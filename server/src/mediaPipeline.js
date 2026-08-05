import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { MEDIA_ROOT, EXTERNAL_ROOT, PRIVATE_ROOT, VIDEO_EXTS } from './paths.js';
import { db } from './db.js';
import { log } from './logger.js';
import { parseFilename, extractMetadata, extractMetadataRemote } from './mediaMetadata.js';
import { checkTranscodeQueue } from './transcodeQueue.js';

export const processDownloadedFile = async (tempPath, filename, options = {}) => {
    // filename originates from Telegram document metadata (attacker/uploader-controlled) or
    // an upload form field — sanitized here, centrally, so no caller can bypass it by
    // forgetting to. A name like "../../.ssh/authorized_keys" would otherwise write outside
    // rootFolder entirely.
    filename = path.basename(filename);
    const { isPrivate = 0, owner = null } = options;
    try {
        let rootFolder;

        if (isPrivate && owner) {
            rootFolder = path.join(PRIVATE_ROOT, owner); // 📂 /StreamMedia_Private/username/
        } else if (isPrivate) {
            rootFolder = PRIVATE_ROOT; // Fallback for system/admin files
        } else {
            rootFolder = MEDIA_ROOT;
        }

        const targetDir = path.join(rootFolder, 'Movies');
        await fs.mkdir(targetDir, { recursive: true });

        const finalPath = path.join(targetDir, filename);
        if (existsSync(finalPath)) return;

        await fs.rename(tempPath, finalPath).catch(async () => { await fs.copyFile(tempPath, finalPath); await fs.unlink(tempPath); });

        const stats = await fs.stat(finalPath);
        const { duration, poster, needsTranscode } = await extractMetadata(finalPath);
        const meta = parseFilename(filename);
        const status = (needsTranscode && !isPrivate) ? 'pending' : 'completed';

        await db.run(`INSERT OR IGNORE INTO media
            (path, filename, title, type, series_name, season, episode, size, duration, poster, created_at, transcode_status, is_private, owner_username)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [finalPath, filename, meta.title, meta.type, meta.series_name, meta.season, meta.episode, stats.size, duration, poster, stats.birthtime.toISOString(), status, isPrivate, owner]);

        await log(`✅ Auto-Imported: ${filename}`);
        checkTranscodeQueue();
    } catch (e) { await log(`❌ Processing Failed: ${e.message}`, 'ERROR'); }
};

// A file that was streamed straight into a node's storage (never touched this server's
// disk) — register it as already-archived on that node and let the normal transcode
// queue pick it up (checkTranscodeQueue routes nas:// jobs back to the same node).
// Used by both the Telegram direct-download flow (no metadata overrides — filename
// guessing via parseFilename is all it has) and the manual-upload direct-to-node flow
// (which already knows the real title/type/series info from the upload form, same as
// the local-upload path does — falls back to guessing only for whatever wasn't given).
export const processDirectToNodeFile = async (nodeId, nasNode, filename, size, options = {}) => {
    // Same reasoning as processDownloadedFile above — this reaches the node's own /file and
    // /archive endpoints, which now also enforce a flat filename server-side, but this call
    // site should never send an unsafe one in the first place.
    filename = path.basename(filename);
    const { isPrivate = 0, owner = null, title, type, seriesName, season, episode } = options;
    try {
        const nasPath = `nas://${nodeId}/${filename}`;
        const existing = await db.get("SELECT 1 FROM media WHERE path = ?", nasPath);
        if (existing) return;

        const fileUrl = `${nasNode.url}/file/${encodeURIComponent(filename)}`;
        const thumbName = path.basename(filename, path.extname(filename)) + '.jpg';
        const { duration, poster, needsTranscode } = await extractMetadataRemote(fileUrl, nasNode.apiKey, thumbName);
        const meta = parseFilename(filename);
        const status = (needsTranscode && !isPrivate) ? 'pending' : 'completed';

        const finalTitle = title || meta.title;
        const finalType = type || meta.type;
        const finalSeriesName = type === 'series' ? (seriesName || meta.series_name) : meta.series_name;
        const finalSeason = type === 'series' ? (parseInt(season) || meta.season) : meta.season;
        const finalEpisode = type === 'series' ? (parseInt(episode) || meta.episode) : meta.episode;

        await db.run(`INSERT OR IGNORE INTO media
            (path, filename, title, type, series_name, season, episode, size, duration, poster, created_at, transcode_status, is_private, owner_username, is_archived)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [nasPath, filename, finalTitle, finalType, finalSeriesName, finalSeason, finalEpisode, size, duration, poster, new Date().toISOString(), status, isPrivate, owner]);

        await log(`✅ Auto-Imported directly to node ${nodeId}: ${filename}`);
        checkTranscodeQueue();
    } catch (e) {
        await log(`❌ Failed to register direct-to-node file: ${e.message}`, 'ERROR');
        // Re-thrown (not swallowed) so a caller that needs to know — like a manual
        // upload's HTTP response — actually finds out. Safe for the Telegram caller too:
        // that call site already has its own surrounding try/catch (telegramService.js).
        throw e;
    }
};

// 👇 Removes now-empty season/series folders after a delete, walking up but never past a library root
export const LIBRARY_ROOTS = [MEDIA_ROOT, EXTERNAL_ROOT, PRIVATE_ROOT];
export async function cleanupEmptyDirs(startDir) {
    let dir = startDir;
    while (LIBRARY_ROOTS.some(root => dir.startsWith(root)) && !LIBRARY_ROOTS.includes(dir)) {
        try {
            const entries = await fs.readdir(dir);
            if (entries.length > 0) break;
            await fs.rmdir(dir);
            dir = path.dirname(dir);
        } catch (e) { break; }
    }
}

// --- LIBRARY SCANNER ---
export const scanLibrary = async () => {
    if (!db) return;
    const roots = [
        { path: path.join(MEDIA_ROOT, 'Movies'), archived: 0, private: 0 },
        { path: path.join(MEDIA_ROOT, 'Series'), archived: 0, private: 0 },
        { path: path.join(EXTERNAL_ROOT, 'Movies'), archived: 1, private: 0 },
        { path: path.join(EXTERNAL_ROOT, 'Series'), archived: 1, private: 0 }
    ];

    for (const r of roots) await fs.mkdir(r.path, { recursive: true }).catch(()=>{});

    // Previously had no try/catch anywhere — an external/NAS-mounted folder disconnecting
    // mid-scan (ENOENT/EIO), or a single corrupt file failing extractMetadata, aborted the
    // entire scan (and, before scanLibrary() was called with .catch() at its call site,
    // could crash the whole server via an unhandled rejection on every boot). Now one bad
    // directory/file is logged and skipped so the rest of the library still gets scanned.
    const processDir = async (dir, isArchived, isPrivate) => {
        if (!existsSync(dir)) return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e) {
            console.error(`❌ Library scan: could not read directory ${dir}: ${e.message}`);
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            try {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    await processDir(fullPath, isArchived, isPrivate);
                }
                else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
                    const exists = await db.get("SELECT path FROM media WHERE path = ?", fullPath);
                    if (!exists) {
                        const meta = parseFilename(entry.name);
                        const stats = await fs.stat(fullPath);
                        const { duration, poster, needsTranscode } = await extractMetadata(fullPath);
                        await db.run(`INSERT OR IGNORE INTO media
                        (path, filename, title, type, series_name, season, episode, size, duration, poster, created_at, transcode_status, is_archived, is_private)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [fullPath, entry.name, meta.title, meta.type, meta.series_name, meta.season, meta.episode, stats.size, duration, poster, stats.birthtime.toISOString(), needsTranscode ? 'pending' : 'completed', isArchived, isPrivate]);
                    }
                }
            } catch (e) {
                console.error(`❌ Library scan: skipping ${fullPath}: ${e.message}`);
            }
        }
    };
    for (const r of roots) await processDir(r.path, r.archived, r.private);
};

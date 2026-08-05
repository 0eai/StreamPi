import express from 'express';
import fs from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import path from 'path';
import axios from 'axios';
import { execFile, spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { MEDIA_ROOT, EXTERNAL_ROOT, PRIVATE_ROOT, USER_HOME, THUMB_FOLDER, isSafeFilename } from '../paths.js';
import { db, initDB, logActivity } from '../db.js';
import { verifyToken } from '../middleware.js';
import { KNOWN_NAS_NODES } from '../state.js';
import { resolveNasFile, withNasAvailability, isNasNodeAvailable } from '../nasSource.js';
import { extractMetadata, parseFilename } from '../mediaMetadata.js';
import { cleanupEmptyDirs, processDirectToNodeFile } from '../mediaPipeline.js';
import { checkTranscodeQueue } from '../transcodeQueue.js';
import { getBestNasNode } from '../nodeDiscovery.js';
import { hasFreeSpace, sendServerError } from '../logger.js';
import { upload } from '../uploadMiddleware.js';

const router = express.Router();

router.get('/api/library', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();

        let query;
        let params = [];

        if (req.user.role === 'super_admin') {
            query = 'SELECT * FROM media';
        } else {
            query = 'SELECT * FROM media WHERE is_private = 0 OR owner_username = ?';
            params = [req.user.username];
        }

        // Stamped here, before mediaByPath and the loops below are built from it, so the flag
        // reaches movies, series episodes and continueWatching alike — each of those spreads
        // these same row objects. A client can then say "this is on an offline node" up front
        // instead of finding out from a failed /api/stream once the player is already open.
        const media = (await db.all(query, params)).map(withNasAvailability);

        const historyUser = req.user.username;
        const history = await db.all('SELECT * FROM history WHERE user_email = ?', [historyUser]);

        const historyMap = {};
        history.forEach(h => { historyMap[h.media_path] = h; });

        // Built once and reused below instead of a per-history-row `media.find(...)` scan —
        // that was an O(history × media) pattern on the endpoint hit on every app load.
        const mediaByPath = new Map(media.map(m => [m.path, m]));

        const result = { movies: [], series: {}, continueWatching: [] };

        for (const item of media) {
            const historyItem = historyMap[item.path];
            const finalItem = historyItem ? { ...item, ...historyItem } : item;

            if (finalItem.type === 'movie') {
                result.movies.push(finalItem);
            } else {
                if (!result.series[finalItem.series_name]) result.series[finalItem.series_name] = [];
                result.series[finalItem.series_name].push(finalItem);
            }
        }

        for (const h of history) {
            const m = mediaByPath.get(h.media_path);
            if (m && (h.progress / h.duration) < 0.95) {
                result.continueWatching.push({ ...m, ...h });
            }
        }

        result.continueWatching.sort((a, b) => new Date(b.last_watched) - new Date(a.last_watched));

        const seriesArray = Object.keys(result.series).map(name => ({
            title: name,
            episodes: result.series[name].sort((a,b) => (a.season * 100 + a.episode) - (b.season * 100 + b.episode))
        }));

        res.json({ ...result, series: seriesArray });
    } catch (e) {
        sendServerError(res, e);
    }
});

router.get('/api/series', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();

        let query = req.user.role === 'super_admin' ?
                "SELECT DISTINCT series_name FROM media WHERE type = 'series' ORDER BY series_name" :
                "SELECT DISTINCT series_name FROM media WHERE type = 'series' AND is_private = 0 ORDER BY series_name";

        const rows = await db.all(query);
        res.json(rows.map(r => r.series_name));
    } catch (e) {
        sendServerError(res, e);
    }
});

router.get('/api/series/:name', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();

        let query = req.user.role === 'super_admin' ?
                "SELECT season, episode FROM media WHERE series_name = ? ORDER BY season, episode" :
                "SELECT season, episode FROM media WHERE series_name = ? AND is_private = 0 ORDER BY season, episode";

        const rows = await db.all(query, req.params.name);
        res.json(rows);
    } catch (e) {
        sendServerError(res, e);
    }
});

router.post('/api/media/toggle-privacy', verifyToken, async (req, res) => {
    const { path: currentPath } = req.body;

    try {
        const item = await db.get("SELECT * FROM media WHERE path = ?", currentPath);
        if (!item) return res.status(404).json({ error: "Item not found" });
        if (item.is_archived) return res.status(400).json({ error: "Cannot toggle privacy on NAS items. Restore first." });

        // 1. Permission Check: Allow if Super Admin OR if User owns the file
        if (req.user.role !== 'super_admin' && item.owner_username !== req.user.username) {
            return res.status(403).json({ error: "Access Denied: You do not own this file." });
        }

        const isGoingPrivate = item.is_private === 0;
        const owner = item.owner_username || req.user.username; // Assign owner if previously null

        let newPath;

        if (isGoingPrivate) {
            // Public -> Private (Move to /StreamMedia_Private/<Username>/...)
            const relativePath = path.relative(MEDIA_ROOT, currentPath);
            newPath = path.join(PRIVATE_ROOT, owner, relativePath);
        } else {
            // Private -> Public (Move to /StreamMedia/...)
            // We find the path relative to the user's private folder
            const userVaultRoot = path.join(PRIVATE_ROOT, owner);
            const relativePath = path.relative(userVaultRoot, currentPath);
            newPath = path.join(MEDIA_ROOT, relativePath);
        }

        const newDir = path.dirname(newPath);
        if (!existsSync(newDir)) await fs.mkdir(newDir, { recursive: true });

        await fs.rename(currentPath, newPath);

        // Update DB: Update path, is_private, and ensure owner_username is set
        await db.run("UPDATE media SET path = ?, is_private = ?, owner_username = ? WHERE path = ?",
            [newPath, isGoingPrivate ? 1 : 0, owner, currentPath]);

        await db.run("UPDATE history SET media_path = ? WHERE media_path = ?", [newPath, currentPath]);

        await logActivity(req.user.username, "PRIVACY", `Marked ${item.filename} as ${isGoingPrivate ? 'Private' : 'Public'}`, req.ip);

        res.json({ success: true, newPath, isPrivate: isGoingPrivate });

    } catch (e) {
        sendServerError(res, e);
    }
});

const probeMediaInfo = async (req, res) => {
    let { path: filePath } = req.query;
    if (!filePath) return res.status(400).send("Path required");

    try {
        filePath = decodeURIComponent(filePath);
    } catch (e) {
        console.error("Path decoding failed", e);
    }

    // Same private-vault ownership check /api/stream already does — without it, any logged-in
    // user could probe another user's private vault path for its audio/subtitle track listing.
    if (filePath.startsWith(PRIVATE_ROOT)) {
        try {
            if (!db) await initDB();
            const mediaItem = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);
            if (mediaItem && mediaItem.is_private === 1 && req.user.role !== 'super_admin' && mediaItem.owner_username !== req.user.username) {
                return res.status(403).send("Access Denied: User Private Vault");
            }
        } catch (e) {
            return sendServerError(res, e);
        }
    }

    console.log(`ℹ️ [Media Info] Probing: ${filePath}`);

    const formatResponse = (metadata) => {
        try {
            const fileSize = metadata.format && metadata.format.size
                ? parseInt(metadata.format.size, 10)
                : 0;

            const audioTracks = metadata.streams
                .filter(s => s.codec_type === 'audio')
                .map((s, i) => ({
                    index: i,
                    label: s.tags?.title || s.tags?.language || s.codec_name || `Audio ${i + 1}`,
                    language: s.tags?.language || 'und',
                    codec: s.codec_name
                }));

            const subtitleTracks = metadata.streams
                .filter(s => s.codec_type === 'subtitle')
                .map((s) => ({
                    index: s.index,
                    label: s.tags?.title || s.tags?.language || s.codec_name || `Subtitle ${s.index}`,
                    language: s.tags?.language || 'en',
                    codec: s.codec_name
                }));

            return { fileSize, audioTracks, subtitleTracks };
        } catch (e) {
            console.error("Metadata parse error:", e);
            return { fileSize: 0, audioTracks: [], subtitleTracks: [] };
        }
    };

    if (filePath.startsWith('nas://')) {
        const nas = resolveNasFile(filePath);
        if (!nas.ok) return res.status(nas.status).json({ error: nas.error });

        const fileUrl = nas.url;

        // execFile with an argument array, not exec() with an interpolated shell string —
        // the node's url is self-reported (nodeDiscovery.js), which this process doesn't
        // control, so it must never reach an actual shell (same fix as mediaMetadata.js).
        // An unresponsive node would otherwise hang this HTTP response forever — same fix as
        // mediaMetadata.js's extractMetadataRemote.
        execFile('ffprobe', [
            '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format',
            '-headers', `Authorization: Bearer ${nas.apiKey}`, fileUrl
        ], { timeout: 15000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("NAS Probe Error:", stderr);
                return res.json({ fileSize: 0, audioTracks: [], subtitleTracks: [] });
            }
            try {
                const metadata = JSON.parse(stdout);
                res.json(formatResponse(metadata));
            } catch (e) {
                res.json({ fileSize: 0, audioTracks: [], subtitleTracks: [] });
            }
        });
    }

    else if (existsSync(filePath)) {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error("FFprobe Error:", err.message);
                return res.status(500).json({ error: "Probe failed" });
            }
            res.json(formatResponse(metadata));
        });
    } else {
        console.error(`❌ File Not Found on Disk: ${filePath}`);
        res.status(404).send("File not found on server disk");
    }
};

// Registered twice in the original file (byte-identical handler both times) — kept as
// two registrations rather than deduped, to keep this a zero-behavior-change extraction.
router.get('/api/media/info', verifyToken, probeMediaInfo);

router.post('/api/progress', verifyToken, async (req, res) => {
    const { path: filePath, timestamp, duration } = req.body;

    const historyUser = req.user.username;

    try {
        await db.run(`INSERT INTO history (user_email, media_path, progress, duration, last_watched)
                      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_email, media_path)
                      DO UPDATE SET progress = ?, duration = ?, last_watched = ?`,
                      [
                          historyUser,
                          filePath,
                          timestamp,
                          duration,
                          new Date().toISOString(),
                          timestamp,
                          duration,
                          new Date().toISOString()
                      ]);

        res.json({ success: true });
    } catch (e) {
        sendServerError(res, e);
    }
});

/**
 * Which NAS nodes can serve a file right now, as a bare id list.
 *
 * Exists because node availability is live state while /api/library is fetched once per page
 * load: the `nas_available` stamped on each row is only accurate as of that fetch, so a client
 * left open while a node goes down would keep showing archived items as playable. Cheap enough
 * to poll (an in-memory map read plus nothing else), unlike re-fetching the whole library.
 *
 * Uses the same isNasNodeAvailable as the streaming guards, so a client's badge and the
 * server's answer to an actual /api/stream can't disagree.
 */
router.get('/api/nas/availability', verifyToken, (req, res) => {
    const available = [];
    for (const [id, node] of KNOWN_NAS_NODES.entries()) {
        if (isNasNodeAvailable(node)) available.push(id);
    }
    res.json({ available });
});

// Every node's own in-progress archive/restore/migration jobs, flattened across all nodes and
// open to any logged-in user — /api/media/nas-action blocks until a transfer finishes, so this
// is the only way a client can see it moving rather than just waiting on that one request.
// Jobs carry no caller/session info (see node/stats.js), so matching back to a specific
// nas-action call has to happen by filename on the client, same as the admin dashboard does.
router.get('/api/nas/jobs', verifyToken, (req, res) => {
    const jobs = [];
    for (const [nodeId, node] of KNOWN_NAS_NODES.entries()) {
        for (const job of node.stats?.jobs || []) jobs.push({ ...job, nodeId });
    }
    res.json({ jobs });
});

// Lightweight, upload-picker-scoped node list — deliberately not reusing
// /api/admin/dashboard's payload (unrelated admin data: other users' sessions, active
// streams, full queue state) just to get free-space numbers. Open to any logged-in user,
// matching the Upload button itself, which has no role restriction today.
router.get('/api/upload/nas-nodes', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const nodeRows = await db.all("SELECT id, name FROM nodes");
        const nameById = new Map(nodeRows.map(n => [n.id, n.name]));

        // Strictly isReachable, NOT nasSource.js's isNasNodeAvailable: this endpoint exists to
        // report free space, and checkNasHealth nulls a node's stats the moment a probe fails.
        // Admitting a node inside the grace window would list it with 0 bytes free — worse than
        // omitting it. Reading an existing file needs no stats, which is why that path is the
        // more forgiving of the two.
        const nodes = Array.from(KNOWN_NAS_NODES.values())
            .filter(n => n.isReachable)
            .map(n => ({
                id: n.id,
                name: nameById.get(n.id) || n.id,
                free: n.stats?.disk?.free || 0,
                total: n.stats?.disk?.total || 0,
                percent: n.stats?.disk?.percent || 0,
            }));

        res.json(nodes);
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/upload', verifyToken, (req, res, next) => { req.setTimeout(3600000); next(); }, upload.array('files'), async (req, res) => {
    try {
        if (!db) await initDB();

        if (!(await hasFreeSpace(USER_HOME))) throw new Error("Server disk is full");

        const files = req.files;
        if (!files || files.length === 0) throw new Error("No files received");

        let { type, seriesName, season, episode, title, isPrivate = false } = req.body;

        const wantsPrivate = isPrivate === 'true' || isPrivate === true;
        const markAsPrivate = wantsPrivate ? 1 : 0;
        const owner = wantsPrivate ? req.user.username : null;

        const safeFolder = (str) => str ? str.replace(/[/\\?%*:|"<>]/g, '-').trim() : 'Unknown';

        let rootFolder;
        if (wantsPrivate) {
            rootFolder = path.join(PRIVATE_ROOT, safeFolder(req.user.username));
        } else {
            rootFolder = MEDIA_ROOT;
        }

        let targetDir;
        if (type === 'series') {
            const safeSeries = safeFolder(seriesName || 'Unknown Series');
            const safeSeason = `Season ${parseInt(season) || 1}`;
            targetDir = path.join(rootFolder, 'Series', safeSeries, safeSeason);
        } else {
            targetDir = path.join(rootFolder, 'Movies');
        }

        await fs.mkdir(targetDir, { recursive: true });
        const results = [];
        let episodeCounter = parseInt(episode) || 1;

        for (const file of files) {
            // file.originalname is the attacker-controlled multipart filename field — without
            // stripping any directory portion, a name like "../../.stream_db/media.db" would
            // rename the upload to a path outside the intended media tree.
            const safeFilename = path.basename(decodeURIComponent(file.originalname));

            // Streamed straight to a NAS node by the storage engine (uploadMiddleware.js) —
            // never touched local disk, so none of the rename/extractMetadata/targetDir
            // logic below applies. Flat filename on the node (no series/season subfolder
            // support there today), same characteristic Telegram-sourced NAS files already
            // have — not a new limitation this introduces.
            if (file.isDirectToNode) {
                // Reachability, not just registration: the picker that offered this node
                // filtered on isReachable, but the node can go down between picking it and
                // the upload landing here.
                const nasNode = KNOWN_NAS_NODES.get(file.nodeId);
                if (!isNasNodeAvailable(nasNode)) throw new Error("Selected node is no longer reachable.");

                const seriesEpisode = type === 'series'
                    ? (parseInt(episode) ? episodeCounter++ : (parseFilename(safeFilename).episode || 0))
                    : undefined;

                await processDirectToNodeFile(file.nodeId, nasNode, safeFilename, file.size, {
                    isPrivate: markAsPrivate,
                    owner,
                    title,
                    type,
                    seriesName: type === 'series' ? seriesName : undefined,
                    season: type === 'series' ? (parseInt(season) || 1) : undefined,
                    episode: seriesEpisode,
                });

                results.push(safeFilename);
                continue;
            }

            const targetPath = path.join(targetDir, safeFilename);

            try {
                await fs.rename(file.path, targetPath);
            } catch (err) {
                await fs.copyFile(file.path, targetPath);
                await fs.unlink(file.path);
            }

            const stats = await fs.stat(targetPath);
            const { duration, poster, needsTranscode } = await extractMetadata(targetPath);

            let finalTitle = title || safeFilename;
            let finalSeriesName = null, finalSeason = null, finalEpisode = null;

            if (type === 'series') {
                finalSeriesName = seriesName;
                finalSeason = parseInt(season) || 1;
                finalEpisode = parseInt(episode) ? episodeCounter++ : (parseFilename(safeFilename).episode || 0);
            } else {
                if (!title) finalTitle = path.basename(safeFilename, path.extname(safeFilename));
            }

            const status = (needsTranscode && !isPrivate) ? 'pending' : 'completed';

            await db.run(`INSERT OR IGNORE INTO media
                (path, filename, title, type, series_name, season, episode, size, duration, poster, created_at, transcode_status, is_private, owner_username)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [targetPath, safeFilename, finalTitle, type, finalSeriesName, finalSeason, finalEpisode, stats.size, duration, poster, stats.birthtime.toISOString(), status, markAsPrivate, owner]);

            results.push(safeFilename);
        }

        await logActivity(req.user.username, "UPLOAD", `Uploaded ${files.length} files`, req.ip);
        res.json({ success: true, processed: results });
        checkTranscodeQueue();

    } catch (e) {
        if (req.files) for (const f of req.files) if (f.path && existsSync(f.path)) await fs.unlink(f.path).catch(()=>{});
        sendServerError(res, e, "Upload failed");
    }
});

router.post('/api/media/nas-action', verifyToken, async (req, res) => {
    const { path: filePath, action } = req.body;

    try {
        if (!filePath) throw new Error("No file path provided");

        if (action === 'archive') {
            if (filePath.startsWith('nas://')) return res.status(400).json({ error: "Already on NAS" });

            // Requiring a matching, registered media row (same pattern as DELETE /api/media)
            // is what actually closes this off — without it, filePath was any string the
            // caller supplied, and this route would upload-then-delete whatever it pointed at.
            const item = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);
            if (!item) return res.status(404).json({ error: "File not found" });
            if (item.is_private === 1 && item.owner_username !== req.user.username && req.user.role !== 'super_admin') {
                return res.status(403).json({ error: "Access Denied: You do not own this file." });
            }

            if (!existsSync(filePath)) return res.status(404).json({ error: "Local file not found" });

            const stats = await fs.stat(filePath);
            const targetNas = getBestNasNode(stats.size);

            if (!targetNas) throw new Error("No suitable NAS node available");

            console.log(`📦 Manual Archive via cURL: ${filePath} -> ${targetNas.id}`);

            const uploadUrl = `${targetNas.url}/archive`;

            await new Promise((resolve, reject) => {
                const child = spawn('curl', [
                    '-s',
                    '--connect-timeout', '10',
                    '--max-time', '14400',
                    '-H', `Authorization: Bearer ${targetNas.apiKey}`,
                    '-F', `file=@${filePath}`,
                    uploadUrl
                ]);

                let responseData = '';
                // Same crash risk as autoArchiver.js's equivalent spawn — an unhandled
                // ChildProcess 'error' event (curl missing, EACCES, etc.) becomes an uncaught
                // exception with no listener here.
                child.on('error', reject);
                child.stdout.on('data', (d) => { responseData += d.toString(); });
                child.stderr.on('data', (d) => { console.error(`[cURL Manual] ${d.toString()}`); });

                child.on('close', (code) => {
                    if (code !== 0) return reject(new Error(`Upload failed (cURL code ${code})`));
                    try {
                        const json = JSON.parse(responseData);
                        if (json.success) resolve();
                        else reject(new Error(json.error || "NAS Rejected Upload"));
                    } catch (e) {
                        reject(new Error("Invalid response from NAS"));
                    }
                });
            });

            const newPath = `nas://${targetNas.id}/${path.basename(filePath)}`;

            // DB updated before the local file is removed — same reordering as autoArchiver.js's
            // equivalent flow, so a crash/error in between leaves an orphaned local file
            // (harmless) instead of a DB row pointing at a path that no longer exists at all.
            await db.run("UPDATE media SET path = ?, is_archived = 1 WHERE path = ?", [newPath, filePath]);
            await db.run("UPDATE history SET media_path = ? WHERE media_path = ?", [newPath, filePath]);

            await fs.unlink(filePath);

            // newPath is required by callers that patch an item in place (the web client
            // reads result.newPath); without it they store `undefined` and the item can no
            // longer be streamed until a full library refetch.
            return res.json({ success: true, message: "Moved to NAS", newPath });
        }

        else if (action === 'restore') {
            if (!filePath.startsWith('nas://')) return res.status(400).json({ error: "File is not on NAS" });

            const item = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);
            if (!item) return res.status(404).json({ error: "File not found" });
            if (item.is_private === 1 && item.owner_username !== req.user.username && req.user.role !== 'super_admin') {
                return res.status(403).json({ error: "Access Denied: You do not own this file." });
            }

            if (!(await hasFreeSpace(MEDIA_ROOT))) throw new Error("Server disk full");

            const nas = resolveNasFile(filePath);
            if (!nas.ok) return res.status(nas.status).json({ error: nas.error });
            const filename = nas.filename;
            // filePath is now guaranteed to be a registered media row's own path, so filename
            // should already be flat/safe by construction — kept as an explicit check anyway
            // since this string still ends up in a local fs.join below.
            if (!isSafeFilename(filename)) return res.status(400).json({ error: "Invalid filename on record" });

            if (nas.node.stats && nas.node.stats.nasBusy) {
                return res.status(503).json({ error: "NAS is currently busy with max jobs." });
            }

            console.log(`♻️ Triggering Restore: ${filename}`);

            const localDir = path.join(MEDIA_ROOT, 'Restored');
            if (!existsSync(localDir)) await fs.mkdir(localDir, { recursive: true });
            const localPath = path.join(localDir, filename);
            const writer = createWriteStream(localPath);

            try {
                const response = await axios({
                    method: 'GET',
                    url: nas.url,
                    responseType: 'stream',
                    headers: { 'Authorization': `Bearer ${nas.apiKey}` },
                    timeout: 2 * 60 * 60 * 1000, // 👈 ADD THIS (1 Hour Timeout)
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });

                // The write side already rejects on its own 'error' below — this source stream
                // needed the same, since a dropped NAS connection mid-download would otherwise
                // fire an unhandled 'error' on it and crash the whole process.
                response.data.on('error', (err) => writer.destroy(err));
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                await axios.delete(nas.url, {
                    headers: { 'Authorization': `Bearer ${nas.apiKey}` }
                });

                await db.run("UPDATE media SET path = ?, is_archived = 0 WHERE path = ?", [localPath, filePath]);
                await db.run("UPDATE history SET media_path = ? WHERE media_path = ?", [localPath, filePath]);

                return res.json({ success: true, message: "Restored to Local", newPath: localPath });
            } catch (e) {
                if (e.response && e.response.status === 503) {
                    return res.status(503).json({ error: "NAS Busy: Queue full." });
                }
                throw e;
            }
        }
        res.status(400).json({ error: "Invalid action" });
    } catch (e) {
        sendServerError(res, e, "Move failed");
    }
});

router.get('/api/media/next', verifyToken, async (req, res) => {
    const { path: currentPath } = req.query;
    if (!currentPath) return res.status(400).json({ error: "Path required" });

    try {
        const current = await db.get("SELECT series_name, season, episode FROM media WHERE path = ?", currentPath);

        if (!current || !current.series_name) {
            return res.json({ next: null });
        }

        console.log(`[AutoPlay] Looking for next episode of ${current.series_name} (Current: S${current.season} E${current.episode})`);

        const privacyFilter = req.user.role === 'super_admin' ? "" : "AND is_private = 0";

        const nextEpisode = await db.get(`
            SELECT * FROM media
            WHERE series_name = ?
            AND (
                (season = ? AND episode > ?)
                OR
                (season > ?)
            )
            ${privacyFilter}
            ORDER BY season ASC, episode ASC
            LIMIT 1
        `, [
            current.series_name,
            parseInt(current.season),
            parseInt(current.episode),
            parseInt(current.season)
        ]);

        if (nextEpisode) {
            console.log(`[AutoPlay] Found: ${nextEpisode.filename} (S${nextEpisode.season} E${nextEpisode.episode})`);
        } else {
            console.log(`[AutoPlay] No next episode found.`);
        }

        // Stamped like the /api/library rows: autoplay hands this straight to the player, so
        // without it an archived next episode on a downed node would be the one place the
        // client still discovered unavailability from a failed stream.
        res.json({ next: nextEpisode ? withNasAvailability(nextEpisode) : null });

    } catch (e) {
        console.error("AutoPlay Error:", e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/media/move', verifyToken, async (req, res) => {
    const { path: srcPath, action } = req.body;
    try {
        if (!srcPath || !existsSync(srcPath)) throw new Error("Source file not found");
        if (srcPath.startsWith(PRIVATE_ROOT)) return res.status(403).json({ error: "Private Vault items cannot be moved." });
        // An unrecognized action previously left destPath as '' and attempted
        // fs.rename(srcPath, '') — a confusing low-level filesystem error instead of a clean 400.
        if (action !== 'archive' && action !== 'restore') return res.status(400).json({ error: "Invalid action" });
        let destPath = '', isArchived = 0;
        if (action === 'archive') { destPath = srcPath.replace(MEDIA_ROOT, EXTERNAL_ROOT); isArchived = 1; }
        else if (action === 'restore') { destPath = srcPath.replace(EXTERNAL_ROOT, MEDIA_ROOT); isArchived = 0; }
        await fs.rename(srcPath, destPath).catch(async()=>{ await fs.copyFile(srcPath, destPath); await fs.unlink(srcPath); });
        await db.run("UPDATE media SET path = ?, is_archived = ?, is_private = 0 WHERE path = ?", [destPath, isArchived, srcPath]);
        await db.run("UPDATE history SET media_path = ? WHERE media_path = ?", [destPath, srcPath]);
        await logActivity(req.user.username, "MOVE", `Moved ${path.basename(srcPath)} to ${path.basename(destPath)}`, req.ip);
        res.json({ success: true, newPath: destPath });
    } catch (e) { sendServerError(res, e); }
});

router.delete('/api/media', verifyToken, async (req, res) => {
    const { path: filePath } = req.body;
    try {
        if (!filePath) return res.status(400).json({ error: "No path provided" });

        // 👇 FETCH ITEM INFO FIRST
        const item = await db.get("SELECT owner_username, is_private, poster FROM media WHERE path = ?", filePath);
        if (!item) return res.status(404).json({ error: "File not found" });

        // 👇 PERMISSION CHECK
        // Allow if:
        // 1. User is Super Admin
        // 2. File is Public (is_private = 0)
        // 3. User owns the file
        const isOwner = item.owner_username === req.user.username;
        if (item.is_private === 1 && !isOwner && req.user.role !== 'super_admin') {
             return res.status(403).json({ error: "Access Denied: You do not own this file." });
        }

        // path is this table's primary key, and toggle-privacy can change it (moves the file,
        // updates the row's path) — if that races with this delete reading the old path just
        // before a toggle relocates it, this DELETE matches zero rows. Checking .changes
        // catches that instead of silently reporting success while the file (now at a new
        // path) survives with a live DB row untouched.
        const result = await db.run('DELETE FROM media WHERE path = ?', [filePath]);
        if (result.changes === 0) return res.status(409).json({ error: "File was modified by another request — please retry." });
        await db.run('DELETE FROM history WHERE media_path = ?', [filePath]);

        if (existsSync(filePath)) await fs.unlink(filePath).catch(() => {});
        if (item.poster) {
            const thumbPath = path.join(THUMB_FOLDER, item.poster);
            if (existsSync(thumbPath)) await fs.unlink(thumbPath).catch(() => {});
        }
        await cleanupEmptyDirs(path.dirname(filePath));

        await logActivity(req.user.username, "DELETE", `Deleted ${path.basename(filePath)}`, req.ip);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

router.delete('/api/series/:name', verifyToken, async (req, res) => {
    const seriesName = req.params.name;
    try {
        const rows = await db.all("SELECT path, owner_username, is_private, poster FROM media WHERE series_name = ?", seriesName);
        if (!rows.length) return res.status(404).json({ error: "Series not found" });

        const deletable = rows.filter(item =>
            req.user.role === 'super_admin' || item.is_private !== 1 || item.owner_username === req.user.username);
        if (!deletable.length) return res.status(403).json({ error: "Access Denied: You do not own any episodes in this series." });

        const dirsToCheck = new Set();
        for (const item of deletable) {
            await db.run('DELETE FROM media WHERE path = ?', [item.path]);
            await db.run('DELETE FROM history WHERE media_path = ?', [item.path]);
            if (existsSync(item.path)) await fs.unlink(item.path).catch(() => {});
            if (item.poster) {
                const thumbPath = path.join(THUMB_FOLDER, item.poster);
                if (existsSync(thumbPath)) await fs.unlink(thumbPath).catch(() => {});
            }
            dirsToCheck.add(path.dirname(item.path));
        }
        for (const dir of dirsToCheck) await cleanupEmptyDirs(dir);

        await logActivity(req.user.username, "DELETE", `Deleted series ${seriesName} (${deletable.length} episodes)`, req.ip);
        res.json({ success: true, deleted: deletable.length, skipped: rows.length - deletable.length });
    } catch (e) { sendServerError(res, e); }
});

router.patch('/api/media/title', verifyToken, async (req, res) => {
    const { path: filePath, title } = req.body;
    try {
        if (!filePath || !title?.trim()) return res.status(400).json({ error: "Path and title are required" });

        const item = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);
        if (!item) return res.status(404).json({ error: "File not found" });

        const isOwner = item.owner_username === req.user.username;
        if (item.is_private === 1 && !isOwner && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: "Access Denied: You do not own this file." });
        }

        await db.run("UPDATE media SET title = ? WHERE path = ?", [title.trim(), filePath]);
        await logActivity(req.user.username, "EDIT", `Renamed ${path.basename(filePath)} to "${title.trim()}"`, req.ip);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

router.patch('/api/series/:name', verifyToken, async (req, res) => {
    const seriesName = req.params.name;
    const { newName } = req.body;
    try {
        if (!newName?.trim()) return res.status(400).json({ error: "New name is required" });

        const rows = await db.all("SELECT path, owner_username, is_private FROM media WHERE series_name = ?", seriesName);
        if (!rows.length) return res.status(404).json({ error: "Series not found" });

        const editable = rows.filter(item =>
            req.user.role === 'super_admin' || item.is_private !== 1 || item.owner_username === req.user.username);
        if (!editable.length) return res.status(403).json({ error: "Access Denied: You do not own any episodes in this series." });

        for (const item of editable) {
            await db.run("UPDATE media SET series_name = ? WHERE path = ?", [newName.trim(), item.path]);
        }

        await logActivity(req.user.username, "EDIT", `Renamed series "${seriesName}" to "${newName.trim()}"`, req.ip);
        res.json({ success: true, renamed: editable.length, skipped: rows.length - editable.length });
    } catch (e) { sendServerError(res, e); }
});

export default router;

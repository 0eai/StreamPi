import { existsSync } from 'fs';
import path from 'path';
import { db } from './db.js';
import { log } from './logger.js';
import { extractMetadata, extractMetadataRemote } from './mediaMetadata.js';
import { resolveNasFile } from './nasSource.js';

let isHealing = false;

// Same cap pattern as transcode_attempts/archive_attempts (transcodeQueue.js, autoArchiver.js)
// — without it, a genuinely-corrupt file would retry every tick forever and, since the query
// below always picks the single oldest still-failing row, permanently block every other file
// behind it from ever being healed.
const MAX_POSTER_ATTEMPTS = 5;

export const runPosterHealer = async () => {
    if (isHealing) return;
    if (!db) return;

    // One row per tick, oldest first, not a batch in parallel — deliberately serial: the
    // incident this heals (a Badminton episode's poster/duration lost entirely) was itself
    // caused by several large 4K files being ffprobed/thumbnailed at once on a Pi's modest
    // CPU/disk. Healing them one at a time is the fix, not a race to redo the same contention.
    // Excludes private/vault files, matching transcodeQueue.js's and autoArchiver.js's own
    // choice not to spend background CPU on vault content automatically.
    let candidate = null;
    try {
        isHealing = true;

        candidate = await db.get(`
            SELECT * FROM media
            WHERE poster IS NULL AND is_private = 0 AND poster_attempts < ?
            ORDER BY created_at ASC LIMIT 1
        `, MAX_POSTER_ATTEMPTS);

        if (!candidate) return;

        let result;
        if (candidate.path.startsWith('nas://')) {
            const nas = resolveNasFile(candidate.path);
            // Node currently offline is a transient condition, not a defect in this file —
            // returning here (without touching poster_attempts) lets the next tick retry it
            // once the node is back, instead of burning down its attempt budget for something
            // that was never this file's fault.
            if (!nas.ok) return;
            const thumbName = path.basename(candidate.filename, path.extname(candidate.filename)) + '.jpg';
            result = await extractMetadataRemote(nas.url, nas.apiKey, thumbName);
        } else {
            if (!existsSync(candidate.path)) {
                // A missing file is a bigger problem than a missing poster — this job's
                // remit is healing posters, not deleting orphaned rows, so it just stops
                // retrying rather than reaching further and deleting anything.
                log(`⚠️ Poster-healing candidate missing on disk, skipping permanently: ${candidate.path}`, 'WARN');
                await db.run("UPDATE media SET poster_attempts = ? WHERE path = ?", [MAX_POSTER_ATTEMPTS, candidate.path]);
                return;
            }
            result = await extractMetadata(candidate.path);
        }

        if (result.poster) {
            await db.run("UPDATE media SET poster = ?, duration = ? WHERE path = ?", [result.poster, result.duration, candidate.path]);
            log(`🖼️ Poster healed: ${candidate.filename}`);
        } else {
            const attempts = (candidate.poster_attempts || 0) + 1;
            if (attempts >= MAX_POSTER_ATTEMPTS) {
                log(`⛔ ${candidate.filename} failed poster extraction ${attempts} times — giving up.`, 'WARN');
            }
            await db.run("UPDATE media SET poster_attempts = ? WHERE path = ?", [attempts, candidate.path]);
        }
    } catch (e) {
        log(`❌ Poster healer error: ${e.message}`, 'ERROR');
        if (candidate) {
            const attempts = (candidate.poster_attempts || 0) + 1;
            await db.run("UPDATE media SET poster_attempts = ? WHERE path = ?", [attempts, candidate.path]).catch(() => {});
        }
    } finally {
        isHealing = false;
    }
};

export const startPosterHealer = () => setInterval(runPosterHealer, 120000);

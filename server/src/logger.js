import fs from 'fs/promises';
import path from 'path';
import checkDiskSpace from 'check-disk-space';
import { LOG_FILE, TEMP_DIR, MIN_FREE_SPACE_BYTES } from './paths.js';

// log() appended forever with no size cap — over months of INFO-level logging on a
// disk-constrained Pi this grows unbounded. Simple size-based rotation: once LOG_FILE
// crosses MAX_LOG_SIZE_BYTES, the current file becomes the single .1 backup and a fresh
// file starts — keeps at most ~2x MAX_LOG_SIZE_BYTES on disk rather than truly unbounded.
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const rotateLogIfNeeded = async () => {
    try {
        const stats = await fs.stat(LOG_FILE);
        if (stats.size >= MAX_LOG_SIZE_BYTES) {
            await fs.rename(LOG_FILE, `${LOG_FILE}.1`);
        }
    } catch (e) {} // ENOENT on first run — nothing to rotate yet
};

export const log = async (message, type = 'INFO') => {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${type}] ${message}\n`;
    console.log(logLine.trim());
    try {
        await rotateLogIfNeeded();
        await fs.appendFile(LOG_FILE, logLine);
    } catch (e) {}
};

export const hasFreeSpace = async (dirPath) => {
    try {
        const disk = await checkDiskSpace(dirPath);
        return disk.free > MIN_FREE_SPACE_BYTES;
    } catch (e) { return true; }
};

// Logs the real error server-side and returns only a generic message to the client — several
// routes used to echo e.message straight back, which can include local filesystem paths or
// other internal detail a client has no reason to see.
export const sendServerError = (res, e, publicMessage = 'Something went wrong', status = 500) => {
    console.error(e);
    res.status(status).json({ error: publicMessage });
};

// Recurses into subdirectories — torrentService.js downloads non-private torrents into
// TEMP_DIR/torrents, and a torrent that never completes was never reachable by the previous
// shallow, top-level-only readdir, so it accumulated disk usage forever.
export const cleanOldTempFiles = async () => {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const walk = async (dir) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(entryPath);
            } else {
                try {
                    const stats = await fs.stat(entryPath);
                    if (now - stats.mtimeMs > ONE_DAY) await fs.unlink(entryPath);
                } catch (err) {}
            }
        }
    };

    await walk(TEMP_DIR);
};

import fs from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import checkDiskSpace from 'check-disk-space';
import { MEDIA_ROOT, MIN_FREE_SPACE_BYTES } from './paths.js';
import { db } from './db.js';
import { log } from './logger.js';
import { getBestNasNode } from './nodeDiscovery.js';
import { isDownloading } from './telegramService.js';
import { isAssigningJob } from './transcodeQueue.js';

let isArchiving = false;

export const runAutoArchiver = async () => {
    if (isDownloading || isAssigningJob || isArchiving) return;

    // Declared here (not with the query below, inside the try) so the catch block can still
    // record a failure against the right row.
    let candidate = null;
    try {
        const disk = await checkDiskSpace(MEDIA_ROOT);
        const TRIGGER_THRESHOLD = MIN_FREE_SPACE_BYTES;

        if (disk.free > TRIGGER_THRESHOLD) return;

        isArchiving = true;

        log(`⚠️ Low Disk Space detected. Finding candidate to archive...`, 'WARN');

        // Excludes candidates that have already failed MAX_ARCHIVE_ATTEMPTS times — without
        // this, a file that can never upload (a structural NAS rejection, a corrupt file) was
        // retried every 60s forever, and since this always picks the single oldest-watched
        // candidate, it also permanently blocked every other eligible file from ever being
        // archived. A resource-availability gate below (no NAS node currently available) is
        // NOT capped the same way — that's transient and should keep retrying once a node
        // comes back, unlike a per-file defect.
        const MAX_ARCHIVE_ATTEMPTS = 5;
        candidate = await db.get(`
            SELECT m.*, h.last_watched
            FROM media m
            LEFT JOIN history h ON m.path = h.media_path
            WHERE m.is_archived = 0
            AND m.is_private = 0
            AND m.transcode_status = 'completed'
            AND m.archive_attempts < ?
            ORDER BY COALESCE(h.last_watched, m.created_at) ASC
            LIMIT 1
        `, MAX_ARCHIVE_ATTEMPTS);

        if (!candidate) {
            isArchiving = false;
            return;
        }

        if (!existsSync(candidate.path)) {
            log(`❌ Candidate file missing: ${candidate.path}. Cleaning DB.`, 'ERROR');
            await db.run("DELETE FROM media WHERE path = ?", candidate.path);
            isArchiving = false;
            return;
        }

        const targetNas = getBestNasNode(candidate.size);

        if (!targetNas) {
            log(`❌ No suitable NAS node found (Offline or Full).`, 'ERROR');
            isArchiving = false;
            return;
        }

        log(`📦 Archiving via System cURL: ${candidate.filename} -> ${targetNas.id}`);

        const uploadUrl = `${targetNas.url}/archive`;

        await new Promise((resolve, reject) => {
            const child = spawn('curl', [
                '-s',
                '--connect-timeout', '10',
                '--max-time', '14400',
                '-H', `Authorization: Bearer ${targetNas.apiKey}`,
                '-F', `file=@${candidate.path}`,
                uploadUrl
            ]);

            let responseData = '';

            // Without this, a spawn failure (curl missing, EACCES, too many open files) fires
            // the ChildProcess's 'error' event with no listener — Node rethrows that as an
            // uncaught exception, crashing the whole server, not just this archive attempt.
            child.on('error', reject);
            child.stdout.on('data', (d) => { responseData += d.toString(); });
            child.stderr.on('data', (d) => { console.error(`[cURL] ${d.toString()}`); });
            child.on('close', (code) => {
                if (code !== 0) return reject(new Error(`cURL process exited with code ${code}`));
                try {
                    const json = JSON.parse(responseData);
                    if (json.success) resolve();
                    else reject(new Error(json.error || "Remote Server Error"));
                } catch (e) {
                    reject(new Error("Invalid JSON response from NAS"));
                }
            });
        });

        const newPath = `nas://${targetNas.id}/${candidate.filename}`;

        // DB updated before the local file is removed — a crash/error in between now leaves an
        // orphaned local file (harmless: a future library scan just re-discovers it as a new
        // item) instead of the previous failure mode, where the DB pointed at a path that no
        // longer existed on disk at all.
        await db.run("UPDATE media SET path = ?, is_archived = 1 WHERE path = ?", [newPath, candidate.path]);
        await db.run("UPDATE history SET media_path = ? WHERE media_path = ?", [newPath, candidate.path]);

        await fs.unlink(candidate.path);

        log(`✅ Archived Successfully to ${targetNas.id}`);

    } catch (e) {
        log(`❌ Archive Failed: ${e.message}`, 'ERROR');
        if (candidate) {
            const attempts = (candidate.archive_attempts || 0) + 1;
            await db.run("UPDATE media SET archive_attempts = ? WHERE path = ?", [attempts, candidate.path]).catch(() => {});
        }
    } finally {
        isArchiving = false;
    }
};

// Previously started as a side effect of importing this file — moved behind an explicit
// call so server.js's startup order is visible in startBackgroundJobs() instead of implicit
// in import statement order.
export const startAutoArchiver = () => setInterval(runAutoArchiver, 60000);

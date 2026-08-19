import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { getSetting } from './db.js';
import { FILES_ROOT, storagePathFor } from './paths.js';
import { log } from './logger.js';
import * as store from './fileStore.js';

/**
 * The hourly job behind auto-delete and the trash.
 *
 * Three passes, in this order and for these reasons:
 *
 *   1. Expire — anything whose auto-delete has come due goes to the trash, subtree and all. Nothing
 *      is unlinked, so an expiry the owner didn't expect is still recoverable.
 *   2. Purge — anything trashed longer than the grace period is removed for real. Rows first, bytes
 *      second, matching the ordering autoArchiver already uses deliberately: a crash between them
 *      leaves a nameless blob that pass 3 collects, whereas the other order leaves a row pointing at
 *      nothing, which nothing would ever notice.
 *   3. Orphans — bytes on disk with no row at all, older than a day. These come from a process dying
 *      between the rename-into-place and the row insert, which is a real window the upload route
 *      accepts precisely because this pass exists.
 *
 * Hourly matches cleanOldTempFiles' existing cadence. Nothing here is time-critical: an item sitting
 * in the trash an extra 59 minutes is not a problem, and being late is always safer than being eager.
 */

const DEFAULT_GRACE_DAYS = 7;
/** How long a file can sit on disk with no row before it counts as abandoned rather than in-flight. */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const graceDays = async () => {
    const raw = Number(await getSetting('files_trash_grace_days', String(DEFAULT_GRACE_DAYS)));
    // A misconfigured 0 would purge the trash on the next sweep, which defeats the point of having
    // one — so anything unusable falls back rather than being honoured.
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GRACE_DAYS;
};

/**
 * Pass 1. Expiry is inherited as a ceiling — a folder's deadline applies to everything inside it —
 * and that falls out of trashing the whole subtree rather than needing to compute each descendant's
 * effective expiry: whichever ancestor comes due first takes its contents with it.
 */
const expireDue = async (nowIso) => {
    const due = await store.expiredNodes(nowIso);
    let trashed = 0;
    for (const node of due) {
        const r = await store.trashNode({ owner: node.owner_username, id: node.id });
        if (r.ok) trashed += r.trashed;
        else await log(`File expiry skipped "${node.name}" (${node.id}): ${r.error}`, 'WARN');
    }
    return { expired: due.length, trashed };
};

/** Pass 2. Rows first, then bytes — see the note at the top of this file. */
const purgeOldTrash = async (cutoffIso) => {
    const rows = await store.purgeableNodes(cutoffIso);
    if (!rows.length) return { purged: 0, unlinked: 0 };

    await store.purgeRows(rows.map((r) => r.id));

    let unlinked = 0;
    for (const row of rows.filter((r) => r.storage_name)) {
        try {
            await fs.unlink(storagePathFor(row.storage_name));
            unlinked += 1;
        } catch (e) {
            // Already gone is the expected case after a crash between the two steps, and is fine.
            if (e.code !== 'ENOENT') await log(`Could not unlink ${row.storage_name}: ${e.message}`, 'WARN');
        }
    }
    return { purged: rows.length, unlinked };
};

/**
 * Pass 3. Compares the shard directories against the storage names the database still knows about.
 *
 * Only unlinks; never removes a directory. There is no realpath anywhere in this codebase, so a
 * recursive delete here would be the one place a planted symlink could do damage — and 256 empty
 * shard directories cost nothing to leave alone.
 */
const collectOrphans = async (now) => {
    if (!existsSync(FILES_ROOT)) return { orphans: 0 };
    const known = await store.knownStorageNames();
    let orphans = 0;

    for (const shard of await fs.readdir(FILES_ROOT, { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        const shardPath = path.join(FILES_ROOT, shard.name);

        for (const entry of await fs.readdir(shardPath, { withFileTypes: true })) {
            if (!entry.isFile() || known.has(entry.name)) continue;
            const full = path.join(shardPath, entry.name);
            try {
                const stat = await fs.stat(full);
                // Age matters: a file written seconds ago is probably an upload mid-flight whose row
                // has not been inserted yet, and deleting it would break a request in progress.
                if (now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
                await fs.unlink(full);
                orphans += 1;
            } catch (e) {
                if (e.code !== 'ENOENT') await log(`Orphan sweep skipped ${entry.name}: ${e.message}`, 'WARN');
            }
        }
    }
    return { orphans };
};

export const runFileReaper = async (now = Date.now()) => {
    const nowIso = new Date(now).toISOString();
    const cutoffIso = new Date(now - (await graceDays()) * 24 * 60 * 60 * 1000).toISOString();

    const expired = await expireDue(nowIso);
    const purged = await purgeOldTrash(cutoffIso);
    const orphaned = await collectOrphans(now);

    // Only speaks up when it did something — an hourly job that logs every hour is an hourly job
    // nobody reads.
    if (expired.expired || purged.purged || orphaned.orphans) {
        await log(
            `File reaper: expired ${expired.expired} (${expired.trashed} rows trashed), ` +
            `purged ${purged.purged} rows / ${purged.unlinked} files, ${orphaned.orphans} orphan(s) removed`,
            'INFO'
        );
    }
    return { ...expired, ...purged, ...orphaned };
};

export const startFileReaper = () => {
    setInterval(() => { runFileReaper().catch((e) => console.error('File reaper failed:', e.message)); }, 60 * 60 * 1000);
    // Once at boot as well, so a server that was down over a deadline catches up rather than waiting
    // an hour to notice.
    runFileReaper().catch((e) => console.error('File reaper failed:', e.message));
};

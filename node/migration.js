import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { loadPendingMigrations, savePendingMigrations } from './config.js';
import { ACTIVE_MIGRATIONS } from './state.js';

// ==========================================
// STORAGE MIGRATION — moving files between locations when a path changes or a
// location is removed, without ever orphaning files still sitting in the old spot.
// ==========================================

// Moves one file between two directories without ever exposing a partial file to a concurrent
// reader: same-device files use an atomic rename directly; cross-device files are streamed
// into a temp name in the destination first, then atomically renamed into the real filename,
// then the source is unlinked. Refuses to clobber a same-named file already at the
// destination (e.g. a fresh upload landed there after the migration started) — that file is
// left in place and reported as a conflict rather than silently overwritten.
const moveFileSafely = async (fromPath, toPath, filename) => {
    const src = path.join(fromPath, filename);
    const dest = path.join(toPath, filename);

    let destStat = null;
    try { destStat = await fsp.stat(dest); } catch (e) { /* dest doesn't exist yet — proceed */ }

    if (destStat) {
        // dest already existing isn't necessarily a genuine collision — a prior run of this
        // same migration can have completed the rename but crashed before unlinking the
        // source, which used to be misclassified as a permanent conflict with no way to
        // resolve it: the stale duplicate at src would sit there forever and this migration
        // would never clear. If src is already gone, or matches dest's size, treat it as
        // "already moved" and just finish the last step instead of a genuine collision (an
        // unrelated file that happens to share this name, e.g. a fresh upload landed there
        // after the migration started).
        let srcStat = null;
        try { srcStat = await fsp.stat(src); } catch (e) {}
        if (!srcStat || srcStat.size === destStat.size) {
            if (srcStat) await fsp.unlink(src).catch(() => {});
            return { status: 'moved' };
        }
        return { status: 'conflict' };
    }

    try {
        await fsp.rename(src, dest);
        return { status: 'moved' };
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
    }

    const tempDest = path.join(toPath, `.migrate_${Date.now()}_${filename}`);
    try {
        await new Promise((resolve, reject) => {
            const read = fs.createReadStream(src);
            const write = fs.createWriteStream(tempDest);
            read.on('error', reject);
            write.on('error', reject);
            write.on('finish', resolve);
            read.pipe(write);
        });
        await fsp.rename(tempDest, dest);
    } catch (e) {
        // Without this, a crash or write failure (e.g. the destination disk filling up —
        // exactly the disk-pressure condition likely to cause this in the first place) left
        // the temp file behind with no cleanup path; every retry then created a new
        // differently-timestamped orphan without ever removing the last one.
        await fsp.unlink(tempDest).catch(() => {});
        throw e;
    }
    await fsp.unlink(src);
    return { status: 'moved' };
};

export const runMigration = async (id, fromPath, toPath) => {
    const info = { fromPath, toPath, filesTotal: 0, filesMoved: 0, bytesTotal: 0, bytesMoved: 0, status: 'running', conflicts: [] };
    ACTIVE_MIGRATIONS.set(id, info);

    try {
        // A crash mid-copy on a previous attempt at this same migration can leave a stray
        // .migrate_* temp file in the destination — clean those up before resuming, otherwise
        // every retry creates a new differently-timestamped orphan without ever removing the
        // last one, compounding disk usage under exactly the pressure that likely caused the
        // original failure.
        try {
            const destEntries = await fsp.readdir(toPath);
            for (const name of destEntries) {
                if (name.startsWith('.migrate_')) await fsp.unlink(path.join(toPath, name)).catch(() => {});
            }
        } catch (e) {}

        const entries = await fsp.readdir(fromPath);
        const files = [];
        for (const name of entries) {
            if (name.startsWith('.migrate_')) continue; // our own leftover temp files, if any
            try {
                const s = await fsp.stat(path.join(fromPath, name));
                if (s.isFile()) files.push({ name, size: s.size });
            } catch (e) {}
        }
        info.filesTotal = files.length;
        info.bytesTotal = files.reduce((s, f) => s + f.size, 0);

        for (const file of files) {
            const result = await moveFileSafely(fromPath, toPath, file.name);
            if (result.status === 'conflict') {
                info.conflicts.push(file.name);
            } else {
                // Previously incremented even on a conflict — a file that was actually left
                // behind (not moved) was still counted as progress, overstating completion.
                info.filesMoved++;
                info.bytesMoved += file.size;
            }
        }
    } catch (e) {
        if (e.code === 'ENOENT') {
            // fromPath is already gone — this migration completed in some prior run, but that
            // completion didn't persist (e.g. a crash between the rmdir below and this
            // migration's own record being cleared). The directory being gone IS the success
            // condition, so treat it as done rather than failed — otherwise this exact
            // migration re-attempts and re-fails identically on every single boot, forever.
            console.log(`✅ Migration ${id}: source ${fromPath} no longer exists — already completed.`);
            ACTIVE_MIGRATIONS.delete(id);
            savePendingMigrations(loadPendingMigrations().filter(m => m.id !== id));
            return;
        }
        info.status = 'failed';
        console.error(`❌ Migration ${id} (${fromPath} -> ${toPath}) failed:`, e.message);
        return; // left in ACTIVE_MIGRATIONS + migrations.json — retried on next restart
    }

    info.status = info.conflicts.length ? 'completed_with_conflicts' : 'completed';
    // Only stop tracking (and drop the persisted record) once fromPath has no more real files
    // left unaccounted for — a conflict must keep the source path reachable/findable.
    if (info.conflicts.length === 0) {
        ACTIVE_MIGRATIONS.delete(id);
        savePendingMigrations(loadPendingMigrations().filter(m => m.id !== id));
        try { await fsp.rmdir(fromPath); } catch (e) {}
    }
};

// Kicks off a new migration: persists the routing fact first (so a restart mid-move doesn't
// lose track of it), then runs it in the background without blocking the request.
export const startMigration = (locationId, fromPath, toPath, reason) => {
    const id = crypto.randomUUID();
    const record = { id, locationId, fromPath, toPath, reason, startedAt: Date.now() };
    savePendingMigrations([...loadPendingMigrations(), record]);
    runMigration(id, fromPath, toPath); // fire-and-forget; live progress tracked in ACTIVE_MIGRATIONS
    return record;
};

export const resumePendingMigrationsOnBoot = () => {
    for (const m of loadPendingMigrations()) {
        console.log(`↔️  Resuming migration ${m.fromPath} -> ${m.toPath}`);
        runMigration(m.id, m.fromPath, m.toPath); // same persisted toPath — no re-run of placement policy
    }
};

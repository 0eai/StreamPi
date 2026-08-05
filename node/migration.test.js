import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// config.js reads node_config.json and process.exit(1)s if it's missing — not something a
// unit test should depend on the local machine having. migration.js's only import from it is
// loadPendingMigrations/savePendingMigrations, which we stub out with an in-memory list so
// runMigration's actual file-moving logic is exercised without touching migrations.json.
let pending = [];
vi.mock('./config.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        loadPendingMigrations: () => pending,
        savePendingMigrations: (list) => { pending = list; }
    };
});

const { runMigration } = await import('./migration.js');
const { ACTIVE_MIGRATIONS } = await import('./state.js');

describe('runMigration crash-recovery', () => {
    let fromDir, toDir;

    beforeEach(async () => {
        pending = [];
        ACTIVE_MIGRATIONS.clear();
        fromDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'streampi-migrate-from-'));
        toDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'streampi-migrate-to-'));
    });

    afterEach(async () => {
        await fsp.rm(fromDir, { recursive: true, force: true });
        await fsp.rm(toDir, { recursive: true, force: true });
    });

    it('moves every file from source to destination and cleans up the source directory', async () => {
        await fsp.writeFile(path.join(fromDir, 'a.mp4'), 'aaa');
        await fsp.writeFile(path.join(fromDir, 'b.mp4'), 'bb');

        await runMigration('mig-1', fromDir, toDir);

        expect(fs.existsSync(path.join(toDir, 'a.mp4'))).toBe(true);
        expect(fs.existsSync(path.join(toDir, 'b.mp4'))).toBe(true);
        expect(fs.existsSync(fromDir)).toBe(false); // source dir removed once fully migrated
        expect(ACTIVE_MIGRATIONS.has('mig-1')).toBe(false);
        expect(pending).toEqual([]);
    });

    it('cleans up an orphaned .migrate_* temp file left by a crash on a previous attempt', async () => {
        await fsp.writeFile(path.join(fromDir, 'a.mp4'), 'aaa');
        // Simulate a crash mid-copy on a prior attempt at this same migration.
        await fsp.writeFile(path.join(toDir, '.migrate_12345_a.mp4'), 'partial');

        await runMigration('mig-2', fromDir, toDir);

        const destEntries = await fsp.readdir(toDir);
        expect(destEntries).toEqual(['a.mp4']); // orphan gone, real file present
    });

    it('resolves a rename-then-crash-before-unlink as already-moved instead of a conflict, when sizes match', async () => {
        // Simulate: the rename to dest succeeded, but the process crashed before the source
        // unlink ran — both files now exist with identical content/size.
        await fsp.writeFile(path.join(fromDir, 'a.mp4'), 'identical-content');
        await fsp.writeFile(path.join(toDir, 'a.mp4'), 'identical-content');

        await runMigration('mig-3', fromDir, toDir);

        expect(fs.existsSync(path.join(fromDir, 'a.mp4'))).toBe(false); // stale source cleaned up
        expect(fs.existsSync(path.join(toDir, 'a.mp4'))).toBe(true);
        expect(ACTIVE_MIGRATIONS.has('mig-3')).toBe(false); // no conflict recorded, migration cleared
    });

    it('reports a genuine same-name collision as a conflict, not an already-moved file', async () => {
        // An unrelated file happens to share this name at the destination — different content/size.
        await fsp.writeFile(path.join(fromDir, 'a.mp4'), 'short');
        await fsp.writeFile(path.join(toDir, 'a.mp4'), 'a much longer unrelated file content');

        await runMigration('mig-4', fromDir, toDir);

        expect(fs.existsSync(path.join(fromDir, 'a.mp4'))).toBe(true); // left in place, not clobbered
        const info = ACTIVE_MIGRATIONS.get('mig-4');
        expect(info.conflicts).toEqual(['a.mp4']);
        expect(info.status).toBe('completed_with_conflicts');
        // A conflict must keep the migration tracked/persisted so the source stays reachable.
        expect(pending.length).toBe(0); // (mig-4 was never added to `pending` in this test — startMigration does that)
    });

    it('treats an already-gone source directory (ENOENT) as already completed, not failed', async () => {
        await fsp.rm(fromDir, { recursive: true, force: true }); // source never existed / already fully migrated
        pending = [{ id: 'mig-5', fromPath: fromDir, toPath: toDir }];

        await runMigration('mig-5', fromDir, toDir);

        expect(ACTIVE_MIGRATIONS.has('mig-5')).toBe(false);
        expect(pending).toEqual([]); // cleared from the persisted list, not retried forever
    });
});

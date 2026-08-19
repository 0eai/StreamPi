import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * The reaper is the only thing in this feature that destroys data, so these run against real SQLite
 * and a real temp directory: what matters is that phase 1 does NOT unlink, phase 2 does, and neither
 * touches anything it shouldn't.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-'));
const FILES_ROOT = path.join(tmp, 'StreamFiles');

vi.mock('./paths.js', () => ({
    FILES_ROOT,
    TEMP_DIR: path.join(tmp, 'temp'),
    storagePathFor: (n) => path.join(FILES_ROOT, String(n).slice(0, 2), String(n)),
    HIDDEN_DATA_FOLDER: tmp, THUMB_FOLDER: tmp, DB_PATH: path.join(tmp, 'x.db'),
}));

const findUp = (rel) => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
        const c = path.join(dir, rel);
        if (fs.existsSync(c)) return c;
        dir = path.dirname(dir);
    }
    throw new Error(`could not locate ${rel}`);
};
const dbSource = fs.readFileSync(findUp('server/src/db.js'), 'utf8');
const ddlFor = (t) => new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n            \\);`).exec(dbSource)[0];
const liveNameIndex = () => /CREATE UNIQUE INDEX IF NOT EXISTS idx_file_nodes_live_name[\s\S]*?deleted_at IS NULL/.exec(dbSource)[0];

const args = (p) => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
let raw;
const adapter = {
    get: async (sql, p) => raw.prepare(sql).get(...args(p)),
    all: async (sql, p) => raw.prepare(sql).all(...args(p)),
    run: async (sql, p) => {
        const i = raw.prepare(sql).run(...args(p));
        return { changes: i.changes, lastID: i.lastInsertRowid };
    },
};
let graceSetting = '7';
vi.mock('./db.js', () => ({
    db: adapter,
    initDB: vi.fn(),
    getSetting: vi.fn(async (k, d) => (k === 'files_trash_grace_days' ? graceSetting : d)),
    logActivity: vi.fn(),
}));
vi.mock('./logger.js', () => ({ log: vi.fn() }));

const store = await import('./fileStore.js');
const { runFileReaper } = await import('./fileReaper.js');

const DAY = 86400000;
const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let root;
const writeBytes = (storageName, contents = 'x', mtimeMs = NOW) => {
    const p = path.join(FILES_ROOT, storageName.slice(0, 2), storageName);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
    fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    return p;
};
const exists = (storageName) => fs.existsSync(path.join(FILES_ROOT, storageName.slice(0, 2), storageName));

beforeEach(async () => {
    fs.rmSync(FILES_ROOT, { recursive: true, force: true });
    fs.mkdirSync(FILES_ROOT, { recursive: true });
    raw = new Database(':memory:');
    raw.exec(ddlFor('file_nodes'));
    raw.exec(liveNameIndex());
    raw.exec(ddlFor('file_shares'));
    graceSetting = '7';
    root = await store.ensureRoot('ranjan');
});

const addFile = async (name, storageName, parentId = root.id) => {
    const r = await store.createFile({ owner: 'ranjan', parentId, name, storageName, size: 1, mime: null });
    writeBytes(storageName);
    return r.node;
};

describe('phase 1: expiry', () => {
    it('moves a due item to the trash without unlinking anything', async () => {
        // The whole reason expiry goes through the trash: an auto-delete the owner did not expect is
        // still recoverable for the grace period.
        const f = await addFile('a.txt', 'aaaa1111');
        await store.setExpiry({ owner: 'ranjan', id: f.id, expiresAt: iso(NOW - 1000) });

        const r = await runFileReaper(NOW);
        expect(r.expired).toBe(1);
        expect(await store.getNode(f.id)).toBeUndefined();
        expect(exists('aaaa1111')).toBe(true);
    });

    it('takes a folder\'s whole subtree with it, which is how the ceiling rule is enforced', async () => {
        const dir = (await store.createFolder({ owner: 'ranjan', parentId: root.id, name: 'D' })).node;
        const inner = await addFile('inner.txt', 'bbbb2222', dir.id);
        // Explicitly set to never — the folder's deadline still wins, because a surviving child of a
        // deleted parent would be unreachable.
        await store.setExpiry({ owner: 'ranjan', id: inner.id, expiresAt: null });
        await store.setExpiry({ owner: 'ranjan', id: dir.id, expiresAt: iso(NOW - 1000) });

        const r = await runFileReaper(NOW);
        expect(r.trashed).toBe(2);
        expect(await store.getNode(inner.id)).toBeUndefined();
    });

    it('leaves a future deadline alone', async () => {
        const f = await addFile('a.txt', 'cccc3333');
        await store.setExpiry({ owner: 'ranjan', id: f.id, expiresAt: iso(NOW + DAY) });
        expect((await runFileReaper(NOW)).expired).toBe(0);
        expect(await store.getNode(f.id)).toBeDefined();
    });
});

describe('phase 2: purge', () => {
    it('leaves the trash alone inside the grace period', async () => {
        const f = await addFile('a.txt', 'dddd4444');
        await store.trashNode({ owner: 'ranjan', id: f.id });
        raw.prepare('UPDATE file_nodes SET deleted_at = ? WHERE id = ?').run(iso(NOW - 3 * DAY), f.id);

        expect((await runFileReaper(NOW)).purged).toBe(0);
        expect(exists('dddd4444')).toBe(true);
        expect(await store.getNodeIncludingTrashed(f.id)).toBeDefined();
    });

    it('removes rows and bytes once the grace period has passed', async () => {
        const f = await addFile('a.txt', 'eeee5555');
        await store.trashNode({ owner: 'ranjan', id: f.id });
        raw.prepare('UPDATE file_nodes SET deleted_at = ? WHERE id = ?').run(iso(NOW - 8 * DAY), f.id);

        const r = await runFileReaper(NOW);
        expect(r.purged).toBe(1);
        expect(r.unlinked).toBe(1);
        expect(exists('eeee5555')).toBe(false);
        expect(await store.getNodeIncludingTrashed(f.id)).toBeUndefined();
    });

    it('removes the item\'s shares with it, so nothing points at a row that is gone', async () => {
        const f = await addFile('a.txt', 'ffff6666');
        raw.prepare(`INSERT INTO file_shares (id, node_id, kind, token, owner_username, created_at)
                     VALUES ('s1', ?, 'link', 'tok', 'ranjan', 'now')`).run(f.id);
        await store.trashNode({ owner: 'ranjan', id: f.id });
        raw.prepare('UPDATE file_nodes SET deleted_at = ? WHERE id = ?').run(iso(NOW - 8 * DAY), f.id);

        await runFileReaper(NOW);
        expect(raw.prepare('SELECT COUNT(*) c FROM file_shares').get().c).toBe(0);
    });

    it('honours a configured grace period, and refuses an unusable one', async () => {
        const f = await addFile('a.txt', 'gggg7777');
        await store.trashNode({ owner: 'ranjan', id: f.id });
        raw.prepare('UPDATE file_nodes SET deleted_at = ? WHERE id = ?').run(iso(NOW - 2 * DAY), f.id);

        graceSetting = '1';
        expect((await runFileReaper(NOW)).purged).toBe(1);

        const g = await addFile('b.txt', 'hhhh8888');
        await store.trashNode({ owner: 'ranjan', id: g.id });
        raw.prepare('UPDATE file_nodes SET deleted_at = ? WHERE id = ?').run(iso(NOW - 2 * DAY), g.id);
        // A 0 would purge the trash on the next sweep, defeating the point of having one.
        graceSetting = '0';
        expect((await runFileReaper(NOW)).purged).toBe(0);
    });
});

describe('phase 3: orphans', () => {
    it('removes bytes with no row once they are old enough', async () => {
        writeBytes('9999abcd', 'stray', NOW - 2 * DAY);
        expect((await runFileReaper(NOW)).orphans).toBe(1);
        expect(exists('9999abcd')).toBe(false);
    });

    it('leaves a recent stray alone, since it is probably an upload in flight', async () => {
        // The upload route renames bytes into place before inserting the row, so for a moment every
        // upload looks exactly like an orphan.
        writeBytes('1111abcd', 'in flight', NOW - 60 * 1000);
        expect((await runFileReaper(NOW)).orphans).toBe(0);
        expect(exists('1111abcd')).toBe(true);
    });

    it('never touches bytes a row still references, including a trashed one', async () => {
        const f = await addFile('a.txt', '2222abcd');
        fs.utimesSync(path.join(FILES_ROOT, '22', '2222abcd'), new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
        await store.trashNode({ owner: 'ranjan', id: f.id });

        expect((await runFileReaper(NOW)).orphans).toBe(0);
        expect(exists('2222abcd')).toBe(true);
    });

    it('leaves the shard directories in place rather than removing them', async () => {
        // Deliberate: nothing in this codebase resolves symlinks, so a recursive delete here would be
        // the one place a planted link could do damage. Empty directories cost nothing.
        writeBytes('3333abcd', 'x', NOW - 2 * DAY);
        await runFileReaper(NOW);
        expect(fs.existsSync(path.join(FILES_ROOT, '33'))).toBe(true);
    });
});

describe('restore', () => {
    it('brings back a whole trashed subtree', async () => {
        const dir = (await store.createFolder({ owner: 'ranjan', parentId: root.id, name: 'D' })).node;
        const inner = await addFile('inner.txt', '4444abcd', dir.id);
        await store.trashNode({ owner: 'ranjan', id: dir.id });

        const r = await store.restoreNode({ owner: 'ranjan', id: dir.id });
        expect(r.restored).toBe(2);
        expect(await store.getNode(inner.id)).toBeDefined();
    });

    it('rehydrates trashed ancestors so a restored file is where it was', async () => {
        // Otherwise the file comes back attached to a parent still in the trash — neither visible nor
        // really restored — and relocating it to the top level would lose where it belonged.
        const dir = (await store.createFolder({ owner: 'ranjan', parentId: root.id, name: 'D' })).node;
        const inner = await addFile('inner.txt', '5555abcd', dir.id);
        await store.trashNode({ owner: 'ranjan', id: dir.id });

        await store.restoreNode({ owner: 'ranjan', id: inner.id });
        expect(await store.getNode(inner.id)).toBeDefined();
        expect(await store.getNode(dir.id)).toBeDefined();
    });

    it('refuses when something has taken the name, explaining rather than erroring', async () => {
        const f = await addFile('notes.txt', '6666abcd');
        await store.trashNode({ owner: 'ranjan', id: f.id });
        await addFile('notes.txt', '7777abcd');

        const r = await store.restoreNode({ owner: 'ranjan', id: f.id });
        expect(r.status).toBe(409);
        expect(r.error).toMatch(/rename it first/);
    });

    it('refuses a live item and someone else\'s', async () => {
        const f = await addFile('a.txt', '8888abcd');
        expect((await store.restoreNode({ owner: 'ranjan', id: f.id })).status).toBe(404);
        await store.trashNode({ owner: 'ranjan', id: f.id });
        expect((await store.restoreNode({ owner: 'ashutosh', id: f.id })).status).toBe(403);
    });
});

describe('listTrash', () => {
    it('shows only the top-most trashed items, not every marked descendant', async () => {
        const dir = (await store.createFolder({ owner: 'ranjan', parentId: root.id, name: 'D' })).node;
        await addFile('inner.txt', 'aaaabbbb', dir.id);
        await store.trashNode({ owner: 'ranjan', id: dir.id });

        const rows = await store.listTrash('ranjan');
        expect(rows.map((r) => r.name)).toEqual(['D']);
    });

    it('is per owner', async () => {
        const f = await addFile('a.txt', 'ccccdddd');
        await store.trashNode({ owner: 'ranjan', id: f.id });
        expect(await store.listTrash('ashutosh')).toEqual([]);
    });
});

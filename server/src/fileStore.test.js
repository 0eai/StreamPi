import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Run against real SQLite rather than a mocked db, because the things most likely to be wrong here
 * are the SQL itself: the path_ids rewrite on a move, whether a trashed sibling still reserves its
 * name, and whether the quota sum counts what it should. A stubbed db.run would agree with any of
 * those being wrong.
 *
 * The adapter below is the small part of the `sqlite` wrapper's surface that fileStore uses.
 */
const findUp = (rel) => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
        const candidate = path.join(dir, rel);
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
    }
    throw new Error(`could not locate ${rel}`);
};
const dbSource = fs.readFileSync(findUp('server/src/db.js'), 'utf8');
const ddlFor = (table) =>
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n            \\);`).exec(dbSource)[0];

const args = (params) => (params === undefined ? [] : Array.isArray(params) ? params : [params]);
let raw;
const adapter = {
    get: async (sql, params) => raw.prepare(sql).get(...args(params)),
    all: async (sql, params) => raw.prepare(sql).all(...args(params)),
    run: async (sql, params) => {
        const info = raw.prepare(sql).run(...args(params));
        return { changes: info.changes, lastID: info.lastInsertRowid };
    },
};
vi.mock('./db.js', () => ({ db: adapter, initDB: vi.fn() }));

const store = await import('./fileStore.js');

let root;
beforeEach(async () => {
    raw = new Database(':memory:');
    raw.exec(ddlFor('file_nodes'));
    raw.exec(ddlFor('file_shares'));
    root = await store.ensureRoot('ranjan');
});

const folder = async (name, parentId = root.id, owner = 'ranjan') => {
    const r = await store.createFolder({ owner, parentId, name });
    expect(r.ok, r.error).toBe(true);
    return r.node;
};
const file = async (name, parentId = root.id, size = 100) => {
    const r = await store.createFile({ owner: 'ranjan', parentId, name, storageName: 'sn' + name, size, mime: null });
    expect(r.ok, r.error).toBe(true);
    return r.node;
};

describe('ensureRoot', () => {
    it('is idempotent, so every caller can just ask for it', async () => {
        const again = await store.ensureRoot('ranjan');
        expect(again.id).toBe(root.id);
        expect(raw.prepare('SELECT COUNT(*) c FROM file_nodes').get().c).toBe(1);
    });

    it('gives each user their own, named so it can never collide with a real folder', async () => {
        const other = await store.ensureRoot('ashutosh');
        expect(other.id).not.toBe(root.id);
        expect(root.name).toBe('');
        expect(root.parent_id).toBeNull();
    });
});

describe('createFolder', () => {
    it('refuses a duplicate name in the same folder', async () => {
        await folder('Docs');
        const r = await store.createFolder({ owner: 'ranjan', parentId: root.id, name: 'Docs' });
        expect(r.status).toBe(409);
        expect(r.error).toMatch(/already exists/);
    });

    it('treats names case-insensitively, so "Docs" and "docs" cannot both exist', async () => {
        await folder('Docs');
        expect((await store.createFolder({ owner: 'ranjan', parentId: root.id, name: 'docs' })).status).toBe(409);
    });

    it('allows the same name under different parents', async () => {
        const a = await folder('A');
        const b = await folder('B');
        await folder('shared', a.id);
        expect((await store.createFolder({ owner: 'ranjan', parentId: b.id, name: 'shared' })).ok).toBe(true);
    });

    it("refuses to create inside another user's folder", async () => {
        const mine = await folder('Mine');
        const r = await store.createFolder({ owner: 'ashutosh', parentId: mine.id, name: 'Theirs' });
        expect(r.status).toBe(403);
    });

    it('rejects an invalid name before touching the database', async () => {
        expect((await store.createFolder({ owner: 'ranjan', parentId: root.id, name: '..' })).status).toBe(400);
    });
});

describe('ensureFolderPath', () => {
    it('creates a nested path and returns its leaf', async () => {
        const r = await store.ensureFolderPath({ owner: 'ranjan', parentId: root.id, segments: ['2025', 'Q1'] });
        expect(r.ok).toBe(true);
        expect(r.node.name).toBe('Q1');
        const ancestors = await store.ancestorsOf(r.node);
        expect(ancestors.map((a) => a.name)).toEqual(['', '2025']);
    });

    it('is idempotent, which is what lets a folder upload be re-run', async () => {
        // The difference from createFolder: re-sending a directory tree that already exists has to
        // succeed, or every re-upload fails on the first existing directory.
        const first = await store.ensureFolderPath({ owner: 'ranjan', parentId: root.id, segments: ['a', 'b'] });
        const second = await store.ensureFolderPath({ owner: 'ranjan', parentId: root.id, segments: ['a', 'b'] });
        expect(second.node.id).toBe(first.node.id);
        expect(raw.prepare("SELECT COUNT(*) c FROM file_nodes WHERE is_folder = 1").get().c).toBe(3); // root + a + b
    });

    it('reports a file already holding the name rather than silently diverting', async () => {
        await file('reports');
        const r = await store.ensureFolderPath({ owner: 'ranjan', parentId: root.id, segments: ['reports', 'x'] });
        expect(r.status).toBe(409);
        expect(r.error).toMatch(/as a file/);
    });
});

describe('moveNode', () => {
    it('rewrites every descendant path, keeping relative position', async () => {
        // The single most consequential query in the store: get this wrong and a subtree either
        // detaches from its owner's root or lands inside the wrong ancestor chain.
        const a = await folder('A');
        const b = await folder('B');
        const inner = await folder('inner', a.id);
        const leaf = await file('leaf.txt', inner.id);

        expect((await store.moveNode({ owner: 'ranjan', id: a.id, destinationId: b.id })).ok).toBe(true);

        const movedA = await store.getNode(a.id);
        const movedInner = await store.getNode(inner.id);
        const movedLeaf = await store.getNode(leaf.id);
        expect(movedA.parent_id).toBe(b.id);
        expect(movedA.path_ids).toBe(`/${root.id}/${b.id}/${a.id}/`);
        expect(movedInner.path_ids).toBe(`/${root.id}/${b.id}/${a.id}/${inner.id}/`);
        expect(movedLeaf.path_ids).toBe(`/${root.id}/${b.id}/${a.id}/${inner.id}/${leaf.id}/`);
        // parent_id of descendants is untouched — only the path changes.
        expect(movedInner.parent_id).toBe(a.id);
    });

    it('leaves unrelated subtrees alone', async () => {
        const a = await folder('A');
        const b = await folder('B');
        const other = await folder('Other');
        const otherChild = await file('x.txt', other.id);
        const before = (await store.getNode(otherChild.id)).path_ids;

        await store.moveNode({ owner: 'ranjan', id: a.id, destinationId: b.id });
        expect((await store.getNode(otherChild.id)).path_ids).toBe(before);
    });

    it('refuses to move a folder into its own subtree', async () => {
        const a = await folder('A');
        const inner = await folder('inner', a.id);
        const r = await store.moveNode({ owner: 'ranjan', id: a.id, destinationId: inner.id });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/into itself/);
    });

    it("refuses to move into another user's folder", async () => {
        const otherRoot = await store.ensureRoot('ashutosh');
        const theirs = await folder('Theirs', otherRoot.id, 'ashutosh');
        const mine = await file('mine.txt');
        const r = await store.moveNode({ owner: 'ranjan', id: mine.id, destinationId: theirs.id });
        expect(r.ok).toBe(false);
    });

    it('refuses a name collision at the destination and changes nothing', async () => {
        const b = await folder('B');
        await file('same.txt', b.id);
        const moving = await file('same.txt');
        const r = await store.moveNode({ owner: 'ranjan', id: moving.id, destinationId: b.id });
        expect(r.status).toBe(409);
        expect((await store.getNode(moving.id)).parent_id).toBe(root.id);
    });

    it('refuses to move the root itself', async () => {
        const b = await folder('B');
        expect((await store.moveNode({ owner: 'ranjan', id: root.id, destinationId: b.id })).ok).toBe(false);
    });
});

describe('trashNode', () => {
    it('marks the whole subtree and hides it from listings', async () => {
        const a = await folder('A');
        const inner = await file('inner.txt', a.id);

        const r = await store.trashNode({ owner: 'ranjan', id: a.id });
        expect(r.trashed).toBe(2);
        expect(await store.getNode(a.id)).toBeUndefined();
        expect(await store.getNode(inner.id)).toBeUndefined();
        expect(await store.listChildren(root.id)).toHaveLength(0);
        // Still in the table — the reaper is what eventually removes it.
        expect(await store.getNodeIncludingTrashed(a.id)).toBeDefined();
    });

    it('frees the name for reuse immediately', async () => {
        // Otherwise deleting something would reserve its name for the whole grace period, and
        // "delete it and upload it again" — the most obvious recovery there is — would fail.
        const f = await file('notes.txt');
        await store.trashNode({ owner: 'ranjan', id: f.id });
        expect((await store.createFile({ owner: 'ranjan', parentId: root.id, name: 'notes.txt', storageName: 's2', size: 1 })).ok).toBe(true);
    });

    it("refuses someone else's item, and the root", async () => {
        const f = await file('mine.txt');
        expect((await store.trashNode({ owner: 'ashutosh', id: f.id })).status).toBe(403);
        expect((await store.trashNode({ owner: 'ranjan', id: root.id })).ok).toBe(false);
    });
});

describe('usedBytes', () => {
    it('sums files only, and keeps counting trashed ones', async () => {
        // Trashed bytes are still on disk until the purge, so excluding them would let a user go
        // over quota by deleting and re-uploading.
        const a = await file('a.bin', root.id, 500);
        await file('b.bin', root.id, 250);
        await folder('folder');
        expect(await store.usedBytes('ranjan')).toBe(750);

        await store.trashNode({ owner: 'ranjan', id: a.id });
        expect(await store.usedBytes('ranjan')).toBe(750);
    });

    it('is per user', async () => {
        await file('a.bin', root.id, 500);
        expect(await store.usedBytes('ashutosh')).toBe(0);
    });
});

describe('listChildren and subtreeSummary', () => {
    it('puts folders first, then names case-insensitively', async () => {
        await file('apple.txt');
        await file('Banana.txt');
        await folder('zebra');
        expect((await store.listChildren(root.id)).map((n) => n.name)).toEqual(['zebra', 'apple.txt', 'Banana.txt']);
    });

    it('describes what a recursive delete is about to remove', async () => {
        const a = await folder('A');
        await file('one.bin', a.id, 10);
        await file('two.bin', a.id, 20);
        expect(await store.subtreeSummary(a)).toEqual({ items: 3, files: 2, bytes: 30 });
    });
});

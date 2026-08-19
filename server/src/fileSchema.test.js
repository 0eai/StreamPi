import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * These assert the two constraints that cannot be added afterwards: SQLite's ALTER TABLE cannot
 * introduce a CHECK, and CREATE TABLE IF NOT EXISTS never re-runs on a database that already has the
 * table. If either is wrong in the first release it stays wrong until someone rebuilds the table.
 *
 * The DDL is read out of db.js rather than retyped, so this tests what actually ships.
 */
// Located by walking up from the cwd rather than from import.meta: `import.meta.dirname` needs Node
// 20.11+, and `import.meta.url` is not reliably a file: URL once a test runner has transformed the
// file. This also works whether vitest is invoked from server/ or from the repo root — the same
// approach nodeDashboardDialogs.test.js uses in the web client.
const findUp = (rel) => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
        const candidate = path.join(dir, rel);
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
    }
    throw new Error(`could not locate ${rel} from ${process.cwd()}`);
};

const dbSource = fs.readFileSync(findUp('server/src/db.js'), 'utf8');

const ddlFor = (table) => {
    const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n            \\);`).exec(dbSource);
    if (!match) throw new Error(`Could not find the CREATE TABLE for ${table} in db.js`);
    return match[0];
};

/** The live-name uniqueness is a separate partial index, so it has to be applied separately too. */
const liveNameIndex = () => {
    const match = /CREATE UNIQUE INDEX IF NOT EXISTS idx_file_nodes_live_name[\s\S]*?deleted_at IS NULL/.exec(dbSource);
    if (!match) throw new Error('Could not find idx_file_nodes_live_name in db.js');
    return match[0];
};

let db;
beforeEach(() => {
    db = new Database(':memory:');
    db.exec(ddlFor('file_nodes'));
    db.exec(liveNameIndex());
    db.exec(ddlFor('file_shares'));
});

const insertNode = (over = {}) => {
    const row = {
        id: 'n1', owner_username: 'ranjan', parent_id: 'root', name: 'thing', is_folder: 0,
        storage_name: 'abc', size: 1, mime: null, path_ids: '/root/n1/',
        created_at: 'now', updated_at: 'now', expires_at: null, deleted_at: null, ...over,
    };
    return db.prepare(`INSERT INTO file_nodes
        (id, owner_username, parent_id, name, is_folder, storage_name, size, mime, path_ids, created_at, updated_at, expires_at, deleted_at)
        VALUES (@id, @owner_username, @parent_id, @name, @is_folder, @storage_name, @size, @mime, @path_ids, @created_at, @updated_at, @expires_at, @deleted_at)`).run(row);
};

const insertShare = (over = {}) => {
    const row = {
        id: 's1', node_id: 'n1', kind: 'link', token: 'tok', recipient_user_id: null,
        owner_username: 'ranjan', created_at: 'now', expires_at: null, revoked: 0,
        open_count: 0, last_accessed_at: null, ...over,
    };
    return db.prepare(`INSERT INTO file_shares
        (id, node_id, kind, token, recipient_user_id, owner_username, created_at, expires_at, revoked, open_count, last_accessed_at)
        VALUES (@id, @node_id, @kind, @token, @recipient_user_id, @owner_username, @created_at, @expires_at, @revoked, @open_count, @last_accessed_at)`).run(row);
};

describe('file_nodes', () => {
    it('rejects two items with the same name in the same folder', () => {
        insertNode({ id: 'a', name: 'Docs' });
        expect(() => insertNode({ id: 'b', name: 'Docs' })).toThrow(/UNIQUE/);
    });

    it('allows the same name in different folders', () => {
        insertNode({ id: 'a', parent_id: 'p1', name: 'README.md' });
        expect(() => insertNode({ id: 'b', parent_id: 'p2', name: 'README.md' })).not.toThrow();
    });

    it('constrains the top level too, because every user has a real root row', () => {
        // The reason roots are real rows: SQLite treats NULLs as distinct in a unique index, so
        // parent_id = NULL for top-level items would leave the entire top level unconstrained. This
        // demonstrates that failure mode is real, and that the design avoids relying on it.
        insertNode({ id: 'r1', parent_id: null, name: '' });
        expect(() => insertNode({ id: 'r2', parent_id: null, name: '' })).not.toThrow();

        // Whereas with a real root as the parent, duplicates are rejected as intended.
        insertNode({ id: 'x', parent_id: 'r1', name: 'Docs' });
        expect(() => insertNode({ id: 'y', parent_id: 'r1', name: 'Docs' })).toThrow(/UNIQUE/);
    });

    it('is case-insensitive, so the database agrees with the application check', () => {
        insertNode({ id: 'a', name: 'Docs' });
        expect(() => insertNode({ id: 'b', name: 'docs' })).toThrow(/UNIQUE/);
    });

    it('stops reserving a name once the row is trashed', () => {
        // Why the uniqueness is a partial index rather than an inline UNIQUE: a table-level
        // constraint applies to trashed rows too, so a deleted file would hold its name for the
        // whole grace period and re-uploading it — the obvious recovery — would fail.
        insertNode({ id: 'a', name: 'notes.txt', deleted_at: '2026-08-19T00:00:00.000Z' });
        expect(() => insertNode({ id: 'b', name: 'notes.txt' })).not.toThrow();
    });

    it('still allows two trashed rows to share a name', () => {
        // Deleting the same name twice over time is normal, and the index must not object.
        insertNode({ id: 'a', name: 'x', deleted_at: 'then' });
        expect(() => insertNode({ id: 'b', name: 'x', deleted_at: 'later' })).not.toThrow();
    });
});

describe('file_shares CHECK', () => {
    it('accepts a link share: a token and no recipient', () => {
        expect(() => insertShare({ kind: 'link', token: 't1', recipient_user_id: null })).not.toThrow();
    });

    it('accepts a user share: a recipient and no token', () => {
        expect(() => insertShare({ kind: 'user', token: null, recipient_user_id: 7 })).not.toThrow();
    });

    it('refuses a user share that carries a token', () => {
        // This is the invariant the whole design leans on: with token guaranteed NULL on user rows,
        // a token lookup cannot return a user grant even if a resolver forgets `AND kind = 'link'`,
        // because NULL = 'abc' is NULL rather than true.
        expect(() => insertShare({ kind: 'user', token: 'sneaky', recipient_user_id: 7 })).toThrow(/CHECK/);
    });

    it('refuses a link share with no token, or one that names a recipient', () => {
        expect(() => insertShare({ kind: 'link', token: null })).toThrow(/CHECK/);
        expect(() => insertShare({ kind: 'link', token: 't', recipient_user_id: 7 })).toThrow(/CHECK/);
    });

    it('refuses an unknown kind, so a third mode cannot be introduced by accident', () => {
        expect(() => insertShare({ kind: 'public', token: 't' })).toThrow(/CHECK/);
    });

    it('keeps tokens unique while allowing many user shares with no token', () => {
        insertShare({ id: 's1', token: 'same' });
        expect(() => insertShare({ id: 's2', token: 'same' })).toThrow(/UNIQUE/);

        // Multiple NULLs in a UNIQUE column are fine in SQLite, which is what lets one table hold
        // any number of user grants alongside tokenized links.
        insertShare({ id: 'u1', kind: 'user', token: null, recipient_user_id: 1 });
        expect(() => insertShare({ id: 'u2', kind: 'user', token: null, recipient_user_id: 2 })).not.toThrow();
    });

    it('allows several people to be given the same node', () => {
        insertShare({ id: 'u1', kind: 'user', token: null, recipient_user_id: 1 });
        expect(() => insertShare({ id: 'u2', kind: 'user', token: null, recipient_user_id: 2 })).not.toThrow();
    });
});

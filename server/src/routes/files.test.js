import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * The repo's first route-level test. The handlers live inside an express Router, so rather than
 * extracting them they are mounted on a real app and driven over HTTP — which also exercises the
 * multipart upload path, the part most likely to be wrong and least amenable to a unit test.
 *
 * paths.js is mocked so the storage roots land in a temp directory: importing the real one would
 * create directories under the developer's home and the upload would write files there.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'files-routes-'));
const FILES_ROOT = path.join(tmp, 'StreamFiles');
const TEMP_DIR = path.join(tmp, 'temp_uploads');
fs.mkdirSync(FILES_ROOT, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

vi.mock('../paths.js', () => ({
    FILES_ROOT,
    TEMP_DIR,
    storagePathFor: (name) => path.join(FILES_ROOT, String(name).slice(0, 2), String(name)),
    // Imported transitively by db.js, which is mocked below but still resolved.
    HIDDEN_DATA_FOLDER: tmp, THUMB_FOLDER: tmp, DB_PATH: path.join(tmp, 'x.db'),
}));

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
const logActivityMock = vi.fn();
let quotaSetting = String(1024 * 1024); // 1 MiB, so quota is reachable in a test
vi.mock('../db.js', () => ({
    db: adapter,
    initDB: vi.fn(),
    logActivity: logActivityMock,
    getSetting: vi.fn(async (k, d) => (k === 'files_quota_bytes' ? quotaSetting : d)),
}));

let currentUser = { id: 1, username: 'ranjan', role: 'user' };
vi.mock('../middleware.js', () => ({
    verifyToken: (req, res, next) => {
        if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
        req.user = currentUser;
        next();
    },
}));

vi.mock('../logger.js', () => ({
    sendServerError: (res, e, msg = 'Something went wrong') => {
        console.error('route error:', e?.message);
        res.status(500).json({ error: msg });
    },
}));

const express = (await import('express')).default;
const filesRouter = (await import('./files.js')).default;
const { FILE_TOKENS } = await import('../state.js');

let server, origin;
beforeEach(async () => {
    // The roots are created once at module scope, so they have to be emptied per test — otherwise
    // an assertion about what is on disk silently counts the previous test's uploads.
    for (const dir of [FILES_ROOT, TEMP_DIR]) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
    }

    raw = new Database(':memory:');
    raw.exec(ddlFor('file_nodes'));
    raw.exec(liveNameIndex());
    raw.exec(ddlFor('file_shares'));
    raw.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, status TEXT)');
    raw.prepare("INSERT INTO users (username, status) VALUES ('ranjan','approved'),('ashutosh','approved'),('pending_guy','pending')").run();

    currentUser = { id: 1, username: 'ranjan', role: 'user' };
    quotaSetting = String(1024 * 1024);
    logActivityMock.mockClear();
    FILE_TOKENS.clear();

    const app = express();
    app.use(express.json());
    app.use(filesRouter);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => server?.close());

const api = async (method, url, body) => {
    const res = await fetch(`${origin}${url}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
};

const uploadFile = async (name, bytes, parentId) => {
    const form = new FormData();
    if (parentId) form.append('parentId', parentId);
    form.append('name', name);
    form.append('file', new Blob([bytes]), name);
    const res = await fetch(`${origin}/api/files/upload`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json().catch(() => ({})) };
};

describe('GET /api/files', () => {
    it('creates the root on first visit and returns an empty listing with quota', async () => {
        const r = await api('GET', '/api/files');
        expect(r.status).toBe(200);
        expect(r.body.parent.isRoot).toBe(true);
        expect(r.body.items).toEqual([]);
        expect(r.body.breadcrumb).toHaveLength(1);
        expect(r.body.quota).toEqual({ used: 0, limit: 1024 * 1024 });
    });

    it("refuses to list another user's folder", async () => {
        const mine = (await api('POST', '/api/files/folder', { name: 'Mine' })).body.item;
        currentUser = { id: 2, username: 'ashutosh', role: 'user' };
        expect((await api('GET', `/api/files?parent=${mine.id}`)).status).toBe(403);
    });

    it('builds a breadcrumb from the root down', async () => {
        const a = (await api('POST', '/api/files/folder', { name: 'A' })).body.item;
        const b = (await api('POST', '/api/files/folder', { parentId: a.id, name: 'B' })).body.item;
        const r = await api('GET', `/api/files?parent=${b.id}`);
        expect(r.body.breadcrumb.map((x) => x.name)).toEqual(['', 'A', 'B']);
    });
});

describe('folders', () => {
    it('rejects a duplicate name with 409 and says which name', async () => {
        await api('POST', '/api/files/folder', { name: 'Docs' });
        const r = await api('POST', '/api/files/folder', { name: 'Docs' });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/"Docs" already exists/);
    });

    it('ensure is idempotent, which is what folder upload needs', async () => {
        const first = await api('POST', '/api/files/folders/ensure', { segments: ['2025', 'Q1'] });
        const second = await api('POST', '/api/files/folders/ensure', { segments: ['2025', 'Q1'] });
        expect(first.status).toBe(200);
        expect(second.body.item.id).toBe(first.body.item.id);
    });

    it('rejects an invalid segment rather than creating part of the path', async () => {
        const r = await api('POST', '/api/files/folders/ensure', { segments: ['ok', '..'] });
        expect(r.status).toBe(400);
    });
});

describe('upload', () => {
    it('stores the bytes under an opaque sharded name and records the row', async () => {
        const r = await uploadFile('report.pdf', 'hello world');
        expect(r.status).toBe(200);
        expect(r.body.item.name).toBe('report.pdf');
        expect(r.body.item.size).toBe(11);

        const row = raw.prepare('SELECT storage_name FROM file_nodes WHERE is_folder = 0').get();
        expect(row.storage_name).toMatch(/^[0-9a-f]{32}$/);
        // On disk it is only that name, in a two-character shard — the display name appears nowhere.
        const onDisk = path.join(FILES_ROOT, row.storage_name.slice(0, 2), row.storage_name);
        expect(fs.readFileSync(onDisk, 'utf8')).toBe('hello world');
        expect(fs.readdirSync(TEMP_DIR)).toEqual([]); // renamed out, not copied
    });

    it('refuses an upload that would exceed the quota, and leaves nothing behind', async () => {
        quotaSetting = '10';
        const r = await uploadFile('big.bin', 'more than ten bytes');
        expect(r.status).toBe(507);
        expect(r.body.error).toMatch(/exceed/);
        expect(fs.readdirSync(TEMP_DIR)).toEqual([]);
        expect(raw.prepare('SELECT COUNT(*) c FROM file_nodes WHERE is_folder = 0').get().c).toBe(0);
    });

    it('counts trashed files toward the quota', async () => {
        quotaSetting = '20';
        const first = await uploadFile('a.bin', '0123456789');
        expect(first.status).toBe(200);
        await api('DELETE', `/api/files/${first.body.item.id}`);
        // Still on disk until the reaper purges it, so it still counts.
        const second = await uploadFile('b.bin', '0123456789abcdef');
        expect(second.status).toBe(507);
    });

    it('rejects a duplicate name and removes the stored bytes again', async () => {
        await uploadFile('same.txt', 'one');
        const r = await uploadFile('same.txt', 'two');
        expect(r.status).toBe(409);
        // Exactly one file's bytes remain — the rejected upload cleaned up after itself.
        const shards = fs.readdirSync(FILES_ROOT).flatMap((d) => fs.readdirSync(path.join(FILES_ROOT, d)));
        expect(shards).toHaveLength(1);
    });

    it('uploads into a named folder', async () => {
        const f = (await api('POST', '/api/files/folder', { name: 'Docs' })).body.item;
        const r = await uploadFile('inside.txt', 'x', f.id);
        expect(r.status).toBe(200);
        const listed = await api('GET', `/api/files?parent=${f.id}`);
        expect(listed.body.items.map((i) => i.name)).toEqual(['inside.txt']);
    });
});

describe('move', () => {
    it('reports per item so one collision does not abandon the batch', async () => {
        const dest = (await api('POST', '/api/files/folder', { name: 'Dest' })).body.item;
        const a = (await uploadFile('a.txt', 'a')).body.item;
        const b = (await uploadFile('b.txt', 'b')).body.item;
        await uploadFile('b.txt', 'clash', dest.id); // occupies the name at the destination

        const r = await api('POST', '/api/files/move', { ids: [a.id, b.id], destinationId: dest.id });
        expect(r.status).toBe(200);
        expect(r.body.moved).toBe(1);
        expect(r.body.results.find((x) => x.id === a.id).ok).toBe(true);
        const failed = r.body.results.find((x) => x.id === b.id);
        expect(failed.ok).toBe(false);
        expect(failed.error).toMatch(/already exists/);
    });

    it('needs both a destination and something to move', async () => {
        expect((await api('POST', '/api/files/move', { ids: [] })).status).toBe(400);
        expect((await api('POST', '/api/files/move', { ids: ['x'] })).status).toBe(400);
    });
});

describe('delete', () => {
    it('moves a subtree to the trash and hides it, without unlinking bytes', async () => {
        const folder = (await api('POST', '/api/files/folder', { name: 'A' })).body.item;
        const inner = (await uploadFile('inner.txt', 'x', folder.id)).body.item;
        const storage = raw.prepare('SELECT storage_name FROM file_nodes WHERE id = ?').get(inner.id).storage_name;

        const r = await api('DELETE', `/api/files/${folder.id}`);
        expect(r.status).toBe(200);
        expect(r.body.trashed).toBe(2);
        expect((await api('GET', '/api/files')).body.items).toEqual([]);
        // The bytes are still there — that is what makes the trash recoverable.
        expect(fs.existsSync(path.join(FILES_ROOT, storage.slice(0, 2), storage))).toBe(true);
    });

    it("refuses someone else's item", async () => {
        const mine = (await api('POST', '/api/files/folder', { name: 'Mine' })).body.item;
        currentUser = { id: 2, username: 'ashutosh', role: 'user' };
        expect((await api('DELETE', `/api/files/${mine.id}`)).status).toBe(403);
    });
});

describe('POST /api/files/:id/token', () => {
    it('mints a grant carrying the resolved path, for the owner only', async () => {
        const f = (await uploadFile('report.pdf', 'bytes')).body.item;
        const r = await api('POST', `/api/files/${f.id}/token`);
        expect(r.status).toBe(200);

        const grant = FILE_TOKENS.get(r.body.token);
        expect(grant.name).toBe('report.pdf');
        expect(grant.absPath.startsWith(FILES_ROOT)).toBe(true);
        expect(r.body.path).toBe(`/f/${r.body.token}`);
    });

    it("refuses another user's file — this is the only place byte access is checked", async () => {
        // The files origin has no database and cannot make this decision, so if it is wrong here it
        // is wrong everywhere.
        const f = (await uploadFile('secret.pdf', 'bytes')).body.item;
        currentUser = { id: 2, username: 'ashutosh', role: 'user' };
        const r = await api('POST', `/api/files/${f.id}/token`);
        expect(r.status).toBe(403);
        expect(FILE_TOKENS.size).toBe(0);
    });

    it('will not mint one for a folder', async () => {
        const f = (await api('POST', '/api/files/folder', { name: 'A' })).body.item;
        expect((await api('POST', `/api/files/${f.id}/token`)).status).toBe(404);
    });
});

describe('GET /api/users/shareable', () => {
    it('lists approved accounts except the caller, excluding ones that cannot sign in', async () => {
        const r = await api('GET', '/api/users/shareable');
        expect(r.status).toBe(200);
        // pending_guy is excluded: sharing with an account that cannot log in would silently do nothing.
        expect(r.body.users.map((u) => u.username)).toEqual(['ashutosh']);
    });
});

// --- Sharing ------------------------------------------------------------------------------------

const RANJAN = 1;
const ASHUTOSH = 2;
const PENDING = 3;

const asAshutosh = () => { currentUser = { id: ASHUTOSH, username: 'ashutosh', role: 'user' }; };

describe('link shares', () => {
    it('creates a link and resolves it without any credential', async () => {
        const f = (await uploadFile('report.pdf', 'bytes')).body.item;
        const made = await api('POST', `/api/files/${f.id}/share`, { kind: 'link' });
        expect(made.status).toBe(200);

        // No user is set for the public routes — they carry no verifyToken at all.
        const info = await api('GET', `/api/files/share/${made.body.token}/info`);
        expect(info.status).toBe(200);
        expect(info.body.current.name).toBe('report.pdf');
    });

    it('lists a shared folder and lets ?node= walk into it', async () => {
        const dir = (await api('POST', '/api/files/folder', { name: 'Docs' })).body.item;
        const sub = (await api('POST', '/api/files/folder', { parentId: dir.id, name: 'Sub' })).body.item;
        await uploadFile('inside.txt', 'x', sub.id);
        const token = (await api('POST', `/api/files/${dir.id}/share`, { kind: 'link' })).body.token;

        const top = await api('GET', `/api/files/share/${token}/info`);
        expect(top.body.items.map((i) => i.name)).toEqual(['Sub']);

        const deeper = await api('GET', `/api/files/share/${token}/info?node=${sub.id}`);
        expect(deeper.body.items.map((i) => i.name)).toEqual(['inside.txt']);
    });

    it('refuses a ?node= that is not inside the share', async () => {
        // Without this a folder link would be a key to the owner's whole tree — the same hole a
        // series share closes by refusing a path that is not one of its episodes.
        const shared = (await api('POST', '/api/files/folder', { name: 'Shared' })).body.item;
        const secret = (await uploadFile('secret.txt', 'nope')).body.item;
        const token = (await api('POST', `/api/files/${shared.id}/share`, { kind: 'link' })).body.token;

        const r = await api('GET', `/api/files/share/${token}/info?node=${secret.id}`);
        expect(r.status).toBe(404);
        expect(r.body.error).toMatch(/not part of this share/);
    });

    it('mints byte tokens for the link but never for a folder', async () => {
        const dir = (await api('POST', '/api/files/folder', { name: 'D' })).body.item;
        const f = (await uploadFile('in.txt', 'x', dir.id)).body.item;
        const token = (await api('POST', `/api/files/${dir.id}/share`, { kind: 'link' })).body.token;

        expect((await api('POST', `/api/files/share/${token}/token`, {})).status).toBe(400);
        const minted = await api('POST', `/api/files/share/${token}/token`, { node: f.id });
        expect(minted.status).toBe(200);
        expect(FILE_TOKENS.get(minted.body.token).name).toBe('in.txt');
    });

    it('counts opens once per landing-page load, not per navigation', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        const token = (await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).body.token;
        await api('GET', `/api/files/share/${token}/info`);
        await api('GET', `/api/files/share/${token}/info`);
        await api('GET', `/api/files/share/${token}/info?node=${f.id}`); // walking, not opening

        expect((await api('GET', '/api/files/shares/mine')).body.shares[0].opens).toBe(2);
    });

    it('dies when the shared item is trashed, immediately and not after the grace period', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        const token = (await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).body.token;
        await api('DELETE', `/api/files/${f.id}`);
        expect((await api('GET', `/api/files/share/${token}/info`)).status).toBe(404);
    });

    it('dies when the owner account is gone, since nobody could revoke it', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        const token = (await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).body.token;
        raw.prepare('DELETE FROM users WHERE username = ?').run('ranjan');
        expect((await api('GET', `/api/files/share/${token}/info`)).status).toBe(404);
    });
});

describe('user shares', () => {
    it('grants several people at once and reports each', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        const r = await api('POST', `/api/files/${f.id}/share`, { kind: 'user', recipientUserIds: [ASHUTOSH, PENDING] });
        expect(r.body.granted).toBe(1);
        // A pending account cannot sign in, so granting it would silently do nothing.
        expect(r.body.results.find((x) => x.recipientUserId === PENDING).ok).toBe(false);
    });

    it('is idempotent per person rather than piling up duplicate grants', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        await api('POST', `/api/files/${f.id}/share`, { kind: 'user', recipientUserIds: [ASHUTOSH] });
        await api('POST', `/api/files/${f.id}/share`, { kind: 'user', recipientUserIds: [ASHUTOSH] });
        expect(raw.prepare("SELECT COUNT(*) c FROM file_shares WHERE kind='user'").get().c).toBe(1);
    });

    it('shows up for the recipient, and lets them read the bytes but not change anything', async () => {
        const f = (await uploadFile('shared.txt', 'x')).body.item;
        await api('POST', `/api/files/${f.id}/share`, { kind: 'user', recipientUserIds: [ASHUTOSH] });

        asAshutosh();
        const inbox = await api('GET', '/api/files/shared-with-me');
        expect(inbox.body.items.map((i) => i.name)).toEqual(['shared.txt']);

        // Byte access works through the grant, not ownership.
        expect((await api('POST', `/api/files/${f.id}/token`)).status).toBe(200);

        // Read-only: every mutation is owner-gated.
        expect((await api('PATCH', `/api/files/${f.id}`, { name: 'renamed.txt' })).status).toBe(403);
        expect((await api('DELETE', `/api/files/${f.id}`)).status).toBe(403);
        expect((await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).status).toBe(403);
    });

    it('reaches everything inside a shared folder, including things added later', async () => {
        const dir = (await api('POST', '/api/files/folder', { name: 'Photos' })).body.item;
        await api('POST', `/api/files/${dir.id}/share`, { kind: 'user', recipientUserIds: [ASHUTOSH] });
        // Added after the grant — this is the behaviour the move dialog warns about.
        const later = (await uploadFile('later.jpg', 'x', dir.id)).body.item;

        asAshutosh();
        expect((await api('POST', `/api/files/${later.id}/token`)).status).toBe(200);
        const browsed = await api('GET', `/api/files/shared/${dir.id}`);
        expect(browsed.body.readOnly).toBe(true);
        expect(browsed.body.items.map((i) => i.name)).toEqual(['later.jpg']);
    });

    it('stops working the moment the recipient is no longer approved', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        await api('POST', `/api/files/${f.id}/share`, { kind: 'user', recipientUserIds: [ASHUTOSH] });
        // verifyToken reads status off the session, so this is the only place it gets noticed.
        raw.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(ASHUTOSH);

        asAshutosh();
        expect((await api('GET', '/api/files/shared-with-me')).body.items).toEqual([]);
        expect((await api('POST', `/api/files/${f.id}/token`)).status).toBe(403);
    });

    it('gives a non-recipient nothing, and says 404 rather than 403 for a browse', async () => {
        const dir = (await api('POST', '/api/files/folder', { name: 'Private' })).body.item;
        asAshutosh();
        // 404 rather than 403: confirming the folder exists is itself a disclosure.
        expect((await api('GET', `/api/files/shared/${dir.id}`)).status).toBe(404);
    });
});

describe('managing shares', () => {
    it('revokes, and only the owner or a super_admin may', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        const id = (await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).body.shareId;

        asAshutosh();
        expect((await api('DELETE', `/api/files/share/${id}`)).status).toBe(403);

        currentUser = { id: 9, username: 'admin', role: 'super_admin' };
        expect((await api('DELETE', `/api/files/share/${id}`)).status).toBe(200);
    });

    it('sets and clears expiry, and refuses to revive an expired share', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        const id = (await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).body.shareId;

        expect((await api('PATCH', `/api/files/share/${id}`, { expiresInHours: 24 })).body.expiresAt).toBeTruthy();
        expect((await api('PATCH', `/api/files/share/${id}`, { expiresInHours: '' })).body.expiresAt).toBeNull();

        raw.prepare('UPDATE file_shares SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);
        expect((await api('PATCH', `/api/files/share/${id}`, { expiresInHours: 24 })).status).toBe(404);
    });

    it('hides expired and revoked shares from the management list', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        const live = (await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).body.shareId;
        const dead = (await api('POST', `/api/files/${f.id}/share`, { kind: 'link' })).body.shareId;
        raw.prepare('UPDATE file_shares SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', dead);

        const listed = (await api('GET', '/api/files/shares/mine')).body.shares.map((s) => s.id);
        expect(listed).toEqual([live]);
    });

    it('rejects an unknown kind', async () => {
        const f = (await uploadFile('a.txt', 'x')).body.item;
        expect((await api('POST', `/api/files/${f.id}/share`, { kind: 'public' })).status).toBe(400);
    });
});

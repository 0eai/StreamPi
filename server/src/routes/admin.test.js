import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Route-level tests for the two node actions that are super_admin-only, following the harness in
 * files.test.js: the handlers live inside an express Router, so they are mounted on a real app and
 * driven over HTTP rather than extracted.
 *
 * These are authorization tests first. `owner` and `regenerate` are the two routes that can act on a
 * node without any proof of controlling it — everything else about node ownership is meant to go
 * through /api/node-owner/:id/claim, which requires the node's API key. Both were gated with the same
 * `admin || super_admin` check as the rest of this file, and narrowing them is the kind of change that
 * silently reverts: a later edit copying the two-clause check from a neighbouring route would look
 * entirely normal in review.
 *
 * Each gate is checked from both sides. A test that only proves an admin gets 403 would still pass if
 * the route were broken outright and refused everyone.
 */

vi.mock('../paths.js', () => ({ PRIVATE_ROOT: '/tmp/streampi-test-private' }));

// isFirebaseActive false keeps the node_keys writes out of the way; firebase-admin is still imported
// at module scope, so it needs to resolve to something.
vi.mock('../firebaseBootstrap.js', () => ({ isFirebaseActive: false }));
vi.mock('firebase-admin', () => ({ default: { database: () => ({ ref: () => ({ set: async () => {}, update: async () => {} }) }) } }));

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
vi.mock('../db.js', () => ({
    db: adapter,
    initDB: vi.fn(),
    logActivity: logActivityMock,
    getSetting: vi.fn(async (_k, d) => d),
    setSetting: vi.fn(),
}));

let currentUser = null;
vi.mock('../middleware.js', () => ({
    verifyToken: (req, res, next) => {
        if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
        req.user = currentUser;
        next();
    },
}));

// Deterministic, so a test can assert the key actually changed to the new one rather than merely
// changed to something.
let nextKey = 'generated-key-1';
vi.mock('../cryptoHelpers.js', () => ({
    generateApiKey: () => nextKey,
    hashApiKey: (k) => `hash:${k}`,
    generateNodeId: (name) => `${name}_abc123`,
    sessionIdFor: (t) => `sess:${t}`,
}));

vi.mock('./auth.js', () => ({ deviceKindOf: () => 'Browser' }));
vi.mock('../nodeProxy.js', () => ({ proxyToNode: () => (req, res) => res.json({ proxied: true }) }));
vi.mock('../logger.js', () => ({
    sendServerError: (res, e, msg = 'Something went wrong') => {
        console.error('route error:', e?.message);
        res.status(500).json({ error: msg });
    },
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
// The real DDL, so these tests fail if the nodes table changes shape under them. owner_user_id is not
// in the CREATE TABLE — it arrives as an ALTER in db.js's migration list, which is where any column
// added after the table shipped will be, so both are pulled from source rather than restated here.
const dbSource = fs.readFileSync(findUp('server/src/db.js'), 'utf8');
const nodesDdl = /CREATE TABLE IF NOT EXISTS nodes \([\s\S]*?\n {12}\);/.exec(dbSource)[0];
const nodeAlters = [...dbSource.matchAll(/"(ALTER TABLE nodes ADD COLUMN [^"]+)"/g)].map((m) => m[1]);

const express = (await import('express')).default;
const adminRouter = (await import('./admin.js')).default;
const { KNOWN_NODES, KNOWN_NAS_NODES } = await import('../state.js');

const SUPER = { id: 1, username: 'ankit', role: 'super_admin' };
const ADMIN = { id: 2, username: 'ranjan', role: 'admin' };
const USER = { id: 3, username: 'sagarkumar', role: 'public' };

let server, origin;
const post = (p, body, user = SUPER) => {
    currentUser = user;
    return fetch(`${origin}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
};

beforeEach(async () => {
    raw = new Database(':memory:');
    raw.exec(nodesDdl);
    for (const alter of nodeAlters) raw.exec(alter);
    raw.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, role TEXT, status TEXT)');
    raw.prepare("INSERT INTO users (username, role, status) VALUES ('ankit','super_admin','approved'),('ranjan','admin','approved'),('sagarkumar','public','approved')").run();
    raw.prepare("INSERT INTO nodes (id, name, roles, api_key, revoked) VALUES ('orin2_abc','orin2','transcoder,nas','old-key',0)").run();

    nextKey = 'generated-key-1';
    logActivityMock.mockClear();
    KNOWN_NODES.clear();
    KNOWN_NAS_NODES.clear();

    const app = express();
    app.use(express.json());
    app.use(adminRouter);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => server?.close());

const ownerOf = (id) => raw.prepare('SELECT owner_user_id FROM nodes WHERE id = ?').get(id)?.owner_user_id;
const keyOf = (id) => raw.prepare('SELECT api_key FROM nodes WHERE id = ?').get(id)?.api_key;

describe('POST /api/admin/nodes/:id/owner', () => {
    it('lets a super_admin assign an owner', async () => {
        const res = await post('/api/admin/nodes/orin2_abc/owner', { ownerUserId: 2 });
        expect(res.status).toBe(200);
        expect(ownerOf('orin2_abc')).toBe(2);
    });

    it('refuses a plain admin, who could otherwise hand themselves a node they cannot reach', async () => {
        const res = await post('/api/admin/nodes/orin2_abc/owner', { ownerUserId: 2 }, ADMIN);
        expect(res.status).toBe(403);
        expect(ownerOf('orin2_abc')).toBeNull();
    });

    it('refuses an ordinary user', async () => {
        const res = await post('/api/admin/nodes/orin2_abc/owner', { ownerUserId: 3 }, USER);
        expect(res.status).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
        currentUser = null;
        const res = await fetch(`${origin}/api/admin/nodes/orin2_abc/owner`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(401);
    });

    it('clears the owner when given nothing, which is the escape hatch the route exists for', async () => {
        // Claim matches only an unowned node, so without this a node whose owner's account was deleted
        // could never be claimed by anyone again.
        raw.prepare('UPDATE nodes SET owner_user_id = 2 WHERE id = ?').run('orin2_abc');
        const res = await post('/api/admin/nodes/orin2_abc/owner', { ownerUserId: null });
        expect(res.status).toBe(200);
        expect(ownerOf('orin2_abc')).toBeNull();
    });

    it('rejects a user id that does not exist, rather than storing a dangling owner', async () => {
        const res = await post('/api/admin/nodes/orin2_abc/owner', { ownerUserId: 999 });
        expect(res.status).toBe(400);
        expect(ownerOf('orin2_abc')).toBeNull();
    });

    it('404s an unknown node, so the gate is not masking the not-found path', async () => {
        const res = await post('/api/admin/nodes/nope/owner', { ownerUserId: 2 });
        expect(res.status).toBe(404);
    });
});

describe('POST /api/admin/nodes/:id/regenerate', () => {
    it('lets a super_admin rotate the key', async () => {
        const res = await post('/api/admin/nodes/orin2_abc/regenerate');
        expect(res.status).toBe(200);
        expect(keyOf('orin2_abc')).toBe('generated-key-1');
        expect((await res.json()).apiKey).toBe('generated-key-1');
    });

    it('refuses a plain admin — this is what actually dispossesses the old key holder', async () => {
        const res = await post('/api/admin/nodes/orin2_abc/regenerate', {}, ADMIN);
        expect(res.status).toBe(403);
        expect(keyOf('orin2_abc')).toBe('old-key');
    });

    it('refuses an ordinary user', async () => {
        expect((await post('/api/admin/nodes/orin2_abc/regenerate', {}, USER)).status).toBe(403);
    });

    it('pushes the new key into the live maps so outbound calls switch immediately', async () => {
        // Otherwise the server keeps signing requests with a key the node no longer accepts, and the
        // node reads as unreachable until the next restart.
        KNOWN_NODES.set('orin2_abc', { id: 'orin2_abc', apiKey: 'old-key' });
        KNOWN_NAS_NODES.set('orin2_abc', { id: 'orin2_abc', apiKey: 'old-key' });
        await post('/api/admin/nodes/orin2_abc/regenerate');
        expect(KNOWN_NODES.get('orin2_abc').apiKey).toBe('generated-key-1');
        expect(KNOWN_NAS_NODES.get('orin2_abc').apiKey).toBe('generated-key-1');
    });

    it('leaves the maps alone for a node it does not know', async () => {
        await post('/api/admin/nodes/orin2_abc/regenerate');
        expect(KNOWN_NODES.size).toBe(0);
    });

    it('404s an unknown node without rotating anything', async () => {
        const res = await post('/api/admin/nodes/nope/regenerate');
        expect(res.status).toBe(404);
        expect(keyOf('orin2_abc')).toBe('old-key');
    });
});

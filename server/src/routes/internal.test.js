import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * The in-place transcode callback, which had no tests and never once succeeded.
 *
 * Its fileId always decodes to a `nas://<nodeId>/<file>` URI, because that is what transcodeQueue puts
 * there and this route serves no other kind of job — so the isUnderRoot guard it used to carry could
 * not pass for any input at all. That failure was silent from the server's side and destructive at the
 * node's, since the node renames its output over the source and deletes the original *before* calling
 * this. A rejected callback leaves the file as .mp4 and the row naming a .mkv, unplayable and with no
 * poster, stuck in remote_processing.
 *
 * Hence testing both that a legitimate completion is accepted and that a fabricated one is not: the
 * cheap way to "fix" a guard nothing could satisfy is to remove it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-routes-'));
vi.mock('../paths.js', async (orig) => {
    const real = await orig();
    return { ...real, MEDIA_ROOT: path.join(tmp, 'media'), EXTERNAL_ROOT: path.join(tmp, 'external'), TEMP_DIR: tmp };
});

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

// The node's identity check. Keyed so a test can present a wrong key.
const KEYS = { orin2: 'key-orin2', mac: 'key-mac' };
vi.mock('../db.js', () => ({
    db: adapter,
    verifyNodeKey: async (nodeId, secret) => KEYS[nodeId] === secret,
}));

const logLines = [];
vi.mock('../logger.js', () => ({
    log: async (m, level) => { logLines.push(`${level || 'INFO'}: ${m}`); },
    sendServerError: (res, e) => res.status(500).json({ error: e?.message }),
    hasFreeSpace: async () => true,
}));

vi.mock('../transcodeQueue.js', () => ({ checkTranscodeQueue: vi.fn() }));
vi.mock('../uploadMiddleware.js', () => ({ upload: { single: () => (req, res, next) => next() } }));

const express = (await import('express')).default;
const internalRouter = (await import('./internal.js')).default;
const { JOB_PROGRESS } = await import('../state.js');

const MKV = 'Assi (2026) Bollywood Hindi(DD5.1-224Kbps) Movie HD 1080p ESub.mkv';
const MP4 = 'Assi (2026) Bollywood Hindi(DD5.1-224Kbps) Movie HD 1080p ESub.mp4';
const nasPath = (node, name) => `nas://${node}/${name}`;
const idFor = (p) => Buffer.from(p).toString('base64');

let server, origin;
const complete = (body) => fetch(`${origin}/api/internal/transcode-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

beforeEach(async () => {
    raw = new Database(':memory:');
    raw.exec('CREATE TABLE media (path TEXT PRIMARY KEY, filename TEXT, transcode_status TEXT, poster_attempts INTEGER DEFAULT 0)');
    // 5 is posterHealer's give-up cap, which is where a title lands after its source could not be
    // read — exactly the state the real stranded row was in.
    raw.prepare("INSERT INTO media (path, filename, transcode_status, poster_attempts) VALUES (?, ?, 'remote_processing', 5)")
        .run(nasPath('orin2', MKV), MKV);
    logLines.length = 0;
    JOB_PROGRESS.clear();

    const app = express();
    app.use(express.json());
    app.use(internalRouter);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => server?.close());

const row = (p) => raw.prepare('SELECT * FROM media WHERE path = ?').get(p);

describe('POST /api/internal/transcode-complete', () => {
    it('finalizes an in-place transcode, which it could not do at all before', async () => {
        const res = await complete({ fileId: idFor(nasPath('orin2', MKV)), nodeId: 'orin2', secret: KEYS.orin2, finalFilename: MP4 });
        expect(res.status).toBe(200);

        // The row must now name the file the node actually holds.
        expect(row(nasPath('orin2', MKV))).toBeUndefined();
        expect(row(nasPath('orin2', MP4))).toMatchObject({ filename: MP4, transcode_status: 'completed' });
    });

    it('clears a spent poster-attempt count, since this is a different file now', async () => {
        // posterHealer stores its give-up count on the row and never retries past the cap, so without
        // this the transcoded copy — usually the more extractable of the two, since an unseekable
        // container is why it was queued in the first place — would never be tried.
        await complete({ fileId: idFor(nasPath('orin2', MKV)), nodeId: 'orin2', secret: KEYS.orin2, finalFilename: MP4 });
        expect(row(nasPath('orin2', MP4)).poster_attempts).toBe(0);
    });

    it('clears the progress entry for the old path', async () => {
        JOB_PROGRESS.set(nasPath('orin2', MKV), { percent: 100 });
        await complete({ fileId: idFor(nasPath('orin2', MKV)), nodeId: 'orin2', secret: KEYS.orin2, finalFilename: MP4 });
        expect(JOB_PROGRESS.has(nasPath('orin2', MKV))).toBe(false);
    });

    it('refuses a node finalizing a file that belongs to a different node', async () => {
        // The guard that replaced isUnderRoot has to actually constrain something: the mac node
        // presenting its own valid key must not be able to rewrite orin2's row.
        const res = await complete({ fileId: idFor(nasPath('orin2', MKV)), nodeId: 'mac', secret: KEYS.mac, finalFilename: MP4 });
        expect(res.status).toBe(400);
        expect(row(nasPath('orin2', MKV))).toBeDefined();
    });

    it('refuses a local filesystem path, which this route never legitimately receives', async () => {
        const res = await complete({ fileId: idFor('/home/pi/Projects/streampi/server_data/StreamMedia/x.mkv'), nodeId: 'orin2', secret: KEYS.orin2, finalFilename: MP4 });
        expect(res.status).toBe(400);
    });

    it('refuses a fileId whose filename is not flat', async () => {
        const res = await complete({ fileId: idFor(nasPath('orin2', '../../.stream_db/media.db')), nodeId: 'orin2', secret: KEYS.orin2, finalFilename: MP4 });
        expect(res.status).toBe(400);
    });

    it('refuses an unsafe finalFilename', async () => {
        const res = await complete({ fileId: idFor(nasPath('orin2', MKV)), nodeId: 'orin2', secret: KEYS.orin2, finalFilename: '../evil.mp4' });
        expect(res.status).toBe(400);
        expect(row(nasPath('orin2', MKV))).toBeDefined();
    });

    it('rejects a wrong node key before looking at anything else', async () => {
        const res = await complete({ fileId: idFor(nasPath('orin2', MKV)), nodeId: 'orin2', secret: 'wrong', finalFilename: MP4 });
        expect(res.status).toBe(403);
    });

    it('reports a completion that matched no row instead of claiming success', async () => {
        // The node has already renamed the file and deleted the source by now, so a 200 here would
        // strand the pair: nothing retries, and the row names a file that is gone. The log has to
        // carry both names, because a hand repair is the only thing left.
        const gone = nasPath('orin2', 'Something Deleted.mkv');
        const res = await complete({ fileId: idFor(gone), nodeId: 'orin2', secret: KEYS.orin2, finalFilename: 'Something Deleted.mp4' });
        expect(res.status).toBe(409);
        expect(logLines.join('\n')).toMatch(/matched no media row/);
        expect(logLines.join('\n')).toContain('Something Deleted.mp4');
    });

    it('needs both a fileId and a finalFilename', async () => {
        expect((await complete({ nodeId: 'orin2', secret: KEYS.orin2, finalFilename: MP4 })).status).toBe(400);
        expect((await complete({ fileId: idFor(nasPath('orin2', MKV)), nodeId: 'orin2', secret: KEYS.orin2 })).status).toBe(400);
    });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbMock = { get: vi.fn(), run: vi.fn() };
const logActivityMock = vi.fn();
vi.mock('./db.js', () => ({ db: dbMock, logActivity: logActivityMock }));

const sendServerErrorMock = vi.fn();
vi.mock('./logger.js', () => ({ sendServerError: sendServerErrorMock }));

const { claimNode } = await import('./nodeClaim.js');
const { nodeOwnerGate } = await import('./routes/nodeOwner.js');

const mockReqRes = ({ user, params = { id: 'n1' }, body } = {}) => {
    const req = { user, params, body, ip: '192.168.1.5' };
    const res = {
        statusCode: 200,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
    return { req, res };
};

const USER = { id: 7, username: 'ranjan', role: 'user' };

describe('claimNode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('refuses a session whose user id could not be resolved, without touching the database', async () => {
        // The guard has to come before the UPDATE, not after: `owner_user_id IS NULL` matches an
        // unowned node, so a null id would write NULL over NULL, count one changed row, and report a
        // successful claim that claimed nothing.
        const { req, res } = mockReqRes({ user: { id: null, username: 'ghost', role: 'user' }, body: { apiKey: 'k' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(403);
        expect(dbMock.run).not.toHaveBeenCalled();
    });

    it('rejects a missing or non-string apiKey as a 400 rather than letting the driver throw', async () => {
        // express.json() yields {} for an empty body; binding undefined to a ? parameter makes the
        // sqlite3 driver throw, which sendServerError would turn into a 500.
        for (const body of [undefined, {}, { apiKey: '' }, { apiKey: { nested: true } }]) {
            vi.clearAllMocks();
            const { req, res } = mockReqRes({ user: USER, body });
            await claimNode(req, res);

            expect(res.statusCode).toBe(400);
            expect(dbMock.run).not.toHaveBeenCalled();
        }
    });

    it('claims an unowned node with one conditional write, and records who did it', async () => {
        dbMock.run.mockResolvedValueOnce({ changes: 1 });
        dbMock.get.mockResolvedValueOnce({ name: 'ankit' });

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'correct-key' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        // The atomicity is the point: assert the guard clauses are in the SQL, not applied by a
        // preceding read that another request could race.
        const [sql, params] = dbMock.run.mock.calls[0];
        expect(sql).toContain('owner_user_id IS NULL');
        expect(sql).toContain('api_key = ?');
        expect(sql).toContain('revoked = 0');
        expect(params).toEqual([7, 'n1', 'correct-key']);

        expect(logActivityMock).toHaveBeenCalledWith(
            'ranjan', 'NODE_CLAIM', 'Claimed ownership of node "ankit"', '192.168.1.5'
        );
    });

    it('is idempotent when the caller already owns the node, and logs nothing', async () => {
        // The write matches only unowned rows, so this falls through to the classification read. It
        // must still be a success — the caller asked for a state that already holds — but it must not
        // write a second "Claimed ownership" line, which would read as though ownership moved again.
        dbMock.run.mockResolvedValueOnce({ changes: 0 });
        dbMock.get.mockResolvedValueOnce({ name: 'ankit', api_key: 'correct-key', revoked: 0, owner_user_id: 7 });

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'correct-key' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(logActivityMock).not.toHaveBeenCalled();
    });

    it('404s an unknown node', async () => {
        dbMock.run.mockResolvedValueOnce({ changes: 0 });
        dbMock.get.mockResolvedValueOnce(undefined);

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'k' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(404);
    });

    it('403s a wrong key without revealing whether the node has an owner', async () => {
        // Key before ownership. The other order would make this endpoint an ownership oracle for any
        // logged-in user who knows a node id — and node ids are not secret.
        dbMock.run.mockResolvedValueOnce({ changes: 0 });
        dbMock.get.mockResolvedValueOnce({ name: 'ankit', api_key: 'real-key', revoked: 0, owner_user_id: 42 });

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'guessed-key' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Access Denied' });
        // Only the classification read ran; no second read to resolve an owner name.
        expect(dbMock.get).toHaveBeenCalledTimes(1);
    });

    it('403s a revoked node even when the key matches', async () => {
        // Matches what db.verifyNodeKey and nodeDiscovery already require of a node's key.
        dbMock.run.mockResolvedValueOnce({ changes: 0 });
        dbMock.get.mockResolvedValueOnce({ name: 'ankit', api_key: 'real-key', revoked: 1, owner_user_id: null });

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'real-key' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(403);
    });

    it('409s a node owned by someone else, naming them so the message is actionable', async () => {
        dbMock.run.mockResolvedValueOnce({ changes: 0 });
        dbMock.get
            .mockResolvedValueOnce({ name: 'ankit', api_key: 'real-key', revoked: 0, owner_user_id: 42 })
            .mockResolvedValueOnce({ username: 'ashutosh' });

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'real-key' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toContain('ashutosh');
        expect(logActivityMock).not.toHaveBeenCalled();
    });

    it('409s without a name when the owner row has gone missing', async () => {
        dbMock.run.mockResolvedValueOnce({ changes: 0 });
        dbMock.get
            .mockResolvedValueOnce({ name: 'ankit', api_key: 'real-key', revoked: 0, owner_user_id: 42 })
            .mockResolvedValueOnce(undefined);

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'real-key' } });
        await claimNode(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('This node already has an owner — ask an admin to transfer it.');
    });

    it('never puts the supplied key in the activity log', async () => {
        dbMock.run.mockResolvedValueOnce({ changes: 1 });
        dbMock.get.mockResolvedValueOnce({ name: 'ankit' });

        const { req, res } = mockReqRes({ user: USER, body: { apiKey: 'super-secret-key' } });
        await claimNode(req, res);

        expect(JSON.stringify(logActivityMock.mock.calls)).not.toContain('super-secret-key');
    });
});

describe('nodeOwnerGate', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does not treat an unresolved user id as matching an unowned node', async () => {
        // `null !== null` is false, so without the explicit id check a non-admin whose session did not
        // resolve to a users row would pass the gate on every unclaimed node — which grants
        // config-write and restart through the proxy.
        dbMock.get.mockResolvedValueOnce({ id: 'n1', owner_user_id: null });
        const { req, res } = mockReqRes({ user: { id: null, username: 'ghost', role: 'user' } });
        const next = vi.fn();

        await nodeOwnerGate(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    it('still lets the real owner through', async () => {
        dbMock.get.mockResolvedValueOnce({ id: 'n1', owner_user_id: 7 });
        const { req, res } = mockReqRes({ user: USER });
        const next = vi.fn();

        await nodeOwnerGate(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.node).toEqual({ id: 'n1', owner_user_id: 7 });
    });

    it('still lets an admin through on a node they do not own', async () => {
        dbMock.get.mockResolvedValueOnce({ id: 'n1', owner_user_id: 42 });
        const { req, res } = mockReqRes({ user: { id: 1, username: 'admin', role: 'super_admin' } });
        const next = vi.fn();

        await nodeOwnerGate(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });
});

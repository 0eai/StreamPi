import express from 'express';
import { db } from '../db.js';
import { verifyToken } from '../middleware.js';
import { sendServerError } from '../logger.js';
import { proxyToNode } from '../nodeProxy.js';
import { claimNode } from '../nodeClaim.js';

const router = express.Router();

// Deliberately NOT behind nodeOwnerGate, and registered above it for that reason: claiming is how a
// node gets an owner in the first place, so gating it on already being the owner would deadlock. It
// proves possession of the node's API key instead — see nodeClaim.js. Express matches in declaration
// order, so keeping this first means a future blanket `router.use('/api/node-owner/:id', …, gate)`
// physically cannot capture it; a comment saying "don't gate this" would not survive that refactor.
router.post('/api/node-owner/:id/claim', verifyToken, claimNode);

// --- Node-owner proxy routes: distinct from the admin-only /api/admin/nodes/:id/live
// above. A node's delegated owner is not necessarily a global admin, so these are gated
// per-node (owner_user_id match) instead of by role, and the node's URL and apiKey stay
// server-side — everything is forwarded, same pattern as /live.
//
// One caveat worth stating, since it shapes what ownership means: the /config route below proxies the
// node's own GET /api/config, whose payload includes that node's raw apiKey (node/routes/core.js), and
// the dashboard renders it with Show and Copy buttons. So an owner does end up holding the key, and
// keeps it after ownership is cleared.
//
// Exported so the null-id guard below can be tested directly.
export const nodeOwnerGate = async (req, res, next) => {
    try {
        const node = await db.get("SELECT * FROM nodes WHERE id = ?", req.params.id);
        if (!node) return res.status(404).json({ error: "Node not found" });
        const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
        // The !req.user.id half is defence-in-depth rather than a fix for a reachable bug: an unowned
        // node has owner_user_id === null, and verifyToken yields id === null when a session's
        // username doesn't resolve to a users row, at which point `null !== null` is false and the
        // guard would wave a non-admin through to config-write and restart. No code path today
        // produces such a session, but nothing structural prevents one either.
        if (!isAdmin && (!req.user.id || node.owner_user_id !== req.user.id)) {
            return res.status(403).json({ error: "Access Denied" });
        }
        req.node = node;
        next();
    } catch (e) { sendServerError(res, e); }
};

router.get('/api/node-owner/:id/live', verifyToken, nodeOwnerGate, proxyToNode('get', '/stats'));
router.get('/api/node-owner/:id/config', verifyToken, nodeOwnerGate, proxyToNode('get', '/api/config'));
router.post('/api/node-owner/:id/config', verifyToken, nodeOwnerGate, proxyToNode('post', '/api/config', req => req.body));
router.post('/api/node-owner/:id/restart', verifyToken, nodeOwnerGate, proxyToNode('post', '/api/self/restart', () => ({})));
router.get('/api/node-owner/:id/history', verifyToken, nodeOwnerGate, proxyToNode('get', '/api/history'));
router.get('/api/node-owner/:id/files', verifyToken, nodeOwnerGate, proxyToNode('get', '/api/files'));

export default router;

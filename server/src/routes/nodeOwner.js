import express from 'express';
import { db } from '../db.js';
import { verifyToken } from '../middleware.js';
import { sendServerError } from '../logger.js';
import { proxyToNode } from '../nodeProxy.js';

const router = express.Router();

// --- Node-owner proxy routes: distinct from the admin-only /api/admin/nodes/:id/live
// above. A node's delegated owner is not necessarily a global admin, so these are gated
// per-node (owner_user_id match) instead of by role, and never expose the raw apiKey to
// the browser — everything is forwarded server-side, same pattern as /live.
const nodeOwnerGate = async (req, res, next) => {
    try {
        const node = await db.get("SELECT * FROM nodes WHERE id = ?", req.params.id);
        if (!node) return res.status(404).json({ error: "Node not found" });
        const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
        if (!isAdmin && node.owner_user_id !== req.user.id) {
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

import express from 'express';
import path from 'path';
import admin from 'firebase-admin';
import { PRIVATE_ROOT } from '../paths.js';
import { db, initDB, logActivity, getSetting, setSetting } from '../db.js';
import { verifyToken } from '../middleware.js';
import { generateApiKey, hashApiKey, generateNodeId } from '../cryptoHelpers.js';
import { KNOWN_NODES, KNOWN_NAS_NODES, ACTIVE_STREAMS, JOB_PROGRESS } from '../state.js';
import { proxyToNode } from '../nodeProxy.js';
import { isFirebaseActive } from '../firebaseBootstrap.js';
import { sendServerError } from '../logger.js';

const router = express.Router();

router.get('/api/admin/dashboard', verifyToken, async (req, res) => {
    // Every sibling admin route below checks this; this one didn't, despite returning every
    // online user's IP/location, every active stream, and the full node inventory.
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    if (!db) await initDB();
    try {
        const users = await db.all(`
            SELECT username, device, device_type, ip, location, last_active, role
            FROM sessions
            WHERE last_active > ?
            AND role != 'super_admin'
        `, Date.now() - 5 * 60 * 1000);

        const streams = Array.from(ACTIVE_STREAMS.entries())
            .filter(([, s]) => !s.path.startsWith(PRIVATE_ROOT))
            .map(([id, s]) => ({
                id,
                filename: s.filename,
                ip: s.ip,
                username: s.username || 'Guest',
                type: s.type,
                source: s.source,
                duration: Math.floor((Date.now() - s.start) / 1000)
            }));

        // 👇 Unified node list: one row per admin-registered node (nodes table),
        // enriched with whatever live status is currently known for it. A node
        // that's been created on the dashboard but never connected still shows
        // up here (as "Never Connected") instead of only appearing once live.
        const dbNodes = await db.all("SELECT id, name, roles, created_at, last_seen_at, revoked, owner_user_id FROM nodes ORDER BY created_at DESC");
        const ownerRows = await db.all("SELECT id, username FROM users");
        const ownerUsernameById = new Map(ownerRows.map(u => [u.id, u.username]));
        const nodes = dbNodes.map(row => {
            const t = KNOWN_NODES.get(row.id);
            const n = KNOWN_NAS_NODES.get(row.id);
            // Roles are node-owner managed (editable from that node's own settings UI) — once a
            // node has ever reported in, its live Firebase-reported roles are authoritative here,
            // not the value picked when the admin first created it. Only a node that has never
            // connected falls back to that original admin-picked value.
            const roles = (t || n) ? [...(t ? ['transcoder'] : []), ...(n ? ['nas'] : [])] : (row.roles || '').split(',').filter(Boolean);
            const isOnline = !!(t?.isReachable || n?.isReachable);
            return {
                id: row.id,
                name: row.name || row.id,
                roles,
                revoked: !!row.revoked,
                createdAt: row.created_at,
                status: isOnline ? 'Online' : ((t || n) ? 'Offline' : 'Never Connected'),
                hardware: t?.hardware || null,
                activeJob: t?.activeJob ? path.basename(t.activeJob) : null,
                connection: t?.directIp || n?.ip || null,
                cpu: t?.stats?.cpu ?? n?.stats?.cpu ?? 0,
                ram: t?.stats?.ram?.percent ?? n?.stats?.ram?.percent ?? 0,
                network: t?.stats?.network || n?.stats?.network || { up: 0, down: 0 },
                disk: n?.stats?.disk || null,
                jobs: n?.stats?.jobs || [],
                dashboardUrl: t?.activeUrl || n?.url || null,
                ownerUserId: row.owner_user_id || null,
                ownerUsername: row.owner_user_id ? (ownerUsernameById.get(row.owner_user_id) || null) : null
            };
        });

        const dbQueue = await db.all(`SELECT path, filename, transcode_status FROM media WHERE transcode_status IN ('pending', 'processing', 'remote_processing') ORDER BY created_at ASC`);
        const queue = dbQueue.map(job => {
            const progress = JOB_PROGRESS.get(job.path);
            return {
                filename: job.filename, status: job.transcode_status,
                assignedNode: Array.from(KNOWN_NODES.values()).find(n => n.activeJob === job.path)?.id || '-',
                progress: progress || { stage: 'pending', percent: 0 }
            };
        });

        res.json({ users, streams, nodes, queue });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/admin/streams/:id/terminate', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }

    const victim = ACTIVE_STREAMS.get(req.params.id);
    if (!victim) return res.status(404).json({ error: "Stream not found" });

    try { if (victim.res) victim.res.destroy(); } catch (e) {}
    ACTIVE_STREAMS.delete(req.params.id);

    await logActivity(req.user.username, "TERMINATE_STREAM", `Terminated stream: ${victim.filename} (${victim.username})`, req.ip);
    res.json({ success: true });
});

router.post('/api/admin/nodes', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    const { name, roles, ownerUserId } = req.body;
    const cleanRoles = Array.isArray(roles) ? roles.filter(r => ['transcoder', 'nas'].includes(r)) : [];
    if (!name || !cleanRoles.length) return res.status(400).json({ error: "Name and at least one role are required" });

    try {
        let id;
        do { id = generateNodeId(name); } while (await db.get("SELECT 1 FROM nodes WHERE id = ?", id));

        const apiKey = generateApiKey();
        const rolesStr = cleanRoles.join(',');

        await db.run(
            "INSERT INTO nodes (id, name, roles, api_key, created_at, revoked, owner_user_id) VALUES (?, ?, ?, ?, ?, 0, ?)",
            [id, name, rolesStr, apiKey, new Date().toISOString(), ownerUserId || null]
        );

        if (isFirebaseActive) {
            await admin.database().ref(`node_keys/${id}`).set({ hash: hashApiKey(apiKey), roles: cleanRoles, revoked: false });
        }

        await logActivity(req.user.username, "NODE_CREATE", `Created node "${name}" (${rolesStr})`, req.ip);
        res.json({ success: true, id, name, roles: cleanRoles, apiKey });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/admin/nodes/:id/owner', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    const { ownerUserId } = req.body;
    try {
        const node = await db.get("SELECT * FROM nodes WHERE id = ?", req.params.id);
        if (!node) return res.status(404).json({ error: "Node not found" });

        if (ownerUserId) {
            const owner = await db.get("SELECT id, username FROM users WHERE id = ?", ownerUserId);
            if (!owner) return res.status(400).json({ error: "User not found" });
        }

        await db.run("UPDATE nodes SET owner_user_id = ? WHERE id = ?", [ownerUserId || null, node.id]);
        await logActivity(req.user.username, "NODE_OWNER", `Set owner of node "${node.name}"`, req.ip);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/admin/nodes/:id/regenerate', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    try {
        const node = await db.get("SELECT * FROM nodes WHERE id = ?", req.params.id);
        if (!node) return res.status(404).json({ error: "Node not found" });

        const apiKey = generateApiKey();
        await db.run("UPDATE nodes SET api_key = ? WHERE id = ?", [apiKey, node.id]);

        if (isFirebaseActive) {
            await admin.database().ref(`node_keys/${node.id}`).update({ hash: hashApiKey(apiKey) });
        }

        // Push the new key into any live map entries so outbound calls switch to it immediately.
        if (KNOWN_NODES.has(node.id)) KNOWN_NODES.get(node.id).apiKey = apiKey;
        if (KNOWN_NAS_NODES.has(node.id)) KNOWN_NAS_NODES.get(node.id).apiKey = apiKey;

        await logActivity(req.user.username, "NODE_REGENERATE", `Regenerated key for node "${node.name}"`, req.ip);
        res.json({ success: true, id: node.id, name: node.name, roles: (node.roles || '').split(',').filter(Boolean), apiKey });
    } catch (e) { sendServerError(res, e); }
});

router.delete('/api/admin/nodes/:id', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    try {
        const node = await db.get("SELECT * FROM nodes WHERE id = ?", req.params.id);
        if (!node) return res.status(404).json({ error: "Node not found" });

        await db.run("DELETE FROM nodes WHERE id = ?", req.params.id);
        if (isFirebaseActive) {
            await admin.database().ref(`node_keys/${req.params.id}`).update({ revoked: true });
        }
        KNOWN_NODES.delete(req.params.id);
        KNOWN_NAS_NODES.delete(req.params.id);

        await logActivity(req.user.username, "NODE_DELETE", `Removed node "${node.name}"`, req.ip);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

router.get('/api/admin/nodes/:id/live', verifyToken, (req, res, next) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    next();
}, proxyToNode('get', '/stats'));

router.get('/api/admin/settings', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    try {
        res.json({
            telegramAutoDownload: (await getSetting('telegram_auto_download', '1')) === '1'
        });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/admin/settings', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    try {
        const { telegramAutoDownload } = req.body;
        if (typeof telegramAutoDownload === 'boolean') {
            await setSetting('telegram_auto_download', telegramAutoDownload ? '1' : '0');
        }
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

router.get('/api/admin/users', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    try {
        const users = await db.all(`
            SELECT id, username, role, status, created_at
            FROM users
            WHERE (status = 'pending' OR status = 'approved')
            AND role != 'super_admin'
            ORDER BY status DESC, created_at DESC
        `);

        res.json(users);
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/admin/users/action', verifyToken, async (req, res) => {
    const currentUserRole = req.user.role;

    if (currentUserRole !== 'super_admin' && currentUserRole !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }

    const { userId, action } = req.body;
    const VALID_ACTIONS = ['approve', 'reject', 'delete', 'promote', 'demote', 'unlink_kunji'];
    // A missing/garbage action previously fell through every branch untouched, then crashed
    // on action.toUpperCase() below instead of a clean 400.
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: "Invalid action" });

    try {
        const targetUser = await db.get("SELECT * FROM users WHERE id = ?", userId);
        if (!targetUser) return res.status(404).json({ error: "User not found" });

        if (targetUser.role === 'super_admin') {
            return res.status(403).json({ error: "Cannot modify the Super Admin." });
        }

        if (currentUserRole === 'admin' && targetUser.role === 'admin') {
            return res.status(403).json({ error: "Admins cannot modify other Admins." });
        }

        if ((action === 'promote' || action === 'demote') && currentUserRole !== 'super_admin') {
            return res.status(403).json({ error: "Only Super Admin can change roles." });
        }

        if (action === 'approve') await db.run("UPDATE users SET status = 'approved' WHERE id = ?", userId);

        if (action === 'reject' || action === 'delete') {
            await db.run("DELETE FROM sessions WHERE username = ?", targetUser.username);
            await db.run("DELETE FROM users WHERE id = ?", userId);
        }

        if (action === 'promote') {
            await db.run("UPDATE users SET role = 'admin' WHERE id = ?", userId);
            await db.run("UPDATE sessions SET role = 'admin' WHERE username = ?", targetUser.username);
        }
        if (action === 'demote') {
            await db.run("UPDATE users SET role = 'user' WHERE id = ?", userId);
            await db.run("UPDATE sessions SET role = 'user' WHERE username = ?", targetUser.username);
        }
        if (action === 'unlink_kunji') {
            await db.run("UPDATE users SET kunji_sub = NULL WHERE id = ?", userId);
        }

        await logActivity(req.user.username, "ADMIN_ACTION", `${action.toUpperCase()} user ${targetUser.username}`, req.ip);
        res.json({ success: true });

    } catch (e) { sendServerError(res, e); }
});

router.get('/api/admin/activity', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });

    try {
        const logs = await db.all("SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 100");
        res.json(logs);
    } catch (e) {
        sendServerError(res, e);
    }
});

export default router;

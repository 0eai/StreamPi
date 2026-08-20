import express from 'express';
import path from 'path';
import admin from 'firebase-admin';
import { PRIVATE_ROOT } from '../paths.js';
import { db, initDB, logActivity, getSetting, setSetting } from '../db.js';
import { verifyToken } from '../middleware.js';
import { generateApiKey, hashApiKey, generateNodeId, sessionIdFor } from '../cryptoHelpers.js';
import { deviceKindOf } from './auth.js';
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
                // Separate from `disk` on purpose. `disk` is a NAS quota being deliberately filled;
                // this is the real filesystem a transcode job stages input and output on, where
                // running out fails the job rather than declining the next one. A transcoder-only node
                // reported neither before, so its disk cell was simply blank.
                work: t?.stats?.work || null,
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
    // Roles are deliberately not accepted here any more. They were required, stored, and then only
    // ever displayed — and only until the node first connected, after which the live Firebase-reported
    // value wins (see the comment above the dashboard's node mapping). What actually decides whether a
    // node transcodes or stores is its own node_config.json, which node/config.js refuses to boot
    // without. So asking at creation looked like a capability grant while granting nothing; the column
    // is left empty and the UI shows "—" until the node reports in.
    //
    // ownerUserId is not accepted either. It was written straight through with no existence check
    // (unlike the /owner route below), so a bad id created a node owned by nobody — which, now that
    // claiming requires the node to be unowned, would make it permanently unclaimable. Ownership is
    // set afterwards, by an admin via /owner or by the operator via /api/node-owner/:id/claim.
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });

    try {
        let id;
        do { id = generateNodeId(name); } while (await db.get("SELECT 1 FROM nodes WHERE id = ?", id));

        const apiKey = generateApiKey();

        await db.run(
            "INSERT INTO nodes (id, name, roles, api_key, created_at, revoked, owner_user_id) VALUES (?, ?, '', ?, ?, 0, NULL)",
            [id, name, apiKey, new Date().toISOString()]
        );

        if (isFirebaseActive) {
            // No roles in this payload: nothing ever read node_keys/{id}.roles, and the RTDB rule that
            // authorizes a node's own registration write reads only `hash` and `revoked`.
            await admin.database().ref(`node_keys/${id}`).set({ hash: hashApiKey(apiKey), revoked: false });
        }

        await logActivity(req.user.username, "NODE_CREATE", `Created node "${name}"`, req.ip);
        res.json({ success: true, id, name, apiKey });
    } catch (e) { sendServerError(res, e); }
});

/**
 * super_admin only, unlike every other node route here.
 *
 * Ownership is meant to be established at the node itself: /api/node-owner/:id/claim asks for that
 * node's API key, which is the one thing separating "I run this machine" from "I can load its page" —
 * the node's dashboard is served unauthenticated, so anyone on the LAN can reach it. This route is the
 * only way ownership can be set *without* that proof, which makes it the exception to the rule the
 * claim flow exists to enforce rather than a peer of the other admin actions.
 *
 * It stays because claim matches only an unowned node, so with no way to clear the field a node whose
 * owner's account was deleted could never be claimed by anyone again. Narrowing who can reach it keeps
 * that escape hatch without leaving every admin able to hand themselves a box they have no access to.
 */
router.post('/api/admin/nodes/:id/owner', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });
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

/**
 * super_admin only, matching /owner above and for a sharper version of the same reason.
 *
 * This is what actually dispossesses whoever held the old key — clearing ownership alone does not,
 * since the node's /api/config hands its raw apiKey back to anyone who can already authenticate, so a
 * former owner keeps a working copy. It is also the more disruptive of the two: the node keeps using
 * the old key until someone edits its node_config.json and restarts it, so a regenerate performed by
 * someone who cannot reach the machine leaves it unable to register or accept work.
 */
router.post('/api/admin/nodes/:id/regenerate', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });
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
            // Release any nodes this user owned. Without this the node keeps a non-null owner_user_id
            // pointing at a row that no longer exists — the Owner dropdown reads blank, and because
            // claiming requires the node to be unowned, nobody could ever take it over again.
            await db.run("UPDATE nodes SET owner_user_id = NULL WHERE owner_user_id = ?", userId);
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

/**
 * Every session on the system — the "what has access to this server" list behind the Dashboard.
 *
 * super_admin only, matching GET /api/admin/activity below rather than the two-clause admin gate
 * used by every other route in this file. This returns every user's IP and location and backs the
 * ability to sign any of them out, which is a step beyond what plain admin gets elsewhere.
 *
 * Deliberately omits all three filters the other session queries apply, and each omission is the
 * point rather than an oversight:
 *  - no activity window. The dashboard's `last_active > now - 5min` is the same value as remote.js's
 *    COMMAND_MAX_AGE_MS: it answers "can this still receive a cast", not "is this signed in". Session
 *    tokens never expire (middleware.js only checks the row exists), so an idle row is still a live
 *    credential and hiding it would defeat the purpose of the list.
 *  - no `role != 'super_admin'`. Every other listing hides them, which would leave this screen unable
 *    to show the viewer their own sessions or another owner's — a permanent blind spot on the one
 *    view meant to remove one.
 *  - no `device_type != 'Node'`. Excluding the node dashboard is right for a cast target; it is a
 *    real standing credential here.
 *
 * Returns an opaque `id` and no `token`: see sessionIdFor. The user-facing /api/auth/devices makes
 * the same choice, but it matters more here, since this payload would otherwise carry a working
 * credential for every account on the server.
 */
router.get('/api/admin/devices', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });

    if (!db) await initDB();
    try {
        const currentToken = req.headers.authorization?.split('Bearer ')[1] || req.query.token;
        const rows = await db.all(
            `SELECT token, username, role, device, device_type, ip, location, last_active
             FROM sessions ORDER BY last_active DESC`
        );
        // No LIMIT: the 72-hour sweep in routes/status.js bounds this in practice, and a truncated
        // security list is worse than a long one. Revisit if a deployment ever has enough users for
        // this to matter.
        const devices = rows.map(s => ({
            id: sessionIdFor(s.token),
            username: s.username,
            role: s.role,
            device: s.device,
            deviceType: s.device_type,
            deviceKind: deviceKindOf(s),
            ip: s.ip,
            location: s.location,
            lastActive: s.last_active,
            isCurrent: s.token === currentToken,
        }));
        res.json({ devices });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Sign out any one session on the system, by the opaque id from /api/admin/devices.
 *
 * Cannot reuse DELETE /api/auth/devices/:id: that route scans only the caller's own rows, so it 404s
 * for anyone else's device. That is correct there — the username-scoped scan IS its ownership check —
 * and loosening it would turn a user-facing route into an admin one. Here the scan is unscoped and
 * the super_admin gate is the only check.
 *
 * Note the existing "Cannot modify the Super Admin." guard in /api/admin/users/action is deliberately
 * NOT extended here: a super_admin can sign out another super_admin, including the owner. That was an
 * explicit choice, on the grounds that a security list which cannot act on what it shows is not much
 * of one; the client states whose session it is before asking.
 *
 * Inherited limitation: this does not stop playback already running. A stream token (state.js
 * STREAM_TOKENS) has no back-reference to the session that minted it and middleware.js checks it
 * before the sessions table, so a revoked device keeps what it started for up to the 6-hour TTL.
 */
router.delete('/api/admin/devices/:id', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });

    if (!db) await initDB();
    try {
        const rows = await db.all("SELECT token, username, device FROM sessions");
        const match = rows.find(s => sessionIdFor(s.token) === req.params.id);
        if (!match) return res.status(404).json({ error: "Device not found" });

        await db.run("DELETE FROM sessions WHERE token = ?", match.token);
        // Clipped because POST /api/auth/login stores `device` from the request body with no length
        // limit, and this lands in the activity log verbatim.
        const label = (match.device || 'Unknown Device').slice(0, 80);
        // Names the OWNER, and uses its own action: req.user.username is the admin, so the
        // user-facing SESSION_REVOKE line would read as though the owner signed themselves out.
        await logActivity(
            req.user.username,
            "ADMIN_SESSION_REVOKE",
            `Signed out ${label} belonging to ${match.username}`,
            req.ip
        );

        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Recent activity, optionally narrowed to one user.
 *
 * The filter is applied in SQL rather than in the client because of the LIMIT: filtering 100
 * already-fetched rows would silently show nothing for a user whose activity is older than the most
 * recent hundred entries, which is indistinguishable from "this user has done nothing". Filtering
 * first, then limiting, answers the question actually being asked.
 *
 * `usernames` comes from a DISTINCT over the whole table so the client's dropdown is complete —
 * including users since deleted, whose log rows outlive their account.
 *
 * NOTE the response shape changed from a bare array to an object. The client tolerates both, because
 * deploying the built client and restarting this server are separate acts by different hands.
 */
router.get('/api/admin/activity', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });

    if (!db) await initDB();
    try {
        const { username } = req.query;
        const logs = username
            ? await db.all(
                "SELECT * FROM activity_logs WHERE username = ? ORDER BY timestamp DESC LIMIT 100",
                [username]
            )
            : await db.all("SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 100");

        const owners = await db.all(
            "SELECT DISTINCT username FROM activity_logs WHERE username IS NOT NULL ORDER BY username"
        );
        res.json({ logs, usernames: owners.map(o => o.username) });
    } catch (e) {
        sendServerError(res, e);
    }
});

/**
 * Delete one activity row.
 *
 * Nothing prunes activity_logs, which is why this exists — the table only grows.
 *
 * Deliberately writes NO log entry of its own, by explicit decision. The consequence, recorded here
 * so nobody later assumes otherwise: this table is an editable record, not an audit trail. Rows can
 * be removed without a trace, including by the person whose actions they describe, so it should not
 * be relied on as evidence of what did or did not happen.
 */
router.delete('/api/admin/activity/:id', verifyToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: "Access Denied" });

    if (!db) await initDB();
    try {
        const result = await db.run("DELETE FROM activity_logs WHERE id = ?", req.params.id);
        if (!result?.changes) return res.status(404).json({ error: "Entry not found" });
        res.json({ success: true });
    } catch (e) {
        sendServerError(res, e);
    }
});

export default router;

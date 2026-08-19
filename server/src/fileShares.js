import crypto from 'crypto';
import { db, initDB } from './db.js';
import { isShareLive, liveShareSql, expiryFromHours } from './shareExpiry.js';
import { ancestorIds, isAtOrBelow } from './fileTree.js';
import * as store from './fileStore.js';

/**
 * Sharing a file or folder: with named people, or by public link.
 *
 * One table holds both, discriminated by `kind`, so expiry and revocation are written once — see the
 * CHECK on file_shares in db.js for why that is safe rather than merely tidy.
 *
 * A folder grant covers its whole subtree, including things added later. That is deliberate and it is
 * what makes "share a folder" mean what people expect, but it is also the sharpest edge in the
 * feature: moving a file into a shared folder widens who can read it. The client says so at the
 * moment of the move rather than leaving it to be discovered.
 */

const nowIso = () => new Date().toISOString();
const ready = async () => { if (!db) await initDB(); };

/**
 * Everything that must still hold for a share to work, re-checked on every use rather than trusted
 * from creation time.
 *
 * The first three rungs are shared with media shares (isShareLive). The rest exist because a share
 * points at rows that can change underneath it, and the rule this codebase already follows is that a
 * permission which changed after creation must kill the link rather than become a standing bypass —
 * the same reasoning as shareResolver re-checking whether a file was moved to the vault.
 */
export const validateShare = async (share) => {
    if (!isShareLive(share)) return { ok: false, status: 404, error: 'Link not found' };

    // Trashed counts as gone immediately, not after the grace period: the owner deleted it.
    const node = await store.getNode(share.node_id);
    if (!node) return { ok: false, status: 404, error: 'Link not found' };

    // A node whose owner changed is no longer the thing that was shared.
    if (node.owner_username !== share.owner_username) return { ok: false, status: 404, error: 'Link not found' };

    // An owner whose account is gone leaves a link nobody can revoke, since the management view is
    // scoped by owner. Treat it as dead.
    const owner = await db.get("SELECT id FROM users WHERE username = ?", share.owner_username);
    if (!owner) return { ok: false, status: 404, error: 'Link not found' };

    if (share.kind === 'user') {
        // verifyToken reads status from the session rather than users, so approval is only ever
        // checked at sign-in — this is the one place a since-revoked account is noticed.
        const recipient = await db.get(
            "SELECT id FROM users WHERE id = ? AND status = 'approved'", share.recipient_user_id
        );
        if (!recipient) return { ok: false, status: 404, error: 'Link not found' };
    }

    return { ok: true, share, node };
};

/**
 * Resolves a public link, optionally to one item inside a shared folder.
 *
 * `AND kind = 'link'` is belt to the CHECK's braces: user grants store no token, so a token lookup
 * cannot return one anyway — but stating it here means the intent survives a future edit.
 */
export const resolveFileShare = async (token, requestedNodeId = null) => {
    await ready();
    const share = await db.get("SELECT * FROM file_shares WHERE token = ? AND kind = 'link'", token);
    const base = await validateShare(share);
    if (!base.ok) return base;

    if (!requestedNodeId || requestedNodeId === base.node.id) return { ...base, target: base.node };

    const target = await store.getNode(requestedNodeId);
    // Descendancy is checked rather than assumed — the analogue of a series share refusing a path
    // that isn't one of its episodes. Without it, a folder link would be a key to the whole tree.
    if (!target || !isAtOrBelow(target.path_ids, base.node.path_ids)) {
        return { ok: false, status: 404, error: 'That item is not part of this share' };
    }
    return { ...base, target };
};

/**
 * Can this signed-in user read this node by virtue of a grant?
 *
 * Checks the node and every ancestor against the grants held by this user, so a grant on a folder
 * reaches everything inside it. The ancestor ids come from path_ids, so this is one query regardless
 * of depth.
 */
export const grantFor = async (node, userId) => {
    await ready();
    if (!node || !userId) return null;

    const ids = ancestorIds(node.path_ids);
    if (!ids.length) return null;

    const rows = await db.all(
        `SELECT * FROM file_shares
          WHERE kind = 'user' AND recipient_user_id = ?
            AND node_id IN (${ids.map(() => '?').join(',')})
            AND ${liveShareSql()}`,
        [userId, ...ids, nowIso()]
    );

    for (const row of rows) {
        // Each candidate still has to pass the full ladder — a grant row alone is not access.
        const verdict = await validateShare(row);
        if (verdict.ok) return row;
    }
    return null;
};

/** Creates a public link. Several are allowed on one node: different links, different lifetimes. */
export const createLinkShare = async ({ owner, nodeId, expiresInHours }) => {
    await ready();
    const expiry = expiryFromHours(expiresInHours);
    if (!expiry.ok) return { ok: false, status: 400, error: expiry.error };

    const node = await store.getNode(nodeId);
    if (!node) return { ok: false, status: 404, error: 'Item not found' };
    // Only the owner shares. Deliberately unlike POST /api/share for media, which skips this because
    // a non-vault movie is already visible to every account — nothing here is.
    if (node.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };

    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    await db.run(
        `INSERT INTO file_shares (id, node_id, kind, token, owner_username, created_at, expires_at)
         VALUES (?, ?, 'link', ?, ?, ?, ?)`,
        [id, node.id, token, owner, nowIso(), expiry.expiresAt]
    );
    return { ok: true, share: await db.get("SELECT * FROM file_shares WHERE id = ?", id), node };
};

/**
 * Grants one named user access. Idempotent per (node, recipient): sharing with the same person twice
 * returns the existing grant rather than accumulating duplicate rows that all mean the same thing.
 */
export const createUserShare = async ({ owner, nodeId, recipientUserId, expiresInHours }) => {
    await ready();
    const expiry = expiryFromHours(expiresInHours);
    if (!expiry.ok) return { ok: false, status: 400, error: expiry.error };

    const node = await store.getNode(nodeId);
    if (!node) return { ok: false, status: 404, error: 'Item not found' };
    if (node.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };

    const recipient = await db.get(
        "SELECT id, username FROM users WHERE id = ? AND status = 'approved'", recipientUserId
    );
    if (!recipient) return { ok: false, status: 400, error: 'That account cannot be shared with' };
    if (recipient.username === owner) return { ok: false, status: 400, error: 'That is already your file' };

    const existing = await db.get(
        `SELECT * FROM file_shares
          WHERE node_id = ? AND kind = 'user' AND recipient_user_id = ? AND ${liveShareSql()}`,
        [node.id, recipient.id, nowIso()]
    );
    if (existing) return { ok: true, share: existing, node, recipient, existed: true };

    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO file_shares (id, node_id, kind, recipient_user_id, owner_username, created_at, expires_at)
         VALUES (?, ?, 'user', ?, ?, ?, ?)`,
        [id, node.id, recipient.id, owner, nowIso(), expiry.expiresAt]
    );
    return { ok: true, share: await db.get("SELECT * FROM file_shares WHERE id = ?", id), node, recipient };
};

/** Everything this user is sharing, live only, with enough context to render a row. */
export const listMyShares = async (owner) => {
    await ready();
    return db.all(
        `SELECT s.*, n.name AS node_name, n.is_folder, u.username AS recipient_username
           FROM file_shares s
           JOIN file_nodes n ON n.id = s.node_id AND n.deleted_at IS NULL
           LEFT JOIN users u ON u.id = s.recipient_user_id
          WHERE s.owner_username = ? AND ${liveShareSql('s')}
          ORDER BY s.created_at DESC`,
        [owner, nowIso()]
    );
};

/**
 * What has been shared with this user — the granted items themselves, not their contents.
 *
 * Each candidate goes through the full ladder rather than being trusted from the join, so a grant
 * whose owner has been deleted or whose node changed hands disappears from here for the same reason
 * it stops working.
 */
export const listSharedWithMe = async (userId) => {
    await ready();
    if (!userId) return [];
    const rows = await db.all(
        `SELECT s.*, n.name AS node_name, n.is_folder, n.size, n.mime, n.updated_at AS node_updated_at
           FROM file_shares s
           JOIN file_nodes n ON n.id = s.node_id AND n.deleted_at IS NULL
          WHERE s.kind = 'user' AND s.recipient_user_id = ?
            AND ${liveShareSql('s')}
          ORDER BY s.created_at DESC`,
        [userId, nowIso()]
    );

    const visible = [];
    for (const row of rows) {
        if ((await validateShare(row)).ok) visible.push(row);
    }
    return visible;
};

export const revokeShare = async ({ id, username, role }) => {
    await ready();
    const share = await db.get("SELECT * FROM file_shares WHERE id = ?", id);
    if (!share) return { ok: false, status: 404, error: 'Share not found' };
    // A super_admin may revoke anyone's share but cannot create one — the same asymmetry the media
    // share routes already have, which keeps the audit trail honest about who granted what.
    if (share.owner_username !== username && role !== 'super_admin') {
        return { ok: false, status: 403, error: 'Access Denied' };
    }
    await db.run("UPDATE file_shares SET revoked = 1 WHERE id = ?", id);
    return { ok: true, share };
};

export const setShareExpiry = async ({ id, username, role, expiresInHours }) => {
    await ready();
    const expiry = expiryFromHours(expiresInHours);
    if (!expiry.ok) return { ok: false, status: 400, error: expiry.error };

    const share = await db.get("SELECT * FROM file_shares WHERE id = ?", id);
    if (!share) return { ok: false, status: 404, error: 'Share not found' };
    if (share.owner_username !== username && role !== 'super_admin') {
        return { ok: false, status: 403, error: 'Access Denied' };
    }
    // Refuses to revive a dead share, matching PATCH /api/share/:token — an expired link staying
    // expired is what makes "expired" mean anything.
    if (!isShareLive(share)) return { ok: false, status: 404, error: 'Share not found' };

    await db.run("UPDATE file_shares SET expires_at = ? WHERE id = ?", [expiry.expiresAt, id]);
    return { ok: true, expiresAt: expiry.expiresAt };
};

/** Counted once per landing-page load, like touchShare — so "opens" means what it says. */
export const touchFileShare = async (id) => {
    await ready();
    await db.run(
        "UPDATE file_shares SET open_count = open_count + 1, last_accessed_at = ? WHERE id = ?",
        [nowIso(), id]
    );
};

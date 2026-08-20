import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { db, initDB, logActivity, getSetting } from '../db.js';
import { verifyToken } from '../middleware.js';
import { sendServerError } from '../logger.js';
import { storagePathFor } from '../paths.js';
import { decodeMultipartFilename } from '../multipartFilename.js';
import { uploadUserFile } from '../uploadMiddleware.js';
import { mintFileToken, canRenderInline } from '../fileServer.js';
import { effectiveExpiry } from '../fileTree.js';
import { expiryFromHours } from '../shareExpiry.js';
import * as store from '../fileStore.js';
import * as shares from '../fileShares.js';

const router = express.Router();

/** Tunable without a deploy, via the existing settings table. 20 GiB unless told otherwise. */
const DEFAULT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
const quotaBytes = async () => Number(await getSetting('files_quota_bytes', String(DEFAULT_QUOTA_BYTES)));

/**
 * The shape sent to the client for one item.
 *
 * `expiresAt` is the *effective* one — the earliest in the chain — with `expiresFrom` naming the
 * ancestor it came from when it isn't the item's own, so the UI can say "in 30 days · Receipts"
 * rather than implying the file was set that way itself.
 */
const view = (node, chain = []) => {
    const effective = effectiveExpiry([...chain, node]);
    const inherited = effective && effective !== node.expires_at;
    const source = inherited ? chain.find((a) => a.expires_at === effective) : null;
    return {
        id: node.id,
        name: node.name,
        isFolder: !!node.is_folder,
        size: node.size,
        mime: node.mime,
        updatedAt: node.updated_at,
        expiresAt: effective,
        expiresFrom: source ? source.name : null,
        canPreview: !node.is_folder && canRenderInline(node.name),
    };
};

const ownRoot = async (req) => store.ensureRoot(req.user.username);

// --- Browsing -----------------------------------------------------------------------------------

router.get('/api/files', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const root = await ownRoot(req);
        const node = req.query.parent ? await store.getNode(req.query.parent) : root;
        if (!node || !node.is_folder) return res.status(404).json({ error: 'Folder not found' });
        // Browsing someone else's folder happens through a share, not through this route.
        if (node.owner_username !== req.user.username) return res.status(403).json({ error: 'Access Denied' });

        const ancestors = await store.ancestorsOf(node);
        const children = await store.listChildren(node.id);
        const chain = [...ancestors, node];

        res.json({
            parent: { id: node.id, name: node.name, isRoot: !node.parent_id },
            // Root included so the client always has a "Home" to navigate back to.
            breadcrumb: chain.map((a) => ({ id: a.id, name: a.name, isRoot: !a.parent_id })),
            items: children.map((c) => view(c, chain)),
            quota: { used: await store.usedBytes(req.user.username), limit: await quotaBytes() },
        });
    } catch (e) { sendServerError(res, e); }
});

// --- Creating and organising ---------------------------------------------------------------------

router.post('/api/files/folder', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const parentId = req.body?.parentId || (await ownRoot(req)).id;
        const result = await store.createFolder({ owner: req.user.username, parentId, name: req.body?.name });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        res.json({ success: true, item: view(result.node) });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Idempotent counterpart for folder upload: the client dedupes its selection's directory names and
 * sends them once, then uploads each file against the leaf id this returns. That is why the upload
 * route below never sees a path.
 */
router.post('/api/files/folders/ensure', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const parentId = req.body?.parentId || (await ownRoot(req)).id;
        const result = await store.ensureFolderPath({
            owner: req.user.username, parentId, segments: req.body?.segments,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        res.json({ success: true, item: view(result.node) });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Renames, or sets auto-delete, or both.
 *
 * `expiresInHours` uses the same helper as share expiry, so "30 days" means the same thing in both
 * places and both store a canonical ISO timestamp. On a folder the deadline becomes a ceiling for
 * everything inside it — see effectiveExpiry.
 */
router.patch('/api/files/:id', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const owner = req.user.username;
        let item;

        if (req.body?.name !== undefined) {
            const renamed = await store.renameNode({ owner, id: req.params.id, name: req.body.name });
            if (!renamed.ok) return res.status(renamed.status).json({ error: renamed.error });
            item = renamed.node;
        }

        if (req.body?.expiresInHours !== undefined) {
            const expiry = expiryFromHours(req.body.expiresInHours);
            if (!expiry.ok) return res.status(400).json({ error: expiry.error });
            const set = await store.setExpiry({ owner, id: req.params.id, expiresAt: expiry.expiresAt });
            if (!set.ok) return res.status(set.status).json({ error: set.error });
            item = set.node;
        }

        if (!item) return res.status(400).json({ error: 'Nothing to change' });

        // Re-read the chain so the response carries the effective expiry, not just the stored one.
        const chain = await store.ancestorsOf(item);
        res.json({ success: true, item: view(item, chain) });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Bulk move, reported per item.
 *
 * Not all-or-nothing: one name collision must not abandon the other forty, and with no transactions
 * anywhere in this codebase an all-or-nothing batch could not be honoured anyway. The client shows
 * what moved and what didn't.
 */
router.post('/api/files/move', verifyToken, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const destinationId = req.body?.destinationId;
    if (!ids.length) return res.status(400).json({ error: 'Nothing to move' });
    if (!destinationId) return res.status(400).json({ error: 'A destination is required' });

    try {
        if (!db) await initDB();
        const results = [];
        for (const id of ids) {
            // Sequential rather than parallel: each move rewrites path prefixes that a sibling move
            // in the same batch may be reading.
            const r = await store.moveNode({ owner: req.user.username, id, destinationId });
            results.push({ id, ok: r.ok, error: r.error });
        }
        const moved = results.filter((r) => r.ok).length;
        if (moved) await logActivity(req.user.username, 'FILE_MOVE', `Moved ${moved} item(s)`, req.ip);
        res.json({ success: true, moved, results });
    } catch (e) { sendServerError(res, e); }
});

router.delete('/api/files/:id', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const node = await store.getNode(req.params.id);
        if (!node) return res.status(404).json({ error: 'Item not found' });
        if (node.owner_username !== req.user.username) return res.status(403).json({ error: 'Access Denied' });

        const summary = await store.subtreeSummary(node);
        const result = await store.trashNode({ owner: req.user.username, id: req.params.id });
        if (!result.ok) return res.status(result.status).json({ error: result.error });

        await logActivity(req.user.username, 'FILE_DELETE', `Moved "${node.name}" to trash (${summary.files} file(s))`, req.ip);
        res.json({ success: true, trashed: result.trashed });
    } catch (e) { sendServerError(res, e); }
});

/** What a recursive delete is about to remove, so the confirmation can state it. */
router.get('/api/files/:id/summary', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const node = await store.getNode(req.params.id);
        if (!node) return res.status(404).json({ error: 'Item not found' });
        if (node.owner_username !== req.user.username) return res.status(403).json({ error: 'Access Denied' });
        res.json(await store.subtreeSummary(node));
    } catch (e) { sendServerError(res, e); }
});

// --- Trash --------------------------------------------------------------------------------------

/**
 * What is recoverable, and for how long.
 *
 * Only the top-most trashed items: deleting a folder marks its whole subtree, so listing every marked
 * row would show the folder and then each of its children separately — all of which come back
 * together anyway.
 */
router.get('/api/files/trash', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const rows = await store.listTrash(req.user.username);
        const graceDays = Number(await getSetting('files_trash_grace_days', '7'));
        res.json({
            graceDays,
            items: rows.map((n) => ({
                id: n.id,
                name: n.name,
                isFolder: !!n.is_folder,
                size: n.size,
                deletedAt: n.deleted_at,
                purgesAt: new Date(new Date(n.deleted_at).getTime() + graceDays * 86400000).toISOString(),
            })),
        });
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/files/:id/restore', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const result = await store.restoreNode({ owner: req.user.username, id: req.params.id });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        res.json({ success: true, restored: result.restored });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Skips the grace period for one item.
 *
 * Deliberately reuses the reaper's ordering rather than inventing its own: rows first, then bytes, so
 * a failure halfway leaves something the orphan sweep collects instead of a row pointing at nothing.
 */
router.delete('/api/files/:id/purge', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const node = await store.getNodeIncludingTrashed(req.params.id);
        if (!node || !node.deleted_at) return res.status(404).json({ error: 'Not in the trash' });
        if (node.owner_username !== req.user.username) return res.status(403).json({ error: 'Access Denied' });

        const subtree = await store.trashedSubtree(node);
        await store.purgeRows(subtree.map((n) => n.id));
        for (const n of subtree.filter((x) => x.storage_name)) {
            await fs.unlink(storagePathFor(n.storage_name)).catch(() => {});
        }

        await logActivity(req.user.username, 'FILE_PURGE', `Permanently deleted "${node.name}"`, req.ip);
        res.json({ success: true, purged: subtree.length });
    } catch (e) { sendServerError(res, e); }
});

// --- Upload -------------------------------------------------------------------------------------

/**
 * One file per request, carrying only an opaque parentId.
 *
 * The multipart field order that routes/media.js depends on does not apply here: that constraint
 * exists because its storage engine reads req.body mid-parse to decide where the bytes go, whereas
 * this always takes the TEMP_DIR branch and reads req.body only once the handler runs.
 */
router.post('/api/files/upload', verifyToken, (req, res, next) => {
    req.setTimeout(3600000);
    next();
}, uploadUserFile.single('file'), async (req, res) => {
    const temp = req.file?.path;
    const cleanup = async () => { if (temp) await fs.unlink(temp).catch(() => {}); };

    try {
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        if (!db) await initDB();

        const owner = req.user.username;
        const parentId = req.body?.parentId || (await ownRoot(req)).id;
        // Same latin-1 recovery as the media upload — an accented or dashed filename would
        // otherwise be stored mojibaked and shown that way to whoever the file is shared with.
        const name = req.body?.name || decodeMultipartFilename(req.file.originalname);

        // Quota before anything is moved into place. It can overshoot by up to the concurrency the
        // client allows, since parallel uploads each see the same pre-upload total — bounded by the
        // client's upload pool and accepted rather than solved with a reservation table.
        const [used, limit] = [await store.usedBytes(owner), await quotaBytes()];
        if (used + req.file.size > limit) {
            await cleanup();
            return res.status(507).json({
                error: `That would exceed your ${Math.round(limit / 1024 ** 3)} GB of storage. Delete something first — items in the trash still count until they are purged.`,
            });
        }

        // The temp name is already 16 random bytes from the storage engine, so it doubles as the
        // opaque on-disk name and this becomes a rename rather than a copy. Both live under
        // USER_HOME, so it is same-filesystem and atomic.
        const storageName = path.basename(temp);
        const destination = storagePathFor(storageName);
        await fs.mkdir(path.dirname(destination), { recursive: true });

        // The row is written last: a crash before it leaves a nameless blob the reaper collects,
        // whereas the other order would leave a row pointing at nothing.
        await fs.rename(temp, destination);

        const created = await store.createFile({
            owner, parentId, name, storageName, size: req.file.size, mime: req.file.mimetype || null,
        });
        if (!created.ok) {
            await fs.unlink(destination).catch(() => {});
            return res.status(created.status).json({ error: created.error });
        }

        res.json({ success: true, item: view(created.node) });
    } catch (e) {
        await cleanup();
        sendServerError(res, e, 'Upload failed');
    }
});

// --- Byte access --------------------------------------------------------------------------------

/**
 * Trades an id the caller may read for a short-lived grant on the files origin.
 *
 * This is the only place ownership is checked for byte access, which is the point: the files origin
 * has no database and no idea who anyone is, so the decision has to be made here.
 */
router.post('/api/files/:id/token', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const node = await store.getNode(req.params.id);
        if (!node || node.is_folder) return res.status(404).json({ error: 'File not found' });

        // Either you own it, or someone granted it to you — directly or by sharing a folder above it.
        const owns = node.owner_username === req.user.username;
        if (!owns && !(await shares.grantFor(node, req.user.id))) {
            return res.status(403).json({ error: 'Access Denied' });
        }

        const token = mintFileToken({
            absPath: storagePathFor(node.storage_name),
            name: node.name,
            size: node.size,
            inline: req.body?.inline === true,
        });
        res.json({ success: true, token, path: `/f/${token}` });
    } catch (e) { sendServerError(res, e); }
});

// --- Sharing ------------------------------------------------------------------------------------

/**
 * Shares one item, either as a public link or with named people.
 *
 * Both modes in one endpoint because they are one decision to the person making it — the client's
 * dialog is a radio button, not two features. `recipientUserIds` may name several, and each becomes
 * its own grant row so they can be revoked independently.
 */
router.post('/api/files/:id/share', verifyToken, async (req, res) => {
    const { kind, recipientUserIds, expiresInHours } = req.body || {};
    try {
        if (!db) await initDB();

        if (kind === 'link') {
            const r = await shares.createLinkShare({ owner: req.user.username, nodeId: req.params.id, expiresInHours });
            if (!r.ok) return res.status(r.status).json({ error: r.error });
            await logActivity(req.user.username, 'FILE_SHARE', `Created a public link for "${r.node.name}"`, req.ip);
            return res.json({ success: true, token: r.share.token, shareId: r.share.id, expiresAt: r.share.expires_at });
        }

        if (kind === 'user') {
            const ids = Array.isArray(recipientUserIds) ? recipientUserIds : [];
            if (!ids.length) return res.status(400).json({ error: 'Pick at least one person to share with' });

            const results = [];
            for (const recipientUserId of ids) {
                const r = await shares.createUserShare({
                    owner: req.user.username, nodeId: req.params.id, recipientUserId, expiresInHours,
                });
                results.push({ recipientUserId, ok: r.ok, error: r.error, username: r.recipient?.username });
            }
            const granted = results.filter((r) => r.ok);
            // Reported per recipient for the same reason a bulk move is: one bad id must not discard
            // the rest, and the client can say precisely who it reached.
            if (granted.length) {
                const node = await store.getNode(req.params.id);
                await logActivity(
                    req.user.username, 'FILE_SHARE',
                    `Shared "${node?.name}" with ${granted.map((g) => g.username).join(', ')}`, req.ip
                );
            }
            return res.json({ success: true, granted: granted.length, results });
        }

        res.status(400).json({ error: "kind must be 'link' or 'user'" });
    } catch (e) { sendServerError(res, e); }
});

router.get('/api/files/shares/mine', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const rows = await shares.listMyShares(req.user.username);
        res.json({
            shares: rows.map((s) => ({
                id: s.id,
                kind: s.kind,
                token: s.token,
                // The node id, not just its name: two folders in different places can share a name,
                // and the client uses this to decide which one is marked as shared.
                nodeId: s.node_id,
                itemName: s.node_name,
                isFolder: !!s.is_folder,
                recipient: s.recipient_username,
                createdAt: s.created_at,
                expiresAt: s.expires_at,
                opens: s.open_count,
                lastAccessedAt: s.last_accessed_at,
            })),
        });
    } catch (e) { sendServerError(res, e); }
});

router.patch('/api/files/share/:id', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const r = await shares.setShareExpiry({
            id: req.params.id, username: req.user.username, role: req.user.role,
            expiresInHours: req.body?.expiresInHours,
        });
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        res.json({ success: true, expiresAt: r.expiresAt });
    } catch (e) { sendServerError(res, e); }
});

router.delete('/api/files/share/:id', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const r = await shares.revokeShare({ id: req.params.id, username: req.user.username, role: req.user.role });
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        await logActivity(req.user.username, 'FILE_SHARE_REVOKE', 'Revoked a file share', req.ip);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

/**
 * What other people have shared with this account.
 *
 * There is no notification system anywhere in this app and this change does not add one, so this view
 * plus its count is how a recipient finds out at all. Worth knowing rather than discovering.
 */
router.get('/api/files/shared-with-me', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const rows = await shares.listSharedWithMe(req.user.id);
        res.json({
            items: rows.map((s) => ({
                shareId: s.id,
                id: s.node_id,
                name: s.node_name,
                isFolder: !!s.is_folder,
                size: s.size,
                owner: s.owner_username,
                sharedAt: s.created_at,
                expiresAt: s.expires_at,
            })),
        });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Browsing inside something shared with you. Read-only by design: a recipient can look and download,
 * never rename, move, delete or re-share — which also disposes of cross-owner moves as a category
 * rather than as a check.
 */
router.get('/api/files/shared/:id', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const node = await store.getNode(req.params.id);
        if (!node) return res.status(404).json({ error: 'Not found' });
        if (!(await shares.grantFor(node, req.user.id))) return res.status(404).json({ error: 'Not found' });
        if (!node.is_folder) return res.status(400).json({ error: 'That is a file, not a folder' });

        const children = await store.listChildren(node.id);
        res.json({
            parent: { id: node.id, name: node.name, owner: node.owner_username },
            items: children.map((c) => view(c)),
            readOnly: true,
        });
    } catch (e) { sendServerError(res, e); }
});

// --- Public link (no auth) ----------------------------------------------------------------------

/**
 * What a public link points at. For a folder, its immediate children; `?node=` walks deeper, and the
 * resolver verifies descendancy rather than trusting the parameter.
 */
router.get('/api/files/share/:token/info', async (req, res) => {
    try {
        const r = await shares.resolveFileShare(req.params.token, req.query.node || null);
        if (!r.ok) return res.status(r.status).json({ error: r.error });

        // Counted once per landing-page load, like media shares — so "opens" means what it says
        // rather than counting range requests.
        if (!req.query.node) await shares.touchFileShare(r.share.id);

        const target = r.target;
        const items = target.is_folder ? await store.listChildren(target.id) : [];
        res.json({
            root: { id: r.node.id, name: r.node.name, isFolder: !!r.node.is_folder },
            current: { id: target.id, name: target.name, isFolder: !!target.is_folder, size: target.size },
            items: items.map((c) => view(c)),
        });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Mints a byte grant for something inside a public link.
 *
 * Same short-lived FILE_TOKENS mechanism the authenticated path uses, so the files origin has exactly
 * one way to be asked for bytes and no idea whether the requester was signed in.
 */
router.post('/api/files/share/:token/token', async (req, res) => {
    try {
        const r = await shares.resolveFileShare(req.params.token, req.body?.node || null);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        if (r.target.is_folder) return res.status(400).json({ error: 'That is a folder' });

        const token = mintFileToken({
            absPath: storagePathFor(r.target.storage_name),
            name: r.target.name,
            size: r.target.size,
            inline: req.body?.inline === true,
        });
        res.json({ success: true, token, path: `/f/${token}` });
    } catch (e) { sendServerError(res, e); }
});

// --- Who you can share with ---------------------------------------------------------------------

/**
 * Every approved account except the caller's own.
 *
 * A new endpoint because the only existing user listing is admin-gated, and a normal user sharing
 * their own file has nothing to populate a picker with. It does disclose the member roster to every
 * signed-in account — accepted deliberately for a household server, and worth knowing rather than
 * discovering. Pending and rejected accounts are excluded: they cannot sign in, so sharing with one
 * would silently do nothing.
 */
router.get('/api/users/shareable', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const rows = await db.all(
            "SELECT id, username FROM users WHERE status = 'approved' AND username != ? ORDER BY username COLLATE NOCASE",
            req.user.username
        );
        res.json({ users: rows });
    } catch (e) { sendServerError(res, e); }
});

export default router;

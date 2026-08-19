import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { db, initDB, logActivity, getSetting } from '../db.js';
import { verifyToken } from '../middleware.js';
import { sendServerError } from '../logger.js';
import { storagePathFor } from '../paths.js';
import { uploadUserFile } from '../uploadMiddleware.js';
import { mintFileToken, canRenderInline } from '../fileServer.js';
import { effectiveExpiry } from '../fileTree.js';
import * as store from '../fileStore.js';

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

router.patch('/api/files/:id', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const result = await store.renameNode({ owner: req.user.username, id: req.params.id, name: req.body?.name });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        res.json({ success: true, item: view(result.node) });
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
        const name = req.body?.name || req.file.originalname;

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
        // Share-based access arrives through the share routes, not here.
        if (node.owner_username !== req.user.username) return res.status(403).json({ error: 'Access Denied' });

        const token = mintFileToken({
            absPath: storagePathFor(node.storage_name),
            name: node.name,
            size: node.size,
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

import express from 'express';
import { USER_HOME } from '../paths.js';
import { db } from '../db.js';
import { verifyToken } from '../middleware.js';
import { hasFreeSpace, sendServerError } from '../logger.js';
import { processDownloadQueue, requestDownloadCancel } from '../telegramService.js';
import { getNodeForDirectDownload } from '../nodeDiscovery.js';

const router = express.Router();

// Statuses for which pressing "Get" right now would actually start a fresh download —
// completed/downloading files aren't going anywhere, so a direct-node candidate for them
// would be meaningless.
const DOWNLOADABLE_STATUSES = ['discovered', 'stopped', 'failed', 'queued'];

router.get('/api/telegram/files', verifyToken, async (req, res) => {
    try {
        const files = await db.all("SELECT * FROM telegram_files ORDER BY message_id DESC");
        const nodeNames = new Map((await db.all("SELECT id, name FROM nodes")).map(n => [n.id, n.name]));

        // getNodeForDirectDownload is a cheap, side-effect-free read over in-memory node
        // state (server/src/nodeDiscovery.js) — safe to call once per row. Note this is a
        // live "best candidate right now" preview, not a reservation: node availability
        // (free space, transcoder idleness) can change by the time a download actually
        // starts, and if several rows are shown pointing at the same node, only whichever
        // one is actually dispatched next will really land there.
        const enriched = files.map((f) => {
            if (!DOWNLOADABLE_STATUSES.includes(f.status)) {
                return { ...f, directNodeId: null, directNodeName: null };
            }
            const candidate = getNodeForDirectDownload(f.size || 0);
            return {
                ...f,
                directNodeId: candidate?.id || null,
                directNodeName: candidate ? (nodeNames.get(candidate.id) || candidate.id) : null,
            };
        });

        res.json(enriched);
    } catch (e) { sendServerError(res, e); }
});

router.post('/api/telegram/download', verifyToken, async (req, res) => {
    const { message_id } = req.body;
    try {
        if (!(await hasFreeSpace(USER_HOME))) return res.status(507).json({ error: "Insufficient disk space" });
        await db.run("UPDATE telegram_files SET status = 'queued', downloaded_size = 0 WHERE message_id = ?", [message_id]);
        processDownloadQueue();
        res.json({ success: true, message: "Download Queued" });
    } catch (e) { sendServerError(res, e); }
});

// Previously written as one unbroken statement with no try/catch at all — a real gap that's
// easy to miss when validation, DB access, and business logic all run together with no
// visual seam to spot it at.
router.post('/api/telegram/stop', verifyToken, async (req, res) => {
    const { message_id } = req.body;
    try {
        const currentItem = await db.get("SELECT message_id FROM telegram_files WHERE status = 'downloading'");
        if (currentItem && currentItem.message_id === message_id) {
            requestDownloadCancel();
            res.json({ success: true, message: "Stop signal sent" });
        } else {
            await db.run("UPDATE telegram_files SET status = 'stopped' WHERE message_id = ?", message_id);
            res.json({ success: true, message: "Removed from queue" });
        }
    } catch (e) { sendServerError(res, e); }
});

router.get('/api/resync-db', verifyToken, async (req, res) => {
    try {
        const result = await db.run(`DELETE FROM telegram_files WHERE size = '[object Object]' OR size LIKE '%object%' OR size IS NULL`);
        res.send(`Deleted ${result.changes} bad entries.`);
    } catch (e) { sendServerError(res, e); }
});

export default router;

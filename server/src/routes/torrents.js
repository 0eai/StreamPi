import express from 'express';
import { db } from '../db.js';
import { verifyToken } from '../middleware.js';
import { torrentClient, addTorrentToClient } from '../torrentService.js';
import { sendServerError } from '../logger.js';

const router = express.Router();

router.get('/api/torrents', verifyToken, (req, res) => {
    const list = torrentClient.torrents.map(t => ({
        hash: t.infoHash,
        name: t.name || "Fetching Metadata...",
        progress: t.progress * 100,
        downloadSpeed: t.downloadSpeed,
        uploadSpeed: t.uploadSpeed,
        numPeers: t.numPeers,
        size: t.length,
        downloaded: t.downloaded,
        timeRemaining: t.timeRemaining,
        state: t.paused ? 'paused' : (t.done ? 'completed' : 'downloading')
    }));

    if (list.length > 0) {
        const t = list[0];
        console.log(`📊 [STATUS] ${list.length} Torrents | First: ${t.name} | Peers: ${t.numPeers} | Speed: ${(t.downloadSpeed/1024).toFixed(0)} KB/s`);
    } else {
        console.log("📊 [STATUS] No active torrents");
    }

    res.json(list);
});

router.post('/api/torrents', verifyToken, async (req, res) => {
    const { magnet, isPrivate } = req.body;

    console.log("➕ [DEBUG] API Request received. Magnet length:", magnet ? magnet.length : 'null');

    if (!magnet || !magnet.startsWith('magnet:?')) {
        console.error("❌ [DEBUG] Invalid magnet link format");
        return res.status(400).json({ error: "Invalid magnet link" });
    }

    try {
        const wantsPrivate = isPrivate === true || isPrivate === 'true'; // Handle boolean or string
        const isPrivateInt = wantsPrivate ? 1 : 0;
        const owner = wantsPrivate ? req.user.username : null; // 👈 Capture Owner

        console.log(`👤 Adding Torrent | User: ${req.user.username} | Private: ${wantsPrivate}`);

        // Pass owner to function
        addTorrentToClient(magnet, true, isPrivateInt, owner);

        res.json({ success: true, message: wantsPrivate ? "Added to your Private Vault" : "Torrent added" });
    } catch (e) {
        console.error("🔥 [DEBUG] API Exception:", e);
        sendServerError(res, e);
    }
});

router.post('/api/torrents/:hash/:action', verifyToken, async (req, res) => {
    const { hash, action } = req.params;
    const torrent = torrentClient.get(hash);

    if (!torrent && action !== 'remove') return res.status(404).json({ error: "Torrent not found" });
    // An unrecognized action previously fell through every branch untouched and still
    // returned {success:true} having done nothing.
    if (!['pause', 'resume', 'remove'].includes(action)) return res.status(400).json({ error: "Invalid action" });

    try {
        if (action === 'pause') {
            torrent.pause();
            if (db) await db.run("UPDATE torrents SET status = 'paused' WHERE hash = ?", hash);
        }
        else if (action === 'resume') {
            torrent.resume();
            if (db) await db.run("UPDATE torrents SET status = 'downloading' WHERE hash = ?", hash);
        }
        else if (action === 'remove') {
            if (torrent) {
                torrent.destroy({ destroyStore: true });
            }
            if (db) await db.run("DELETE FROM torrents WHERE hash = ?", hash);
        }
        res.json({ success: true });
    } catch (e) {
        sendServerError(res, e);
    }
});

export default router;

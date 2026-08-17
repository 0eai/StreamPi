import express from 'express';
import path from 'path';
import { existsSync } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { THUMB_FOLDER, PRIVATE_ROOT, isSafeFilename } from '../paths.js';
import { db, initDB } from '../db.js';
import { verifyToken } from '../middleware.js';
import { ACTIVE_STREAMS } from '../state.js';
import { resolveNasFile } from '../nasSource.js';
import { streamMediaFile, streamSubtitle, downloadMediaFile } from '../streamCore.js';

const router = express.Router();

router.get('/api/posters/:filename', async (req, res) => {
    const { filename } = req.params;
    // No auth on this route by design (posters render as plain <img src> tags), which makes
    // this check load-bearing rather than defense-in-depth — without it, "../media.db" or
    // "../server.key" resolves one directory up from THUMB_FOLDER and gets served to anyone.
    if (!isSafeFilename(filename)) return res.status(400).send("Invalid filename");
    const thumbPath = path.join(THUMB_FOLDER, filename);

    if (existsSync(thumbPath)) return res.sendFile(thumbPath);

    try {
        if (!db) await initDB();
        const mediaItem = await db.get("SELECT path FROM media WHERE poster = ?", filename);

        if (!mediaItem || !mediaItem.path) return res.status(404).send("Poster not found");

        console.log(`🎨 Auto-regenerating poster for: ${filename}`);

        let inputPath = mediaItem.path;
        let inputOptions = ['-ss', '30']; // Skip 30s

        if (inputPath.startsWith('nas://')) {
            const nas = resolveNasFile(inputPath);
            if (!nas.ok) return res.status(nas.status).send(nas.error);

            inputPath = nas.url;
            inputOptions = [
                '-headers', `Authorization: Bearer ${nas.apiKey}\r\n`,
                '-ss', '30'
            ];
        } else if (!existsSync(inputPath)) {
            return res.status(404).send("Local file missing");
        }

        await new Promise((resolve, reject) => {
            const cmd = ffmpeg();

            cmd.inputOptions(inputOptions);
            cmd.input(inputPath);
            cmd.outputOptions([
                '-vframes', '1',
                '-q:v', '2',
                '-vf', 'scale=320:-1'
            ])
            .output(thumbPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        res.sendFile(thumbPath);

    } catch (e) {
        console.error(`❌ Poster Gen Failed: ${e.message}`);
        res.status(404).send("Generation failed");
    }
});

// Shared by /api/subtitle, /api/stream and /api/download below — the only three routes that
// serve a *local, non-NAS* private-vault path (NAS-hosted files never have this prefix, they're
// nas://<node>/<file>). Kept here rather than in streamCore.js, which is deliberately permission-
// agnostic: its functions serve whatever path they're handed, so this check has to happen
// before calling into it, not inside it.
const checkPrivateVaultAccess = async (req, res, filePath) => {
    if (!filePath.startsWith(PRIVATE_ROOT)) return true;
    if (!db) await initDB();
    const mediaItem = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);
    if (mediaItem && mediaItem.is_private === 1 && req.user.role !== 'super_admin' && mediaItem.owner_username !== req.user.username) {
        res.status(403).send("Access Denied: User Private Vault");
        return false;
    }
    return true;
};

router.get('/api/subtitle', verifyToken, async (req, res) => {
    const { path: filePath, index } = req.query;
    if (!filePath || !index) return res.status(400).send("Missing params");

    if (!(await checkPrivateVaultAccess(req, res, filePath))) return;

    await streamSubtitle(req, res, filePath, index);
});

router.get('/api/stream', verifyToken, async (req, res) => {
    const { path: filePath } = req.query;

    if (filePath.startsWith(PRIVATE_ROOT)) {
        if (!db) await initDB();
        const mediaItem = await db.get("SELECT owner_username, is_private FROM media WHERE path = ?", filePath);

        if (mediaItem && mediaItem.is_private === 1) {
            if (req.user.role !== 'super_admin' && mediaItem.owner_username !== req.user.username) {
                console.log(`⛔ Access Denied: ${req.user.username} tried to access vault of ${mediaItem.owner_username}`);
                return res.status(403).send("Access Denied: User Private Vault");
            }
        }
    }

    await streamMediaFile(req, res, filePath, { username: req.user.username, role: req.user.role });
});

// Previously referenced by Poster.jsx's Download button (?path=&token=) with nothing on the
// server side to answer it — that button 404'd for every user, always. Added alongside the
// share-link download endpoint since both need the exact same downloadMediaFile logic.
router.get('/api/download', verifyToken, async (req, res) => {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).send("Path required");

    if (!(await checkPrivateVaultAccess(req, res, filePath))) return;

    if (!db) await initDB();
    const mediaItem = await db.get("SELECT filename FROM media WHERE path = ?", filePath);
    await downloadMediaFile(req, res, filePath, mediaItem?.filename);
});

// Explicit "I'm done" signal, sent via navigator.sendBeacon when CustomVideoPlayer.jsx
// unmounts — the close/error/finish listeners in streamCore.js only fire once the client's own
// TCP connection actually tears down, which iOS Safari doesn't reliably do the moment a custom
// (non-native) player closes, leaving a stream sitting here for hours (this app's own
// keep-alive timeout) with the viewer long gone. sendBeacon can't carry a custom Authorization
// header or set a JSON content-type reliably, so both sessionId and the token travel as query
// params — verifyToken already falls back to req.query.token for exactly this reason.
router.post('/api/stream/end', verifyToken, (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    for (const s of ACTIVE_STREAMS.values()) {
        // Scoped to the caller's own username, not just the (unguessable) sessionId alone —
        // matches the same defense-in-depth already used for remote-play's target check.
        if (s.sessionId === sessionId && s.username === req.user.username) {
            try { s.res.destroy(); } catch (e) {}
        }
    }
    res.json({ success: true });
});

// Defense-in-depth backstop for the leak fixed above — if some entry still somehow never
// receives close/error/finish (a genuinely wedged connection, not just a normal completion),
// this reclaims it instead of leaving it stuck on the dashboard forever. The threshold is
// deliberately generous: a legitimate slow connection delivering one range chunk shouldn't
// come anywhere near this long.
const STREAM_STALE_MS = 30 * 60 * 1000; // 30 minutes
const sweepStaleStreams = () => {
    const now = Date.now();
    for (const [streamId, s] of ACTIVE_STREAMS.entries()) {
        if (now - s.start > STREAM_STALE_MS) {
            if (s.command) { try { s.command.kill('SIGKILL'); } catch (e) {} }
            if (s.proxyRequest) { try { s.proxyRequest.destroy(); } catch (e) {} }
            // A plain local direct-play read has neither of the above — destroying the
            // response itself is what actually stops that pipe; deleting only the bookkeeping
            // entry below left it running, orphaned, with nothing left tracking it at all.
            try { s.res.destroy(); } catch (e) {}
            ACTIVE_STREAMS.delete(streamId);
        }
    }
};
export const startStreamStalenessSweep = () => setInterval(sweepStaleStreams, 5 * 60 * 1000);

export default router;

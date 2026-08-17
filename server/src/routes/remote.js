import express from 'express';
import { db, initDB } from '../db.js';
import { verifyToken } from '../middleware.js';
import { sendServerError } from '../logger.js';

const router = express.Router();

// How stale a "play on this device" command can be before it's no longer honored — guards
// against a command landing late (the target dropped offline right after it was sent) and
// then firing unexpectedly minutes later once that device finally polls again.
const COMMAND_MAX_AGE_MS = 5 * 60 * 1000;

router.post('/api/remote/play', verifyToken, async (req, res) => {
    const { targetToken, path: mediaPath, startTime } = req.body;
    if (!targetToken || !mediaPath) return res.status(400).json({ error: "targetToken and path are required" });

    try {
        if (!db) await initDB();

        // The target must be another currently-active session on the SAME account — this is
        // the only check standing between "cast to my own TV" and "cast to a stranger's
        // session," so it can't be skipped even though the token itself is already a secret.
        const target = await db.get("SELECT username FROM sessions WHERE token = ?", targetToken);
        if (!target || target.username !== req.user.username) {
            return res.status(403).json({ error: "That device isn't one of your active sessions." });
        }

        const media = await db.get("SELECT path FROM media WHERE path = ?", mediaPath);
        if (!media) return res.status(404).json({ error: "File not found" });

        await db.run(
            "INSERT INTO remote_commands (target_token, media_path, start_time, created_at, created_by_username, status) VALUES (?, ?, ?, ?, ?, 'pending')",
            [targetToken, mediaPath, startTime || 0, new Date().toISOString(), req.user.username]
        );

        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

// Polled by whichever device wants to know "has someone told me to play something" — both
// web_client and StreamPiTV call this from their own existing idle-screen poll loops. Marks
// the command delivered immediately (not "confirmed playing," just "handed off") since there's
// no ack channel back from actual playback starting, matching the honesty of every other
// polled-status field in this app (e.g. Telegram's queued/downloading column).
router.get('/api/remote/pending', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const token = req.headers.authorization?.split('Bearer ')[1] || req.query.token;

        const cutoff = new Date(Date.now() - COMMAND_MAX_AGE_MS).toISOString();
        const command = await db.get(
            "SELECT * FROM remote_commands WHERE target_token = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
            [token, cutoff]
        );

        if (!command) return res.json({ command: null });

        await db.run("UPDATE remote_commands SET status = 'delivered' WHERE id = ?", command.id);
        res.json({ command: { path: command.media_path, startTime: command.start_time } });
    } catch (e) { sendServerError(res, e); }
});

export default router;

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { db, initDB, logActivity } from '../db.js';
import { verifyToken } from '../middleware.js';
import { resolveShare, touchShare } from '../shareResolver.js';
import { expiryFromHours, isShareLive, LIVE_SHARE_SQL } from '../shareExpiry.js';
import { streamMediaFile, downloadMediaFile } from '../streamCore.js';
import { sendServerError } from '../logger.js';

const router = express.Router();

// --- Owner-side management (verifyToken) ---

router.post('/api/share', verifyToken, async (req, res) => {
    const { shareType, path: mediaPath, seriesName, expiresInHours } = req.body;

    // Optional, and omitting it means "never" — which is what every share created before this
    // existed already is, so the one-click share path in useLibraryActions keeps working unchanged.
    const expiry = expiryFromHours(expiresInHours);
    if (!expiry.ok) return res.status(400).json({ error: expiry.error });
    const expiresAt = expiry.expiresAt;
    const expiryNote = expiresAt ? ` (expires ${expiresAt})` : '';

    try {
        if (!db) await initDB();

        if (shareType === 'file') {
            if (!mediaPath) return res.status(400).json({ error: "Path required" });

            const item = await db.get("SELECT is_private FROM media WHERE path = ?", mediaPath);
            if (!item) return res.status(404).json({ error: "File not found" });
            // Sharing is deliberately not gated on ownership the way delete/rename are —
            // a public (non-vault) file is already visible to every account via /api/library,
            // and very often has no owner_username at all (only vault uploads get one). The
            // vault itself is the one hard line: never shareable, no exceptions.
            if (item.is_private === 1) return res.status(403).json({ error: "Private vault files can't be shared." });

            const token = crypto.randomUUID();
            await db.run(
                "INSERT INTO shares (token, share_type, media_path, owner_username, created_at, expires_at) VALUES (?, 'file', ?, ?, ?, ?)",
                [token, mediaPath, req.user.username, new Date().toISOString(), expiresAt]
            );
            await logActivity(req.user.username, "SHARE", `Created share link for ${path.basename(mediaPath)}${expiryNote}`, req.ip);
            return res.json({ success: true, token });
        }

        if (shareType === 'series') {
            if (!seriesName) return res.status(400).json({ error: "Series name required" });

            const row = await db.get("SELECT COUNT(*) as c FROM media WHERE series_name = ? AND is_private = 0", seriesName);
            if (!row || row.c === 0) return res.status(404).json({ error: "Series not found" });

            const token = crypto.randomUUID();
            await db.run(
                "INSERT INTO shares (token, share_type, series_name, owner_username, created_at, expires_at) VALUES (?, 'series', ?, ?, ?, ?)",
                [token, seriesName, req.user.username, new Date().toISOString(), expiresAt]
            );
            await logActivity(req.user.username, "SHARE", `Created share link for series "${seriesName}"${expiryNote}`, req.ip);
            return res.json({ success: true, token });
        }

        res.status(400).json({ error: "Invalid share type" });
    } catch (e) { sendServerError(res, e); }
});

router.get('/api/share/mine', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        // Filters expired rows as well as revoked ones. Without this a link that has already
        // stopped working keeps listing here as though it were live — the one read of `shares`
        // that needed changing when expires_at started being populated.
        const rows = await db.all(
            `SELECT * FROM shares WHERE owner_username = ? AND ${LIVE_SHARE_SQL} ORDER BY created_at DESC`,
            [req.user.username, new Date().toISOString()]
        );

        const shares = await Promise.all(rows.map(async (s) => {
            let title = s.series_name;
            if (s.share_type === 'file') {
                const media = await db.get("SELECT title, filename FROM media WHERE path = ?", s.media_path);
                title = media?.title || media?.filename || '(file no longer exists)';
            }
            return {
                token: s.token,
                shareType: s.share_type,
                title,
                createdAt: s.created_at,
                expiresAt: s.expires_at,
                viewCount: s.view_count,
                lastAccessedAt: s.last_accessed_at,
            };
        }));

        res.json({ shares });
    } catch (e) { sendServerError(res, e); }
});

router.delete('/api/share/:token', verifyToken, async (req, res) => {
    try {
        if (!db) await initDB();
        const share = await db.get("SELECT owner_username FROM shares WHERE token = ?", req.params.token);
        if (!share) return res.status(404).json({ error: "Share not found" });
        if (share.owner_username !== req.user.username && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: "Access Denied" });
        }
        await db.run("UPDATE shares SET revoked = 1 WHERE token = ?", req.params.token);
        res.json({ success: true });
    } catch (e) { sendServerError(res, e); }
});

/**
 * Set or clear the expiry on a share that already exists.
 *
 * This is what keeps creating a share a single click: handleShare posts and immediately shows the
 * link, and anyone who wants the link to be temporary sets that here afterwards, rather than every
 * share paying for a duration picker it usually doesn't need.
 *
 * Deliberately refuses to edit a share that has already expired. Reviving one would mean an
 * "expired" link isn't reliably dead, and /api/share/mine no longer lists them anyway — so the
 * honest move is to make a new link.
 */
router.patch('/api/share/:token', verifyToken, async (req, res) => {
    const expiry = expiryFromHours(req.body?.expiresInHours);
    if (!expiry.ok) return res.status(400).json({ error: expiry.error });

    try {
        if (!db) await initDB();
        const share = await db.get("SELECT owner_username, revoked, expires_at FROM shares WHERE token = ?", req.params.token);
        if (!share) return res.status(404).json({ error: "Share not found" });
        if (share.owner_username !== req.user.username && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: "Access Denied" });
        }
        if (!isShareLive(share)) return res.status(404).json({ error: "Share not found" });

        await db.run("UPDATE shares SET expires_at = ? WHERE token = ?", [expiry.expiresAt, req.params.token]);
        await logActivity(
            req.user.username,
            "SHARE_EXPIRY",
            expiry.expiresAt ? `Set share link to expire ${expiry.expiresAt}` : "Removed the expiry from a share link",
            req.ip
        );
        res.json({ success: true, expiresAt: expiry.expiresAt });
    } catch (e) { sendServerError(res, e); }
});

// --- Public viewer-side (no auth) ---

router.get('/api/share/:token/info', async (req, res) => {
    const result = await resolveShare(req.params.token);
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    await touchShare(req.params.token);

    if (result.type === 'file') {
        const m = result.media;
        return res.json({
            shareType: 'file',
            path: m.path,
            title: m.title || m.filename,
            poster: m.poster,
            duration: m.duration,
        });
    }

    res.json({
        shareType: 'series',
        seriesName: result.share.series_name,
        episodes: result.episodes.map(e => ({
            path: e.path, title: e.title, filename: e.filename, poster: e.poster,
            season: e.season, episode: e.episode, duration: e.duration, series_name: e.series_name,
        })),
    });
});

router.get('/api/share/:token/stream', async (req, res) => {
    const result = await resolveShare(req.params.token, req.query.path);
    if (!result.ok) return res.status(result.status).send(result.error);
    if (!result.media) return res.status(400).send("Path required for a series share");

    await streamMediaFile(req, res, result.media.path, {});
});

router.get('/api/share/:token/download', async (req, res) => {
    const result = await resolveShare(req.params.token, req.query.path);
    if (!result.ok) return res.status(result.status).send(result.error);
    if (!result.media) return res.status(400).send("Path required for a series share");

    await downloadMediaFile(req, res, result.media.path, result.media.filename);
});

// Series shares only — file shares have no "next", by design (a single-item grant shouldn't
// silently auto-advance into an episode that was never explicitly shared).
router.get('/api/share/:token/next', async (req, res) => {
    const result = await resolveShare(req.params.token, req.query.path);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.type !== 'series' || !result.media) return res.json({ next: null });

    const idx = result.episodes.findIndex(e => e.path === result.media.path);
    const next = idx >= 0 && idx + 1 < result.episodes.length ? result.episodes[idx + 1] : null;
    res.json({ next });
});

export default router;

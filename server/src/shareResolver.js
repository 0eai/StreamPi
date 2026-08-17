import { db, initDB } from './db.js';

/**
 * Resolve a public share token to whatever it grants access to.
 *
 * `{ ok: true, share, type: 'file'|'series', media?, path?, episodes? }` on success; on failure
 * `{ ok: false, status, error }` with a status the caller can return directly — same convention
 * as resolveNasFile (nasSource.js), so route handlers stay one-liners.
 *
 * A revoked or expired share reports the same 404 as one that never existed — confirming a
 * token *used to* work is its own small leak, not worth it for a link that's already dead.
 *
 * Series shares are resolved live (a fresh SELECT against `media`, not a snapshot taken at
 * creation time) so new episodes added later show up for anyone still holding the link, and so
 * there's no per-episode data to keep in sync when episodes are renamed/deleted/reprivatized.
 * `requestedPath` is required to pick one episode out of that list for stream/download/next —
 * a `file`-type share ignores it entirely and always resolves to its own single stored path,
 * which is what makes a stray or crafted `?path=` harmless against a file share.
 */
export const resolveShare = async (token, requestedPath = null) => {
    if (!db) await initDB();

    const share = await db.get("SELECT * FROM shares WHERE token = ?", token);
    if (!share) return { ok: false, status: 404, error: 'Link not found' };
    if (share.revoked) return { ok: false, status: 404, error: 'Link not found' };
    if (share.expires_at && new Date(share.expires_at) < new Date()) return { ok: false, status: 404, error: 'Link not found' };

    if (share.share_type === 'file') {
        const media = await db.get("SELECT * FROM media WHERE path = ?", share.media_path);
        if (!media) return { ok: false, status: 404, error: 'Link not found' };
        // Re-checked even though creation already blocks it — if the file was vaulted *after*
        // this share was made, the link needs to die too, not become a standing vault bypass.
        if (media.is_private === 1) return { ok: false, status: 404, error: 'Link not found' };
        return { ok: true, share, type: 'file', media, path: media.path };
    }

    if (share.share_type === 'series') {
        const episodes = await db.all(
            "SELECT * FROM media WHERE series_name = ? AND is_private = 0 ORDER BY season, episode",
            share.series_name
        );
        if (episodes.length === 0) return { ok: false, status: 404, error: 'Link not found' };

        if (requestedPath) {
            const media = episodes.find(e => e.path === requestedPath);
            if (!media) return { ok: false, status: 404, error: 'Episode not part of this share' };
            return { ok: true, share, type: 'series', media, path: media.path, episodes };
        }
        return { ok: true, share, type: 'series', episodes };
    }

    return { ok: false, status: 404, error: 'Link not found' };
};

/** Called once per page-load of a share (the /info route), not per stream/range request. */
export const touchShare = async (token) => {
    if (!db) await initDB();
    await db.run(
        "UPDATE shares SET view_count = view_count + 1, last_accessed_at = ? WHERE token = ?",
        [new Date().toISOString(), token]
    );
};

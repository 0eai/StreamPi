/**
 * Collapses a viewing into one WATCH activity entry instead of one per HTTP request.
 *
 * A `<video>` element does not make one request per film. It opens several range requests in parallel
 * to start playback, opens another on every seek, and re-opens as it rebuffers — so a single sitting
 * produced dozens of identical "Started watching" rows, in bursts of two or three seconds apart with
 * minutes between them. The activity log is meant to answer "who watched what", and at that volume it
 * answered nothing while burying every other kind of entry.
 *
 * The key of choice is the player's own `sessionId`, which streamCore already threads through for
 * /api/stream/end: CustomVideoPlayer mints one per player-open and sends it on every range request, so
 * it identifies exactly the thing being deduplicated. Clients that send none — StreamPiTV, or anything
 * hitting /api/stream directly — fall back to user-and-path, which is coarser: two devices signed in
 * as the same person watching the same file collapse into one entry. That is the right trade for a
 * fallback, since the alternative is the flood.
 *
 * The window slides on every request rather than expiring at a fixed point after the first. A film runs
 * far longer than any sensible window, so a fixed expiry would re-log every N minutes mid-viewing;
 * sliding means a continuous viewing logs once, however long it lasts, while genuinely coming back to
 * something after a real gap logs again — which is a distinct event and should.
 */

const WINDOW_MS = 10 * 60 * 1000;

// A bound, not a cap on correctness: exceeding it prunes what has expired, and if everything is still
// live the map simply grows. Concurrent viewers are the limit here, and this is a home media server.
const MAX_TRACKED = 1000;

const lastSeenAt = new Map();

/**
 * `filePath` rather than its basename, because two files in different directories can share a basename
 * and collapsing those would drop a real entry. A NUL joins the two halves since it cannot appear in
 * either — with a printable separator, a username or path containing it could be made to collide with
 * a different pair.
 */
export const watchLogKey = ({ sessionId, username, filePath }) =>
    sessionId ? `s:${sessionId}` : `u:${username}\u0000${filePath}`;

export const shouldLogWatch = (key, now = Date.now()) => {
    if (lastSeenAt.size >= MAX_TRACKED) {
        for (const [k, at] of lastSeenAt) {
            if (now - at >= WINDOW_MS) lastSeenAt.delete(k);
        }
    }

    const previous = lastSeenAt.get(key);
    lastSeenAt.set(key, now);
    return previous === undefined || now - previous >= WINDOW_MS;
};

// Test-only, so one case cannot leak state into the next through a module-level Map.
export const resetWatchLogThrottle = () => lastSeenAt.clear();

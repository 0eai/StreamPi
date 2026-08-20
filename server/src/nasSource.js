import { KNOWN_NAS_NODES } from './state.js';

// Archived media is stored as `nas://<nodeId>/<filename>` and has to be resolved to an HTTP
// URL on the owning node before anything can read it. Five routes did that resolution
// independently — /api/stream, /api/subtitle, the poster regenerator (routes/streaming.js),
// /api/media/info and the restore half of /api/media/nas-action (routes/media.js) — each
// re-parsing the path, re-building the same `/file/<name>` URL, and guarding with its own
// `if (!nasNode)`.
//
// That guard only asked whether the node was *registered*, never whether it was *reachable*.
// A node that is registered but offline (unplugged, rebooting, off the network) sailed past
// all five, so the failure surfaced from whatever ran next: axios threw and the client got a
// 502 "NAS Proxy Error" — after the player had already opened — while ffmpeg-based paths
// failed on the HTTP input and ffprobe simply timed out. Only an *unregistered* id produced
// the intended 503. Collapsing the resolution here means the reachability check happens once,
// by construction, and every one of those routes answers 503 before doing any work.

/**
 * How stale a node's last successful health probe may be before it counts as unavailable.
 *
 * Deliberately not gated on `isReachable` alone. checkNasHealth (nodeDiscovery.js) polls each
 * node's /stats every 2s with a 2s timeout, so a node busy serving several streams can miss a
 * probe or two while still serving files perfectly well. Refusing playback on a single missed
 * tick would turn "briefly slow" into "unavailable" — worse than the 502 this replaces. A few
 * missed probes in a row is a genuine outage; one is noise.
 */
export const NAS_AVAILABILITY_GRACE_MS = 15_000;

export const isNasPath = (p) => typeof p === 'string' && p.startsWith('nas://');

/**
 * `nas://<nodeId>/<filename>` -> `{ nodeId, filename }`, or null if either part is missing.
 * The filename keeps any interior slashes: nothing creates nested paths on a node today, but
 * splitting on only the first separator is what the callers this replaces all did.
 */
export const parseNasPath = (p) => {
    if (!isNasPath(p)) return null;
    const parts = p.slice('nas://'.length).split('/');
    const nodeId = parts[0];
    const filename = parts.slice(1).join('/');
    if (!nodeId || !filename) return null;
    return { nodeId, filename };
};

/** Reachable now, or reachable recently enough — see NAS_AVAILABILITY_GRACE_MS. */
export const isNasNodeAvailable = (node, now = Date.now()) => {
    if (!node) return false;
    if (node.isReachable) return true;
    return node.lastSeen > 0 && (now - node.lastSeen) < NAS_AVAILABILITY_GRACE_MS;
};

/**
 * Resolve an archived path to a fetchable URL on its node.
 *
 * `{ ok: true, nodeId, filename, node, url, apiKey }` on success; on failure
 * `{ ok: false, status, error }` with a status the caller can return directly. Callers format
 * the credential themselves because the consumers differ — axios wants a headers object,
 * ffmpeg's `-headers` wants `Authorization: Bearer …` with **no** trailing CRLF — that separator
 * belongs *between* headers, and appending it to the last one leaves a bare CR inside the value that
 * a strict HTTP parser answers with 400. ffprobe is handed the same as an execFile argument.
 */
export const resolveNasFile = (p) => {
    const parsed = parseNasPath(p);
    if (!parsed) return { ok: false, status: 404, error: 'Invalid NAS path on record' };

    const node = KNOWN_NAS_NODES.get(parsed.nodeId);
    if (!node) return { ok: false, status: 503, error: 'NAS node is not registered' };
    if (!isNasNodeAvailable(node)) return { ok: false, status: 503, error: 'NAS node is offline' };

    return {
        ok: true,
        nodeId: parsed.nodeId,
        filename: parsed.filename,
        node,
        url: `${node.url}/file/${encodeURIComponent(parsed.filename)}`,
        apiKey: node.apiKey,
    };
};

/**
 * Stamp a media row with whether it can be streamed right now, so a client can say so before
 * the user presses play rather than discovering it from a failed request. Rows on local disk
 * are returned untouched — the fields are absent rather than true, which lets a client tell
 * "not archived" apart from "archived and up".
 */
export const withNasAvailability = (row) => {
    const parsed = parseNasPath(row?.path);
    if (!parsed) return row;
    return {
        ...row,
        nas_node_id: parsed.nodeId,
        nas_available: isNasNodeAvailable(KNOWN_NAS_NODES.get(parsed.nodeId)),
    };
};

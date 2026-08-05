import { useState } from 'react';
import { apiFetch } from './api';
import { usePolling } from './usePolling';

// Two sources of truth for "can this archived item be played", used in order of freshness:
//
//  1. `availableNodeIds` — polled from /api/nas/availability, so it stays current while the
//     page is open. This is the one that matters: /api/library is fetched once per page load
//     (useLibraryActions), so without a poll a tab left open while a node went down would keep
//     showing its items as playable.
//  2. `item.nas_available` — stamped onto the row by /api/library (server/src/nasSource.js).
//     Correct as of that fetch, and the fallback for the first render before the poll answers,
//     or against a server too old to have the endpoint.
//
// Both are checked so that a missing signal never reads as unavailable: a locally-stored row
// has no nas_node_id at all, and an older server sends neither field.
export const isNasOffline = (item, availableNodeIds = null) => {
    if (!item) return false;
    if (availableNodeIds && item.nas_node_id) return !availableNodeIds.has(item.nas_node_id);
    return item.nas_available === false;
};

export const nasOfflineMessage = (item) => {
    const label = (item?.title || item?.filename || 'This item').trim();
    const node = item?.nas_node_id ? `NAS node "${item.nas_node_id}"` : 'its NAS node';
    return `${label} is stored on ${node}, which is currently offline.\n\n`
        + `Bring the node back online to watch or restore it.`;
};

const POLL_MS = 10_000;
const TRANSFER_POLL_MS = 1_500;

/**
 * Returns a Set of reachable NAS node ids, or null while unknown — the caller must treat null
 * as "fall back to the row's own flag", never as "nothing is available".
 *
 * Null is also the resting state on a server without the endpoint: a 404 throws here, which
 * usePolling counts as a failed tick and backs off, and the set stays null so every archived
 * item keeps whatever /api/library said.
 */
export const useNasAvailability = (serverUrl, token) => {
    const [availableNodeIds, setAvailableNodeIds] = useState(null);

    usePolling(async () => {
        if (!token) return;
        const res = await apiFetch(serverUrl, '/api/nas/availability', token);
        if (!res.ok) throw new Error(`nas availability failed: ${res.status}`);
        const data = await res.json();
        setAvailableNodeIds(new Set(data.available || []));
    }, POLL_MS, [serverUrl, token]);

    return availableNodeIds;
};

/**
 * Live progress for archive/restore transfers currently in flight, keyed by filename.
 *
 * The nas-action request itself blocks until the whole transfer finishes, so it can never
 * report progress — this polls /api/nas/jobs (the same node-reported byte counters the admin
 * dashboard already shows) in parallel, only while `activeFilenames` is non-empty. Matching by
 * filename alone, same as the node's own job tracking, since nothing ties a job back to a
 * specific /api/media/nas-action call.
 *
 * `activeFilenames` only needs to change identity for the polling loop itself to start/stop —
 * usePolling reads the latest closure on every tick regardless of its deps array, so a filename
 * being added or removed mid-poll is picked up on the very next tick without restarting it.
 */
export const useNasTransferProgress = (serverUrl, token, activeFilenames) => {
    const [jobsByFilename, setJobsByFilename] = useState({});
    const hasActive = activeFilenames.length > 0;

    usePolling(async () => {
        if (!token || !hasActive) { setJobsByFilename({}); return; }
        const res = await apiFetch(serverUrl, '/api/nas/jobs', token);
        if (!res.ok) throw new Error(`nas jobs failed: ${res.status}`);
        const data = await res.json();
        const next = {};
        for (const job of data.jobs || []) next[job.filename] = job;
        setJobsByFilename(next);
    }, TRANSFER_POLL_MS, [serverUrl, token, hasActive]);

    return jobsByFilename;
};

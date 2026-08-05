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

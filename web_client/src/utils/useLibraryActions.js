import { useState, useEffect, useRef } from 'react';
import { apiFetch, parseJsonSafe } from './api';
import { useNasTransferProgress } from './nas';
import { usePolling } from './usePolling';
import { useDialogs } from '../components/ui/dialogs';
import { useToast } from '../components/ui/toast';
import { formatBytes } from './format';

const EMPTY_LIBRARY = { continueWatching: [], movies: [], series: [] };

// Sentinel for "let the server choose", which is what offloading did before a destination could be
// picked. Deliberately not '' — choose() resolves null on a dismissal, and a falsy option value could
// not be told apart from one.
const AUTO_NAS_NODE = 'auto';

// Long, because /api/library is the whole collection and it changes rarely — this exists so another
// person's upload appears on its own, not to make the view feel live.
const LIBRARY_POLL_MS = 45000;
// Explicit because usePolling's default ceiling is 30s, which is *below* the base above and would
// leave this with no backoff at all. A server that has gone away should be asked every five minutes,
// not every forty-five seconds.
const LIBRARY_POLL_BACKOFF_MAX_MS = 5 * 60 * 1000;

// A move's own fetch is what clears movingFilenames in the common case — but that promise (and
// the plain React state it resolves into) lives only in this tab's JS context, so a refresh
// mid-transfer wipes both, even though the transfer itself is running server/node-side and
// couldn't care less whether this tab reloaded. Persisting the in-flight filename here lets a
// fresh page load resume polling for it instead of just silently losing track of it.
const MOVING_FILES_KEY = 'streampi_moving_files';
const loadMovingFilenames = () => {
    try { return JSON.parse(localStorage.getItem(MOVING_FILES_KEY)) || []; } catch { return []; }
};

// A resumed (or freshly started) entry has no job yet the instant we start watching it — curl/
// multer need a beat to actually begin — so "missing from /api/nas/jobs" only counts as
// "finished" once it's been missing for longer than one real setup delay, not on the first poll.
const MOVE_GRACE_MS = 5000;

// Peeled off StreamApp.jsx — owns the library data itself plus every CRUD action on it
// (delete/rename/move/toggle-privacy), all of which just re-fetch afterward. `onUnauthorized`
// is called instead of directly handling logout, since that's session-level state this hook
// has no business owning.
export const useLibraryActions = (token, serverUrl, onUnauthorized, { paused = false } = {}) => {
    // This is a hook, so it reaches the dialog/toast providers directly rather than having them
    // threaded down through every component that calls one of these actions.
    const { confirm, prompt, choose } = useDialogs();
    const toast = useToast();

    const [library, setLibrary] = useState(EMPTY_LIBRARY);
    const [loadError, setLoadError] = useState(false);
    const [loading, setLoading] = useState(false);
    const [selectedSeries, setSelectedSeries] = useState(null);
    const [shareLink, setShareLink] = useState(null); // { url, label } | null — feeds ShareModal
    const [movingFilenames, setMovingFilenames] = useState(loadMovingFilenames);
    // When we started (or resumed) watching each filename — render-time, not an effect, since
    // it just needs to seed any name that doesn't have one yet, including ones resumed from
    // localStorage on the very first render.
    const movingSinceRef = useRef({});
    for (const f of movingFilenames) {
        if (!(f in movingSinceRef.current)) movingSinceRef.current[f] = Date.now();
    }

    const transferJobs = useNasTransferProgress(serverUrl, token, movingFilenames);
    // Filenames currently mid-move, each with whatever percent the node has reported so far —
    // 0 until the first poll tick lands one, rather than undefined, so a click shows progress
    // starting immediately instead of a beat of nothing.
    const moveStatus = {};
    for (const f of movingFilenames) moveStatus[f] = transferJobs[f]?.percent ?? 0;

    useEffect(() => {
        localStorage.setItem(MOVING_FILES_KEY, JSON.stringify(movingFilenames));
    }, [movingFilenames]);

    // The only completion signal a resumed entry has left, since its original fetch (and the
    // tab that was awaiting it) may be long gone — once a tracked filename stops appearing in
    // the node's own job list, treat the transfer as over (succeeded or failed either way) and
    // resync the library to find out which. Harmless no-op for the common case too, where
    // handleMove's own finally-block below has usually already cleared it by the time this runs.
    useEffect(() => {
        const done = movingFilenames.filter(f =>
            !(f in transferJobs) && Date.now() - (movingSinceRef.current[f] || 0) > MOVE_GRACE_MS
        );
        if (done.length === 0) return;
        done.forEach(f => delete movingSinceRef.current[f]);
        setMovingFilenames(prev => prev.filter(f => !done.includes(f)));
        fetchData(token);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transferJobs]);

    // Deliberately not wrapped in useCallback with a dependency array — this closes over the
    // current `library` on every render (needed for the `movies.length === 0` check below),
    // and the effect underneath only ever wants "whichever fetchData exists on the render
    // where token changed," not a memoized identity. Matches the original component's exact
    // behavior before this hook existed.
    const fetchData = async (t, { background = false } = {}) => {
        // A background refresh must not flash the spinner. The empty-library guard alone is not
        // enough: on a genuinely empty library every poll would satisfy it and the screen would blink
        // between "loading" and "no movies found" forever.
        if (!background && library.movies.length === 0) setLoading(true);
        try {
            const libRes = await apiFetch(serverUrl, '/api/library', t);

            if (libRes.status === 401) {
                onUnauthorized();
                setLoading(false);
                return;
            }

            // A failed request previously fell straight to the catch below, which only
            // logged to console — the library stayed at its default empty shape and the UI
            // showed "No movies found. Upload one!", indistinguishable from a genuinely empty
            // library. The most realistic trigger for this is also the most confusing one:
            // the server restarting right as the page loads.
            if (!libRes.ok) throw new Error(`Library request failed: ${libRes.status}`);

            const data = await libRes.json();

            data.movies.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
            data.series.forEach(s => {
                const latest = s.episodes.reduce((max, ep) => {
                    const current = new Date(ep.created_at || 0);
                    return current > max ? current : max;
                }, new Date(0));
                s.latest_created_at = latest;
            });
            data.series.sort((a, b) => b.latest_created_at - a.latest_created_at);
            setLibrary(data);
            setLoadError(false);

            setSelectedSeries(prev => {
                if (!prev) return prev;
                // Only close the view if the series no longer exists (e.g. last episode deleted)
                return data.series.find(s => s.title === prev.title) || null;
            });
        } catch (e) {
            console.error("Fetch Error:", e);
            setLoadError(true);
            // usePolling decides its backoff from a rejection, so a polled call has to rethrow. The
            // handlers that call this directly do not catch, hence only on the background path.
            if (background) { setLoading(false); throw e; }
        }
        setLoading(false);
    };

    /**
     * The library used to be fetched exactly once, when the token appeared. Every other refresh was
     * triggered by something *this* user did — a delete, a rename, a move, an upload finishing, the
     * player closing — so anything another person added stayed invisible until you happened to act or
     * reloaded the page. On a shared library that is most of the time.
     *
     * 45s rather than the 2s the admin dashboard uses: /api/library returns the whole collection with
     * every episode, and it changes on the order of minutes at best. `paused` stops it during playback,
     * where a refresh buys nothing and competes with the stream for the same connection.
     *
     * usePolling ticks immediately on mount, so it owns the initial load too — hence firstLoadRef,
     * which lets exactly that first tick show the spinner. It also re-ticks whenever `paused` flips
     * back, which conveniently means closing the player refreshes right away instead of waiting out
     * the interval.
     */
    const firstLoadRef = useRef(true);
    const libraryOffline = usePolling(async () => {
        if (!token || paused) return;
        const background = !firstLoadRef.current;
        firstLoadRef.current = false;
        await fetchData(token, { background });
    }, LIBRARY_POLL_MS, [token, paused], { maxIntervalMs: LIBRARY_POLL_BACKOFF_MAX_MS });

    const resetLibrary = () => { setLibrary(EMPTY_LIBRARY); setSelectedSeries(null); };

    const handleDelete = async (item) => {
        if (!await confirm(`Delete "${item.title || item.filename}" permanently from disk?`)) return;
        try {
            const res = await apiFetch(serverUrl, '/api/media', token, { method: 'DELETE', json: { path: item.path } });
            if (!res.ok) {
                const data = await parseJsonSafe(res);
                toast.error(`Delete failed: ${data.error || res.statusText}`);
                return;
            }
            fetchData(token);
        } catch(e) { toast.error("Delete failed: " + e.message); }
    };

    const handleDeleteSeries = async (item) => {
        const seriesName = item.series_name || item.title;
        if (!await confirm(`Delete ALL ${item.episodes?.length || ''} episodes of "${seriesName}" permanently from disk?`)) return;
        try {
            const res = await apiFetch(serverUrl, `/api/series/${encodeURIComponent(seriesName)}`, token, { method: 'DELETE' });
            const data = await parseJsonSafe(res);
            if (!res.ok) {
                toast.error(`Delete failed: ${data.error || res.statusText}`);
                return;
            }
            if (data.skipped > 0) {
                toast.info(`Deleted ${data.deleted} episode(s). ${data.skipped} could not be deleted (not owned by you).`);
            }
            fetchData(token);
        } catch(e) { toast.error("Delete failed: " + e.message); }
    };

    const handleRenameMovie = async (item) => {
        const newTitle = await prompt({ title: 'Rename', label: 'Title', value: item.title || item.filename });
        if (!newTitle || !newTitle.trim() || newTitle.trim() === item.title) return;
        try {
            const res = await apiFetch(serverUrl, '/api/media/title', token, { method: 'PATCH', json: { path: item.path, title: newTitle.trim() } });
            const data = await parseJsonSafe(res);
            if (!res.ok) {
                toast.error(`Rename failed: ${data.error || res.statusText}`);
                return;
            }
            fetchData(token);
        } catch(e) { toast.error("Rename failed: " + e.message); }
    };

    const handleRenameSeries = async (item) => {
        const seriesName = item.series_name || item.title;
        const newName = await prompt({ title: 'Rename series', label: 'Series name', value: seriesName });
        if (!newName || !newName.trim() || newName.trim() === seriesName) return;
        try {
            const res = await apiFetch(serverUrl, `/api/series/${encodeURIComponent(seriesName)}`, token, { method: 'PATCH', json: { newName: newName.trim() } });
            const data = await parseJsonSafe(res);
            if (!res.ok) {
                toast.error(`Rename failed: ${data.error || res.statusText}`);
                return;
            }
            if (data.skipped > 0) {
                toast.info(`Renamed ${data.renamed} episode(s). ${data.skipped} could not be renamed (not owned by you).`);
            }
            fetchData(token);
        } catch(e) { toast.error("Rename failed: " + e.message); }
    };

    // --- MOVE LOGIC ---
    const handleMove = async (item) => {
        const action = item.is_archived ? 'restore' : 'archive';
        const label = item.title || item.filename;
        let nodeId = null;

        if (action === 'restore') {
            if (!await confirm(`Restore from NAS to Main Storage for "${label}"?`)) return;
        } else {
            // Fetched at the moment of the choice rather than kept in state: both of the things this
            // list reports — whether a node is reachable, and how much room it has left — move on
            // their own, and most library sessions never offload anything at all.
            let nodes;
            try {
                const res = await apiFetch(serverUrl, '/api/upload/nas-nodes', token);
                nodes = await parseJsonSafe(res);
                if (!res.ok) throw new Error(nodes.error || res.statusText);
            } catch (e) {
                toast.error(`Could not list NAS nodes: ${e.message}`);
                return;
            }

            // The server would refuse this anyway, but saying so before the confirmation is the
            // difference between an explanation and a failed action.
            if (!Array.isArray(nodes) || nodes.length === 0) {
                toast.error('No NAS node is reachable right now.');
                return;
            }

            // AUTO keeps the previous behaviour as the default — the server picks the emptiest node —
            // so choosing a destination is available without being a step. It must be truthy: choose()
            // resolves null for a dismissal, and an empty value would be indistinguishable from one.
            const choice = await choose({
                title: 'Offload to NAS Storage',
                message: `Move "${label}" off main storage?`,
                label: 'Destination',
                confirmLabel: 'Offload',
                options: [
                    { value: AUTO_NAS_NODE, label: 'Automatic — node with the most free space' },
                    ...nodes.map(n => ({ value: n.id, label: `${n.name} — ${formatBytes(n.free)} free` })),
                ],
            });
            if (!choice) return;
            if (choice !== AUTO_NAS_NODE) nodeId = choice;
        }

        // Explicit reset, not just the render-time seed above — a filename moved once before
        // (archived, then later restored) already has a stale timestamp in the ref, which
        // would otherwise make this new move look instantly overdue to the grace check.
        movingSinceRef.current[item.filename] = Date.now();
        setMovingFilenames(prev => [...prev, item.filename]);

        try {
            const res = await apiFetch(serverUrl, '/api/media/nas-action', token, {
                method: 'POST',
                json: { path: item.path, action, ...(nodeId ? { nodeId } : {}) },
            });

            if (res.ok) {
                const result = await res.json();

                const updateItemInList = (list) => list.map(i =>
                    i.path === item.path ? { ...i, is_archived: action === 'archive' ? 1 : 0, path: result.newPath } : i
                );

                setLibrary(prev => ({
                    continueWatching: updateItemInList(prev.continueWatching),
                    movies: updateItemInList(prev.movies),
                    series: prev.series.map(s => ({
                        ...s,
                        episodes: updateItemInList(s.episodes)
                    }))
                }));

                setSelectedSeries(prev => prev ? ({
                    ...prev,
                    episodes: updateItemInList(prev.episodes)
                }) : prev);

                // Also fetch fresh data to be safe
                fetchData(token);
                toast.success(result.message || "Done");
            } else {
                const err = await res.json();
                toast.error(`Move failed: ${err.error}`);
            }
        } catch (e) { toast.error("Move failed"); }
        finally {
            delete movingSinceRef.current[item.filename];
            setMovingFilenames(prev => prev.filter(f => f !== item.filename));
        }
    };

    // --- SHARE LOGIC ---
    // A series-summary card (StreamApp builds { title, series_name, episodes, poster } for
    // those, with no `path` of its own) shares as a whole series; anything with a `path`
    // (a movie, a continue-watching item, or a per-episode row) shares as that one file.
    const handleShare = async (item) => {
        const isSeries = !item.path;
        const body = isSeries
            ? { shareType: 'series', seriesName: item.series_name || item.title }
            : { shareType: 'file', path: item.path };

        try {
            const res = await apiFetch(serverUrl, '/api/share', token, { method: 'POST', json: body });
            const data = await parseJsonSafe(res);
            if (!res.ok) { toast.error(`Share failed: ${data.error || res.statusText}`); return; }
            setShareLink({ url: `${window.location.origin}/share/${data.token}`, label: item.title || item.series_name });
        } catch (e) { toast.error("Share failed: " + e.message); }
    };

    const handleTogglePrivacy = async (item) => {
        const actionText = item.is_private ? "Unlock (Make Public)" : "Lock (Move to Private Vault)";
        if (!await confirm(`${actionText} for "${item.title || item.filename}"? This will physically move the file.`)) return;

        try {
            const res = await apiFetch(serverUrl, '/api/media/toggle-privacy', token, { method: 'POST', json: { path: item.path } });

            if (res.ok) {
                const result = await res.json();

                const updateItemInList = (list) => list.map(i =>
                    i.path === item.path ? { ...i, is_private: result.isPrivate ? 1 : 0, path: result.newPath } : i
                );

                setLibrary(prev => ({
                    continueWatching: updateItemInList(prev.continueWatching),
                    movies: updateItemInList(prev.movies),
                    series: prev.series.map(s => ({
                        ...s,
                        episodes: updateItemInList(s.episodes)
                    }))
                }));

                setSelectedSeries(prev => prev ? ({
                    ...prev,
                    episodes: updateItemInList(prev.episodes)
                }) : prev);

                toast.success("Privacy updated");
            } else {
                const err = await res.json();
                toast.error(`Error: ${err.error}`);
            }
        } catch (e) { console.error(e); toast.error("Failed to toggle privacy"); }
    };

    return {
        library, loadError, loading, selectedSeries, setSelectedSeries,
        fetchData, resetLibrary, moveStatus, shareLink, setShareLink, libraryOffline,
        handleDelete, handleDeleteSeries, handleRenameMovie, handleRenameSeries, handleMove, handleTogglePrivacy, handleShare
    };
};

import { useState, useEffect } from 'react';
import { apiFetch, parseJsonSafe } from './api';

const EMPTY_LIBRARY = { continueWatching: [], movies: [], series: [] };

// Peeled off StreamApp.jsx — owns the library data itself plus every CRUD action on it
// (delete/rename/move/toggle-privacy), all of which just re-fetch afterward. `onUnauthorized`
// is called instead of directly handling logout, since that's session-level state this hook
// has no business owning.
export const useLibraryActions = (token, serverUrl, onUnauthorized) => {
    const [library, setLibrary] = useState(EMPTY_LIBRARY);
    const [loadError, setLoadError] = useState(false);
    const [loading, setLoading] = useState(false);
    const [selectedSeries, setSelectedSeries] = useState(null);

    // Deliberately not wrapped in useCallback with a dependency array — this closes over the
    // current `library` on every render (needed for the `movies.length === 0` check below),
    // and the effect underneath only ever wants "whichever fetchData exists on the render
    // where token changed," not a memoized identity. Matches the original component's exact
    // behavior before this hook existed.
    const fetchData = async (t) => {
        if (library.movies.length === 0) setLoading(true);
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
        }
        setLoading(false);
    };

    useEffect(() => {
        if (token) fetchData(token);
    }, [token]);

    const resetLibrary = () => { setLibrary(EMPTY_LIBRARY); setSelectedSeries(null); };

    const handleDelete = async (item) => {
        if (!confirm(`Delete "${item.title || item.filename}" permanently from disk?`)) return;
        try {
            const res = await apiFetch(serverUrl, '/api/media', token, { method: 'DELETE', json: { path: item.path } });
            if (!res.ok) {
                const data = await parseJsonSafe(res);
                alert(`Delete failed: ${data.error || res.statusText}`);
                return;
            }
            fetchData(token);
        } catch(e) { alert("Delete failed: " + e.message); }
    };

    const handleDeleteSeries = async (item) => {
        const seriesName = item.series_name || item.title;
        if (!confirm(`Delete ALL ${item.episodes?.length || ''} episodes of "${seriesName}" permanently from disk?`)) return;
        try {
            const res = await apiFetch(serverUrl, `/api/series/${encodeURIComponent(seriesName)}`, token, { method: 'DELETE' });
            const data = await parseJsonSafe(res);
            if (!res.ok) {
                alert(`Delete failed: ${data.error || res.statusText}`);
                return;
            }
            if (data.skipped > 0) {
                alert(`Deleted ${data.deleted} episode(s). ${data.skipped} could not be deleted (not owned by you).`);
            }
            fetchData(token);
        } catch(e) { alert("Delete failed: " + e.message); }
    };

    const handleRenameMovie = async (item) => {
        const newTitle = prompt("Enter new title:", item.title || item.filename);
        if (!newTitle || !newTitle.trim() || newTitle.trim() === item.title) return;
        try {
            const res = await apiFetch(serverUrl, '/api/media/title', token, { method: 'PATCH', json: { path: item.path, title: newTitle.trim() } });
            const data = await parseJsonSafe(res);
            if (!res.ok) {
                alert(`Rename failed: ${data.error || res.statusText}`);
                return;
            }
            fetchData(token);
        } catch(e) { alert("Rename failed: " + e.message); }
    };

    const handleRenameSeries = async (item) => {
        const seriesName = item.series_name || item.title;
        const newName = prompt("Enter new series name:", seriesName);
        if (!newName || !newName.trim() || newName.trim() === seriesName) return;
        try {
            const res = await apiFetch(serverUrl, `/api/series/${encodeURIComponent(seriesName)}`, token, { method: 'PATCH', json: { newName: newName.trim() } });
            const data = await parseJsonSafe(res);
            if (!res.ok) {
                alert(`Rename failed: ${data.error || res.statusText}`);
                return;
            }
            if (data.skipped > 0) {
                alert(`Renamed ${data.renamed} episode(s). ${data.skipped} could not be renamed (not owned by you).`);
            }
            fetchData(token);
        } catch(e) { alert("Rename failed: " + e.message); }
    };

    // --- MOVE LOGIC ---
    const handleMove = async (item) => {
        const action = item.is_archived ? 'restore' : 'archive';

        const actionText = item.is_archived
            ? 'Restore from NAS to Main Storage'
            : 'Offload to NAS Storage';

        if (!confirm(`${actionText} for "${item.title || item.filename}"? This might take a moment.`)) return;

        try {
            const res = await apiFetch(serverUrl, '/api/media/nas-action', token, { method: 'POST', json: { path: item.path, action } });

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
                alert(result.message || "Operation successful"); // Optional feedback
            } else {
                const err = await res.json();
                alert(`Move failed: ${err.error}`);
            }
        } catch (e) { alert("Move failed"); }
    };

    const handleTogglePrivacy = async (item) => {
        const actionText = item.is_private ? "Unlock (Make Public)" : "Lock (Move to Private Vault)";
        if (!confirm(`${actionText} for "${item.title || item.filename}"? This will physically move the file.`)) return;

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

                alert("Privacy toggled successfully");
            } else {
                const err = await res.json();
                alert(`Error: ${err.error}`);
            }
        } catch (e) { console.error(e); alert("Failed to toggle privacy"); }
    };

    return {
        library, loadError, loading, selectedSeries, setSelectedSeries,
        fetchData, resetLibrary,
        handleDelete, handleDeleteSeries, handleRenameMovie, handleRenameSeries, handleMove, handleTogglePrivacy
    };
};

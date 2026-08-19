import { useState, useRef, useCallback } from 'react';
import { randomId } from './randomId';

/**
 * Owns the upload queue and the raw XHR behind it. XHR rather than fetch for one reason only:
 * upload progress, which fetch still cannot report.
 *
 * Serves two kinds of upload. `kind: 'media'` (the default) posts to /api/upload with the library's
 * field shape; `kind: 'file'` posts to /api/files/upload with an opaque parentId. They share this
 * queue deliberately — one place tracks in-flight uploads, one abortAll covers both on logout, and
 * there is one progress widget rather than two fighting over the same corner.
 */

/**
 * Three at a time.
 *
 * Previously every item started at once. A browser caps its own connections per origin so that did
 * not flood the network, but 400 selected files meant 400 XHRs, 400 rows re-rendering, and an O(n)
 * state copy on every progress event of every one — plus, on the server, a `df` subprocess and an
 * activity-log insert per request. Folder upload makes 400 files an ordinary case rather than an
 * abusive one.
 */
const MAX_CONCURRENT = 3;

const buildFormData = (item) => {
    const formData = new FormData();

    if (item.kind === 'file') {
        // No ordering constraint here, unlike the media branch: the file route reads req.body only
        // once its handler runs, so the field order is free.
        if (item.parentId) formData.append('parentId', item.parentId);
        formData.append('name', item.name || item.file.name);
        formData.append('file', item.file);
        return formData;
    }

    // destination/nodeId MUST be appended before the files field — multer's storage engine
    // (uploadMiddleware.js) needs them in req.body before it starts handling the file stream, and
    // busboy/multer populate req.body in multipart part order.
    formData.append('destination', item.destination || 'main');
    if (item.nodeId) formData.append('nodeId', item.nodeId);
    formData.append('files', item.file);
    formData.append('type', item.type);
    formData.append('isPrivate', item.isPrivate);
    if (item.title) formData.append('title', item.title);
    if (item.type === 'series') {
        formData.append('seriesName', item.seriesName);
        formData.append('season', item.season);
        formData.append('episode', item.episode);
    }
    return formData;
};

const endpointFor = (item) => (item.kind === 'file' ? '/api/files/upload' : '/api/upload');

/** Reads whatever the server said, so a 413 or a quota rejection reaches the person who caused it. */
const errorFromXhr = (xhr) => {
    try {
        const parsed = JSON.parse(xhr.responseText);
        if (parsed?.error) return parsed.error;
    } catch { /* not JSON — a proxy page, or plain text from the multer error handler */ }
    if (xhr.responseText && xhr.responseText.length < 200) return xhr.responseText;
    return `Upload failed (${xhr.status || 'no response'})`;
};

export const useUploads = (token, serverUrl, onUploadComplete) => {
    const [uploads, setUploads] = useState([]);
    // Tracked so an in-flight upload can be aborted on logout — previously it kept running with a
    // now-invalidated token, whose only effect was a pointless extra 401 once it finished.
    const activeXhrsRef = useRef(new Map());
    const queueRef = useRef([]);
    const runningRef = useRef(0);

    const patch = useCallback((id, changes) => {
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...changes } : u)));
    }, []);

    // Declared before use via a ref because start() and pump() call each other; a plain const would
    // capture an undefined pump on the first render.
    const pumpRef = useRef(null);

    const start = useCallback((item, authToken) => {
        runningRef.current += 1;
        patch(item.id, { status: 'uploading', error: null });

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${serverUrl}${endpointFor(item)}`);
        xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        activeXhrsRef.current.set(item.id, xhr);

        const settle = () => {
            activeXhrsRef.current.delete(item.id);
            runningRef.current -= 1;
            pumpRef.current?.(authToken);
        };

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) patch(item.id, { progress: (e.loaded / e.total) * 100 });
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                patch(item.id, { status: 'done', progress: 100 });
                onUploadComplete?.(authToken, item);
            } else {
                patch(item.id, { status: 'error', error: errorFromXhr(xhr) });
            }
            settle();
        };
        xhr.onerror = () => { patch(item.id, { status: 'error', error: 'Network error' }); settle(); };
        // An abort is not a failure to report — abortAll happens on logout, when the UI is going away.
        xhr.onabort = () => { activeXhrsRef.current.delete(item.id); runningRef.current -= 1; };

        xhr.send(buildFormData(item));
    }, [serverUrl, onUploadComplete, patch]);

    const pump = useCallback((authToken) => {
        while (runningRef.current < MAX_CONCURRENT && queueRef.current.length) {
            start(queueRef.current.shift(), authToken);
        }
    }, [start]);
    pumpRef.current = pump;

    const handleStartUpload = useCallback((uploadItems) => {
        const queued = uploadItems.map((item) => ({
            id: randomId(),
            ...item,
            progress: 0,
            status: 'pending',
            error: null,
        }));
        setUploads((prev) => [...prev, ...queued]);
        queueRef.current.push(...queued);
        pump(token);
    }, [pump, token]);

    const removeUpload = useCallback((id) => {
        queueRef.current = queueRef.current.filter((u) => u.id !== id);
        setUploads((prev) => prev.filter((u) => u.id !== id));
    }, []);

    const clearCompletedUploads = useCallback(() => {
        setUploads((prev) => prev.filter((u) => u.status !== 'done' && u.status !== 'error'));
    }, []);

    const retryUpload = useCallback((id) => {
        setUploads((prev) => {
            const item = prev.find((u) => u.id === id);
            if (item) {
                queueRef.current.push({ ...item, status: 'pending', progress: 0, error: null });
                // Queued from inside the updater, but pumped after — starting an upload mid-update
                // would re-enter setUploads while React is already applying one.
                setTimeout(() => pump(token), 0);
            }
            return prev.map((u) => (u.id === id ? { ...u, status: 'pending', progress: 0, error: null } : u));
        });
    }, [pump, token]);

    /** Cancels one upload that hasn't finished — queued or in flight. */
    const cancelUpload = useCallback((id) => {
        queueRef.current = queueRef.current.filter((u) => u.id !== id);
        const xhr = activeXhrsRef.current.get(id);
        if (xhr) xhr.abort();
        setUploads((prev) => prev.filter((u) => u.id !== id));
    }, []);

    const abortAll = useCallback(() => {
        queueRef.current = [];
        activeXhrsRef.current.forEach((xhr) => xhr.abort());
        activeXhrsRef.current.clear();
        runningRef.current = 0;
    }, []);

    return {
        uploads, setUploads, handleStartUpload, removeUpload,
        clearCompletedUploads, retryUpload, cancelUpload, abortAll,
    };
};

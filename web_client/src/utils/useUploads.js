import { useState, useRef } from 'react';

// Peeled off StreamApp.jsx — owns the upload queue and the raw XHR management behind it.
// `onUploadComplete` is called after a successful upload so the caller can refresh whatever
// list of files it's showing, without this hook needing to know anything about that list.
export const useUploads = (token, serverUrl, onUploadComplete) => {
    const [uploads, setUploads] = useState([]);
    // Tracked so an in-flight upload can be aborted on logout — previously it kept running with
    // an now-invalidated token, whose only effect was a pointless extra 401 once it finished.
    const activeXhrsRef = useRef(new Map());

    const uploadFile = (item, authToken) => {
        setUploads(prev => prev.map(u => u.id === item.id ? { ...u, status: 'uploading' } : u));
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        // destination/nodeId MUST be appended before the files field — multer's storage
        // engine (uploadMiddleware.js) needs them in req.body before it starts handling the
        // file stream, and busboy/multer populate req.body in multipart part order.
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
        xhr.open('POST', `${serverUrl}/api/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        activeXhrsRef.current.set(item.id, xhr);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = (e.loaded / e.total) * 100;
                setUploads(prev => prev.map(u => u.id === item.id ? { ...u, progress: percent } : u));
            }
        };
        xhr.onload = () => {
            activeXhrsRef.current.delete(item.id);
            if (xhr.status === 200) {
                setUploads(prev => prev.map(u => u.id === item.id ? { ...u, status: 'done', progress: 100 } : u));
                onUploadComplete?.(authToken);
            } else {
                setUploads(prev => prev.map(u => u.id === item.id ? { ...u, status: 'error' } : u));
            }
        };
        xhr.onerror = () => { activeXhrsRef.current.delete(item.id); setUploads(prev => prev.map(u => u.id === item.id ? { ...u, status: 'error' } : u)); };
        xhr.onabort = () => { activeXhrsRef.current.delete(item.id); };
        xhr.send(formData);
    };

    const handleStartUpload = (uploadItems) => {
        const newUploads = uploadItems.map(item => ({
            id: Math.random().toString(36).substr(2, 9),
            ...item,
            progress: 0,
            status: 'pending'
        }));
        setUploads(prev => [...prev, ...newUploads]);
        newUploads.forEach(item => uploadFile(item, token));
    };

    const removeUpload = (id) => setUploads(prev => prev.filter(u => u.id !== id));
    const clearCompletedUploads = () => setUploads(prev => prev.filter(u => u.status !== 'done' && u.status !== 'error'));

    const retryUpload = (id) => {
        const item = uploads.find(u => u.id === id);
        if (item) {
            setUploads(prev => prev.map(u => u.id === id ? { ...u, status: 'pending', progress: 0 } : u));
            uploadFile(item, token);
        }
    };

    const abortAll = () => {
        activeXhrsRef.current.forEach(xhr => xhr.abort());
        activeXhrsRef.current.clear();
    };

    return { uploads, setUploads, handleStartUpload, removeUpload, clearCompletedUploads, retryUpload, abortAll };
};

import React, { useState, useEffect, useCallback } from 'react';
import { Folder, File as FileIcon, Download, Loader2, ArrowLeft, ChevronRight } from 'lucide-react';
import { SERVER_URL, FILES_URL } from '../../utils/api';
import { formatBytes } from '../../utils/format';

/**
 * What someone sees when they open a shared file or folder link. No account, no session.
 *
 * Mounted before the app's login gate — see main.jsx — and deliberately does not reuse anything from
 * the signed-in file browser: that expects a token for every request and an owner for every row, and a
 * viewer here has neither.
 *
 * Bytes come from the files origin via a short-lived grant minted per click, so a link that is shared
 * onward is still only as useful as the share itself.
 */
const FileSharePage = ({ token }) => {
    const [state, setState] = useState('loading');
    const [error, setError] = useState('');
    const [info, setInfo] = useState(null);
    const [nodeId, setNodeId] = useState(null);
    const [trail, setTrail] = useState([]);
    const [busyId, setBusyId] = useState(null);

    const load = useCallback(async (targetId) => {
        setState('loading');
        try {
            const query = targetId ? `?node=${encodeURIComponent(targetId)}` : '';
            const res = await fetch(`${SERVER_URL}/api/files/share/${token}/info${query}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'This link has expired or been revoked.');
            setInfo(data);
            setState('ready');
        } catch (e) {
            setError(e.message);
            setState('error');
        }
    }, [token]);

    useEffect(() => { load(nodeId); }, [load, nodeId]);

    const open = (item) => {
        setTrail((prev) => [...prev, { id: nodeId, name: info?.current?.name }]);
        setNodeId(item.id);
    };

    const back = () => {
        setTrail((prev) => {
            const next = prev.slice(0, -1);
            setNodeId(prev[prev.length - 1]?.id ?? null);
            return next;
        });
    };

    const download = async (item) => {
        setBusyId(item.id);
        try {
            const res = await fetch(`${SERVER_URL}/api/files/share/${token}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ node: item.id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'That file is no longer available.');
            // Minted on click rather than up front: a listing of 200 files would otherwise create 200
            // grants, nearly all of them unused and expiring a minute later.
            window.location.assign(`${FILES_URL}${data.path}`);
        } catch (e) {
            setError(e.message);
            setState('error');
        } finally {
            setBusyId(null);
        }
    };

    if (state === 'loading') {
        return (
            <div className="min-h-screen bg-bg flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-muted" />
            </div>
        );
    }

    if (state === 'error') {
        return (
            <div className="min-h-screen bg-bg text-text flex flex-col items-center justify-center gap-3 p-6 text-center">
                <img src="/logo.png" alt="StreamPi" className="h-10 w-auto object-contain mb-2" />
                <h1 className="text-lg font-bold">This link doesn&apos;t work</h1>
                <p className="text-sm text-muted max-w-sm">{error}</p>
            </div>
        );
    }

    const current = info.current;
    const isSingleFile = !info.root.isFolder;

    return (
        <div className="min-h-screen bg-bg text-text flex flex-col items-center p-4 sm:p-10">
            <div className="w-full max-w-2xl space-y-5">
                <div className="flex items-center gap-3">
                    <img src="/logo.png" alt="StreamPi" className="h-8 w-auto object-contain" />
                    <h1 className="text-lg font-bold truncate">{info.root.name}</h1>
                </div>

                {isSingleFile ? (
                    <div className="bg-surface border border-border rounded-lg p-5 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <FileIcon className="w-8 h-8 text-muted shrink-0" />
                            <div className="min-w-0">
                                <p className="font-medium truncate">{current.name}</p>
                                <p className="text-xs text-muted">{formatBytes(current.size)}</p>
                            </div>
                        </div>
                        <button
                            onClick={() => download(current)}
                            disabled={busyId === current.id}
                            className="bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2 shrink-0 disabled:opacity-40"
                        >
                            <Download className="w-4 h-4" /> {busyId === current.id ? 'Preparing…' : 'Download'}
                        </button>
                    </div>
                ) : (
                    <div className="bg-surface border border-border rounded-lg overflow-hidden">
                        <div className="px-4 py-3 border-b border-border flex items-center gap-2 text-sm min-w-0">
                            {trail.length > 0 && (
                                <button onClick={back} className="text-muted hover:text-text inline-flex items-center gap-1 shrink-0">
                                    <ArrowLeft className="w-4 h-4" /> Back
                                </button>
                            )}
                            {trail.length > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-2 shrink-0" />}
                            <span className="truncate text-text font-medium">{current.name || info.root.name}</span>
                        </div>

                        {info.items.length === 0 ? (
                            <div className="p-6 text-sm text-muted italic">This folder is empty.</div>
                        ) : (
                            <ul className="divide-y divide-border">
                                {info.items.map((item) => (
                                    <li key={item.id} className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-surface-2/60">
                                        {item.isFolder ? (
                                            <button onClick={() => open(item)} className="flex items-center gap-2 min-w-0 text-text hover:text-accent">
                                                <Folder className="w-4 h-4 text-accent shrink-0" />
                                                <span className="truncate">{item.name}</span>
                                            </button>
                                        ) : (
                                            <span className="flex items-center gap-2 min-w-0">
                                                <FileIcon className="w-4 h-4 text-muted shrink-0" />
                                                <span className="truncate">{item.name}</span>
                                            </span>
                                        )}
                                        <div className="flex items-center gap-3 shrink-0">
                                            <span className="text-xs text-muted">{item.isFolder ? '' : formatBytes(item.size)}</span>
                                            {!item.isFolder && (
                                                <button
                                                    onClick={() => download(item)}
                                                    disabled={busyId === item.id}
                                                    aria-label={`Download ${item.name}`}
                                                    className="text-info hover:brightness-125 disabled:opacity-40"
                                                >
                                                    <Download className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                <p className="text-xs text-muted-2 text-center">Shared with you through StreamPi.</p>
            </div>
        </div>
    );
};

export default FileSharePage;

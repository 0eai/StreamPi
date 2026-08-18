import React, { useState } from 'react';
import { Magnet, Play, Pause, Lock, Trash2, CheckCircle2, ArrowUp, ArrowDown, CloudDownload, RefreshCw, WifiOff } from 'lucide-react';
import { formatBytes } from '../utils/format';
import { usePolling } from '../utils/usePolling';
import { apiFetch } from '../utils/api';
import { useDialogs } from './ui/dialogs';
import { useToast } from './ui/toast';

const TorrentManager = ({ token, serverUrl }) => {
    const { confirm } = useDialogs();
    const toast = useToast();
    const [magnetLink, setMagnetLink] = useState('');
    const [torrents, setTorrents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [trigger, setTrigger] = useState(0);
    const [isPrivate, setIsPrivate] = useState(false);

    // Backs off (up to 30s) instead of hammering a dead server every 2s forever, and surfaces
    // `offline` so this no longer just silently stalls with no indication anything's wrong.
    const offline = usePolling(async () => {
        try {
            const res = await apiFetch(serverUrl, '/api/torrents', token);
            if (!res.ok) throw new Error('Failed to load torrents');
            setTorrents(await res.json());
        } finally {
            setLoading(false);
        }
    }, 2000, [token, serverUrl, trigger]);

    const handleAddMagnet = async () => {
        if (!magnetLink) return;
        setLoading(true);
        try {
            await apiFetch(serverUrl, '/api/torrents', token, { method: 'POST', json: { magnet: magnetLink, isPrivate } });
            setMagnetLink('');
            setIsPrivate(false);
            setTrigger(t => t + 1);
        } catch (e) { toast.error("Failed to add torrent: " + e.message); }
        setLoading(false);
    };

    const handleAction = async (hash, action) => {
        // action = 'pause' | 'resume' | 'remove' — every other destructive action in this app
        // (media delete, node remove, user delete, etc.) is guarded by a confirmation; this one
        // wasn't.
        if (action === 'remove' && !await confirm({
            title: 'Remove this torrent?',
            message: 'This deletes its downloaded data.',
            confirmLabel: 'Remove',
            danger: true,
        })) return;
        await apiFetch(serverUrl, `/api/torrents/${hash}/${action}`, token, { method: 'POST' });
        setTrigger(t => t + 1);
    };

    return (
        <div className="animate-in fade-in duration-500 space-y-6">
            {/* Input Section */}
            <div className="bg-[#1a1a1a] p-6 rounded-xl border border-gray-800 shadow-xl">
                <h2 className="text-xl font-bold text-white mb-4 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2"><Magnet className="w-5 h-5 text-red-500" /> Add New Torrent</span>
                    {offline && (
                        <span className="flex items-center gap-1.5 text-xs font-bold text-red-400 bg-red-900/20 border border-red-900/50 rounded-full px-3 py-1.5" title="Lost connection to the server — retrying">
                            <WifiOff className="w-3.5 h-3.5" /> Offline
                        </span>
                    )}
                </h2>

                {/* INPUT CONTAINER */}
                <div className="flex flex-col gap-3">
                    <div className="flex gap-3">
                        <div className="relative flex-1">
                            <Magnet className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                            <input 
                                type="text" 
                                placeholder="Paste Magnet Link (magnet:?xt=...)" 
                                value={magnetLink} 
                                onChange={e => setMagnetLink(e.target.value)} 
                                className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none transition-all font-mono" 
                            />
                        </div>
                        <button 
                            onClick={handleAddMagnet} 
                            disabled={!magnetLink || loading}
                            className="bg-red-600 hover:bg-red-500 text-white px-6 py-2.5 rounded-lg font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
                            Add
                        </button>
                    </div>

                    {/* PRIVACY TOGGLE */}
                    <div className="flex items-center gap-2 cursor-pointer" onClick={() => setIsPrivate(!isPrivate)}>
                        <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${isPrivate ? 'bg-red-600 border-red-600' : 'border-gray-600 bg-transparent'}`}>
                            {isPrivate && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                        </div>
                        <span className="text-sm text-gray-400 select-none flex items-center gap-2">
                            <Lock className="w-3 h-3" /> Download to Private Vault
                        </span>
                    </div>
                </div>
            </div>

            {/* Torrents List */}
            <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden shadow-xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-gray-900 text-gray-400 text-xs uppercase font-bold">
                            <tr>
                                <th className="px-6 py-4">Name</th>
                                <th className="px-6 py-4">Size</th>
                                <th className="px-6 py-4">Progress</th>
                                <th className="px-6 py-4">Speed</th>
                                <th className="px-6 py-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {torrents.length === 0 ? (
                                <tr>
                                    <td colSpan="5" className="px-6 py-8 text-center text-gray-500 italic">
                                        No active downloads
                                    </td>
                                </tr>
                            ) : torrents.map((t) => (
                                <tr key={t.hash} className="hover:bg-gray-800/50 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="text-sm font-bold text-white truncate max-w-[200px]" title={t.name}>
                                            {t.name || "Metadata..."}
                                        </div>
                                        <div className="text-[10px] text-gray-500 font-mono mt-1">
                                            {t.hash.substring(0, 8)}...
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-sm text-gray-400 font-mono whitespace-nowrap">
                                        {formatBytes(t.downloaded)} / {formatBytes(t.size)}
                                    </td>
                                    <td className="px-6 py-4 w-48">
                                        <div className="flex justify-between text-[10px] text-gray-400 mb-1 font-mono">
                                            <span>{t.progress.toFixed(1)}%</span>
                                            <span className={t.state === 'downloading' ? 'text-green-400' : 'text-gray-500'}>{t.state}</span>
                                        </div>
                                        <div className="w-full bg-gray-700 h-1.5 rounded-full overflow-hidden">
                                            <div 
                                                className={`h-full transition-all duration-500 ${t.state === 'paused' ? 'bg-yellow-500' : 'bg-red-500'}`} 
                                                style={{ width: `${t.progress}%` }} 
                                            />
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-1 text-green-400 text-xs font-mono">
                                            <ArrowDown className="w-3 h-3" /> {formatBytes(t.downloadSpeed)}/s
                                        </div>
                                        <div className="flex items-center gap-1 text-blue-400 text-xs font-mono mt-0.5">
                                            <ArrowUp className="w-3 h-3" /> {formatBytes(t.uploadSpeed)}/s
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex justify-end gap-2">
                                            {t.state === 'paused' ? (
                                                <button onClick={() => handleAction(t.hash, 'resume')} className="p-1.5 rounded bg-gray-800 hover:bg-green-600/20 text-gray-400 hover:text-green-400 transition-colors" title="Resume" aria-label="Resume">
                                                    <Play className="w-4 h-4" />
                                                </button>
                                            ) : (
                                                <button onClick={() => handleAction(t.hash, 'pause')} className="p-1.5 rounded bg-gray-800 hover:bg-yellow-600/20 text-gray-400 hover:text-yellow-400 transition-colors" title="Pause" aria-label="Pause">
                                                    <Pause className="w-4 h-4" />
                                                </button>
                                            )}
                                            <button onClick={() => handleAction(t.hash, 'remove')} className="p-1.5 rounded bg-gray-800 hover:bg-red-600/20 text-gray-400 hover:text-red-400 transition-colors" title="Remove" aria-label="Remove">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default TorrentManager;

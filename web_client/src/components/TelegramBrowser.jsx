import React, { useState, useEffect } from 'react';
import { CheckCircle2, Send, CloudDownload, Search, RefreshCw, Square, Zap, WifiOff } from 'lucide-react';
import { formatBytes } from '../utils/format';
import { usePolling } from '../utils/usePolling';
import Badge from './ui/Badge';
import { apiFetch } from '../utils/api';

const STATUS_TONE = { downloading: 'info', completed: 'success' };

const TelegramBrowser = ({ token, serverUrl, library }) => {
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [trigger, setTrigger] = useState(0);
    const [autoDownload, setAutoDownload] = useState(null);

    // Backs off (up to 30s) instead of hammering a dead server every 3s forever, and surfaces
    // `offline` so this no longer just silently stalls with no indication anything's wrong.
    const offline = usePolling(async () => {
        try {
            const res = await apiFetch(serverUrl, '/api/telegram/files', token);
            if (!res.ok) throw new Error('Failed to load Telegram files');
            setFiles(await res.json());
        } finally {
            setLoading(false);
        }
    }, 3000, [token, serverUrl, trigger]);

    useEffect(() => {
        apiFetch(serverUrl, '/api/admin/settings', token)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data) setAutoDownload(data.telegramAutoDownload); })
            .catch(() => {});
    }, [token, serverUrl]);

    const handleToggleAutoDownload = async () => {
        const next = !autoDownload;
        setAutoDownload(next);
        try {
            await apiFetch(serverUrl, '/api/admin/settings', token, { method: 'POST', json: { telegramAutoDownload: next } });
        } catch (e) { setAutoDownload(!next); }
    };

    const handleDownload = async (messageId) => {
        // Optimistic update
        setFiles(prev => prev.map(f => f.message_id === messageId ? { ...f, status: 'queued', downloaded_size: 0 } : f));
        await apiFetch(serverUrl, '/api/telegram/download', token, { method: 'POST', json: { message_id: messageId } });
        setTrigger(t => t + 1);
    };

    const handleStop = async (messageId) => {
        setFiles(prev => prev.map(f => f.message_id === messageId ? { ...f, status: 'stopping' } : f));
        await apiFetch(serverUrl, '/api/telegram/stop', token, { method: 'POST', json: { message_id: messageId } });
        setTimeout(() => setTrigger(t => t + 1), 1000);
    };
    const normalize = (name) => {
        if (!name) return "";
        return name
            .toLowerCase()
            .replace(/\.[^/.]+$/, "") // Remove extension
            .replace(/[._-]/g, " ")   // Replace dots, underscores, hyphens with space
            .replace(/\s+/g, " ")     // Collapse multiple spaces
            .trim();
    };
    // Helper to check if file exists in the library
    const isFileInLibrary = (telegramFilename) => {
        const target = normalize(telegramFilename);
        
        // Check Movies
        const inMovies = library.movies.some(m => {
            // Check against both the library filename AND the library title
            return normalize(m.filename) === target || normalize(m.title) === target;
        });
        if (inMovies) return true;

        // Check Series
        const inSeries = library.series.some(s => 
            s.episodes.some(e => normalize(e.filename) === target)
        );
        return inSeries;
    };

    const filteredFiles = files.filter(f => (f.filename || '').toLowerCase().includes(searchTerm.toLowerCase()));

    const renderAction = (file) => {
        const inLibrary = isFileInLibrary(file.filename);
        
        // CASE 1: Currently Downloading/Queued -> Show STOP
        if (file.status === 'queued' || file.status === 'downloading') {
            return (
                <button onClick={() => handleStop(file.message_id)} className="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white px-3 py-1.5 rounded text-xs font-bold transition-all flex items-center gap-1 ml-auto border border-red-600/30">
                    <Square className="w-3 h-3 fill-current" /> Stop
                </button>
            );
        }

        // CASE 2: Completed but MISSING from Library -> Show RE-DOWNLOAD
        if (file.status === 'completed' && !inLibrary) {
            return (
                <button onClick={() => handleDownload(file.message_id)} className="bg-yellow-600/20 hover:bg-yellow-600 text-yellow-400 hover:text-white px-3 py-1.5 rounded text-xs font-bold transition-all flex items-center gap-1 ml-auto border border-yellow-600/30">
                    <CloudDownload className="w-3 h-3" /> Re-Download
                </button>
            );
        }

        // CASE 3: Completed AND In Library -> Show Checkmark
        if (file.status === 'completed' || file.status === 'discovered' && inLibrary) {
            return (
                <span className="text-green-500 text-xs font-bold flex items-center gap-1 justify-end opacity-50">
                    <CheckCircle2 className="w-4 h-4" /> In Library
                </span>
            );
        }

        // CASE 4: New / Failed / Stopped -> Show GET
        return (
            <button onClick={() => handleDownload(file.message_id)} className="bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white px-3 py-1.5 rounded text-xs font-bold transition-all flex items-center gap-1 ml-auto border border-blue-600/30">
                <CloudDownload className="w-3 h-3" /> Get
            </button>
        );
    };

    return (
        <div className="animate-in fade-in duration-500">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                        <Send className="w-6 h-6 text-blue-400" /> Telegram Discovery
                    </h2>
                </div>
                <div className="flex gap-2 w-full md:w-auto items-center">
                    {offline && (
                        <span className="flex items-center gap-1.5 text-xs font-bold text-red-400 bg-red-900/20 border border-red-900/50 rounded-full px-3 py-1.5" title="Lost connection to the server — retrying">
                            <WifiOff className="w-3.5 h-3.5" /> Offline
                        </span>
                    )}
                    {autoDownload !== null && (
                        <button
                            onClick={handleToggleAutoDownload}
                            className="flex items-center gap-2.5 bg-gray-900 border border-gray-800 rounded-full pl-3.5 pr-3 py-1.5 text-xs font-bold text-gray-300 whitespace-nowrap"
                            title={autoDownload ? "New Telegram files download automatically" : "New Telegram files are only listed — click Get to download"}
                        >
                            Auto-Download
                            <span className={`relative inline-block w-9 h-5 shrink-0 rounded-full transition-colors ${autoDownload ? 'bg-green-600' : 'bg-gray-700'}`}>
                                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${autoDownload ? 'translate-x-4' : 'translate-x-0'}`} />
                            </span>
                        </button>
                    )}
                    <div className="relative flex-1 md:w-64">
                        <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                        <input type="text" placeholder="Search files..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full bg-gray-900 border border-gray-800 rounded-full pl-10 pr-4 py-2 text-sm text-white focus:border-blue-500 outline-none" />
                    </div>
                    <button
                        onClick={() => {
                            setLoading(true); // 👈 Turn on spinner immediately
                            setTrigger(t => t + 1); // Trigger the useEffect fetch
                        }}
                        className="p-2 bg-gray-800 rounded-full hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                        title="Refresh List"
                        aria-label="Refresh List"
                    >
                        <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden shadow-xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-gray-900 text-gray-400 text-xs uppercase font-bold">
                            <tr>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4">Filename</th>
                                <th className="px-6 py-4">Size</th>
                                <th className="px-6 py-4">Destination</th>
                                <th className="px-6 py-4">Progress</th> {/* New Column */}
                                <th className="px-6 py-4 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {filteredFiles.map((file) => {
                                const progress = file.size > 0 ? (file.downloaded_size / file.size) * 100 : 0;
                                return (
                                    <tr key={file.message_id} className="hover:bg-gray-800/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <Badge tone={STATUS_TONE[file.status] || 'neutral'}>{file.status}</Badge>
                                        </td>
                                        <td className="px-6 py-4 text-sm font-medium text-white truncate max-w-xs" title={file.filename}>{file.filename}</td>
                                        <td className="px-6 py-4 text-sm text-gray-400 font-mono whitespace-nowrap">{formatBytes(file.size)}</td>

                                        {/* DESTINATION COLUMN — a live "best candidate right now" preview, not a
                                            reservation: node availability can change before this file is actually
                                            dispatched, so this can shift between refreshes. */}
                                        <td className="px-6 py-4 text-xs whitespace-nowrap">
                                            {file.directNodeName ? (
                                                <span
                                                    className="inline-flex items-center gap-1 text-blue-400 font-mono"
                                                    title={`Will stream straight into this node's storage, skipping local disk (id: ${file.directNodeId})`}
                                                >
                                                    <Zap className="w-3 h-3" />
                                                    {file.directNodeName}
                                                </span>
                                            ) : (
                                                <span className="text-gray-600">Local</span>
                                            )}
                                        </td>

                                        {/* PROGRESS COLUMN */}
                                        <td className="px-6 py-4 w-48">
                                            {file.status === 'downloading' || (file.status === 'stopped' && progress > 0) ? (
                                                <div>
                                                    <div className="flex justify-between text-[10px] text-gray-400 mb-1 font-mono">
                                                        <span>{Math.round(progress)}%</span>
                                                        <span>{formatBytes(file.downloaded_size)}</span>
                                                    </div>
                                                    <div className="w-full bg-gray-700 h-1.5 rounded-full overflow-hidden">
                                                        <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${progress}%` }} />
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="text-gray-600 text-xs">-</span>
                                            )}
                                        </td>

                                        <td className="px-6 py-4 text-right">
                                            {renderAction(file)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default TelegramBrowser;

import React, { useState, useEffect } from 'react';
import { FileText, Trash2 } from 'lucide-react';
import { apiFetch, parseJsonSafe } from '../utils/api';
import { useDialogs } from './ui/dialogs';
import { useToast } from './ui/toast';

const ActivityLog = ({ token, serverUrl }) => {
    const [logs, setLogs] = useState([]);
    const [usernames, setUsernames] = useState([]);
    const [filter, setFilter] = useState('');
    const { confirm } = useDialogs();
    const toast = useToast();

    const fetchLogs = async (username = filter) => {
        try {
            const query = username ? `?username=${encodeURIComponent(username)}` : '';
            const res = await apiFetch(serverUrl, `/api/admin/activity${query}`, token);
            if (!res.ok) return;
            const data = await res.json();
            // Tolerates both shapes: this endpoint returned a bare array before gaining the filter,
            // and the built client can reach a server that has not been restarted yet.
            setLogs(Array.isArray(data) ? data : (data.logs || []));
            if (!Array.isArray(data) && data.usernames) setUsernames(data.usernames);
        } catch (e) { /* ignore — the panel keeps whatever it last had */ }
    };

    // Now keyed on the filter too, so changing it refetches. Previously this had no refetch trigger
    // at all, which is also why a newly logged action only appeared after a tab switch.
    useEffect(() => {
        fetchLogs(filter);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, serverUrl, filter]);

    const handleDelete = async (log) => {
        const ok = await confirm({
            title: 'Delete this entry?',
            message: `${log.action} — ${log.details || 'no details'}\n\nThe log keeps no record of the deletion.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;

        try {
            const res = await apiFetch(serverUrl, `/api/admin/activity/${log.id}`, token, { method: 'DELETE' });
            if (!res.ok) {
                const data = await parseJsonSafe(res);
                toast.error(`Delete failed: ${data.error || res.statusText}`);
                return;
            }
            fetchLogs(filter);
        } catch (e) {
            toast.error(`Delete failed: ${e.message}`);
        }
    };

    return (
        <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
                <h3 className="font-bold text-white flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-500"/> System Activity
                </h3>
                {/* Filtering happens server-side, so picking a user searches the whole table rather
                    than the hundred rows already on screen — otherwise someone whose last action was
                    200 entries ago reads as having done nothing. */}
                <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter by user"
                    className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-500 transition-colors"
                >
                    <option value="">All users</option>
                    {usernames.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
            </div>
            <div className="max-h-60 overflow-y-auto custom-scrollbar p-0">
                <table className="w-full text-left text-xs">
                    <thead className="bg-gray-800/50 text-gray-400 font-bold sticky top-0">
                        <tr>
                            <th className="px-6 py-2">Time</th>
                            <th className="px-6 py-2">User</th>
                            <th className="px-6 py-2">Action</th>
                            <th className="px-6 py-2 w-full">Details</th>
                            <th className="px-6 py-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                        {logs.length === 0 ? (
                            <tr>
                                <td colSpan="5" className="px-6 py-8 text-center text-gray-500 italic">
                                    {filter ? `No activity recorded for ${filter}` : 'No activity recorded'}
                                </td>
                            </tr>
                        ) : logs.map(log => (
                            <tr key={log.id} className="hover:bg-gray-800/30">
                                <td className="px-6 py-2 text-gray-500 font-mono whitespace-nowrap">
                                    {new Date(log.timestamp).toLocaleString()}
                                </td>
                                <td className="px-6 py-2 font-bold text-white">{log.username}</td>
                                <td className="px-6 py-2">
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                        log.action === 'LOGIN' ? 'bg-green-900/30 text-green-400' :
                                        log.action === 'WATCH' ? 'bg-blue-900/30 text-blue-400' :
                                        log.action === 'DELETE' ? 'bg-red-900/30 text-red-400' :
                                        'bg-gray-700 text-gray-300'
                                    }`}>
                                        {log.action}
                                    </span>
                                </td>
                                <td className="px-6 py-2 text-gray-300">{log.details}</td>
                                <td className="px-6 py-2 text-right">
                                    <button
                                        onClick={() => handleDelete(log)}
                                        className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-400 font-medium"
                                        aria-label={`Delete entry ${log.id}`}
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default ActivityLog;

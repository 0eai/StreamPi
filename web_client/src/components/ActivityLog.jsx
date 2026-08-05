import React, { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import { apiFetch } from '../utils/api';

const ActivityLog = ({ token, serverUrl }) => {
    const [logs, setLogs] = useState([]);

    useEffect(() => {
        const fetchLogs = async () => {
            try {
                const res = await apiFetch(serverUrl, '/api/admin/activity', token);
                if (res.ok) setLogs(await res.json());
            } catch (e) { /* ignore */ }
        };
        fetchLogs();
    }, [token, serverUrl]);

    return (
        <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
                <h3 className="font-bold text-white flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-500"/> System Activity
                </h3>
            </div>
            <div className="max-h-60 overflow-y-auto custom-scrollbar p-0">
                <table className="w-full text-left text-xs">
                    <thead className="bg-gray-800/50 text-gray-400 font-bold sticky top-0">
                        <tr>
                            <th className="px-6 py-2">Time</th>
                            <th className="px-6 py-2">User</th>
                            <th className="px-6 py-2">Action</th>
                            <th className="px-6 py-2 w-full">Details</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                        {logs.map(log => (
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
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// New Component: User Management

export default ActivityLog;

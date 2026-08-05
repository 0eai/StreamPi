import React, { useState } from 'react';
import { Play, HardDrive, Users, WifiOff } from 'lucide-react';
import { usePolling } from '../utils/usePolling';
import { apiFetch } from '../utils/api';

const ServerStats = ({ token, serverUrl }) => {
    const [stats, setStats] = useState(null);
    const [storage, setStorage] = useState(null);

    // Backs off (up to 30s) instead of hammering a dead server every 5s forever, and surfaces
    // `offline` so this no longer just silently freezes on stale numbers with no indication
    // anything's wrong.
    const offline = usePolling(async () => {
        const [sysRes, storRes] = await Promise.all([
            apiFetch(serverUrl, '/api/status/system', token),
            apiFetch(serverUrl, '/api/status/storage', token)
        ]);
        if (!sysRes.ok || !storRes.ok) throw new Error('Stats request failed');
        setStats(await sysRes.json());
        setStorage(await storRes.json());
    }, 5000, [token, serverUrl]);

    if (!stats || !storage) return null;

    if (offline) {
        return (
            <div className="hidden lg:flex items-center gap-1.5 text-[10px] font-mono text-red-400 bg-black/40 px-3 py-1.5 rounded-lg border border-red-900/50" title="Lost connection to the server — retrying">
                <WifiOff className="w-3 h-3" />
                <span>Offline</span>
            </div>
        );
    }

    return (
        <div className="hidden lg:flex items-center gap-4 text-[10px] font-mono text-gray-400 bg-black/40 px-3 py-1.5 rounded-lg border border-gray-800">
            {/* Users */}
            <div className="flex items-center gap-1.5" title="Connected Users">
                <Users className="w-3 h-3 text-blue-400" />
                <span>{stats.onlineUsers}</span>
            </div>

            {/* Active Streams */}
            <div className="flex items-center gap-1.5" title="Active Streams">
                <Play className="w-3 h-3 text-green-400" />
                <span>{stats.activeStreams}</span>
            </div>

            <div className="w-px h-4 bg-gray-700 mx-1" />

            {/* Storage Usage */}
            <div className="flex items-center gap-1.5" title="Disk Usage">
                <HardDrive className="w-3 h-3 text-gray-500" />
                <span className={storage.percentage > 90 ? "text-red-500" : "text-gray-300"}>
                    {Math.round(storage.percentage)}%
                </span>
            </div>
        </div>
    );
};

export default ServerStats;

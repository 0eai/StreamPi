import React, { useState } from 'react';
import { Smartphone, UploadCloud, Monitor, Tv, Loader2, HardDrive, Activity, Cpu, ArrowUp, ArrowDown, XCircle, Globe, Radio, Wifi, WifiOff } from 'lucide-react';
import { formatDuration, formatBytes, formatNetworkSpeed, formatRelativeTime } from '../utils/format';
import AllDevices from './AllDevices';
import { useDialogs } from './ui/dialogs';
import { useToast } from './ui/toast';
import { usePolling } from '../utils/usePolling';
import { apiFetch, parseJsonSafe } from '../utils/api';

const DashboardTab = ({ token, serverUrl, role, onLogout }) => {
    const { confirm } = useDialogs();
    const toast = useToast();
    const [data, setData] = useState(null);
    const [system, setSystem] = useState(null);
    const [storage, setStorage] = useState(null);

    const [speedTestResult, setSpeedTestResult] = useState(null);
    const [isTestingSpeed, setIsTestingSpeed] = useState(false);

    // Backs off (up to 30s) instead of hammering a dead server with 3 requests every 2s
    // forever, surfaces `offline` instead of silently freezing on stale numbers, and — since
    // the next tick is only scheduled after this one fully settles — can no longer pile up
    // overlapping in-flight requests if one tick runs long.
    const offline = usePolling(async () => {
        const [sysRes, storRes, dashRes] = await Promise.all([
            apiFetch(serverUrl, '/api/status/system', token),
            apiFetch(serverUrl, '/api/status/storage', token),
            apiFetch(serverUrl, '/api/admin/dashboard', token)
        ]);
        if (!sysRes.ok || !storRes.ok || !dashRes.ok) throw new Error('Dashboard poll failed');
        setSystem(await sysRes.json());
        setStorage(await storRes.json());
        setData(await dashRes.json());
    }, 2000, [token, serverUrl]);

    const runSpeedTest = async () => {
        setIsTestingSpeed(true);
        setSpeedTestResult(null);
        try {
            const res = await apiFetch(serverUrl, '/api/status/speedtest', token);
            const data = await res.json();
            if (res.ok) setSpeedTestResult(data);
            else toast.error("Test failed: " + (data.error || "Unknown error"));
        } catch (e) {
            toast.error("Connection error");
        }
        setIsTestingSpeed(false);
    };

    // Helper to convert Bytes/s to Mbps (Megabits per second)
    const toMbps = (bytesPerSec) => (bytesPerSec * 8 / 1000000).toFixed(1);

    const handleTerminateStream = async (streamId) => {
        if (!await confirm("Terminate this stream? Playback will stop immediately for that user.")) return;
        try {
            const res = await apiFetch(serverUrl, `/api/admin/streams/${streamId}/terminate`, token, { method: 'POST' });
            const result = await parseJsonSafe(res);
            if (!res.ok) {
                toast.error(`Terminate failed: ${result.error || res.statusText}`);
                return;
            }
            setData(prev => prev ? { ...prev, streams: prev.streams.filter(s => s.id !== streamId) } : prev);
        } catch (e) { toast.error("Terminate failed: " + e.message); }
    };

    if (!data || !system) return <div className="p-12 text-center text-gray-500"><Loader2 className="w-8 h-8 animate-spin mx-auto mb-2"/> Loading Dashboard...</div>;

    const { users, streams, queue } = data;

    return (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8 pb-12">
            {offline && (
                <div className="flex items-center gap-2 text-sm font-bold text-red-400 bg-red-900/20 border border-red-900/50 rounded-lg px-4 py-2.5">
                    <WifiOff className="w-4 h-4" /> Lost connection to the server — showing the last known data while retrying.
                </div>
            )}

            {/* 1. TOP STATS ROW */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
                <div className="bg-[#1a1a1a] p-5 rounded-xl border border-gray-800 relative overflow-hidden">
                    <div className="flex justify-between items-start z-10 relative">
                        <div>
                            <p className="text-gray-400 text-xs font-bold uppercase mb-1">CPU Load</p>
                            <h3 className="text-3xl font-bold text-white">{Math.round(system.cpu)}%</h3>
                        </div>
                        <Cpu className="text-gray-700 w-8 h-8"/>
                    </div>
                    <div className="absolute bottom-0 left-0 w-full h-1 bg-gray-800"><div className="h-full bg-blue-500 transition-all duration-500" style={{width: `${system.cpu}%`}}/></div>
                </div>

                <div className="bg-[#1a1a1a] p-5 rounded-xl border border-gray-800 relative overflow-hidden">
                    <div className="flex justify-between items-start z-10 relative">
                        <div>
                            <p className="text-gray-400 text-xs font-bold uppercase mb-1">RAM Usage</p>
                            <h3 className="text-3xl font-bold text-white">{Math.round(system.ram.percent)}%</h3>
                        </div>
                        <Activity className="text-gray-700 w-8 h-8"/>
                    </div>
                    <div className="absolute bottom-0 left-0 w-full h-1 bg-gray-800"><div className="h-full bg-purple-500 transition-all duration-500" style={{width: `${system.ram.percent}%`}}/></div>
                </div>

                <div className="bg-[#1a1a1a] p-5 rounded-xl border border-gray-800 relative overflow-hidden">
                    <div className="flex justify-between items-start z-10 relative">
                        <div>
                            <p className="text-gray-400 text-xs font-bold uppercase mb-1">Disk Storage</p>
                            <h3 className="text-3xl font-bold text-white">{storage ? Math.round(storage.percentage) : '--'}%</h3>
                            <p className="text-gray-500 text-xs mt-1">{storage ? formatBytes(storage.free) : '--'} free</p>
                        </div>
                        <HardDrive className="text-gray-700 w-8 h-8"/>
                    </div>
                    <div className="absolute bottom-0 left-0 w-full h-1 bg-gray-800"><div className={`h-full transition-all duration-500 ${storage?.percentage > 90 ? 'bg-red-500' : 'bg-orange-500'}`} style={{width: `${storage?.percentage || 0}%`}}/></div>
                </div>

                <div className="bg-[#1a1a1a] p-5 rounded-xl border border-gray-800 relative overflow-hidden">
                    <div className="flex justify-between items-start z-10 relative">
                        <div>
                            <p className="text-gray-400 text-xs font-bold uppercase mb-1">Network Up</p>
                            <h3 className="text-xl font-bold text-white flex items-center gap-1"><ArrowUp className="w-4 h-4 text-blue-500"/> {formatNetworkSpeed(system.network.up)}</h3>
                            <p className="text-gray-500 text-xs mt-1 flex items-center gap-1"><ArrowDown className="w-3 h-3"/> {formatNetworkSpeed(system.network.down)} Down</p>
                        </div>
                        <Activity className="text-gray-700 w-8 h-8"/>
                    </div>
                </div>

                <div className="bg-[#1a1a1a] p-5 rounded-xl border border-gray-800 relative overflow-hidden">
                    <div className="flex justify-between items-start z-10 relative">
                        <div>
                            <p className="text-gray-400 text-xs font-bold uppercase mb-1">Active Streams</p>
                            <h3 className="text-3xl font-bold text-red-500">{system.activeStreams}</h3>
                        </div>
                        <Radio className="text-gray-700 w-8 h-8"/>
                    </div>
                </div>
                {/* 🆕 NEW: SPEEDTEST CARD */}
                <div className="bg-[#1a1a1a] p-5 rounded-xl border border-gray-800 relative overflow-hidden flex flex-col justify-between">
                    <div className="flex justify-between items-start z-10 relative mb-2">
                        <div>
                            <p className="text-gray-400 text-xs font-bold uppercase mb-1">Internet Speed</p>
                            {isTestingSpeed ? (
                                <div className="flex items-center gap-2 text-yellow-500 animate-pulse">
                                    <Loader2 className="w-5 h-5 animate-spin" /> Testing...
                                </div>
                            ) : speedTestResult ? (
                                <div>
                                    <h3 className="text-xl font-bold text-green-400 flex items-center gap-1">
                                        <ArrowDown className="w-4 h-4"/> {toMbps(speedTestResult.download)} <span className="text-xs text-gray-500">Mbps</span>
                                    </h3>
                                    <p className="text-gray-400 text-xs mt-1 flex items-center gap-1">
                                        <ArrowUp className="w-3 h-3"/> {toMbps(speedTestResult.upload)} Mbps
                                    </p>
                                </div>
                            ) : (
                                <h3 className="text-xl font-bold text-gray-600">-- Mbps</h3>
                            )}
                        </div>
                        <Wifi className={`w-8 h-8 ${isTestingSpeed ? 'text-yellow-500' : 'text-gray-700'}`} />
                    </div>
                    
                    <button 
                        onClick={runSpeedTest} 
                        disabled={isTestingSpeed}
                        className="w-full bg-gray-800 hover:bg-gray-700 text-xs font-bold text-white py-2 rounded transition-colors disabled:opacity-50 border border-gray-700"
                    >
                        {isTestingSpeed ? "Running Test..." : "Run Speed Test"}
                    </button>
                </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* 2. ONLINE USERS */}
                <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                        <h3 className="font-bold text-white flex items-center gap-2"><Globe className="w-4 h-4 text-blue-500"/> Online Users ({users.length})</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-800/50 text-gray-400 font-medium text-xs uppercase">
                                <tr>
                                    <th className="px-6 py-3">User</th>
                                    <th className="px-6 py-3">Device</th>
                                    <th className="px-6 py-3">Location</th>
                                    <th className="px-6 py-3 text-right">Last Active</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                                {users.length === 0 ? (
                                    <tr><td colSpan="4" className="px-6 py-8 text-center text-gray-500 italic">No active users</td></tr>
                                ) : (
                                    users.map((u, i) => (
                                        <tr key={i} className="hover:bg-gray-800/30">
                                            <td className="px-6 py-3">
                                                <div className="font-bold text-white">{u.username}</div>
                                                <div className="text-[10px] text-gray-500 font-mono">{u.ip}</div>
                                            </td>
                                            <td className="px-6 py-3">
                                                <div className="flex items-center gap-2">
                                                    {/* Device Icon Logic */}
                                                    {u.device_type === 'Mobile' ? <Smartphone className="w-4 h-4 text-gray-400"/> : 
                                                     u.device_type === 'TV' ? <Tv className="w-4 h-4 text-gray-400"/> : 
                                                     <Monitor className="w-4 h-4 text-gray-400"/>}
                                                    <span className="text-gray-300">{u.device}</span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-3 text-white">{u.location || 'Unknown'}</td>
                                            <td className="px-6 py-3 text-right text-gray-500">{formatRelativeTime(u.last_active)}</td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* 2b. ALL DEVICES — super_admin only, and hidden outright rather than disabled for
                    anyone else: a visible card advertising every user's devices is worse than its
                    absence, and the route 403s regardless. This is the first place the client
                    branches on super_admin for access rather than for a label or a colour.

                    Separate from Online Users above on purpose — that card is a live "who is
                    watching now" view whose 5-minute window is meaningful there. */}
                {role === 'super_admin' && (
                    <AllDevices token={token} serverUrl={serverUrl} onLogout={onLogout} />
                )}

                {/* 3. ACTIVE STREAMS */}
                <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                        <h3 className="font-bold text-white flex items-center gap-2"><Radio className="w-4 h-4 text-red-500"/> Active Streams</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-800/50 text-gray-400 font-medium text-xs uppercase">
                                <tr>
                                    <th className="px-6 py-3">User</th>
                                    <th className="px-6 py-3">Content</th>
                                    <th className="px-6 py-3">Type</th>
                                    <th className="px-6 py-3 text-right">Duration</th>
                                    <th className="px-6 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                                {streams.length === 0 ? (
                                    <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500 italic">No streams active</td></tr>
                                ) : (
                                    streams.map((s, i) => (
                                        <tr key={s.id || i} className="hover:bg-gray-800/30">
                                            <td className="px-6 py-3">
                                                <div className="font-bold text-white">{s.username || 'Guest'}</div>
                                                <div className="text-[10px] text-gray-500 font-mono">{s.ip}</div>
                                            </td>
                                            <td className="px-6 py-3 text-white font-medium truncate max-w-[150px]" title={s.filename}>{s.filename}</td>
                                            <td className="px-6 py-3">
                                                {/* 1. The Stream Type Badge (Direct/Transcode) */}
                                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${s.type === 'direct' ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}`}>
                                                    {(s.type || '').toUpperCase()}
                                                </span>

                                                {/* 2. The Source Info (NAS/Local) */}
                                                <div className="mt-1.5 text-[10px] text-gray-500 font-mono uppercase tracking-wider flex items-center gap-1.5">
                                                    {/* Optional: Little colored dot to distinguish visually */}
                                                    <span className={`w-1.5 h-1.5 rounded-full ${s.source?.toLowerCase().includes('nas') ? 'bg-blue-500' : 'bg-purple-500'}`}></span>
                                                    {s.source || 'LOCAL'}
                                                </div>
                                            </td>
                                            <td className="px-6 py-3 text-right text-gray-400 font-mono">{formatDuration(s.duration)}</td>
                                            <td className="px-6 py-3 text-right">
                                                <button
                                                    onClick={() => handleTerminateStream(s.id)}
                                                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold text-red-400 hover:text-white hover:bg-red-600/80 transition-colors"
                                                    title="Terminate Stream"
                                                >
                                                    <XCircle className="w-3.5 h-3.5" /> Terminate
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            {/* 5. TRANSCODE QUEUE */}
            <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                    <h3 className="font-bold text-white flex items-center gap-2"><UploadCloud className="w-4 h-4 text-yellow-500"/> Transcode Queue</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-800/50 text-gray-400 font-medium text-xs uppercase">
                            <tr>
                                <th className="px-6 py-3">Filename</th>
                                <th className="px-6 py-3">Assigned Node</th>
                                <th className="px-6 py-3">Status</th>
                                <th className="px-6 py-3 text-center">Download</th>
                                <th className="px-6 py-3 text-center">Transcode</th>
                                <th className="px-6 py-3 text-center">Upload</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {queue.length === 0 ? (
                                <tr><td colSpan="6" className="px-6 py-8 text-center text-gray-500 italic">Queue empty</td></tr>
                            ) : (
                                queue.map((job, i) => {
                                    const progress = job.progress || { stage: 'pending', percent: 0 };
                                    const stage = progress.stage;
                                    const pct = progress.percent;
                                    
                                    // Helper to render bars with side percentage
                                    const getBar = (columnType, baseColor) => {
                                        let val = 0;
                                        let barColor = baseColor;
                                        let animation = "";
                                        let label = null; // For hovering tooltips (e.g., "Saving...")

                                        // 1. DOWNLOAD COLUMN
                                        if (columnType === 'download') {
                                            if (stage === 'downloading_source') val = pct;
                                            else if (['transcoding', 'uploading_result', 'server_receiving', 'finalizing_server', 'completed'].includes(stage)) val = 100;
                                        }

                                        // 2. TRANSCODE COLUMN
                                        if (columnType === 'transcode') {
                                            if (stage === 'transcoding') val = pct;
                                            else if (['uploading_result', 'server_receiving', 'finalizing_server', 'completed'].includes(stage)) val = 100;
                                        }

                                        // 3. UPLOAD COLUMN
                                        if (columnType === 'upload') {
                                            if (stage === 'uploading_result') val = pct;
                                            else if (stage === 'server_receiving') {
                                                val = pct; 
                                                barColor = "bg-purple-500"; 
                                                label = "Saving"; 
                                                animation = "animate-pulse"; 
                                            }
                                            else if (stage === 'finalizing_server') {
                                                val = 100;
                                                barColor = "bg-purple-500";
                                                label = "Finalizing";
                                                animation = "animate-pulse";
                                            }
                                            else if (stage === 'completed') val = 100;
                                        }
                                        
                                        // Render Bar + Percentage Side-by-Side
                                        return (
                                            <div className="flex items-center gap-2 w-32">
                                                {/* The Bar */}
                                                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden relative">
                                                    <div className={`h-full ${barColor} transition-all duration-500 ${animation}`} style={{width: `${val}%`}}/>
                                                </div>
                                                
                                                {/* The Percentage Text */}
                                                <span className={`text-[10px] font-mono w-8 text-right ${val > 0 ? 'text-white' : 'text-gray-600'}`}>
                                                    {val}%
                                                </span>

                                                {/* Optional Floating Label for Special States (like Saving) */}
                                                {label && (
                                                    <div className="absolute -mt-6 left-1/2 -translate-x-1/2 bg-black/90 text-white text-[9px] px-1.5 py-0.5 rounded border border-gray-700 whitespace-nowrap z-10 shadow-lg">
                                                        {label}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    };

                                    // Status Text Logic
                                    let statusText = (job.status || '').replace('_', ' ');
                                    if (stage === 'server_receiving') statusText = "Saving to Disk";
                                    if (stage === 'finalizing_server') statusText = "Finalizing";

                                    return (
                                        <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                                            <td className="px-6 py-3 text-white font-medium truncate max-w-[150px]" title={job.filename}>
                                                {job.filename}
                                            </td>
                                            <td className="px-6 py-3 text-blue-400 font-mono text-xs">
                                                {job.assignedNode}
                                            </td>
                                            <td className="px-6 py-3">
                                                <span className="text-gray-400 text-[10px] uppercase font-bold tracking-wider">
                                                    {statusText}
                                                </span>
                                            </td>
                                            <td className="px-6 py-3">{getBar('download', 'bg-blue-500')}</td>
                                            <td className="px-6 py-3">{getBar('transcode', 'bg-yellow-500')}</td>
                                            <td className="px-6 py-3">{getBar('upload', 'bg-green-500')}</td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

        </div>
    );
};

export default DashboardTab;

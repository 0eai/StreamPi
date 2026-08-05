import React, { useState, useEffect } from 'react';
import { Loader2, ArrowUp, ArrowDown, Server, WifiOff } from 'lucide-react';
import { formatBytes, formatNetworkSpeed } from '../utils/format';
import { usePolling } from '../utils/usePolling';
import Modal from './ui/Modal';
import { apiFetch } from '../utils/api';

const NodeDetailModal = ({ node, token, serverUrl, onClose }) => {
    const [live, setLive] = useState(null);

    useEffect(() => { setLive(null); }, [node?.id]);

    // Backs off (up to 30s) instead of hammering an unreachable node every 3s forever, and
    // surfaces `offline` — previously a failed fetch just left whatever `live` data was
    // already showing frozen, with no indication it might be stale.
    const offline = usePolling(async () => {
        if (!node) return;
        const res = await apiFetch(serverUrl, `/api/admin/nodes/${node.id}/live`, token);
        if (!res.ok) throw new Error('Node unreachable');
        setLive(await res.json());
    }, 3000, [node, token, serverUrl]);

    return (
        <Modal
            isOpen={!!node}
            onClose={onClose}
            maxWidth="max-w-2xl"
            panelClassName="max-h-[85vh] overflow-y-auto"
            title={
                <>
                    <Server className="w-5 h-5 text-purple-500" /> {node?.name}
                    {offline && live && (
                        <span className="flex items-center gap-1 text-xs font-bold text-red-400 bg-red-900/20 border border-red-900/50 rounded-full px-2.5 py-1 ml-2" title="Lost connection to this node — retrying">
                            <WifiOff className="w-3 h-3" /> Offline
                        </span>
                    )}
                </>
            }
        >
            <div className="text-xs text-gray-500 font-mono mb-6 -mt-4">{node?.id}</div>

            {!live ? (
                    <div className="text-center text-gray-500 py-12"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Connecting...</div>
                ) : (
                    <div className="space-y-6">
                        <div className="grid grid-cols-3 gap-4">
                            <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-800">
                                <div className="text-xs text-gray-500 uppercase font-bold mb-1">CPU</div>
                                <div className="text-2xl font-bold text-white">{Math.round(live.cpu || 0)}%</div>
                            </div>
                            <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-800">
                                <div className="text-xs text-gray-500 uppercase font-bold mb-1">RAM</div>
                                <div className="text-2xl font-bold text-white">{Math.round(live.ram?.percent || 0)}%</div>
                            </div>
                            <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-800">
                                <div className="text-xs text-gray-500 uppercase font-bold mb-1">Network</div>
                                <div className="text-sm font-bold text-white flex items-center gap-1"><ArrowUp className="w-3 h-3 text-blue-500" />{formatNetworkSpeed(live.network?.up || 0)}</div>
                                <div className="text-sm text-gray-400 flex items-center gap-1"><ArrowDown className="w-3 h-3" />{formatNetworkSpeed(live.network?.down || 0)}</div>
                            </div>
                        </div>

                        {live.disk && (
                            <div>
                                <div className="flex justify-between text-xs text-gray-400 mb-1">
                                    <span className="font-bold uppercase">Storage</span>
                                    <span>{formatBytes(live.disk.free)} free of {formatBytes(live.disk.total)}</span>
                                </div>
                                <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                                    <div className={`h-full ${live.disk.percent > 90 ? 'bg-red-500' : 'bg-orange-500'}`} style={{ width: `${live.disk.percent}%` }} />
                                </div>
                            </div>
                        )}

                        {live.jobs && live.jobs.length > 0 && (
                            <div>
                                <div className="text-xs text-gray-400 uppercase font-bold mb-2">Active Transfers</div>
                                {live.jobs.map((job, i) => (
                                    <div key={i} className="mb-2">
                                        <div className="flex justify-between text-xs text-gray-300 mb-1">
                                            <span className="truncate max-w-[200px]">{job.filename}</span>
                                            <span>{job.percent}%</span>
                                        </div>
                                        <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-blue-500" style={{ width: `${job.percent}%` }} /></div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {node?.roles?.includes('transcoder') && (
                            <div>
                                <div className="text-xs text-gray-400 uppercase font-bold mb-1">Current Job</div>
                                <div className={`text-sm font-bold ${live.busy ? 'text-yellow-500' : 'text-green-500'}`}>{live.current_job || 'Idle'}</div>
                            </div>
                        )}

                        <div className="text-xs text-gray-500 pt-2 border-t border-gray-800">Hardware: {live.hardware || 'Unknown'}</div>
                    </div>
                )}
        </Modal>
    );
};

export default NodeDetailModal;

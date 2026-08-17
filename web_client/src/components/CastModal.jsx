import React, { useState, useEffect } from 'react';
import { Cast, Loader2, Tv, Smartphone, Monitor, Check } from 'lucide-react';
import Modal from './ui/Modal';
import { apiFetch, parseJsonSafe } from '../utils/api';

const DEVICE_ICON = { tv: Tv, mobile: Smartphone, desktop: Monitor };

// Opened from the Cast button on a Poster/EpisodeCard. Lists the caller's OWN other active
// sessions (GET /api/auth/sessions) and sends a "play this" command to whichever one is picked
// (POST /api/remote/play) — the target picks it up on its own polling loop within a few
// seconds (both web_client and StreamPiTV poll /api/remote/pending). There's no push/ack
// channel back, so this only ever reports "sent," never "confirmed playing."
const CastModal = ({ item, onClose, serverUrl, token }) => {
    const [state, setState] = useState('loading'); // loading | ready | error
    const [devices, setDevices] = useState([]);
    const [sentTo, setSentTo] = useState(null);

    useEffect(() => {
        if (!item) return;
        setState('loading');
        setSentTo(null);
        apiFetch(serverUrl, '/api/auth/sessions', token)
            .then(async (res) => {
                const data = await parseJsonSafe(res);
                if (!res.ok) throw new Error(data.error || 'Failed to load devices');
                setDevices((data.sessions || []).filter(s => !s.isCurrent));
                setState('ready');
            })
            .catch(() => setState('error'));
    }, [item, serverUrl, token]);

    const handleSend = async (device) => {
        try {
            const res = await apiFetch(serverUrl, '/api/remote/play', token, {
                method: 'POST',
                json: { targetToken: device.token, path: item.path, startTime: item.progress || 0 },
            });
            const data = await parseJsonSafe(res);
            if (!res.ok) { alert(`Cast failed: ${data.error || res.statusText}`); return; }
            setSentTo(device.token);
            setTimeout(onClose, 1200);
        } catch (e) { alert('Cast failed: ' + e.message); }
    };

    return (
        <Modal isOpen={!!item} onClose={onClose} title={<><Cast className="w-5 h-5 text-blue-500" /> Play On&hellip;</>}>
            <p className="text-xs text-gray-500 mb-4 truncate">{item?.title || item?.filename}</p>

            {state === 'loading' && (
                <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-gray-500" /></div>
            )}

            {state === 'error' && (
                <p className="text-sm text-danger py-4 text-center">Couldn&apos;t load your other devices.</p>
            )}

            {state === 'ready' && devices.length === 0 && (
                <p className="text-sm text-gray-500 italic py-4 text-center">No other devices are currently signed in to this account.</p>
            )}

            {state === 'ready' && devices.length > 0 && (
                <div className="space-y-2">
                    {devices.map((d) => {
                        const Icon = DEVICE_ICON[d.deviceKind] || Monitor;
                        const sent = sentTo === d.token;
                        return (
                            <button
                                key={d.token}
                                onClick={() => handleSend(d)}
                                disabled={!!sentTo}
                                className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-left transition-colors disabled:opacity-60"
                            >
                                <Icon className="w-5 h-5 text-gray-400 shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium text-white truncate">{d.device || 'Unknown Device'}</div>
                                    <div className="text-xs text-gray-500">{d.deviceType}</div>
                                </div>
                                {sent && <Check className="w-4 h-4 text-green-500 shrink-0" />}
                            </button>
                        );
                    })}
                </div>
            )}
        </Modal>
    );
};

export default CastModal;

import React, { useEffect, useState } from 'react';
import { Laptop, Trash2 } from 'lucide-react';
import { apiFetch, parseJsonSafe } from '../utils/api';
import { deviceIcon } from '../utils/deviceIcons';
import { formatRelativeTime } from '../utils/format';

/** Below this, show "Active now" instead of a relative time. */
const ACTIVE_NOW_MS = 2 * 60 * 1000;

/**
 * Every session signed in to this account, with the ability to sign one out.
 *
 * Until this existed, a normal user had nowhere to see their own devices: names appeared only in
 * the cast picker (a transient modal that filters to the last 5 minutes and hides the current
 * device) and the admin-only dashboard. That is why a Fire TV reporting itself as "Unknown Device /
 * Web Browser" went unnoticed for weeks.
 *
 * Backed by /api/auth/devices rather than /api/auth/sessions: the latter is a cast-target list
 * bounded to 5 minutes of activity, so a backgrounded phone would be missing from exactly the list
 * whose job is to account for it. See that route's comment for the full contrast.
 */
const MyDevices = ({ token, serverUrl, onLogout }) => {
    const [devices, setDevices] = useState([]);
    // Distinguished from an empty list on purpose. Every sibling card here treats a failed fetch as
    // "nothing to show", which is fine for share links but would have this card claim the account
    // has no devices — on a screen the reader is demonstrably looking at from one. It is also the
    // real rollout state, since building the client and restarting the server are separate acts.
    const [unavailable, setUnavailable] = useState(false);

    const loadDevices = async () => {
        try {
            const res = await apiFetch(serverUrl, '/api/auth/devices', token);
            if (!res.ok) { setUnavailable(true); return; }
            setDevices((await res.json()).devices || []);
            setUnavailable(false);
        } catch (e) {
            setUnavailable(true);
        }
    };

    // One-shot, matching the other Settings cards. Not polled: the shared offline banner in
    // SettingsTab is admin-gated, so a poller here would have nowhere to report a failure. The
    // trade-off is that relative times freeze while the tab stays open.
    useEffect(() => {
        if (token) loadDevices();
        else setDevices([]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const handleSignOut = async (d) => {
        const label = d.device || 'this device';

        // The current session deliberately does NOT go through the API. Deleting your own row from
        // here would leave the page running on a dead token — every poll 401s and the user sits in
        // a half-logged-in UI. onLogout aborts uploads, clears localStorage and resets the app.
        if (d.isCurrent) {
            if (!confirm(`Sign out ${label}? That's the device you're using, so you'll be returned to the login screen.`)) return;
            onLogout();
            return;
        }

        if (!confirm(`Sign out ${label}? It will need to sign in again. Anything it is already playing may continue until it stops.`)) return;
        try {
            const res = await apiFetch(serverUrl, `/api/auth/devices/${d.id}`, token, { method: 'DELETE' });
            if (!res.ok) {
                const data = await parseJsonSafe(res);
                alert(`Sign out failed: ${data.error || res.statusText}`);
                return;
            }
            loadDevices();
        } catch (e) {
            alert(`Sign out failed: ${e.message}`);
        }
    };

    return (
        <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                <h3 className="font-bold text-white flex items-center gap-2"><Laptop className="w-4 h-4 text-green-500" /> My Devices</h3>
            </div>
            {unavailable ? (
                <div className="p-6 text-sm text-gray-500 italic">Your signed-in devices aren&apos;t available on this server version.</div>
            ) : devices.length === 0 ? (
                <div className="p-6 text-sm text-gray-500 italic">No signed-in devices found.</div>
            ) : (
                <>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-800/50 text-gray-400 font-medium text-xs uppercase">
                                <tr>
                                    <th className="px-6 py-3">Device</th>
                                    <th className="px-6 py-3">Location</th>
                                    <th className="px-6 py-3">Last Active</th>
                                    <th className="px-6 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                                {devices.map((d) => {
                                    const Icon = deviceIcon(d.deviceKind);
                                    return (
                                        <tr key={d.id} className="hover:bg-gray-800/30">
                                            <td className="px-6 py-3">
                                                <div className="flex items-center gap-3">
                                                    <Icon className="w-4 h-4 text-gray-400 shrink-0" />
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-bold text-white truncate">{d.device || 'Unknown Device'}</span>
                                                            {d.isCurrent && (
                                                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-900/40 text-green-300 shrink-0">THIS DEVICE</span>
                                                            )}
                                                        </div>
                                                        <div className="text-[10px] text-gray-500 font-mono">
                                                            {d.deviceType}{d.ip ? ` · ${d.ip}` : ''}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-3 text-gray-400 text-xs">{d.location || 'Unknown'}</td>
                                            <td className="px-6 py-3 text-gray-400 text-xs">
                                                {Date.now() - d.lastActive < ACTIVE_NOW_MS ? (
                                                    <span className="inline-flex items-center gap-1.5">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Active now
                                                    </span>
                                                ) : formatRelativeTime(d.lastActive)}
                                            </td>
                                            <td className="px-6 py-3 text-right">
                                                {/* Hidden rather than disabled when the parent didn't pass onLogout, so this
                                                    component can never strand a caller on a dead token. */}
                                                {(!d.isCurrent || onLogout) && (
                                                    <button onClick={() => handleSignOut(d)} className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-400 font-medium">
                                                        <Trash2 className="w-3.5 h-3.5" /> Sign Out
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {/* Repeated entries are legitimate, not a bug: a browser that loses its saved token
                        without signing out leaves the session row behind, and each row is a credential
                        that still works. Saying so stops it reading as duplication. */}
                    <div className="px-6 py-3 border-t border-gray-800 text-xs text-gray-500">
                        Each row is a sign-in that still has access. Repeats are normal — a browser that
                        forgot its login leaves one behind until you sign it out here.
                    </div>
                </>
            )}
        </div>
    );
};

export default MyDevices;

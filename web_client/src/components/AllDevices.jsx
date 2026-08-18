import React, { useEffect, useState } from 'react';
import { Laptop, XCircle } from 'lucide-react';
import { apiFetch, parseJsonSafe } from '../utils/api';
import { deviceIcon } from '../utils/deviceIcons';
import { formatRelativeTime } from '../utils/format';
import { useDialogs } from './ui/dialogs';
import { useToast } from './ui/toast';

/** Below this, show "Active now" rather than a relative time — same threshold as MyDevices. */
const ACTIVE_NOW_MS = 2 * 60 * 1000;

const ROLE_LABEL = { super_admin: 'Super Admin', admin: 'Admin', public: 'User' };

/**
 * Every session on the server, for a super_admin, with per-device sign-out.
 *
 * The Dashboard's "Online Users" card above this one answers a different question — who is watching
 * right now — and its 5-minute window and hidden super_admin rows are correct for that. It also
 * carries no id per row, so nothing in it can be acted on. This is the security inventory: every
 * session, no filters, each revocable.
 *
 * Backed by /api/admin/devices, which is gated on super_admin rather than the two-clause admin check
 * used elsewhere, because it exposes every user's IP and location.
 */
const AllDevices = ({ token, serverUrl, onLogout }) => {
    const [devices, setDevices] = useState([]);
    // Kept distinct from an empty list: an un-restarted server 404s the route, and "no devices" would
    // be a claim the reader can disprove by looking at the screen they are reading it on. It is also
    // the real intermediate state, since deploying the client and restarting the server are separate.
    const [unavailable, setUnavailable] = useState(false);
    const { confirm } = useDialogs();
    const toast = useToast();

    const loadDevices = async () => {
        try {
            const res = await apiFetch(serverUrl, '/api/admin/devices', token);
            if (!res.ok) { setUnavailable(true); return; }
            setDevices((await res.json()).devices || []);
            setUnavailable(false);
        } catch (e) {
            setUnavailable(true);
        }
    };

    // One-shot plus a refetch after a revoke, not polled. The sibling cards on this tab poll at 2s
    // because they show live telemetry; this is a list that changes on login and logout.
    useEffect(() => {
        if (token) loadDevices();
        else setDevices([]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, serverUrl]);

    const handleSignOut = async (d) => {
        const label = d.device || 'Unknown Device';

        // The viewer's own session never goes through the API: deleting your own row from a live page
        // leaves it 401ing on every poll in a half-logged-in state. onLogout clears up properly.
        if (d.isCurrent) {
            const ok = await confirm({
                title: 'Sign out this device?',
                message: `${label} is the device you are using, so you will be returned to the login screen.`,
                confirmLabel: 'Sign Out',
                danger: true,
            });
            if (ok) onLogout?.();
            return;
        }

        // A super_admin's session gets its own wording. The server does not block this — the guard is
        // that whose session it is, is said out loud before the question.
        const isOwner = d.role === 'super_admin';
        const ok = await confirm({
            title: isOwner ? 'Sign out a Super Admin?' : 'Sign out this device?',
            message: isOwner
                ? `${label} belongs to ${d.username}, who is a Super Admin. They will have to sign in again.`
                : `${label} belongs to ${d.username}. They will have to sign in again, and anything already playing may continue until it stops.`,
            confirmLabel: 'Sign Out',
            danger: true,
        });
        if (!ok) return;

        try {
            const res = await apiFetch(serverUrl, `/api/admin/devices/${d.id}`, token, { method: 'DELETE' });
            if (!res.ok) {
                const data = await parseJsonSafe(res);
                toast.error(`Sign out failed: ${data.error || res.statusText}`);
                return;
            }
            toast.success(`Signed out ${label}`);
            loadDevices();
        } catch (e) {
            toast.error(`Sign out failed: ${e.message}`);
        }
    };

    return (
        <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                <h3 className="font-bold text-white flex items-center gap-2">
                    <Laptop className="w-4 h-4 text-green-500" /> All Devices ({devices.length})
                </h3>
            </div>
            {unavailable ? (
                <div className="p-6 text-sm text-gray-500 italic">
                    Device list isn&apos;t available on this server version.
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-800/50 text-gray-400 font-medium text-xs uppercase">
                            <tr>
                                <th className="px-6 py-3">User</th>
                                <th className="px-6 py-3">Device</th>
                                <th className="px-6 py-3">Location</th>
                                <th className="px-6 py-3">Last Active</th>
                                <th className="px-6 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {devices.length === 0 ? (
                                <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500 italic">No sessions</td></tr>
                            ) : devices.map((d) => {
                                const Icon = deviceIcon(d.deviceKind);
                                return (
                                    <tr key={d.id} className="hover:bg-gray-800/30">
                                        <td className="px-6 py-3">
                                            <div className="font-bold text-white">{d.username}</div>
                                            <div className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">
                                                {ROLE_LABEL[d.role] || d.role}
                                            </div>
                                        </td>
                                        <td className="px-6 py-3">
                                            <div className="flex items-center gap-2">
                                                {/* The server's normalized kind, not raw device_type — that is what
                                                    drops 'Android TV' to a desktop icon in the card above. */}
                                                <Icon className="w-4 h-4 text-gray-400 shrink-0" />
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-white truncate">{d.device || 'Unknown Device'}</span>
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
                                            {/* Hidden for the viewer's own row when no onLogout was passed, so this
                                                can never strand a caller on a dead token. */}
                                            {(!d.isCurrent || onLogout) && (
                                                <button
                                                    onClick={() => handleSignOut(d)}
                                                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold text-red-400 hover:text-white hover:bg-red-600/80 transition-colors"
                                                >
                                                    <XCircle className="w-3.5 h-3.5" /> Sign Out
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default AllDevices;

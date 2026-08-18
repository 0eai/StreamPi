import React, { useState, useEffect } from 'react';
import { User, Lock, KeyRound, Server, Plus, ExternalLink, Share2, Film, Tv, Trash2, Copy, Check } from 'lucide-react';
import ActivityLog from './ActivityLog';
import AddNodeModal from './AddNodeModal';
import TransferNodeModal from './TransferNodeModal';
import MyDevices from './MyDevices';
import { useDialogs } from './ui/dialogs';
import { useToast } from './ui/toast';
import CredentialsModal from './CredentialsModal';
import NodeDetailModal from './NodeDetailModal';
import UserManagement from './UserManagement';
import ChangePasswordModal from './ChangePasswordModal';
import LinkKunjiModal from './LinkKunjiModal';
import { formatBytes } from '../utils/format';
import { usePolling } from '../utils/usePolling';
import { apiFetch, parseJsonSafe } from '../utils/api';
import { copyToClipboard } from '../utils/clipboard';

const isAdmin = (role) => role === 'admin' || role === 'super_admin';

// Everyone gets the Account card (moved out of the header dropdown, which used to be the only
// way to reach change-password/Kunji-link). Admins additionally get User Management, Nodes,
// and Activity Log — previously all three lived inside DashboardTab.jsx.
const SettingsTab = ({ token, serverUrl, username, role, onLogout }) => {
    const { confirm } = useDialogs();
    const toast = useToast();
    const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
    const [isKunjiModalOpen, setIsKunjiModalOpen] = useState(false);
    const [kunjiLinked, setKunjiLinked] = useState(false);

    const [nodes, setNodes] = useState([]);
    const [ownerCandidates, setOwnerCandidates] = useState([]);
    const [addNodeOpen, setAddNodeOpen] = useState(false);
    const [nodeCredentials, setNodeCredentials] = useState(null);
    const [selectedNode, setSelectedNode] = useState(null);
    const [transferNode, setTransferNode] = useState(null);

    const [shares, setShares] = useState([]);
    const [copiedShareToken, setCopiedShareToken] = useState(null);

    const loadShares = async () => {
        try {
            const res = await apiFetch(serverUrl, '/api/share/mine', token);
            if (res.ok) setShares((await res.json()).shares || []);
        } catch (e) { /* ignore — section just shows whatever it last had */ }
    };

    useEffect(() => {
        if (token) loadShares();
        else setShares([]);
    }, [token]);

    const handleCopyShareLink = (shareToken) => {
        copyToClipboard(`${window.location.origin}/share/${shareToken}`)
            .then(() => { setCopiedShareToken(shareToken); setTimeout(() => setCopiedShareToken(null), 1500); })
            .catch(() => toast.error("Couldn't copy automatically — select the text and copy it manually."));
    };

    const handleRevokeShare = async (shareToken) => {
        if (!await confirm('Revoke this share link? Anyone using it will lose access immediately.')) return;
        try {
            const res = await apiFetch(serverUrl, `/api/share/${shareToken}`, token, { method: 'DELETE' });
            if (!res.ok) {
                const data = await parseJsonSafe(res);
                toast.error(`Revoke failed: ${data.error || res.statusText}`);
                return;
            }
            loadShares();
        } catch (e) { toast.error("Revoke failed: " + e.message); }
    };

    const refreshKunjiLinkStatus = async (t) => {
        try {
            const res = await apiFetch(serverUrl, '/api/auth/kunji/link-status', t);
            if (res.ok) setKunjiLinked((await res.json()).linked);
        } catch (e) { /* ignore, section just shows the default "Link" state */ }
    };

    useEffect(() => {
        if (token) refreshKunjiLinkStatus(token);
        else setKunjiLinked(false);
    }, [token]);

    const handleUnlinkKunji = async () => {
        if (!await confirm('Unlink your Kunji identity from this account? You can always link it again later.')) return;
        try {
            const res = await apiFetch(serverUrl, '/api/auth/kunji/unlink', token, { method: 'POST' });
            if (res.ok) setKunjiLinked(false);
            else {
                const data = await parseJsonSafe(res);
                toast.error('Unlink failed: ' + (data.error || res.statusText));
            }
        } catch (e) { toast.error('Unlink failed: ' + e.message); }
    };

    // Admin-only data — skipped entirely for a regular user rather than polling endpoints
    // whose result they'd never see, matching the same "don't show/fetch what 403s or doesn't
    // apply" spirit already used for the Dashboard tab's own admin gating.
    const offline = usePolling(async () => {
        if (!isAdmin(role)) return;
        const [dashRes, usersRes] = await Promise.all([
            apiFetch(serverUrl, '/api/admin/dashboard', token),
            apiFetch(serverUrl, '/api/admin/users', token)
        ]);
        if (!dashRes.ok || !usersRes.ok) throw new Error('Settings poll failed');
        const dash = await dashRes.json();
        setNodes(dash.nodes || []);
        setOwnerCandidates(await usersRes.json());
    }, 2000, [token, serverUrl, role]);

    const handleRegenerateNode = async (node) => {
        if (!await confirm(`Regenerate the API key for "${node.name}"? The old key stops working immediately.`)) return;
        try {
            const res = await apiFetch(serverUrl, `/api/admin/nodes/${node.id}/regenerate`, token, { method: 'POST' });
            const result = await parseJsonSafe(res);
            if (!res.ok) { toast.error(`Regenerate failed: ${result.error || res.statusText}`); return; }
            setNodeCredentials(result);
        } catch (e) { toast.error("Regenerate failed: " + e.message); }
    };

    const handleRemoveNode = async (node) => {
        if (!await confirm(`Remove node "${node.name}"? This cannot be undone.`)) return;
        try {
            const res = await apiFetch(serverUrl, `/api/admin/nodes/${node.id}`, token, { method: 'DELETE' });
            if (!res.ok) {
                const result = await parseJsonSafe(res);
                toast.error(`Remove failed: ${result.error || res.statusText}`);
            }
        } catch (e) { toast.error("Remove failed: " + e.message); }
    };

    const setOwner = async (node, ownerUserId) => {
        const res = await apiFetch(serverUrl, `/api/admin/nodes/${node.id}/owner`, token, { method: 'POST', json: { ownerUserId } });
        if (!res.ok) {
            const result = await parseJsonSafe(res);
            throw new Error(result.error || res.statusText);
        }
    };

    const handleTransferNode = async (ownerUserId) => {
        const node = transferNode;
        try {
            await setOwner(node, ownerUserId);
            setTransferNode(null);
        } catch (e) { toast.error("Transfer failed: " + e.message); }
    };

    const handleReleaseNode = async ({ regenerate }) => {
        const node = transferNode;
        if (regenerate && !await confirm({
            title: 'Release and regenerate the key?',
            message: `The old key stops working immediately, so "${node.name}" cannot register again until the new key is in its node_config.json.`,
            confirmLabel: 'Release + Regenerate',
            danger: true,
        })) return;

        try {
            await setOwner(node, null);
        } catch (e) {
            toast.error("Release failed: " + e.message);
            return;
        }
        setTransferNode(null);
        if (!regenerate) return;

        // Second leg. The release already succeeded, so a failure here has to say so precisely: the
        // node is now unowned with a key its previous owner still holds, which is a claimable state.
        try {
            const res = await apiFetch(serverUrl, `/api/admin/nodes/${node.id}/regenerate`, token, { method: 'POST' });
            const result = await parseJsonSafe(res);
            if (!res.ok) {
                toast.error(`Released, but the key was NOT regenerated (${result.error || res.statusText}) — the previous owner can still claim it. Use Regenerate to finish.`);
                return;
            }
            setNodeCredentials(result);
        } catch (e) {
            toast.error(`Released, but the key was NOT regenerated (${e.message}) — the previous owner can still claim it. Use Regenerate to finish.`);
        }
    };

    return (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8 pb-12">
            {offline && isAdmin(role) && (
                <div className="flex items-center gap-2 text-sm font-bold text-red-400 bg-red-900/20 border border-red-900/50 rounded-lg px-4 py-2.5">
                    Lost connection to the server — showing the last known data while retrying.
                </div>
            )}

            {/* ACCOUNT — available to every logged-in user */}
            <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                    <h3 className="font-bold text-white flex items-center gap-2"><User className="w-4 h-4 text-blue-500" /> Account</h3>
                </div>
                <div className="p-6 flex flex-col gap-4">
                    <div>
                        <div className="text-lg font-bold text-white">{username}</div>
                        <div className="text-xs text-gray-500 uppercase font-bold tracking-wider mt-0.5">{role === 'super_admin' ? 'Super Admin' : role === 'public' ? 'User' : role}</div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                        <button
                            onClick={() => setIsPasswordModalOpen(true)}
                            className="inline-flex items-center gap-2 text-sm text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg border border-gray-700 transition-colors"
                        >
                            <Lock className="w-4 h-4 text-warning" /> Change Password
                        </button>
                        <button
                            onClick={() => kunjiLinked ? handleUnlinkKunji() : setIsKunjiModalOpen(true)}
                            className="inline-flex items-center gap-2 text-sm text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg border border-gray-700 transition-colors"
                        >
                            <KeyRound className="w-4 h-4 text-warning" /> {kunjiLinked ? 'Unlink Kunji Account' : 'Link Kunji Account'}
                        </button>
                    </div>
                </div>
            </div>

            {/* MY SHARES — available to every logged-in user, matching Account above */}
            <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                    <h3 className="font-bold text-white flex items-center gap-2"><Share2 className="w-4 h-4 text-purple-500" /> My Shares</h3>
                </div>
                {shares.length === 0 ? (
                    <div className="p-6 text-sm text-gray-500 italic">No active share links yet — use the Share button on a movie, episode, or series to create one.</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-800/50 text-gray-400 font-medium text-xs uppercase">
                                <tr>
                                    <th className="px-6 py-3">Title</th>
                                    <th className="px-6 py-3">Type</th>
                                    <th className="px-6 py-3">Created</th>
                                    <th className="px-6 py-3">Views</th>
                                    <th className="px-6 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                                {shares.map((s) => (
                                    <tr key={s.token} className="hover:bg-gray-800/30">
                                        <td className="px-6 py-3 font-bold text-white">{s.title}</td>
                                        <td className="px-6 py-3">
                                            <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                                                {s.shareType === 'series' ? <Tv className="w-3.5 h-3.5" /> : <Film className="w-3.5 h-3.5" />}
                                                {s.shareType === 'series' ? 'Series' : 'File'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-3 text-gray-400 text-xs">{new Date(s.createdAt).toLocaleDateString()}</td>
                                        <td className="px-6 py-3 text-gray-400 text-xs">{s.viewCount}</td>
                                        <td className="px-6 py-3 text-right">
                                            <button onClick={() => handleCopyShareLink(s.token)} className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400 font-medium mr-3">
                                                {copiedShareToken === s.token ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy
                                            </button>
                                            <button onClick={() => handleRevokeShare(s.token)} className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-400 font-medium">
                                                <Trash2 className="w-3.5 h-3.5" /> Revoke
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* MY DEVICES — every logged-in user, like Account and My Shares above. The only place
                a non-admin can see or revoke their own sign-ins. */}
            <MyDevices token={token} serverUrl={serverUrl} onLogout={onLogout} />

            {isAdmin(role) && (
                <>
                    <UserManagement token={token} serverUrl={serverUrl} />

                    {/* NODES (merged transcoder + NAS) */}
                    <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden">
                        <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                            <h3 className="font-bold text-white flex items-center gap-2"><Server className="w-4 h-4 text-purple-500" /> Nodes</h3>
                            <button onClick={() => setAddNodeOpen(true)} className="inline-flex items-center gap-1 text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 px-3 py-1.5 rounded transition-colors">
                                <Plus className="w-3.5 h-3.5" /> Add Node
                            </button>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-gray-800/50 text-gray-400 font-medium text-xs uppercase">
                                    <tr>
                                        <th className="px-6 py-3">Node</th>
                                        <th className="px-6 py-3">Roles</th>
                                        <th className="px-6 py-3">Status</th>
                                        <th className="px-6 py-3 w-28">CPU</th>
                                        <th className="px-6 py-3 w-28">RAM</th>
                                        <th className="px-6 py-3 w-40">Disk</th>
                                        <th className="px-6 py-3">Job</th>
                                        <th className="px-6 py-3">Owner</th>
                                        <th className="px-6 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-800">
                                    {nodes.length === 0 ? (
                                        <tr><td colSpan="9" className="px-6 py-8 text-center text-gray-500 italic">No nodes registered yet</td></tr>
                                    ) : (
                                        nodes.map((n) => (
                                            <tr key={n.id} className="hover:bg-gray-800/30 cursor-pointer" onClick={() => setSelectedNode(n)}>
                                                <td className="px-6 py-3">
                                                    <div className="font-bold text-white">{n.name}</div>
                                                    <div className="text-[10px] text-gray-500 font-mono">{n.id}</div>
                                                    {n.connection && <div className="text-[10px] text-gray-600 font-mono">{n.connection}</div>}
                                                </td>
                                                {/* Roles are no longer chosen at creation — they come from what the node
                                                    reports about itself, so a node that has never connected has none yet.
                                                    A dash says that; the bare empty div this used to render just looked
                                                    like a rendering bug. */}
                                                <td className="px-6 py-3">
                                                    {n.roles.length === 0 ? <span className="text-gray-600">—</span> : (
                                                        <div className="flex gap-1">
                                                            {n.roles.includes('transcoder') && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-900/40 text-purple-300">TRANSCODER</span>}
                                                            {n.roles.includes('nas') && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-900/40 text-orange-300">NAS</span>}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-6 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <span className={`w-2 h-2 rounded-full ${n.status === 'Online' ? 'bg-green-500' : n.status === 'Offline' ? 'bg-red-500' : 'bg-gray-600'}`} />
                                                        <span className="text-gray-300 text-xs">{n.status}</span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-3">
                                                    <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${n.cpu}%` }} /></div>
                                                    <div className="text-[9px] text-gray-500 mt-1 text-center">{Math.round(n.cpu)}%</div>
                                                </td>
                                                <td className="px-6 py-3">
                                                    <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-purple-500 transition-all duration-500" style={{ width: `${n.ram}%` }} /></div>
                                                    <div className="text-[9px] text-gray-500 mt-1 text-center">{Math.round(n.ram)}%</div>
                                                </td>
                                                <td className="px-6 py-3">
                                                    {n.disk ? (
                                                        <>
                                                            <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                                                                <span className={n.disk.percent > 90 ? "text-red-400 font-bold" : ""}>{Math.round(n.disk.percent)}%</span>
                                                                <span>{formatBytes(n.disk.free)} free</span>
                                                            </div>
                                                            <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                                                <div className={`h-full transition-all duration-500 ${n.disk.percent > 90 ? 'bg-red-500' : 'bg-orange-500'}`} style={{ width: `${n.disk.percent}%` }} />
                                                            </div>
                                                        </>
                                                    ) : <span className="text-gray-600 text-xs">—</span>}
                                                </td>
                                                <td className="px-6 py-3 text-xs">
                                                    {n.activeJob ? (
                                                        <span className="text-yellow-500 font-bold uppercase">{n.activeJob}</span>
                                                    ) : n.roles.includes('transcoder') ? (
                                                        <span className="text-green-500 font-bold uppercase">Idle</span>
                                                    ) : <span className="text-gray-600">—</span>}
                                                </td>
                                                {/* Read-only. Assignment moved to the Transfer action, because a
                                                    dropdown here changed who could administer a machine on a stray
                                                    scroll, and it listed every user as though ownership meant the same
                                                    for all of them — admins bypass the check, so it doesn't. */}
                                                <td className="px-6 py-3 text-xs">
                                                    {n.ownerUsername
                                                        ? <span className="text-gray-300">{n.ownerUsername}</span>
                                                        : <span className="text-gray-600">—</span>}
                                                </td>
                                                <td className="px-6 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                                                    {n.dashboardUrl && /^https?:\/\//i.test(n.dashboardUrl) && (
                                                        <a href={n.dashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400 font-medium mr-3">
                                                            <ExternalLink className="w-3 h-3" /> Open
                                                        </a>
                                                    )}
                                                    <button onClick={() => setTransferNode(n)} className="text-xs text-green-500 hover:text-green-400 font-medium mr-3">Transfer</button>
                                                    <button onClick={() => handleRegenerateNode(n)} className="text-xs text-yellow-500 hover:text-yellow-400 font-medium mr-3">Regenerate</button>
                                                    <button onClick={() => handleRemoveNode(n)} className="text-xs text-red-500 hover:text-red-400 font-medium">Remove</button>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <ActivityLog token={token} serverUrl={serverUrl} />

                    <TransferNodeModal
                        node={transferNode}
                        users={ownerCandidates}
                        onClose={() => setTransferNode(null)}
                        onTransfer={handleTransferNode}
                        onRelease={handleReleaseNode}
                    />

                    <AddNodeModal
                        isOpen={addNodeOpen}
                        onClose={() => setAddNodeOpen(false)}
                        token={token}
                        serverUrl={serverUrl}
                        onCreated={(creds) => setNodeCredentials(creds)}
                    />
                    <CredentialsModal credentials={nodeCredentials} onClose={() => setNodeCredentials(null)} />
                    <NodeDetailModal node={selectedNode} token={token} serverUrl={serverUrl} onClose={() => setSelectedNode(null)} />
                </>
            )}

            <ChangePasswordModal
                isOpen={isPasswordModalOpen}
                onClose={() => setIsPasswordModalOpen(false)}
                token={token}
                serverUrl={serverUrl}
            />
            <LinkKunjiModal
                isOpen={isKunjiModalOpen}
                onClose={() => setIsKunjiModalOpen(false)}
                token={token}
                serverUrl={serverUrl}
                onLinked={() => setKunjiLinked(true)}
            />
        </div>
    );
};

export default SettingsTab;

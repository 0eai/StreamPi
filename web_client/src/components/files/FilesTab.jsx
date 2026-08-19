import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FolderPlus, UploadCloud, Pencil, FolderInput, Timer, Trash2, Share2, X } from 'lucide-react';
import Button from '../ui/Button';
import { useDialogs } from '../ui/dialogs';
import { useToast } from '../ui/toast';
import { apiFetch, parseJsonSafe, FILES_URL } from '../../utils/api';
import { formatBytes } from '../../utils/format';
import FileBrowser from './FileBrowser';
import MoveFilesModal from './MoveFilesModal';
import AutoDeleteModal from './AutoDeleteModal';
import ShareFileModal from './ShareFileModal';
import { MyFileShares, SharedWithMe, FileTrash } from './FileListViews';

/**
 * The Files tab: uploads, folders, sharing, and the trash.
 *
 * Owns every request and all the state; the pieces under ./ are presentational, which is what makes
 * them testable without a server and keeps the network story in one file.
 *
 * Four sub-views rather than four top-level tabs — they are all one feature, and the nav already has
 * as many entries as it wants.
 */

const VIEWS = [
    { id: 'mine', label: 'My Files' },
    { id: 'shared-with-me', label: 'Shared with me' },
    { id: 'my-shares', label: "What I've shared" },
    { id: 'trash', label: 'Trash' },
];

const FilesTab = ({ token, serverUrl, uploads }) => {
    const { confirm, prompt } = useDialogs();
    const toast = useToast();

    const [view, setView] = useState('mine');
    const [loading, setLoading] = useState(true);
    const [unavailable, setUnavailable] = useState(false);

    const [parentId, setParentId] = useState(null);
    const [trail, setTrail] = useState([]);
    const [items, setItems] = useState([]);
    const [quota, setQuota] = useState(null);
    const [selected, setSelected] = useState(new Set());

    const [readOnlyFolder, setReadOnlyFolder] = useState(null);
    const [myShares, setMyShares] = useState([]);
    const [inbox, setInbox] = useState([]);
    const [trash, setTrash] = useState({ items: [], graceDays: 7 });
    const [users, setUsers] = useState([]);
    const [allFolders, setAllFolders] = useState([]);

    const [moveOpen, setMoveOpen] = useState(false);
    const [expiryItem, setExpiryItem] = useState(null);
    const [shareItem, setShareItem] = useState(null);
    const [menuItem, setMenuItem] = useState(null);
    const [copiedId, setCopiedId] = useState(null);

    const call = useCallback(
        (path, opts) => apiFetch(serverUrl, path, token, opts),
        [serverUrl, token]
    );

    /** Every failure in this tab is reported the same way, so no handler invents its own. */
    const fail = useCallback(async (what, res) => {
        const data = await parseJsonSafe(res);
        toast.error(`${what}: ${data.error || res.statusText}`);
    }, [toast]);

    const loadFolder = useCallback(async (id) => {
        setLoading(true);
        try {
            const res = await call(`/api/files${id ? `?parent=${encodeURIComponent(id)}` : ''}`);
            if (!res.ok) {
                // A 404 on a folder that was open when it got deleted elsewhere should not look like
                // the whole feature is missing.
                if (res.status === 404 && id) { setParentId(null); return; }
                setUnavailable(true);
                return;
            }
            const data = await res.json();
            setUnavailable(false);
            setParentId(data.parent.id);
            setTrail(data.breadcrumb);
            setItems(data.items);
            setQuota(data.quota);
            setSelected(new Set());
        } catch {
            setUnavailable(true);
        } finally {
            setLoading(false);
        }
    }, [call]);

    // One-shot per navigation rather than polled: a file listing does not change under you the way a
    // node's CPU does, and there is nowhere in this tab to report a failed poll.
    useEffect(() => { if (token && view === 'mine') loadFolder(parentId); }, [token, view]); // eslint-disable-line react-hooks/exhaustive-deps

    const loadSideData = useCallback(async () => {
        const [sharesRes, inboxRes, trashRes, usersRes] = await Promise.all([
            call('/api/files/shares/mine'),
            call('/api/files/shared-with-me'),
            call('/api/files/trash'),
            call('/api/users/shareable'),
        ]);
        if (sharesRes.ok) setMyShares((await sharesRes.json()).shares || []);
        if (inboxRes.ok) setInbox((await inboxRes.json()).items || []);
        if (trashRes.ok) setTrash(await trashRes.json());
        if (usersRes.ok) setUsers((await usersRes.json()).users || []);
    }, [call]);

    useEffect(() => { if (token) loadSideData().catch(() => {}); }, [token, view]); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * Every folder the user has, flattened for the move picker.
     *
     * Walked breadth-first through the listing endpoint rather than added as a bespoke server route:
     * a personal file tree is small, this only runs when the move dialog opens, and it avoids a second
     * way of asking the same question.
     */
    const loadAllFolders = useCallback(async () => {
        const root = trail[0];
        if (!root) return [];
        const out = [];
        const queue = [{ id: root.id, name: 'Home', isRoot: true, depth: 0, pathIds: null }];
        // Keyed by node id rather than name: two folders in different places can share a name, and
        // marking the wrong one as shared would make the warning actively misleading.
        const sharedByNode = new Map();
        for (const share of myShares.filter((s) => s.isFolder && s.nodeId)) {
            const label = share.kind === 'link' ? 'anyone with the link' : share.recipient;
            sharedByNode.set(share.nodeId, [...(sharedByNode.get(share.nodeId) || []), label]);
        }

        while (queue.length) {
            const node = queue.shift();
            out.push(node);
            if (out.length > 500) break; // a guard, not a limit anyone should reach
            const res = await call(`/api/files?parent=${encodeURIComponent(node.id)}`);
            if (!res.ok) continue;
            const data = await res.json();
            for (const child of data.items.filter((i) => i.isFolder)) {
                const names = sharedByNode.get(child.id) || [];
                queue.push({
                    id: child.id,
                    name: child.name,
                    depth: node.depth + 1,
                    // Composed from the parent's path so the dialog can exclude a folder's own subtree
                    // without the server having to send path_ids to the client.
                    pathIds: `${node.pathIds || `/${root.id}/`}${child.id}/`,
                    sharedWith: names.length ? names.join(', ') : null,
                });
            }
        }
        return out;
    }, [call, trail, myShares]);

    // --- Actions ---------------------------------------------------------------------------------

    const newFolder = async () => {
        const name = await prompt({ title: 'New folder', label: 'Name', confirmLabel: 'Create' });
        if (!name) return;
        const res = await call('/api/files/folder', { method: 'POST', json: { parentId, name } });
        if (!res.ok) return fail("Couldn't create the folder", res);
        loadFolder(parentId);
    };

    const rename = async (item) => {
        const name = await prompt({ title: `Rename "${item.name}"`, label: 'Name', value: item.name, confirmLabel: 'Rename' });
        if (!name || name === item.name) return;
        const res = await call(`/api/files/${item.id}`, { method: 'PATCH', json: { name } });
        if (!res.ok) return fail("Couldn't rename it", res);
        loadFolder(parentId);
    };

    const remove = async (item) => {
        // The summary is fetched so the confirmation can state what is about to go, rather than asking
        // someone to accept an unknown amount of recursion.
        let detail = '';
        const summaryRes = await call(`/api/files/${item.id}/summary`);
        if (summaryRes.ok) {
            const s = await summaryRes.json();
            if (item.isFolder) detail = ` It holds ${s.files} file${s.files === 1 ? '' : 's'} (${formatBytes(s.bytes)}).`;
        }
        const ok = await confirm({
            title: `Delete "${item.name}"?`,
            message: `It goes to the trash and can be restored for ${trash.graceDays} days.${detail}`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        const res = await call(`/api/files/${item.id}`, { method: 'DELETE' });
        if (!res.ok) return fail("Couldn't delete it", res);
        loadFolder(parentId);
        loadSideData().catch(() => {});
    };

    const bulkDelete = async () => {
        const chosen = items.filter((i) => selected.has(i.id));
        const ok = await confirm({
            title: `Delete ${chosen.length} item${chosen.length === 1 ? '' : 's'}?`,
            message: `They go to the trash and can be restored for ${trash.graceDays} days.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        const failures = [];
        for (const item of chosen) {
            const res = await call(`/api/files/${item.id}`, { method: 'DELETE' });
            if (!res.ok) failures.push(item.name);
        }
        if (failures.length) toast.error(`Couldn't delete: ${failures.join(', ')}`);
        loadFolder(parentId);
        loadSideData().catch(() => {});
    };

    const openMove = async () => {
        setAllFolders(await loadAllFolders());
        setMoveOpen(true);
    };

    const doMove = async (destinationId) => {
        const ids = [...selected];
        const res = await call('/api/files/move', { method: 'POST', json: { ids, destinationId } });
        if (!res.ok) return fail("Couldn't move", res);
        const data = await res.json();
        const failed = data.results.filter((r) => !r.ok);
        // Partial success is the normal case for a bulk move, so it is reported rather than smoothed
        // over: a collision on one item must not read as "moved" for all of them.
        if (failed.length) {
            toast.error(`Moved ${data.moved} of ${ids.length}. ${failed[0].error}`);
        } else {
            toast.success(`Moved ${data.moved} item${data.moved === 1 ? '' : 's'}.`);
        }
        setMoveOpen(false);
        loadFolder(parentId);
    };

    const saveExpiry = async (expiresInHours) => {
        const res = await call(`/api/files/${expiryItem.id}`, { method: 'PATCH', json: { expiresInHours } });
        if (!res.ok) return fail("Couldn't set auto-delete", res);
        setExpiryItem(null);
        loadFolder(parentId);
    };

    /** Bytes always come from the files origin, never this one — see api.js for why. */
    const withByteToken = async (item, { inline = false } = {}) => {
        const res = await call(`/api/files/${item.id}/token`, { method: 'POST', json: { inline } });
        if (!res.ok) { await fail("Couldn't open that file", res); return null; }
        const { path } = await res.json();
        return `${FILES_URL}${path}`;
    };

    const download = async (item) => {
        const url = await withByteToken(item);
        if (url) window.location.assign(url);
    };

    const preview = async (item) => {
        const url = await withByteToken(item, { inline: true });
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    };

    const shareWithUsers = async (recipientUserIds, expiresInHours) => {
        const res = await call(`/api/files/${shareItem.id}/share`, {
            method: 'POST', json: { kind: 'user', recipientUserIds, expiresInHours },
        });
        if (!res.ok) return fail("Couldn't share", res);
        const data = await res.json();
        const failed = data.results.filter((r) => !r.ok);
        if (failed.length) toast.error(`Shared with ${data.granted}. ${failed[0].error}`);
        else toast.success(`Shared with ${data.granted} ${data.granted === 1 ? 'person' : 'people'}.`);
        setShareItem(null);
        loadSideData().catch(() => {});
    };

    const createLink = async (expiresInHours) => {
        const res = await call(`/api/files/${shareItem.id}/share`, {
            method: 'POST', json: { kind: 'link', expiresInHours },
        });
        if (!res.ok) { await fail("Couldn't create the link", res); return null; }
        const { token: shareToken } = await res.json();
        loadSideData().catch(() => {});
        return `${window.location.origin}/f/${shareToken}`;
    };

    const revokeShare = async (share) => {
        const ok = await confirm({
            title: 'Revoke this share?',
            message: share.kind === 'link'
                ? 'The link stops working immediately.'
                : `${share.recipient} loses access immediately.`,
            confirmLabel: 'Revoke',
            danger: true,
        });
        if (!ok) return;
        const res = await call(`/api/files/share/${share.id}`, { method: 'DELETE' });
        if (!res.ok) return fail("Couldn't revoke it", res);
        loadSideData().catch(() => {});
    };

    const shareExpiry = async (share) => {
        const hours = await prompt({
            title: 'Expire this share after…',
            message: 'Hours from now. Leave it empty for no expiry.',
            label: 'Hours',
            value: '',
            confirmLabel: 'Save',
        });
        // prompt resolves null when cancelled and a trimmed string otherwise, so an empty answer here
        // genuinely means "clear it".
        if (hours === null) return;
        const res = await call(`/api/files/share/${share.id}`, { method: 'PATCH', json: { expiresInHours: hours } });
        if (!res.ok) return fail("Couldn't change the expiry", res);
        loadSideData().catch(() => {});
    };

    const copyLink = (share) => {
        const url = `${window.location.origin}/f/${share.token}`;
        navigator.clipboard?.writeText?.(url).then(
            () => { setCopiedId(share.id); setTimeout(() => setCopiedId(null), 1500); },
            () => toast.error(`Copy this manually: ${url}`)
        );
    };

    const restore = async (item) => {
        const res = await call(`/api/files/${item.id}/restore`, { method: 'POST' });
        if (!res.ok) return fail("Couldn't restore it", res);
        toast.success(`Restored "${item.name}".`);
        loadSideData().catch(() => {});
        loadFolder(parentId);
    };

    const purge = async (item) => {
        const ok = await confirm({
            title: `Permanently delete "${item.name}"?`,
            message: 'This cannot be undone — it skips the rest of the recovery window.',
            confirmLabel: 'Delete for good',
            danger: true,
        });
        if (!ok) return;
        const res = await call(`/api/files/${item.id}/purge`, { method: 'DELETE' });
        if (!res.ok) return fail("Couldn't delete it", res);
        loadSideData().catch(() => {});
    };

    const openSharedFolder = async (entry) => {
        const res = await call(`/api/files/shared/${entry.id}`);
        if (!res.ok) return fail("Couldn't open that folder", res);
        const data = await res.json();
        setReadOnlyFolder({ owner: data.parent.owner, name: data.parent.name, items: data.items });
    };

    // Debounced so a folder upload of 400 files refreshes the listing once rather than 400 times.
    const refreshTimer = useRef(null);
    useEffect(() => {
        const done = uploads?.uploads?.filter((u) => u.kind === 'file' && u.status === 'done').length || 0;
        if (!done) return;
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => loadFolder(parentId), 600);
        return () => clearTimeout(refreshTimer.current);
    }, [uploads?.uploads, parentId]); // eslint-disable-line react-hooks/exhaustive-deps

    const startUpload = (files, useRelativePaths) => {
        if (!files.length) return;
        const queue = async () => {
            const byDir = new Map();
            for (const file of files) {
                const rel = useRelativePaths ? (file.webkitRelativePath || '') : '';
                const segments = rel.split('/').slice(0, -1).filter(Boolean);
                const key = segments.join('/');
                if (!byDir.has(key)) byDir.set(key, { segments, files: [] });
                byDir.get(key).files.push(file);
            }

            const items = [];
            for (const { segments, files: group } of byDir.values()) {
                let target = parentId;
                if (segments.length) {
                    const res = await call('/api/files/folders/ensure', { method: 'POST', json: { parentId, segments } });
                    if (!res.ok) { await fail("Couldn't create the folders", res); continue; }
                    target = (await res.json()).item.id;
                }
                // One request per file, carrying only the folder id — so the server never parses a path.
                for (const file of group) items.push({ kind: 'file', file, name: file.name, parentId: target });
            }
            if (items.length) uploads.handleStartUpload(items);
        };
        queue().catch((e) => toast.error(`Upload failed to start: ${e.message}`));
    };

    const filesInput = useRef(null);
    const folderInput = useRef(null);

    const selectedItems = items.filter((i) => selected.has(i.id));

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-1 bg-surface border border-border rounded-lg p-1">
                    {VIEWS.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => { setView(v.id); setReadOnlyFolder(null); }}
                            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${view === v.id
                                ? 'bg-accent-soft text-accent font-medium'
                                : 'text-muted hover:text-text hover:bg-surface-2'}`}
                        >
                            {v.label}
                            {v.id === 'shared-with-me' && inbox.length > 0 && (
                                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-success/20 text-success text-[10px] font-bold">
                                    {inbox.length}
                                </span>
                            )}
                            {v.id === 'trash' && trash.items.length > 0 && (
                                <span className="ml-1.5 text-muted-2 text-[10px]">{trash.items.length}</span>
                            )}
                        </button>
                    ))}
                </div>

                {view === 'mine' && !unavailable && (
                    <div className="flex items-center gap-2">
                        {quota && (
                            <span className="text-xs text-muted mr-1">
                                {formatBytes(quota.used)} of {formatBytes(quota.limit)} used
                            </span>
                        )}
                        <Button variant="ghost" onClick={newFolder}>
                            <FolderPlus className="w-4 h-4" /> New Folder
                        </Button>
                        {/* Upload lives here rather than in the nav because it needs a destination —
                            "into the folder you are looking at" — which a global button cannot express. */}
                        <Button variant="ghost" onClick={() => filesInput.current?.click()}>
                            <UploadCloud className="w-4 h-4" /> Upload Files
                        </Button>
                        <Button variant="ghost" onClick={() => folderInput.current?.click()}>
                            <UploadCloud className="w-4 h-4" /> Upload Folder
                        </Button>
                        <input
                            ref={filesInput} type="file" multiple className="hidden" aria-label="Upload files"
                            onChange={(e) => { startUpload(Array.from(e.target.files), false); e.target.value = ''; }}
                        />
                        {/* webkitdirectory is unsupported on iOS Safari, so the files button above stays
                            the path that always works. */}
                        <input
                            ref={folderInput} type="file" multiple webkitdirectory="" directory="" className="hidden" aria-label="Upload folder"
                            onChange={(e) => { startUpload(Array.from(e.target.files), true); e.target.value = ''; }}
                        />
                    </div>
                )}
            </div>

            {view === 'mine' && (
                <>
                    {selected.size > 0 && (
                        <div className="flex items-center gap-3 px-4 py-2 bg-accent-soft border border-accent/30 rounded-lg">
                            <span className="text-sm text-text font-medium">{selected.size} selected</span>
                            <Button variant="ghost" onClick={openMove}><FolderInput className="w-4 h-4" /> Move to…</Button>
                            <Button variant="danger" onClick={bulkDelete}><Trash2 className="w-4 h-4" /> Delete</Button>
                            <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted hover:text-text">
                                Clear
                            </button>
                        </div>
                    )}

                    <FileBrowser
                        trail={trail}
                        items={items}
                        selected={selected}
                        loading={loading}
                        unavailable={unavailable}
                        onNavigate={(c) => { setParentId(c.id); loadFolder(c.id); }}
                        onToggle={(id) => setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) next.delete(id); else next.add(id);
                            return next;
                        })}
                        onToggleAll={(all) => setSelected(all ? new Set(items.map((i) => i.id)) : new Set())}
                        onOpenMenu={setMenuItem}
                        onDownload={download}
                        onPreview={preview}
                    />
                </>
            )}

            {view === 'shared-with-me' && (
                readOnlyFolder ? (
                    <div className="space-y-3">
                        <button onClick={() => setReadOnlyFolder(null)} className="text-sm text-muted hover:text-text inline-flex items-center gap-1">
                            <X className="w-4 h-4" /> Back to Shared with me
                        </button>
                        <p className="text-xs text-muted-2">
                            {readOnlyFolder.name} — shared by {readOnlyFolder.owner}. View and download only.
                        </p>
                        <FileBrowser
                            trail={[{ id: 'ro', name: readOnlyFolder.name }]}
                            items={readOnlyFolder.items}
                            readOnly
                            onNavigate={() => {}}
                            onDownload={download}
                            onPreview={preview}
                        />
                    </div>
                ) : (
                    <SharedWithMe items={inbox} onOpen={openSharedFolder} onDownload={download} />
                )
            )}

            {view === 'my-shares' && (
                <MyFileShares
                    shares={myShares}
                    copiedId={copiedId}
                    onCopy={copyLink}
                    onExpiry={shareExpiry}
                    onRevoke={revokeShare}
                />
            )}

            {view === 'trash' && (
                <FileTrash items={trash.items} graceDays={trash.graceDays} onRestore={restore} onPurge={purge} />
            )}

            {/* A row's actions as a small sheet rather than a hover menu — the app has no dropdown
                primitive, and a modal is both testable and reachable by keyboard. */}
            {menuItem && (
                <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 p-4" onClick={() => setMenuItem(null)}>
                    <div className="bg-surface border border-border rounded-lg w-full max-w-xs overflow-hidden" onClick={(e) => e.stopPropagation()}>
                        <div className="px-4 py-3 border-b border-border text-sm font-bold text-text truncate">{menuItem.name}</div>
                        {[
                            { label: 'Share', Icon: Share2, run: () => setShareItem(menuItem) },
                            { label: 'Rename', Icon: Pencil, run: () => rename(menuItem) },
                            { label: 'Move to…', Icon: FolderInput, run: async () => { setSelected(new Set([menuItem.id])); await openMove(); } },
                            { label: 'Auto-delete…', Icon: Timer, run: () => setExpiryItem(menuItem) },
                            { label: 'Delete', Icon: Trash2, run: () => remove(menuItem), danger: true },
                        ].map(({ label, Icon, run, danger }) => (
                            <button
                                key={label}
                                onClick={() => { const item = menuItem; setMenuItem(null); run(item); }}
                                className={`w-full px-4 py-3 flex items-center gap-3 text-sm text-left hover:bg-surface-2 ${danger ? 'text-danger' : 'text-text'}`}
                            >
                                <Icon className="w-4 h-4" /> {label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <MoveFilesModal
                isOpen={moveOpen}
                onClose={() => setMoveOpen(false)}
                onMove={doMove}
                items={selectedItems}
                folders={allFolders}
                currentParentId={parentId}
            />

            <AutoDeleteModal
                item={expiryItem}
                graceDays={trash.graceDays}
                onClose={() => setExpiryItem(null)}
                onSave={saveExpiry}
            />

            <ShareFileModal
                item={shareItem}
                users={users}
                onClose={() => setShareItem(null)}
                onShareWithUsers={shareWithUsers}
                onCreateLink={createLink}
            />
        </div>
    );
};

export default FilesTab;

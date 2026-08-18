import React, { useState } from 'react';
import { UserCog } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';

const isAdminRole = (role) => role === 'admin' || role === 'super_admin';

/**
 * Assigns or releases a node's owner.
 *
 * Ownership is what opens the node-owner routes to a non-admin, so this exists as a deliberate act
 * rather than the inline dropdown it replaced. That dropdown changed ownership on a stray scroll, and
 * it offered every user identically — including the admins for whom ownership grants nothing, since
 * they bypass the check entirely. Hence the annotation: the field used to imply it was granting access
 * it wasn't.
 *
 * Presentational. The caller owns both API calls, because releasing is really two decisions and the
 * second one (regenerating) is shared with the Regenerate action in the same row.
 */
const TransferNodeModal = ({ node, users, onClose, onTransfer, onRelease }) => {
    const [selected, setSelected] = useState('');
    const [busy, setBusy] = useState(false);

    if (!node) return null;

    const currentOwner = users.find((u) => u.id === node.ownerUserId);
    const picked = users.find((u) => String(u.id) === selected);
    // Reassigning to the current owner is a no-op, so it isn't offered as an action.
    const canTransfer = !!selected && Number(selected) !== node.ownerUserId;

    const run = async (fn) => {
        setBusy(true);
        try { await fn(); } finally { setBusy(false); }
    };

    return (
        <Modal isOpen onClose={onClose} title={<><UserCog className="w-5 h-5 text-green-500" /> Ownership of &ldquo;{node.name}&rdquo;</>}>
            <p className="text-sm text-muted">
                {currentOwner ? (
                    <>Owned by <span className="font-bold text-white">{currentOwner.username}</span>
                        {isAdminRole(currentOwner.role)
                            ? ' — who is an admin, so this grants them no access they did not already have. It does stop anyone else claiming the node.'
                            : ', who can manage this node from its own dashboard without being an admin.'}
                    </>
                ) : node.ownerUserId ? (
                    <>Owned by a user account that no longer exists. Release it to make the node claimable again.</>
                ) : (
                    <>No owner. Whoever holds this node&apos;s API key can claim it from the node&apos;s own dashboard, or you can assign it here.</>
                )}
            </p>

            <label className="block mt-6 mb-1 text-xs text-gray-500 uppercase font-bold" htmlFor="transfer-owner">Assign to</label>
            <select
                id="transfer-owner"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-green-500 outline-none"
            >
                <option value="">Select a user…</option>
                {users.map((u) => (
                    <option key={u.id} value={u.id} disabled={u.id === node.ownerUserId}>
                        {u.username}
                        {u.id === node.ownerUserId ? ' (current owner)' : isAdminRole(u.role) ? ' (admin — full access already)' : ''}
                    </option>
                ))}
            </select>
            {picked && !isAdminRole(picked.role) && (
                <p className="mt-2 text-[11px] text-gray-500">
                    {picked.username} will be able to view this node&apos;s stats, edit its storage locations, restart
                    it and browse its files — this node only.
                </p>
            )}

            <div className="flex justify-end gap-2 mt-4">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button variant="primary" disabled={!canTransfer || busy} onClick={() => run(() => onTransfer(Number(selected)))}>
                    {busy ? 'Working…' : 'Transfer'}
                </Button>
            </div>

            {/* Releasing is its own section rather than a "— None —" row in the picker above: it is the
                one path with a consequence that isn't obvious, and it needs two buttons to say so. */}
            {node.ownerUserId && (
                <div className="mt-6 pt-4 border-t border-gray-800">
                    <h4 className="text-sm font-bold text-white">Release ownership</h4>
                    <p className="mt-1 text-[11px] text-gray-500">
                        Clearing the owner does not revoke their access on its own
                        {currentOwner ? ` — ${currentOwner.username} keeps` : ' — they keep'} a copy of this node&apos;s
                        API key and can claim it straight back. Regenerating the key is what locks them out, and means
                        pasting the new key into the node&apos;s <code className="text-gray-400">node_config.json</code>.
                    </p>
                    <div className="flex justify-end gap-2 mt-3">
                        <Button variant="ghost" disabled={busy} onClick={() => run(() => onRelease({ regenerate: false }))}>
                            Release only
                        </Button>
                        <Button variant="danger" disabled={busy} onClick={() => run(() => onRelease({ regenerate: true }))}>
                            Release + Regenerate Key
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
};

export default TransferNodeModal;

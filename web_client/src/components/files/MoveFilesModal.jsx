import React, { useState } from 'react';
import { FolderInput, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

/**
 * Where to move the selected items.
 *
 * A flat indented select rather than a tree: the depth is already in each folder's path, so indenting
 * by it is free, and a real tree widget is a lot of machinery for something used a handful of times.
 *
 * Three kinds of destination are excluded rather than left to fail server-side — the current parent
 * (a no-op), any item being moved, and anything inside one. That last exclusion is the cycle rule,
 * surfaced as a missing option instead of an error after the fact.
 */
const MoveFilesModal = ({ isOpen, onClose, onMove, items = [], folders = [], currentParentId }) => {
    const [destination, setDestination] = useState('');
    const [busy, setBusy] = useState(false);

    if (!isOpen) return null;

    const movingIds = new Set(items.map((i) => i.id));
    const movingPaths = items.filter((i) => i.isFolder).map((i) => i.pathIds).filter(Boolean);

    const choices = folders.filter((f) => {
        if (f.id === currentParentId) return false;
        if (movingIds.has(f.id)) return false;
        return !movingPaths.some((p) => f.pathIds && f.pathIds.startsWith(p));
    });

    const picked = choices.find((f) => f.id === destination);

    const submit = async () => {
        setBusy(true);
        try { await onMove(destination); } finally { setBusy(false); }
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={<><FolderInput className="w-5 h-5 text-accent" /> Move {items.length} item{items.length === 1 ? '' : 's'}</>}
        >
            {choices.length === 0 ? (
                <p className="text-sm text-muted">
                    There is nowhere else to move {items.length === 1 ? 'this' : 'these'} — make another folder first.
                </p>
            ) : (
                <>
                    <label className="block mb-1 text-xs text-muted uppercase font-bold" htmlFor="move-destination">
                        Destination
                    </label>
                    <select
                        id="move-destination"
                        value={destination}
                        onChange={(e) => setDestination(e.target.value)}
                        className="w-full bg-bg border border-border rounded px-3 py-2 text-text text-sm focus:border-accent outline-none"
                    >
                        <option value="">Choose a folder…</option>
                        {choices.map((f) => (
                            <option key={f.id} value={f.id}>
                                {/* Non-breaking spaces: a select collapses ordinary leading whitespace. */}
                                {'  '.repeat(f.depth)}{f.isRoot ? 'Home' : f.name}
                                {f.sharedWith ? '  (shared)' : ''}
                            </option>
                        ))}
                    </select>

                    {picked?.sharedWith && (
                        // The consequence that is genuinely surprising: a folder grant covers everything
                        // inside it, so moving something in widens who can read it.
                        <div className="mt-4 flex gap-2 p-3 rounded-md bg-warning/10 border border-warning/30">
                            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                            <p className="text-xs text-text/90 leading-relaxed">
                                <span className="font-bold">{picked.isRoot ? 'Home' : picked.name}</span> is shared with{' '}
                                {picked.sharedWith}. Anything you move there becomes visible to them, including
                                files added later.
                            </p>
                        </div>
                    )}
                </>
            )}

            <div className="flex justify-end gap-2 mt-6">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button variant="primary" onClick={submit} disabled={!destination || busy}>
                    {busy ? 'Moving…' : 'Move'}
                </Button>
            </div>
        </Modal>
    );
};

export default MoveFilesModal;

import React, { useState } from 'react';
import { Timer, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { formatTimeUntil } from '../../utils/format';

/**
 * Sets how long an item sticks around.
 *
 * The same hour counts share expiry uses, so "30 days" means one thing across the app and both store a
 * canonical timestamp through the same helper.
 *
 * On a folder this is a subtree-wide destructive setting — one dropdown can schedule the deletion of
 * everything beneath it — so the scope is stated before you confirm rather than after.
 */
const OPTIONS = [
    { label: 'Never delete', hours: '' },
    { label: '7 days', hours: 24 * 7 },
    { label: '30 days', hours: 24 * 30 },
    { label: '90 days', hours: 24 * 90 },
];

const AutoDeleteModal = ({ item, graceDays = 7, onClose, onSave }) => {
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);

    if (!item) return null;

    const inherited = item.expiresAt && item.expiresFrom;

    const submit = async () => {
        setBusy(true);
        try { await onSave(choice); } finally { setBusy(false); }
    };

    return (
        <Modal isOpen onClose={onClose} title={<><Timer className="w-5 h-5 text-warning" /> Auto-delete</>}>
            <p className="text-sm text-muted">
                {item.expiresAt ? (
                    <>
                        <span className="font-bold text-text">{item.name}</span> is due to be deleted{' '}
                        <span className="font-bold text-text">{formatTimeUntil(item.expiresAt)}</span>
                        {inherited && <> — inherited from <span className="font-bold text-text">{item.expiresFrom}</span></>}.
                    </>
                ) : (
                    <><span className="font-bold text-text">{item.name}</span> is kept until you delete it.</>
                )}
            </p>

            <label className="block mt-6 mb-1 text-xs text-muted uppercase font-bold" htmlFor="auto-delete">
                Delete after
            </label>
            <select
                id="auto-delete"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className="w-full bg-bg border border-border rounded px-3 py-2 text-text text-sm focus:border-accent outline-none"
            >
                {OPTIONS.map((o) => <option key={o.label} value={o.hours}>{o.label}</option>)}
            </select>
            <p className="mt-2 text-[11px] text-muted-2">Counted from now.</p>

            {item.isFolder && choice !== '' && (
                <div className="mt-4 flex gap-2 p-3 rounded-md bg-warning/10 border border-warning/30">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <p className="text-xs text-text/90 leading-relaxed">
                        This is a folder. <span className="font-bold">Everything inside it</span> will be deleted
                        too, including files added later — and an item&apos;s own longer deadline won&apos;t
                        override this one.
                    </p>
                </div>
            )}

            {inherited && choice !== '' && (
                <p className="mt-3 text-xs text-muted">
                    {item.expiresFrom} still expires first, so that deadline wins.
                </p>
            )}

            <p className="mt-4 text-[11px] text-muted-2">
                Deleted items go to the trash and stay recoverable for {graceDays} days.
            </p>

            <div className="flex justify-end gap-2 mt-6">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
        </Modal>
    );
};

export default AutoDeleteModal;

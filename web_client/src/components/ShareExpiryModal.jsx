import React, { useState } from 'react';
import { Clock } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { formatTimeUntil } from '../utils/format';

/**
 * Sets or clears how long a share link lasts.
 *
 * Expiry is edited here rather than chosen when the link is created, which is what keeps sharing a
 * single click — most links don't want a deadline, and making every share pass through a duration
 * picker to reach the common case is the wrong trade.
 *
 * A fixed set of durations rather than a date input: `type="datetime-local"` renders inconsistently,
 * needs timezone reasoning on both ends, and nobody picking a share expiry wants minute precision.
 * The server takes hours (`expiresInHours`), so these are just hour counts.
 *
 * Presentational — the caller owns the request, following TransferNodeModal.
 */
const OPTIONS = [
    { label: 'Never expires', hours: '' },
    { label: '1 hour', hours: 1 },
    { label: '24 hours', hours: 24 },
    { label: '7 days', hours: 24 * 7 },
    { label: '30 days', hours: 24 * 30 },
];

const ShareExpiryModal = ({ share, onClose, onSave }) => {
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);

    if (!share) return null;

    const submit = async () => {
        setBusy(true);
        try { await onSave(choice); } finally { setBusy(false); }
    };

    return (
        <Modal isOpen onClose={onClose} title={<><Clock className="w-5 h-5 text-purple-500" /> Link expiry</>}>
            <p className="text-sm text-muted">
                {share.expiresAt
                    ? <>This link expires <span className="font-bold text-white">{formatTimeUntil(share.expiresAt)}</span>, on {new Date(share.expiresAt).toLocaleString()}.</>
                    : <>This link never expires. It keeps working until you revoke it.</>}
            </p>

            <label className="block mt-6 mb-1 text-xs text-gray-500 uppercase font-bold" htmlFor="share-expiry">
                Change to
            </label>
            <select
                id="share-expiry"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-purple-500 outline-none"
            >
                {OPTIONS.map((o) => (
                    <option key={o.label} value={o.hours}>{o.label}</option>
                ))}
            </select>
            {/* Durations count from now, not from when the link was made — otherwise "1 hour" on a
                week-old link would expire it instantly, which is not what anyone means by it. */}
            <p className="mt-2 text-[11px] text-gray-500">Counted from now.</p>

            <div className="flex justify-end gap-2 mt-6">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
        </Modal>
    );
};

export default ShareExpiryModal;

import React, { useState } from 'react';
import { Share2, Copy, Check, X, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { copyToClipboard } from '../../utils/clipboard';
import { useToast } from '../ui/toast';

/**
 * One dialog for both ways of sharing, because to the person doing it that is one decision rather than
 * two features. The radio switches which half is shown; the expiry applies either way.
 *
 * Presentational: the caller owns both requests, so the same dialog serves a file and a folder without
 * knowing which endpoints exist.
 */
const EXPIRY_OPTIONS = [
    { label: 'Never expires', hours: '' },
    { label: '24 hours', hours: 24 },
    { label: '7 days', hours: 24 * 7 },
    { label: '30 days', hours: 24 * 30 },
];

const ShareFileModal = ({ item, users = [], onClose, onShareWithUsers, onCreateLink }) => {
    const toast = useToast();
    const [mode, setMode] = useState('people');
    const [picked, setPicked] = useState([]);
    const [choice, setChoice] = useState('');
    const [expiry, setExpiry] = useState('');
    const [link, setLink] = useState(null);
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);

    if (!item) return null;

    const add = () => {
        const user = users.find((u) => String(u.id) === choice);
        if (user && !picked.some((p) => p.id === user.id)) setPicked([...picked, user]);
        setChoice('');
    };

    const run = async (fn) => {
        setBusy(true);
        try { return await fn(); } finally { setBusy(false); }
    };

    const submitPeople = () => run(async () => {
        await onShareWithUsers(picked.map((p) => p.id), expiry);
    });

    const submitLink = () => run(async () => {
        const url = await onCreateLink(expiry);
        if (url) setLink(url);
    });

    const copy = () => {
        copyToClipboard(link)
            .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
            .catch(() => toast.error("Couldn't copy automatically — select the link and copy it manually."));
    };

    const remaining = users.filter((u) => !picked.some((p) => p.id === u.id));

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={<><Share2 className="w-5 h-5 text-accent" /> Share &ldquo;{item.name}&rdquo;</>}
        >
            {item.isFolder && (
                // The part people get wrong about folder sharing, said before they do it.
                <div className="mb-4 flex gap-2 p-3 rounded-md bg-surface-2 border border-border">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <p className="text-xs text-muted leading-relaxed">
                        Sharing a folder shares <span className="font-bold text-text">everything inside it</span>,
                        including files you add later.
                    </p>
                </div>
            )}

            {link ? (
                <>
                    <p className="text-sm text-muted mb-3">
                        Anyone with this link can open it without an account.
                    </p>
                    <div className="flex gap-2">
                        <code className="flex-1 bg-bg border border-border rounded px-3 py-2 text-text text-xs overflow-x-auto break-all">{link}</code>
                        <button type="button" onClick={copy} aria-label="Copy share link" className="px-2 bg-surface-2 rounded hover:brightness-125 shrink-0">
                            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-muted" />}
                        </button>
                    </div>
                    <Button variant="primary" className="w-full mt-6" onClick={onClose}>Done</Button>
                </>
            ) : (
                <>
                    <div className="flex gap-4 mb-5">
                        {[['people', 'Specific people'], ['link', 'Anyone with the link']].map(([value, label]) => (
                            <label key={value} className="flex items-center gap-2 text-sm text-text cursor-pointer">
                                <input
                                    type="radio"
                                    name="share-mode"
                                    value={value}
                                    checked={mode === value}
                                    onChange={() => setMode(value)}
                                />
                                {label}
                            </label>
                        ))}
                    </div>

                    {mode === 'people' ? (
                        <>
                            <label className="block mb-1 text-xs text-muted uppercase font-bold" htmlFor="share-with">
                                Share with
                            </label>
                            <div className="flex gap-2">
                                <select
                                    id="share-with"
                                    value={choice}
                                    onChange={(e) => setChoice(e.target.value)}
                                    className="flex-1 bg-bg border border-border rounded px-3 py-2 text-text text-sm focus:border-accent outline-none"
                                >
                                    <option value="">Select a user…</option>
                                    {remaining.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                                </select>
                                <Button variant="ghost" onClick={add} disabled={!choice}>Add</Button>
                            </div>
                            {picked.length > 0 && (
                                <div className="flex flex-wrap gap-2 mt-3">
                                    {picked.map((p) => (
                                        <span key={p.id} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-border text-xs text-text">
                                            {p.username}
                                            <button onClick={() => setPicked(picked.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.username}`}>
                                                <X className="w-3 h-3 text-muted hover:text-text" />
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            )}
                            <p className="mt-3 text-[11px] text-muted-2">
                                They can view and download, not change anything. There are no notifications — it
                                appears under Shared with me for them.
                            </p>
                        </>
                    ) : (
                        <p className="text-sm text-muted">
                            A link that works without an account. Keep it private — anyone who has it can open it.
                        </p>
                    )}

                    <label className="block mt-6 mb-1 text-xs text-muted uppercase font-bold" htmlFor="share-expiry">
                        Expires
                    </label>
                    <select
                        id="share-expiry"
                        value={expiry}
                        onChange={(e) => setExpiry(e.target.value)}
                        className="w-full bg-bg border border-border rounded px-3 py-2 text-text text-sm focus:border-accent outline-none"
                    >
                        {EXPIRY_OPTIONS.map((o) => <option key={o.label} value={o.hours}>{o.label}</option>)}
                    </select>

                    <div className="flex justify-end gap-2 mt-6">
                        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                        {mode === 'people' ? (
                            <Button variant="primary" onClick={submitPeople} disabled={busy || picked.length === 0}>
                                {busy ? 'Sharing…' : 'Share'}
                            </Button>
                        ) : (
                            <Button variant="primary" onClick={submitLink} disabled={busy}>
                                {busy ? 'Creating…' : 'Create link'}
                            </Button>
                        )}
                    </div>
                </>
            )}
        </Modal>
    );
};

export default ShareFileModal;

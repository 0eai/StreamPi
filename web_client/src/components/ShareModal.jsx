import React, { useState } from 'react';
import { Share2, Copy, Check } from 'lucide-react';
import Modal from './ui/Modal';
import { useToast } from './ui/toast';
import { copyToClipboard } from '../utils/clipboard';

// Shown right after a share link is created (useLibraryActions.handleShare) — there's no
// duration/expiry picker in v1 (links last until revoked from Settings → My Shares), so this
// has nothing to configure; it's purely "here's the link, copy it," same shape as
// CredentialsModal.jsx's copy-to-clipboard pattern.
const ShareModal = ({ shareLink, onClose }) => {
    const toast = useToast();
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        copyToClipboard(shareLink.url)
            .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
            .catch(() => toast.error("Couldn't copy automatically — select the text and copy it manually."));
    };

    return (
        <Modal isOpen={!!shareLink} onClose={onClose} title={<><Share2 className="w-5 h-5 text-purple-500" /> Share Link</>}>
            <p className="text-xs text-gray-500 mb-4">
                Anyone with this link can watch{shareLink ? ` "${shareLink.label}"` : ''} without an account — no login required.
            </p>
            <div className="flex gap-2">
                <code className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white text-xs overflow-x-auto break-all">{shareLink?.url}</code>
                <button type="button" onClick={handleCopy} className="px-2 bg-gray-800 rounded hover:bg-gray-700 shrink-0" title="Copy" aria-label="Copy share link">
                    {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4 text-gray-400" />}
                </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-3">Manage or revoke this link anytime from Settings &rarr; My Shares.</p>
            <button onClick={onClose} className="w-full mt-6 bg-white text-black font-bold py-2 rounded hover:bg-gray-200 transition-colors">Done</button>
        </Modal>
    );
};

export default ShareModal;

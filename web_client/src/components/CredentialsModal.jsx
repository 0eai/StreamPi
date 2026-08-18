import React, { useState } from 'react';
import { Server, Copy, Check } from 'lucide-react';
import Modal from './ui/Modal';
import { useToast } from './ui/toast';
import { copyToClipboard } from '../utils/clipboard';

const CredentialsModal = ({ credentials, onClose }) => {
    const toast = useToast();
    const [copied, setCopied] = useState(null);

    const handleCopy = (field, value) => {
        copyToClipboard(value)
            .then(() => { setCopied(field); setTimeout(() => setCopied(null), 1500); })
            .catch(() => toast.error("Couldn't copy automatically — select the text and copy it manually."));
    };

    return (
        <Modal isOpen={!!credentials} onClose={onClose} nested title={<><Server className="w-5 h-5 text-green-500" /> Node Credentials</>}>
            <p className="text-xs text-yellow-500 mb-4">Copy these now — the key won't be shown again.</p>
            <div className="space-y-3">
                <div>
                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Node ID</label>
                    <div className="flex gap-2">
                        <code className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white text-xs overflow-x-auto">{credentials?.id}</code>
                        <button type="button" onClick={() => handleCopy('id', credentials.id)} className="px-2 bg-gray-800 rounded hover:bg-gray-700" title="Copy" aria-label="Copy Node ID">
                            {copied === 'id' ? <Check className="w-4 h-4 text-green-500"/> : <Copy className="w-4 h-4 text-gray-400"/>}
                        </button>
                    </div>
                </div>
                <div>
                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">API Key</label>
                    <div className="flex gap-2">
                        <code className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white text-xs overflow-x-auto break-all">{credentials?.apiKey}</code>
                        <button type="button" onClick={() => handleCopy('apiKey', credentials.apiKey)} className="px-2 bg-gray-800 rounded hover:bg-gray-700" title="Copy" aria-label="Copy API Key">
                            {copied === 'apiKey' ? <Check className="w-4 h-4 text-green-500"/> : <Copy className="w-4 h-4 text-gray-400"/>}
                        </button>
                    </div>
                </div>
                {/* Roles get a sentence of their own now that creation no longer issues them: the node
                    won't boot without a non-empty roles array, so the operator setting them here is
                    load-bearing rather than a detail. */}
                <p className="text-[11px] text-gray-500">Paste these into that node&apos;s <code className="text-gray-400">node_config.json</code>, set its <code className="text-gray-400">roles</code> there (<code className="text-gray-400">&quot;transcoder&quot;</code>, <code className="text-gray-400">&quot;nas&quot;</code>, or both), and restart it.</p>
            </div>
            <button onClick={onClose} className="w-full mt-6 bg-white text-black font-bold py-2 rounded hover:bg-gray-200 transition-colors">Done</button>
        </Modal>
    );
};

export default CredentialsModal;

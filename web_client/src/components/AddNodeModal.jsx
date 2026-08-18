import React, { useState } from 'react';
import { Server } from 'lucide-react';
import Modal from './ui/Modal';
import { apiFetch } from '../utils/api';

/**
 * Creation takes a name and nothing else.
 *
 * It used to ask for roles, but that choice was never enforced: a node's roles come from its own
 * node_config.json, which it reports at registration and can change from its own dashboard, and the
 * server treats that as authoritative the moment the node first connects. So the checkboxes read as a
 * capability grant while granting nothing. What creation actually issues is the id and the API key.
 */
const AddNodeModal = ({ isOpen, onClose, token, serverUrl, onCreated }) => {
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleClose = () => { setName(''); setError(''); setLoading(false); onClose(); };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!name.trim()) { setError('Name is required'); return; }
        setLoading(true); setError('');
        try {
            const res = await apiFetch(serverUrl, '/api/admin/nodes', token, { method: 'POST', json: { name: name.trim() } });
            const data = await res.json();
            if (!res.ok) { setError(data.error || 'Failed to create node'); setLoading(false); return; }
            // handleClose resets loading too — without that, reopening the modal without a remount
            // would show a permanently disabled "Creating...".
            handleClose();
            onCreated(data);
        } catch (e) { setError('Server error'); setLoading(false); }
    };

    return (
        <Modal isOpen={isOpen} onClose={handleClose} title={<><Server className="w-5 h-5 text-purple-500" /> Add Node</>}>
            {error && <div className="mb-4 p-2 rounded text-sm text-center bg-red-900/30 text-red-400">{error}</div>}
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Name</label>
                    <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white focus:border-purple-500 outline-none" required />
                </div>
                <p className="text-[11px] text-gray-500">
                    Roles are set on the machine itself, in its <code className="text-gray-400">node_config.json</code>,
                    and appear here once it connects.
                </p>
                <button type="submit" disabled={loading} className="w-full bg-white text-black font-bold py-2 rounded hover:bg-gray-200 transition-colors disabled:opacity-50">
                    {loading ? 'Creating...' : 'Create Node'}
                </button>
            </form>
        </Modal>
    );
};

export default AddNodeModal;

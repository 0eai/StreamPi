import React, { useState } from 'react';
import { Server } from 'lucide-react';
import Modal from './ui/Modal';
import { apiFetch } from '../utils/api';

const AddNodeModal = ({ isOpen, onClose, token, serverUrl, onCreated }) => {
    const [name, setName] = useState('');
    const [roles, setRoles] = useState({ transcoder: false, nas: false });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleClose = () => { setName(''); setRoles({ transcoder: false, nas: false }); setError(''); onClose(); };

    const handleSubmit = async (e) => {
        e.preventDefault();
        const selectedRoles = Object.keys(roles).filter(r => roles[r]);
        if (!name.trim() || !selectedRoles.length) { setError('Name and at least one role are required'); return; }
        setLoading(true); setError('');
        try {
            const res = await apiFetch(serverUrl, '/api/admin/nodes', token, { method: 'POST', json: { name: name.trim(), roles: selectedRoles } });
            const data = await res.json();
            if (!res.ok) { setError(data.error || 'Failed to create node'); setLoading(false); return; }
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
                <div>
                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Roles</label>
                    <div className="flex gap-4">
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input type="checkbox" checked={roles.transcoder} onChange={e => setRoles(r => ({ ...r, transcoder: e.target.checked }))} /> Transcoder
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input type="checkbox" checked={roles.nas} onChange={e => setRoles(r => ({ ...r, nas: e.target.checked }))} /> NAS Storage
                        </label>
                    </div>
                </div>
                <button type="submit" disabled={loading} className="w-full bg-white text-black font-bold py-2 rounded hover:bg-gray-200 transition-colors disabled:opacity-50">
                    {loading ? 'Creating...' : 'Create Node'}
                </button>
            </form>
        </Modal>
    );
};

export default AddNodeModal;

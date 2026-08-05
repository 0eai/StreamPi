import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import Modal from './ui/Modal';
import { apiFetch } from '../utils/api';

const ChangePasswordModal = ({ isOpen, onClose, token, serverUrl }) => {
    const [oldPass, setOldPass] = useState('');
    const [newPass, setNewPass] = useState('');
    const [msg, setMsg] = useState({ type: '', text: '' });
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setMsg({});

        try {
            const res = await apiFetch(serverUrl, '/api/auth/change-password', token, { method: 'POST', json: { oldPassword: oldPass, newPassword: newPass } });
            const data = await res.json();

            if (res.ok) {
                setMsg({ type: 'success', text: 'Password changed!' });
                setTimeout(() => {
                    onClose();
                    setOldPass(''); setNewPass(''); setMsg({});
                }, 1500);
            } else {
                setMsg({ type: 'error', text: data.error || 'Failed' });
            }
        } catch (e) {
            setMsg({ type: 'error', text: 'Server Error' });
        }
        setLoading(false);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={<><Lock className="w-5 h-5 text-yellow-500" /> Change Password</>}>
            {msg.text && (
                <div className={`mb-4 p-2 rounded text-sm text-center ${msg.type === 'error' ? 'bg-red-900/30 text-red-400' : 'bg-green-900/30 text-green-400'}`}>
                    {msg.text}
                </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Old Password</label>
                    <input type="password" value={oldPass} onChange={e=>setOldPass(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white focus:border-yellow-500 outline-none" required />
                </div>
                <div>
                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">New Password</label>
                    <input type="password" value={newPass} onChange={e=>setNewPass(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white focus:border-yellow-500 outline-none" required />
                </div>
                <button type="submit" disabled={loading} className="w-full bg-white text-black font-bold py-2 rounded hover:bg-gray-200 transition-colors disabled:opacity-50">
                    {loading ? 'Updating...' : 'Update Password'}
                </button>
            </form>
        </Modal>
    );
};

export default ChangePasswordModal;

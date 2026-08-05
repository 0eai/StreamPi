import React, { useState, useEffect } from 'react';
import { Shield } from 'lucide-react';
import { apiFetch } from '../utils/api';

const UserManagement = ({ token, serverUrl }) => {
    const [users, setUsers] = useState([]);
    
    const fetchUsers = async () => {
        try {
            const res = await apiFetch(serverUrl, '/api/admin/users', token);
            if (res.ok) setUsers(await res.json());
        } catch (e) { /* ignore */ }
    };

    useEffect(() => { fetchUsers(); }, []);

    const handleAction = async (userId, action) => {
        if (!confirm(`Confirm ${action}?`)) return;
        await apiFetch(serverUrl, '/api/admin/users/action', token, { method: 'POST', json: { userId, action } });
        fetchUsers();
    };

    const pendingUsers = users.filter(u => u.status === 'pending');
    const activeUsers = users.filter(u => u.status === 'approved');

    return (
        <div className="bg-[#1a1a1a] rounded-xl border border-gray-800 overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
                <h3 className="font-bold text-white flex items-center gap-2"><Shield className="w-4 h-4 text-red-500"/> User Management</h3>
                {pendingUsers.length > 0 && <span className="bg-yellow-600 text-black text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">{pendingUsers.length} Pending</span>}
            </div>
            
            <div className="p-6 grid gap-6">
                
                {/* 👇👇👇 THIS WAS MISSING IN YOUR CODE 👇👇👇 */}
                {pendingUsers.length > 0 && (
                    <div className="space-y-3">
                        <h4 className="text-xs font-bold text-yellow-500 uppercase">Pending Requests</h4>
                        {pendingUsers.map(u => (
                            <div key={u.id} className="flex justify-between items-center bg-yellow-900/10 border border-yellow-500/20 p-3 rounded-lg">
                                <div>
                                    <div className="font-bold text-white">{u.username}</div>
                                    <div className="text-xs text-gray-500">Registered: {new Date(u.created_at).toLocaleDateString()}</div>
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={()=>handleAction(u.id, 'approve')} className="px-3 py-1 bg-green-600 text-white text-xs font-bold rounded hover:bg-green-500 transition-colors">Approve</button>
                                    <button onClick={()=>handleAction(u.id, 'reject')} className="px-3 py-1 bg-red-600 text-white text-xs font-bold rounded hover:bg-red-500 transition-colors">Reject</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {/* 👆👆👆 END OF RESTORED CODE 👆👆👆 */}

                {/* ACTIVE USERS LIST */}
                <div>
                    <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Active Users</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {activeUsers.map(user => (
                            <div key={user.id} className="bg-gray-800/50 p-3 rounded border border-gray-700 flex justify-between items-center">
                                <div className="flex items-center gap-3">
                                    {/* ROLE BADGES */}
                                    {user.role === 'super_admin' && <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />}
                                    {user.role === 'admin' && <div className="w-2 h-2 rounded-full bg-yellow-500" />}
                                    {user.role === 'user' && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                                    {user.role === 'public' && <div className="w-2 h-2 rounded-full bg-gray-500" />} {/* Fallback for old users */}
                                    
                                    <div>
                                        <div className="text-sm font-bold text-gray-200">{user.username}</div>
                                        <div className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">
                                            {user.role === 'super_admin' ? 'Super Admin' : user.role === 'public' ? 'User' : user.role}
                                        </div>
                                    </div>
                                </div>

                                {/* ACTIONS */}
                                <div className="flex gap-2">
                                    {/* Only show promote/demote if target is NOT super admin */}
                                    {user.role !== 'super_admin' && (
                                        <>
                                            {(user.role === 'user' || user.role === 'public') && (
                                                <button onClick={()=>handleAction(user.id, 'promote')} className="text-xs text-yellow-500 hover:text-yellow-400 font-medium" title="Promote to Admin">Promote</button>
                                            )}
                                            {user.role === 'admin' && (
                                                <button onClick={()=>handleAction(user.id, 'demote')} className="text-xs text-blue-500 hover:text-blue-400 font-medium" title="Demote to User">Demote</button>
                                            )}
                                            <button onClick={()=>handleAction(user.id, 'delete')} className="text-xs text-red-500 hover:text-red-400 font-medium">Remove</button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- NEW COMPONENT: TELEGRAM BROWSER ---

export default UserManagement;

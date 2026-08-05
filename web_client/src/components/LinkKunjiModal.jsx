import React, { useState, useEffect, useRef, useCallback } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { loadKunjiScript } from '../utils/kunji';
import Modal from './ui/Modal';
import { apiFetch } from '../utils/api';

const LinkKunjiModal = ({ isOpen, onClose, token, serverUrl, onLinked }) => {
    const [phase, setPhase] = useState('loading'); // loading | ready | linking | linked | error
    const [errorMsg, setErrorMsg] = useState('');
    const containerRef = useRef(null);

    const handleKunjiSuccess = useCallback(async (e) => {
        const { sub } = e.detail;
        setPhase('linking');
        try {
            const res = await apiFetch(serverUrl, '/api/auth/kunji/link', token, { method: 'POST', json: { sub } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Linking failed.');
            setPhase('linked');
            onLinked?.();
            setTimeout(() => onClose(), 1500);
        } catch (err) {
            setErrorMsg(err.message);
            setPhase('error');
        }
    }, [serverUrl, token, onClose, onLinked]);

    useEffect(() => {
        document.addEventListener('kunji:success', handleKunjiSuccess);
        return () => document.removeEventListener('kunji:success', handleKunjiSuccess);
    }, [handleKunjiSuccess]);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        setPhase('loading');
        setErrorMsg('');

        (async () => {
            try {
                const cfgRes = await fetch(`${serverUrl}/api/auth/kunji/config`);
                const cfg = await cfgRes.json();
                if (!cfgRes.ok || !cfg.callbackUrl) throw new Error(cfg.error || 'Kunji login is not configured on this server.');

                await loadKunjiScript();
                if (cancelled) return;
                if (!window.kunji || typeof window.kunji.render !== 'function') {
                    throw new Error('Kunji widget script loaded but did not expose a render() function.');
                }
                // The container div is always mounted while the modal is open (see JSX below),
                // so the ref is already attached — no need to wait a tick for it to appear.
                if (!containerRef.current) throw new Error('Kunji widget container was not available to render into.');

                containerRef.current.innerHTML = '';
                window.kunji.render(containerRef.current, {
                    appName: 'StreamPi',
                    audience: cfg.audience,
                    sessionUrl: `${serverUrl}/api/auth/kunji/session`,
                    callbackUrl: cfg.callbackUrl,
                    pollUrl: `${serverUrl}/api/auth/kunji/status`,
                    codeUrl: `${cfg.callbackUrl.replace(/\/$/, '')}/kunji/session/code`,
                    scope: 'profile'
                });
                setPhase('ready');
            } catch (e) {
                if (!cancelled) { setErrorMsg(e.message); setPhase('error'); }
            }
        })();

        return () => { cancelled = true; };
    }, [isOpen, serverUrl]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={<><KeyRound className="w-5 h-5 text-yellow-500" /> Link Kunji Account</>}>
            {phase === 'loading' && (
                <div className="flex flex-col items-center gap-3 py-6">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                    <span className="text-sm text-gray-400">Connecting to Kunji…</span>
                </div>
            )}

            {/* Always mounted while the modal is open (never conditionally removed) so
                the ref is guaranteed attached when the effect above calls
                window.kunji.render() into it — just hidden via CSS otherwise. */}
            <div className={phase === 'ready' || phase === 'linking' ? 'flex flex-col items-center gap-4' : 'hidden'}>
                <div ref={containerRef} className="flex justify-center min-h-[1px]" />
                {phase === 'linking' && <span className="text-sm text-green-400 font-medium">Verified! Linking…</span>}
            </div>

            {phase === 'linked' && (
                <div className="text-center py-4">
                    <p className="text-sm text-green-400 font-medium">Kunji identity linked! You can now log in with it.</p>
                </div>
            )}

            {phase === 'error' && (
                <div className="text-center py-4">
                    <p className="text-sm text-red-400">{errorMsg}</p>
                </div>
            )}
        </Modal>
    );
};

export default LinkKunjiModal;

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { getDeviceInfo } from '../utils/device';
import { SERVER_URL, apiFetch } from '../utils/api';
import { loadKunjiScript } from '../utils/kunji';
import Card from './ui/Card';
import Input from './ui/Input';
import Button from './ui/Button';

const LoginScreen = ({ onLogin }) => {
    const [isRegistering, setIsRegistering] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [successMsg, setSuccessMsg] = useState('');
    const [loading, setLoading] = useState(false);

    // idle | loading | ready | signing_in | forbidden | error
    // Starts at 'loading', not 'idle' — Kunji is the first thing attempted on load, the
    // password form is the fallback reached via "Back to password login".
    const [kunjiPhase, setKunjiPhase] = useState('loading');
    const [kunjiError, setKunjiError] = useState('');
    const kunjiContainerRef = useRef(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        setSuccessMsg('');

        const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
        const { device, type } = getDeviceInfo();

        try {
            const res = await apiFetch(SERVER_URL, endpoint, null, { method: 'POST', json: { username, password, device, device_type: type } });
            const data = await res.json();

            if (res.ok && data.success) {
                if (isRegistering) {
                    setSuccessMsg(data.message);
                    setIsRegistering(false); // Switch back to login
                    setUsername('');
                    setPassword('');
                } else {
                    onLogin(data.token, username, data.role);
                }
            } else {
                setError(data.error || 'Authentication failed');
            }
        } catch (err) {
            setError('Server connection failed');
        }
        setLoading(false);
    };

    const resetKunji = () => {
        setKunjiPhase('idle');
        setKunjiError('');
        if (kunjiContainerRef.current) kunjiContainerRef.current.innerHTML = '';
    };

    const startKunjiLogin = async () => {
        setError('');
        setKunjiError('');
        setKunjiPhase('loading');
        try {
            const cfgRes = await fetch(`${SERVER_URL}/api/auth/kunji/config`);
            const cfg = await cfgRes.json();
            if (!cfgRes.ok || !cfg.callbackUrl) {
                throw new Error(cfg.error || 'Kunji login is not configured on this server.');
            }

            await loadKunjiScript();
            if (!window.kunji || typeof window.kunji.render !== 'function') {
                throw new Error('Kunji widget script loaded but did not expose a render() function.');
            }
            // The container div is always mounted (see JSX below), so the ref is already
            // attached at this point — no need to wait a tick for it to appear.
            if (!kunjiContainerRef.current) throw new Error('Kunji widget container was not available to render into.');

            kunjiContainerRef.current.innerHTML = '';
            window.kunji.render(kunjiContainerRef.current, {
                appName: 'StreamPi',
                audience: cfg.audience,
                sessionUrl: `${SERVER_URL}/api/auth/kunji/session`,
                callbackUrl: cfg.callbackUrl,
                pollUrl: `${SERVER_URL}/api/auth/kunji/status`,
                codeUrl: `${cfg.callbackUrl.replace(/\/$/, '')}/kunji/session/code`,
                scope: 'profile'
            });
            setKunjiPhase('ready');
        } catch (e) {
            setKunjiError(e.message);
            setKunjiPhase('error');
        }
    };

    const handleKunjiSuccess = useCallback(async (e) => {
        const { sub, sessionId } = e.detail;
        setKunjiPhase('signing_in');
        try {
            const { device, type } = getDeviceInfo();
            const res = await apiFetch(SERVER_URL, '/api/auth/kunji/finalize', null, { method: 'POST', json: { sessionId, sub, device, device_type: type } });
            const data = await res.json();
            if (res.status === 403) {
                setKunjiPhase('forbidden');
                return;
            }
            if (!res.ok || !data.success) throw new Error(data.error || 'Sign-in failed.');
            onLogin(data.token, data.username, data.role);
        } catch (e) {
            setKunjiError(e.message);
            setKunjiPhase('error');
        }
    }, [onLogin]);

    useEffect(() => {
        document.addEventListener('kunji:success', handleKunjiSuccess);
        return () => document.removeEventListener('kunji:success', handleKunjiSuccess);
    }, [handleKunjiSuccess]);

    // Kunji is the first thing attempted, automatically, on load — no extra click needed
    // to reach the widget's own "Sign in with kunji" button.
    useEffect(() => {
        startKunjiLogin();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const showPasswordForm = kunjiPhase === 'idle';

    return (
        <div className="min-h-screen bg-bg text-text flex items-center justify-center flex-col gap-6 p-4">
            {/* Same logo.png as the header/downloads page — was logo-mono.png in a solid
                accent-colored box, which no longer matches now that the header shows the
                full-color mark instead of the newer flat design that mono version depicted. */}
            <img src="/logo.png" alt="StreamPi" className="w-24 h-auto object-contain mb-2 animate-in zoom-in duration-500" />

            <h1 className="text-3xl font-bold tracking-tight">
                {isRegistering ? 'Create Account' : 'StreamPi Login'}
            </h1>

            <Card className="w-full max-w-sm p-8">
                {showPasswordForm && (
                    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                        {successMsg && <div className="bg-success/10 border border-success/30 text-success p-3 rounded-md text-sm text-center">{successMsg}</div>}
                        {error && <div className="bg-danger/10 border border-danger/30 text-danger p-3 rounded-md text-sm text-center">{error}</div>}

                        <Input
                            label="Username"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="username"
                            required
                        />

                        <Input
                            label="Password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••••"
                            required
                        />

                        <Button type="submit" variant="primary" disabled={loading} className="mt-2 justify-center">
                            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : (isRegistering ? 'Register' : 'Sign In')}
                        </Button>

                        <div className="text-center mt-2">
                            <Button
                                type="button"
                                variant="link"
                                onClick={() => { setIsRegistering(!isRegistering); setError(''); setSuccessMsg(''); }}
                            >
                                {isRegistering ? "Already have an account? Sign In" : "Need an account? Register"}
                            </Button>
                        </div>
                        <div className="text-center">
                            <Button type="button" variant="link" onClick={startKunjiLogin}>
                                Sign in with Kunji instead →
                            </Button>
                        </div>
                    </form>
                )}

                {kunjiPhase === 'loading' && (
                    <div className="flex flex-col items-center gap-3 py-6">
                        <Loader2 className="w-8 h-8 animate-spin text-muted" />
                        <span className="text-sm text-muted">Connecting to Kunji…</span>
                        <Button type="button" variant="link" onClick={resetKunji}>
                            Use password instead →
                        </Button>
                    </div>
                )}

                {/* Always mounted (never conditionally removed) so the ref is guaranteed
                    attached whenever startKunjiLogin() calls window.kunji.render() into it —
                    just hidden via CSS outside the ready/signing_in phases. */}
                <div className={kunjiPhase === 'ready' || kunjiPhase === 'signing_in' ? 'flex flex-col items-center gap-4' : 'hidden'}>
                    <div ref={kunjiContainerRef} className="flex justify-center min-h-[1px]" />
                    {kunjiPhase === 'signing_in' && (
                        <span className="text-sm text-success font-medium">Verified! Signing you in…</span>
                    )}
                    <Button type="button" variant="link" onClick={resetKunji}>
                        Use password instead →
                    </Button>
                </div>

                {kunjiPhase === 'forbidden' && (
                    <div className="flex flex-col items-center gap-4 text-center py-4">
                        <p className="text-sm text-warning">
                            This Kunji identity isn't linked to any StreamPi account yet.
                        </p>
                        <p className="text-xs text-muted">
                            Log in with your username and password, then link Kunji from your account menu.
                        </p>
                        <Button type="button" variant="link" onClick={resetKunji}>
                            Use password instead →
                        </Button>
                    </div>
                )}

                {kunjiPhase === 'error' && (
                    <div className="flex flex-col items-center gap-4 text-center py-4">
                        <p className="text-sm text-danger">{kunjiError}</p>
                        <Button type="button" variant="link" onClick={resetKunji}>
                            Use password instead →
                        </Button>
                    </div>
                )}
            </Card>

            <a href="/download" className="text-sm text-muted hover:text-text transition-colors">
                Download the Android TV app or worker node script →
            </a>
        </div>
    );
};

export default LoginScreen;

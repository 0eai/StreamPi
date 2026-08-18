import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

/**
 * Transient notices, replacing native alert().
 *
 * Almost every alert() in this app was a "<something> failed: <reason>" that needs no decision from
 * the reader — turning 45 of those into modals you must click through would be worse than the native
 * dialogs they replace. Decisions live in ./dialogs.jsx instead; this is for things you only need to
 * be *told*.
 *
 * Portaled to document.body for the same reason Modal is: `position: fixed` resolves against the
 * nearest transformed/filtered ancestor, not the viewport, and this app has several (Poster's
 * hover:scale, TopNav's backdrop-blur).
 */

const ToastContext = createContext(null);

const TONES = {
    error: { Icon: AlertTriangle, cls: 'border-danger/40 text-danger', role: 'alert' },
    success: { Icon: CheckCircle2, cls: 'border-success/40 text-success', role: 'status' },
    info: { Icon: Info, cls: 'border-info/40 text-info', role: 'status' },
};

const DEFAULT_MS = 5000;

export const ToastProvider = ({ children }) => {
    const [toasts, setToasts] = useState([]);
    // Ids come from a counter, not Date.now(): two failures in the same millisecond are entirely
    // possible (a loop of per-episode requests all rejecting at once) and would collide as keys.
    const nextId = useRef(0);

    const dismiss = useCallback((id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const push = useCallback((tone, message, durationMs = DEFAULT_MS) => {
        if (!message) return;
        const id = nextId.current++;
        setToasts((prev) => [...prev, { id, tone, message: String(message), durationMs }]);
        return id;
    }, []);

    // Stable identity: these end up in the dependency arrays of callers' effects and handlers.
    const api = useRef(null);
    if (!api.current) {
        api.current = {
            error: (m, ms) => push('error', m, ms),
            success: (m, ms) => push('success', m, ms),
            info: (m, ms) => push('info', m, ms),
            dismiss: (id) => dismiss(id),
        };
    }

    return (
        <ToastContext.Provider value={api.current}>
            {children}
            {toasts.length > 0 && createPortal(
                // Bottom-right, above modals (z-[60]/[70]) so a failure raised from inside a dialog
                // is still visible. pointer-events-none on the stack, re-enabled per toast, so the
                // empty column never blocks clicks on the page beneath it.
                <div className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))] pointer-events-none">
                    {toasts.map((t) => (
                        <Toast key={t.id} toast={t} onDismiss={dismiss} />
                    ))}
                </div>,
                document.body
            )}
        </ToastContext.Provider>
    );
};

const Toast = ({ toast, onDismiss }) => {
    const { Icon, cls, role } = TONES[toast.tone] || TONES.info;

    useEffect(() => {
        if (!toast.durationMs) return;
        const timer = setTimeout(() => onDismiss(toast.id), toast.durationMs);
        return () => clearTimeout(timer);
    }, [toast.id, toast.durationMs, onDismiss]);

    return (
        <div
            role={role}
            className={`pointer-events-auto flex items-start gap-2.5 bg-surface border ${cls} rounded-lg shadow-2xl px-3.5 py-3 animate-in fade-in slide-in-from-bottom-2 duration-200`}
        >
            <Icon className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-sm text-text flex-1 break-words">{toast.message}</p>
            <button
                onClick={() => onDismiss(toast.id)}
                className="text-muted hover:text-text transition-colors shrink-0"
                aria-label="Dismiss"
            >
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    );
};

/**
 * Throws when used outside the provider rather than returning no-ops: a silently swallowed error
 * message is precisely the failure this whole layer exists to stop.
 */
export const useToast = () => {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
    return ctx;
};

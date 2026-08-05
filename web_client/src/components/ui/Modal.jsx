import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The shell six modals (ChangePassword, AddNode, LinkKunji, NodeDetail, Credentials,
// UploadWizard) each hand-rolled independently, down to copy-pasted backdrop/panel
// classNames — none of them had Escape-to-close or a focus trap, unlike CustomVideoPlayer,
// which already handles Escape correctly. Centralizing the shell here fixes that once for
// all six instead of six times. `nested` covers the one real stacked case (Credentials
// opened from AddNode) — z-[60]/z-[70] follow the scale documented in index.css.
const Modal = ({ isOpen, onClose, title, maxWidth = 'max-w-sm', nested = false, panelClassName = '', hideCloseButton = false, children }) => {
    const panelRef = useRef(null);
    const previouslyFocusedRef = useRef(null);

    useEffect(() => {
        if (!isOpen) return;

        previouslyFocusedRef.current = document.activeElement;
        const panel = panelRef.current;
        const focusable = () => Array.from(panel?.querySelectorAll(FOCUSABLE_SELECTOR) || []);
        (focusable()[0] || panel)?.focus();

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                onClose?.();
                return;
            }
            if (e.key !== 'Tab' || !panel) return;

            const items = focusable();
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];

            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            // Only restore if focus is still somewhere inside this modal (a click-away or a
            // programmatic focus change elsewhere shouldn't be yanked back on close).
            if (panel?.contains(document.activeElement)) previouslyFocusedRef.current?.focus?.();
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div className={`fixed inset-0 bg-black/80 ${nested ? 'z-[70]' : 'z-[60]'} flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-200`}>
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={typeof title === 'string' ? title : undefined}
                tabIndex={-1}
                className={`bg-surface w-full ${maxWidth} p-6 rounded-lg border border-border shadow-2xl relative animate-in fade-in zoom-in duration-200 outline-none ${panelClassName}`}
            >
                {onClose && !hideCloseButton && (
                    <button onClick={onClose} className="absolute top-4 right-4 text-muted hover:text-text transition-colors" aria-label="Close">
                        <X className="w-5 h-5" />
                    </button>
                )}
                {title && <h2 className="text-lg font-semibold text-text mb-6 flex items-center gap-2">{title}</h2>}
                {children}
            </div>
        </div>
    );
};

export default Modal;

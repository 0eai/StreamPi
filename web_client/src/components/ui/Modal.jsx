import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
    // Callers overwhelmingly pass an inline `() => setX(false)` for onClose, which gets a new
    // identity on every render of whatever owns that state — StreamApp re-renders on every poll
    // tick from any hook it uses, open modal or not. A ref means the effect below only depends
    // on `isOpen`, so a parent re-render can no longer retrigger this effect's cleanup — which
    // previously ran its "restore focus to what was focused before the modal opened" step any
    // time onClose's identity changed, yanking focus out of whatever input the user was
    // actively typing into even though the modal wasn't actually closing.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!isOpen) return;

        previouslyFocusedRef.current = document.activeElement;
        const panel = panelRef.current;
        const focusable = () => Array.from(panel?.querySelectorAll(FOCUSABLE_SELECTOR) || []);
        (focusable()[0] || panel)?.focus();

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                onCloseRef.current?.();
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
    }, [isOpen]);

    if (!isOpen) return null;

    // Portaled to document.body rather than rendered in place — `position: fixed` is relative
    // to the nearest *transformed* ancestor, not necessarily the viewport (CSS spec: any
    // ancestor with a transform/filter/will-change becomes the containing block for a fixed
    // descendant). Poster.jsx's card has `hover:scale-105`, so a modal opened from inside it
    // while still hovered got boxed into that card's own bounds instead of covering the
    // screen. Portaling out from under any such ancestor is the general fix, not just a
    // one-off for that specific card.
    return createPortal(
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
        </div>,
        document.body
    );
};

export default Modal;

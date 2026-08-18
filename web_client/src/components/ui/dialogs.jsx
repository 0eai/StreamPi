import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';
import Input from './Input';

/**
 * Promise-based replacements for native confirm() and prompt().
 *
 * The promise is the whole design. Native confirm/prompt are synchronous, so every call site is
 * written as `if (!confirm(msg)) return;` — 14 of them, plus 2 prompts. Returning a promise means
 * each becomes `if (!await confirm(msg)) return;`: one keyword, same control flow, no restructuring.
 * A callback- or state-based dialog would have meant rewriting each handler inside-out.
 *
 * Transient notices are NOT here — see ./toast.jsx. This module is only for the cases that genuinely
 * need an answer before the code can continue: confirm, prompt, and choose (more than two outcomes).
 *
 * Only one dialog is ever open at a time; a second call while one is pending replaces it and
 * resolves the first as cancelled, which is the honest outcome — the user never saw it to answer.
 */

const DialogContext = createContext(null);

/**
 * What a dismissal resolves to, per kind — the value each caller's falsy check expects. Written as a
 * conditional rather than a lookup table on purpose: `TABLE[kind] ?? false` would turn the deliberate
 * null for prompt/choose back into false, since ?? treats null as absent.
 */
const cancelValueFor = (kind) => (kind === 'confirm' ? false : null);

export const DialogProvider = ({ children }) => {
    const [dialog, setDialog] = useState(null);
    const resolveRef = useRef(null);
    // The pending dialog's own kind. Superseding used to read it off the *incoming* spec, which
    // resolved the outgoing promise with the wrong kind's cancel value — harmless while every one was
    // falsy, but wrong, and `choose` callers compare against null specifically.
    const pendingKindRef = useRef(null);

    const settle = useCallback((value) => {
        const resolve = resolveRef.current;
        resolveRef.current = null;
        pendingKindRef.current = null;
        setDialog(null);
        resolve?.(value);
    }, []);

    const open = useCallback((spec) => new Promise((resolve) => {
        // Supersede rather than queue or ignore: the caller is waiting on a promise, so leaving it
        // unresolved would hang that handler forever.
        resolveRef.current?.(cancelValueFor(pendingKindRef.current));
        resolveRef.current = resolve;
        pendingKindRef.current = spec.kind;
        setDialog(spec);
    }), []);

    const api = useRef(null);
    if (!api.current) {
        api.current = {
            /**
             * `confirm('Delete this?')` or `confirm({ message, title, confirmLabel, danger })`.
             * Resolves true only on the confirm button; Escape, the backdrop close and Cancel all
             * resolve false, matching what native confirm does with a dismissed dialog.
             */
            confirm: (arg) => open({
                kind: 'confirm',
                ...(typeof arg === 'string' ? { message: arg } : arg),
            }),
            /**
             * `prompt({ label, value, message })`. Resolves the trimmed string, or null when
             * cancelled — same contract as native prompt, so callers' existing falsy checks hold.
             */
            prompt: (arg) => open({
                kind: 'prompt',
                ...(typeof arg === 'string' ? { label: arg } : arg),
            }),
            /**
             * `choose({ title, message, options: [{ label, value, variant }] })`. Resolves the chosen
             * option's value, or null when dismissed.
             *
             * For the case confirm can't express: not "do this, yes or no" but "there are two
             * different things you might mean here". The first is clearing a node's owner, where
             * "also regenerate the key" is a genuinely separate outcome rather than a stronger yes —
             * offering it as a second confirm would make the safe option take two dialogs.
             */
            choose: (arg) => open({ kind: 'choose', ...arg }),
        };
    }

    return (
        <DialogContext.Provider value={api.current}>
            {children}
            {dialog?.kind === 'confirm' && <ConfirmDialog spec={dialog} onSettle={settle} />}
            {dialog?.kind === 'prompt' && <PromptDialog spec={dialog} onSettle={settle} />}
            {dialog?.kind === 'choose' && <ChooseDialog spec={dialog} onSettle={settle} />}
        </DialogContext.Provider>
    );
};

const ConfirmDialog = ({ spec, onSettle }) => (
    // `nested` so a confirm raised from inside another modal (revoking a share from Settings,
    // signing out a device) lands above it rather than behind.
    <Modal
        isOpen
        onClose={() => onSettle(false)}
        nested
        title={spec.danger
            ? <><AlertTriangle className="w-5 h-5 text-danger" /> {spec.title || 'Are you sure?'}</>
            : (spec.title || 'Are you sure?')}
    >
        <p className="text-sm text-muted whitespace-pre-line">{spec.message}</p>
        <div className="flex justify-end gap-2 mt-6">
            <Button variant="ghost" onClick={() => onSettle(false)}>{spec.cancelLabel || 'Cancel'}</Button>
            {/* Nothing here is focused on open — Modal focuses the first focusable in the panel, which
                is its header close button — so a stray Enter dismisses rather than confirming. Keep
                Cancel ahead of the confirm button so that stays true if Modal's focus rule changes. */}
            {/* Always `primary`: the app's accent already IS red (#dc2626), so the confirm button
                reads as consequential without needing Button's quiet `danger` variant, which is
                meant for a destructive control sitting *among* others rather than being the
                primary action of a dialog. */}
            <Button variant="primary" onClick={() => onSettle(true)}>
                {spec.confirmLabel || 'Confirm'}
            </Button>
        </div>
    </Modal>
);

const ChooseDialog = ({ spec, onSettle }) => (
    <Modal
        isOpen
        onClose={() => onSettle(null)}
        nested
        title={spec.danger
            ? <><AlertTriangle className="w-5 h-5 text-danger" /> {spec.title || 'Choose an action'}</>
            : (spec.title || 'Choose an action')}
    >
        <p className="text-sm text-muted whitespace-pre-line">{spec.message}</p>
        {/* Stacked rather than a row: these labels are whole phrases ("Clear + Regenerate Key"), and
            side by side they'd be unreadable at the narrower widths this modal takes. Cancel stays
            first so it keeps the initial focus, as in ConfirmDialog. */}
        <div className="flex flex-col gap-2 mt-6">
            <Button variant="ghost" onClick={() => onSettle(null)}>{spec.cancelLabel || 'Cancel'}</Button>
            {(spec.options || []).map((opt) => (
                <Button key={opt.value} variant={opt.variant || 'primary'} onClick={() => onSettle(opt.value)}>
                    {opt.label}
                </Button>
            ))}
        </div>
    </Modal>
);

const PromptDialog = ({ spec, onSettle }) => {
    const [value, setValue] = useState(spec.value ?? '');
    const submit = () => onSettle(value.trim() ? value.trim() : null);

    return (
        <Modal isOpen onClose={() => onSettle(null)} nested title={spec.title || spec.label || 'Enter a value'}>
            {/* A form so Enter submits, which native prompt did for free and is how anyone will
                expect to finish typing a title. */}
            <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
                {spec.message && <p className="text-sm text-muted mb-4 whitespace-pre-line">{spec.message}</p>}
                <Input
                    label={spec.label}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    autoFocus
                />
                <div className="flex justify-end gap-2 mt-6">
                    <Button type="button" variant="ghost" onClick={() => onSettle(null)}>Cancel</Button>
                    <Button type="submit" variant="primary" disabled={!value.trim()}>
                        {spec.confirmLabel || 'Save'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

/**
 * Throws outside the provider rather than falling back to window.confirm: a silent fallback would
 * hide a missing provider until someone hit the one code path that uses it.
 */
export const useDialogs = () => {
    const ctx = useContext(DialogContext);
    if (!ctx) throw new Error('useDialogs must be used inside <DialogProvider>');
    return ctx;
};

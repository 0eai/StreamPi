import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { DialogProvider, useDialogs } from './dialogs';
import { ToastProvider, useToast } from './toast';

/**
 * The promise contract is what the 61-call-site migration depends on, so it is what these pin:
 * a cancelled confirm must resolve false (not hang, not throw), and a cancelled prompt must
 * resolve null so existing `if (!value) return` checks keep working unchanged.
 */

const Harness = ({ onReady }) => {
    const dialogs = useDialogs();
    return <button onClick={() => onReady(dialogs)}>go</button>;
};

const renderDialogs = () => {
    let api;
    render(
        <DialogProvider>
            <Harness onReady={(d) => { api = d; }} />
        </DialogProvider>
    );
    fireEvent.click(screen.getByText('go'));
    return () => api;
};

describe('confirm', () => {
    it('resolves true on the confirm button', async () => {
        const get = renderDialogs();
        let promise;
        act(() => { promise = get().confirm('Delete this?'); });

        expect(await screen.findByText('Delete this?')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Confirm'));
        await expect(promise).resolves.toBe(true);
    });

    it('resolves false on Cancel', async () => {
        const get = renderDialogs();
        let promise;
        act(() => { promise = get().confirm('Delete this?'); });
        fireEvent.click(await screen.findByText('Cancel'));
        await expect(promise).resolves.toBe(false);
    });

    it('resolves false on Escape, like a dismissed native confirm', async () => {
        const get = renderDialogs();
        let promise;
        act(() => { promise = get().confirm('Delete this?'); });
        await screen.findByText('Delete this?');
        fireEvent.keyDown(document, { key: 'Escape' });
        await expect(promise).resolves.toBe(false);
    });

    it('accepts a spec object for custom copy', async () => {
        const get = renderDialogs();
        act(() => { get().confirm({ title: 'Sign out?', message: 'It will need to sign in again.', confirmLabel: 'Sign Out', danger: true }); });
        expect(await screen.findByText('Sign out?')).toBeInTheDocument();
        expect(screen.getByText('It will need to sign in again.')).toBeInTheDocument();
        expect(screen.getByText('Sign Out')).toBeInTheDocument();
    });

    it('closes after answering, leaving nothing on screen', async () => {
        const get = renderDialogs();
        let promise;
        act(() => { promise = get().confirm('Delete this?'); });
        fireEvent.click(await screen.findByText('Confirm'));
        await promise;
        await waitFor(() => expect(screen.queryByText('Delete this?')).not.toBeInTheDocument());
    });

    it('does not leave a superseded call hanging', async () => {
        // A second dialog while one is pending must resolve the first, or its caller's handler
        // never returns.
        const get = renderDialogs();
        let first;
        act(() => { first = get().confirm('First?'); });
        act(() => { get().confirm('Second?'); });
        await expect(first).resolves.toBe(false);
        expect(await screen.findByText('Second?')).toBeInTheDocument();
    });
});

describe('prompt', () => {
    it('resolves the typed value, trimmed', async () => {
        const get = renderDialogs();
        let promise;
        act(() => { promise = get().prompt({ label: 'Title', value: 'Old' }); });

        const input = await screen.findByDisplayValue('Old');
        fireEvent.change(input, { target: { value: '  New Title  ' } });
        fireEvent.click(screen.getByText('Save'));
        await expect(promise).resolves.toBe('New Title');
    });

    it('prefills the current value so renaming is an edit, not a retype', async () => {
        const get = renderDialogs();
        act(() => { get().prompt({ label: 'Title', value: 'Oppenheimer' }); });
        expect(await screen.findByDisplayValue('Oppenheimer')).toBeInTheDocument();
    });

    it('resolves null when cancelled, so existing falsy checks hold', async () => {
        const get = renderDialogs();
        let promise;
        act(() => { promise = get().prompt({ label: 'Title', value: 'Old' }); });
        fireEvent.click(await screen.findByText('Cancel'));
        await expect(promise).resolves.toBeNull();
    });

    it('submits on Enter', async () => {
        const get = renderDialogs();
        let promise;
        act(() => { promise = get().prompt({ label: 'Title', value: 'Old' }); });
        const input = await screen.findByDisplayValue('Old');
        fireEvent.change(input, { target: { value: 'Typed' } });
        fireEvent.submit(input.closest('form'));
        await expect(promise).resolves.toBe('Typed');
    });

    it('cannot submit an empty value', async () => {
        const get = renderDialogs();
        act(() => { get().prompt({ label: 'Title', value: '' }); });
        expect(await screen.findByText('Save')).toBeDisabled();
    });
});

describe('supersession', () => {
    it('resolves a superseded prompt as null, not false', async () => {
        // The cancel value has to come from the pending dialog's own kind, not the incoming one.
        // Both are falsy so nothing visibly broke, but a caller checking `=== null` would have been
        // silently wrong.
        const get = renderDialogs();
        let first;
        act(() => { first = get().prompt({ label: 'Title', value: 'Old' }); });
        act(() => { get().confirm('Something else?'); });
        await expect(first).resolves.toBeNull();
    });
});

describe('toast', () => {
    const ToastHarness = () => {
        const toast = useToast();
        return <button onClick={() => toast.error('Rename failed: nope')}>fail</button>;
    };

    it('shows a notice and auto-dismisses it', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        render(<ToastProvider><ToastHarness /></ToastProvider>);

        fireEvent.click(screen.getByText('fail'));
        expect(await screen.findByText('Rename failed: nope')).toBeInTheDocument();

        await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
        expect(screen.queryByText('Rename failed: nope')).not.toBeInTheDocument();
        vi.useRealTimers();
    });

    it('can be dismissed by hand', async () => {
        render(<ToastProvider><ToastHarness /></ToastProvider>);
        fireEvent.click(screen.getByText('fail'));
        await screen.findByText('Rename failed: nope');

        fireEvent.click(screen.getByLabelText('Dismiss'));
        await waitFor(() => expect(screen.queryByText('Rename failed: nope')).not.toBeInTheDocument());
    });

    it('stacks concurrent notices instead of replacing them', async () => {
        // Two failures in the same tick are routine — a loop of per-episode requests all rejecting.
        const Multi = () => {
            const toast = useToast();
            return <button onClick={() => { toast.error('One'); toast.error('Two'); }}>both</button>;
        };
        render(<ToastProvider><Multi /></ToastProvider>);
        fireEvent.click(screen.getByText('both'));
        expect(await screen.findByText('One')).toBeInTheDocument();
        expect(screen.getByText('Two')).toBeInTheDocument();
    });
});

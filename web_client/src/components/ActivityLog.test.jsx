import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ActivityLog from './ActivityLog';
import { DialogProvider } from './ui/dialogs';
import { ToastProvider } from './ui/toast';

const entry = (over = {}) => ({
    id: 1,
    username: 'admin',
    action: 'LOGIN',
    details: 'Logged in from Windows PC',
    ip: '192.168.1.5',
    timestamp: '2026-08-18T10:00:00.000Z',
    ...over,
});

const jsonOnce = (body, ok = true, status = 200) =>
    Promise.resolve({ ok, status, statusText: ok ? 'OK' : 'Not Found', json: () => Promise.resolve(body) });

const renderLog = () => render(
    <ToastProvider>
        <DialogProvider>
            <ActivityLog token="t" serverUrl="http://pi:3005" />
        </DialogProvider>
    </ToastProvider>
);

const lastUrl = (mock) => mock.mock.calls[mock.mock.calls.length - 1][0];

describe('ActivityLog', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('renders entries and populates the user filter', async () => {
        fetchMock.mockReturnValue(jsonOnce({ logs: [entry()], usernames: ['admin', 'ranjan'] }));
        renderLog();

        expect(await screen.findByText('Logged in from Windows PC')).toBeInTheDocument();
        const select = screen.getByLabelText('Filter by user');
        expect(within(select).getByText('All users')).toBeInTheDocument();
        expect(within(select).getByText('ranjan')).toBeInTheDocument();
    });

    it('still works against a server that returns a bare array', async () => {
        // The endpoint returned an array before it gained the filter, and the built client can be
        // deployed before the server is restarted.
        fetchMock.mockReturnValue(jsonOnce([entry({ details: 'Old shape' })]));
        renderLog();
        expect(await screen.findByText('Old shape')).toBeInTheDocument();
    });

    it('asks the server to filter rather than filtering what it already has', async () => {
        // Client-side filtering would only search the fetched 100 rows, so a user whose last action
        // was older would read as having done nothing.
        fetchMock.mockReturnValue(jsonOnce({ logs: [entry()], usernames: ['admin', 'ranjan'] }));
        renderLog();
        await screen.findByText('Logged in from Windows PC');

        fireEvent.change(screen.getByLabelText('Filter by user'), { target: { value: 'ranjan' } });
        await waitFor(() => expect(lastUrl(fetchMock)).toContain('/api/admin/activity?username=ranjan'));
    });

    it('says which user has no activity when a filter is on', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ logs: [entry()], usernames: ['admin', 'ranjan'] }))
            .mockReturnValueOnce(jsonOnce({ logs: [], usernames: ['admin', 'ranjan'] }));
        renderLog();
        await screen.findByText('Logged in from Windows PC');

        fireEvent.change(screen.getByLabelText('Filter by user'), { target: { value: 'ranjan' } });
        expect(await screen.findByText('No activity recorded for ranjan')).toBeInTheDocument();
    });

    it('deletes an entry after confirming, then refetches', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ logs: [entry({ id: 42 })], usernames: ['admin'] }))
            .mockReturnValueOnce(jsonOnce({ success: true }))
            .mockReturnValueOnce(jsonOnce({ logs: [], usernames: ['admin'] }));

        renderLog();
        fireEvent.click(await screen.findByLabelText('Delete entry 42'));

        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByText('Delete'));

        await waitFor(() => {
            const del = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'DELETE');
            expect(del).toBeTruthy();
            expect(del[0]).toContain('/api/admin/activity/42');
        });
        expect(await screen.findByText('No activity recorded')).toBeInTheDocument();
    });

    it('says the deletion leaves no trace, since that is the chosen behaviour', async () => {
        fetchMock.mockReturnValue(jsonOnce({ logs: [entry({ id: 42 })], usernames: ['admin'] }));
        renderLog();
        fireEvent.click(await screen.findByLabelText('Delete entry 42'));
        expect(await screen.findByText(/keeps no record of the deletion/)).toBeInTheDocument();
    });

    it('keeps the entry when the confirmation is cancelled', async () => {
        fetchMock.mockReturnValue(jsonOnce({ logs: [entry({ id: 42 })], usernames: ['admin'] }));
        renderLog();
        fireEvent.click(await screen.findByLabelText('Delete entry 42'));

        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByText('Cancel'));

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
        expect(screen.getByText('Logged in from Windows PC')).toBeInTheDocument();
    });

    it('reports a failed delete as a toast and leaves the row', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ logs: [entry({ id: 42 })], usernames: ['admin'] }))
            .mockReturnValueOnce(jsonOnce({ error: 'Entry not found' }, false, 404));

        renderLog();
        fireEvent.click(await screen.findByLabelText('Delete entry 42'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByText('Delete'));

        expect(await screen.findByText('Delete failed: Entry not found')).toBeInTheDocument();
        expect(screen.getByText('Logged in from Windows PC')).toBeInTheDocument();
    });
});

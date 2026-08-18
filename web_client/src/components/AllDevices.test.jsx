import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AllDevices from './AllDevices';
import { DialogProvider } from './ui/dialogs';
import { ToastProvider } from './ui/toast';

const device = (over = {}) => ({
    id: 'aaaaaaaaaaaaaaaa',
    username: 'ranjan',
    role: 'user',
    device: 'Windows PC',
    deviceType: 'Desktop',
    deviceKind: 'desktop',
    ip: '192.168.1.5',
    location: 'Local Network',
    lastActive: Date.now() - 60 * 60 * 1000, // an hour ago, so not "Active now"
    isCurrent: false,
    ...over,
});

const jsonOnce = (body, ok = true, status = 200) =>
    Promise.resolve({ ok, status, statusText: ok ? 'OK' : 'Not Found', json: () => Promise.resolve(body) });

/**
 * The row action and the dialog's confirm button share the label "Sign Out", so every dialog query
 * has to be scoped to the dialog or it matches both.
 */
const clickDialogConfirm = async (label = 'Sign Out') => {
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText(label));
};

const renderCard = (props = {}) => render(
    <ToastProvider>
        <DialogProvider>
            <AllDevices token="t" serverUrl="http://pi:3005" onLogout={() => {}} {...props} />
        </DialogProvider>
    </ToastProvider>
);

describe('AllDevices', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('lists each session with its owner, role, address and relative last-active', async () => {
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ device: "RAM's Fire TV", deviceType: 'Android TV', deviceKind: 'tv' })] }));
        renderCard();

        expect(await screen.findByText('ranjan')).toBeInTheDocument();
        expect(screen.getByText("RAM's Fire TV")).toBeInTheDocument();
        expect(screen.getByText(/Android TV · 192\.168\.1\.5/)).toBeInTheDocument();
        expect(screen.getByText('1h ago')).toBeInTheDocument();
    });

    it('labels roles the way User Management does', async () => {
        fetchMock.mockReturnValue(jsonOnce({
            devices: [device({ role: 'super_admin' }), device({ id: 'b', role: 'public', device: 'Old Phone' })],
        }));
        renderCard();

        expect(await screen.findByText('Super Admin')).toBeInTheDocument();
        // Scoped to the row: the legacy 'public' role renders as "User", which is also the column
        // heading, so an unscoped query matches both.
        const publicRow = screen.getByText('Old Phone').closest('tr');
        expect(within(publicRow).getByText('User')).toBeInTheDocument();
    });

    it('says unavailable on an older server rather than claiming there are no sessions', async () => {
        fetchMock.mockReturnValue(jsonOnce({ error: 'Not Found' }, false, 404));
        renderCard();
        expect(await screen.findByText(/isn't available on this server version/)).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('signs out another user\'s device through the API, then refetches', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ devices: [device({ id: 'deadbeefdeadbeef' })] }))
            .mockReturnValueOnce(jsonOnce({ success: true }))
            .mockReturnValueOnce(jsonOnce({ devices: [] }));

        renderCard();
        fireEvent.click(await screen.findByText('Sign Out'));
        await clickDialogConfirm();

        await waitFor(() => {
            const del = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'DELETE');
            expect(del).toBeTruthy();
            expect(del[0]).toContain('/api/admin/devices/deadbeefdeadbeef');
        });
        expect(await screen.findByText('No sessions')).toBeInTheDocument();
    });

    it('names the owner and their role before revoking a super_admin session', async () => {
        // The server does not block this; stating whose session it is, is the whole guard.
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ username: 'ankit', role: 'super_admin' })] }));
        renderCard();
        fireEvent.click(await screen.findByText('Sign Out'));

        expect(await screen.findByText('Sign out a Super Admin?')).toBeInTheDocument();
        expect(screen.getByText(/belongs to ankit, who is a Super Admin/)).toBeInTheDocument();
    });

    it('signs the viewer\'s own session out via onLogout, never the API', async () => {
        const onLogout = vi.fn();
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ isCurrent: true, device: 'This Laptop' })] }));
        renderCard({ onLogout });

        fireEvent.click(await screen.findByText('Sign Out'));
        await clickDialogConfirm();

        await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
    });

    it('does nothing when the confirmation is cancelled', async () => {
        fetchMock.mockReturnValue(jsonOnce({ devices: [device()] }));
        renderCard();
        fireEvent.click(await screen.findByText('Sign Out'));
        await clickDialogConfirm('Cancel');

        await waitFor(() => expect(screen.queryByText('Sign out this device?')).not.toBeInTheDocument());
        expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
        expect(screen.getByText('Windows PC')).toBeInTheDocument();
    });

    it('reports a failed sign-out as a toast and leaves the row', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ devices: [device()] }))
            .mockReturnValueOnce(jsonOnce({ error: 'Device not found' }, false, 404));

        renderCard();
        fireEvent.click(await screen.findByText('Sign Out'));
        await clickDialogConfirm();

        expect(await screen.findByText('Sign out failed: Device not found')).toBeInTheDocument();
        expect(screen.getByText('Windows PC')).toBeInTheDocument();
    });
});

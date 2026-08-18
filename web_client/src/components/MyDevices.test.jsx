import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import MyDevices from './MyDevices';
import { DialogProvider } from './ui/dialogs';
import { ToastProvider } from './ui/toast';

const device = (over = {}) => ({
    id: 'aaaaaaaaaaaaaaaa',
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
 * Confirmations and failure notices come from the app's own dialog/toast layer now, not
 * window.confirm/alert, so the component has to be rendered inside both providers — the hooks throw
 * without them, deliberately, so a missing provider fails loudly rather than silently swallowing an
 * error message.
 */
const renderCard = (props = {}) => render(
    <ToastProvider>
        <DialogProvider>
            <MyDevices token="t" serverUrl="http://pi:3005" onLogout={() => {}} {...props} />
        </DialogProvider>
    </ToastProvider>
);

// The row action and the dialog's confirm button share the label "Sign Out", so dialog queries have
// to be scoped or they match both.
const clickDialog = async (label) => {
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText(label));
};

describe('MyDevices', () => {
    // vi.stubGlobal rather than assigning `global.fetch`: this project's eslint env is the browser
    // one, which has no Node `global`, and stubGlobal is undone by unstubAllGlobals below.
    let fetchMock;
    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('lists each device with its type, address and relative last-active', async () => {
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ device: 'RAM\'s Fire TV', deviceType: 'Android TV', deviceKind: 'tv' })] }));
        renderCard();

        expect(await screen.findByText("RAM's Fire TV")).toBeInTheDocument();
        expect(screen.getByText(/Android TV · 192\.168\.1\.5/)).toBeInTheDocument();
        expect(screen.getByText('Local Network')).toBeInTheDocument();
        expect(screen.getByText('1h ago')).toBeInTheDocument();
    });

    it('marks only the current device, and shows "Active now" while it is live', async () => {
        fetchMock.mockReturnValue(jsonOnce({
            devices: [
                device({ id: 'current00000000', device: 'This Laptop', isCurrent: true, lastActive: Date.now() }),
                device({ id: 'other000000000', device: 'Old Phone' }),
            ],
        }));
        renderCard();

        await screen.findByText('This Laptop');
        expect(screen.getAllByText('THIS DEVICE')).toHaveLength(1);
        expect(screen.getByText('Active now')).toBeInTheDocument();
    });

    it('says the feature is unavailable on an older server rather than claiming no devices', async () => {
        // The distinction matters: "no devices" would be a claim the reader can disprove by
        // looking at the device they are reading it on.
        fetchMock.mockReturnValue(jsonOnce({ error: 'Not Found' }, false, 404));
        renderCard();

        expect(await screen.findByText(/aren't available on this server version/)).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('signs out another device through the API and refetches', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ devices: [device({ id: 'deadbeefdeadbeef', device: 'Old Phone' })] }))
            .mockReturnValueOnce(jsonOnce({ success: true }))
            .mockReturnValueOnce(jsonOnce({ devices: [] }));

        renderCard();
        fireEvent.click(await screen.findByText('Sign Out'));
        await clickDialog('Sign Out');

        await waitFor(() => {
            const del = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'DELETE');
            expect(del).toBeTruthy();
            expect(del[0]).toContain('/api/auth/devices/deadbeefdeadbeef');
        });
        expect(await screen.findByText('No signed-in devices found.')).toBeInTheDocument();
    });

    it('signs the current device out via onLogout, never the API', async () => {
        // Deleting your own row from here would leave the page running on a dead token.
        const onLogout = vi.fn();
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ device: 'This Laptop', isCurrent: true })] }));

        renderCard({ onLogout });
        fireEvent.click(await screen.findByText('Sign Out'));
        await clickDialog('Sign Out');

        await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
    });

    it('hides the current device\'s action when no onLogout was provided', async () => {
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ device: 'This Laptop', isCurrent: true })] }));
        renderCard({ onLogout: undefined });

        await screen.findByText('This Laptop');
        expect(screen.queryByText('Sign Out')).not.toBeInTheDocument();
    });

    it('reports a failed sign-out instead of silently dropping the row', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ devices: [device({ device: 'Old Phone' })] }))
            .mockReturnValueOnce(jsonOnce({ error: 'Device not found' }, false, 404));

        renderCard();
        fireEvent.click(await screen.findByText('Sign Out'));
        await clickDialog('Sign Out');

        expect(await screen.findByText('Sign out failed: Device not found')).toBeInTheDocument();
        expect(screen.getByText('Old Phone')).toBeInTheDocument();
    });
});

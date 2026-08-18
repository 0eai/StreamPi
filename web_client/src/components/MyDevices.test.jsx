import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MyDevices from './MyDevices';

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

describe('MyDevices', () => {
    // vi.stubGlobal rather than assigning `global.fetch`: this project's eslint env is the browser
    // one, which has no Node `global`, and stubGlobal is undone by unstubAllGlobals below.
    let fetchMock;
    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.spyOn(window, 'alert').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('lists each device with its type, address and relative last-active', async () => {
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ device: 'RAM\'s Fire TV', deviceType: 'Android TV', deviceKind: 'tv' })] }));
        render(<MyDevices token="t" serverUrl="http://pi:3005" onLogout={() => {}} />);

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
        render(<MyDevices token="t" serverUrl="http://pi:3005" onLogout={() => {}} />);

        await screen.findByText('This Laptop');
        expect(screen.getAllByText('THIS DEVICE')).toHaveLength(1);
        expect(screen.getByText('Active now')).toBeInTheDocument();
    });

    it('says the feature is unavailable on an older server rather than claiming no devices', async () => {
        // The distinction matters: "no devices" would be a claim the reader can disprove by
        // looking at the device they are reading it on.
        fetchMock.mockReturnValue(jsonOnce({ error: 'Not Found' }, false, 404));
        render(<MyDevices token="t" serverUrl="http://pi:3005" onLogout={() => {}} />);

        expect(await screen.findByText(/aren't available on this server version/)).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('signs out another device through the API and refetches', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ devices: [device({ id: 'deadbeefdeadbeef', device: 'Old Phone' })] }))
            .mockReturnValueOnce(jsonOnce({ success: true }))
            .mockReturnValueOnce(jsonOnce({ devices: [] }));

        render(<MyDevices token="t" serverUrl="http://pi:3005" onLogout={() => {}} />);
        fireEvent.click(await screen.findByText('Sign Out'));

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

        render(<MyDevices token="t" serverUrl="http://pi:3005" onLogout={onLogout} />);
        fireEvent.click(await screen.findByText('Sign Out'));

        await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
    });

    it('hides the current device\'s action when no onLogout was provided', async () => {
        fetchMock.mockReturnValue(jsonOnce({ devices: [device({ device: 'This Laptop', isCurrent: true })] }));
        render(<MyDevices token="t" serverUrl="http://pi:3005" />);

        await screen.findByText('This Laptop');
        expect(screen.queryByText('Sign Out')).not.toBeInTheDocument();
    });

    it('reports a failed sign-out instead of silently dropping the row', async () => {
        fetchMock
            .mockReturnValueOnce(jsonOnce({ devices: [device({ device: 'Old Phone' })] }))
            .mockReturnValueOnce(jsonOnce({ error: 'Device not found' }, false, 404));

        render(<MyDevices token="t" serverUrl="http://pi:3005" onLogout={() => {}} />);
        fireEvent.click(await screen.findByText('Sign Out'));

        await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Sign out failed: Device not found'));
        expect(screen.getByText('Old Phone')).toBeInTheDocument();
    });
});

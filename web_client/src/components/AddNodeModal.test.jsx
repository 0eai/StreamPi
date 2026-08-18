import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AddNodeModal from './AddNodeModal';

const jsonOnce = (body, ok = true, status = 200) =>
    Promise.resolve({ ok, status, statusText: ok ? 'OK' : 'Bad Request', json: () => Promise.resolve(body) });

const renderModal = (props = {}) => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AddNodeModal isOpen onClose={onClose} token="t" serverUrl="http://pi:3005" onCreated={onCreated} {...props} />);
    return { onCreated, onClose };
};

const bodyOf = (mock) => JSON.parse(mock.mock.calls[0][1].body);

describe('AddNodeModal', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('creates a node from a name alone, sending no roles', async () => {
        // Roles are deliberately absent: the server no longer accepts them, and a node's real roles
        // come from its own node_config.json.
        fetchMock.mockReturnValue(jsonOnce({ success: true, id: 'ankit_22abee', name: 'ankit', apiKey: 'deadbeef' }));
        const { onCreated } = renderModal();

        fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ankit  ' } });
        fireEvent.click(screen.getByText('Create Node'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls[0][0]).toContain('/api/admin/nodes');
        expect(bodyOf(fetchMock)).toEqual({ name: 'ankit' });
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'deadbeef' })));
    });

    it('offers no roles control at all', async () => {
        renderModal();
        expect(screen.queryByText('Transcoder')).not.toBeInTheDocument();
        expect(screen.queryByText('NAS Storage')).not.toBeInTheDocument();
        // ...but says where roles actually come from, so their absence doesn't read as an omission.
        expect(screen.getByText(/node_config\.json/)).toBeInTheDocument();
    });

    it('refuses a blank name without calling the server', async () => {
        renderModal();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
        fireEvent.click(screen.getByText('Create Node'));

        expect(await screen.findByText('Name is required')).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces the server error and stays open', async () => {
        fetchMock.mockReturnValue(jsonOnce({ error: 'Name is required' }, false, 400));
        const { onCreated } = renderModal();

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ankit' } });
        fireEvent.click(screen.getByText('Create Node'));

        expect(await screen.findByText('Name is required')).toBeInTheDocument();
        expect(onCreated).not.toHaveBeenCalled();
        expect(screen.getByText('Create Node')).toBeEnabled();
    });

    it('re-enables the button after a success, so a reopened modal is usable', async () => {
        // The success path used to leave loading true; the modal only looked fine because closing it
        // unmounted the body.
        fetchMock.mockReturnValue(jsonOnce({ success: true, id: 'n1', name: 'n', apiKey: 'k' }));
        const { onClose } = renderModal();

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ankit' } });
        fireEvent.click(screen.getByText('Create Node'));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(screen.getByText('Create Node')).toBeEnabled();
    });
});

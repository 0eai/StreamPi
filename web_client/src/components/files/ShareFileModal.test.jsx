import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ShareFileModal from './ShareFileModal';
import { ToastProvider } from '../ui/toast';

const USERS = [{ id: 2, username: 'ranjan' }, { id: 3, username: 'sagarkumar' }];

const renderModal = (props = {}) => {
    const onShareWithUsers = vi.fn().mockResolvedValue(undefined);
    const onCreateLink = vi.fn().mockResolvedValue('http://pi/f/tok-123');
    const onClose = vi.fn();
    render(
        <ToastProvider>
            <ShareFileModal
                item={{ id: 'n1', name: 'report.pdf', isFolder: false }}
                users={USERS}
                onClose={onClose}
                onShareWithUsers={onShareWithUsers}
                onCreateLink={onCreateLink}
                {...props}
            />
        </ToastProvider>
    );
    return { onShareWithUsers, onCreateLink, onClose };
};

describe('ShareFileModal', () => {
    it('renders nothing without an item', () => {
        const { container } = render(<ToastProvider><ShareFileModal item={null} onClose={() => {}} /></ToastProvider>);
        expect(container).toBeEmptyDOMElement();
    });

    it('shares with several people at once', async () => {
        const { onShareWithUsers } = renderModal();
        fireEvent.change(screen.getByLabelText('Share with'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Add'));
        fireEvent.change(screen.getByLabelText('Share with'), { target: { value: '3' } });
        fireEvent.click(screen.getByText('Add'));

        fireEvent.click(screen.getByText('Share'));
        await waitFor(() => expect(onShareWithUsers).toHaveBeenCalledWith([2, 3], ''));
    });

    it('stops offering someone already added, and lets them be removed', () => {
        renderModal();
        fireEvent.change(screen.getByLabelText('Share with'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Add'));

        const picker = screen.getByLabelText('Share with');
        expect(picker.innerHTML).not.toContain('ranjan');

        fireEvent.click(screen.getByLabelText('Remove ranjan'));
        expect(screen.getByLabelText('Share with').innerHTML).toContain('ranjan');
    });

    it('cannot share with nobody', () => {
        renderModal();
        expect(screen.getByText('Share')).toBeDisabled();
    });

    it('passes the chosen expiry through', async () => {
        const { onShareWithUsers } = renderModal();
        fireEvent.change(screen.getByLabelText('Share with'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Add'));
        fireEvent.change(screen.getByLabelText('Expires'), { target: { value: String(24 * 7) } });
        fireEvent.click(screen.getByText('Share'));
        await waitFor(() => expect(onShareWithUsers).toHaveBeenCalledWith([2], '168'));
    });

    it('switches to a link and shows it for copying', async () => {
        const { onCreateLink } = renderModal();
        fireEvent.click(screen.getByLabelText('Anyone with the link'));
        fireEvent.click(screen.getByText('Create link'));

        await waitFor(() => expect(onCreateLink).toHaveBeenCalled());
        expect(await screen.findByText('http://pi/f/tok-123')).toBeInTheDocument();
        // The recipient picker is gone once there is a link — the two modes are exclusive.
        expect(screen.queryByLabelText('Share with')).not.toBeInTheDocument();
    });

    it('warns that sharing a folder shares everything inside it', () => {
        // The surprising half of folder sharing, said before the decision rather than after.
        renderModal({ item: { id: 'n2', name: 'Photos', isFolder: true } });
        expect(screen.getByText(/everything inside it/)).toBeInTheDocument();
        expect(screen.getByText(/including files you add later/)).toBeInTheDocument();
    });

    it('says there are no notifications, since nothing tells the recipient', () => {
        renderModal();
        expect(screen.getByText(/no notifications/)).toBeInTheDocument();
    });
});

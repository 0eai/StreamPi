import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import TransferNodeModal from './TransferNodeModal';

const USERS = [
    { id: 18, username: 'sagarkumar', role: 'public' },
    { id: 5, username: 'ankit', role: 'admin' },
    { id: 11, username: 'ranjan', role: 'admin' },
];

const node = (over = {}) => ({ id: 'ankit_22abee', name: 'ankit', ownerUserId: null, ownerUsername: null, ...over });

const renderModal = (props = {}) => {
    const onTransfer = vi.fn().mockResolvedValue(undefined);
    const onRelease = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<TransferNodeModal node={node()} users={USERS} onClose={onClose} onTransfer={onTransfer} onRelease={onRelease} {...props} />);
    return { onTransfer, onRelease, onClose };
};

const picker = () => screen.getByLabelText('Assign to');

describe('TransferNodeModal', () => {
    it('renders nothing without a node, so the caller can hold null', () => {
        const { container } = render(<TransferNodeModal node={null} users={USERS} onClose={() => {}} onTransfer={() => {}} onRelease={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('marks admins as already having full access', () => {
        // The whole reason the inline dropdown was replaced: it listed admins identically, implying
        // ownership granted them something. It does not — they bypass the ownership check.
        renderModal();
        expect(within(picker()).getByText('ankit (admin — full access already)')).toBeInTheDocument();
        expect(within(picker()).getByText('ranjan (admin — full access already)')).toBeInTheDocument();
        // A non-admin gets no annotation, because for them it is a real grant.
        expect(within(picker()).getByText('sagarkumar')).toBeInTheDocument();
    });

    it('spells out what a non-admin owner will be able to do', () => {
        renderModal();
        fireEvent.change(picker(), { target: { value: '18' } });
        expect(screen.getByText(/sagarkumar will be able to view this node/)).toBeInTheDocument();
    });

    it('transfers to the selected user', async () => {
        const { onTransfer } = renderModal();
        fireEvent.change(picker(), { target: { value: '18' } });
        fireEvent.click(screen.getByText('Transfer'));
        await waitFor(() => expect(onTransfer).toHaveBeenCalledWith(18));
    });

    it('cannot transfer until a user is chosen', () => {
        renderModal();
        expect(screen.getByText('Transfer')).toBeDisabled();
    });

    it('will not reassign to the current owner', () => {
        renderModal({ node: node({ ownerUserId: 5, ownerUsername: 'ankit' }) });
        const current = within(picker()).getByText('ankit (current owner)');
        expect(current).toBeDisabled();
    });

    it('says an admin owner gained nothing, but that the node is still reserved', () => {
        renderModal({ node: node({ ownerUserId: 5, ownerUsername: 'ankit' }) });
        expect(screen.getByText(/who is an admin, so this grants them no access/)).toBeInTheDocument();
        expect(screen.getByText(/stop anyone else claiming/)).toBeInTheDocument();
    });

    it('offers no release section for an unowned node', () => {
        renderModal();
        expect(screen.queryByText('Release ownership')).not.toBeInTheDocument();
        expect(screen.getByText(/Whoever holds this node's API key can claim it/)).toBeInTheDocument();
    });

    it('offers both release paths, and distinguishes them', async () => {
        const { onRelease } = renderModal({ node: node({ ownerUserId: 18, ownerUsername: 'sagarkumar' }) });
        expect(screen.getByText('Release ownership')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Release only'));
        await waitFor(() => expect(onRelease).toHaveBeenCalledWith({ regenerate: false }));

        fireEvent.click(screen.getByText('Release + Regenerate Key'));
        await waitFor(() => expect(onRelease).toHaveBeenCalledWith({ regenerate: true }));
    });

    it('warns that releasing alone leaves the old owner holding the key', () => {
        renderModal({ node: node({ ownerUserId: 18, ownerUsername: 'sagarkumar' }) });
        expect(screen.getByText(/sagarkumar keeps a copy of this node's\s+API key/)).toBeInTheDocument();
    });

    it('explains an owner whose account is gone, rather than showing a blank', () => {
        // Deleting a user now clears node ownership, but rows predating that fix still point at a
        // missing account — and until released, nobody can claim the node.
        renderModal({ node: node({ ownerUserId: 999, ownerUsername: null }) });
        expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
        expect(screen.getByText('Release ownership')).toBeInTheDocument();
    });
});

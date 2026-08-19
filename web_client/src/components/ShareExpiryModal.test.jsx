import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ShareExpiryModal from './ShareExpiryModal';

const share = (over = {}) => ({ token: 'tok', title: 'Oppenheimer', expiresAt: null, ...over });

const renderModal = (props = {}) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ShareExpiryModal share={share()} onClose={onClose} onSave={onSave} {...props} />);
    return { onSave, onClose };
};

describe('ShareExpiryModal', () => {
    it('renders nothing without a share, so the caller can hold null', () => {
        const { container } = render(<ShareExpiryModal share={null} onClose={() => {}} onSave={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says a link with no expiry keeps working until revoked', () => {
        renderModal();
        expect(screen.getByText(/never expires/)).toBeInTheDocument();
        expect(screen.getByText(/until you revoke it/)).toBeInTheDocument();
    });

    it('shows the current deadline both relatively and absolutely', () => {
        // Relative alone is ambiguous for anything past a day; absolute alone is hard to scan.
        // Deliberately 6 days *and an hour*: at exactly 6 days, the milliseconds between building
        // this string and the component reading the clock round the floor down to "in 5d".
        const future = new Date(Date.now() + (6 * 24 + 1) * 3600_000).toISOString();
        renderModal({ share: share({ expiresAt: future }) });
        expect(screen.getByText('in 6d')).toBeInTheDocument();
        expect(screen.getByText(new RegExp(new Date(future).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    });

    it('sends the chosen duration in hours', async () => {
        const { onSave } = renderModal();
        fireEvent.change(screen.getByLabelText('Change to'), { target: { value: String(24 * 7) } });
        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith('168'));
    });

    it('sends an empty value to clear the expiry, which the server reads as never', async () => {
        const future = new Date(Date.now() + 3600_000).toISOString();
        const { onSave } = renderModal({ share: share({ expiresAt: future }) });
        // "Never expires" is the default selection, so saving straight away clears it.
        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith(''));
    });

    it('says the countdown starts now, not from when the link was made', () => {
        // Otherwise "1 hour" on a week-old link reads as though it expired six days ago.
        renderModal();
        expect(screen.getByText('Counted from now.')).toBeInTheDocument();
    });

    it('cancels without saving', () => {
        const { onSave, onClose } = renderModal();
        fireEvent.click(screen.getByText('Cancel'));
        expect(onClose).toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
    });
});

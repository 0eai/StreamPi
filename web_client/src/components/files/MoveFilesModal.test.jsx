import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import MoveFilesModal from './MoveFilesModal';

/**
 * The exclusions are the point of this dialog: the destinations it *doesn't* offer are what stop a
 * user creating a cycle or asking for a move the server will refuse.
 */
const FOLDERS = [
    { id: 'root', name: 'Home', isRoot: true, depth: 0, pathIds: '/root/' },
    { id: 'docs', name: 'Docs', depth: 1, pathIds: '/root/docs/' },
    { id: 'docs-2025', name: '2025', depth: 2, pathIds: '/root/docs/docs-2025/' },
    { id: 'photos', name: 'Photos', depth: 1, pathIds: '/root/photos/', sharedWith: 'ranjan and sagarkumar' },
];

const renderModal = (props = {}) => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
        <MoveFilesModal
            isOpen
            onClose={onClose}
            onMove={onMove}
            items={[{ id: 'file-1', name: 'a.txt', isFolder: false }]}
            folders={FOLDERS}
            currentParentId="root"
            {...props}
        />
    );
    return { onMove, onClose };
};

const options = () => within(screen.getByLabelText('Destination')).getAllByRole('option').map((o) => o.textContent.trim());

describe('MoveFilesModal', () => {
    it('renders nothing when closed', () => {
        const { container } = render(<MoveFilesModal isOpen={false} onClose={() => {}} onMove={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('leaves out the folder the items are already in', () => {
        renderModal();
        expect(options().some((o) => o.includes('Home'))).toBe(false);
        expect(options().some((o) => o.includes('Docs'))).toBe(true);
    });

    it('leaves out a moved folder and everything inside it', () => {
        // This is the cycle rule made visible: without it a user could ask to move Docs into
        // Docs/2025, and the server would have to refuse after the fact.
        renderModal({ items: [{ id: 'docs', name: 'Docs', isFolder: true, pathIds: '/root/docs/' }] });
        const listed = options();
        expect(listed.some((o) => o.includes('Docs'))).toBe(false);
        expect(listed.some((o) => o.includes('2025'))).toBe(false);
        expect(listed.some((o) => o.includes('Photos'))).toBe(true);
    });

    it('warns that a shared destination widens who can read what is moved there', async () => {
        // The consequence people are most likely to get wrong, said at the moment of the move.
        renderModal();
        fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'photos' } });
        expect(await screen.findByText(/becomes visible to them/)).toBeInTheDocument();
        expect(screen.getByText(/ranjan and sagarkumar/)).toBeInTheDocument();
    });

    it('says nothing about sharing for an unshared destination', () => {
        renderModal();
        fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'docs' } });
        expect(screen.queryByText(/becomes visible to them/)).not.toBeInTheDocument();
    });

    it('cannot submit until a destination is chosen', () => {
        renderModal();
        expect(screen.getByText('Move')).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'docs' } });
        expect(screen.getByText('Move')).toBeEnabled();
    });

    it('moves to the chosen folder', async () => {
        const { onMove } = renderModal();
        fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'docs' } });
        fireEvent.click(screen.getByText('Move'));
        await waitFor(() => expect(onMove).toHaveBeenCalledWith('docs'));
    });

    it('explains itself when there is nowhere left to move to', () => {
        // Reachable in the ordinary case of one top-level folder being moved, and an empty select with
        // a disabled button would leave someone guessing why.
        renderModal({ folders: [FOLDERS[0]], currentParentId: 'root' });
        expect(screen.getByText(/nowhere else to move/)).toBeInTheDocument();
    });
});

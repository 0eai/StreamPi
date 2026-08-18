import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TopNav from './TopNav';

/**
 * The dropdown used to be dismissed by a `fixed inset-0` overlay rendered inside the <nav>. The
 * nav carries backdrop-blur, and backdrop-filter establishes a containing block for fixed
 * descendants, so inset-0 covered only the header strip — clicking anywhere in the page below it
 * left the menu open. These pin the replacement.
 */
const props = () => ({
    username: 'admin',
    role: 'super_admin',
    activeTab: 'home',
    setActiveTab: vi.fn(),
    setSelectedSeries: vi.fn(),
    token: 't',
    serverUrl: 'http://pi:3005',
    onUploadClick: vi.fn(),
    onLogout: vi.fn(),
});

const openMenu = () => fireEvent.click(screen.getByLabelText('User Menu'));

describe('TopNav user menu', () => {
    beforeEach(() => {
        // ServerStats polls on mount; keep it off the network.
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('opens on the user button', () => {
        render(<TopNav {...props()} />);
        expect(screen.queryByText('Logout')).not.toBeInTheDocument();
        openMenu();
        expect(screen.getByText('Logout')).toBeInTheDocument();
    });

    it('closes on a click anywhere outside it', () => {
        // The regression: this is a click in the page body, far from the header the old overlay
        // was confined to.
        render(<><div data-testid="page">page content</div><TopNav {...props()} /></>);
        openMenu();
        expect(screen.getByText('Logout')).toBeInTheDocument();

        fireEvent.mouseDown(screen.getByTestId('page'));
        expect(screen.queryByText('Logout')).not.toBeInTheDocument();
    });

    it('stays open when the click lands inside it', () => {
        render(<TopNav {...props()} />);
        openMenu();
        fireEvent.mouseDown(screen.getByText('Settings'));
        expect(screen.getByText('Logout')).toBeInTheDocument();
    });

    it('closes on Escape', () => {
        render(<TopNav {...props()} />);
        openMenu();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByText('Logout')).not.toBeInTheDocument();
    });

    it('does not swallow the outside click it closed on', () => {
        // The old overlay intercepted it, so dismissing the menu and hitting the control you were
        // aiming at cost two clicks.
        const onPageClick = vi.fn();
        render(<><button onClick={onPageClick}>Elsewhere</button><TopNav {...props()} /></>);
        openMenu();

        fireEvent.mouseDown(screen.getByText('Elsewhere'));
        fireEvent.click(screen.getByText('Elsewhere'));
        expect(onPageClick).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Logout')).not.toBeInTheDocument();
    });

    it('closes when a menu item navigates', () => {
        const setActiveTab = vi.fn();
        render(<TopNav {...props()} setActiveTab={setActiveTab} />);
        openMenu();
        fireEvent.click(screen.getByText('Settings'));
        expect(setActiveTab).toHaveBeenCalledWith('settings');
        expect(screen.queryByText('Logout')).not.toBeInTheDocument();
    });
});

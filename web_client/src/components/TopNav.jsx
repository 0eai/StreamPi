import React, { useEffect, useRef, useState } from 'react';
import { Home, LayoutDashboard, Compass, LogOut, User, UploadCloud, Film, Tv, Settings as SettingsIcon, Download as DownloadIcon, FolderOpen } from 'lucide-react';
import ServerStats from './ServerStats';
import Button from './ui/Button';

// Only the primary browsing tabs live in the top bar now — Discovery, Settings, and (for
// admins) Dashboard moved into the user dropdown below.
const TABS = [
    { id: 'home', label: 'Home', Icon: Home },
    { id: 'movies', label: 'Movies', Icon: Film },
    { id: 'series', label: 'Series', Icon: Tv },
    { id: 'files', label: 'Files', Icon: FolderOpen },
];

// Peeled off StreamApp.jsx — owns everything about the nav bar itself: tabs, the upload
// trigger, and the user menu (which now also doubles as the entry point for
// Discovery/Settings/Dashboard, not just account actions).
const TopNav = ({ username, role, activeTab, setActiveTab, setSelectedSeries, token, serverUrl, onUploadClick, onLogout }) => {
    const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
    const userMenuRef = useRef(null);

    // Closed from document-level listeners rather than a full-screen overlay div, which is what
    // this used to do. That overlay was `fixed inset-0` *inside* this nav, and the nav carries
    // backdrop-blur — backdrop-filter establishes a containing block for fixed descendants, so
    // inset-0 resolved against the header strip instead of the viewport. The overlay therefore
    // only covered the header, and a click anywhere in the page below it never closed the menu.
    //
    // Listening on the document also fixes a second thing the overlay got wrong even where it
    // did cover: it swallowed the click, so dismissing the menu and pressing the button you were
    // aiming at took two clicks. mousedown just closes and lets the event continue.
    useEffect(() => {
        if (!isUserMenuOpen) return;

        const onPointerDown = (e) => {
            if (!userMenuRef.current?.contains(e.target)) setIsUserMenuOpen(false);
        };
        const onKeyDown = (e) => { if (e.key === 'Escape') setIsUserMenuOpen(false); };

        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [isUserMenuOpen]);

    const menuItems = [
        { id: 'discovery', label: 'Discovery', Icon: Compass },
        // Server-side this is enforced by /api/admin/dashboard's own role check — hidden
        // here too so a non-admin isn't shown an item that just 403s.
        ...(role === 'super_admin' || role === 'admin' ? [{ id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard }] : []),
        { id: 'settings', label: 'Settings', Icon: SettingsIcon },
    ];

    const goToTab = (id) => { setActiveTab(id); setSelectedSeries(null); setIsUserMenuOpen(false); };

    // pt-[max(...)] below, rather than the plain py-3 this replaced: index.html declares
    // viewport-fit=cover + apple-mobile-web-app-status-bar-style=black-translucent, which is
    // exactly what makes an installed iOS PWA draw edge-to-edge under the status bar instead
    // of iOS reserving space for it automatically — env(safe-area-inset-top) is the
    // compensating inset for that, and max() keeps the normal 0.75rem padding on every device
    // that reports 0 (i.e. not an installed iOS PWA at all).
    return (
        <nav className="fixed top-0 w-full z-40 bg-gradient-to-b from-bg/90 to-transparent px-4 md:px-6 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] grid grid-cols-[1fr_auto_1fr] items-center gap-4 backdrop-blur-[2px]">
                {/* One active-state treatment for all tabs (accent bg + accent text),
                    replacing the previous per-tab colors (white/blue-400/red-500 — the last
                    of which didn't even match the red-600 brand accent used everywhere else). */}
                <div className="flex items-center gap-1 md:gap-2 text-sm font-medium text-muted overflow-hidden">
                    {TABS.map(({ id, label, Icon }) => (
                        <button
                            key={id}
                            onClick={() => { setActiveTab(id); setSelectedSeries(null); }}
                            className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${activeTab === id ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2 hover:text-text'}`}
                            title={label}
                        >
                            <Icon className="w-5 h-5" />
                            <span className="hidden md:inline">{label}</span>
                        </button>
                    ))}
                </div>

                {/* Center column is sized to its content (grid-cols-[1fr_auto_1fr]), with the
                    two flanking 1fr columns splitting whatever space is left equally — that's
                    what keeps this centered on the *whole* bar regardless of how wide the tabs
                    or the right-side actions are, rather than just centered in leftover space. */}
                <div
                    className="flex items-center justify-center cursor-pointer whitespace-nowrap"
                    onClick={() => { setSelectedSeries(null); setActiveTab('home'); }}
                    title="StreamPi"
                >
                    <img src="/logo.png" alt="StreamPi" className="h-9 w-auto object-contain" />
                    {/* Sized a bit under the logo's h-9 (36px) rather than matching it
                        exactly — full height read as too heavy next to the mark.
                        Gradient matches the logo mark's own blue → purple → pink diagonal. */}
                    <span className="ml-2 text-[26px] leading-none font-bold bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 bg-clip-text text-transparent hidden sm:inline">
                        StreamPi
                    </span>
                </div>

                {/* Right Side Actions */}
                <div className="flex items-center justify-end gap-2 md:gap-4">

                    <ServerStats token={token} serverUrl={serverUrl} />

                    <Button variant="ghost" onClick={onUploadClick} title="Upload">
                        <UploadCloud className="w-4 h-4" />
                        <span className="hidden sm:inline">Upload</span>
                    </Button>

                    {/* USER DROPDOWN MENU */}
                    <div className="relative" ref={userMenuRef}>
                        {/* User Icon Button — soft accent tint while open, same "this is the
                            active thing" language as the nav tabs, instead of a full white/black
                            invert. */}
                        <Button
                            variant="icon"
                            onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                            className={isUserMenuOpen ? 'bg-accent-soft text-accent' : ''}
                            title="User Menu"
                            aria-label="User Menu"
                        >
                            <User className="w-5 h-5" />
                        </Button>

                        {/* The Popup Menu */}
                        {isUserMenuOpen && (
                            <div className="absolute right-0 mt-2 w-56 bg-surface border border-border rounded-lg shadow-2xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-200 origin-top-right">

                                <div className="px-4 py-3 border-b border-border bg-surface-2/50">
                                    <p className="text-sm text-text font-semibold truncate">
                                        {username}
                                    </p>
                                </div>

                                <div className="p-1">
                                    {/* Discovery / (admin) Dashboard / Settings — moved here
                                        from the top tab bar, which now only holds the primary
                                        browsing tabs (Home/Movies/Series). */}
                                    {menuItems.map(({ id, label, Icon }) => (
                                        <button
                                            key={id}
                                            onClick={() => goToTab(id)}
                                            className={`w-full text-left px-4 py-2.5 text-sm rounded-md flex items-center gap-3 transition-colors ${activeTab === id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-text'}`}
                                        >
                                            <Icon className="w-4 h-4" />
                                            {label}
                                        </button>
                                    ))}

                                    {/* A real page (reachable without login too, see
                                        main.jsx) rather than a tab switch, so this is a plain
                                        navigation link, not a goToTab button. */}
                                    <a
                                        href="/download"
                                        className="w-full text-left px-4 py-2.5 text-sm rounded-md flex items-center gap-3 transition-colors text-muted hover:bg-surface-2 hover:text-text"
                                    >
                                        <DownloadIcon className="w-4 h-4" />
                                        Downloads
                                    </a>

                                    <div className="my-1 border-t border-border" />

                                    {/* Logout Option — quiet at rest, only turns red on hover, same
                                        "danger stays quiet until you're about to act" language as
                                        Button's danger variant. */}
                                    <button
                                        onClick={() => { setIsUserMenuOpen(false); onLogout(); }}
                                        className="w-full text-left px-4 py-2.5 text-sm text-muted hover:bg-danger/10 hover:text-danger rounded-md flex items-center gap-3 transition-colors"
                                    >
                                        <LogOut className="w-4 h-4" />
                                        Logout
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
        </nav>
    );
};

export default TopNav;

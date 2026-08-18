import React, { useEffect, useState } from 'react';
import { Film, Tv, Clock, Pencil, WifiOff } from 'lucide-react';
import { SERVER_URL, apiFetch } from './utils/api';
import { getDeviceInfo } from './utils/device';
import { useNasAvailability } from './utils/nas';
import { usePolling } from './utils/usePolling';
import { useLibraryActions } from './utils/useLibraryActions';
import { useUploads } from './utils/useUploads';
import LoginScreen from './components/LoginScreen';
import TopNav from './components/TopNav';
import Discovery from './components/Discovery';
import DashboardTab from './components/DashboardTab';
import SettingsTab from './components/SettingsTab';
import Poster from './components/Poster';
import EpisodeCard from './components/EpisodeCard';
import UploadQueue from './components/UploadQueue';
import UploadWizard from './components/UploadWizard';
import CustomVideoPlayer from './components/CustomVideoPlayer';
import ShareModal from './components/ShareModal';
import CastModal from './components/CastModal';
import ErrorBoundary from './components/ErrorBoundary';

export default function StreamApp() {
    const [token, setToken] = useState(() => localStorage.getItem('auth_token'));
    const [username, setUsername] = useState(() => localStorage.getItem('auth_username') || 'Guest');
    const [role, setRole] = useState(() => localStorage.getItem('auth_role') || null);
    const [activeVideo, setActiveVideo] = useState(null);
    const [activeTab, setActiveTab] = useState('home');
    const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
    const [castItem, setCastItem] = useState(null);

    const handleLogin = (newToken, newUsername, newRole) => {
        setToken(newToken);
        setUsername(newUsername);
        setRole(newRole);
        localStorage.setItem('auth_token', newToken);
        localStorage.setItem('auth_username', newUsername);
        if (newRole) localStorage.setItem('auth_role', newRole);
    };

    const handleLogout = async () => {
        // 👇 Notify server first
        try {
            if (token) await apiFetch(SERVER_URL, '/api/auth/logout', token, { method: 'POST' });
        } catch (e) { /* Ignore network errors on logout */ }

        uploads.abortAll();

        // Clear local state
        setToken(null);
        setUsername(null);
        setRole(null);
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_username');
        localStorage.removeItem('auth_role');
        libraryActions.resetLibrary();
        setActiveVideo(null);
        setActiveTab('home');
    };

    // Keep this session's device label current, the same way the TV app does. The label is
    // written once at login, so a browser signed in months ago still carries whatever
    // getDeviceInfo() guessed then — which is the same root cause as a Fire TV showing up as
    // "Unknown Device / Web Browser". Best-effort: older servers 404 this route.
    //
    // Note this makes labels current, not correct: getDeviceInfo tests /linux/i before its TV
    // arm, so many smart-TV browsers still report "Linux PC".
    useEffect(() => {
        if (!token) return;
        const { device, type } = getDeviceInfo();
        apiFetch(SERVER_URL, '/api/auth/session/device', token, {
            method: 'POST',
            json: { device, device_type: type },
        }).catch(() => { /* label stays as-is; nothing user-visible depends on it here */ });
    }, [token]);

    const libraryActions = useLibraryActions(token, SERVER_URL, handleLogout);
    // Polled separately from the library: node reachability changes while the page is
    // open, and the library is fetched once per load.
    const availableNodeIds = useNasAvailability(SERVER_URL, token);
    const { library, loadError, selectedSeries, setSelectedSeries, fetchData, moveStatus, shareLink, setShareLink, handleDelete, handleDeleteSeries, handleRenameMovie, handleRenameSeries, handleMove, handleTogglePrivacy, handleShare } = libraryActions;

    const uploads = useUploads(token, SERVER_URL, fetchData);

    // The receiver half of "Play On…" (CastModal/Poster/EpisodeCard's Cast button) — mirrors
    // StreamPiTV's own idle-screen poll of the same endpoint. Skips the request entirely while
    // something is already playing, same as the TV app: its poll loop lives in HomeScreen and
    // stops the moment PlayerScreen replaces it, so a device already watching something won't
    // have a second command silently swap it out mid-playback.
    usePolling(async () => {
        if (!token || activeVideo) return;
        const res = await apiFetch(SERVER_URL, '/api/remote/pending', token);
        if (!res.ok) throw new Error(`remote pending check failed: ${res.status}`);
        const data = await res.json();
        if (data.command) setActiveVideo({ path: data.command.path, progress: data.command.startTime || 0 });
    }, 5000, [token, activeVideo]);

    if (!token) return <LoginScreen onLogin={handleLogin} />;

    return (
        <div className="min-h-screen bg-bg text-text selection:bg-accent/30">
            {activeVideo && (
                <CustomVideoPlayer
                    item={activeVideo}
                    token={token}
                    onPlayNext={(nextItem) => setActiveVideo(nextItem)}
                    onClose={() => {
                        setActiveVideo(null);
                        fetchData(token); // Update progress bars without resetting scroll
                    }}
                    serverUrl={SERVER_URL}
                />
            )}
            <TopNav
                username={username}
                role={role}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                setSelectedSeries={setSelectedSeries}
                token={token}
                serverUrl={SERVER_URL}
                onUploadClick={() => setIsUploadModalOpen(true)}
                onLogout={handleLogout}
            />
            <UploadWizard isOpen={isUploadModalOpen} onClose={() => setIsUploadModalOpen(false)} onStartUpload={uploads.handleStartUpload} token={token} serverUrl={SERVER_URL} />
            <UploadQueue queue={uploads.uploads} onRemove={uploads.removeUpload} onRetry={uploads.retryUpload} onClearCompleted={uploads.clearCompletedUploads} />
            <ShareModal shareLink={shareLink} onClose={() => setShareLink(null)} />
            <CastModal item={castItem} onClose={() => setCastItem(null)} serverUrl={SERVER_URL} token={token} />

            <div className="pt-24 pb-12 px-6 md:px-12 space-y-10 max-w-[1600px] mx-auto">
            {/* A failed load used to be indistinguishable from a genuinely empty library — the
                UI just fell through to "No movies found. Upload one!" either way. This is only
                shown when the library ALSO looks empty, since if there's already cached data
                showing, that's friendlier than blocking the whole view over one failed refresh. */}
            {loadError && library.movies.length === 0 && library.series.length === 0 && (
                <div className="flex items-center gap-2 text-sm font-bold text-red-400 bg-red-900/20 border border-red-900/50 rounded-lg px-4 py-2.5">
                    <WifiOff className="w-4 h-4" /> Couldn't reach the server — this may just be an empty library, or the connection dropped.
                    <button onClick={() => fetchData(token)} className="ml-auto underline hover:text-red-300">Retry</button>
                </div>
            )}
            {/* Keyed by whatever's currently showing, so switching tabs/series mounts a fresh
                boundary instead of staying stuck on a previous crash — nav/upload/user menu
                above are outside this boundary and stay usable even if this section crashes. */}
            <ErrorBoundary key={selectedSeries ? `series-${selectedSeries.title}` : activeTab} label="This section">
                {selectedSeries ? (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <button onClick={() => setSelectedSeries(null)} className="mb-6 text-gray-400 hover:text-white flex items-center gap-2 font-medium transition-colors">&larr; Back to Browse</button>
                        <div className="flex items-baseline justify-between mb-8">
                            <div className="flex items-center gap-3">
                                <h2 className="text-4xl font-bold text-white">{selectedSeries.title}</h2>
                                <button onClick={() => handleRenameSeries(selectedSeries)} className="text-gray-500 hover:text-blue-400 p-1 rounded hover:bg-white/5 transition-colors" title="Rename Series" aria-label="Rename Series">
                                    <Pencil className="w-5 h-5" />
                                </button>
                            </div>
                            <span className="text-gray-500 font-medium">{selectedSeries.episodes.length} Episodes</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                            {selectedSeries.episodes.map(ep => (
                                <EpisodeCard
                                    key={ep.path}
                                    ep={ep}
                                    availableNodeIds={availableNodeIds}
                                    movePercent={moveStatus[ep.filename]}
                                    serverUrl={SERVER_URL}
                                    token={token}
                                    onPlay={setActiveVideo}
                                    onMove={handleMove}
                                    onTogglePrivacy={handleTogglePrivacy}
                                    onShare={handleShare}
                                    onCast={setCastItem}
                                    onDelete={handleDelete}
                                />
                            ))}
                        </div>
                    </div>
                ) : (
                    <>
                        {activeTab === 'home' && (
                            <>
                                {library.continueWatching.length > 0 && (
                                    <section>
                                        <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Clock className="w-5 h-5 text-red-600" /> Continue Watching</h3>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                            {library.continueWatching.map(item => (
                                                <Poster key={item.path} item={item} progress={(item.progress / item.duration) * 100} movePercent={moveStatus[item.filename]} onClick={setActiveVideo} serverUrl={SERVER_URL} token={token} onMove={handleMove} onShare={handleShare} onCast={setCastItem} availableNodeIds={availableNodeIds} />
                                            ))}
                                        </div>
                                    </section>
                                )}
                                <section>
                                    <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Film className="w-5 h-5 text-blue-500" /> Recent Movies</h3>
                                    {library.movies.length === 0 ? <div className="text-gray-500 italic text-sm">No movies found. Upload one!</div> :
                                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                            {library.movies.map(movie => <Poster key={movie.path} item={movie} progress={0} movePercent={moveStatus[movie.filename]} onClick={setActiveVideo} onDelete={handleDelete} onEdit={handleRenameMovie} onMove={handleMove} onShare={handleShare} onCast={setCastItem} onTogglePrivacy={handleTogglePrivacy} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                        </div>
                                    }
                                </section>
                                <section>
                                    <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Tv className="w-5 h-5 text-green-500" /> Recent Series</h3>
                                    {library.series.length === 0 ? <div className="text-gray-500 italic text-sm">No series found.</div> :
                                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                            {library.series.map(s => <Poster key={s.title} item={{ title: s.title, series_name: s.title, episodes: s.episodes, poster: s.episodes[0]?.poster }} progress={0} onClick={() => setSelectedSeries(s)} onDelete={handleDeleteSeries} onEdit={handleRenameSeries} onShare={handleShare} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                        </div>
                                    }
                                </section>
                            </>
                        )}
                        {activeTab === 'movies' && (
                            <section>
                                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Film className="w-5 h-5 text-blue-500" /> All Movies</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                    {library.movies.map(movie => <Poster key={movie.path} item={movie} progress={0} movePercent={moveStatus[movie.filename]} onClick={setActiveVideo} onDelete={handleDelete} onEdit={handleRenameMovie} onMove={handleMove} onShare={handleShare} onCast={setCastItem} onTogglePrivacy={handleTogglePrivacy} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                </div>
                            </section>
                        )}
                        {activeTab === 'series' && (
                            <section>
                                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Tv className="w-5 h-5 text-green-500" /> All Series</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                    {library.series.map(s => <Poster key={s.title} item={{ title: s.title, series_name: s.title, episodes: s.episodes, poster: s.episodes[0]?.poster }} progress={0} onClick={() => setSelectedSeries(s)} onDelete={handleDeleteSeries} onEdit={handleRenameSeries} onShare={handleShare} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                </div>
                            </section>
                        )}
                        {activeTab === 'discovery' && (
                            <Discovery token={token} serverUrl={SERVER_URL} library={library} />
                        )}
                        {activeTab === 'dashboard' && (
                            <DashboardTab token={token} serverUrl={SERVER_URL} role={role} onLogout={handleLogout} />
                        )}
                        {activeTab === 'settings' && (
                            <SettingsTab token={token} serverUrl={SERVER_URL} username={username} role={role} onLogout={handleLogout} />
                        )}
                    </>
                )}
            </ErrorBoundary>
            </div>
        </div>
    );
}

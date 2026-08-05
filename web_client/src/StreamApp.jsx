import React, { useState } from 'react';
import { Play, Unlock, Lock, Trash2, Film, Tv, Clock, Archive, RefreshCcw, Pencil, WifiOff, Loader2 } from 'lucide-react';
import { formatDuration } from './utils/format';
import { SERVER_URL, apiFetch } from './utils/api';
import { isNasOffline, nasOfflineMessage, useNasAvailability } from './utils/nas';
import { useLibraryActions } from './utils/useLibraryActions';
import { useUploads } from './utils/useUploads';
import LoginScreen from './components/LoginScreen';
import TopNav from './components/TopNav';
import Discovery from './components/Discovery';
import DashboardTab from './components/DashboardTab';
import SettingsTab from './components/SettingsTab';
import Poster from './components/Poster';
import UploadQueue from './components/UploadQueue';
import UploadWizard from './components/UploadWizard';
import CustomVideoPlayer from './components/CustomVideoPlayer';
import ErrorBoundary from './components/ErrorBoundary';

export default function StreamApp() {
    const [token, setToken] = useState(() => localStorage.getItem('auth_token'));
    const [username, setUsername] = useState(() => localStorage.getItem('auth_username') || 'Guest');
    const [role, setRole] = useState(() => localStorage.getItem('auth_role') || null);
    const [activeVideo, setActiveVideo] = useState(null);
    const [activeTab, setActiveTab] = useState('home');
    const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);

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

    const libraryActions = useLibraryActions(token, SERVER_URL, handleLogout);
    // Polled separately from the library: node reachability changes while the page is
    // open, and the library is fetched once per load.
    const availableNodeIds = useNasAvailability(SERVER_URL, token);
    const { library, loadError, selectedSeries, setSelectedSeries, fetchData, moveStatus, handleDelete, handleDeleteSeries, handleRenameMovie, handleRenameSeries, handleMove, handleTogglePrivacy } = libraryActions;

    const uploads = useUploads(token, SERVER_URL, fetchData);

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
                                <div key={ep.path} className="group relative bg-gray-900 rounded-xl overflow-hidden hover:bg-gray-800 transition-colors border border-gray-800/50 hover:border-gray-700">
                                    <div onClick={() => {
                                        // Restore reads from the same node a stream would, so
                                        // an offline node rules out both.
                                        if (isNasOffline(ep, availableNodeIds)) alert(nasOfflineMessage(ep));
                                        else if (ep.is_archived) handleMove(ep);
                                        else setActiveVideo(ep);
                                    }} className="aspect-video bg-gray-800 flex items-center justify-center cursor-pointer relative overflow-hidden">
                                        {ep.poster && <img src={`${SERVER_URL}/api/posters/${ep.poster}`} className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity" loading="lazy" />}
                                        <div className="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-colors" />
                                        <Play className="w-10 h-10 text-white opacity-70 group-hover:opacity-100 group-hover:scale-110 transition-all z-10" />
                                        {ep.progress > 0 && <div className="absolute bottom-0 left-0 h-1 bg-red-600 w-full" style={{ width: `${(ep.progress/ep.duration)*100}%` }} />}
                                        <span className="absolute bottom-2 right-2 text-xs bg-black/70 text-white px-1 rounded">{formatDuration(ep.duration)}</span>
                                        {/* Archived Badge for Episodes — amber + WifiOff once
                                            the node holding it is down, matching Poster.jsx */}
                                        {ep.is_archived === 1 && (
                                            isNasOffline(ep, availableNodeIds) ? (
                                                <span title="Unavailable — storage node offline" className="absolute top-2 left-2 bg-amber-600/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"><WifiOff className="w-3 h-3"/></span>
                                            ) : (
                                                <span className="absolute top-2 left-2 bg-blue-600/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"><Archive className="w-3 h-3"/></span>
                                            )
                                        )}
                                    </div>
                                    {/* Same move-in-progress overlay as Poster.jsx, covering the whole
                                        card (both the thumbnail and the action buttons below it) so a
                                        second click can't fire a concurrent nas-action for this episode. */}
                                    {moveStatus[ep.filename] !== undefined && (
                                        <div className="absolute inset-0 z-30 bg-black/75 flex flex-col items-center justify-center gap-2 text-white">
                                            <Loader2 className="w-6 h-6 animate-spin" />
                                            <span className="text-xs font-bold">
                                                {ep.is_archived ? 'Restoring' : 'Archiving'}… {moveStatus[ep.filename]}%
                                            </span>
                                            <div className="w-2/3 h-1.5 bg-white/20 rounded-full overflow-hidden">
                                                <div className="h-full bg-white transition-all duration-500" style={{ width: `${moveStatus[ep.filename]}%` }} />
                                            </div>
                                        </div>
                                    )}
                                    <div className="p-4 flex justify-between items-start">
                                        <div onClick={() => isNasOffline(ep, availableNodeIds) ? alert(nasOfflineMessage(ep)) : setActiveVideo(ep)} className="cursor-pointer">
                                            <h4 className="font-bold text-white mb-1">Episode {ep.episode}</h4>
                                            <p className="text-sm text-gray-400 font-mono">Season {ep.season}</p>
                                        </div>
                                        <div className="flex gap-2">
                                            {!ep.is_archived && (
                                                <button
                                                    onClick={() => handleTogglePrivacy(ep)}
                                                    className={`p-1 rounded hover:bg-white/10 transition-colors ${ep.is_private ? 'text-red-500 hover:text-red-400' : 'text-gray-500 hover:text-gray-300'}`}
                                                    title={ep.is_private ? "Unlock" : "Lock"}
                                                >
                                                    {ep.is_private ? <Unlock className="w-4 h-4"/> : <Lock className="w-4 h-4"/>}
                                                </button>
                                            )}
                                            <button onClick={() => handleMove(ep)} className={`p-1 rounded hover:bg-white/10 transition-colors ${ep.is_archived ? 'text-blue-400 hover:text-blue-300' : 'text-yellow-600 hover:text-yellow-500'}`} title={ep.is_archived ? "Restore" : "Archive"}>
                                                {ep.is_archived ? <RefreshCcw className="w-4 h-4"/> : <Archive className="w-4 h-4"/>}
                                            </button>
                                            <button onClick={() => handleDelete(ep)} className="text-gray-600 hover:text-red-500 p-1 rounded hover:bg-white/5 transition-colors"><Trash2 className="w-4 h-4" /></button>
                                        </div>
                                    </div>
                                </div>
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
                                                <Poster key={item.path} item={item} progress={(item.progress / item.duration) * 100} movePercent={moveStatus[item.filename]} onClick={setActiveVideo} serverUrl={SERVER_URL} token={token} onMove={handleMove} availableNodeIds={availableNodeIds} />
                                            ))}
                                        </div>
                                    </section>
                                )}
                                <section>
                                    <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Film className="w-5 h-5 text-blue-500" /> Recent Movies</h3>
                                    {library.movies.length === 0 ? <div className="text-gray-500 italic text-sm">No movies found. Upload one!</div> :
                                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                            {library.movies.map(movie => <Poster key={movie.path} item={movie} progress={0} movePercent={moveStatus[movie.filename]} onClick={setActiveVideo} onDelete={handleDelete} onEdit={handleRenameMovie} onMove={handleMove} onTogglePrivacy={handleTogglePrivacy} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                        </div>
                                    }
                                </section>
                                <section>
                                    <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Tv className="w-5 h-5 text-green-500" /> Recent Series</h3>
                                    {library.series.length === 0 ? <div className="text-gray-500 italic text-sm">No series found.</div> :
                                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                            {library.series.map(s => <Poster key={s.title} item={{ title: s.title, series_name: s.title, episodes: s.episodes, poster: s.episodes[0]?.poster }} progress={0} onClick={() => setSelectedSeries(s)} onDelete={handleDeleteSeries} onEdit={handleRenameSeries} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                        </div>
                                    }
                                </section>
                            </>
                        )}
                        {activeTab === 'movies' && (
                            <section>
                                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Film className="w-5 h-5 text-blue-500" /> All Movies</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                    {library.movies.map(movie => <Poster key={movie.path} item={movie} progress={0} movePercent={moveStatus[movie.filename]} onClick={setActiveVideo} onDelete={handleDelete} onEdit={handleRenameMovie} onMove={handleMove} onTogglePrivacy={handleTogglePrivacy} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                </div>
                            </section>
                        )}
                        {activeTab === 'series' && (
                            <section>
                                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Tv className="w-5 h-5 text-green-500" /> All Series</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                    {library.series.map(s => <Poster key={s.title} item={{ title: s.title, series_name: s.title, episodes: s.episodes, poster: s.episodes[0]?.poster }} progress={0} onClick={() => setSelectedSeries(s)} onDelete={handleDeleteSeries} onEdit={handleRenameSeries} serverUrl={SERVER_URL} token={token} availableNodeIds={availableNodeIds} />)}
                                </div>
                            </section>
                        )}
                        {activeTab === 'discovery' && (
                            <Discovery token={token} serverUrl={SERVER_URL} library={library} />
                        )}
                        {activeTab === 'dashboard' && (
                            <DashboardTab token={token} serverUrl={SERVER_URL} />
                        )}
                        {activeTab === 'settings' && (
                            <SettingsTab token={token} serverUrl={SERVER_URL} username={username} role={role} />
                        )}
                    </>
                )}
            </ErrorBoundary>
            </div>
        </div>
    );
}

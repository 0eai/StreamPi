import React, { useState, useRef } from 'react';
import { Play, Unlock, Lock, Trash2, Archive, RefreshCcw, Share2, WifiOff, Loader2, Info, Volume2, Subtitles, Database, Cast } from 'lucide-react';
import { formatDuration } from '../utils/format';
import { apiFetch } from '../utils/api';
import { isNasOffline, nasOfflineMessage } from '../utils/nas';
import MediaInfoModal from './MediaInfoModal';

const formatFileSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const getUniqueLanguages = (tracks) => {
    if (!tracks) return [];
    const langs = [...new Set(tracks.map(t => t.language || 'und'))];
    return langs.slice(0, 3).map(l => l.toUpperCase());
};

// Peeled out of StreamApp.jsx's series-detail view so each episode can hold its own metadata /
// info-modal state — the same reason Poster.jsx is its own component rather than inline JSX:
// hooks can't vary per-iteration of a .map() in the parent itself. Mirrors Poster.jsx's
// metadata-badge and Info-button behavior exactly; every other prop/click behavior below is
// unchanged from the inline markup this replaced.
const EpisodeCard = ({ ep, availableNodeIds, movePercent, serverUrl, token, onPlay, onMove, onTogglePrivacy, onShare, onCast, onDelete }) => {
    const nasOffline = isNasOffline(ep, availableNodeIds);

    const [metadata, setMetadata] = useState(null);
    const [isLoadingMeta, setIsLoadingMeta] = useState(false);
    const [showInfoModal, setShowInfoModal] = useState(false);
    const fetchAttempted = useRef(false);

    const handleMouseEnter = async () => {
        if (metadata || fetchAttempted.current) return;
        fetchAttempted.current = true;
        setIsLoadingMeta(true);
        try {
            const res = await apiFetch(serverUrl, `/api/media/info?path=${encodeURIComponent(ep.path)}`, token);
            if (res.ok) setMetadata(await res.json());
        } catch (e) {
            console.error("Meta fetch failed", e);
        }
        setIsLoadingMeta(false);
    };

    const handleShowInfo = (e) => {
        e.stopPropagation();
        handleMouseEnter();
        setShowInfoModal(true);
    };

    const handlePlayClick = () => {
        // Restore reads from the same node a stream would, so an offline node rules out both.
        if (nasOffline) alert(nasOfflineMessage(ep));
        else if (ep.is_archived) onMove(ep);
        else onPlay(ep);
    };

    return (
        <div onMouseEnter={handleMouseEnter} className="group relative bg-gray-900 rounded-xl overflow-hidden hover:bg-gray-800 transition-colors border border-gray-800/50 hover:border-gray-700">
            <div onClick={handlePlayClick} className="aspect-video bg-gray-800 flex items-center justify-center cursor-pointer relative overflow-hidden">
                {ep.poster && <img src={`${serverUrl}/api/posters/${ep.poster}`} className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity" loading="lazy" />}
                <div className="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-colors" />
                <Play className="w-10 h-10 text-white opacity-70 group-hover:opacity-100 group-hover:scale-110 transition-all z-10" />
                {ep.progress > 0 && <div className="absolute bottom-0 left-0 h-1 bg-red-600 w-full" style={{ width: `${(ep.progress/ep.duration)*100}%` }} />}
                <span className="absolute bottom-2 right-2 text-xs bg-black/70 text-white px-1 rounded">{formatDuration(ep.duration)}</span>
                {/* Archived Badge for Episodes — amber + WifiOff once the node holding it is
                    down, matching Poster.jsx */}
                {ep.is_archived === 1 && (
                    nasOffline ? (
                        <span title="Unavailable — storage node offline" className="absolute top-2 left-2 bg-amber-600/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"><WifiOff className="w-3 h-3"/></span>
                    ) : (
                        <span className="absolute top-2 left-2 bg-blue-600/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"><Archive className="w-3 h-3"/></span>
                    )
                )}

                {/* Metadata Badges (only visible on hover), same shape as Poster.jsx */}
                <div className="absolute bottom-0 left-0 w-full p-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity translate-y-full group-hover:translate-y-0 duration-300">
                    {isLoadingMeta ? (
                        <div className="flex gap-2">
                            <div className="h-4 w-12 bg-gray-700 animate-pulse rounded"></div>
                            <div className="h-4 w-12 bg-gray-700 animate-pulse rounded"></div>
                        </div>
                    ) : metadata ? (
                        <div className="flex flex-wrap gap-1.5">
                            {metadata.fileSize > 0 && (
                                <div className="flex items-center gap-1 bg-gray-700/80 border border-gray-500/30 px-1.5 py-0.5 rounded text-[9px] text-gray-200 font-bold backdrop-blur-sm">
                                    <Database className="w-2.5 h-2.5" /> {formatFileSize(metadata.fileSize)}
                                </div>
                            )}
                            {getUniqueLanguages(metadata.audioTracks).map((lang, i) => (
                                <div key={`aud-${i}`} className="flex items-center gap-1 bg-blue-900/80 border border-blue-500/30 px-1.5 py-0.5 rounded text-[9px] text-blue-200 font-bold backdrop-blur-sm">
                                    <Volume2 className="w-2.5 h-2.5" /> {lang}
                                </div>
                            ))}
                            {getUniqueLanguages(metadata.subtitleTracks).map((lang, i) => (
                                <div key={`sub-${i}`} className="flex items-center gap-1 bg-yellow-900/80 border border-yellow-500/30 px-1.5 py-0.5 rounded text-[9px] text-yellow-200 font-bold backdrop-blur-sm">
                                    <Subtitles className="w-2.5 h-2.5" /> {lang}
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            </div>

            {/* Same move-in-progress overlay as Poster.jsx, covering the whole card (both the
                thumbnail and the action buttons below it) so a second click can't fire a
                concurrent nas-action for this episode. */}
            {movePercent !== undefined && (
                <div className="absolute inset-0 z-30 bg-black/75 flex flex-col items-center justify-center gap-2 text-white">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <span className="text-xs font-bold">
                        {ep.is_archived ? 'Restoring' : 'Archiving'}… {movePercent}%
                    </span>
                    <div className="w-2/3 h-1.5 bg-white/20 rounded-full overflow-hidden">
                        <div className="h-full bg-white transition-all duration-500" style={{ width: `${movePercent}%` }} />
                    </div>
                </div>
            )}

            <div className="p-4 flex justify-between items-start">
                <div onClick={() => nasOffline ? alert(nasOfflineMessage(ep)) : onPlay(ep)} className="cursor-pointer">
                    <h4 className="font-bold text-white mb-1">Episode {ep.episode}</h4>
                    <p className="text-sm text-gray-400 font-mono">Season {ep.season}</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={handleShowInfo} className="p-1 rounded hover:bg-white/10 transition-colors text-gray-500 hover:text-blue-400" title="Media Info">
                        <Info className="w-4 h-4"/>
                    </button>
                    {!ep.is_archived && (
                        <button
                            onClick={() => onTogglePrivacy(ep)}
                            className={`p-1 rounded hover:bg-white/10 transition-colors ${ep.is_private ? 'text-red-500 hover:text-red-400' : 'text-gray-500 hover:text-gray-300'}`}
                            title={ep.is_private ? "Unlock" : "Lock"}
                        >
                            {ep.is_private ? <Unlock className="w-4 h-4"/> : <Lock className="w-4 h-4"/>}
                        </button>
                    )}
                    <button onClick={() => onMove(ep)} className={`p-1 rounded hover:bg-white/10 transition-colors ${ep.is_archived ? 'text-blue-400 hover:text-blue-300' : 'text-yellow-600 hover:text-yellow-500'}`} title={ep.is_archived ? "Restore" : "Archive"}>
                        {ep.is_archived ? <RefreshCcw className="w-4 h-4"/> : <Archive className="w-4 h-4"/>}
                    </button>
                    {!ep.is_private && (
                        <button onClick={() => onShare(ep)} className="p-1 rounded hover:bg-white/10 transition-colors text-gray-500 hover:text-purple-400" title="Share">
                            <Share2 className="w-4 h-4"/>
                        </button>
                    )}
                    <button onClick={() => onCast(ep)} className="p-1 rounded hover:bg-white/10 transition-colors text-gray-500 hover:text-blue-400" title="Play on another device">
                        <Cast className="w-4 h-4"/>
                    </button>
                    <button onClick={() => onDelete(ep)} className="text-gray-600 hover:text-red-500 p-1 rounded hover:bg-white/5 transition-colors"><Trash2 className="w-4 h-4" /></button>
                </div>
            </div>

            <MediaInfoModal isOpen={showInfoModal} onClose={() => setShowInfoModal(false)} item={ep} metadata={metadata} loading={isLoadingMeta} />
        </div>
    );
};

export default EpisodeCard;

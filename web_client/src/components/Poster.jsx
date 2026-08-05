import React, { useState, useRef } from 'react';
import { Download, Play, Database, Lock, Unlock, X, Trash2, Loader2, Volume2, Clock3, CheckCircle2, HardDrive, Archive, RefreshCcw, Server, Subtitles, Pencil, WifiOff } from 'lucide-react';
import { formatDuration } from '../utils/format';
import { apiFetch } from '../utils/api';
import { isNasOffline, nasOfflineMessage } from '../utils/nas';

const Poster = ({ item, onClick, onDelete, onEdit, onMove, onTogglePrivacy, progress, serverUrl, token, availableNodeIds }) => {

    const nasOffline = isNasOffline(item, availableNodeIds);
    
    const [metadata, setMetadata] = useState(null);
    const [isLoadingMeta, setIsLoadingMeta] = useState(false);
    const fetchAttempted = useRef(false); // Prevent double firing

    const formatFileSize = (bytes) => {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const handleMouseEnter = async () => {
        if (metadata || fetchAttempted.current) return; // Don't fetch if we have data or already tried
        
        fetchAttempted.current = true;
        setIsLoadingMeta(true);

        try {
            const res = await apiFetch(serverUrl, `/api/media/info?path=${encodeURIComponent(item.path)}`, token);
            if (res.ok) {
                const data = await res.json();
                setMetadata(data);
            }
        } catch (e) {
            console.error("Meta fetch failed", e);
        }
        setIsLoadingMeta(false);
    };

    const handleDownload = async (e) => {
        e.stopPropagation(); 
        if (!confirm(`Download "${item.title || item.filename}"?`)) return;
        try {
            const link = document.createElement("a");
            link.href = `${serverUrl}/api/download?path=${encodeURIComponent(item.path)}&token=${token}`;
            link.setAttribute("download", item.filename);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) { alert("Download failed"); }
    };

    const handleClick = (e) => {
        // Refused here rather than in the player: /api/stream now answers 503 for an archived
        // file whose node is down, and opening the player only to fail on its first range
        // request is a worse way to learn that. Restore is no help either — it reads from the
        // same node — so there is nothing to offer but the explanation.
        if (nasOffline) {
            alert(nasOfflineMessage(item));
            return;
        }
        onClick(item);
    };

    const getUniqueLanguages = (tracks) => {
        if (!tracks) return [];
        // Map to language codes, filter undefined, deduplicate
        const langs = [...new Set(tracks.map(t => t.language || 'und'))];
        // Limit to 3 to prevent overflow
        return langs.slice(0, 3).map(l => l.toUpperCase());
    };

    // Status Badge Logic
    const getStatusBadge = () => {
        if (item.is_private) {
             return (
                <div className="absolute top-2 left-2 bg-red-600/90 text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20 border border-red-500/50">
                    <Lock className="w-3 h-3" /> Vault
                </div>
            );
        }

        // Archived Badge — amber when the node holding it is down, since the item is visible
        // but unplayable, which the plain blue "NAS" badge gave no hint of.
        if (item.is_archived) {
            return nasOffline ? (
                <div className="absolute top-2 left-2 bg-amber-600/90 text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20 border border-amber-500/50">
                    <WifiOff className="w-3 h-3" /> NAS Offline
                </div>
            ) : (
                <div className="absolute top-2 left-2 bg-blue-600/90 text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20">
                    <Archive className="w-3 h-3" /> NAS
                </div>
            );
        }

        if (item.transcode_status === 'completed' || (!item.transcode_status && item.path?.endsWith('.mp4'))) {
             return (
                <div className="absolute top-2 left-2 bg-green-600/90 text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20">
                    <CheckCircle2 className="w-3 h-3" /> Ready
                </div>
            );
        }
        if (item.transcode_status === 'remote_processing') {
            return (
                <div className="absolute top-2 left-2 bg-purple-600/90 text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20 animate-pulse">
                    <Server className="w-3 h-3" /> Worker
                </div>
            );
        }
        if (item.transcode_status === 'processing') {
            return (
                <div className="absolute top-2 left-2 bg-yellow-600/90 text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20">
                    <Loader2 className="w-3 h-3 animate-spin" /> Transcoding
                </div>
            );
        }
        if (item.transcode_status === 'pending') {
            return (
                <div className="absolute top-2 left-2 bg-gray-600/90 text-gray-200 text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20">
                    <Clock3 className="w-3 h-3" /> Scheduled
                </div>
            );
        }
        if (item.transcode_status === 'failed') {
             return (
                <div className="absolute top-2 left-2 bg-red-600/90 text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-sm backdrop-blur-sm z-20">
                    <X className="w-3 h-3" /> Failed
                </div>
            );
        }
        return null;
    };

    return (
        <div
            className={`relative w-full aspect-video bg-gray-800 rounded-lg overflow-hidden hover:scale-105 transition-transform group shadow-lg border border-gray-700/30 ${nasOffline ? 'cursor-not-allowed saturate-50' : 'cursor-pointer'}`}
            onMouseEnter={handleMouseEnter} // 👈 Trigger fetch here
            title={nasOffline ? 'Unavailable — storage node offline' : undefined}
        >
            {getStatusBadge()}
            
            <div onClick={handleClick} className="absolute inset-0 z-0 bg-gray-900">
                {item.poster ? (
                    <img 
                        src={`${serverUrl}/api/posters/${item.poster}`} 
                        alt={item.title} 
                        className="w-full h-full object-cover opacity-80 group-hover:opacity-40 transition-opacity"
                        loading="lazy"
                    />
                ) : (
                    <div className="w-full h-full bg-gradient-to-t from-gray-900 to-gray-700 opacity-50" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-90" />
                
                {/* Bottom Info Bar */}
                <div className="absolute bottom-0 p-3 w-full transition-transform duration-300 group-hover:-translate-y-8">
                    <h3 className="text-white text-sm font-bold truncate leading-tight">{item.title || item.series_name}</h3>
                    <div className="flex justify-between items-end mt-1">
                        {item.season ? (
                            <p className="text-gray-300 text-xs">S{item.season} E{item.episode}</p>
                        ) : (
                            <p className="text-gray-400 text-[10px] uppercase">Movie</p>
                        )}
                        {item.duration > 0 && (
                            <span className="text-[10px] text-gray-300 bg-black/50 px-1.5 py-0.5 rounded">{formatDuration(item.duration)}</span>
                        )}
                    </div>
                </div>
                
                {/* 🆕 Metadata Badges (Only visible on hover) */}
                <div className="absolute bottom-0 left-0 w-full p-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity translate-y-full group-hover:translate-y-0 duration-300">
                    {isLoadingMeta ? (
                        <div className="flex gap-2">
                            <div className="h-4 w-12 bg-gray-700 animate-pulse rounded"></div>
                            <div className="h-4 w-12 bg-gray-700 animate-pulse rounded"></div>
                        </div>
                    ) : metadata ? (
                        <div className="flex flex-wrap gap-1.5">
                            {/* 1. FILE SIZE BADGE (Gray) */}
                            {metadata.fileSize > 0 && (
                                <div className="flex items-center gap-1 bg-gray-700/80 border border-gray-500/30 px-1.5 py-0.5 rounded text-[9px] text-gray-200 font-bold backdrop-blur-sm">
                                    <Database className="w-2.5 h-2.5" /> {formatFileSize(metadata.fileSize)}
                                </div>
                            )}
                            {/* Audio Badges */}
                            {getUniqueLanguages(metadata.audioTracks).map((lang, i) => (
                                <div key={`aud-${i}`} className="flex items-center gap-1 bg-blue-900/80 border border-blue-500/30 px-1.5 py-0.5 rounded text-[9px] text-blue-200 font-bold backdrop-blur-sm">
                                    <Volume2 className="w-2.5 h-2.5" /> {lang}
                                </div>
                            ))}
                            {/* Subtitle Badges */}
                            {getUniqueLanguages(metadata.subtitleTracks).map((lang, i) => (
                                <div key={`sub-${i}`} className="flex items-center gap-1 bg-yellow-900/80 border border-yellow-500/30 px-1.5 py-0.5 rounded text-[9px] text-yellow-200 font-bold backdrop-blur-sm">
                                    <Subtitles className="w-2.5 h-2.5" /> {lang}
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>

                {progress > 0 && (
                    <div className="absolute bottom-0 left-0 h-1 bg-red-600 z-10 transition-all duration-500" style={{ width: `${progress}%` }} />
                )}
            </div>

            {/* Centered Play Button Overlay */}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/10 pointer-events-none z-10">
                <Play className="w-10 h-10 text-white fill-white drop-shadow-xl opacity-80" />
            </div>

            {/* Top Right Action Buttons */}
            <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                {onTogglePrivacy && !item.is_archived && (
                    <button 
                        onClick={(e) => { e.stopPropagation(); onTogglePrivacy(item); }}
                        className={`p-1.5 rounded-full transition-all ${
                            item.is_private 
                            ? 'bg-red-600/80 text-white hover:bg-red-500' 
                            : 'bg-black/60 text-gray-400 hover:bg-white hover:text-black'
                        }`}
                        title={item.is_private ? "Unlock (Make Public)" : "Lock (Move to Private Vault)"}
                        aria-label={item.is_private ? "Unlock (Make Public)" : "Lock (Move to Private Vault)"}
                    >
                        {item.is_private ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                    </button>
                )}
                <button 
                    onClick={handleDownload}
                    className="p-1.5 bg-black/60 rounded-full text-gray-400 hover:text-green-500 hover:bg-white transition-all"
                    title="Download"
                    aria-label="Download"
                >
                    <Download className="w-4 h-4" />
                </button>

                {onMove && (
                    <button 
                        onClick={(e) => { e.stopPropagation(); onMove(item); }}
                        className={`p-1.5 bg-black/60 rounded-full text-gray-400 hover:bg-white transition-all ${item.is_archived ? 'hover:text-blue-500' : 'hover:text-orange-500'}`}
                        title={item.is_archived ? "Restore from NAS" : "Move to NAS Storage"}
                        aria-label={item.is_archived ? "Restore from NAS" : "Move to NAS Storage"}
                    >
                        {item.is_archived ? <RefreshCcw className="w-4 h-4" /> : <HardDrive className="w-4 h-4" />}
                    </button>
                )}

                {onEdit && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onEdit(item); }}
                        className="p-1.5 bg-black/60 rounded-full text-gray-400 hover:text-blue-400 hover:bg-white transition-all"
                        title="Rename"
                        aria-label="Rename"
                    >
                        <Pencil className="w-4 h-4" />
                    </button>
                )}

                {onDelete && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(item); }}
                        className="p-1.5 bg-black/60 rounded-full text-gray-400 hover:text-red-500 hover:bg-white transition-all"
                        title="Delete from Disk"
                        aria-label="Delete from Disk"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    );
};

export default Poster;

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, SkipBack, SkipForward, ArrowLeft, Subtitles } from 'lucide-react';
import { formatDuration } from '../utils/format';
import { getBrowserCodecs } from '../utils/device';
import { apiFetch } from '../utils/api';

const CustomVideoPlayer = ({ item, token, onClose, serverUrl, onPlayNext }) => {
    const videoRef = useRef(null);
    const containerRef = useRef(null);
    const [playing, setPlaying] = useState(false); // Default to false, let useEffect set true
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [audioTrack, setAudioTrack] = useState(0);
    const [availableAudio, setAvailableAudio] = useState([]); 
    
    const [subtitleTrack, setSubtitleTrack] = useState(-1); // -1 = Off
    const [availableSubs, setAvailableSubs] = useState([]);

    const [showControls, setShowControls] = useState(true);
    const controlsTimeoutRef = useRef(null);

    const totalDuration = duration || item.duration || 0;

    // The <video>/<track> elements below can't send an Authorization header, so their src
    // URLs need a token in the query string — this fetches a short-lived one instead of
    // reusing the caller's real, non-expiring session token (which used to end up sitting in
    // browser history/access logs for as long as the account exists).
    const [streamToken, setStreamToken] = useState(null);
    useEffect(() => {
        setStreamToken(null);
        apiFetch(serverUrl, '/api/auth/stream-token', token, { method: 'POST' })
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(data => setStreamToken(data.token))
            .catch(() => console.error("Failed to obtain a streaming token"));
    }, [token, serverUrl]);

    useEffect(() => {
        // onPlayNext auto-advances to the next episode by re-rendering this same component
        // with a new item prop rather than unmounting it — audioTrack/subtitleTrack used to
        // carry over unchanged, so picking track 2 on episode 1 meant episode 2 auto-played
        // still requesting a track index that might not exist on that file.
        setAudioTrack(0);
        setSubtitleTrack(-1);

        const fetchMetadata = async () => {
            try {
                const res = await apiFetch(serverUrl, `/api/media/info?path=${encodeURIComponent(item.path)}`, token);
                if (res.ok) {
                    const data = await res.json();
                    const audioTracks = data.audioTracks || [];
                    setAvailableAudio(audioTracks);
                    setAvailableSubs(data.subtitleTracks || []);

                    // Default to whichever track is actually AAC — some sources ship a
                    // legacy AC3/DTS track first with a perfectly good AAC track right
                    // behind it, which used to force a full transcode on every play for
                    // no reason (track 0 was always trusted as "the" track).
                    if (audioTracks.length && audioTracks[0]?.codec !== 'aac') {
                        const aacTrack = audioTracks.find(t => t.codec === 'aac');
                        if (aacTrack) setAudioTrack(aacTrack.index);
                    }
                }
            } catch (e) {
                console.error("Failed to fetch audio tracks", e);
            }
        };
        fetchMetadata();
    }, [item, serverUrl, token]);

    const isDirectPlay = (item.path?.endsWith('.mp4') || item.is_private === 1) && audioTrack === 0;

    const streamUrl = useMemo(() => {
        if (!streamToken) return null;
        const supportedCodecs = getBrowserCodecs();
        let url = `${serverUrl}/api/stream?path=${encodeURIComponent(item.path)}&token=${streamToken}&track=${audioTrack}&codecs=${supportedCodecs}`;
        if (!isDirectPlay && item.progress > 5) {
            url += `&startTime=${item.progress}`;
        }
        return url;
    }, [item.path, streamToken, audioTrack, isDirectPlay, item.progress, serverUrl]);

    // --- FIX: Safe Playback Starter ---
    useEffect(() => {
        const startPlayback = async () => {
            if (videoRef.current) {
                try {
                    await videoRef.current.play();
                    setPlaying(true);
                } catch (e) {
                    // Ignore AbortError (happens if user closes video quickly)
                    if (e.name !== 'AbortError') console.error("Playback failed:", e);
                }
            }
        };
        startPlayback();
    }, [streamUrl]); // Re-run if stream URL changes (e.g. audio track switch)

    const changeAudioTrack = () => {
        if (availableAudio.length <= 1) return;
        const currentIdx = availableAudio.findIndex(t => t.index === audioTrack);
        const nextIdx = (currentIdx + 1) % availableAudio.length;
        setAudioTrack(availableAudio[nextIdx].index);
    };

    useEffect(() => {
        const interval = setInterval(() => {
            if (videoRef.current && !videoRef.current.paused) {
                let reportTime = videoRef.current.currentTime;
                if (!isDirectPlay && item.progress > 5) {
                    reportTime += item.progress;
                }
                apiFetch(serverUrl, '/api/progress', token, { method: 'POST', json: { path: item.path, timestamp: reportTime, duration: videoRef.current.duration } });
            }
        }, 5000);
        return () => clearInterval(interval);
    }, [item, token, serverUrl, isDirectPlay]);

    const handleMouseMove = () => {
        setShowControls(true);
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
    };

    // Was only cleared on the *next* mouse move — closing the player while one was still
    // pending left it firing 3s later against an unmounted instance.
    useEffect(() => {
        return () => { if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current); };
    }, []);

    // Closing the player previously just unmounted this component and let the browser GC the
    // <video> element — which usually aborts its in-flight request, but isn't synchronous or
    // guaranteed the same way an explicit abort is. If the browser had already finished
    // delivering the current range chunk (common — video elements buffer ahead), there was
    // nothing left to abort at all, so the server's corresponding ACTIVE_STREAMS entry could
    // sit around long after the viewer actually left. Explicitly pausing and clearing src
    // forces an immediate abort of whatever request is still in flight the moment this
    // instance goes away, regardless of which of the several call sites triggered onClose.
    useEffect(() => {
        const videoEl = videoRef.current;
        return () => {
            if (videoEl) {
                videoEl.pause();
                videoEl.removeAttribute('src');
                videoEl.load();
            }
        };
    }, []);

    // --- FIX: Safe Toggle Play ---
    const togglePlay = async () => {
        if (!videoRef.current) return;

        if (videoRef.current.paused) {
            try {
                await videoRef.current.play();
                setPlaying(true);
            } catch (e) {
                if (e.name !== 'AbortError') console.error(e);
            }
        } else {
            videoRef.current.pause();
            setPlaying(false);
        }
    };

    // Populated below, after toggleFullScreen exists — see the effect for why this indirection.
    const latestRef = useRef({});

    const cycleSubtitle = () => {
        if (availableSubs.length === 0) return;
        // Cycle: -1 (Off) -> 0 -> 1 -> ... -> -1
        const nextIndex = subtitleTrack + 1;
        setSubtitleTrack(nextIndex >= availableSubs.length ? -1 : nextIndex);
    };

    const getSubtitleLabel = () => {
        if (subtitleTrack === -1) return "Off";
        const sub = availableSubs.find(s => s.index === subtitleTrack);
        return sub ? (sub.language || `Track ${sub.index}`) : "Unknown";
    };

    const toggleFullScreen = () => {
        if (!document.fullscreenElement) containerRef.current.requestFullscreen();
        else document.exitFullscreen();
    };

    // The listener below is only registered once (empty deps) rather than re-registered on
    // every volume change, so it reads the latest togglePlay/toggleFullScreen/onClose/volume
    // through this ref instead of closing over whichever versions existed when it was last
    // (re-)attached — otherwise replacing onClose or item (e.g. if the player is ever reused
    // for a different item without unmounting) would silently keep calling a stale callback.
    latestRef.current = { togglePlay, toggleFullScreen, onClose, volume };

    useEffect(() => {
        const handleKey = (e) => {
            if (!videoRef.current) return;
            const { togglePlay, toggleFullScreen, onClose, volume } = latestRef.current;
            switch(e.key) {
                case ' ': case 'k': e.preventDefault(); togglePlay(); break;
                case 'ArrowRight': videoRef.current.currentTime += 5; break;
                case 'ArrowLeft': videoRef.current.currentTime -= 5; break;
                case 'ArrowUp': setVolume(Math.min(1, volume + 0.1)); break;
                case 'ArrowDown': setVolume(Math.max(0, volume - 0.1)); break;
                case 'f': toggleFullScreen(); break;
                case 'Escape': onClose(); break;
            }
            handleMouseMove();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, []);

    const handleSeek = (e) => {
        const time = parseFloat(e.target.value);
        videoRef.current.currentTime = time;
        setCurrentTime(time);
    };

    const updateTime = () => {
        let displayTime = videoRef.current.currentTime;
        if (!isDirectPlay && item.progress > 5) {
             displayTime += item.progress;
        }
        setCurrentTime(displayTime);
        setDuration(videoRef.current.duration);
    };

    const getCurrentTrackLabel = () => {
        if (availableAudio.length === 0) return "Default Audio";
        const track = availableAudio.find(t => t.index === audioTrack);
        return track ? track.label : `Audio ${audioTrack + 1}`;
    };

    const playNextEpisode = async () => {
        try {
            const res = await apiFetch(serverUrl, `/api/media/next?path=${encodeURIComponent(item.path)}`, token);
            const data = await res.json();
            
            if (data.next) {
                // Determine if we need to switch (pass 'item' setter from parent if possible, 
                // OR simpler: just update the current 'item' prop via a callback)
                if (onPlayNext) {
                    onPlayNext(data.next); // We need to add this prop
                }
            } else {
                onClose(); // No next episode, close player
            }
        } catch (e) {
            console.error("Auto-play error:", e);
            onClose();
        }
    };

    return (
        <div 
            ref={containerRef}
            className="fixed inset-0 bg-black z-[100] flex items-center justify-center group overflow-hidden"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setShowControls(false)}
        >
            <video 
                ref={videoRef}
                src={streamUrl}
                className="w-full h-full object-contain"
                crossOrigin="anonymous" // Required for VTT
                onTimeUpdate={updateTime}
                onEnded={playNextEpisode}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={togglePlay}
                onLoadedMetadata={(e) => {
                    if (isDirectPlay && item.progress > 0) {
                         e.target.currentTime = item.progress; 
                    }
                }}
            >
                {/* 👇 INSERT THIS BLOCK: Render Subtitle Tracks */}
                {availableSubs.map((sub) => (
                    <track
                        key={sub.index}
                        kind="subtitles"
                        label={sub.label || sub.language}
                        srcLang={sub.language || 'en'}
                        // URL must match your backend route
                        src={streamToken ? `${serverUrl}/api/subtitle?path=${encodeURIComponent(item.path)}&index=${sub.index}&token=${streamToken}` : undefined}
                        default={sub.index === subtitleTrack}
                    />
                ))}
                {/* 👆 END INSERT */}
            </video>
            <div className={`absolute top-0 left-0 w-full p-6 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
                <button onClick={onClose} className="text-white/80 hover:text-white flex items-center gap-2 font-medium bg-black/40 px-4 py-2 rounded-full backdrop-blur-sm hover:bg-black/60 transition-colors"><ArrowLeft className="w-5 h-5" /> Back</button>
            </div>
            <div className={`absolute bottom-0 left-0 w-full px-6 pb-6 pt-20 bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
                <div className="flex items-center gap-4 mb-4 group/timeline">
                    <span className="text-xs text-gray-300 font-mono w-12 text-right">{formatDuration(currentTime)}</span>
                    <input type="range" min="0" max={item.duration || duration || 0} value={currentTime} onChange={handleSeek} className="flex-1 h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-red-600 hover:h-2 transition-all" />
                    <span className="text-xs text-gray-300 font-mono w-12">
                        {formatDuration(item.duration || totalDuration)}
                    </span>
                    
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-6">
                        <button onClick={togglePlay} className="text-white hover:text-red-500 transition-colors">{playing ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current" />}</button>
                        <button 
                            onClick={playNextEpisode} 
                            className="text-gray-300 hover:text-white flex items-center gap-2"
                            title="Next Episode"
                            aria-label="Next Episode"
                        >
                            <SkipForward className="w-8 h-8" />
                        </button>

                        {availableAudio.length > 0 && (
                            <button 
                                onClick={changeAudioTrack}
                                className="text-gray-300 hover:text-white flex items-center gap-2 text-xs font-bold border border-gray-600 hover:border-white rounded px-3 py-1.5 transition-all"
                                title="Switch Audio Track (Video will reload)"
                                aria-label={`Switch Audio Track, currently ${getCurrentTrackLabel()}`}
                            >
                                <Volume2 className="w-4 h-4" />
                                <span className="uppercase">{getCurrentTrackLabel()}</span>
                            </button>
                        )}

                        {availableSubs.length > 0 && (
                            <button 
                                onClick={cycleSubtitle} 
                                className={`text-gray-300 hover:text-white flex items-center gap-2 text-xs font-bold border border-gray-600 hover:border-white rounded px-3 py-1.5 transition-all ${subtitleTrack !== -1 ? 'bg-white/20 text-white border-white' : ''}`}
                                title="Toggle Subtitles"
                                aria-label={`Toggle Subtitles, currently ${getSubtitleLabel()}`}
                            >
                                <Subtitles className="w-4 h-4" />
                                <span className="uppercase">{getSubtitleLabel()}</span>
                            </button>
                        )}

                        <div className="flex items-center gap-4">
                            <button onClick={() => { videoRef.current.currentTime -= 10; }} className="text-gray-300 hover:text-white"><SkipBack className="w-6 h-6" /></button>
                            <button onClick={() => { videoRef.current.currentTime += 10; }} className="text-gray-300 hover:text-white"><SkipForward className="w-6 h-6" /></button>
                        </div>
                        <div className="flex items-center gap-2 group/vol">
                            <button onClick={() => { const v = volume > 0 ? 0 : 1; setVolume(v); videoRef.current.volume = v; }} className="text-gray-300 hover:text-white">{volume === 0 ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}</button>
                            <div className="w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300 ease-out"><input type="range" min="0" max="1" step="0.1" value={volume} onChange={(e) => { const v = parseFloat(e.target.value); setVolume(v); videoRef.current.volume = v; }} className="w-20 h-1 bg-gray-600 rounded-lg appearance-none accent-white cursor-pointer ml-2" /></div>
                        </div>
                    </div>
                    <div>
                        <h4 className="text-sm font-medium text-white/90 mb-0.5 max-w-[300px] truncate text-right hidden md:block">{item.title || item.filename}</h4>
                        {item.series_name && <p className="text-xs text-gray-400 text-right hidden md:block">{item.series_name} - S{item.season} E{item.episode}</p>}
                    </div>
                    <button onClick={toggleFullScreen} className="text-gray-300 hover:text-white ml-6"><Maximize className="w-6 h-6" /></button>
                </div>
            </div>
        </div>
    );
};

export default CustomVideoPlayer;

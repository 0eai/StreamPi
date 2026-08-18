import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, SkipBack, SkipForward, ArrowLeft, Subtitles, Airplay } from 'lucide-react';
import { formatDuration } from '../utils/format';
import { getBrowserCodecs } from '../utils/device';
import { apiFetch } from '../utils/api';
import { randomId } from '../utils/randomId';

const CustomVideoPlayer = ({ item, token, onClose, serverUrl, onPlayNext, isPublic = false, shareToken = null }) => {
    const videoRef = useRef(null);
    const containerRef = useRef(null);
    // One id for this whole player-open (survives an autoplay-next item swap, since that
    // reuses this same mounted instance) — tags every range request server-side so
    // /api/stream/end can find and kill all of them explicitly on unmount. Needed because the
    // server's own close/error/finish listeners depend entirely on the client's TCP connection
    // actually tearing down, which iOS Safari doesn't reliably do the moment a custom player
    // closes — without this, a stream could sit "active" for hours after the viewer left.
    // randomId(), not crypto.randomUUID(), which is secure-context-only and threw here over plain
    // http://<lan-ip>. Assigned lazily rather than as useRef's argument, which would mint and
    // discard an id on every render — and this component re-renders several times a second while
    // playing, off timeupdate.
    const sessionIdRef = useRef(null);
    if (!sessionIdRef.current) sessionIdRef.current = randomId();
    const [playing, setPlaying] = useState(false); // Default to false, let useEffect set true
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    // Separate from volume: browsers block autoplay-with-sound with no user gesture (exactly
    // the case for a remote-cast open, triggered by a background poll rather than a tap) but
    // universally allow *muted* autoplay — this is Safari's own documented policy too, and the
    // check specifically inspects the muted IDL property, not volume=0. Tracked apart from
    // volume so the fallback in startPlayback below doesn't fight whatever the user had their
    // volume slider set to.
    const [muted, setMuted] = useState(false);
    // A brief, self-dismissing explanation for *why* there's no sound — without it, the muted
    // fallback above is silent about itself; nothing on screen says a tap is needed.
    const [showMutedHint, setShowMutedHint] = useState(false);
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
    // browser history/access logs for as long as the account exists). Skipped entirely for a
    // public share viewer: shareToken is already a scoped, per-item credential — everything
    // this minting step exists to add on top of a whole-account session token, a share token
    // already has, so re-minting from it would just be a redundant extra round trip.
    const [streamToken, setStreamToken] = useState(null);
    useEffect(() => {
        if (isPublic) return;
        setStreamToken(null);
        apiFetch(serverUrl, '/api/auth/stream-token', token, { method: 'POST' })
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(data => setStreamToken(data.token))
            .catch(() => console.error("Failed to obtain a streaming token"));
    }, [token, serverUrl, isPublic]);

    useEffect(() => {
        // onPlayNext auto-advances to the next episode by re-rendering this same component
        // with a new item prop rather than unmounting it — audioTrack/subtitleTrack used to
        // carry over unchanged, so picking track 2 on episode 1 meant episode 2 auto-played
        // still requesting a track index that might not exist on that file.
        setAudioTrack(0);
        setSubtitleTrack(-1);
        // Share info (SERVER_URL/api/share/:token/info) doesn't carry audio/subtitle track
        // listings in v1 — a public viewer always gets the default track, no track-switch or
        // subtitle UI. Extending that endpoint to probe tracks the way /api/media/info does is
        // a larger, riskier refactor than this feature calls for.
        if (isPublic) return;

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
    }, [item, serverUrl, token, isPublic]);

    const isDirectPlay = (item.path?.endsWith('.mp4') || item.is_private === 1) && audioTrack === 0;

    const streamUrl = useMemo(() => {
        const supportedCodecs = getBrowserCodecs();

        if (isPublic) {
            // path= is required for a series share (picks which episode) and harmlessly
            // ignored for a file share (resolveShare always serves its own stored path
            // regardless of what's asked for) — always sending it keeps this branch the
            // same regardless of share type.
            let url = `${serverUrl}/api/share/${shareToken}/stream?path=${encodeURIComponent(item.path)}&track=0&codecs=${supportedCodecs}`;
            if (!isDirectPlay && item.progress > 5) url += `&startTime=${item.progress}`;
            return url;
        }

        if (!streamToken) return null;
        let url = `${serverUrl}/api/stream?path=${encodeURIComponent(item.path)}&token=${streamToken}&track=${audioTrack}&codecs=${supportedCodecs}&sessionId=${sessionIdRef.current}`;
        if (!isDirectPlay && item.progress > 5) {
            url += `&startTime=${item.progress}`;
        }
        return url;
    }, [item.path, streamToken, audioTrack, isDirectPlay, item.progress, serverUrl, isPublic, shareToken]);

    // --- FIX: Safe Playback Starter ---
    useEffect(() => {
        const startPlayback = async () => {
            if (videoRef.current) {
                try {
                    await videoRef.current.play();
                    setPlaying(true);
                } catch (e) {
                    if (e.name === 'NotAllowedError') {
                        // Retry muted — set directly on the element first (synchronous), not
                        // just via setMuted, since the retry below needs it to already be true
                        // the instant play() runs; React wouldn't have committed the state
                        // update to the DOM yet if that were the only thing setting it.
                        try {
                            videoRef.current.muted = true;
                            setMuted(true);
                            setShowMutedHint(true);
                            await videoRef.current.play();
                            setPlaying(true);
                        } catch (e2) {
                            if (e2.name !== 'AbortError') console.error("Playback failed even muted:", e2);
                        }
                    } else if (e.name !== 'AbortError') {
                        // Ignore AbortError (happens if user closes video quickly)
                        console.error("Playback failed:", e);
                    }
                }
            }
        };
        startPlayback();
    }, [streamUrl]); // Re-run if stream URL changes (e.g. audio track switch)

    useEffect(() => {
        if (!showMutedHint) return;
        const t = setTimeout(() => setShowMutedHint(false), 4000);
        return () => clearTimeout(t);
    }, [showMutedHint]);

    const changeAudioTrack = () => {
        if (availableAudio.length <= 1) return;
        const currentIdx = availableAudio.findIndex(t => t.index === audioTrack);
        const nextIdx = (currentIdx + 1) % availableAudio.length;
        setAudioTrack(availableAudio[nextIdx].index);
    };

    useEffect(() => {
        if (isPublic) return; // no account to attach watch history to
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
    }, [item, token, serverUrl, isDirectPlay, isPublic]);

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
    //
    // On iOS Safari specifically, even that isn't reliable enough — confirmed live: closing
    // this player there left a direct-play stream sitting in ACTIVE_STREAMS well past ten
    // minutes and still climbing, not just a brief lag. sendBeacon is the explicit backstop:
    // it's the one API guaranteed to actually dispatch even as this component (and the page
    // context around it) is being torn down, unlike a normal fetch, which the browser can
    // simply drop if navigation happens too quickly after it's issued. Skipped for a public
    // share viewer — /api/stream/end requires a real login, and an anonymous viewer has none.
    useEffect(() => {
        const videoEl = videoRef.current;
        const sessionId = sessionIdRef.current;
        return () => {
            if (videoEl) {
                videoEl.pause();
                videoEl.removeAttribute('src');
                videoEl.load();
            }
            if (!isPublic && token) {
                navigator.sendBeacon(`${serverUrl}/api/stream/end?sessionId=${sessionId}&token=${encodeURIComponent(token)}`);
            }
        };
        // isPublic/serverUrl/token are read once here deliberately — this must fire its
        // cleanup exactly once, on final unmount, not re-attach every time one of them
        // happens to change identity (none of them meaningfully change mid-playback anyway).
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // webkitShowPlaybackTargetPicker is a WebKit-only <video> method (Safari desktop/iOS/iPadOS)
    // — there's no equivalent API on Chrome/Firefox/Android, so the button is feature-detected
    // and simply doesn't render anywhere else. No backend involvement: the receiver (Apple TV,
    // an AirPlay speaker) fetches the same stream URL directly over the LAN, same as the
    // <video> element itself already does.
    const [airplaySupported, setAirplaySupported] = useState(false);
    useEffect(() => {
        setAirplaySupported(typeof videoRef.current?.webkitShowPlaybackTargetPicker === 'function');
    }, []);

    const handleAirPlay = () => {
        videoRef.current?.webkitShowPlaybackTargetPicker?.();
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

    // The standard Fullscreen API on a plain <div> is inconsistent on iPadOS — some versions
    // don't expose requestFullscreen on a non-<video> element at all, others expose it but
    // silently reject the promise. The previous code never even attached a .catch(), so a
    // rejection there was an unhandled promise rejection: nothing happened, no error, no
    // fallback. video.webkitEnterFullscreen() is Apple's own dedicated (and, for video
    // specifically, reliable) API — it hands off to iOS's native fullscreen video player
    // instead of our custom chrome, which is the accepted trade-off every custom HTML5 player
    // targeting iOS makes, since it's the only fullscreen iOS actually guarantees for video.
    const toggleFullScreen = () => {
        const container = containerRef.current;
        const video = videoRef.current;

        if (document.fullscreenElement || document.webkitFullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
            return;
        }

        if (container?.requestFullscreen) {
            container.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());
        } else if (container?.webkitRequestFullscreen) {
            container.webkitRequestFullscreen();
        } else {
            video?.webkitEnterFullscreen?.();
        }
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
            const nextPath = isPublic
                ? `/api/share/${shareToken}/next?path=${encodeURIComponent(item.path)}`
                : `/api/media/next?path=${encodeURIComponent(item.path)}`;
            const res = await apiFetch(serverUrl, nextPath, isPublic ? null : token);
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
                muted={muted}
                playsInline
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

            {/* startPlayback's muted-autoplay fallback covers the common case (a remote-cast
                open has no user-gesture context, so unmuted autoplay gets blocked — this
                retries muted, which browsers allow unconditionally), but a genuine failure or
                a normal manual pause still needs an obvious "tap to play," not just the small
                control-bar icon. pointer-events-none — purely a visual cue; the tap is handled
                by the <video>'s own onClick={togglePlay} underneath, same as tapping anywhere
                else on it. */}
            {!playing && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="bg-black/50 rounded-full p-6">
                        <Play className="w-16 h-16 text-white fill-white" />
                    </div>
                </div>
            )}

            {/* Self-dismissing (4s, or immediately on unmute) — without this, the muted
                fallback has no visible explanation at all for why there's suddenly no sound.
                Independent of showControls: this is a one-time notice, not part of the
                mouse-move-driven controls chrome. pointer-events-none for the same reason as
                the play overlay above — never intercepts a tap meant for the video/controls. */}
            {showMutedHint && (
                <div className="absolute top-20 inset-x-0 flex justify-center z-20 pointer-events-none animate-in fade-in duration-300">
                    <div className="flex items-center gap-2 bg-black/70 text-white text-sm font-medium px-4 py-2 rounded-full backdrop-blur-sm">
                        <VolumeX className="w-4 h-4" /> Muted — tap the speaker icon to unmute
                    </div>
                </div>
            )}

            {/* pt-[max(...)] rather than the plain p-6 this replaced — same iOS-PWA status-bar
                inset as TopNav.jsx's header; the player is full-screen fixed too, so it needs
                the identical compensation. */}
            <div className={`absolute top-0 left-0 w-full px-6 pb-6 pt-[max(1.5rem,env(safe-area-inset-top))] bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
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
                            {/* Clears `muted` too, not just volume — the autoplay fallback above
                                sets the element's actual muted property directly, which .volume
                                alone can't undo (they're independent on a <video>). Without this,
                                a remote-cast play that fell back to muted would stay silent
                                forever even after dragging volume back up. */}
                            <button onClick={() => { const v = volume > 0 ? 0 : 1; setVolume(v); videoRef.current.volume = v; if (muted) { videoRef.current.muted = false; setMuted(false); setShowMutedHint(false); } }} className="text-gray-300 hover:text-white">{(volume === 0 || muted) ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}</button>
                            <div className="w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300 ease-out"><input type="range" min="0" max="1" step="0.1" value={volume} onChange={(e) => { const v = parseFloat(e.target.value); setVolume(v); videoRef.current.volume = v; if (muted) { videoRef.current.muted = false; setMuted(false); setShowMutedHint(false); } }} className="w-20 h-1 bg-gray-600 rounded-lg appearance-none accent-white cursor-pointer ml-2" /></div>
                        </div>

                        {airplaySupported && (
                            <button onClick={handleAirPlay} className="text-gray-300 hover:text-white" title="AirPlay" aria-label="AirPlay">
                                <Airplay className="w-6 h-6" />
                            </button>
                        )}
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

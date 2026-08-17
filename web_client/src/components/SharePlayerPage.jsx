import React, { useState, useEffect } from 'react';
import { Loader2, ArrowLeft, Play, Download } from 'lucide-react';
import { SERVER_URL } from '../utils/api';
import { formatDuration } from '../utils/format';
import CustomVideoPlayer from './CustomVideoPlayer';

const downloadUrl = (token, path) => `${SERVER_URL}/api/share/${token}/download?path=${encodeURIComponent(path)}`;

// Standalone, unauthenticated page (mounted directly in main.jsx, before the login gate) for
// a /share/<token> link — a movie/episode goes straight to a landing card (Play/Download); a
// series goes to a plain episode grid first. Doesn't reuse Poster.jsx: its hover-metadata fetch
// and Download button both assume a real session token, which a share viewer never has.
const SharePlayerPage = ({ token }) => {
    const [state, setState] = useState('loading'); // loading | error | ready
    const [info, setInfo] = useState(null);
    const [error, setError] = useState('');
    const [activeEpisode, setActiveEpisode] = useState(null);
    const [playing, setPlaying] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`${SERVER_URL}/api/share/${token}/info`)
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'This link has expired or been revoked.');
                if (!cancelled) { setInfo(data); setState('ready'); }
            })
            .catch((e) => { if (!cancelled) { setError(e.message); setState('error'); } });
        return () => { cancelled = true; };
    }, [token]);

    if (state === 'loading') {
        return (
            <div className="min-h-screen bg-bg text-text flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-muted" />
            </div>
        );
    }

    if (state === 'error') {
        return (
            <div className="min-h-screen bg-bg text-text flex flex-col items-center justify-center gap-4 p-4 text-center">
                <img src="/logo.png" alt="StreamPi" className="h-10 w-auto object-contain" />
                <p className="text-danger font-medium">{error}</p>
                <a href="/" className="text-sm text-muted hover:text-text flex items-center gap-2">
                    <ArrowLeft className="w-4 h-4" /> Back to StreamPi
                </a>
            </div>
        );
    }

    if (info.shareType === 'file' && playing) {
        return <CustomVideoPlayer item={info} isPublic shareToken={token} serverUrl={SERVER_URL} onClose={() => setPlaying(false)} />;
    }

    if (info.shareType === 'series' && activeEpisode) {
        return (
            <CustomVideoPlayer
                item={activeEpisode}
                isPublic
                shareToken={token}
                serverUrl={SERVER_URL}
                onClose={() => setActiveEpisode(null)}
                onPlayNext={setActiveEpisode}
            />
        );
    }

    if (info.shareType === 'file') {
        return (
            <div className="min-h-screen bg-bg text-text flex flex-col items-center justify-center gap-6 p-4">
                <div className="w-full max-w-sm rounded-xl overflow-hidden border border-border bg-surface">
                    {info.poster ? (
                        <img src={`${SERVER_URL}/api/posters/${info.poster}`} alt={info.title} className="w-full aspect-video object-cover" />
                    ) : (
                        <div className="w-full aspect-video bg-gradient-to-t from-gray-900 to-gray-700" />
                    )}
                    <div className="p-5 flex flex-col gap-4">
                        <div>
                            <h1 className="text-lg font-bold">{info.title}</h1>
                            {info.duration > 0 && <p className="text-sm text-muted">{formatDuration(info.duration)}</p>}
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => setPlaying(true)} className="flex-1 inline-flex items-center justify-center gap-2 bg-accent hover:brightness-110 text-white px-4 py-2.5 rounded-lg font-bold text-sm transition-all">
                                <Play className="w-4 h-4" /> Play
                            </button>
                            <a href={downloadUrl(token, info.path)} className="inline-flex items-center justify-center gap-2 bg-surface-2 hover:brightness-110 text-text px-4 py-2.5 rounded-lg font-medium text-sm border border-border transition-all" title="Download" aria-label="Download">
                                <Download className="w-4 h-4" />
                            </a>
                        </div>
                    </div>
                </div>
                <p className="text-xs text-muted">Shared via StreamPi &mdash; no account needed</p>
            </div>
        );
    }

    // Series share — episode grid
    return (
        <div className="min-h-screen bg-bg text-text p-6 md:p-12">
            <div className="flex items-center gap-3 mb-8">
                <img src="/logo.png" alt="StreamPi" className="h-9 w-auto object-contain" />
                <h1 className="text-2xl font-bold">{info.seriesName}</h1>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 max-w-[1600px] mx-auto">
                {info.episodes.map((ep) => (
                    <div key={ep.path} className="group relative aspect-video bg-gray-800 rounded-lg overflow-hidden border border-gray-700/30">
                        <div onClick={() => setActiveEpisode(ep)} className="absolute inset-0 cursor-pointer">
                            {ep.poster ? (
                                <img src={`${SERVER_URL}/api/posters/${ep.poster}`} alt={ep.title} className="w-full h-full object-cover opacity-80 group-hover:opacity-40 transition-opacity" loading="lazy" />
                            ) : (
                                <div className="w-full h-full bg-gradient-to-t from-gray-900 to-gray-700" />
                            )}
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                                <Play className="w-8 h-8 text-white fill-white" />
                            </div>
                            <div className="absolute bottom-0 left-0 w-full p-2 bg-gradient-to-t from-black/90 to-transparent">
                                <p className="text-white text-xs font-bold truncate">S{ep.season} E{ep.episode}</p>
                                {ep.duration > 0 && <p className="text-gray-400 text-[10px]">{formatDuration(ep.duration)}</p>}
                            </div>
                        </div>
                        {/* Always visible, not hover-revealed like the Play overlay above — a
                            share link has no logged-in session, so it's disproportionately
                            likely to be opened on a phone, where :hover never fires at all and
                            group-hover:opacity-100 would leave this permanently invisible. */}
                        <a
                            href={downloadUrl(token, ep.path)}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-full text-gray-300 hover:text-white hover:bg-black/80 transition-all z-10"
                            title="Download"
                            aria-label="Download episode"
                        >
                            <Download className="w-4 h-4" />
                        </a>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default SharePlayerPage;

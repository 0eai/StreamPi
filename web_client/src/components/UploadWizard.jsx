import React, { useState, useEffect, useRef } from 'react';
import { UploadCloud, Lock, X, Film, Tv, ChevronDown, CheckCircle2, HardDrive, AlertTriangle, Server, Zap, Plus } from 'lucide-react';
import { formatBytes } from '../utils/format';
import Modal from './ui/Modal';
import { apiFetch } from '../utils/api';

const UploadWizard = ({ isOpen, onClose, onStartUpload, token, serverUrl }) => {
    const [step, setStep] = useState(1);
    const [files, setFiles] = useState([]);
    const [type, setType] = useState('movie');
    const [seriesList, setSeriesList] = useState([]);
    const [seriesName, setSeriesName] = useState('');
    const [season, setSeason] = useState('1');
    const [availableSeasons, setAvailableSeasons] = useState(['1']);
    const [existingEpisodes, setExistingEpisodes] = useState([]);
    const [fileMeta, setFileMeta] = useState({});
    const [storage, setStorage] = useState(null); // New State for Storage
    const inputRef = useRef(null);
    const addFilesInputRef = useRef(null);
    const [isPrivate, setIsPrivate] = useState(false);
    const [destination, setDestination] = useState('main'); // 'main' (default) or 'nas'
    const [nasNodes, setNasNodes] = useState([]);
    const [selectedNodeId, setSelectedNodeId] = useState('');

    // --- FETCH DATA ON OPEN ---
    useEffect(() => {
        if (isOpen) {
            // Reset Form
            setStep(1); setFiles([]); setType('movie'); setSeriesName(''); setSeason('1'); setFileMeta({}); setStorage(null); setIsPrivate(false);
            setDestination('main'); setNasNodes([]); setSelectedNodeId('');

            if (token && serverUrl) {
                // 1. Fetch Series List
                apiFetch(serverUrl, '/api/series', token)
                    .then(r => r.json()).then(setSeriesList).catch(()=>{});

                // 2. Fetch Storage Status
                apiFetch(serverUrl, '/api/status/storage', token)
                    .then(r => r.json()).then(setStorage).catch(console.error);

                // 3. Fetch eligible NAS nodes for the destination picker
                apiFetch(serverUrl, '/api/upload/nas-nodes', token)
                    .then(r => r.json()).then(setNasNodes).catch(()=>{});
            }
        }
    }, [isOpen, token, serverUrl]);

    // ... (Existing Series Logic kept exactly the same) ...
    useEffect(() => {
        if (type === 'series' && seriesName && token && serverUrl) {
            apiFetch(serverUrl, `/api/series/${encodeURIComponent(seriesName)}`, token)
                .then(r => r.json())
                .then(data => {
                    const seasons = [...new Set(data.map(d => d.season))].sort((a,b)=>a-b);
                    if (seasons.length > 0) {
                        const nextSeason = seasons[seasons.length - 1] + 1;
                        if (!seasons.includes(nextSeason)) seasons.push(nextSeason);
                    } else { seasons.push(1); }
                    setAvailableSeasons(seasons.map(String));
                    const eps = data.filter(d => d.season === parseInt(season)).map(d => d.episode);
                    setExistingEpisodes(eps.sort((a, b) => a - b));
                })
                .catch(() => { setExistingEpisodes([]); setAvailableSeasons(['1']); });
        }
    }, [seriesName, season, type, token, serverUrl]);

    useEffect(() => {
        if (type === 'series' && files.length > 0) {
            const maxEp = existingEpisodes.length > 0 ? Math.max(...existingEpisodes) : 0;
            let startEp = maxEp + 1;
            setFileMeta(prev => {
                const next = { ...prev };
                files.forEach((f, idx) => {
                    if (next[f.name]) next[f.name] = { ...next[f.name], episode: startEp + idx };
                });
                return next;
            });
        }
    }, [existingEpisodes, files, type]);

    const handleFileSelect = (e) => {
        if (e.target.files?.length) {
            const selected = Array.from(e.target.files);
            setFiles(selected);
            const initialMeta = {};
            selected.forEach((f, index) => {
                initialMeta[f.name] = { title: f.name.replace(/\.[^/.]+$/, ""), episode: index + 1 };
            });
            setFileMeta(initialMeta);
            setStep(2);
        }
    };

    const updateMeta = (filename, key, value) => {
        setFileMeta(prev => ({ ...prev, [filename]: { ...prev[filename], [key]: value } }));
    };

    // Appends to the existing selection (step 1's handleFileSelect replaces it instead,
    // since that's the very first pick) — lets a user add more files without losing the
    // titles/episodes/destination already configured for ones already on the list.
    const handleAddFiles = (e) => {
        if (e.target.files?.length) {
            const added = Array.from(e.target.files);
            setFiles(prev => [...prev, ...added]);
            setFileMeta(prev => {
                const next = { ...prev };
                added.forEach((f, idx) => {
                    if (!next[f.name]) next[f.name] = { title: f.name.replace(/\.[^/.]+$/, ""), episode: files.length + idx + 1 };
                });
                return next;
            });
        }
        e.target.value = '';
    };

    const handleSubmit = () => {
        // Optional: Block upload if strictly no space, but for now we just rely on the warning
        const uploadItems = files.map(f => {
            const meta = fileMeta[f.name];
            return {
                file: f,
                type,
                title: meta.title,
                seriesName: type === 'series' ? seriesName : null,
                season: type === 'series' ? season : null,
                episode: type === 'series' ? meta.episode : null,
                isPrivate: isPrivate,
                destination,
                nodeId: destination === 'nas' ? selectedNodeId : null
            };
        });
        onStartUpload(uploadItems);
        onClose();
    };

    const selectedNode = destination === 'nas' ? nasNodes.find(n => n.id === selectedNodeId) : null;
    // Threshold: 10 GB in bytes — checked against whichever destination is actually chosen
    // (main server's own disk, or the selected node's), so the warning always reflects where
    // the file is really going to land.
    const relevantFree = selectedNode ? selectedNode.free : storage?.free;
    const relevantTotal = selectedNode ? selectedNode.total : storage?.total;
    const relevantPercent = selectedNode ? selectedNode.percent : storage?.percentage;
    const isLowStorage = relevantFree !== undefined && relevantFree < 10 * 1024 * 1024 * 1024;

    return (
        <Modal isOpen={isOpen} onClose={onClose} maxWidth="max-w-2xl" panelClassName="flex flex-col max-h-[85vh]" hideCloseButton>
                <div className="flex justify-between items-center mb-6 border-b border-gray-800 pb-4">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <UploadCloud className="text-red-600" /> {step === 1 ? "Select Files" : "Review & Configure"}
                    </h2>
                    <button onClick={onClose} aria-label="Close"><X className="text-gray-400 hover:text-white"/></button>
                </div>

                <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                    
                    {/* --- NEW: STORAGE INDICATOR --- */}
                    {/* Reflects whichever destination is currently chosen — the main server's
                        disk, or the selected node's, once one is picked. */}
                    {relevantFree !== undefined ? (
                        <div className={`mb-6 p-4 rounded-xl flex items-center justify-between border transition-colors ${
                            isLowStorage
                                ? 'bg-red-900/20 border-red-500/30'
                                : 'bg-blue-900/10 border-blue-500/20'
                        }`}>
                            <div className="flex items-center gap-3">
                                <div className={`p-2 rounded-full ${isLowStorage ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                    {isLowStorage ? <AlertTriangle className="w-5 h-5" /> : <HardDrive className="w-5 h-5" />}
                                </div>
                                <div>
                                    <div className={`text-sm font-bold ${isLowStorage ? 'text-red-400' : 'text-blue-400'}`}>
                                        {isLowStorage ? 'Low Storage Space' : 'Storage Available'}
                                    </div>
                                    <div className="text-xs text-gray-400 mt-0.5">
                                        <span className="text-white font-mono font-bold">{formatBytes(relevantFree)}</span> free of {formatBytes(relevantTotal)}
                                        {selectedNode && <span className="text-gray-500"> on {selectedNode.name}</span>}
                                    </div>
                                </div>
                            </div>

                            {/* Storage Bar */}
                            <div className="hidden sm:block w-32">
                                <div className="flex justify-end text-[10px] text-gray-400 mb-1">{Math.round(relevantPercent)}% Used</div>
                                <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full ${isLowStorage ? 'bg-red-500' : 'bg-blue-500'}`}
                                        style={{ width: `${relevantPercent}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    ) : destination === 'nas' ? (
                        <div className="mb-6 p-4 rounded-xl border border-gray-800 bg-gray-800/30 text-xs text-gray-500 flex items-center gap-2">
                            <HardDrive className="w-4 h-4" /> Pick a node below to see its free space
                        </div>
                    ) : (
                        <div className="mb-6 h-16 bg-gray-800/30 animate-pulse rounded-xl" />
                    )}
                    {/* --------------------------- */}

                    {step === 1 ? (
                        <div className="space-y-6">
                            <div onClick={() => inputRef.current?.click()} className="border-2 border-dashed border-gray-700 rounded-2xl p-12 text-center cursor-pointer hover:border-red-600/50 hover:bg-red-900/10 transition-all group">
                                <input type="file" multiple accept=".mp4,.mkv,.avi,.mov,.webm" onChange={handleFileSelect} className="hidden" ref={inputRef} />
                                <div className="flex flex-col items-center gap-4">
                                    <div className="p-4 bg-gray-800 rounded-full group-hover:scale-110 transition-transform">
                                        <Film className="w-10 h-10 text-gray-400 group-hover:text-red-500" />
                                    </div>
                                    <div>
                                        <span className="text-lg text-white font-medium block">Click to select video files</span>
                                        <span className="text-sm text-gray-500">MP4, MKV, AVI, MOV</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            <div className="grid grid-cols-2 gap-4 bg-gray-900/50 p-4 rounded-xl border border-gray-800">
                                <div>
                                    <label className="text-xs text-gray-500 uppercase font-bold mb-2 block">Content Type</label>
                                    <div className="flex gap-2 bg-gray-800 p-1 rounded-lg">
                                        <button onClick={() => setType('movie')} className={`flex-1 py-1.5 rounded text-sm font-medium transition-all flex items-center justify-center gap-2 ${type === 'movie' ? 'bg-gray-700 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><Film className="w-4 h-4"/> Movie</button>
                                        <button onClick={() => setType('series')} className={`flex-1 py-1.5 rounded text-sm font-medium transition-all flex items-center justify-center gap-2 ${type === 'series' ? 'bg-gray-700 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><Tv className="w-4 h-4"/> Series</button>
                                    </div>
                                </div>
                                {type === 'series' && (
                                    <div className="space-y-3">
                                        <div>
                                            <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Series Name</label>
                                            <div className="relative">
                                                <input list="series-list" className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:border-red-600 outline-none" placeholder="Select or Type..." value={seriesName} onChange={(e) => setSeriesName(e.target.value)} />
                                                <datalist id="series-list">{seriesList.map(s => <option key={s} value={s} />)}</datalist>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Session (Season)</label>
                                            <div className="relative">
                                                <input
                                                    type="number"
                                                    min="1"
                                                    list="season-list"
                                                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:border-red-600 outline-none"
                                                    placeholder="Season number"
                                                    value={season}
                                                    onChange={(e) => setSeason(e.target.value)}
                                                />
                                                <datalist id="season-list">{availableSeasons.map(s => <option key={s} value={s}>{`Season ${s}`}</option>)}</datalist>
                                            </div>
                                            <div className="mt-3">
                                                <span className="text-xs text-gray-500 block mb-1">Existing Episodes:</span>
                                                {existingEpisodes.length > 0 ? (
                                                    <div className="flex flex-wrap gap-1">{existingEpisodes.map(ep => (<span key={ep} className="px-1.5 py-0.5 bg-gray-800 text-gray-400 text-[10px] rounded border border-gray-700">{ep}</span>))}</div>
                                                ) : (<span className="text-xs text-gray-600 italic">None</span>)}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="p-4 rounded-xl border border-gray-800 bg-gray-900/50">
                                <label className="text-xs text-gray-500 uppercase font-bold mb-2 block">Destination</label>
                                <div className="flex gap-2 bg-gray-800 p-1 rounded-lg">
                                    <button onClick={() => setDestination('main')} className={`flex-1 py-1.5 rounded text-sm font-medium transition-all flex items-center justify-center gap-2 ${destination === 'main' ? 'bg-gray-700 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><Server className="w-4 h-4"/> Main Server</button>
                                    <button onClick={() => setDestination('nas')} disabled={nasNodes.length === 0} className={`flex-1 py-1.5 rounded text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${destination === 'nas' ? 'bg-gray-700 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}><Zap className="w-4 h-4"/> Direct to Node</button>
                                </div>
                                {destination === 'nas' && (
                                    <div className="relative mt-3">
                                        <select className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:border-red-600 outline-none appearance-none" value={selectedNodeId} onChange={e => setSelectedNodeId(e.target.value)}>
                                            <option value="">Select a node...</option>
                                            {nasNodes.map(n => <option key={n.id} value={n.id}>{n.name} — {formatBytes(n.free)} free</option>)}
                                        </select>
                                        <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 text-gray-500 pointer-events-none" />
                                    </div>
                                )}
                                {nasNodes.length === 0 && (
                                    <div className="text-xs text-gray-600 italic mt-2">No NAS nodes currently reachable</div>
                                )}
                            </div>
                            <div
                                className={`p-4 rounded-xl border transition-colors cursor-pointer flex items-center justify-between ${isPrivate ? 'bg-red-900/20 border-red-500/50' : 'bg-gray-800 border-gray-700'}`}
                                onClick={() => setIsPrivate(!isPrivate)}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-full ${isPrivate ? 'bg-red-500 text-white' : 'bg-gray-700 text-gray-400'}`}>
                                        <Lock className="w-5 h-5" />
                                    </div>
                                    <div>
                                        <div className="text-sm font-bold text-white">Private Vault</div>
                                        <div className="text-xs text-gray-400">Only you can see these files</div>
                                    </div>
                                </div>
                                <div className={`w-6 h-6 rounded border flex items-center justify-center ${isPrivate ? 'bg-red-500 border-red-500' : 'border-gray-600'}`}>
                                    {isPrivate && <CheckCircle2 className="w-4 h-4 text-white" />}
                                </div>
                            </div>
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs text-gray-500 uppercase font-bold block">File Details ({files.length})</label>
                                    <button onClick={() => addFilesInputRef.current?.click()} className="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1">
                                        <Plus className="w-3.5 h-3.5" /> Add Files
                                    </button>
                                    <input type="file" multiple accept=".mp4,.mkv,.avi,.mov,.webm" onChange={handleAddFiles} className="hidden" ref={addFilesInputRef} />
                                </div>
                                {files.map((file, idx) => (
                                    <div key={idx} className="flex items-center gap-4 bg-gray-800/30 p-3 rounded-lg border border-gray-800">
                                        <div className="w-8 h-8 flex items-center justify-center bg-gray-800 rounded text-gray-500 text-xs font-mono">{idx + 1}</div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs text-gray-500 truncate mb-1">{file.name}</div>
                                            {type === 'movie' ? (
                                                <input type="text" className="w-full bg-transparent border-b border-gray-700 text-sm text-white focus:border-red-600 outline-none px-0 py-1" placeholder="Movie Title" value={fileMeta[file.name]?.title || ''} onChange={(e) => updateMeta(file.name, 'title', e.target.value)} />
                                            ) : (
                                                <div className="flex items-center gap-3">
                                                    <span className="text-sm text-gray-400">Episode</span>
                                                    <input type="number" className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:border-red-600 outline-none" value={fileMeta[file.name]?.episode || ''} onChange={(e) => updateMeta(file.name, 'episode', e.target.value)} />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                <div className="mt-6 pt-4 border-t border-gray-800 flex justify-end gap-3">
                    {step === 2 && <button onClick={() => setStep(1)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Back</button>}
                    {step === 2 ? <button onClick={handleSubmit} disabled={(type === 'series' && !seriesName) || (destination === 'nas' && !selectedNodeId)} className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-lg font-bold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"><UploadCloud className="w-4 h-4" /> Start Upload</button> : null}
                </div>
        </Modal>
    );
};

export default UploadWizard;

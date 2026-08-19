import React from 'react';
import { UploadCloud, X, Film, Tv, FileUp } from 'lucide-react';

/**
 * Describes one queued item in the label under its progress bar.
 *
 * Media uploads carry a type and possibly a series/episode; a user file carries neither, and the old
 * code fell through to a TV icon and "S undefined E undefined" for anything that wasn't a movie.
 */
const describe = (item) => {
    if (item.kind === 'file') return { Icon: FileUp, label: item.name || item.file.name };
    if (item.seriesName) return { Icon: Tv, label: `${item.seriesName} S${item.season}E${item.episode}` };
    return { Icon: item.type === 'movie' ? Film : Tv, label: item.title || item.type };
};

const UploadQueue = ({ queue, onRemove, onRetry, onCancel, onClearCompleted }) => {
    if (queue.length === 0) return null;
    const hasCompleted = queue.some(item => item.status === 'done' || item.status === 'error');

    return (
        <div className="fixed bottom-6 right-6 w-80 bg-[#1a1a1a] border border-gray-800 rounded-xl shadow-2xl overflow-hidden z-[100] flex flex-col max-h-[400px] animate-in slide-in-from-bottom-10 fade-in duration-300">
            <div className="bg-gray-900 px-4 py-3 border-b border-gray-800 flex justify-between items-center">
                <span className="text-sm font-semibold text-white flex items-center gap-2">
                    <UploadCloud className="w-4 h-4 text-red-500" /> Uploads ({queue.length})
                </span>
                {hasCompleted && (
                    <button onClick={onClearCompleted} className="p-1 hover:bg-gray-800 rounded text-gray-400 hover:text-white transition-colors" title="Close and Clear Done" aria-label="Close and Clear Done">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
            <div className="overflow-y-auto p-2 space-y-2 custom-scrollbar">
                {queue.map((item) => (
                    <div key={item.id} className="bg-gray-800/50 rounded-lg p-3 relative group border border-gray-700/50">
                        <div className="flex justify-between items-start mb-1">
                            <span className="text-xs font-medium text-gray-300 truncate w-3/4" title={item.file.name}>
                                {item.file.name}
                            </span>
                            {item.status === 'error' && (
                                <button onClick={() => onRetry(item.id)} className="text-xs text-red-400 hover:text-red-300">Retry</button>
                            )}
                            {(item.status === 'done' || item.status === 'error') ? (
                                <button onClick={() => onRemove(item.id)} className="text-gray-500 hover:text-white" aria-label={`Dismiss ${item.file.name}`}><X className="w-3 h-3"/></button>
                            ) : onCancel && (
                                /* Previously there was no way to stop one upload — only logging out
                                   aborted them all. A 400-file folder makes that matter. */
                                <button onClick={() => onCancel(item.id)} className="text-gray-500 hover:text-white" aria-label={`Cancel ${item.file.name}`}><X className="w-3 h-3"/></button>
                            )}
                        </div>
                        <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
                            <div 
                                className={`h-full transition-all duration-300 ${
                                    item.status === 'error' ? 'bg-red-500' : 
                                    item.status === 'done' ? 'bg-green-500' : 'bg-blue-500'
                                }`} 
                                style={{ width: `${item.progress}%` }} 
                            />
                        </div>
                        <div className="flex justify-between mt-1">
                            <span className="text-[10px] text-gray-500 uppercase flex items-center gap-1 truncate">
                                {(() => { const { Icon } = describe(item); return <Icon className="w-3 h-3 shrink-0" />; })()}
                                <span className="truncate">{describe(item).label}</span>
                            </span>
                            <span className={`text-[10px] font-mono shrink-0 ${item.status === 'error' ? 'text-red-400' : item.status === 'done' ? 'text-green-400' : 'text-blue-400'}`}>
                                {item.status === 'uploading' ? `${Math.round(item.progress)}%` : item.status}
                            </span>
                        </div>
                        {/* The server's own words, rather than the word "error" — a quota rejection or
                            a size limit is only actionable if it is repeated. */}
                        {item.status === 'error' && item.error && (
                            <p className="mt-1 text-[10px] text-red-400/90 leading-snug">{item.error}</p>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default UploadQueue;

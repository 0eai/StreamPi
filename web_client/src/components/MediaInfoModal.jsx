import React from 'react';
import { Loader2, Film, Volume2, Subtitles, Image, Info, Pencil, Download } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { formatBytes, formatDuration } from '../utils/format';

const Row = ({ label, value }) => {
    if (value === null || value === undefined || value === '') return null;
    return (
        <div className="flex justify-between gap-4 py-1 text-sm">
            <span className="text-gray-500">{label}</span>
            <span className="text-gray-200 text-right break-all">{value}</span>
        </div>
    );
};

const Section = ({ icon, title, children }) => (
    <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
        <h4 className="text-xs font-bold uppercase text-gray-400 flex items-center gap-2 mb-2">{icon} {title}</h4>
        {children}
    </div>
);

// Everything ffprobe already hands back for /api/media/info, just parsed further and laid out
// per-stream instead of collapsed into the handful of fields Poster.jsx's hover badges use —
// same source data, deeper view. metadata/loading are lifted from Poster.jsx's own existing
// hover-triggered fetch rather than this modal fetching a second time.
//
// Rename and download live here rather than on the poster's hover cluster, which had grown to seven
// buttons. Both are actions you take deliberately about one item, which is exactly what this dialog
// already is. Each renders only when its handler is passed, so callers decide what is on offer and
// this stays presentational — EpisodeCard passes neither and gets no footer.
const MediaInfoModal = ({ isOpen, onClose, item, metadata, loading, onRename, onDownload }) => (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="max-w-lg" panelClassName="max-h-[85vh] flex flex-col" title={<><Info className="w-5 h-5 text-blue-500" /> Media Info</>}>
        <div className="overflow-y-auto pr-1 space-y-4">
            <div>
                <h3 className="text-white font-bold truncate">{item?.title || item?.filename}</h3>
                <p className="text-xs text-gray-500 truncate">{item?.filename}</p>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-10 text-gray-500">
                    <Loader2 className="w-6 h-6 animate-spin" />
                </div>
            ) : !metadata ? (
                <p className="text-sm text-gray-500 italic py-6 text-center">No metadata available for this file.</p>
            ) : (
                <>
                    <Section icon={<Film className="w-3.5 h-3.5" />} title="File">
                        <Row label="Size" value={formatBytes(metadata.fileSize)} />
                        <Row label="Duration" value={metadata.container?.duration ? formatDuration(metadata.container.duration) : null} />
                        <Row label="Overall Bitrate" value={metadata.container?.bitrate ? `${Math.round(metadata.container.bitrate / 1000)} kb/s` : null} />
                        <Row label="Title Tag" value={metadata.container?.title} />
                        <Row label="Encoder" value={metadata.container?.encoder} />
                        <Row label="Created" value={metadata.container?.creationTime ? new Date(metadata.container.creationTime).toLocaleString() : null} />
                    </Section>

                    {metadata.video && (
                        <Section icon={<Film className="w-3.5 h-3.5" />} title="Video">
                            <Row label="Codec" value={metadata.video.codec} />
                            <Row label="Resolution" value={metadata.video.width && metadata.video.height ? `${metadata.video.width}x${metadata.video.height}` : null} />
                            <Row label="Frame Rate" value={metadata.video.fps ? `${metadata.video.fps} fps` : null} />
                            <Row label="Bitrate" value={metadata.video.bitrate ? `${Math.round(metadata.video.bitrate / 1000)} kb/s` : null} />
                            <Row label="Profile" value={metadata.video.profile} />
                        </Section>
                    )}

                    {metadata.audioTracks?.length > 0 && (
                        <Section icon={<Volume2 className="w-3.5 h-3.5" />} title={`Audio (${metadata.audioTracks.length})`}>
                            {metadata.audioTracks.map((a, i) => (
                                <div key={a.index} className={i > 0 ? "pt-3 mt-2 border-t border-gray-800" : ""}>
                                    <Row label="Track" value={`${a.title || a.language.toUpperCase()}${a.isDefault ? ' (default)' : ''}`} />
                                    <Row label="Codec" value={a.codec} />
                                    <Row label="Channels" value={a.channels} />
                                    <Row label="Sample Rate" value={a.sampleRate ? `${a.sampleRate} Hz` : null} />
                                </div>
                            ))}
                        </Section>
                    )}

                    {metadata.subtitleTracks?.length > 0 && (
                        <Section icon={<Subtitles className="w-3.5 h-3.5" />} title={`Subtitles (${metadata.subtitleTracks.length})`}>
                            {metadata.subtitleTracks.map((s, i) => (
                                <div key={s.index} className={i > 0 ? "pt-3 mt-2 border-t border-gray-800" : ""}>
                                    <Row label="Track" value={s.title || s.language.toUpperCase()} />
                                    <Row label="Codec" value={s.codec} />
                                </div>
                            ))}
                        </Section>
                    )}

                    {metadata.attachments?.length > 0 && (
                        <Section icon={<Image className="w-3.5 h-3.5" />} title={`Attachments (${metadata.attachments.length})`}>
                            {metadata.attachments.map((a, i) => (
                                <Row key={i} label={a.mimetype || 'file'} value={a.filename} />
                            ))}
                        </Section>
                    )}
                </>
            )}
        </div>

        {(onRename || onDownload) && (
            <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-gray-800 shrink-0">
                {onRename && (
                    <Button variant="ghost" onClick={onRename}>
                        <Pencil className="w-4 h-4" /> Rename
                    </Button>
                )}
                {onDownload && (
                    <Button variant="ghost" onClick={onDownload}>
                        <Download className="w-4 h-4" /> Download
                    </Button>
                )}
            </div>
        )}
    </Modal>
);

export default MediaInfoModal;

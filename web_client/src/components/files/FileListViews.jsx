import React from 'react';
import { Folder, File as FileIcon, Link2, Users, Copy, Check, Trash2, RotateCcw, Clock, Download } from 'lucide-react';
import { formatBytes, formatTimeUntil, formatDate } from '../../utils/format';

/**
 * The three read-mostly sub-views of the Files tab: what you have shared, what has been shared with
 * you, and what is in the trash.
 *
 * Together in one file because each is a table with two or three actions and no state of its own —
 * three near-identical 40-line files would be worse to read than one that shows them side by side.
 */

const Card = ({ title, icon, children }) => (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            {icon}
            <h3 className="font-bold text-text text-sm">{title}</h3>
        </div>
        {children}
    </div>
);

const Empty = ({ children }) => <div className="p-6 text-sm text-muted italic">{children}</div>;

const Head = ({ cols }) => (
    <thead className="bg-surface-2 text-muted font-medium text-xs uppercase">
        <tr>{cols.map((c) => <th key={c} className={`px-4 py-3 ${c === 'Actions' ? 'text-right' : ''}`}>{c}</th>)}</tr>
    </thead>
);

const NameCell = ({ isFolder, name }) => (
    <span className="inline-flex items-center gap-2 text-text truncate max-w-full">
        {isFolder ? <Folder className="w-4 h-4 text-accent shrink-0" /> : <FileIcon className="w-4 h-4 text-muted shrink-0" />}
        <span className="truncate">{name}</span>
    </span>
);

export const MyFileShares = ({ shares = [], copiedId, onCopy, onExpiry, onRevoke }) => (
    <Card title="What I've shared" icon={<Link2 className="w-4 h-4 text-accent" />}>
        {shares.length === 0 ? (
            <Empty>Nothing shared yet — use Share on any file or folder.</Empty>
        ) : (
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <Head cols={['Item', 'Shared with', 'Expires', 'Opens', 'Actions']} />
                    <tbody className="divide-y divide-border">
                        {shares.map((s) => (
                            <tr key={s.id} className="hover:bg-surface-2/60">
                                <td className="px-4 py-3 min-w-0"><NameCell isFolder={s.isFolder} name={s.itemName} /></td>
                                <td className="px-4 py-3 text-xs">
                                    {s.kind === 'link' ? (
                                        <span className="inline-flex items-center gap-1 text-muted"><Link2 className="w-3.5 h-3.5" /> Anyone with the link</span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1 text-muted"><Users className="w-3.5 h-3.5" /> {s.recipient}</span>
                                    )}
                                </td>
                                <td className="px-4 py-3 text-xs">
                                    {s.expiresAt
                                        ? <span className="text-warning" title={new Date(s.expiresAt).toLocaleString()}>{formatTimeUntil(s.expiresAt)}</span>
                                        : <span className="text-muted-2">never</span>}
                                </td>
                                {/* "Opens", not "views" — the counter only moves when a link's page loads, and it
                                    never moves at all for a share with a named person. */}
                                <td className="px-4 py-3 text-muted text-xs">{s.kind === 'link' ? s.opens : '—'}</td>
                                <td className="px-4 py-3 text-right whitespace-nowrap">
                                    {s.kind === 'link' && (
                                        <button onClick={() => onCopy(s)} className="text-info hover:brightness-125 text-xs font-medium mr-3 inline-flex items-center gap-1">
                                            {copiedId === s.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy
                                        </button>
                                    )}
                                    <button onClick={() => onExpiry(s)} className="text-muted hover:text-text text-xs font-medium mr-3 inline-flex items-center gap-1">
                                        <Clock className="w-3.5 h-3.5" /> Expiry
                                    </button>
                                    <button onClick={() => onRevoke(s)} className="text-danger hover:brightness-125 text-xs font-medium inline-flex items-center gap-1">
                                        <Trash2 className="w-3.5 h-3.5" /> Revoke
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )}
    </Card>
);

export const SharedWithMe = ({ items = [], onOpen, onDownload }) => (
    <Card title="Shared with me" icon={<Users className="w-4 h-4 text-success" />}>
        {items.length === 0 ? (
            <Empty>Nothing yet. Anything someone shares with you shows up here.</Empty>
        ) : (
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <Head cols={['Item', 'From', 'Shared', 'Size', 'Actions']} />
                    <tbody className="divide-y divide-border">
                        {items.map((i) => (
                            <tr key={i.shareId} className="hover:bg-surface-2/60">
                                <td className="px-4 py-3 min-w-0"><NameCell isFolder={i.isFolder} name={i.name} /></td>
                                <td className="px-4 py-3 text-muted text-xs">{i.owner}</td>
                                <td className="px-4 py-3 text-muted text-xs">{formatDate(i.sharedAt)}</td>
                                <td className="px-4 py-3 text-muted text-xs">{i.isFolder ? '—' : formatBytes(i.size)}</td>
                                <td className="px-4 py-3 text-right">
                                    {i.isFolder ? (
                                        <button onClick={() => onOpen(i)} className="text-info hover:brightness-125 text-xs font-medium">Open</button>
                                    ) : (
                                        <button onClick={() => onDownload(i)} className="text-info hover:brightness-125 text-xs font-medium inline-flex items-center gap-1">
                                            <Download className="w-3.5 h-3.5" /> Download
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )}
        <div className="px-4 py-3 border-t border-border text-xs text-muted-2">
            You can view and download these. Only their owner can change or delete them.
        </div>
    </Card>
);

export const FileTrash = ({ items = [], graceDays = 7, onRestore, onPurge }) => (
    <Card title="Trash" icon={<Trash2 className="w-4 h-4 text-muted" />}>
        {items.length === 0 ? (
            <Empty>Nothing in the trash.</Empty>
        ) : (
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <Head cols={['Item', 'Deleted', 'Purges', 'Size', 'Actions']} />
                    <tbody className="divide-y divide-border">
                        {items.map((i) => (
                            <tr key={i.id} className="hover:bg-surface-2/60">
                                <td className="px-4 py-3 min-w-0"><NameCell isFolder={i.isFolder} name={i.name} /></td>
                                <td className="px-4 py-3 text-muted text-xs">{formatDate(i.deletedAt)}</td>
                                <td className="px-4 py-3 text-xs text-warning" title={new Date(i.purgesAt).toLocaleString()}>
                                    {formatTimeUntil(i.purgesAt)}
                                </td>
                                <td className="px-4 py-3 text-muted text-xs">{i.isFolder ? '—' : formatBytes(i.size)}</td>
                                <td className="px-4 py-3 text-right whitespace-nowrap">
                                    <button onClick={() => onRestore(i)} className="text-info hover:brightness-125 text-xs font-medium mr-3 inline-flex items-center gap-1">
                                        <RotateCcw className="w-3.5 h-3.5" /> Restore
                                    </button>
                                    <button onClick={() => onPurge(i)} className="text-danger hover:brightness-125 text-xs font-medium">Delete now</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )}
        {/* The reason someone's storage doesn't drop when they delete things. */}
        <div className="px-4 py-3 border-t border-border text-xs text-muted-2">
            Items are removed for good after {graceDays} days, and still count toward your storage until then.
        </div>
    </Card>
);

import React from 'react';
import { Folder, File as FileIcon, ChevronRight, Home, MoreHorizontal, Download, Eye } from 'lucide-react';
import { formatBytes, formatTimeUntil, formatDate } from '../../utils/format';

/**
 * The file table: breadcrumb, rows, selection, and a per-row menu.
 *
 * Presentational — every action is a callback, so the tab above owns the requests and this stays
 * testable without a server. Selection lives up there too, because the bulk bar needs it and so does
 * the tab's own header.
 */

const Crumbs = ({ trail, onNavigate }) => (
    <nav className="flex items-center gap-1 text-sm min-w-0" aria-label="Breadcrumb">
        {trail.map((c, i) => (
            <React.Fragment key={c.id}>
                {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-2 shrink-0" />}
                <button
                    onClick={() => onNavigate(c)}
                    disabled={i === trail.length - 1}
                    className={`truncate px-1 rounded ${i === trail.length - 1
                        ? 'text-text font-medium cursor-default'
                        : 'text-muted hover:text-text hover:bg-surface-2'}`}
                >
                    {/* The root row's name is the empty string, so it needs a label of its own. */}
                    {c.isRoot ? <span className="inline-flex items-center gap-1"><Home className="w-3.5 h-3.5" /> Home</span> : c.name}
                </button>
            </React.Fragment>
        ))}
    </nav>
);

const FileBrowser = ({
    trail = [],
    items = [],
    selected = new Set(),
    readOnly = false,
    unavailable = false,
    loading = false,
    onNavigate,
    onToggle,
    onToggleAll,
    onOpenMenu,
    onDownload,
    onPreview,
}) => {
    const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-3 min-w-0">
                <Crumbs trail={trail} onNavigate={onNavigate} />
            </div>

            {unavailable ? (
                // Distinguished from empty on purpose: claiming someone has no files, on a screen they
                // opened to look at their files, is worse than admitting the server is behind.
                <div className="p-6 text-sm text-muted italic">
                    Files aren&apos;t available on this server version.
                </div>
            ) : loading ? (
                <div className="p-6 text-sm text-muted italic">Loading…</div>
            ) : items.length === 0 ? (
                <div className="p-6 text-sm text-muted italic">
                    {readOnly ? 'Nothing in this folder.' : 'Nothing here yet — upload something, or make a folder.'}
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-surface-2 text-muted font-medium text-xs uppercase">
                            <tr>
                                {!readOnly && (
                                    <th className="pl-4 py-3 w-10">
                                        <input
                                            type="checkbox"
                                            aria-label="Select all"
                                            checked={allSelected}
                                            onChange={() => onToggleAll(!allSelected)}
                                        />
                                    </th>
                                )}
                                <th className="px-4 py-3">Name</th>
                                <th className="px-4 py-3 w-24">Size</th>
                                <th className="px-4 py-3 w-32">Modified</th>
                                {!readOnly && <th className="px-4 py-3 w-40">Auto-delete</th>}
                                <th className="px-4 py-3 w-32 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {items.map((item) => (
                                <tr key={item.id} className="hover:bg-surface-2/60">
                                    {!readOnly && (
                                        <td className="pl-4 py-3">
                                            <input
                                                type="checkbox"
                                                aria-label={`Select ${item.name}`}
                                                checked={selected.has(item.id)}
                                                onChange={() => onToggle(item.id)}
                                            />
                                        </td>
                                    )}
                                    <td className="px-4 py-3 min-w-0">
                                        {item.isFolder ? (
                                            <button
                                                onClick={() => onNavigate(item)}
                                                className="inline-flex items-center gap-2 text-text hover:text-accent font-medium truncate max-w-full"
                                            >
                                                <Folder className="w-4 h-4 text-accent shrink-0" />
                                                <span className="truncate">{item.name}</span>
                                            </button>
                                        ) : (
                                            <span className="inline-flex items-center gap-2 text-text truncate max-w-full">
                                                <FileIcon className="w-4 h-4 text-muted shrink-0" />
                                                <span className="truncate">{item.name}</span>
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-muted text-xs">
                                        {item.isFolder ? '—' : formatBytes(item.size)}
                                    </td>
                                    <td className="px-4 py-3 text-muted text-xs">{formatDate(item.updatedAt)}</td>
                                    {!readOnly && (
                                        <td className="px-4 py-3 text-xs">
                                            {item.expiresAt ? (
                                                <span className="text-warning" title={new Date(item.expiresAt).toLocaleString()}>
                                                    {formatTimeUntil(item.expiresAt)}
                                                    {/* Naming the folder it came from, so an inherited deadline doesn't
                                                        look like something set on this item. */}
                                                    {item.expiresFrom && <span className="text-muted-2"> · {item.expiresFrom}</span>}
                                                </span>
                                            ) : <span className="text-muted-2">never</span>}
                                        </td>
                                    )}
                                    <td className="px-4 py-3 text-right whitespace-nowrap">
                                        {!item.isFolder && item.canPreview && (
                                            <button
                                                onClick={() => onPreview(item)}
                                                aria-label={`Preview ${item.name}`}
                                                className="text-muted hover:text-text mr-2 inline-flex align-middle"
                                            >
                                                <Eye className="w-4 h-4" />
                                            </button>
                                        )}
                                        {!item.isFolder && (
                                            <button
                                                onClick={() => onDownload(item)}
                                                aria-label={`Download ${item.name}`}
                                                className="text-info hover:brightness-125 mr-2 inline-flex align-middle"
                                            >
                                                <Download className="w-4 h-4" />
                                            </button>
                                        )}
                                        {!readOnly && (
                                            <button
                                                onClick={() => onOpenMenu(item)}
                                                aria-label={`More actions for ${item.name}`}
                                                className="text-muted hover:text-text inline-flex align-middle"
                                            >
                                                <MoreHorizontal className="w-4 h-4" />
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default FileBrowser;

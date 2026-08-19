/**
 * The pure logic behind the file tree: names, the denormalized id-path, and what it implies about
 * ancestry, moves and expiry.
 *
 * Everything here is deliberately free of the database so it can be reasoned about and tested
 * directly — the access decisions in the file routes are only as sound as these functions.
 */

/** Deep enough for any real folder structure; shallow enough that path_ids stays a short string. */
export const MAX_DEPTH = 32;
export const MAX_NAME_LENGTH = 255;

/**
 * Names never become path segments (see FILES_ROOT in paths.js), so this is not a traversal guard.
 * It exists because a name reaches a Content-Disposition header and the DOM, and because '.' / '..'
 * displayed in a folder listing would be actively misleading about what they do.
 */
export const validateName = (name) => {
    if (typeof name !== 'string') return { ok: false, error: 'Name must be text' };

    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Name cannot be empty' };
    if (trimmed === '.' || trimmed === '..') return { ok: false, error: `"${trimmed}" is not a usable name` };
    if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, error: `Name cannot be longer than ${MAX_NAME_LENGTH} characters` };
    if (/[/\\]/.test(trimmed)) return { ok: false, error: 'Name cannot contain / or \\' };
    // Control characters, including the NUL that would truncate a C string and the CR/LF that would
    // otherwise have to be stripped again at the header layer.
    if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, error: 'Name cannot contain control characters' };

    return { ok: true, name: trimmed };
};

/** '/a/b/c/' — always both-ends-slashed, so a prefix test can never match a partial id. */
export const buildPathIds = (parentPathIds, id) => `${parentPathIds || '/'}${id}/`;

/** Every id on the way down to (and including) this node, outermost first. */
export const ancestorIds = (pathIds) => String(pathIds || '').split('/').filter(Boolean);

/** Depth counted the way MAX_DEPTH means it: the root row is depth 0. */
export const depthOf = (pathIds) => Math.max(0, ancestorIds(pathIds).length - 1);

/**
 * Is `node` at or below `maybeAncestor`?
 *
 * The both-ends-slashed invariant is what makes this a safe string test: without the trailing
 * slash, '/root/ab/' would appear to be a prefix of '/root/abc/' and a share of one folder would
 * leak a sibling whose id merely started with the same characters.
 */
export const isAtOrBelow = (nodePathIds, maybeAncestorPathIds) =>
    typeof nodePathIds === 'string' && typeof maybeAncestorPathIds === 'string' &&
    maybeAncestorPathIds.length > 0 && nodePathIds.startsWith(maybeAncestorPathIds);

/**
 * How many levels the node carries beneath it. Callers that know the subtree pass it on the node as
 * `_subtreeDepth`; without it a move is checked as though the node were a leaf, which is correct for
 * a file and optimistic for a folder — the per-descendant depth is re-checked when the subtree's
 * paths are rewritten.
 */
const subtreeDepth = (node) => Number(node._subtreeDepth) || 0;

/**
 * Whether a node may be moved under a destination, and why not if not.
 *
 * Cross-owner moves are refused outright rather than handled: a node owned by one user sitting
 * under another user's folder would mean the folder's owner controls who can read someone else's
 * file, and everyone holding a grant on that folder silently gains it.
 */
export const canMove = (node, destination) => {
    if (!node || !destination) return { ok: false, error: 'Item not found' };
    if (node.id === destination.id) return { ok: false, error: "An item can't be moved into itself" };
    if (!destination.is_folder) return { ok: false, error: 'Destination must be a folder' };
    if (destination.owner_username !== node.owner_username) {
        return { ok: false, error: "An item can't be moved into another user's folder" };
    }
    // The cycle check. Moving a folder into its own subtree would detach that subtree from the root
    // and make the folder its own ancestor.
    if (isAtOrBelow(destination.path_ids, node.path_ids)) {
        return { ok: false, error: "A folder can't be moved into itself" };
    }
    // Already directly in the destination — harmless, but reporting success would imply a change.
    if (node.parent_id === destination.id) return { ok: false, error: 'Item is already there' };

    const newDepth = depthOf(buildPathIds(destination.path_ids, node.id)) + subtreeDepth(node);
    if (newDepth > MAX_DEPTH) return { ok: false, error: `Moving this would nest deeper than ${MAX_DEPTH} folders` };

    return { ok: true };
};

/**
 * Rewrites one node's path when its subtree moves: everything from the old parent prefix onward is
 * replaced, and the node's own id and anything below it keep their relative position.
 */
export const rewritePathIds = (pathIds, oldPrefix, newPrefix) => {
    if (!isAtOrBelow(pathIds, oldPrefix)) return pathIds;
    return newPrefix + pathIds.slice(oldPrefix.length);
};

/**
 * When a node actually disappears, given its own expiry and its ancestors'.
 *
 * The *earliest* wins, so a folder's expiry is a ceiling on everything inside it rather than a
 * default a child can override. The alternative — nearest-set-ancestor, or child-wins — allows a
 * file marked "never" inside a folder expiring next week, which would leave a live file whose parent
 * no longer exists. Returns null when nothing in the chain expires.
 */
export const effectiveExpiry = (chain) => {
    const times = (chain || [])
        .map((n) => n && n.expires_at)
        .filter(Boolean)
        .map((iso) => ({ iso, ms: new Date(iso).getTime() }))
        .filter((t) => !Number.isNaN(t.ms));

    if (!times.length) return null;
    return times.reduce((a, b) => (b.ms < a.ms ? b : a)).iso;
};

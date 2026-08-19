import crypto from 'crypto';
import { db, initDB } from './db.js';
import { buildPathIds, rewritePathIds, canMove, validateName, ancestorIds, depthOf, MAX_DEPTH } from './fileTree.js';

/**
 * Every database operation on the file tree, in one place.
 *
 * The routes above this do request shape and authorization; this does SQL and nothing else. It is
 * split out mainly so the tree operations can be tested against real SQLite rather than a mock —
 * path_ids rewriting, the uniqueness constraint and the quota sum are all things a stubbed db.run
 * would happily pretend to do correctly.
 *
 * Two conventions worth knowing before editing:
 *   · "live" always means deleted_at IS NULL. A trashed node stays in the table (see fileReaper) but
 *     must be invisible to every read except the trash listing itself.
 *   · Results use the house `{ ok, ... }` shape rather than throwing, matching resolveShare and
 *     resolveNasFile, so route handlers stay one-liners.
 */

const nowIso = () => new Date().toISOString();
const ready = async () => { if (!db) await initDB(); };

/**
 * The row every one of a user's items hangs from, created on first use.
 *
 * It exists so parent_id is never NULL for a real item, which is what lets UNIQUE(parent_id, name)
 * actually constrain the top level — SQLite treats NULLs as distinct, so nullable parents would
 * silently allow duplicate names there. Its own name is '' so it can never collide with a real one.
 */
export const ensureRoot = async (owner) => {
    await ready();
    const existing = await db.get(
        "SELECT * FROM file_nodes WHERE owner_username = ? AND parent_id IS NULL", owner
    );
    if (existing) return existing;

    const id = crypto.randomUUID();
    const ts = nowIso();
    await db.run(
        `INSERT INTO file_nodes (id, owner_username, parent_id, name, is_folder, path_ids, created_at, updated_at)
         VALUES (?, ?, NULL, '', 1, ?, ?, ?)`,
        [id, owner, buildPathIds(null, id), ts, ts]
    );
    return db.get("SELECT * FROM file_nodes WHERE id = ?", id);
};

export const getNode = async (id) => {
    await ready();
    if (!id) return undefined;
    return db.get("SELECT * FROM file_nodes WHERE id = ? AND deleted_at IS NULL", id);
};

/** Includes trashed rows — only the trash listing and the reaper should use this. */
export const getNodeIncludingTrashed = async (id) => {
    await ready();
    if (!id) return undefined;
    return db.get("SELECT * FROM file_nodes WHERE id = ?", id);
};

export const listChildren = async (parentId) => {
    await ready();
    return db.all(
        `SELECT * FROM file_nodes WHERE parent_id = ? AND deleted_at IS NULL
          ORDER BY is_folder DESC, name COLLATE NOCASE ASC`,
        parentId
    );
};

/**
 * The node's ancestors, root-first, from path_ids — no recursive query and no walk.
 *
 * Returned in path order rather than whatever order SQLite hands back, because callers use this for
 * a breadcrumb and for effectiveExpiry, and both care about the sequence.
 */
export const ancestorsOf = async (node) => {
    await ready();
    const ids = ancestorIds(node?.path_ids).filter((id) => id !== node.id);
    if (!ids.length) return [];
    const rows = await db.all(
        `SELECT * FROM file_nodes WHERE id IN (${ids.map(() => '?').join(',')})`, ids
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
};

/** Everything at or below the node, including itself. Live rows only. */
export const subtreeOf = async (node) => {
    await ready();
    return db.all(
        "SELECT * FROM file_nodes WHERE path_ids LIKE ? AND deleted_at IS NULL ORDER BY path_ids",
        `${node.path_ids}%`
    );
};

/** Bytes this user is accountable for. Trashed files still count — they are still on disk. */
export const usedBytes = async (owner) => {
    await ready();
    const row = await db.get(
        "SELECT COALESCE(SUM(size), 0) AS total FROM file_nodes WHERE owner_username = ? AND is_folder = 0",
        owner
    );
    return row?.total || 0;
};

const insertNode = async ({ owner, parent, name, isFolder, storageName = null, size = 0, mime = null }) => {
    const id = crypto.randomUUID();
    const ts = nowIso();
    await db.run(
        `INSERT INTO file_nodes
           (id, owner_username, parent_id, name, is_folder, storage_name, size, mime, path_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, owner, parent.id, name, isFolder ? 1 : 0, storageName, size, mime, buildPathIds(parent.path_ids, id), ts, ts]
    );
    return db.get("SELECT * FROM file_nodes WHERE id = ?", id);
};

/**
 * Is there already something with this name in this folder?
 *
 * Checked explicitly rather than relying on the UNIQUE constraint to raise, because the constraint
 * cannot tell a live collision from a trashed one — and a trashed sibling must not block a new file,
 * or deleting something would leave its name reserved for a week.
 */
const liveSibling = async (parentId, name) => db.get(
    "SELECT id FROM file_nodes WHERE parent_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL",
    [parentId, name]
);

/**
 * Creates a folder, refusing a duplicate name.
 *
 * The refusal is the difference between this and ensureFolderPath below: a person clicking "New
 * Folder" needs to be told the name is taken, whereas a folder upload re-sending a directory that
 * already exists needs it to just work.
 */
export const createFolder = async ({ owner, parentId, name }) => {
    await ready();
    const checked = validateName(name);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };

    const parent = await getNode(parentId);
    if (!parent || !parent.is_folder) return { ok: false, status: 404, error: 'Folder not found' };
    if (parent.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };
    if (depthOf(parent.path_ids) + 1 > MAX_DEPTH) {
        return { ok: false, status: 400, error: `Folders cannot nest more than ${MAX_DEPTH} deep` };
    }
    if (await liveSibling(parent.id, checked.name)) {
        return { ok: false, status: 409, error: `"${checked.name}" already exists here` };
    }

    return { ok: true, node: await insertNode({ owner, parent, name: checked.name, isFolder: true }) };
};

/**
 * Walks a relative directory path, creating what's missing and reusing what isn't.
 *
 * This is the folder-upload path: the client dedupes the dirnames of its selection and sends them
 * here once, then uploads each file against the returned leaf id — so the upload route itself never
 * parses a path and the server never trusts a client-supplied hierarchy string beyond its segments.
 */
export const ensureFolderPath = async ({ owner, parentId, segments }) => {
    await ready();
    if (!Array.isArray(segments)) return { ok: false, status: 400, error: 'segments must be an array' };

    let parent = await getNode(parentId);
    if (!parent || !parent.is_folder) return { ok: false, status: 404, error: 'Folder not found' };
    if (parent.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };

    for (const raw of segments) {
        const checked = validateName(raw);
        if (!checked.ok) return { ok: false, status: 400, error: checked.error };
        if (depthOf(parent.path_ids) + 1 > MAX_DEPTH) {
            return { ok: false, status: 400, error: `Folders cannot nest more than ${MAX_DEPTH} deep` };
        }

        const existingId = await liveSibling(parent.id, checked.name);
        const existing = existingId && await getNode(existingId.id);
        if (existing) {
            // A file already holding the name is a genuine conflict — the upload cannot proceed into it.
            if (!existing.is_folder) {
                return { ok: false, status: 409, error: `"${checked.name}" already exists here as a file` };
            }
            parent = existing;
            continue;
        }
        parent = await insertNode({ owner, parent, name: checked.name, isFolder: true });
    }

    return { ok: true, node: parent };
};

export const createFile = async ({ owner, parentId, name, storageName, size, mime }) => {
    await ready();
    const checked = validateName(name);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };

    const parent = await getNode(parentId);
    if (!parent || !parent.is_folder) return { ok: false, status: 404, error: 'Folder not found' };
    if (parent.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };
    if (await liveSibling(parent.id, checked.name)) {
        return { ok: false, status: 409, error: `"${checked.name}" already exists here` };
    }

    return {
        ok: true,
        node: await insertNode({ owner, parent, name: checked.name, isFolder: false, storageName, size, mime }),
    };
};

export const renameNode = async ({ owner, id, name }) => {
    await ready();
    const checked = validateName(name);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };

    const node = await getNode(id);
    if (!node) return { ok: false, status: 404, error: 'Item not found' };
    if (node.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };
    if (!node.parent_id) return { ok: false, status: 400, error: "Your top-level folder can't be renamed" };

    const clash = await liveSibling(node.parent_id, checked.name);
    if (clash && clash.id !== node.id) {
        return { ok: false, status: 409, error: `"${checked.name}" already exists here` };
    }

    // Names are not in path_ids, which is why this is one row and not a subtree rewrite.
    await db.run("UPDATE file_nodes SET name = ?, updated_at = ? WHERE id = ?", [checked.name, nowIso(), id]);
    return { ok: true, node: await getNode(id) };
};

/**
 * Moves one node (and everything under it) into another folder.
 *
 * Reported per item by the bulk caller rather than all-or-nothing: a name collision on one file
 * shouldn't abandon the other forty, and there are no transactions in this codebase to make an
 * all-or-nothing batch meaningful anyway.
 */
export const moveNode = async ({ owner, id, destinationId }) => {
    await ready();
    const node = await getNode(id);
    const destination = await getNode(destinationId);
    if (!node || !destination) return { ok: false, status: 404, error: 'Item not found' };
    if (node.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };
    if (!node.parent_id) return { ok: false, status: 400, error: "Your top-level folder can't be moved" };

    // Deepest descendant relative to this node, so canMove can reject a move that would push the
    // far end of the subtree past the depth cap rather than only checking the node itself.
    const subtree = await subtreeOf(node);
    const nodeDepth = depthOf(node.path_ids);
    const relativeDepth = subtree.reduce((max, r) => Math.max(max, depthOf(r.path_ids) - nodeDepth), 0);

    const verdict = canMove({ ...node, _subtreeDepth: relativeDepth }, destination);
    if (!verdict.ok) return { ok: false, status: 400, error: verdict.error };

    if (await liveSibling(destination.id, node.name)) {
        return { ok: false, status: 409, error: `"${node.name}" already exists in "${destination.name || 'your files'}"` };
    }

    const oldPrefix = node.path_ids;
    const newPrefix = buildPathIds(destination.path_ids, node.id);
    const ts = nowIso();

    await db.run(
        "UPDATE file_nodes SET parent_id = ?, path_ids = ?, updated_at = ? WHERE id = ?",
        [destination.id, newPrefix, ts, node.id]
    );
    // Descendants keep their position relative to the node: everything after the old prefix is
    // preserved verbatim. substr is 1-indexed in SQLite, hence the +1.
    await db.run(
        "UPDATE file_nodes SET path_ids = ? || substr(path_ids, ?) WHERE path_ids LIKE ? AND id != ?",
        [newPrefix, oldPrefix.length + 1, `${oldPrefix}%`, node.id]
    );

    return { ok: true, node: await getNode(id) };
};

/**
 * Moves a node and its subtree to the trash. Nothing is unlinked here — the reaper purges bytes
 * after the grace period, which is what makes an accidental delete recoverable.
 */
export const trashNode = async ({ owner, id }) => {
    await ready();
    const node = await getNode(id);
    if (!node) return { ok: false, status: 404, error: 'Item not found' };
    if (node.owner_username !== owner) return { ok: false, status: 403, error: 'Access Denied' };
    if (!node.parent_id) return { ok: false, status: 400, error: "Your top-level folder can't be deleted" };

    const ts = nowIso();
    const result = await db.run(
        "UPDATE file_nodes SET deleted_at = ?, updated_at = ? WHERE path_ids LIKE ? AND deleted_at IS NULL",
        [ts, ts, `${node.path_ids}%`]
    );
    return { ok: true, trashed: result?.changes ?? 0 };
};

/** What a delete is about to do, so the confirmation can say it rather than guess. */
export const subtreeSummary = async (node) => {
    await ready();
    const row = await db.get(
        `SELECT COUNT(*) AS items,
                COALESCE(SUM(CASE WHEN is_folder = 0 THEN 1 ELSE 0 END), 0) AS files,
                COALESCE(SUM(size), 0) AS bytes
           FROM file_nodes WHERE path_ids LIKE ? AND deleted_at IS NULL`,
        `${node.path_ids}%`
    );
    return { items: row?.items || 0, files: row?.files || 0, bytes: row?.bytes || 0 };
};

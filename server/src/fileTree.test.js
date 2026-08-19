import { describe, it, expect } from 'vitest';
import {
    validateName, buildPathIds, ancestorIds, depthOf, isAtOrBelow,
    canMove, rewritePathIds, effectiveExpiry, MAX_DEPTH, MAX_NAME_LENGTH,
} from './fileTree.js';

const node = (over = {}) => ({
    id: 'n', owner_username: 'ranjan', parent_id: 'root', name: 'thing',
    is_folder: 0, path_ids: '/root/n/', ...over,
});

describe('validateName', () => {
    it('accepts an ordinary name and trims it', () => {
        expect(validateName('  Tax Documents  ')).toEqual({ ok: true, name: 'Tax Documents' });
    });

    it('accepts non-ASCII, which is not a security question here', () => {
        // Names never become path segments, so unicode is just a name — the download layer handles
        // encoding it into a header.
        expect(validateName('résumé 😀.pdf').ok).toBe(true);
    });

    it('rejects the names that would misrepresent what they do', () => {
        for (const n of ['', '   ', '.', '..']) {
            expect(validateName(n).ok, JSON.stringify(n)).toBe(false);
        }
    });

    it('rejects separators and control characters', () => {
        for (const n of ['a/b', 'a\\b', 'a\x00b', 'a\rb', 'a\nb', 'a\x7fb']) {
            expect(validateName(n).ok, JSON.stringify(n)).toBe(false);
        }
    });

    it('caps the length, since nothing else would', () => {
        expect(validateName('a'.repeat(MAX_NAME_LENGTH)).ok).toBe(true);
        expect(validateName('a'.repeat(MAX_NAME_LENGTH + 1)).ok).toBe(false);
    });

    it('rejects a non-string rather than coercing it', () => {
        for (const n of [undefined, null, 42, {}, []]) expect(validateName(n).ok).toBe(false);
    });
});

describe('path_ids', () => {
    it('is slashed at both ends so a prefix test cannot match a partial id', () => {
        expect(buildPathIds('/root/', 'abc')).toBe('/root/abc/');
        expect(buildPathIds(null, 'root')).toBe('/root/');
    });

    it('splits back into the ancestor chain, and counts depth from the root row', () => {
        expect(ancestorIds('/root/a/b/')).toEqual(['root', 'a', 'b']);
        expect(depthOf('/root/')).toBe(0);
        expect(depthOf('/root/a/b/')).toBe(2);
    });

    it('does not treat an id-prefix sibling as a descendant', () => {
        // The whole reason for the trailing slash. Without it '/root/ab/' is a string prefix of
        // '/root/abc/', and a share of one folder would expose an unrelated sibling.
        expect(isAtOrBelow('/root/abc/', '/root/ab/')).toBe(false);
        expect(isAtOrBelow('/root/ab/x/', '/root/ab/')).toBe(true);
        expect(isAtOrBelow('/root/ab/', '/root/ab/')).toBe(true);
    });

    it('never treats an empty prefix as an ancestor of everything', () => {
        expect(isAtOrBelow('/root/a/', '')).toBe(false);
        expect(isAtOrBelow('/root/a/', null)).toBe(false);
    });

    it('rewrites a subtree path by prefix, keeping relative position', () => {
        expect(rewritePathIds('/root/a/b/c/', '/root/a/', '/root/z/')).toBe('/root/z/b/c/');
        // Unrelated paths are returned untouched, so a rewrite loop can pass everything through it.
        expect(rewritePathIds('/root/other/', '/root/a/', '/root/z/')).toBe('/root/other/');
    });
});

describe('canMove', () => {
    const dest = (over = {}) => node({ id: 'd', is_folder: 1, path_ids: '/root/d/', ...over });

    it('allows an ordinary move', () => {
        expect(canMove(node(), dest())).toEqual({ ok: true });
    });

    it('refuses a destination that is not a folder', () => {
        expect(canMove(node(), dest({ is_folder: 0 })).ok).toBe(false);
    });

    it("refuses another user's folder", () => {
        // The hole this closes: the node keeps its owner while its ancestors belong to someone else,
        // so that person's grantees silently gain read access to a file they were never given.
        const r = canMove(node(), dest({ owner_username: 'ashutosh' }));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/another user/);
    });

    it('refuses moving a folder into itself or its own subtree', () => {
        const folder = node({ id: 'f', is_folder: 1, path_ids: '/root/f/' });
        expect(canMove(folder, folder).ok).toBe(false);
        // The cycle case: with a bare parent_id this would be creatable, and an ancestor walk over
        // the result would loop instead of erroring.
        const inside = dest({ id: 'g', path_ids: '/root/f/g/' });
        const r = canMove(folder, inside);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/into itself/);
    });

    it('refuses a move that changes nothing', () => {
        expect(canMove(node({ parent_id: 'd' }), dest()).ok).toBe(false);
    });

    it('refuses a move that would nest past the depth cap', () => {
        const deepPath = '/root/' + Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`).join('/') + '/';
        expect(canMove(node({ _subtreeDepth: 3 }), dest({ path_ids: deepPath })).ok).toBe(false);
    });

    it('reports a missing node or destination rather than throwing', () => {
        expect(canMove(null, dest()).ok).toBe(false);
        expect(canMove(node(), null).ok).toBe(false);
    });
});

describe('effectiveExpiry', () => {
    const at = (iso) => ({ expires_at: iso });

    it('is null when nothing in the chain expires', () => {
        expect(effectiveExpiry([at(null), at(null)])).toBeNull();
        expect(effectiveExpiry([])).toBeNull();
        expect(effectiveExpiry(null)).toBeNull();
    });

    it('takes the earliest, so a folder is a ceiling and not a default', () => {
        // A child marked "never" inside a folder that expires must still expire — otherwise the
        // sweep would delete the parent and leave a live file with no path to it.
        const chain = [at('2026-09-01T00:00:00.000Z'), at(null), at('2026-12-01T00:00:00.000Z')];
        expect(effectiveExpiry(chain)).toBe('2026-09-01T00:00:00.000Z');
    });

    it('ignores an unparseable value instead of returning NaN', () => {
        expect(effectiveExpiry([at('whenever'), at('2026-09-01T00:00:00.000Z')])).toBe('2026-09-01T00:00:00.000Z');
        expect(effectiveExpiry([at('whenever')])).toBeNull();
    });
});

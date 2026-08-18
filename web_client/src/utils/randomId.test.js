import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomId } from './randomId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The shape of `crypto` in a plain-http context: getRandomValues, but no randomUUID. */
const insecureCrypto = () => ({
    getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = i * 7 + 3; // deterministic, not random
        return arr;
    },
});

describe('randomId', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('uses the platform randomUUID when it exists', () => {
        const randomUUID = vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        vi.stubGlobal('crypto', { randomUUID, getRandomValues: () => { throw new Error('should not be reached'); } });
        expect(randomId()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(randomUUID).toHaveBeenCalledTimes(1);
    });

    it('still returns a valid v4 uuid when randomUUID is missing, as over plain http', () => {
        // The regression: this is the context the player crashed in.
        vi.stubGlobal('crypto', insecureCrypto());
        expect(randomId()).toMatch(UUID_V4);
    });

    it('sets the version and variant bits rather than just formatting raw bytes', () => {
        // getRandomValues here yields byte 6 = 45 and byte 8 = 59; masked they must become 4x and 8x.
        vi.stubGlobal('crypto', insecureCrypto());
        const id = randomId();
        expect(id[14]).toBe('4');
        expect('89ab').toContain(id[19]);
    });

    it('falls back to a unique-enough id when Web Crypto is absent entirely', () => {
        vi.stubGlobal('crypto', undefined);
        const a = randomId();
        expect(a).toMatch(/^id-/);
        expect(a).not.toBe(randomId());
    });

    it('does not collide across calls in the real environment', () => {
        const ids = new Set(Array.from({ length: 500 }, randomId));
        expect(ids.size).toBe(500);
    });
});

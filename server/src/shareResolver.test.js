import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbMock = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
vi.mock('./db.js', () => ({ db: dbMock, initDB: vi.fn() }));

const { resolveShare, touchShare } = await import('./shareResolver.js');

describe('resolveShare', () => {
    beforeEach(() => vi.clearAllMocks());

    it('404s an unknown token', async () => {
        dbMock.get.mockResolvedValueOnce(undefined);
        expect(await resolveShare('nope')).toEqual({ ok: false, status: 404, error: 'Link not found' });
    });

    it('404s a revoked share, the same as a nonexistent one', async () => {
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 1, expires_at: null, share_type: 'file', media_path: '/m.mp4' });
        const r = await resolveShare('t');
        expect(r).toEqual({ ok: false, status: 404, error: 'Link not found' });
    });

    it('404s an expired share', async () => {
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: '2000-01-01T00:00:00.000Z', share_type: 'file', media_path: '/m.mp4' });
        const r = await resolveShare('t');
        expect(r.ok).toBe(false);
        expect(r.status).toBe(404);
    });

    it('404s a file share whose media row no longer exists', async () => {
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'file', media_path: '/gone.mp4' });
        dbMock.get.mockResolvedValueOnce(undefined);
        expect((await resolveShare('t')).ok).toBe(false);
    });

    it('404s a file share whose file has since been moved into the vault', async () => {
        // Creation already blocks sharing a vault file — this is the defensive re-check for a
        // file vaulted *after* the share was made, so an old link can't become a bypass.
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'file', media_path: '/m.mp4' });
        dbMock.get.mockResolvedValueOnce({ path: '/m.mp4', is_private: 1 });
        expect((await resolveShare('t')).ok).toBe(false);
    });

    it('resolves a valid file share', async () => {
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'file', media_path: '/m.mp4' });
        dbMock.get.mockResolvedValueOnce({ path: '/m.mp4', is_private: 0, title: 'Movie' });
        expect(await resolveShare('t')).toMatchObject({ ok: true, type: 'file', path: '/m.mp4' });
    });

    it('ignores a requestedPath for a file share — always resolves its own stored path', async () => {
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'file', media_path: '/m.mp4' });
        dbMock.get.mockResolvedValueOnce({ path: '/m.mp4', is_private: 0 });
        const r = await resolveShare('t', '/something/else.mp4');
        expect(r.path).toBe('/m.mp4');
    });

    it('404s a series share with zero non-private episodes', async () => {
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'series', series_name: 'Show' });
        dbMock.all.mockResolvedValueOnce([]);
        expect((await resolveShare('t')).ok).toBe(false);
    });

    it('resolves the live episode list for a series share with no requestedPath', async () => {
        const episodes = [{ path: '/s1e1.mp4', season: 1, episode: 1 }, { path: '/s1e2.mp4', season: 1, episode: 2 }];
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'series', series_name: 'Show' });
        dbMock.all.mockResolvedValueOnce(episodes);
        const r = await resolveShare('t');
        expect(r).toMatchObject({ ok: true, type: 'series', episodes });
        expect(r.media).toBeUndefined();
    });

    it('404s a requestedPath that is not part of the shared series', async () => {
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'series', series_name: 'Show' });
        dbMock.all.mockResolvedValueOnce([{ path: '/s1e1.mp4' }]);
        const r = await resolveShare('t', '/not-in-series.mp4');
        expect(r).toEqual({ ok: false, status: 404, error: 'Episode not part of this share' });
    });

    it('resolves one episode of a series share when requestedPath matches', async () => {
        const episodes = [{ path: '/s1e1.mp4' }, { path: '/s1e2.mp4' }];
        dbMock.get.mockResolvedValueOnce({ token: 't', revoked: 0, expires_at: null, share_type: 'series', series_name: 'Show' });
        dbMock.all.mockResolvedValueOnce(episodes);
        const r = await resolveShare('t', '/s1e2.mp4');
        expect(r).toMatchObject({ ok: true, type: 'series', path: '/s1e2.mp4' });
        expect(r.media).toEqual({ path: '/s1e2.mp4' });
    });
});

describe('touchShare', () => {
    it('increments view_count and stamps last_accessed_at for the given token', async () => {
        dbMock.run.mockResolvedValueOnce({});
        await touchShare('t');
        expect(dbMock.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE shares SET view_count'),
            expect.arrayContaining(['t'])
        );
    });
});

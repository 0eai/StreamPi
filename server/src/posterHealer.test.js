import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbMock = { get: vi.fn(), run: vi.fn() };
vi.mock('./db.js', () => ({ db: dbMock }));

const logMock = vi.fn();
vi.mock('./logger.js', () => ({ log: logMock }));

const extractMetadataMock = vi.fn();
const extractMetadataRemoteMock = vi.fn();
vi.mock('./mediaMetadata.js', () => ({ extractMetadata: extractMetadataMock, extractMetadataRemote: extractMetadataRemoteMock }));

const resolveNasFileMock = vi.fn();
vi.mock('./nasSource.js', () => ({ resolveNasFile: resolveNasFileMock }));

const existsSyncMock = vi.fn();
vi.mock('fs', () => ({ existsSync: existsSyncMock }));

const { runPosterHealer } = await import('./posterHealer.js');

const row = (over = {}) => ({
    path: '/media/Movie.mp4', filename: 'Movie.mp4', poster: null, poster_attempts: 0, duration: 0, ...over,
});

describe('runPosterHealer', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does nothing when there is no candidate', async () => {
        dbMock.get.mockResolvedValueOnce(undefined);
        await runPosterHealer();
        expect(extractMetadataMock).not.toHaveBeenCalled();
        expect(dbMock.run).not.toHaveBeenCalled();
    });

    it('skips permanently (without deleting anything) when the local file is missing', async () => {
        dbMock.get.mockResolvedValueOnce(row());
        existsSyncMock.mockReturnValue(false);

        await runPosterHealer();

        expect(extractMetadataMock).not.toHaveBeenCalled();
        expect(dbMock.run).toHaveBeenCalledWith(
            "UPDATE media SET poster_attempts = ? WHERE path = ?",
            [5, '/media/Movie.mp4']
        );
    });

    it('writes the healed poster and duration on a successful local extraction', async () => {
        dbMock.get.mockResolvedValueOnce(row());
        existsSyncMock.mockReturnValue(true);
        extractMetadataMock.mockResolvedValueOnce({ duration: 120.5, poster: 'Movie.jpg', needsTranscode: false });

        await runPosterHealer();

        expect(dbMock.run).toHaveBeenCalledWith(
            "UPDATE media SET poster = ?, duration = ? WHERE path = ?",
            ['Movie.jpg', 120.5, '/media/Movie.mp4']
        );
    });

    it('increments poster_attempts on a failed local extraction', async () => {
        dbMock.get.mockResolvedValueOnce(row({ poster_attempts: 2 }));
        existsSyncMock.mockReturnValue(true);
        extractMetadataMock.mockResolvedValueOnce({ duration: 0, poster: null, needsTranscode: true });

        await runPosterHealer();

        expect(dbMock.run).toHaveBeenCalledWith(
            "UPDATE media SET poster_attempts = ? WHERE path = ?",
            [3, '/media/Movie.mp4']
        );
    });

    it('logs giving up once attempts reach the cap, but still records the attempt', async () => {
        dbMock.get.mockResolvedValueOnce(row({ poster_attempts: 4 }));
        existsSyncMock.mockReturnValue(true);
        extractMetadataMock.mockResolvedValueOnce({ duration: 0, poster: null, needsTranscode: true });

        await runPosterHealer();

        expect(logMock).toHaveBeenCalledWith(expect.stringContaining('giving up'), 'WARN');
        expect(dbMock.run).toHaveBeenCalledWith(
            "UPDATE media SET poster_attempts = ? WHERE path = ?",
            [5, '/media/Movie.mp4']
        );
    });

    it('leaves poster_attempts untouched when a NAS node is simply offline right now', async () => {
        dbMock.get.mockResolvedValueOnce(row({ path: 'nas://n1/Movie.mp4' }));
        resolveNasFileMock.mockReturnValueOnce({ ok: false, status: 503, error: 'NAS node is offline' });

        await runPosterHealer();

        expect(extractMetadataRemoteMock).not.toHaveBeenCalled();
        expect(dbMock.run).not.toHaveBeenCalled();
    });

    it('heals a NAS-hosted file via extractMetadataRemote', async () => {
        dbMock.get.mockResolvedValueOnce(row({ path: 'nas://n1/Movie.mp4' }));
        resolveNasFileMock.mockReturnValueOnce({ ok: true, url: 'http://n1:4500/file/Movie.mp4', apiKey: 'k1' });
        extractMetadataRemoteMock.mockResolvedValueOnce({ duration: 300, poster: 'Movie.jpg', needsTranscode: false });

        await runPosterHealer();

        expect(extractMetadataRemoteMock).toHaveBeenCalledWith('http://n1:4500/file/Movie.mp4', 'k1', 'Movie.jpg');
        expect(dbMock.run).toHaveBeenCalledWith(
            "UPDATE media SET poster = ?, duration = ? WHERE path = ?",
            ['Movie.jpg', 300, 'nas://n1/Movie.mp4']
        );
    });
});

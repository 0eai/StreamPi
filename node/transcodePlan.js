/**
 * Decides what to do with each stream of a source file, from its ffprobe metadata.
 *
 * Extracted because both /job branches — in-place on a NAS node, and download-then-transcode — carried
 * a byte-identical copy of it. Two copies of a decision is how one of them ends up fixed and the other
 * does not, and this exact function had a bug that live testing found: a mandatory `-map 0:a` made
 * ffmpeg exit 234 on any file with no audio track, so every silent video failed to transcode on every
 * path. Now there is one copy, and it is testable without an ffmpeg or an HTTP server.
 */

// Subtitle codecs mp4 can actually carry once converted to mov_text. Anything else (PGS, DVB, VOBSUB —
// all bitmap formats) is dropped rather than failing the whole remux.
const SAFE_SUBTITLES = ['mov_text', 'subrip', 'ass', 'ssa', 'webvtt'];

export const planTranscode = (streams = []) => {
    /**
     * The trailing `?` on the audio map is load-bearing: it makes the map optional. Without it ffmpeg
     * refuses to start when nothing matches — "Stream map '0:a' matches no streams. To ignore this, add
     * a trailing '?'" — and exits 234 before writing a frame. Screen recordings, CCTV footage, renders
     * with sound disabled and 4K test clips all hit that.
     *
     * The video map stays mandatory on purpose. A file with no video stream is not something to quietly
     * produce an audio-only mp4 for; failing loudly is the better answer.
     */
    const mapOptions = ['-map 0:v:0', '-map 0:a?'];

    let isVideoH264 = false;
    let hasAudio = false;
    let isAllAudioAAC = true;
    let subtitleCount = 0;

    for (const stream of streams) {
        if (stream.codec_type === 'video' && stream.codec_name === 'h264') isVideoH264 = true;
        if (stream.codec_type === 'audio') {
            hasAudio = true;
            if (stream.codec_name !== 'aac') isAllAudioAAC = false;
        }
        if (stream.codec_type === 'subtitle' && SAFE_SUBTITLES.includes(stream.codec_name)) {
            mapOptions.push(`-map 0:${stream.index}`);
            subtitleCount += 1;
        }
    }

    // No audio at all counts as "nothing to re-encode", so the caller copies rather than inventing an
    // aac stream from silence. Without this the flag would still read false from its initial value only
    // by luck of the loop never running.
    if (!hasAudio) isAllAudioAAC = true;

    return { mapOptions, isVideoH264, hasAudio, isAllAudioAAC, subtitleCount };
};

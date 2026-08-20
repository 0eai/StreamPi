import { describe, it, expect } from 'vitest';
import { planTranscode } from './transcodePlan.js';

/**
 * These correspond to files that were actually run through both nodes: an h264+aac .mov (copy both), a
 * VP8+Vorbis .webm (re-encode both), and a silent 4K h264 .mkv — which failed on every transcode path
 * until the audio map became optional, because ffmpeg exits 234 rather than starting when a map matches
 * nothing.
 */

const video = (codec_name, index = 0) => ({ index, codec_type: 'video', codec_name });
const audio = (codec_name, index = 1) => ({ index, codec_type: 'audio', codec_name });
const subtitle = (codec_name, index = 2) => ({ index, codec_type: 'subtitle', codec_name });

describe('planTranscode', () => {
    it('keeps the audio map optional, so a silent file can transcode at all', () => {
        // The bug: '-map 0:a' with no audio stream is a hard ffmpeg failure, not an empty selection.
        const plan = planTranscode([video('h264')]);
        expect(plan.mapOptions).toContain('-map 0:a?');
        expect(plan.mapOptions).not.toContain('-map 0:a');
    });

    it('keeps the video map mandatory, so an audio-only file fails loudly', () => {
        // Quietly producing an audio-only "video" is worse than refusing.
        expect(planTranscode([audio('aac')]).mapOptions).toContain('-map 0:v:0');
        expect(planTranscode([audio('aac')]).mapOptions).not.toContain('-map 0:v:0?');
    });

    it('treats a silent file as needing no audio re-encode', () => {
        // 4K h264 .mkv, no audio: video copied, container remuxed, nothing invented for the audio.
        const plan = planTranscode([video('h264')]);
        expect(plan).toMatchObject({ isVideoH264: true, hasAudio: false, isAllAudioAAC: true, subtitleCount: 0 });
    });

    it('copies both streams for h264 + aac', () => {
        // The .mov: nothing to do but change container.
        expect(planTranscode([video('h264'), audio('aac')]))
            .toMatchObject({ isVideoH264: true, hasAudio: true, isAllAudioAAC: true });
    });

    it('re-encodes both streams for vp8 + vorbis', () => {
        // The .webm: this is the case that actually exercises the hardware encoder.
        expect(planTranscode([video('vp8'), audio('vorbis')]))
            .toMatchObject({ isVideoH264: false, hasAudio: true, isAllAudioAAC: false });
    });

    it('re-encodes audio when any one track is not aac', () => {
        // A stray AC3 commentary track forces the audio path even though the first track is fine —
        // and the video is still copied, which is the point of deciding per stream.
        const plan = planTranscode([video('h264'), audio('aac', 1), audio('ac3', 2)]);
        expect(plan.isAllAudioAAC).toBe(false);
        expect(plan.isVideoH264).toBe(true);
    });

    it('carries text subtitles through, by index', () => {
        const plan = planTranscode([video('h264'), audio('aac'), subtitle('subrip', 2)]);
        expect(plan.mapOptions).toContain('-map 0:2');
        expect(plan.subtitleCount).toBe(1);
    });

    it('drops bitmap subtitles rather than failing the whole remux', () => {
        // PGS/DVB/VOBSUB cannot become mov_text, and mapping them would fail the output.
        const plan = planTranscode([video('h264'), audio('aac'), subtitle('hdmv_pgs_subtitle', 2), subtitle('dvd_subtitle', 3)]);
        expect(plan.subtitleCount).toBe(0);
        expect(plan.mapOptions).toEqual(['-map 0:v:0', '-map 0:a?']);
    });

    it('keeps several text subtitle tracks', () => {
        const plan = planTranscode([video('h264'), audio('aac'), subtitle('subrip', 2), subtitle('ass', 3)]);
        expect(plan.subtitleCount).toBe(2);
        expect(plan.mapOptions).toEqual(['-map 0:v:0', '-map 0:a?', '-map 0:2', '-map 0:3']);
    });

    it('survives metadata with no streams at all', () => {
        // ffprobe on a truncated download can return this; it must not throw before the encode fails.
        expect(() => planTranscode([])).not.toThrow();
        expect(() => planTranscode()).not.toThrow();
    });
});

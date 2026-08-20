import path from 'path';
import { existsSync, statSync, unlinkSync, renameSync } from 'fs';
import ffmpeg from 'fluent-ffmpeg';

/**
 * Picks a poster frame that actually shows something.
 *
 * The previous approach took whatever single frame sat at exactly 10% of the runtime. For Assi (2026)
 * that is 12:43, in the middle of a dark scene, and the result was a 1.2 KB near-black JPEG — served
 * correctly, and on a dark card indistinguishable from having no poster at all. That is not a rare
 * case: 10% into a film is often a fade, a night scene, or titles over black.
 *
 * Two changes, both measured against that file over the real tunnel:
 *
 *   - ffmpeg's `thumbnail` filter instead of a bare frame grab. It scores a batch of frames and picks
 *     the least like the batch average, which is precisely the "don't hand me a blank" heuristic.
 *     At the same 10% offset it took the JPEG from 1,248 to 4,501 bytes.
 *   - More than one candidate offset. That stretch of that film is dark whatever frame you pick, so no
 *     single-offset strategy saves it; 25% gave a clear street scene at 8,162 bytes.
 *
 * Encoded size is the signal for "is there anything here", which is crude but free and turned out to
 * discriminate cleanly: black frames land near 1.2 KB and real ones at 4–10 KB, at the 320px width every
 * thumbnail here uses. Doing it properly would mean a second decode pass per candidate to measure
 * luma, for a judgement this makes correctly.
 *
 * Always produces something if any candidate succeeded — the largest one — so a genuinely dark film
 * still gets its best available frame rather than nothing.
 */

// Calibrated for 320px-wide JPEGs. Anything at or below this is a blank or near-blank frame.
const BLANK_JPEG_BYTES = 2500;

// 10% keeps the original intent (past titles, into the film). The later two exist because one offset is
// not enough, and are spread out so they are unlikely to share a scene.
const CANDIDATE_FRACTIONS = [0.10, 0.25, 0.5];

// Per-attempt, because fluent-ffmpeg has no timeout of its own and a node that accepts the connection
// then goes quiet would otherwise wedge this — and with it the archiver and the Telegram queue, which
// await the caller. Measured at 0.2-0.5s per attempt over the real tunnel, so this is generous.
const ATTEMPT_TIMEOUT_MS = 20000;

const grabOne = (source, seconds, outPath, inputOptions) => new Promise((resolve) => {
    const cmd = ffmpeg(source);
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { try { cmd.kill('SIGKILL'); } catch (e) {} finish(false); }, ATTEMPT_TIMEOUT_MS);
    if (inputOptions?.length) cmd.inputOptions(inputOptions);
    // seekInput, not an output seek: this puts -ss before -i so ffmpeg jumps via a byte-range request
    // instead of decoding from the start, which over a network is the difference between a second and
    // several minutes.
    cmd.seekInput(seconds)
        .outputOptions(['-frames:v 1', '-vf', 'thumbnail=100,scale=320:-1'])
        .on('error', () => finish(false))
        .on('end', () => finish(true))
        .save(outPath);
});

/**
 * `duration` may be 0 when probing failed; a short fixed ladder is then better than nothing, and a
 * fixed 5s beats seeking to 0 which on many films is pure black.
 */
export const extractPosterFrame = async ({ source, duration, thumbFolder, thumbName, inputOptions = [] }) => {
    const finalPath = path.join(thumbFolder, thumbName);
    const offsets = duration > 0
        ? CANDIDATE_FRACTIONS.map((f) => Math.max(1, Math.floor(duration * f)))
        : [5];

    let best = null;
    for (const [i, seconds] of offsets.entries()) {
        const attemptPath = `${finalPath}.try${i}`;
        const ok = await grabOne(source, seconds, attemptPath, inputOptions);
        if (!ok || !existsSync(attemptPath)) continue;

        const size = statSync(attemptPath).size;
        if (!best || size > best.size) {
            if (best) { try { unlinkSync(best.path); } catch (e) {} }
            best = { path: attemptPath, size };
        } else {
            try { unlinkSync(attemptPath); } catch (e) {}
        }

        // Good enough — stop paying for more network seeks.
        if (best.size > BLANK_JPEG_BYTES) break;
    }

    if (!best) return false;
    try {
        renameSync(best.path, finalPath);
        return true;
    } catch (e) {
        try { unlinkSync(best.path); } catch (e2) {}
        return false;
    }
};

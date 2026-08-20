import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { HW_CONFIG } from './state.js';
import { CFG } from './config.js';

// ==========================================
// HARDWARE DETECTION (transcoder role only)
// ==========================================

/**
 * Teaches fluent-ffmpeg that `lavfi` exists, on ffmpeg builds where it cannot see it.
 *
 * fluent-ffmpeg parses `ffmpeg -formats` with a regexp accounting for the Demux and Mux flag columns
 * only: /^\s*([D ])([E ])\s+([^ ]+)\s+(.*)$/. Newer ffmpeg adds a third "device" column, so lavfi
 * prints as `D d lavfi` — after `D`, the `([E ])` group takes the space and `\s+` then meets a
 * literal `d`, and the line fails to match at all. fluent-ffmpeg concludes lavfi does not exist and
 * rejects with "Input format lavfi is not available" *before spawning ffmpeg*.
 *
 * lavfi is how every probe below synthesizes its test clip, so this blocks all of them — including
 * the libx264 check, which is what made it look like missing hardware, or a missing ffmpeg, rather
 * than a parsing bug. On an older build the same lavfi line has no device column, matches fine, and
 * this is a no-op — which is why it reproduced only on the Mac.
 *
 * getAvailableFormats hands back the very object it caches (`cache.formats = data`), so mutating this
 * one result fixes it for the process without patching anything under node_modules — it survives an
 * npm install. Diagnosed on the Mac node by the repo owner; the alternative of spawning ffmpeg
 * directly for the probe would dodge the gate entirely, but then the probe would stop exercising the
 * same code path a real job takes, which is most of what makes it worth running.
 */
const patchLavfiFormat = () => new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err, formats) => {
        if (formats && !formats.lavfi) {
            formats.lavfi = { canDemux: true, canMux: false, description: 'Libavfilter virtual input device' };
        }
        // Deliberately never rejects: if ffmpeg cannot be run at all, that is not this function's
        // problem to report — every probe then fails and detectHardware says so precisely.
        resolve();
    });
});

/** The device VAAPI needs named explicitly; absent on machines with no Intel/AMD render node. */
const VAAPI_DEVICE = '/dev/dri/renderD128';

/**
 * Probes one encoder by actually encoding a second of video with it.
 *
 * Takes the same option sets a real job would use, because several encoders only work *with* them:
 * VAAPI needs its device named before the input and `-vf format=nv12,hwupload` after it, and probing
 * the bare codec name reports it as unavailable on hardware where it works fine.
 */
const testEncoder = (encoderName, inputOptions = [], outputOptions = []) => new Promise((resolve) => {
    const command = ffmpeg().input('color=c=black:s=640x480:d=1').inputFormat('lavfi');
    if (inputOptions.length) command.inputOptions(inputOptions);
    command.noAudio().videoCodec(encoderName);
    if (outputOptions.length) command.outputOptions(outputOptions);
    command.outputFormat('null').output('-')
        .on('end', () => resolve(true)).on('error', () => resolve(false)).run();
});

export const detectHardware = async () => {
    console.log("🔍 Detecting Hardware Capabilities...");
    await patchLavfiFormat();
    const encoders = [
        { name: 'h264_nvenc', desc: 'NVIDIA GPU (NVENC)', opts: ['-preset p4', '-rc constqp', '-qp 26', '-pix_fmt yuv420p', '-movflags +faststart'] },
        { name: 'h264_nvv4l2enc', desc: 'NVIDIA Jetson (Tegra)', opts: ['-b:v 4M', '-pix_fmt yuv420p', '-movflags +faststart'] },
        { name: 'h264_v4l2m2m', desc: 'Raspberry Pi Hardware', opts: ['-b:v 3M', '-pix_fmt yuv420p', '-movflags +faststart'] },
        { name: 'h264_videotoolbox', desc: 'Apple (VideoToolbox)', opts: ['-q:v 60', '-pix_fmt yuv420p', '-movflags +faststart'] },
        // Gated on the device existing so this stays a no-op where there is no render node — the
        // Pi, for instance. Passed as an input option because ffmpeg parses it before the input.
        {
            name: 'h264_vaapi', desc: 'Intel/AMD VAAPI',
            inOpts: fs.existsSync(VAAPI_DEVICE) ? [`-vaapi_device ${VAAPI_DEVICE}`] : null,
            opts: ['-vf format=nv12,hwupload', '-qp 26', '-movflags +faststart'],
        }
    ];
    // A pin skips detection entirely. Worth having because detection is a one-shot boot-time probe
    // whose result can depend on things outside this process — VAAPI access is often granted by a
    // logind ACL, so an otherwise identical machine answers differently depending on whether anyone
    // is signed in at the console. A pin makes the encoder a decision rather than a discovery.
    const pinned = CFG.encoder && CFG.encoder !== 'auto'
        ? encoders.find((e) => e.name === CFG.encoder)
        : null;
    if (CFG.encoder && CFG.encoder !== 'auto' && !pinned && CFG.encoder !== 'libx264') {
        console.log(`⚠️  Unknown encoder "${CFG.encoder}" pinned in node_config.json — detecting instead.`);
    }
    if (CFG.encoder === 'libx264') {
        console.log("📌 Pinned to CPU software encoding (libx264).");
        return;
    }
    if (pinned) {
        // Still probed, because a pin that silently doesn't work would fail every job instead.
        process.stdout.write(`   📌 Pinned ${pinned.desc} (${pinned.name})... `);
        if (await testEncoder(pinned.name, pinned.inOpts || [], pinned.opts)) {
            console.log("✅ WORKING!");
            Object.assign(HW_CONFIG, { encoder: pinned.name, inputOptions: pinned.inOpts || [], options: pinned.opts, description: pinned.desc });
            return;
        }
        console.log("❌ NOT AVAILABLE — falling back to detection");
    }

    for (const enc of encoders) {
        process.stdout.write(`   👉 Testing ${enc.desc} (${enc.name})... `);
        if (await testEncoder(enc.name, enc.inOpts || [], enc.opts)) {
            console.log("✅ WORKING!");
            Object.assign(HW_CONFIG, { encoder: enc.name, inputOptions: enc.inOpts || [], options: enc.opts, description: enc.desc });
            return;
        }
        console.log("❌ Failed/Not Available");
    }

    /**
     * Every hardware probe failing has two very different causes, and they were reported identically.
     *
     * One is ordinary: a machine with no supported GPU, where libx264 is the right answer. The other
     * is that ffmpeg cannot be run at all — and then the CPU "fallback" is not a fallback, because
     * that path needs the same binary. The node went on advertising "CPU Software Encoding" and
     * accepting jobs it had no way to perform, and the dashboard showed nothing amiss.
     *
     * Found on the Mac node: `h264_videotoolbox` encoded fine in a shell there while every probe
     * failed. This check is what made that diagnosable rather than looking like absent hardware —
     * the cause turned out to be the lavfi format-list parsing handled above, not a missing binary,
     * but "everything failed" still needs to be distinguishable from "no GPU here" whatever the
     * reason. One extra probe, only in the already-failing case, tells the two apart.
     */
    if (await testEncoder('libx264', [], ['-preset ultrafast'])) {
        console.log("⚠️  No GPU detected. Falling back to CPU.");
        return;
    }

    Object.assign(HW_CONFIG, { description: 'ffmpeg unavailable — transcoding will fail' });
    console.error("❌ ffmpeg could not encode with libx264 either — it is missing, not executable, or built without it.");
    console.error("   Transcode jobs sent to this node will fail. Set FFMPEG_PATH and FFPROBE_PATH to");
    console.error("   absolute paths if ffmpeg is not on this process's PATH (a login shell's PATH is not");
    console.error("   the one a launchd/systemd/pm2-at-boot process gets).");
};

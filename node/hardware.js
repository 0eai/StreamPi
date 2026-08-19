import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { HW_CONFIG } from './state.js';
import { CFG } from './config.js';

// ==========================================
// HARDWARE DETECTION (transcoder role only)
// ==========================================

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
    console.log("⚠️  No GPU detected. Falling back to CPU.");
};

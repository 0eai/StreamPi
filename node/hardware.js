import ffmpeg from 'fluent-ffmpeg';
import { HW_CONFIG } from './state.js';

// ==========================================
// HARDWARE DETECTION (transcoder role only)
// ==========================================
const testEncoder = (encoderName) => new Promise((resolve) => {
    ffmpeg().input('color=c=black:s=640x480:d=1').inputFormat('lavfi').noAudio().videoCodec(encoderName).outputFormat('null').output('-')
        .on('end', () => resolve(true)).on('error', () => resolve(false)).run();
});

export const detectHardware = async () => {
    console.log("🔍 Detecting Hardware Capabilities...");
    const encoders = [
        { name: 'h264_nvenc', desc: 'NVIDIA GPU (NVENC)', opts: ['-preset p4', '-rc constqp', '-qp 26', '-pix_fmt yuv420p', '-movflags +faststart'] },
        { name: 'h264_nvv4l2enc', desc: 'NVIDIA Jetson (Tegra)', opts: ['-b:v 4M', '-pix_fmt yuv420p', '-movflags +faststart'] },
        { name: 'h264_v4l2m2m', desc: 'Raspberry Pi Hardware', opts: ['-b:v 3M', '-pix_fmt yuv420p', '-movflags +faststart'] },
        { name: 'h264_videotoolbox', desc: 'Apple (VideoToolbox)', opts: ['-q:v 60', '-pix_fmt yuv420p', '-movflags +faststart'] },
        { name: 'h264_vaapi', desc: 'Intel/AMD VAAPI', opts: ['-vf format=nv12,hwupload', '-qp 26', '-movflags +faststart'] }
    ];
    for (const enc of encoders) {
        process.stdout.write(`   👉 Testing ${enc.desc} (${enc.name})... `);
        if (await testEncoder(enc.name)) { console.log("✅ WORKING!"); Object.assign(HW_CONFIG, { encoder: enc.name, options: enc.opts, description: enc.desc }); return; }
        console.log("❌ Failed/Not Available");
    }
    console.log("⚠️  No GPU detected. Falling back to CPU.");
};

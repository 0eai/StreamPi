// Helper function to detect device (you can put this outside component)
export const getDeviceInfo = () => {
    const ua = navigator.userAgent;
    let device = "Unknown Device";
    let type = "Web Browser";

    if (/android/i.test(ua)) { device = "Android Device"; type = "Mobile"; }
    else if (/iPad|iPhone|iPod/.test(ua)) { device = "iOS Device"; type = "Mobile"; }
    else if (/windows/i.test(ua)) { device = "Windows PC"; type = "Desktop"; }
    else if (/macintosh/i.test(ua)) { device = "Mac"; type = "Desktop"; }
    else if (/linux/i.test(ua)) { device = "Linux PC"; type = "Desktop"; }
    else if (/CrOS/.test(ua)) { device = "Chrome OS"; type = "Desktop"; }
    else if (/TV|SmartTV|Tizen|Web0S/.test(ua)) { device = "Smart TV"; type = "TV"; }

    return { device, type };
};

export const getBrowserCodecs = () => {
    const videoElement = document.createElement('video');
    const codecs = [];

    // Check Video Codecs
    if (videoElement.canPlayType('video/mp4; codecs="avc1.42E01E"')) codecs.push('h264');
    if (videoElement.canPlayType('video/mp4; codecs="hev1"')) codecs.push('hevc');
    if (videoElement.canPlayType('video/webm; codecs="vp9"')) codecs.push('vp9');
    if (videoElement.canPlayType('video/mp4; codecs="av01"')) codecs.push('av1');

    // Check Audio Codecs
    if (videoElement.canPlayType('audio/mp4; codecs="mp4a.40.2"')) codecs.push('aac');
    if (videoElement.canPlayType('audio/mp3')) codecs.push('mp3');
    // AC3/EAC3 often supported by Edge/Safari but not Chrome/Firefox
    // We can optimistically include them if userAgent suggests Edge/Safari, or let FFmpeg transcoding handle it if playback fails (advanced).
    // For now, let's stick to reliable checks.

    return codecs.join(',');
};

// The /job handler used to treat every failure identically — log, mark failed, stop —
// whether it was a one-off network blip on the download/delivery step or a genuinely
// corrupt input ffmpeg can never transcode. Retrying the latter just wastes time before
// failing identically, so only network-shaped errors get retried. Pulled into its own module
// (rather than living inline in routes/transcoder.js) so this logic is cheap to unit-test in
// isolation, per the original audit's own suggestion.
export const isTransientNetworkError = (e) => {
    const code = e?.code || e?.cause?.code;
    if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) return true;
    if (e?.response?.status >= 500) return true;
    // curl exit codes: 6=couldn't resolve host, 7=couldn't connect, 28=timeout,
    // 52=empty reply, 56=recv failure — see `man curl` EXIT CODES. Anything else
    // (e.g. curl missing, ENOENT) is a config/environment problem, not a network blip.
    const curlMatch = /cURL upload failed with code (\d+)/.exec(e?.message || '');
    if (curlMatch && ['6', '7', '28', '52', '56'].includes(curlMatch[1])) return true;
    return false;
};

export const withTransientRetry = async (fn, { attempts = 3, baseDelayMs = 2000, label = 'Operation' } = {}) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt >= attempts || !isTransientNetworkError(e)) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.warn(`⚠️ ${label} failed (attempt ${attempt}/${attempts}, transient: ${e.message}) — retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
};

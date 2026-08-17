// Shared by CredentialsModal.jsx and ShareModal.jsx. navigator.clipboard is only available in
// secure contexts (HTTPS or localhost) — this app is very often reached over plain http://<lan-ip>,
// so the execCommand fallback below is the common path here, not a rare edge case.
export const copyToClipboard = (text) => {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
            resolve();
        } catch (e) {
            reject(e);
        } finally {
            document.body.removeChild(textarea);
        }
    });
};

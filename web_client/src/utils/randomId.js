// crypto.randomUUID() exists only in secure contexts (HTTPS or localhost), and this app is very
// often reached over plain http://<lan-ip> — where the property is simply absent, so calling it
// throws "crypto.randomUUID is not a function". In CustomVideoPlayer that happened during render,
// which the ErrorBoundary caught as a blank screen: over plain HTTP the player could not open at all.
//
// Exactly the trap utils/clipboard.js documents for navigator.clipboard, and the one the node
// dashboard's generateLocationId() already sidesteps by hand. Third time, so it gets a helper.
//
// crypto.getRandomValues is NOT secure-context gated, so the usual fallback is still real randomness
// formatted as a v4 UUID; only the last resort trades that away, for a browser without Web Crypto.
export const randomId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

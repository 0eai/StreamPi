// Shared by LoginScreen.jsx (login) and LinkKunjiModal.jsx (linking an existing account) —
// both need the same third-party widget script, loaded at most once per page.
let kunjiScriptPromise = null;

export const loadKunjiScript = () => {
    if (window.kunji) return Promise.resolve();
    if (!kunjiScriptPromise) {
        kunjiScriptPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://kunji.cc/rp.js';
            script.onload = resolve;
            script.onerror = () => { kunjiScriptPromise = null; reject(new Error('Failed to load kunji.cc/rp.js')); };
            document.head.appendChild(script);
        });
    }
    return kunjiScriptPromise;
};

const getApiUrl = () => {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const isHttps = protocol === 'https:';
    const port = isHttps ? '3006' : '3005';
    return `${protocol}//${hostname}:${port}`;
};

export const SERVER_URL = getApiUrl();

// `headers: { 'Authorization': \`Bearer ${token}\` }` was repeated at 40+ call sites across
// the app, each one free to get the shape slightly wrong. `json` is a convenience for the
// equally-repeated `JSON.stringify(...)` + Content-Type pair — pass a plain object and both
// are handled; omit it (or pass `body` directly, e.g. FormData) for anything else.
export const apiFetch = (serverUrl, path, token, { json, headers, ...opts } = {}) => {
    const finalHeaders = { ...headers };
    if (token) finalHeaders['Authorization'] = `Bearer ${token}`;
    let body = opts.body;
    if (json !== undefined) {
        body = JSON.stringify(json);
        finalHeaders['Content-Type'] = 'application/json';
    }
    return fetch(`${serverUrl}${path}`, { ...opts, headers: finalHeaders, body });
};

// The `res.json().catch(() => ({}))`-then-inspect-`.error` idiom, repeated near-verbatim
// across roughly 10 handlers for reading an error body that might not actually be JSON
// (a proxy error page, an empty body on some failure paths).
export const parseJsonSafe = (res) => res.json().catch(() => ({}));

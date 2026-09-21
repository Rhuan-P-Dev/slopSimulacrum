/**
 * api — Thin fetch wrapper for the editor's JSON API.
 *
 * WHY: keeps the HTTP plumbing in one place so app.js focuses on the UI.
 * Every endpoint returns a JSON envelope the UI can inspect for `ok`/`error`.
 */

const BASE = '/api';

/**
 * Resolve a caller-provided path against BASE exactly once.
 * Accepts either the bare subpath ("/vocabulary") or the full API path
 * ("/api/vocabulary") and never doubles the /api prefix.
 * @param {string} url
 * @returns {string}
 */
function resolve(url) {
    return url.startsWith(BASE) ? url : `${BASE}${url}`;
}

/**
 * GET an endpoint.
 * @param {string} url
 * @returns {Promise<Object>}
 */
export async function get(url) {
    const res = await fetch(resolve(url), { headers: { 'content-type': 'application/json' } });
    if (!res.ok) {
        throw new Error(`GET ${resolve(url)} -> ${res.status}`);
    }
    return res.json();
}

/**
 * POST an endpoint with a JSON body.
 * @param {string} url
 * @param {Object} body
 * @returns {Promise<Object>}
 */
export async function post(url, body) {
    const res = await fetch(resolve(url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok && !out?.ok) {
        throw new Error(`${resolve(url)} -> ${res.status}: ${out.error ?? out.message ?? res.statusText}`);
    }
    return out;
}

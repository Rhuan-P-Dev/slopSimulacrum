/**
 * HttpClient — the server's outbound JSON-over-HTTP client.
 *
 * Why this is not `globalThis.fetch` (measured on Node 24.13.1, against a server
 * that holds response headers for 330s):
 *   - the HTTP client under `fetch` abandons a request with no response headers
 *     after ~300s (`UND_ERR_HEADERS_TIMEOUT`, arriving as a bare
 *     `TypeError: fetch failed`), and exposes **no knob** for it — the
 *     `headersTimeout` / `bodyTimeout` request-init options are ignored, and a
 *     longer `AbortController` *or* `AbortSignal.timeout` budget does not move
 *     it (both died at 300.7s). A reasoning model that needs more than 5 minutes
 *     therefore cannot be served, and the caller's `LLM_TIMEOUT_MS` silently
 *     becomes a lie above 300s.
 *   - `node:http` / `node:https` let us set those knobs to 0 (no separate
 *     cutoff) and keep exactly one deadline: the caller's `AbortSignal`, which
 *     then covers connect, headers *and* body.
 *
 * No new dependency (`CR SEC-8`); decision record: `wiki/decisions/llm-transport.md`.
 *
 * Shape: {@link requestJson} is deliberately fetch-shaped —
 * `(url, { method, headers, body, signal })` resolving to
 * `{ ok, status, statusText, json(), text() }` — so the seam's error mapping
 * reads the same as it did over `fetch`. It is not a polyfill: one absolute
 * http(s) URL per call, no redirect following (a 3xx resolves as a non-`ok`
 * response), no cookies, no streaming.
 *
 * @module utils/HttpClient
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/** No separate transport cutoff: the caller's signal is the one deadline. */
const NO_TRANSPORT_TIMEOUT_MS = 0;

/**
 * Builds the `node:http` request options for one JSON call, from fetch-shaped
 * input.
 *
 * Exported so the timeout knobs are pinned by a test: this module exists
 * because a transport timeout silently overrode the caller's budget, and a knob
 * that quietly stopped being set would recreate the same bug invisibly.
 *
 * @param {string} rawUrl - absolute http(s) URL.
 * @param {Object} [init] - the fetch-shaped request init.
 * @param {string} [init.method] - HTTP method; defaults to `POST`.
 * @param {Object} [init.headers] - request headers; an existing
 *   `Content-Length` is honored, not overwritten.
 * @param {string|null} [init.body] - request body, written verbatim.
 * @param {AbortSignal|null} [init.signal] - the caller's deadline; the only
 *   timeout this client applies (`CR E-5`).
 * @returns {Object} `node:http` request options.
 */
export function buildRequestOptions(rawUrl, { method = 'POST', headers = {}, body = null, signal = null } = {}) {
    const target = new URL(rawUrl);
    const outHeaders = { ...headers };

    // node:http does not derive Content-Length for a written body; without it the
    // request goes out chunked, which an OpenAI-compatible server is not
    // required to accept.
    if (typeof body === 'string' && outHeaders['Content-Length'] === undefined) {
        outHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const options = {
        method,
        headers: outHeaders,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        signal,
        // The caller's signal is the deadline. Left at the client defaults these
        // would cut the request off at 60s (headers) / 300s (whole request).
        headersTimeout: NO_TRANSPORT_TIMEOUT_MS,
        requestTimeout: NO_TRANSPORT_TIMEOUT_MS
    };
    if (target.port) {
        options.port = Number(target.port);
    }
    return options;
}

/**
 * Performs one JSON request and resolves with a fetch-shaped response.
 *
 * Rejects with the transport error (`code` and `cause` intact, e.g.
 * `ECONNREFUSED` / `ECONNRESET`), or with the caller's `AbortError` when the
 * signal fires — which is what `LLMController` maps to `LLM_TIMEOUT`.
 *
 * @param {string} rawUrl - absolute http(s) URL.
 * @param {Object} [init] - see {@link buildRequestOptions}.
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, json: Function, text: Function }>}
 *   resolves once the FULL body has been read; `json()` throws `SyntaxError` on
 *   a non-JSON payload, like `Response.json()`.
 */
export function requestJson(rawUrl, init = {}) {
    const target = new URL(rawUrl);
    const options = buildRequestOptions(rawUrl, init);
    const client = target.protocol === 'https:' ? https : http;
    const body = init.body === undefined ? null : init.body;

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };

        const request = client.request(options, (response) => {
            const chunks = [];
            response.setEncoding('utf8');
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('error', fail);
            response.on('end', () => {
                if (settled) {
                    return;
                }
                settled = true;
                const text = chunks.join('');
                const status = typeof response.statusCode === 'number' ? response.statusCode : 0;
                resolve({
                    ok: status >= 200 && status < 300,
                    status,
                    statusText: typeof response.statusMessage === 'string' ? response.statusMessage : '',
                    json: async () => JSON.parse(text),
                    text: async () => text
                });
            });
        });

        request.on('error', fail);
        if (body !== null) {
            request.write(body);
        }
        request.end();
    });
}

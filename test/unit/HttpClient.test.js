/**
 * HttpClient tests — the node:http JSON client behind the LLM seam.
 *
 * Why these tests exist: `globalThis.fetch` applied a ~300s header timeout that
 * no caller could raise, silently overriding `LLM_TIMEOUT_MS`
 * (wiki/decisions/llm-transport.md). So two things are pinned here:
 *   1. the transport sets NO timeout of its own (`headersTimeout: 0`,
 *      `requestTimeout: 0`) — a knob that quietly stops being set would put the
 *      silent ceiling back;
 *   2. the caller's `signal` is what ends the request, and it covers the BODY
 *      too, not just the response headers.
 *
 * Runs against a real `node:http` server on 127.0.0.1 (ephemeral port) — no
 * external network, no provider.
 *
 * @module test/unit/HttpClient
 */

import http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { requestJson, buildRequestOptions } from '../../src/utils/HttpClient.js';

/** Delays headers long enough to prove no short default applies, short enough to stay fast. */
const SLOW_HEADERS_MS = 1200;

const servers = [];

/**
 * Starts a throwaway server and resolves with its absolute URL.
 * @param {Function} handler - the request handler.
 * @returns {Promise<string>}
 */
async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
}

/**
 * A signal that fires after `ms`, built the way LLMController builds it
 * (AbortController + timer) rather than AbortSignal.timeout, so these tests
 * exercise the seam's own deadline shape.
 * @param {number} ms
 * @returns {AbortSignal}
 */
function deadlineSignal(ms) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms).unref?.();
    return controller.signal;
}

/** Reads the request body of an incoming server request. */
function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(chunks.join('')));
    });
}

afterEach(() => {
    for (const server of servers.splice(0)) {
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        server.close();
    }
});

describe('buildRequestOptions', () => {
    it('sets no transport timeout — the caller signal is the only deadline', () => {
        const options = buildRequestOptions('http://localhost:6030/v1/chat/completions', {
            body: '{}',
            signal: deadlineSignal(1000)
        });

        // THE pin: a non-zero value here is the silent 300s/60s ceiling returning.
        expect(options.headersTimeout).toBe(0);
        expect(options.requestTimeout).toBe(0);
        expect(options.signal).toBeTruthy();
    });

    it('splits the url into host, port and path', () => {
        const options = buildRequestOptions('http://127.0.0.1:6030/v1/chat/completions?x=1');

        expect(options.hostname).toBe('127.0.0.1');
        expect(options.port).toBe(6030);
        expect(options.path).toBe('/v1/chat/completions?x=1');
        expect(options.method).toBe('POST');
    });

    it('derives Content-Length so the request is not sent chunked', () => {
        const options = buildRequestOptions('http://h/p', { body: '{"a":1}' });

        expect(options.headers['Content-Length']).toBe(7);
    });

    it('honors a Content-Length the caller set, and sends none without a body', () => {
        expect(buildRequestOptions('http://h/p', { body: 'abc', headers: { 'Content-Length': 99 } })
            .headers['Content-Length']).toBe(99);
        expect(buildRequestOptions('http://h/p').headers).not.toHaveProperty('Content-Length');
    });
});

describe('requestJson', () => {
    it('posts the body and headers, and resolves the full response', async () => {
        let seen = null;
        const url = await serve(async (req, res) => {
            const body = await readBody(req);
            seen = { method: req.method, auth: req.headers.authorization, body };
            res.writeHead(201, { 'content-type': 'application/json' }, { 'x-test': 'ok' });
            res.end('{"choices":[{"message":{"content":"hi"}}]}');
        });

        const response = await requestJson(url, {
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
            body: '{"model":"m"}'
        });

        expect(seen).toEqual({ method: 'POST', auth: 'Bearer token', body: '{"model":"m"}' });
        expect(response.ok).toBe(true);
        expect(response.status).toBe(201);
        expect(response.statusText).toBe('Created');
        await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: 'hi' } }] });
        await expect(response.text()).resolves.toBe('{"choices":[{"message":{"content":"hi"}}]}');
    });

    it('waits past the client header defaults when the caller budget allows it', async () => {
        // The regression this module exists for: a slow first byte must NOT be cut
        // off by a transport default. Scaled to milliseconds — the real case is a
        // reasoning model that needs minutes.
        const url = await serve(async (req, res) => {
            await readBody(req);
            setTimeout(() => {
                if (res.destroyed) {
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"ok":true}');
            }, SLOW_HEADERS_MS).unref();
        });

        const response = await requestJson(url, {
            body: '{}',
            signal: deadlineSignal(SLOW_HEADERS_MS * 4)
        });

        expect(response.ok).toBe(true);
        await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it('resolves a non-2xx as a not-ok response (the seam maps it to LLM_HTTP_ERROR)', async () => {
        const url = await serve((req, res) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"error":"boom"}');
        });

        const response = await requestJson(url, { body: '{}' });

        expect(response.ok).toBe(false);
        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toBe('{"error":"boom"}');
    });

    it('rejects json() on a non-JSON payload, like Response.json() does', async () => {
        const url = await serve((req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html>gateway</html>');
        });

        const response = await requestJson(url, { body: '{}' });

        await expect(response.json()).rejects.toThrow(SyntaxError);
    });

    it('rejects with the transport code when nothing listens', async () => {
        // Bind then close a port so the refusal is real and immediate.
        const deadUrl = await serve(() => {});
        const [host, port] = deadUrl.replace('http://', '').split('/')[0].split(':');
        servers.pop().close();

        await expect(requestJson(`http://${host}:${port}/v1/chat/completions`, { body: '{}' }))
            .rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    it('the caller signal bounds the BODY, not only the headers', async () => {
        // Headers arrive at once, the body never does. A header-only timeout would
        // have resolved and then hung; our single deadline must end it.
        const url = await serve((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"choices":');
        });

        await expect(requestJson(url, { body: '{}', signal: deadlineSignal(150) }))
            .rejects.toThrow();
    });
});

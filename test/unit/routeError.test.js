/**
 * routeError unit tests — the 500 contract, both environment shapes.
 * @module test/unit/routeError
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendRouteError } from '../../src/utils/routeError.js';

/**
 * Minimal Express response stub.
 * @returns {Object} stub with status/json and capture of what was sent
 */
function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
    return res;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('routeError.sendRouteError', () => {
    it('keeps { error, details } outside production (client/test contract)', () => {
        vi.stubEnv('NODE_ENV', 'test');
        const res = makeRes();
        sendRouteError(new Error('boom'), res, 'GET /things');
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'Internal Server Error', details: 'boom' });
    });

    it('omits exception detail in production', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const res = makeRes();
        sendRouteError(new Error('secret internal path'), res, 'GET /things');
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'Internal Server Error' });
        expect(JSON.stringify(res.body)).not.toContain('secret');
    });

    it('survives a thrown non-Error value', () => {
        vi.stubEnv('NODE_ENV', 'test');
        const res = makeRes();
        sendRouteError('plain string', res, 'POST /things');
        expect(res.statusCode).toBe(500);
        expect(res.body.details).toBe('unknown error');
    });
});

/**
 * routeError unit tests — the route-error contract (sendRouteError and
 * sendRouteErrorBody), both environment shapes.
 * @module test/unit/routeError
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendRouteError, sendRouteErrorBody } from '../../src/utils/routeError.js';
import Logger from '../../src/utils/Logger.js';

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

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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

describe('routeError.sendRouteErrorBody', () => {
    it('keeps the caller fields and adds details outside production', () => {
        vi.stubEnv('NODE_ENV', 'test');
        const res = makeRes();
        sendRouteErrorBody(new Error('boom'), res, '/api/world/save', {
            success: false,
            error: { code: 'SAVE_FAILED', message: 'Internal Server Error' },
        });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            success: false,
            error: { code: 'SAVE_FAILED', message: 'Internal Server Error' },
            details: 'boom',
        });
    });

    it('omits details in production and pins the exact save body', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const res = makeRes();
        sendRouteErrorBody(new Error('secret internal path'), res, '/api/world/save', {
            success: false,
            error: { code: 'SAVE_FAILED', message: 'Internal Server Error' },
        });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            success: false,
            error: { code: 'SAVE_FAILED', message: 'Internal Server Error' },
        });
        expect(JSON.stringify(res.body)).not.toContain('secret');
    });

    it('strips a caller-supplied details field (no-leak cannot be opted out)', () => {
        const warnSpy = vi.spyOn(Logger, 'warn');
        vi.stubEnv('NODE_ENV', 'production');
        const resProd = makeRes();
        sendRouteErrorBody(new Error('boom'), resProd, 'Chat', {
            error: 'Chat request failed',
            details: 'CALLER-SECRET',
            code: 'VALIDATION_ERROR',
        }, 400);
        expect(resProd.body.details).toBeUndefined();
        expect(JSON.stringify(resProd.body)).not.toContain('CALLER-SECRET');

        vi.stubEnv('NODE_ENV', 'test');
        const resTest = makeRes();
        sendRouteErrorBody(new Error('boom'), resTest, 'Chat', {
            error: 'Chat request failed',
            details: 'CALLER-SECRET',
            code: 'VALIDATION_ERROR',
        }, 400);
        expect(resTest.body.details).toBe('boom');
        expect(JSON.stringify(resTest.body)).not.toContain('CALLER-SECRET');

        expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('honours the status argument (chat route policy: 400 / 502)', () => {
        vi.stubEnv('NODE_ENV', 'test');
        const res400 = makeRes();
        sendRouteErrorBody(new Error('bad input'), res400, 'Chat', {
            error: 'Chat request failed',
            code: 'VALIDATION_ERROR',
        }, 400);
        expect(res400.statusCode).toBe(400);

        const res502 = makeRes();
        sendRouteErrorBody(new Error('upstream timeout'), res502, 'Chat', {
            error: 'Chat request failed',
            code: 'LLM_TIMEOUT',
        }, 502);
        expect(res502.statusCode).toBe(502);
    });
});

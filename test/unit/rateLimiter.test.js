/**
 * rateLimiter unit tests — the sliding-window, per-key request budget that
 * guards the LLM-backed endpoints (POST /api/chat, POST /api/rooms/:roomId/chat).
 *
 * Express stubs only (no supertest dependency): the middleware is
 * (req, res, next) and every observable effect is a call into the stubs.
 *
 * @module test/unit/rateLimiter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter } from '../../src/utils/rateLimiter.js';

/**
 * Minimal Express request stub.
 * @param {string} [ip]
 * @returns {Object}
 */
function makeReq(ip = '10.0.0.1') {
    return { ip, socket: {} };
}

/**
 * Minimal Express response stub.
 * @returns {Object} stub with status/json/set and capture of what was sent
 */
function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        set(header, value) { this.headers[header] = value; return this; },
    };
    return res;
}

/**
 * Run the middleware against a stub pair.
 * @param {Function} limiter
 * @param {Object} req
 * @param {Object} res
 * @returns {boolean} true when next() was called (request allowed)
 */
function run(limiter, req, res) {
    let nextCalled = false;
    limiter(req, res, () => { nextCalled = true; });
    return nextCalled;
}

describe('rateLimiter', () => {
    // One shared instance per case (the plan's fixed shape: 3 per 1000 ms),
    // reset between cases so no state leaks.
    let limiter;

    beforeEach(() => {
        limiter = createRateLimiter({ windowMs: 1000, max: 3 });
        limiter.reset();
    });

    afterEach(() => {
        limiter.reset();
        vi.useRealTimers();
    });

    it('allows max requests through and rejects the max+1th with 429, Retry-After, and the RATE_LIMITED body', () => {
        let allowed = 0;
        for (let i = 0; i < 3; i += 1) {
            if (run(limiter, makeReq(), makeRes())) {
                allowed += 1;
            }
        }
        expect(allowed).toBe(3);

        const res = makeRes();
        expect(run(limiter, makeReq(), res)).toBe(false);
        expect(res.statusCode).toBe(429);
        expect(res.body).toEqual({
            success: false,
            error: {
                code: 'RATE_LIMITED',
                message: expect.stringContaining('Limit is 3 per 1s'),
            },
        });
        expect(res.headers['Retry-After']).toMatch(/^\d+$/);
        expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
    });

    it('separate limiter instances do not share budget', () => {
        const other = createRateLimiter({ windowMs: 1000, max: 3 });
        // Exhaust the first limiter completely.
        for (let i = 0; i < 3; i += 1) {
            expect(run(limiter, makeReq('10.0.0.1'), makeRes())).toBe(true);
        }
        expect(run(limiter, makeReq('10.0.0.1'), makeRes())).toBe(false);
        // The second limiter sees the same request shape and is untouched.
        expect(run(other, makeReq('10.0.0.1'), makeRes())).toBe(true);
        other.reset();
    });

    it('honours a custom keyGenerator, falling back to req.ip for falsy keys', () => {
        const keyed = createRateLimiter({
            windowMs: 1000,
            max: 3,
            keyGenerator: (req) => req.userId,
        });
        // Exhaust user u1's budget.
        for (let i = 0; i < 3; i += 1) {
            expect(run(keyed, { ip: '10.0.0.1', userId: 'u1' }, makeRes())).toBe(true);
        }
        expect(run(keyed, { ip: '10.0.0.1', userId: 'u1' }, makeRes())).toBe(false);
        // A different derived key does not consume u1's slot.
        expect(run(keyed, { ip: '10.0.0.1', userId: 'u2' }, makeRes())).toBe(true);
        // A falsy key falls back to req.ip: two different IPs stay separate.
        expect(run(keyed, { ip: '10.0.0.2' }, makeRes())).toBe(true);
        expect(run(keyed, { ip: '10.0.0.3' }, makeRes())).toBe(true);
        keyed.reset();
    });

    it('slides the window: half-window still throttles, past the window the request passes again', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

        // Exhaust the window at t=0.
        for (let i = 0; i < 3; i += 1) {
            expect(run(limiter, makeReq(), makeRes())).toBe(true);
        }
        expect(run(limiter, makeReq(), makeRes())).toBe(false);

        // Half the window later: the oldest hit is still inside the window.
        vi.advanceTimersByTime(500);
        expect(run(limiter, makeReq(), makeRes())).toBe(false);

        // Just past the window: the oldest hits age out and a slot frees.
        vi.advanceTimersByTime(501);
        expect(run(limiter, makeReq(), makeRes())).toBe(true);
    });
});

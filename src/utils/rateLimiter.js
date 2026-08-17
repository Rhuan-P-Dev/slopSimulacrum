import Logger from './Logger.js';

/**
 * In-memory per-IP rate limiter with zero external dependencies.
 *
 * Implements a sliding-window ("ring") buffer of request timestamps per client
 * key (IP by default). When a key exceeds `max` requests within the trailing
 * `windowMs`, the request is rejected with 429 before it reaches the handler —
 * so an expensive upstream call (e.g. the LLM) is never attempted while
 * throttled.
 *
 * Exceed response:
 *   429, header `Retry-After: <seconds>`,
 *   body { success: false, error: { code: 'RATE_LIMITED', message } }
 *
 * Memory safety:
 *   The per-key buffer is bounded by `max`. To prevent unbounded growth of the
 *   key map under many distinct clients, idle/expired keys are pruned
 *   opportunistically once the map passes a size threshold. This is a local
 *   dev tool, so a single-process in-memory store is the right trade-off
 *   (no Redis / shared store needed).
 */

/** Maximum number of distinct client keys tracked before a prune pass. */
const MAX_TRACKED_KEYS = 5000;

/**
 * Creates a rate-limit middleware.
 *
 * @param {Object} [options]
 * @param {number} [options.windowMs=60000] - Sliding window length in ms.
 * @param {number} [options.max=20] - Maximum requests allowed per key per window.
 * @param {(req: import('express').Request) => string} [options.keyGenerator] -
 *   Optional function to derive the throttle key. Defaults to the client IP.
 * @param {string} [options.name='rate-limiter'] - Identifier used in log context.
 * @returns {import('express').RequestHandler & { reset: () => void }}
 */
export function createRateLimiter({ windowMs = 60_000, max = 20, keyGenerator = null, name = 'rate-limiter' } = {}) {
	const window = windowMs;
	const limit = max;

	// key -> number[] of request timestamps within the current window.
	const hits = new Map();

	const resolveKey = (req) => {
		if (typeof keyGenerator === 'function') {
			const key = keyGenerator(req);
			if (key) return String(key);
		}
		return req.ip || req.socket?.remoteAddress || 'unknown';
	};

	/**
	 * Drops timestamps that have aged out of the sliding window.
	 * @private
	 */
	const pruneWindow = (timestamps, now) => {
		const cutoff = now - window;
		// Timestamps are appended in order, so expired ones are always a prefix.
		while (timestamps.length > 0 && timestamps[0] <= cutoff) {
			timestamps.shift();
		}
	};

	/**
	 * Removes keys whose windows are empty or fully expired. Called only when the
	 * map grows past MAX_TRACKED_KEYS, so the amortized cost is negligible.
	 * @private
	 */
	const pruneIdleKeys = (now) => {
		if (hits.size < MAX_TRACKED_KEYS) return;
		for (const [key, timestamps] of hits) {
			pruneWindow(timestamps, now);
			if (timestamps.length === 0) {
				hits.delete(key);
			}
		}
	};

	const middleware = (req, res, next) => {
		const now = Date.now();
		pruneIdleKeys(now);

		const key = resolveKey(req);
		let timestamps = hits.get(key);
		if (!timestamps) {
			timestamps = [];
			hits.set(key, timestamps);
		}

		pruneWindow(timestamps, now);

		if (timestamps.length >= limit) {
			// The oldest entry in the window frees a slot first; tell the client
			// how long (in whole seconds) to wait before retrying.
			const oldest = timestamps[0];
			const retryAfterSec = Math.max(1, Math.ceil((oldest + window - now) / 1000));
			Logger.warn(`[${name}] Rate limit exceeded`, { key, windowMs: window, limit });
			res.set('Retry-After', String(retryAfterSec));
			return res.status(429).json({
				success: false,
				error: {
					code: 'RATE_LIMITED',
					message: `Too many requests. Limit is ${limit} per ${Math.round(window / 1000)}s. Retry after ${retryAfterSec}s.`
				}
			});
		}

		timestamps.push(now);
		return next();
	};

	// Test/ops hook: clear all tracked state.
	middleware.reset = () => {
		hits.clear();
	};

	return middleware;
}

export default createRateLimiter;

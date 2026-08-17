import Logger from '../utils/Logger.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

/**
 * Registers chat-related routes with the given Express router.
 *
 * Hardening: every POST /chat passes through an in-memory per-IP rate limiter
 * (20 requests / 60s by default) BEFORE the request reaches the LLM, so an
 * expensive (or slow) model call is never attempted while a client is
 * throttled. See `src/utils/rateLimiter.js`.
 *
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.llmController - LLM controller instance
 */
export function register(router, { llmController }) {
	// Sliding-window limiter: 20 requests per 60s per client IP.
	const chatRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20, name: 'chat-route' });

	router.post('/chat', chatRateLimiter, async (req, res) => {
		const { messages } = req.body;

		if (!messages || !Array.isArray(messages)) {
			return res.status(400).json({
				error: 'Invalid request. "messages" array is required.',
			});
		}

		try {
			const response = await llmController.chat(messages);
			res.json({ response });
		} catch (error) {
			// LLMController throws structured LLMError (with .code) for
			// timeout / HTTP / parse / network failures, and plain Error for
			// invalid input. Map them to consistent structured responses.
			const code = error.code || 'INTERNAL_ERROR';
			const status = code === 'VALIDATION_ERROR' ? 400 : 502;
			Logger.error('Chat endpoint error', { error: error.message, code });
			res.status(status).json({
				error: 'Chat request failed',
				details: error.message,
				code
			});
		}
	});
}

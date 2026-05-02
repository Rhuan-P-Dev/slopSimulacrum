import Logger from '../utils/Logger.js';

/**
 * Registers chat-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.llmController - LLM controller instance
 */
export function register(router, { llmController }) {
	router.post('/chat', async (req, res) => {
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
			Logger.error('Chat endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}
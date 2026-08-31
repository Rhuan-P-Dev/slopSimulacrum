/**
 * Knowledge API Routes — GET /knowledge (knowledge_viewer_spec.md §5).
 *
 * The only injected dependency is the ROOT world-state controller (facade);
 * the route calls the facade's getKnowledge() and never reaches into a
 * sub-controller (facade-only-dependency rule — Public API Only, project rule §2).
 *
 * @module routes/knowledgeRoutes
 */
import Logger from '../utils/Logger.js';

/**
 * Registers the knowledge route with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - The root world-state facade
 *   (the ONLY dependency — the route must never reach into sub-controllers).
 */
export function register(router, { worldStateController }) {
	/**
	 * GET /knowledge
	 * Returns the full knowledge codex (knowledge_viewer_spec.md §3).
	 * 200 envelope: `{ knowledge: <payload> }`.
	 * 500 envelope: `{ error: 'Internal Server Error', details: <message> }`
	 * (same shape as the other read-only routes, for client consistency).
	 */
	router.get('/knowledge', (req, res) => {
		try {
			const knowledge = worldStateController.getKnowledge();
			res.json({ knowledge });
		} catch (error) {
			Logger.error('/knowledge endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}

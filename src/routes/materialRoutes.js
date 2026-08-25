/**
 * Materials API Routes
 * Provides endpoints for material definitions and blueprint compositions.
 *
 * @module routes/materialRoutes
 */
import Logger from '../utils/Logger.js';

/**
 * Registers materials-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export function register(router, { worldStateController }) {
	/**
	 * GET /materials/registry
	 * Returns the material definitions and blueprint compositions.
	 * Static data — served via a registry endpoint (not embedded in mutable state).
	 * Response shape: { materials: { [id]: {...} }, compositions: { [type]: [{ material, fraction, role? }] } }
	 */
	router.get('/materials/registry', (req, res) => {
		try {
			const registry = worldStateController.getMaterialRegistry();
			res.json(registry);
		} catch (error) {
			Logger.error('/materials/registry endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}

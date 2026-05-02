import Logger from '../utils/Logger.js';

/**
 * Registers action capability routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export function register(router, { worldStateController }) {
	/**
	 * GET /action-capabilities
	 * Returns the cached action capability data for all actions.
	 */
	router.get('/action-capabilities', (req, res) => {
		try {
			const capabilities = worldStateController.getCachedCapabilities();
			res.json({ capabilities });
		} catch (error) {
			Logger.error('/action-capabilities endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /action-capabilities/:actionName
	 * Returns the best component for a specific action across all entities.
	 */
	router.get('/action-capabilities/:actionName', (req, res) => {
		try {
			const { actionName } = req.params;
			const bestComponent = worldStateController.getBestComponentForAction(actionName);

			if (!bestComponent) {
				return res.status(404).json({
					error: 'Action not found or no entity can execute it.',
					actionName,
				});
			}

			res.json({ actionName, bestComponent });
		} catch (error) {
			Logger.error('/action-capabilities/:actionName endpoint error', {
				error: error.message,
				actionName,
			});
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /action-capabilities/entity/:entityId
	 * Returns all capability entries for a specific entity across all actions.
	 */
	router.get('/action-capabilities/entity/:entityId', (req, res) => {
		try {
			const { entityId } = req.params;
			const capabilities = worldStateController.getCapabilitiesForEntity(entityId);

			if (capabilities.length === 0) {
				return res.status(404).json({
					error: 'No capabilities found for this entity.',
					entityId,
				});
			}

			res.json({ entityId, capabilities });
		} catch (error) {
			Logger.error('/action-capabilities/entity/:entityId endpoint error', {
				error: error.message,
				entityId,
			});
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /refresh-entity-capabilities
	 * Re-evaluates all action capabilities for a specific entity.
	 */
	router.post('/refresh-entity-capabilities', (req, res) => {
		const { entityId } = req.body;

		if (!entityId) {
			return res.status(400).json({
				error: 'Invalid request. "entityId" is required.',
			});
		}

		try {
			const updatedEntries = worldStateController.reEvaluateEntityCapabilities(entityId);
			res.json({ entityId, updatedEntries });
		} catch (error) {
			Logger.error('/refresh-entity-capabilities endpoint error', {
				error: error.message,
				entityId,
			});
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}
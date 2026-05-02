import Logger from '../utils/Logger.js';

/**
 * Registers action-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 * @param {Object} deps.broadcastService - Broadcast service instance
 */
export function register(router, { worldStateController, broadcastService }) {
	/**
	 * GET /actions
	 * Returns actions. If entityId is provided, returns only actions relevant to that entity.
	 */
	router.get('/actions', (req, res) => {
		try {
			const { entityId } = req.query;

			let actionStatus;
			if (entityId) {
				actionStatus = worldStateController.getActionsForEntity(entityId);
			} else {
				actionStatus = worldStateController.getActionCapabilities();
			}

			res.json({ actions: actionStatus });
		} catch (error) {
			Logger.error('/actions endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /execute-action
	 * Executes an action on an entity.
	 */
	router.post('/execute-action', (req, res) => {
		const { actionName, entityId, params } = req.body;

		if (!actionName || !entityId) {
			return res.status(400).json({
				error: 'Invalid request. "actionName" and "entityId" are required.',
			});
		}

		try {
			worldStateController.expireStaleSelections();

			const result = worldStateController.executeAction(actionName, entityId, params);

			const responseResult = { ...result };
			if (result.success && result.synergy) {
				responseResult.synergyPreview = {
					multiplier: result.synergy.synergyMultiplier,
					finalValue: result.synergy.finalValue,
					capped: result.synergy.capped,
					capKey: result.synergy.capKey,
					contributingComponents: result.synergy.contributingComponents.map((c) => ({
						componentId: c.componentId,
						entityId: c.entityId,
						componentType: c.componentType,
						contribution: c.contribution,
					})),
					summary: result.synergy.summary,
				};
			}

			if (result.success) {
				broadcastService.broadcast();
			}
			res.json({ result: responseResult });
		} catch (error) {
			Logger.error('/execute-action endpoint error', {
				error: error.message,
				actionName,
				entityId,
			});
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}
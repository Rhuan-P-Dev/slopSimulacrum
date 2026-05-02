import Logger from '../utils/Logger.js';

/**
 * Registers synergy-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export function register(router, { worldStateController }) {
	/**
	 * GET /synergy/actions
	 * Returns all actions that have synergy enabled.
	 */
	router.get('/synergy/actions', (req, res) => {
		try {
			const actionsWithSynergy = worldStateController.getActionsWithSynergy();
			res.json({ actionsWithSynergy });
		} catch (error) {
			Logger.error('/synergy/actions endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /synergy/config/:actionName
	 * Returns the synergy configuration for a specific action.
	 */
	router.get('/synergy/config/:actionName', (req, res) => {
		try {
			const { actionName } = req.params;
			const config = worldStateController.getSynergyConfig(actionName);
			res.json({ actionName, synergyConfig: config });
		} catch (error) {
			Logger.error('/synergy/config/:actionName endpoint error', {
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
	 * POST /synergy/preview
	 * Previews synergy computation for an action without executing it.
	 */
	router.post('/synergy/preview', (req, res) => {
		const { actionName, entityId, componentIds, synergyGroups } = req.body;

		if (!actionName || !entityId) {
			return res.status(400).json({
				error: 'Invalid request. "actionName" and "entityId" are required.',
			});
		}

		try {
			const context = {};
			if (componentIds && Array.isArray(componentIds) && componentIds.length > 0) {
				context.providedComponentIds = componentIds;
			}
			if (synergyGroups) {
				context.synergyGroups = synergyGroups;
			}

			const synergyResult = worldStateController.computeSynergy(actionName, entityId, context);
			res.json({ synergyResult });
		} catch (error) {
			Logger.error('/synergy/preview endpoint error', {
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

	/**
	 * POST /synergy/preview-data
	 * Returns action definition, resolved consequence values, and synergy result.
	 */
	router.post('/synergy/preview-data', (req, res) => {
		const { actionName, entityId, componentIds } = req.body;

		if (!actionName || !entityId) {
			return res.status(400).json({
				error: 'Invalid request. "actionName" and "entityId" are required.',
			});
		}

		try {
			const context = {};
			if (componentIds && Array.isArray(componentIds) && componentIds.length > 0) {
				context.providedComponentIds = componentIds;
			}

			const previewData = worldStateController.previewActionData(actionName, entityId, context);
			res.json({ actionPreviewData: previewData });
		} catch (error) {
			Logger.error('/synergy/preview-data endpoint error', {
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
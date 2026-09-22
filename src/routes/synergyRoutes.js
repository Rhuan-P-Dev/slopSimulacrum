import { sendRouteError } from '../utils/routeError.js';

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
			sendRouteError(error, res, '/synergy/actions');
		}
	});

	/**
	 * GET /synergy/config/:actionName
	 * Returns the synergy configuration for a specific action.
	 */
	router.get('/synergy/config/:actionName', (req, res) => {
		const { actionName } = req.params;
		try {
			const config = worldStateController.getSynergyConfig(actionName);
			res.json({ actionName, synergyConfig: config });
		} catch (error) {
			sendRouteError(error, res, '/synergy/config/:actionName');
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
				context.sourceComponentId = componentIds[0].componentId;
			}
			if (synergyGroups) {
				context.synergyGroups = synergyGroups;
			}

			const synergyResult = worldStateController.computeSynergy(actionName, entityId, context);
			res.json({ synergyResult });
		} catch (error) {
			sendRouteError(error, res, '/synergy/preview');
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
				context.sourceComponentId = componentIds[0].componentId;
			}

			const previewData = worldStateController.previewActionData(actionName, entityId, context);
			res.json({ actionPreviewData: previewData });
		} catch (error) {
			sendRouteError(error, res, '/synergy/preview-data');
		}
	});
}
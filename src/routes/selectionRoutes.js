import Logger from '../utils/Logger.js';

/**
 * Registers component selection routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export function register(router, { worldStateController }) {
	/**
	 * POST /select-components
	 * Lock multiple components to a specific action (batch selection).
	 */
	router.post('/select-components', (req, res) => {
		const { actionName, entityId, components } = req.body;

		if (!actionName || !entityId || !components || !Array.isArray(components) || components.length === 0) {
			return res.status(400).json({
				success: false,
				error: 'Invalid request. "actionName", "entityId", and non-empty "components" array are required.',
			});
		}

		try {
			const result = worldStateController.registerSelections(actionName, entityId, components);
			res.json(result);
		} catch (error) {
			Logger.error('/select-components endpoint error', {
				error: error.message,
				actionName,
				entityId,
			});
			res.status(500).json({
				success: false,
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /select-component
	 * Lock a component to a specific action (enforces "one component, one action" rule).
	 */
	router.post('/select-component', (req, res) => {
		const { actionName, entityId, componentId, role } = req.body;

		if (!actionName || !entityId || !componentId || !role) {
			return res.status(400).json({
				success: false,
				error: 'Invalid request. "actionName", "entityId", "componentId", and "role" are required.',
			});
		}

		try {
			const result = worldStateController.registerSelection(actionName, componentId, entityId, role);
			res.json(result);
		} catch (error) {
			Logger.error('/select-component endpoint error', {
				error: error.message,
				actionName,
				entityId,
				componentId,
			});
			res.status(500).json({
				success: false,
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /release-selection
	 * Release (unlock) a component selection.
	 */
	router.post('/release-selection', (req, res) => {
		const { componentId } = req.body;

		if (!componentId) {
			return res.status(400).json({
				success: false,
				error: 'Invalid request. "componentId" is required.',
			});
		}

		try {
			const released = worldStateController.releaseSelection(componentId);
			res.json({ success: true, released });
		} catch (error) {
			Logger.error('/release-selection endpoint error', {
				error: error.message,
				componentId,
			});
			res.status(500).json({
				success: false,
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /selections/:entityId
	 * Get all current component selections for an entity.
	 */
	router.get('/selections/:entityId', (req, res) => {
		const { entityId } = req.params;

		if (!entityId) {
			return res.status(400).json({
				error: 'Invalid request. entityId is required.',
			});
		}

		try {
			const selections = worldStateController.getLockedComponents(entityId);
			res.json(selections);
		} catch (error) {
			Logger.error('/selections/:entityId endpoint error', {
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
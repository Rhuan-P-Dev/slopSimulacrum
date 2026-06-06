import Logger from '../utils/Logger.js';
import IdResolver from '../utils/IdResolver.js';

// TYPED ID MIGRATION: Typed ID validation helper functions
/**
 * Validates that an ID is a typed entity ID (ent-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateEntityId(id, context) {
    if (!IdResolver.isEntityId(id)) {
        return { valid: false, error: `Invalid entityId in ${context}: "${id}". Expected typed ID format "ent-<uuid>".` };
    }
    return { valid: true };
}

/**
 * Validates that an ID is a typed component ID (comp-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateCompId(id, context) {
    if (!IdResolver.isCompId(id)) {
        return { valid: false, error: `Invalid componentId in ${context}: "${id}". Expected typed ID format "comp-<uuid>".` };
    }
    return { valid: true };
}

/**
 * Validates that an ID is a typed item ID (item-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateItemId(id, context) {
    if (!IdResolver.isItemId(id)) {
        return { valid: false, error: `Invalid itemId in ${context}: "${id}". Expected typed ID format "item-<uuid>".` };
    }
    return { valid: true };
}

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

		// TYPED ID MIGRATION: Validate entityId format
		const entityIdValidation = validateEntityId(entityId, 'POST /select-components body');
		if (!entityIdValidation.valid) {
			return res.status(400).json({ success: false, error: entityIdValidation.error });
		}

		// TYPED ID MIGRATION: Validate each component's ID format
		// Accept both comp-* (component IDs) and eq-* (equipped item IDs)
		for (const comp of components) {
			const compId = typeof comp === 'string' ? comp : comp.componentId;
			if (compId) {
				const isCompId = IdResolver.isCompId(compId);
				const isEquippedId = IdResolver.isEquippedId(compId);
				if (!isCompId && !isEquippedId) {
					return res.status(400).json({
						success: false,
						error: `Invalid component ID format: "${compId}". Expected comp-* or eq-* format.`
					});
				}
			}
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

		// TYPED ID MIGRATION: Validate entityId format
		const entityIdValidation = validateEntityId(entityId, 'POST /select-component body');
		if (!entityIdValidation.valid) {
			return res.status(400).json({ success: false, error: entityIdValidation.error });
		}

		// TYPED ID MIGRATION: Validate componentId format
		// Accept both comp-* (component IDs) and eq-* (equipped item IDs)
		const isCompId = IdResolver.isCompId(componentId);
		const isEquippedId = IdResolver.isEquippedId(componentId);
		if (!isCompId && !isEquippedId) {
			return res.status(400).json({
				success: false,
				error: `Invalid component ID format: "${componentId}". Expected comp-* or eq-* format.`
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
		const { componentId, entityId } = req.body;

		if (!componentId) {
			return res.status(400).json({
				success: false,
				error: 'Invalid request. "componentId" is required.',
			});
		}

		// TYPED ID MIGRATION: Validate componentId format
		// Accept both comp-* (component IDs) and eq-* (equipped item IDs)
		const isCompId = IdResolver.isCompId(componentId);
		const isEquippedId = IdResolver.isEquippedId(componentId);
		if (!isCompId && !isEquippedId) {
			return res.status(400).json({
				success: false,
				error: `Invalid component ID format: "${componentId}". Expected comp-* or eq-* format.`
			});
		}

		try {
			const released = worldStateController.releaseSelection(componentId, entityId);
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

		// TYPED ID MIGRATION: Validate entityId format
		const entityIdValidation = validateEntityId(entityId, 'GET /selections/:entityId params');
		if (!entityIdValidation.valid) {
			return res.status(400).json({ error: entityIdValidation.error });
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
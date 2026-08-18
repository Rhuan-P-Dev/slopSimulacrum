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

			// TYPED ID MIGRATION: Validate entityId if provided
			if (entityId) {
				const validation = validateEntityId(entityId, 'GET /actions query');
				if (!validation.valid) {
					return res.status(400).json({ error: validation.error });
				}
			}

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
		const { actionName, entityId, params, queueForRound } = req.body;

		if (!actionName || !entityId) {
			return res.status(400).json({
				error: 'Invalid request. "actionName" and "entityId" are required.',
			});
		}

		// TYPED ID MIGRATION: Validate entityId format
		const entityIdValidation = validateEntityId(entityId, 'POST /execute-action body');
		if (!entityIdValidation.valid) {
			return res.status(400).json({ error: entityIdValidation.error });
		}

		// FEATURE A (spec §5.4) — queuing gate: `queueForRound: true` (additive
		// flag) validates the typed IDs as today, then ENQUEUES the action for
		// the round's resolution instead of executing it immediately. Absent or
		// false → today's exact behavior (backward compatibility guarantee).
		// Rule-level rejections (closed window, full queue, unknown entity/
		// action) follow the project's "rule failure = 200 {result:{success:false, code}}"
		// contract; only malformed input above is 400.
		if (queueForRound === true) {
			try {
				const turnSystem = worldStateController.turnSystemController;
				if (!turnSystem) {
					return res.json({ result: { success: false, code: 'TURNS_DISABLED', error: 'Turn system is not available.' } });
				}
				const q = turnSystem.queueAction(entityId, actionName, params || {}, 'player');
				if (q.success) {
					broadcastService.broadcast();
				}
				return res.status(200).json({ result: q.success
					? { success: true, queued: true, queueId: q.queueId, queue: q.queue }
					: { success: false, code: q.code, error: q.error } });
			} catch (error) {
				Logger.error('/execute-action (queue) endpoint error', { error: error.message, actionName, entityId });
				return res.status(500).json({ error: 'Internal Server Error', details: error.message });
			}
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
					contributingComponents: (result.synergy?.contributingComponents ?? []).map((c) => ({
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
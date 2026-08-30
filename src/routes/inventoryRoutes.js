/**
 * Inventory API Routes
 * Provides endpoints for managing entity inventory.
 *
 * @module routes/inventoryRoutes
 */
import Logger from '../utils/Logger.js';
import IdResolver from '../utils/IdResolver.js';
import { ID_PREFIXES } from '../../shared/IdPrefixes.js';

// TYPED ID MIGRATION: Typed ID validation helper functions
/**
 * Validates that an ID is a typed entity ID (ent-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateEntityId(id, context) {
    if (!IdResolver.isEntityId(id)) {
        return { valid: false, error: `Invalid entityId in ${context}: "${id}". Expected typed ID format "${ID_PREFIXES.ENTITY}<uuid>".` };
    }
    return { valid: true };
}

/**
 * Validates that an ID is a typed component ID (comp-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateCompId(id, context) {
    if (!IdResolver.isCompId(id)) {
        return { valid: false, error: `Invalid componentId in ${context}: "${id}". Expected typed ID format "${ID_PREFIXES.COMPONENT}<uuid>".` };
    }
    return { valid: true };
}

/**
 * Validates that an ID is a typed item ID (item-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateItemId(id, context) {
    if (!IdResolver.isItemId(id)) {
        return { valid: false, error: `Invalid itemId in ${context}: "${id}". Expected typed ID format "${ID_PREFIXES.ITEM}<uuid>".` };
    }
    return { valid: true };
}

/**
 * Registers inventory-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export default function register(router, { worldStateController }) {
	// =========================================================
	// STATIC ROUTES — MUST be registered BEFORE parameterized routes
	// Express matches routes in order; parameterized routes like
	// /:entityId will intercept static paths if registered first.
	// =========================================================

	/**
	 * GET /inventory/registry
	 * Returns the item type definitions (registry) for all item types.
	 */
	router.get('/inventory/registry', (req, res) => {
		try {
			const registry = worldStateController.getItemRegistry();
			res.json({ registry });
		} catch (error) {
			Logger.error('/inventory/registry endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /inventory/holding-cost-registry
	 * Returns the holding cost definitions for all items.
	 */
	router.get('/inventory/holding-cost-registry', (req, res) => {
		try {
			const registry = worldStateController.getHoldingCostRegistry();
			res.json({ registry });
		} catch (error) {
			Logger.error('/inventory/holding-cost-registry endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	// =========================================================
	// PARAMETERIZED ROUTES — registered AFTER static routes
	// =========================================================

	/**
	 * GET /inventory/:entityId
	 * Returns the entity's inventory items grouped by host component.
	 */
	router.get('/inventory/:entityId', (req, res) => {
		try {
			const { entityId } = req.params;
			
			// TYPED ID MIGRATION: Validate entityId format
			const entityIdValidation = validateEntityId(entityId, 'GET /inventory/:entityId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}

			const items = worldStateController.getEntityItems(entityId);
			res.json({ items });
		} catch (error) {
			Logger.error('/inventory/:entityId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /inventory/:entityId/add
	 * Adds an item to an entity's inventory, attached to a specific component.
	 * All items must be associated with a component — there is no general/unassigned inventory.
	 * Body: { itemType: string, componentId: string }
	 */
	router.post('/inventory/:entityId/add', (req, res) => {
		try {
			const { entityId } = req.params;
			const { itemType, componentId } = req.body;

			// TYPED ID MIGRATION: Validate entityId format
			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/add params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}

			if (!itemType) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'itemType is required.',
				});
			}

			if (!componentId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'componentId is required: all items must be attached to a component.',
				});
			}

			// TYPED ID MIGRATION: Validate componentId format
			const compValidation = validateCompId(componentId, 'POST /inventory/:entityId/add body');
			if (!compValidation.valid) {
				return res.status(400).json({ error: compValidation.error });
			}

			const result = worldStateController.addItemToEntity(entityId, itemType, componentId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to add item',
					message: result.message,
				});
			}

			res.json({ success: true, item: result.item });
		} catch (error) {
			Logger.error('/inventory/:entityId/add endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * DELETE /inventory/:entityId/remove/:itemId
	 * Removes an item from an entity's inventory.
	 */
	router.delete('/inventory/:entityId/remove/:itemId', (req, res) => {
		try {
			const { entityId, itemId } = req.params;

			// TYPED ID MIGRATION: Validate entityId and itemId formats
			const entityIdValidation = validateEntityId(entityId, 'DELETE /inventory/:entityId/remove/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'DELETE /inventory/:entityId/remove/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			const result = worldStateController.removeItemFromEntity(entityId, itemId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to remove item',
					message: result.message,
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/remove/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /inventory/:entityId/move/:itemId
	 * Moves an item to a different component within an entity.
	 * Body: { targetComponentId: string }
	 */
	router.post('/inventory/:entityId/move/:itemId', (req, res) => {
		try {
			const { entityId, itemId } = req.params;
			const { targetComponentId } = req.body;

			// TYPED ID MIGRATION: Validate entityId and itemId formats
			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/move/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'POST /inventory/:entityId/move/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			if (!targetComponentId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'targetComponentId is required.',
				});
			}

			// TYPED ID MIGRATION: Validate targetComponentId format
			const compValidation = validateCompId(targetComponentId, 'POST /inventory/:entityId/move/:itemId body');
			if (!compValidation.valid) {
				return res.status(400).json({ error: compValidation.error });
			}

			const result = worldStateController.moveItemInEntity(entityId, itemId, targetComponentId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to move item',
					message: result.message,
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/move/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /inventory/:entityId/equip/:itemId
	 * Equips an item on a specific component. Applies holding cost debuffs, grants item actions.
	 * Body: { itemType: string, componentId: string }
	 */
	router.post('/inventory/:entityId/equip/:itemId', (req, res) => {
		try {
			const { entityId, itemId } = req.params;
			const { itemType, componentId } = req.body;

			// TYPED ID MIGRATION: Validate entityId and itemId formats
			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/equip/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'POST /inventory/:entityId/equip/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			if (!itemType) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'itemType is required.',
				});
			}

			if (!componentId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'componentId is required.',
				});
			}

			// TYPED ID MIGRATION: Validate componentId format
			const compValidation = validateCompId(componentId, 'POST /inventory/:entityId/equip/:itemId body');
			if (!compValidation.valid) {
				return res.status(400).json({ error: compValidation.error });
			}

			const result = worldStateController.equipItem(entityId, itemId, itemType, componentId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to equip item',
					message: result.message,
					details: result.details,
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/equip/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /inventory/:entityId/unequip/:itemId
	 * Unequips an item from its component. Reverses debuffs.
	 */
	router.post('/inventory/:entityId/unequip/:itemId', (req, res) => {
		try {
			const { entityId, itemId } = req.params;

			// TYPED ID MIGRATION: Validate entityId and itemId formats
			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/unequip/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'POST /inventory/:entityId/unequip/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			const result = worldStateController.unequipItem(entityId, itemId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to unequip item',
					message: result.message,
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/unequip/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /inventory/:entityId/transfer/:itemId
	 * Transfers an equipped item from one component to another (hand swap).
	 * Body: { itemType: string, fromComponentId: string, toComponentId: string }
	 */
	router.post('/inventory/:entityId/transfer/:itemId', (req, res) => {
		try {
			const { entityId, itemId } = req.params;
			const { itemType, fromComponentId, toComponentId } = req.body;

			// TYPED ID MIGRATION: Validate entityId and itemId formats
			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/transfer/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'POST /inventory/:entityId/transfer/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			if (!itemType || !fromComponentId || !toComponentId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'itemType, fromComponentId, and toComponentId are required.',
				});
			}

			// TYPED ID MIGRATION: Validate componentId formats
			const fromCompValidation = validateCompId(fromComponentId, 'POST /inventory/:entityId/transfer/:itemId body');
			if (!fromCompValidation.valid) {
				return res.status(400).json({ error: fromCompValidation.error });
			}
			const toCompValidation = validateCompId(toComponentId, 'POST /inventory/:entityId/transfer/:itemId body');
			if (!toCompValidation.valid) {
				return res.status(400).json({ error: toCompValidation.error });
			}

			const result = worldStateController.transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to transfer equip',
					message: result.message,
					details: result.details,
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/transfer/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

    /**
     * GET /inventory/:entityId/equipped
     * Returns all currently equipped items for an entity.
     */
    router.get('/inventory/:entityId/equipped', (req, res) => {
        try {
            const { entityId } = req.params;
            
            // TYPED ID MIGRATION: Validate entityId format
            const entityIdValidation = validateEntityId(entityId, 'GET /inventory/:entityId/equipped params');
            if (!entityIdValidation.valid) {
                return res.status(400).json({ error: entityIdValidation.error });
            }

            const equipped = worldStateController.getEquippedItems(entityId);
            res.json({ equipped });
        } catch (error) {
            Logger.error('/inventory/:entityId/equipped endpoint error', { error: error.message });
            res.status(500).json({
                error: 'Internal Server Error',
                details: error.message,
            });
        }
    });

    // =========================================================
    // ITEM STATS — COMPUTED STATS FOR A SPECIFIC ITEM
    // =========================================================

    /**
     * GET /inventory/:entityId/item-stats/:itemId
     * Returns computed stats for a specific item instance, combining:
     * - Base traits from inventoryItems.json
     * - Dynamic equipped item stats (sharpness drain, durability current)
     * - Holding cost debuffs (if equipped)
     */
    router.get('/inventory/:entityId/item-stats/:itemId', (req, res) => {
        try {
            const { entityId, itemId } = req.params;

            // TYPED ID MIGRATION: Validate entityId and itemId formats
            const entityIdValidation = validateEntityId(entityId, 'GET /inventory/:entityId/item-stats/:itemId params');
            if (!entityIdValidation.valid) {
                return res.status(400).json({ error: entityIdValidation.error });
            }
            const itemIdValidation = validateItemId(itemId, 'GET /inventory/:entityId/item-stats/:itemId params');
            if (!itemIdValidation.valid) {
                return res.status(400).json({ error: itemIdValidation.error });
            }

            const stats = worldStateController.getItemStats(entityId, itemId);
            if (!stats) {
                return res.status(404).json({ error: 'Not Found', message: `Item "${itemId}" not found on entity "${entityId}".` });
            }

            res.json({ success: true, stats });
        } catch (error) {
            Logger.error('/inventory/:entityId/item-stats/:itemId endpoint error', { error: error.message });
            res.status(500).json({
                error: 'Internal Server Error',
                details: error.message,
            });
        }
    });

    // =========================================================
    // DROP SELECTOR — CAPABLE COMPONENTS
    // =========================================================

    /**
     * GET /inventory/:entityId/capable-drop-components
     * Returns all components on an entity that are capable of performing a drop action.
     * A component is "capable" if it has Physical, Movement, or Manipulation traits.
     */
    router.get('/inventory/:entityId/capable-drop-components', (req, res) => {
		try {
			const { entityId } = req.params;

			// TYPED ID MIGRATION: Validate entityId format
			const entityIdValidation = validateEntityId(entityId, 'GET /inventory/:entityId/capable-drop-components params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}

			const entity = worldStateController.getEntity(entityId);
			if (!entity) {
				return res.status(404).json({
					error: 'Not Found',
					message: `Entity "${entityId}" not found.`,
				});
			}

			const capableComponents = [];

			if (entity.components && Array.isArray(entity.components)) {
				for (const compRef of entity.components) {
					// compRef is { id, type, identifier } or a string component ID
					const compId = typeof compRef === 'string' ? compRef : compRef.id;
					const compType = typeof compRef === 'string' ? compRef : compRef.type;
					const compIdentifier = typeof compRef === 'string' ? null : compRef.identifier;

					// Get runtime stats for this component instance
					const compStats = worldStateController.getComponentStats(compId) || {};

					// A component is capable if it has Physical, Movement, or Manipulation traits
					const hasPhysical = compStats.Physical && Object.keys(compStats.Physical).length > 0;
					const hasMovement = compStats.Movement && Object.keys(compStats.Movement).length > 0;
					const hasManipulation = compStats.Manipulation && Object.keys(compStats.Manipulation).length > 0;

					if (hasPhysical || hasMovement || hasManipulation) {
						const compName = compIdentifier || compType || compId;

						capableComponents.push({
							id: compId,
							type: compType,
							name: compName,
							identifier: compIdentifier || compType,
							Physical: compStats.Physical || null,
							Movement: compStats.Movement || null,
							Manipulation: compStats.Manipulation || null,
						});
					}
				}
			}

			res.json({ components: capableComponents });
		} catch (error) {
			Logger.error('/inventory/:entityId/capable-drop-components endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /inventory/:entityId/capable-pickup-components
	 * Returns all components on an entity that are capable of performing a pickup action.
	 * A component is "capable" if it has Physical, Movement, or Manipulation traits.
	 * This mirrors capable-drop-components but is used for the pick-up flow.
	 */
	router.get('/inventory/:entityId/capable-pickup-components', (req, res) => {
		try {
			const { entityId } = req.params;

			// TYPED ID MIGRATION: Validate entityId format
			const entityIdValidation = validateEntityId(entityId, 'GET /inventory/:entityId/capable-pickup-components params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}

			const entity = worldStateController.getEntity(entityId);
			if (!entity) {
				return res.status(404).json({
					error: 'Not Found',
					message: `Entity "${entityId}" not found.`,
				});
			}

			const capableComponents = [];

			if (entity.components && Array.isArray(entity.components)) {
				for (const compRef of entity.components) {
					const compId = typeof compRef === 'string' ? compRef : compRef.id;
					const compType = typeof compRef === 'string' ? compRef : compRef.type;
					const compIdentifier = typeof compRef === 'string' ? null : compRef.identifier;

					const compStats = worldStateController.getComponentStats(compId) || {};

					const hasPhysical = compStats.Physical && Object.keys(compStats.Physical).length > 0;
					const hasMovement = compStats.Movement && Object.keys(compStats.Movement).length > 0;
					const hasManipulation = compStats.Manipulation && Object.keys(compStats.Manipulation).length > 0;

					if (hasPhysical || hasMovement || hasManipulation) {
						const compName = compIdentifier || compType || compId;

						capableComponents.push({
							id: compId,
							type: compType,
							name: compName,
							identifier: compIdentifier || compType,
							Physical: compStats.Physical || null,
							Movement: compStats.Movement || null,
							Manipulation: compStats.Manipulation || null,
						});
					}
				}
			}

			res.json({ components: capableComponents });
		} catch (error) {
			Logger.error('/inventory/:entityId/capable-pickup-components endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	// =========================================================
	// NESTED INVENTORY — CONTAINER ROUTES
	// =========================================================

	/**
	 * POST /inventory/:entityId/container/:containerItemId/add
	 * Adds a new item to a container item.
	 * Body: { itemType: string }
	 */
	router.post('/inventory/:entityId/container/:containerItemId/add', (req, res) => {
		try {
			const { entityId, containerItemId } = req.params;
			const { itemType } = req.body;

			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/container/:containerItemId/add params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const containerItemIdValidation = validateItemId(containerItemId, 'POST /inventory/:entityId/container/:containerItemId/add params');
			if (!containerItemIdValidation.valid) {
				return res.status(400).json({ error: containerItemIdValidation.error });
			}

			if (!itemType) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'itemType is required.'
				});
			}

			const result = worldStateController.addItemToContainer(entityId, containerItemId, itemType);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to add item to container',
					message: result.message
				});
			}

			res.json({ success: true, item: result.item });
		} catch (error) {
			Logger.error('/inventory/:entityId/container/:containerItemId/add endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message
			});
		}
	});

	/**
	 * DELETE /inventory/:entityId/container/:containerItemId/remove/:itemId
	 * Removes an item from a container item.
	 */
	router.delete('/inventory/:entityId/container/:containerItemId/remove/:itemId', (req, res) => {
		try {
			const { entityId, containerItemId, itemId } = req.params;

			const entityIdValidation = validateEntityId(entityId, 'DELETE /inventory/:entityId/container/:containerItemId/remove/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const containerItemIdValidation = validateItemId(containerItemId, 'DELETE /inventory/:entityId/container/:containerItemId/remove/:itemId params');
			if (!containerItemIdValidation.valid) {
				return res.status(400).json({ error: containerItemIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'DELETE /inventory/:entityId/container/:containerItemId/remove/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			const result = worldStateController.removeItemFromContainer(entityId, containerItemId, itemId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to remove item from container',
					message: result.message
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/container/:containerItemId/remove/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message
			});
		}
	});

	/**
	 * POST /inventory/:entityId/container/:containerItemId/move-in/:itemId
	 * Moves an item from component level into a container.
	 */
	router.post('/inventory/:entityId/container/:containerItemId/move-in/:itemId', (req, res) => {
		try {
			const { entityId, containerItemId, itemId } = req.params;

			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/container/:containerItemId/move-in/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const containerItemIdValidation = validateItemId(containerItemId, 'POST /inventory/:entityId/container/:containerItemId/move-in/:itemId params');
			if (!containerItemIdValidation.valid) {
				return res.status(400).json({ error: containerItemIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'POST /inventory/:entityId/container/:containerItemId/move-in/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			const result = worldStateController.moveItemIntoContainer(entityId, containerItemId, itemId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to move item into container',
					message: result.message
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/container/:containerItemId/move-in/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message
			});
		}
	});

	/**
	 * POST /inventory/:entityId/container/:containerItemId/move-out/:itemId
	 * Moves an item out of a container back to the component level.
	 * Body: { targetComponentId: string }
	 */
	router.post('/inventory/:entityId/container/:containerItemId/move-out/:itemId', (req, res) => {
		try {
			const { entityId, containerItemId, itemId } = req.params;
			const { targetComponentId } = req.body;

			const entityIdValidation = validateEntityId(entityId, 'POST /inventory/:entityId/container/:containerItemId/move-out/:itemId params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const containerItemIdValidation = validateItemId(containerItemId, 'POST /inventory/:entityId/container/:containerItemId/move-out/:itemId params');
			if (!containerItemIdValidation.valid) {
				return res.status(400).json({ error: containerItemIdValidation.error });
			}
			const itemIdValidation = validateItemId(itemId, 'POST /inventory/:entityId/container/:containerItemId/move-out/:itemId params');
			if (!itemIdValidation.valid) {
				return res.status(400).json({ error: itemIdValidation.error });
			}

			if (!targetComponentId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'targetComponentId is required.'
				});
			}

			const compValidation = validateCompId(targetComponentId, 'POST /inventory/:entityId/container/:containerItemId/move-out/:itemId body');
			if (!compValidation.valid) {
				return res.status(400).json({ error: compValidation.error });
			}

			const result = worldStateController.moveItemOutOfContainer(entityId, containerItemId, itemId, targetComponentId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to move item out of container',
					message: result.message
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/:entityId/container/:containerItemId/move-out/:itemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message
			});
		}
	});

	/**
	 * GET /inventory/:entityId/container/:containerItemId/items
	 * Gets the contained items for a container item.
	 */
	router.get('/inventory/:entityId/container/:containerItemId/items', (req, res) => {
		try {
			const { entityId, containerItemId } = req.params;

			const entityIdValidation = validateEntityId(entityId, 'GET /inventory/:entityId/container/:containerItemId/items params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}
			const containerItemIdValidation = validateItemId(containerItemId, 'GET /inventory/:entityId/container/:containerItemId/items params');
			if (!containerItemIdValidation.valid) {
				return res.status(400).json({ error: containerItemIdValidation.error });
			}

			const items = worldStateController.getContainerItems(entityId, containerItemId);
			res.json({ items });
		} catch (error) {
			Logger.error('/inventory/:entityId/container/:containerItemId/items endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message
			});
		}
	});

	// =========================================================
	// DROPPED ITEMS ROUTES
	// =========================================================

	/**
	 * GET /inventory/dropped
	 * Returns all dropped items in the world.
	 */
	router.get('/inventory/dropped', (req, res) => {
		try {
			const droppedItems = worldStateController.getDroppedItems();
			res.json({ droppedItems });
		} catch (error) {
			Logger.error('/inventory/dropped endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

}
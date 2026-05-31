/**
 * Inventory API Routes
 * Provides endpoints for managing entity inventory.
 *
 * @module routes/inventoryRoutes
 */
import Logger from '../utils/Logger.js';

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

			if (!targetComponentId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'targetComponentId is required.',
				});
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

			if (!itemType || !fromComponentId || !toComponentId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'itemType, fromComponentId, and toComponentId are required.',
				});
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

			if (!entityId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'entityId is required.',
				});
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

			if (!entityId) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'entityId is required.',
				});
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

	/**
	 * DELETE /inventory/dropped/:droppedItemId
	 * Removes a dropped item from the world.
	 */
	router.delete('/inventory/dropped/:droppedItemId', (req, res) => {
		try {
			const { droppedItemId } = req.params;
			const result = worldStateController.removeDroppedItem(droppedItemId);

			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to remove dropped item',
					message: result.message,
				});
			}

			res.json({ success: true });
		} catch (error) {
			Logger.error('/inventory/dropped/:droppedItemId endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}

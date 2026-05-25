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
}
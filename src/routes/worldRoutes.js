import Logger from '../utils/Logger.js';
import DataLoader from '../utils/DataLoader.js';

/**
 * Registers world state-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 * @param {Object} deps.broadcastService - Broadcast service instance
 */
export function register(router, { worldStateController, broadcastService }) {
	/**
	 * GET /world-state
	 * Returns the current state of the world.
	 */
	router.get('/world-state', (req, res) => {
		try {
			const worldState = worldStateController.getAll();
			res.json({ state: worldState });
		} catch (error) {
			Logger.error('/world-state endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /rooms
	 * Returns all rooms with their coordinates.
	 */
	router.get('/rooms', (req, res) => {
		try {
			const rooms = worldStateController.getRooms();
			res.json({ rooms });
		} catch (error) {
			Logger.error('/rooms endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /world-map
	 * Returns the world graph with resolved room names for all connections
	 * and dropped items for spatial map rendering.
	 */
	router.get('/world-map', (req, res) => {
		try {
			const graph = worldStateController.getWorldGraph();
			const droppedItems = worldStateController.getDroppedItems() || {};

			// Transform dropped items into a flat array with item type info
			const droppedItemsArray = [];
			const itemDefinitions = DataLoader.loadJsonSafe('data/inventoryItems.json', {});

			for (const [id, item] of Object.entries(droppedItems)) {
				const itemDef = itemDefinitions[item.itemType];
				droppedItemsArray.push({
					id,
					itemType: item.itemType,
					name: itemDef?.name || item.itemType,
					description: itemDef?.description || '',
					volume: itemDef?.volume || 1,
					x: item.x,
					y: item.y
				});
			}

			res.json({
				...graph,
				droppedItems: droppedItemsArray
			});
		} catch (error) {
			Logger.error('/world-map endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * GET /world-map-with-items
	 * Returns the world graph with resolved room names and dropped items for map rendering.
	 */
	router.get('/world-map-with-items', (req, res) => {
		try {
			const graph = worldStateController.getWorldGraph();
			const droppedItems = worldStateController.getDroppedItems() || {};

			// Transform dropped items into a flat array with item type info
			const droppedItemsArray = [];
			const itemDefinitions = DataLoader.loadJsonSafe('data/inventoryItems.json', {});

			for (const [id, item] of Object.entries(droppedItems)) {
				const itemDef = itemDefinitions[item.itemType];
				droppedItemsArray.push({
					id,
					itemType: item.itemType,
					name: itemDef?.name || item.itemType,
					description: itemDef?.description || '',
					volume: itemDef?.volume || 1,
					x: item.x,
					y: item.y
				});
			}

			res.json({
				rooms: graph.rooms || [],
				droppedItems: droppedItemsArray
			});
		} catch (error) {
			Logger.error('/world-map-with-items endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /pick-up-item
	 * Picks up a dropped item from the map and adds it to an entity's inventory.
	 */
	router.post('/pick-up-item', (req, res) => {
		const { entityId, droppedItemId, componentId } = req.body;

		if (!entityId || !droppedItemId || !componentId) {
			return res.status(400).json({
				error: 'Invalid request. "entityId", "droppedItemId", and "componentId" are required.',
			});
		}

		try {
			// Access the consequence dispatcher's pickUpItem handler
			const consequenceHandlers = worldStateController.actionController._consequenceHandlers;
			const pickUpHandler = consequenceHandlers?.handlers?.pickUpItem;

			let result;
			if (typeof pickUpHandler === 'function') {
				result = pickUpHandler(null, { entityId, droppedItemId, componentId }, { entityId });
			} else {
				throw new Error('PickUpItem consequence handler not registered.');
			}

			if (result.success) {
				broadcastService.broadcast();
				res.json({ message: result.message, pickedUpItem: result.pickedUpItem });
			} else {
				res.status(400).json({ error: result.message });
			}
		} catch (error) {
			Logger.error('/pick-up-item endpoint error', {
				error: error.message,
				entityId,
				droppedItemId,
				componentId,
			});
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	/**
	 * POST /move-entity
	 * Moves an entity to a different room.
	 */
	router.post('/move-entity', (req, res) => {
		const { entityId, targetRoomId } = req.body;

		if (!entityId || !targetRoomId) {
			return res.status(400).json({
				error: 'Invalid request. "entityId" and "targetRoomId" are required.',
			});
		}

		try {
			const success = worldStateController.moveEntity(entityId, targetRoomId);
			if (success) {
				broadcastService.broadcast();
				res.json({ message: 'Entity moved successfully.' });
			} else {
				res.status(404).json({ error: 'Entity not found.' });
			}
		} catch (error) {
			Logger.error('/move-entity endpoint error', {
				error: error.message,
				entityId,
				targetRoomId,
			});
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}
import express from 'express';
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
	 * Returns the current state of the world (with typed-ID transformation applied).
	 */
	router.get('/world-state', (req, res) => {
		try {
			const worldState = worldStateController.getAll();
			// Apply the same transformation used by broadcast to ensure entity.equipped is populated
			const transformedState = broadcastService._transformForBroadcast(worldState);
			res.json({ state: transformedState });
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
			// Use the public API method on WorldStateController (avoids direct access to internal properties)
			const result = worldStateController.executePickUpItem(entityId, droppedItemId, componentId);

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
	 * Optionally accepts `sourceDoor` to calculate spawn position at the opposite door.
	 */
	router.post('/move-entity', (req, res) => {
	    const { entityId, targetRoomId, sourceDoor } = req.body;

	    if (!entityId || !targetRoomId) {
	        return res.status(400).json({
	            error: 'Invalid request. "entityId" and "targetRoomId" are required.',
	        });
	    }

	    try {
	        const moveOptions = sourceDoor ? { sourceDoor } : {};
	        const success = worldStateController.moveEntity(entityId, targetRoomId, moveOptions);
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
	            sourceDoor,
	        });
	        res.status(500).json({
	            error: 'Internal Server Error',
	            details: error.message,
	        });
	    }
	});

	// =========================================================================
	// PERSISTENCE — save/load endpoints (FASE 3)
	// =========================================================================

	/**
	 * Sub-router mounted at /api/world (this router itself is mounted at / by
	 * src/routes/index.js), so the public paths are POST /api/world/save and
	 * POST /api/world/load. Both are covered by the global auth middleware.
	 */
	const persistenceRouter = express.Router();

	/**
	 * POST /api/world/save
	 * Returns a full, JSON-serializable snapshot of the world state
	 * (WorldStateController.serialize()). The client/operator persists the
	 * returned snapshot (e.g., to a file) for later /load.
	 */
	persistenceRouter.post('/save', (req, res) => {
	    try {
	        const snapshot = worldStateController.serialize();
	        res.json({ success: true, snapshot });
	    } catch (error) {
	        Logger.error('/api/world/save endpoint error', { error: error.message });
	        res.status(500).json({
	            success: false,
	            error: { code: 'SAVE_FAILED', message: 'Internal Server Error' },
	            details: error.message,
	        });
	    }
	});

	/**
	 * POST /api/world/load
	 * Restores the world state from a previously saved snapshot
	 * (WorldStateController.restore()). Accepts { snapshot: <serialize() output> }.
	 * Broadcasts the restored state on success so all clients resync.
	 */
	persistenceRouter.post('/load', (req, res) => {
	    const { snapshot } = req.body || {};

	    if (!snapshot || typeof snapshot !== 'object') {
	        return res.status(400).json({
	            success: false,
	            error: { code: 'INVALID_PAYLOAD', message: 'Invalid request. A "snapshot" object (from POST /api/world/save) is required.' },
	        });
	    }

	    try {
	        const result = worldStateController.restore(snapshot);
	        if (result.success) {
	            broadcastService.broadcast();
	            res.json({ success: true, message: 'World state restored from snapshot.' });
	        } else {
	            // Structured error from restore() (e.g. SCHEMA_VERSION_MISMATCH)
	            const status = result.error?.code === 'SCHEMA_VERSION_MISMATCH' ? 409 : 400;
	            res.status(status).json({ success: false, error: result.error });
	        }
	    } catch (error) {
	        Logger.error('/api/world/load endpoint error', { error: error.message });
	        res.status(500).json({
	            success: false,
	            error: { code: 'LOAD_FAILED', message: 'Internal Server Error' },
	            details: error.message,
	        });
	    }
	});

	router.use('/api/world', persistenceRouter);
}
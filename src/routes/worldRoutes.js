import Logger from '../utils/Logger.js';

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
	 * Returns the world graph with resolved room names for all connections.
	 */
	router.get('/world-map', (req, res) => {
		try {
			const graph = worldStateController.getWorldGraph();
			res.json(graph);
		} catch (error) {
			Logger.error('/world-map endpoint error', { error: error.message });
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
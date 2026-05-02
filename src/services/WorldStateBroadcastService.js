import Logger from '../utils/Logger.js';

/**
 * WorldStateBroadcastService handles broadcasting world state updates to connected clients.
 * Follows the Dependency Injection pattern from controller_patterns.md.
 */
class WorldStateBroadcastService {
	/**
	 * @param {object} io - Socket.IO server instance
	 * @param {object} worldStateController - The root controller for world state management
	 */
	constructor(io, worldStateController) {
		this._io = io;
		this._worldStateController = worldStateController;
	}

	/**
	 * Broadcasts the current world state to all connected clients.
	 */
	broadcast() {
		try {
			const worldState = this._worldStateController.getAll();
			if (!worldState) {
				Logger.warn('Attempted to broadcast null/undefined world state');
				return;
			}

			const clientCount = this._io.engine.clientsCount;
			this._io.emit('world-state-update', { state: worldState });
			Logger.info('World state broadcasted', { clientCount, time: new Date().toLocaleTimeString() });
		} catch (error) {
			Logger.error('Failed to broadcast world state', { error: error.message });
		}
	}
}

export default WorldStateBroadcastService;
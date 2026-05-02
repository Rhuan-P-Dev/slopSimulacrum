import Logger from '../utils/Logger.js';

/**
 * SocketLifecycleController manages WebSocket connection lifecycle events.
 * Handles player incarnation, disconnection, and error handling.
 * Follows the Dependency Injection pattern from controller_patterns.md.
 */
class SocketLifecycleController {
	/**
	 * @param {object} worldStateController - The root controller for entity/room management
	 * @param {object} io - Socket.IO server instance
	 */
	constructor(worldStateController, io) {
		this._worldStateController = worldStateController;
		this._io = io;
		this._socketToEntityMap = new Map();
	}

	/**
	 * Registers all Socket.IO event handlers on the IO server.
	 */
	registerHandlers() {
		this._io.on('connection', (socket) => {
			Logger.info(`Socket connected: ${socket.id}`);

			socket.on('error', (error) => {
				Logger.error(`Socket ${socket.id} error`, { error: error.message });
				this._handleSocketError(socket);
			});

			socket.on('disconnect', () => {
				this._handleDisconnect(socket);
			});

			this._incarnatePlayer(socket);
		});
	}

	/**
	 * Incarnates a player by spawning an entity and mapping socket to entity.
	 * @param {object} socket - The Socket.IO socket instance
	 * @private
	 */
	_incarnatePlayer(socket) {
		try {
			let startRoomId = this._worldStateController.getRoomUidByLogicalId('start_room');

			if (!startRoomId) {
				const availableRooms = this._worldStateController.getAll()?.rooms;
				const availableRoomIds = Object.keys(availableRooms || {});
				if (availableRoomIds.length > 0) {
					startRoomId = availableRoomIds[0];
				}
			}

			if (!startRoomId) {
				Logger.critical('No valid room found for incarnation', { socketId: socket.id });
				socket.emit('error', { message: 'World initialization error: No rooms available.' });
				return;
			}

			const entityId = this._worldStateController.spawnEntity('smallBallDroid', startRoomId);
			this._socketToEntityMap.set(socket.id, entityId);

			Logger.info('Player incarnated', { socketId: socket.id, entityId, roomId: startRoomId });
			socket.emit('incarnate', { entityId });
		} catch (error) {
			Logger.error('Failed to incarnate player', { socketId: socket.id, error: error.message });
			socket.emit('error', { message: 'Failed to incarnate player entity.' });
			const entityId = this._socketToEntityMap.get(socket.id);
			if (entityId) {
				Logger.warn('Cleaning up socket mapping after incarnation error', { socketId: socket.id, entityId });
				this._worldStateController.despawnEntity(entityId);
				this._socketToEntityMap.delete(socket.id);
			}
		}
	}

	/**
	 * Handles socket error events by cleaning up the entity mapping.
	 * @param {object} socket - The Socket.IO socket instance
	 * @private
	 */
	_handleSocketError(socket) {
		const entityId = this._socketToEntityMap.get(socket.id);
		if (entityId) {
			Logger.warn('Cleaning up socket mapping after error', { socketId: socket.id, entityId });
			this._worldStateController.despawnEntity(entityId);
			this._socketToEntityMap.delete(socket.id);
		}
	}

	/**
	 * Handles socket disconnect events by despawning the associated entity.
	 * @param {object} socket - The Socket.IO socket instance
	 * @private
	 */
	_handleDisconnect(socket) {
		const entityId = this._socketToEntityMap.get(socket.id);
		if (entityId) {
			Logger.info('Player disconnected, despawning entity', { socketId: socket.id, entityId });
			this._worldStateController.despawnEntity(entityId);
			this._socketToEntityMap.delete(socket.id);
		}
	}
}

export default SocketLifecycleController;
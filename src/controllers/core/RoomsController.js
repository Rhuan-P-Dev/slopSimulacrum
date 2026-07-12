import { generateUID } from '../../utils/idGenerator.js';
import DataLoader from '../../utils/DataLoader.js';
import Logger from '../../utils/Logger.js';

/**
 * RoomsController handles the storage and management of rooms and their connections.
 * It serves as the single source of truth for the world's spatial data.
 * 
 * Per wiki/CORE.md: RoomsController is a State Controller (data store only),
 * following the State Ownership vs. Logic Coordination pattern.
 */
class RoomsController {
    /**
     * Creates a new RoomsController instance.
     * Loads room definitions from data/rooms.json and initializes the internal room store.
     */
    constructor() {
        // Internal storage for rooms.
        // Format: { roomId: { id, name, description, connections: { doorId: { target: destinationRoomUid } }, x, y, width, height, objects: [], entities: [] } }
        this.rooms = {};
        this.idMap = {}; // Maps logical names to generated UIDs

        // Load room definitions from external data file (per DataLoader pattern used by WorldStateController)
        const roomDefinitions = DataLoader.loadJsonSafe('data/rooms.json', {});

        // Validate loaded definitions before initialization
        this._validateRoomDefinitions(roomDefinitions);

        // 1. Generate Unique IDs for all defined rooms
        for (const logicalId in roomDefinitions) {
            this.idMap[logicalId] = generateUID();
        }

        // 2. Initialize rooms with UIDs and expanded schema (objects, entities)
        for (const [logicalId, data] of Object.entries(roomDefinitions)) {
            const uid = this.idMap[logicalId];
            this.rooms[uid] = {
                id: uid,
                name: data.name,
                description: data.description,
                connections: {}, // Will be filled in next step
                x: data.x,
                y: data.y,
                width: data.width,
                height: data.height,
                objects: [],
                entities: []
            };
        }

        // 3. Map logical connections to actual generated UIDs
        // Supports both string format ("door": "target_room") and object format ("door": { "target": "target_room" })
        // Range is no longer stored on connections; it is computed from the entity's Movement.move stat client-side.
        for (const [logicalId, data] of Object.entries(roomDefinitions)) {
            const uid = this.idMap[logicalId];
            for (const [door, connectionData] of Object.entries(data.connections)) {
                const targetLogicalId = typeof connectionData === 'string'
                    ? connectionData
                    : connectionData.target;

                this.rooms[uid].connections[door] = {
                    target: this.idMap[targetLogicalId]
                };
            }
        }

        Logger.info(`[RoomsController] Initialized with ${Object.keys(this.rooms).length} rooms`);
    }

    /**
     * Validates room definitions loaded from the data file.
     * Supports both string connection format and object format with target.
     * Range is no longer validated on connections; it is computed from the entity's Movement.move stat.
     * @private
     * @param {Object} defs - Room definitions to validate.
     * @throws {TypeError} If validation fails.
     */
    _validateRoomDefinitions(defs) {
        if (typeof defs !== 'object' || defs === null) {
            throw new TypeError('Room definitions must be an object');
        }
        for (const [logicalId, def] of Object.entries(defs)) {
            if (typeof def.name !== 'string' || def.name.trim() === '') {
                throw new TypeError(`Room '${logicalId}' must have a non-empty name`);
            }
            if (typeof def.description !== 'string') {
                throw new TypeError(`Room '${logicalId}' must have a description`);
            }
            if (typeof def.connections !== 'object' || def.connections === null) {
                throw new TypeError(`Room '${logicalId}' must have a connections object`);
            }
            for (const [door, connectionData] of Object.entries(def.connections)) {
                if (typeof door !== 'string' || door.trim() === '') {
                    throw new TypeError(`Room '${logicalId}' connection must have a non-empty door name`);
                }
                if (typeof connectionData === 'string') {
                    // String format: validate target
                    if (connectionData.trim() === '') {
                        throw new TypeError(`Room '${logicalId}' connection '${door}' must have a non-empty target`);
                    }
                } else if (typeof connectionData === 'object' && connectionData !== null) {
                    // Object format: validate target
                    if (typeof connectionData.target !== 'string' || connectionData.target.trim() === '') {
                        throw new TypeError(`Room '${logicalId}' connection '${door}' must have a non-empty string target`);
                    }
                } else {
                    throw new TypeError(`Room '${logicalId}' connection '${door}' must be a string or object`);
                }
            }
            if (typeof def.x !== 'number' || typeof def.y !== 'number') {
                throw new TypeError(`Room '${logicalId}' must have numeric x, y coordinates`);
            }
            if (typeof def.width !== 'number' || typeof def.height !== 'number') {
                throw new TypeError(`Room '${logicalId}' must have numeric width, height`);
            }
        }
    }

    /**
     * Resolves a logical room name to its generated UUID.
     * @param {string} logicalId - The logical name of the room (e.g., 'start_room').
     * @returns {string|null} The UUID of the room, or null if not found.
     */
    getUidByLogicalId(logicalId) {
        return this.idMap[logicalId] || null;
    }

    /**
     * Retrieves a deep copy of all rooms and their connections.
     * Returns a defensive copy to prevent external mutation of internal state.
     * @returns {Object<string, Object>} A deep copy of the rooms map.
     */
    getAll() {
        return structuredClone(this.rooms);
    }

    /**
     * Retrieves a deep copy of a specific room by its ID.
     * @param {string} roomId - The ID of the room to retrieve.
     * @returns {Object|null} A deep copy of the room data, or null if not found.
     */
    getRoom(roomId) {
        const room = this.rooms[roomId];
        return room ? structuredClone(room) : null;
    }

    /**
     * Retrieves the target room UUID for a specific door connection.
     * @param {string} roomId - The UUID of the room.
     * @param {string} doorName - The name of the door (e.g., 'right_door').
     * @returns {string|null} The UUID of the target room, or null if not found.
     */
    getConnectionTarget(roomId, doorName) {
        const room = this.rooms[roomId];
        if (!room) {
            Logger.warn(`[RoomsController] Room '${roomId}' not found`);
            return null;
        }
        const connection = room.connections[doorName];
        if (!connection) {
            Logger.warn(`[RoomsController] Door '${doorName}' not found in room '${roomId}'`);
            return null;
        }
        return connection.target;
    }
}

export default RoomsController;

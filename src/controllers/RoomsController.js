const { generateUID }= require('../utils/idGenerator');

/**
 * RoomsController handles the storage and management of rooms and their connections.
 * It serves as the single source of truth for the world's spatial data.
 */
class RoomsController {
    constructor() {
        // Internal storage for rooms. 
        // Format: { roomId: { id, name, description, connections: { doorId: destinationRoomId }, objects: [], entities: [] } }
        this.rooms = {};
        this.idMap = {}; // Maps logical names to generated UIDs

        // Initial room definitions for setup
        const roomDefinitions = {
            'start_room': {
                name: 'The Entrance Hall',
                description: 'A dimly lit hall. To your right, there is an open corridor.',
                connections: { 'right_door': 'right_room' }
            },
            'right_room': {
                name: 'The Eastern Corridor',
                description: 'A narrow corridor with flickering lights. To your left is the Entrance Hall, and to your right, another door leads deeper into the complex.',
                connections: { 'left_door': 'start_room', 'right_door': 'far_right_room' }
            },
            'far_right_room': {
                name: 'The Deep Vault',
                description: 'A cold, metallic chamber echoing with the hum of ancient machinery. To your left is the Eastern Corridor.',
                connections: { 'left_door': 'right_room' }
            }
        };

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
                objects: [],
                entities: []
            };
        }

        // 3. Map logical connections to actual generated UIDs
        for (const [logicalId, data] of Object.entries(roomDefinitions)) {
            const uid = this.idMap[logicalId];
            for (const [door, targetLogicalId] of Object.entries(data.connections)) {
                this.rooms[uid].connections[door] = this.idMap[targetLogicalId];
            }
        }
    }

    /**
     * Resolves a logical room name to its generated UUID.
     * @param {string} logicalId - The logical name of the room (e.g., 'start_room').
     * @returns {string|null} The UUID of the room or null if not found.
     */
    getUidByLogicalId(logicalId) {
        return this.idMap[logicalId] || null;
    }

    /**
     * Retrieves all rooms and their connections.
     * @returns {Object} The full map of rooms.
     */
    getAll() {
        return this.rooms;
    }

    /**
     * Retrieves a specific room by its ID.
     * @param {string} roomId - The ID of the room to retrieve.
     * @returns {Object|null} The room data or null if not found.
     */
    getRoom(roomId) {
        return this.rooms[roomId] || null;
    }
}

module.exports = RoomsController;

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

        // Initial room definitions for setup
        const roomDefinitions = {
            'start_room': {
                name: 'The Entrance Hall',
                description: 'A dimly lit hall with a heavy oak door to the north.',
                connections: { 'north_door': 'great_hall' }
            },
            'great_hall': {
                name: 'The Great Hall',
                description: 'A vast room with high ceilings and a large fireplace.',
                connections: { 'south_door': 'start_room', 'east_door': 'library' }
            },
            'library': {
                name: 'The Forbidden Library',
                description: 'Shelves of ancient books line the walls. It smells of parchment and dust.',
                connections: { 'west_door': 'great_hall' }
            }
        };

        // 1. Generate Unique IDs for all defined rooms
        const idMap = {}; // Maps logical names to generated UIDs
        for (const logicalId in roomDefinitions) {
            idMap[logicalId] = generateUID();
        }

        // 2. Initialize rooms with UIDs and expanded schema (objects, entities)
        for (const [logicalId, data] of Object.entries(roomDefinitions)) {
            const uid = idMap[logicalId];
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
            const uid = idMap[logicalId];
            for (const [door, targetLogicalId] of Object.entries(data.connections)) {
                this.rooms[uid].connections[door] = idMap[targetLogicalId];
            }
        }
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

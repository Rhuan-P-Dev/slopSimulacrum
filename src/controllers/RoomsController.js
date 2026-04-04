/**
 * RoomsController handles the storage and management of rooms and their connections.
 * It serves as the single source of truth for the world's spatial data.
 */
class RoomsController {
    constructor() {
        // Internal storage for rooms. 
        // Format: { roomId: { id, name, description, connections: { doorId: destinationRoomId } } }
        this.rooms = {
            'start_room': {
                id: 'start_room',
                name: 'The Entrance Hall',
                description: 'A dimly lit hall with a heavy oak door to the north.',
                connections: {
                    'north_door': 'great_hall'
                }
            },
            'great_hall': {
                id: 'great_hall',
                name: 'The Great Hall',
                description: 'A vast room with high ceilings and a large fireplace.',
                connections: {
                    'south_door': 'start_room',
                    'east_door': 'library'
                }
            },
            'library': {
                id: 'library',
                name: 'The Forbidden Library',
                description: 'Shelves of ancient books line the walls. It smells of parchment and dust.',
                connections: {
                    'west_door': 'great_hall'
                }
            }
        };
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

/**
 * WorldGraphBuilder
 * Constructs a navigable graph structure from room data.
 * 
 * Takes a rooms object (from RoomsController.getAll()) and produces a graph
 * where each room includes resolved connection details (door names and
 * destination room names).
 * 
 * Returns a defensive copy via structuredClone to prevent external mutation.
 * 
 * @module WorldGraphBuilder
 */
class WorldGraphBuilder {
    /**
     * @param {Object<string, Object>} rooms - Rooms object from RoomsController.getAll()
     *    Format: { roomId: { id, name, description, connections: { doorId: destinationRoomId }, x, y, width, height, objects, entities } }
     */
    constructor(rooms) {
        if (!rooms || typeof rooms !== 'object') {
            throw new TypeError('WorldGraphBuilder requires a rooms object');
        }

        this.rooms = rooms;
        this.roomsById = new Map();
        this.roomOrder = [];

        this._buildIndex();
    }

    /**
     * Creates a reverse lookup map from room IDs to room data.
     * @private
     */
    _buildIndex() {
        for (const [roomId, roomData] of Object.entries(this.rooms)) {
            this.roomsById.set(roomId, roomData);
            this.roomOrder.push(roomId);
        }
    }

    /**
     * Builds the complete world graph.
     * @returns {Object} Graph structure with rooms and resolved connections.
     */
    build() {
        const graphRooms = [];

        for (const roomId of this.roomOrder) {
            const roomData = this.roomsById.get(roomId);
            if (!roomData) continue;

            const connections = [];
            const roomConnections = roomData.connections || {};

            for (const [door, connData] of Object.entries(roomConnections)) {
                // Connection values can be either a plain room ID string ("room_id")
                // or an object containing the target key ({ target: "room_id" }).
                // Normalize to the string form so the roomsById lookup succeeds.
                // Matches the same pattern used in RoomConnectionRenderer.renderRoomConnections().
                const targetId = typeof connData === 'object' ? connData.target : connData;
                const targetRoom = this.roomsById.get(targetId);
                connections.push({
                    door,
                    targetId,
                    targetName: targetRoom ? targetRoom.name : 'Unknown'
                });
            }

            graphRooms.push({
                id: roomData.id,
                name: roomData.name,
                x: roomData.x,
                y: roomData.y,
                width: roomData.width,
                height: roomData.height,
                connections
            });
        }

        return structuredClone({ rooms: graphRooms });
    }
}

export default WorldGraphBuilder;
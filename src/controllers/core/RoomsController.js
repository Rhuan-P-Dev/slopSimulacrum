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
        // Format: { roomId: { id, name, description, connections: { doorId: destinationRoomId }, x, y, width, height, objects: [], entities: [] } }
        this.rooms = {};
        this.idMap = {}; // Maps logical names to generated UIDs

        // Internal storage for door positions.
        // Format: { roomId: { doorName: { x: number, y: number } } }
        // All positions are normalized to direct X/Y coordinates at initialization time.
        // Stored separately from connections to maintain backward compatibility with existing consumers.
        this.doorPositions = {};

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

        // 3. Map logical connections to actual generated UIDs and populate door positions
        for (const [logicalId, data] of Object.entries(roomDefinitions)) {
            const uid = this.idMap[logicalId];
            this.doorPositions[uid] = {};
            for (const [door, conn] of Object.entries(data.connections)) {
                let targetLogicalId;
                if (typeof conn === 'string') {
                    // Legacy string format: {"right_door": "right_room"}
                    targetLogicalId = conn;
                } else {
                    // New object format: {"right_door": {"target": "right_room", "position": {...}}}
                    targetLogicalId = conn.target;
                    // Store door position if provided, normalizing to direct X/Y coordinates
                    if (conn.position) {
                        this.doorPositions[uid][door] = this._normalizePosition(conn.position, data.width, data.height);
                    }
                }
                this.rooms[uid].connections[door] = this.idMap[targetLogicalId];
            }
        }

        Logger.info(`[RoomsController] Initialized with ${Object.keys(this.rooms).length} rooms`);
    }

    /**
     * Validates room definitions loaded from the data file.
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
            for (const [door, target] of Object.entries(def.connections)) {
                if (typeof door !== 'string' || door.trim() === '') {
                    throw new TypeError(`Room '${logicalId}' connection must have a non-empty door name`);
                }
                // Legacy string format: {"right_door": "right_room"}
                if (typeof target === 'string') {
                    if (target.trim() === '') {
                        throw new TypeError(`Room '${logicalId}' connection '${door}' must have a non-empty target`);
                    }
                }
                // New object format: {"right_door": {"target": "right_room", "position": {...}}}
                else if (typeof target === 'object' && target !== null) {
                    if (typeof target.target !== 'string' || target.target.trim() === '') {
                        throw new TypeError(`Room '${logicalId}' connection '${door}' must have a string 'target'`);
                    }
                    // Optional position validation — supports both direct X/Y and legacy edge/offset
                    if (target.position !== undefined) {
                        this._validatePosition(target.position, logicalId, door);
                    }
                }
                else {
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
     * Retrieves the room-relative spatial position of a named door.
     * Uses a two-tier resolution strategy:
     * 1. Return explicit stored position if available (backward compat override).
     * 2. Calculate automatically from room layout using edge-intersection algorithm.
     * @param {string} roomId - The UUID of the room.
     * @param {string} doorName - The name of the door (e.g., 'right_door').
     * @returns {{ x: number, y: number }|null} Room-relative spatial coordinates, or null if not found.
     */
    getDoorPosition(roomId, doorName) {
        // Tier 1: Explicit stored position (backward compat — intentional overrides)
        const positions = this.doorPositions[roomId];
        if (positions && positions[doorName]) {
            return { ...positions[doorName] };
        }

        // Tier 2: Calculate automatically from room layout
        const room = this.rooms[roomId];
        if (!room || !room.connections[doorName]) {
            return null;
        }

        const targetRoomId = room.connections[doorName];
        const targetRoom = this.rooms[targetRoomId];
        if (!targetRoom) {
            return null;
        }

        return this._calculateEdgeIntersection(room, targetRoom);
    }

    /**
     * Calculates the edge intersection point on the source room's boundary
     * toward the target room's center.
     * Why this algorithm: Mirrors the client-side _getEdgePoint() in RoomConnectionRenderer
     * to ensure client-server parity — the spawn position matches the rendered connection endpoint.
     * @private
     * @param {Object} sourceRoom - The source room object (with x, y, width, height).
     * @param {Object} targetRoom - The target room object (with x, y, width, height).
     * @returns {{ x: number, y: number }} Room-relative coordinates where the connection exits sourceRoom.
     */
    _calculateEdgeIntersection(sourceRoom, targetRoom) {
        // Direction from source center to target center
        const dx = (targetRoom.x + targetRoom.width / 2) - (sourceRoom.x + sourceRoom.width / 2);
        const dy = (targetRoom.y + targetRoom.height / 2) - (sourceRoom.y + sourceRoom.height / 2);

        // Handle degenerate case: same-center rooms
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx === 0 && absDy === 0) {
            return { x: 0, y: 0 };
        }

        // Room boundaries relative to center
        const halfW = sourceRoom.width / 2;
        const halfH = sourceRoom.height / 2;

        let edgeX, edgeY;

        // Determine which edge the ray hits first
        // Use >= to handle the tie case: when direction is more horizontal, hit left/right edge
        if (absDx * halfH >= absDy * halfW) {
            // Left or right edge
            const sign = dx > 0 ? 1 : -1;
            edgeX = sign * halfW;
            edgeY = (dy / absDx) * halfW;
        } else {
            // Top or bottom edge
            const sign = dy > 0 ? 1 : -1;
            edgeY = sign * halfH;
            edgeX = (dx / absDy) * halfH;
        }

        return { x: edgeX, y: edgeY };
    }

    /**
     * Normalizes a door position definition to direct { x, y } coordinates.
     * Why normalization at init: Converts legacy edge/offset format to X/Y once at
     * startup, avoiding repeated calculations at runtime. Supports both formats for
     * backward compatibility during migration.
     * @private
     * @param {Object} position - Position object with either { x, y } or { edge, offset }.
     * @param {number} width - Room width (used for edge/offset conversion).
     * @param {number} height - Room height (used for edge/offset conversion).
     * @returns {{ x: number, y: number }} Normalized room-relative coordinates.
     */
    _normalizePosition(position, width, height) {
        // Direct X/Y format — use as-is
        if (position.x !== undefined && position.y !== undefined) {
            return { x: position.x, y: position.y };
        }
        // Legacy edge/offset format — convert to X/Y
        if (position.edge !== undefined && position.offset !== undefined) {
            return this._calculateEdgePosition(position.edge, position.offset, width, height);
        }
        // Fallback
        return { x: 0, y: 0 };
    }

    /**
     * Validates a door position object supporting both direct X/Y and legacy edge/offset formats.
     * @private
     * @param {Object} position - The position object to validate.
     * @param {string} roomId - The room logical ID (for error messages).
     * @param {string} doorName - The door name (for error messages).
     * @throws {TypeError} If validation fails.
     */
    _validatePosition(position, roomId, doorName) {
        // Direct X/Y format (new preferred format)
        if (position.x !== undefined || position.y !== undefined) {
            if (typeof position.x !== 'number') {
                throw new TypeError(`Room '${roomId}' door '${doorName}' position.x must be a number`);
            }
            if (typeof position.y !== 'number') {
                throw new TypeError(`Room '${roomId}' door '${doorName}' position.y must be a number`);
            }
            return;
        }
        // Legacy edge/offset format (backward compatible)
        if (position.edge !== undefined || position.offset !== undefined) {
            const validEdges = ['left', 'right', 'top', 'bottom'];
            if (!validEdges.includes(position.edge)) {
                throw new TypeError(`Room '${roomId}' door '${doorName}' has invalid edge '${position.edge}'`);
            }
            if (typeof position.offset !== 'number' || position.offset < 0 || position.offset > 1) {
                throw new TypeError(`Room '${roomId}' door '${doorName}' offset must be a number between 0 and 1`);
            }
            return;
        }
        throw new TypeError(`Room '${roomId}' door '${doorName}' position must have either { x, y } or { edge, offset }`);
    }

    /**
     * Calculates room-relative spatial coordinates from an edge position definition.
     * Retained for backward compatibility — used by _normalizePosition() to convert
     * legacy edge/offset format to X/Y at initialization time.
     * Why room-relative: Entity spatial coordinates use room center as (0,0), so door
     * positions must be expressed in the same coordinate space for direct assignment.
     * @private
     * @deprecated Only used for backward compatibility with legacy edge/offset data.
     * @param {string} edge - One of 'left', 'right', 'top', 'bottom'.
     * @param {number} offset - Value from 0.0 to 1.0 along the edge.
     * @param {number} width - Room width.
     * @param {number} height - Room height.
     * @returns {{ x: number, y: number }} Room-relative spatial coordinates.
     */
    _calculateEdgePosition(edge, offset, width, height) {
        switch (edge) {
            case 'left':
                return { x: -width / 2, y: offset * height - height / 2 };
            case 'right':
                return { x: width / 2, y: offset * height - height / 2 };
            case 'top':
                return { x: offset * width - width / 2, y: -height / 2 };
            case 'bottom':
                return { x: offset * width - width / 2, y: height / 2 };
            default:
                return { x: 0, y: 0 };
        }
    }

    /**
     * Finds the opposite door in the target room by looking for a reverse connection
     * back to the source room.
     * Why reverse lookup: Doors are independently defined per room, so the only reliable
     * way to find the "opposite" door is to find which door in the target points back.
     * @param {string} sourceRoomId - The UUID of the source room.
     * @param {string} targetRoomId - The UUID of the destination room.
     * @returns {string|null} The door name in the target room that connects back to the source, or null.
     */
    findOppositeDoor(sourceRoomId, targetRoomId) {
        const targetRoom = this.rooms[targetRoomId];
        if (!targetRoom) return null;

        for (const [doorName, target] of Object.entries(targetRoom.connections)) {
            if (target === sourceRoomId) {
                return doorName;
            }
        }
        return null;
    }

    /**
     * Infers the opposite edge from a source door name using naming conventions.
     * Why convention-based: Not all rooms have explicit position data, so we fall back
     * to inferring the entry edge from the exit door name (right -> left, etc.).
     * @private
     * @param {string} doorName - The source door name (e.g., 'right_door').
     * @returns {string|null} The inferred opposite edge, or null if not recognizable.
     */
    _inferOppositeEdge(doorName) {
        const name = doorName.toLowerCase();
        if (name.includes('right')) return 'left';
        if (name.includes('left')) return 'right';
        if (name.includes('top') || name.includes('up')) return 'bottom';
        if (name.includes('bottom') || name.includes('down')) return 'top';
        return null;
    }

    /**
     * Calculates the spawn position in the target room when traversing through a door.
     * Why multi-strategy: Rooms may lack position data or reverse connections, so we
     * provide graceful degradation from explicit data to convention to center default.
     *
     * Strategy:
     * 1. Find the opposite door in the target room (reverse connection).
     *    getDoorPosition() now resolves automatically if no explicit position exists.
     * 2. If found but no position data, fall back to inferred edge position.
     * 3. If no opposite door, fall back to room center.
     *
     * @param {string} sourceRoomId - The UUID of the source room.
     * @param {string|null} sourceDoorName - The door name used (or null for legacy behavior).
     * @param {string} targetRoomId - The UUID of the destination room.
     * @returns {{ x: number, y: number }|null} Room-relative spawn coordinates, or null for legacy center-spawn.
     */
    getSpawnPositionForDoorTraversal(sourceRoomId, sourceDoorName, targetRoomId) {
        // Legacy behavior: no door name provided, return null (caller uses center spawn)
        if (!sourceDoorName) return null;

        const targetRoom = this.rooms[targetRoomId];
        if (!targetRoom) return null;

        // Strategy 1: Find opposite door via reverse connection
        const oppositeDoor = this.findOppositeDoor(sourceRoomId, targetRoomId);
        if (oppositeDoor) {
            const position = this.getDoorPosition(targetRoomId, oppositeDoor);
            if (position) return position;
        }

        // Strategy 2: Infer edge from source door name convention
        const inferredEdge = this._inferOppositeEdge(sourceDoorName);
        if (inferredEdge) {
            return this._calculateEdgePosition(inferredEdge, 0.5, targetRoom.width, targetRoom.height);
        }

        // Strategy 3: Fall back to room center
        Logger.warn(`[RoomsController] No spawn position found for door traversal ${sourceDoorName}: ${sourceRoomId} -> ${targetRoomId}, using room center`);
        return { x: 0, y: 0 };
    }
}

export default RoomsController;

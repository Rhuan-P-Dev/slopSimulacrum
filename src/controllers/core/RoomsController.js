import { generateUID } from '../../utils/idGenerator.js';
import Logger from '../../utils/Logger.js';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';
import { readRegistryFrom } from '../../services/RegistryStore.js';
import {
    assertRoomDefinitions,
    doorPositionErrors,
    roomDefinitionErrors
} from '../../services/WorldStructureRules.js';

/**
 * RoomsController handles the storage and management of rooms and their connections.
 * It serves as the single source of truth for the world's spatial data.
 * 
 * Per wiki/CORE.md: RoomsController is a State Controller (data store only),
 * following the State Ownership vs. Logic Coordination pattern.
 *
 * IT GROWS, ADDITIVELY. The map used to be a boot-time fact: every room came from the
 * `rooms` registry inside this constructor, with a generated uid, and nothing changed it
 * afterwards — an applied package that authored a room only became a room at the next
 * process start. `addRoom`, `connectRooms` and `reconcile` are how the map grows while a
 * world runs (`wiki/decisions/world-structure-authoring.md`), and the one rule all three
 * keep is that **an installed room is never moved, resized, renamed or unlinked**. A room
 * uid is what every entity's `location` holds, what a round's prose already named and
 * what the client drew last frame; rewriting a room that actors stand in is a corruption,
 * not an update. Additive-only is what makes a live map change safe enough to be worth
 * doing without a restart — and it is why a definition that renames or moves a room
 * changes nothing in the running world (it takes effect on the next boot, from the same
 * definition).
 *
 * The shape rules of a room are NOT here: they live in `WorldStructureRules`, because the
 * boot path, the plan/apply classifier and the System's proposal must answer with one set
 * of texts (`CR T-2`).
 */
class RoomsController {
    /**
     * Creates a new RoomsController instance.
     * Loads the room definitions (registry kind `rooms`) and initializes the
     * internal room store.
     * @param {import('../../services/RegistryStore.js').RegistryStore|null} [registries]
     *   The live world definition; null reads the data seam (hand-built in tests).
     */
    constructor(registries = null) {
        // Internal storage for rooms.
        // Format: { roomId: { id, name, surface, acoustic, lightSource, ceiling, condition, power, connections: { doorId: { target: destinationRoomUid } }, x, y, width, height, atmosphere, objects: [], entities: [] } }
        this.rooms = {};
        this.idMap = {}; // Maps logical names to generated UIDs

        // Internal storage for door positions.
        // Format: { roomId: { doorName: { x: number, y: number } } }
        // All positions are normalized to direct X/Y coordinates at initialization time.
        // Stored separately from connections to maintain backward compatibility with existing consumers.
        this.doorPositions = {};

        // Load room definitions from external data file (per DataLoader pattern used by WorldStateController)
        const roomDefinitions = readRegistryFrom(registries, REGISTRY_KINDS.ROOMS);

        // Validate loaded definitions before initialization
        this._validateRoomDefinitions(roomDefinitions);

        // 1. Install every room (uid + record) before any door is resolved, because a
        // door may point at a room declared later in the file.
        for (const [logicalId, data] of Object.entries(roomDefinitions)) {
            this._installRoom(logicalId, data);
        }

        // 2. Map logical connections to the generated UIDs and populate door positions.
        // Supports both string format ("door": "target_room") and object format ("door": { "target": "target_room", "position": {...} })
        // Range is no longer stored on connections; it is computed from the entity's Movement.move stat client-side.
        for (const [logicalId, data] of Object.entries(roomDefinitions)) {
            for (const [door, connectionData] of Object.entries(data.connections)) {
                this._installConnection(logicalId, door, connectionData);
            }
        }

        Logger.info(`[RoomsController] Initialized with ${Object.keys(this.rooms).length} rooms`);
    }

    /**
     * Mint the id of one room and install its record. Shared by the boot pass and by a
     * room added at runtime, so a room that appears mid-world has exactly the record shape
     * every consumer already reads (`objects`, `entities`, the eight atmosphere keys).
     * Validation is the caller's: boot ran the whole-definition pass, `addRoom` runs the
     * single-room pass, and neither re-checks downstream (`CR T-2`).
     * @private
     * @param {string} logicalId - the key the definition uses
     * @param {Object} data - the room definition
     * @returns {string} the generated room uid
     */
    _installRoom(logicalId, data) {
        const uid = generateUID();
        this.idMap[logicalId] = uid;
        this.rooms[uid] = {
            id: uid,
            name: data.name,
            surface: data.surface == null ? null : String(data.surface).trim(),
            acoustic: data.acoustic == null ? null : String(data.acoustic).trim(),
            lightSource: data.lightSource == null ? null : String(data.lightSource).trim(),
            ceiling: data.ceiling == null ? null : String(data.ceiling).trim(),
            condition: data.condition == null ? null : String(data.condition).trim(),
            power: data.power == null ? null : String(data.power).trim(),
            connections: {}, // filled by _installConnection
            x: data.x,
            y: data.y,
            width: data.width,
            height: data.height,
            atmosphere: this._atmosphere(data),
            objects: [],
            entities: []
        };
        this.doorPositions[uid] = {};
        return uid;
    }

    /**
     * Install one door of one installed room: resolve the target logical id to its uid and
     * keep an authored position, normalized to room-relative X/Y.
     *
     * A target that resolves to nothing stays unresolved, exactly as boot has always left
     * it — a dangling door is refused where a *candidate* can be checked against the rest
     * of it (`WorldStructureRules`, run by the classifier), not by the store.
     * @private
     * @param {string} sourceLogicalId
     * @param {string} doorName
     * @param {string|Object} connectionData
     * @returns {{ roomId: string, door: string, target: string|null }|null} null when the source is not installed.
     */
    _installConnection(sourceLogicalId, doorName, connectionData) {
        const uid = this.idMap[sourceLogicalId];
        const source = this.rooms[uid];
        if (!source) return null;

        let targetLogicalId = null;
        let position = null;
        if (typeof connectionData === 'string') {
            // Legacy string format: {"right_door": "right_room"}
            targetLogicalId = connectionData;
        } else if (connectionData && typeof connectionData === 'object') {
            // Object format: {"right_door": {"target": "right_room", "position": {...}}}
            targetLogicalId = connectionData.target;
            if (connectionData.position) {
                position = this._normalizePosition(connectionData.position, source.width, source.height);
            }
        }

        // Store in object-wrapped format (per wiki design)
        source.connections[doorName] = { target: this.idMap[targetLogicalId] };
        if (position) {
            this.doorPositions[uid][doorName] = position;
        }
        return { roomId: uid, door: doorName, target: this.idMap[targetLogicalId] ?? null };
    }

        /**
     * Boot's fast fail on a definition the map cannot be built from (`CR E-8`). The rules
     * themselves live in `WorldStructureRules`, so the boot path, the plan/apply classifier
     * and the System's proposal answer with one set of texts, not three (`CR T-2`).
     * @private
     * @param {Object} defs - Room definitions to validate.
     * @throws {TypeError} the first violation, naming the room and the field.
     */
    _validateRoomDefinitions(defs) {
        assertRoomDefinitions(defs);
    }


    /**
     * Normalizes the room's `atmosphere` block (validated in
     * _validateRoomDefinitions) into the stable shape exposed on the room
     * record: all eight keys always present, each null when absent from the
     * data, so consumers read a deterministic shape. Returns null when the
     * room carries no atmosphere.
     * @private
     * @param {Object|null} def
     * @returns {{ temperature: number|null, lightLevel: string|null, lightColor: string|null, smell: string|null, ambientSound: string|null, humidity: number|null, airQuality: string|null, fog: string|null }|null}
     */
    _atmosphere(def) {
        if (!def || typeof def !== 'object' || def.atmosphere == null || typeof def.atmosphere !== 'object') {
            return null;
        }
        const a = def.atmosphere;
        return {
            temperature: a.temperature == null ? null : Number(a.temperature),
            lightLevel: a.lightLevel == null ? null : String(a.lightLevel),
            lightColor: a.lightColor == null ? null : String(a.lightColor).trim(),
            smell: a.smell == null ? null : String(a.smell),
            ambientSound: a.ambientSound == null ? null : String(a.ambientSound),
            humidity: a.humidity == null ? null : Number(a.humidity),
            airQuality: a.airQuality == null ? null : String(a.airQuality).trim(),
            fog: a.fog == null ? null : String(a.fog).trim()
        };
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
     * True when a logical room key is already installed.
     * @param {string} logicalId
     * @returns {boolean}
     */
    hasLogicalId(logicalId) {
        return Object.prototype.hasOwnProperty.call(this.idMap, logicalId);
    }

    /**
     * The logical key of a room uid, or null. The reverse of `getUidByLogicalId`, and the
     * reader that lets an operator say "connect the new room to `start_room`" while the
     * world runs on uids. A scan, not an index: the map is a handful of rooms and this is
     * an operator-console read, not a turn-loop path (`CR PERF-3`).
     * @param {string} roomId
     * @returns {string|null}
     */
    getLogicalId(roomId) {
        for (const [logicalId, uid] of Object.entries(this.idMap)) {
            if (uid === roomId) return logicalId;
        }
        return null;
    }

    /**
     * The logical keys of every installed room, in the order they were installed.
     * @returns {Array<string>}
     */
    logicalIds() {
        return Object.keys(this.idMap);
    }

    /**
     * Add one room to a running map.
     *
     * The key must be new: an installed room is never redefined here (`this.rooms[uid]` is
     * what actors, broadcasts and the round's prose already named). The definition is
     * checked by the same rules boot checks, so a room that would refuse to load tomorrow
     * is refused now, where the operator still has a conversation to fix it in.
     *
     * @param {string} logicalId - the key the world will read (and what a `worldObjects`
     *   entry or a later package refers to)
     * @param {Object} data - one room definition, the shape the `rooms` registry already uses
     * @returns {{ logicalId: string, roomId: string }}
     * @throws {TypeError} a missing key, a key already taken, or the first rule violation
     */
    addRoom(logicalId, data) {
        if (typeof logicalId !== 'string' || logicalId.trim() === '') {
            throw new TypeError('A room needs a logical id');
        }
        if (this.hasLogicalId(logicalId)) {
            throw new TypeError(`Room '${logicalId}' already exists — an installed room is never redefined`);
        }
        const errors = roomDefinitionErrors(logicalId, data);
        if (errors.length > 0) throw new TypeError(errors[0]);
        const roomId = this._installRoom(logicalId, data);
        Logger.info(`[RoomsController] room '${logicalId}' added as ${roomId}`);
        return { logicalId, roomId };
    }

    /**
     * Open a door between two installed rooms — in **both** directions, because a door
     * that does not lead back is how an actor gets stranded in a room it entered.
     *
     * Additive: an existing door keeps its target and this refuses rather than re-pointing
     * it. Both rooms may be named by uid (what the world uses) or by logical key (what the
     * definition uses).
     *
     * @param {string} fromRoom - uid or logical key of the room the door opens in
     * @param {string} doorName - the door name to open there
     * @param {string} toRoom - uid or logical key of the room it leads to
     * @param {Object} [options]
     * @param {string|null} [options.targetDoorName] - the door opened in the target room
     *   (default `back_to_<doorName>`)
     * @param {Object|null} [options.position] - authored room-relative position of the
     *   source door, `{ x, y }` or the legacy `{ edge, offset }`
     * @returns {{ fromRoomId: string, door: string, toRoomId: string, targetDoor: string }}
     * @throws {TypeError} an unknown room, the same room twice, a door name already used,
     *   or a position the rules refuse
     */
    connectRooms(fromRoom, doorName, toRoom, { targetDoorName = null, position = null } = {}) {
        const fromRoomId = this._resolveRoom(fromRoom);
        const toRoomId = this._resolveRoom(toRoom);
        if (!fromRoomId) throw new TypeError(`No room '${fromRoom}'`);
        if (!toRoomId) throw new TypeError(`No room '${toRoom}'`);
        if (fromRoomId === toRoomId) {
            throw new TypeError(`Room '${fromRoom}' cannot connect to itself`);
        }
        if (typeof doorName !== 'string' || doorName.trim() === '') {
            throw new TypeError('A door needs a name');
        }
        const source = this.rooms[fromRoomId];
        const target = this.rooms[toRoomId];
        if (Object.prototype.hasOwnProperty.call(source.connections, doorName)) {
            throw new TypeError(`Room '${this.getLogicalId(fromRoomId) ?? fromRoomId}' already has a door '${doorName}'`);
        }
        const backDoor = typeof targetDoorName === 'string' && targetDoorName.trim() !== ''
            ? targetDoorName.trim()
            : `back_to_${doorName}`;
        if (Object.prototype.hasOwnProperty.call(target.connections, backDoor)) {
            throw new TypeError(`Room '${this.getLogicalId(toRoomId) ?? toRoomId}' already has a door '${backDoor}'`);
        }
        if (position != null) {
            const positionErrors = doorPositionErrors(position, this.getLogicalId(fromRoomId) ?? fromRoomId, doorName);
            if (positionErrors.length > 0) throw new TypeError(positionErrors[0]);
        }

        this._installDoorBetween(fromRoomId, doorName, toRoomId, position);
        this._installDoorBetween(toRoomId, backDoor, fromRoomId);
        Logger.info(`[RoomsController] door '${doorName}' opened between ${fromRoomId} and ${toRoomId} ('${backDoor}' back)`);
        return { fromRoomId, door: doorName, toRoomId, targetDoor: backDoor };
    }

    /**
     * Point one installed room's door at another installed room — the uid-level form of
     * `_installConnection`, which is the definition-level one (a logical key, an authored
     * position, both connection formats).
     * @private
     * @param {string} fromRoomId
     * @param {string} doorName
     * @param {string} toRoomId
     * @param {Object|null} [position] - authored room-relative position, either format
     */
    _installDoorBetween(fromRoomId, doorName, toRoomId, position = null) {
        const source = this.rooms[fromRoomId];
        source.connections[doorName] = { target: toRoomId };
        if (position) {
            this.doorPositions[fromRoomId][doorName] = this._normalizePosition(position, source.width, source.height);
        }
    }

    /**
     * Grow the map to match a definition: the additive half of a definition swap.
     *
     * Called after a swap that wrote the `rooms` kind, so a room somebody authored (in a
     * package, through the System or by hand) becomes a room the running world has, without
     * a restart. Two passes, for the same reason the constructor is two passes: install
     * every new room first, then resolve doors, so a door may point at a room the same
     * definition declares after it.
     *
     * What it never does: move, resize, rename or re-link an installed room, or remove
     * anything. An authored change to an existing room is therefore reported as ignored in
     * the sense that it stays in the definition and lands on the next boot; a door that is
     * already there keeps its target.
     *
     * A room whose shape the world cannot read is **skipped with its rule text**, not
     * thrown: the definition has already been swapped, and trading a running world for one
     * bad room is the wrong trade (`CR E-1`). The report names every skip.
     *
     * @param {Object} definitions - the `rooms` registry content, as the store holds it
     * @returns {{ added: Array<{logicalId: string, roomId: string}>, doorsAdded: Array<{roomId: string, door: string, target: string|null}>, skipped: Array<{logicalId: string, reason: string}> }}
     */
    reconcile(definitions = {}) {
        const report = { added: [], doorsAdded: [], skipped: [] };
        if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return report;
        const known = Object.keys(definitions);

        // Pass 1 — the new rooms. An existing key is never reinstalled.
        for (const [logicalId, data] of Object.entries(definitions)) {
            if (this.hasLogicalId(logicalId)) continue;
            const errors = roomDefinitionErrors(logicalId, data, { knownLogicalIds: known });
            if (errors.length > 0) {
                report.skipped.push({ logicalId, reason: errors.join('; ') });
                continue;
            }
            const roomId = this._installRoom(logicalId, data);
            report.added.push({ logicalId, roomId });
        }

        // Pass 2 — the doors, including new doors on rooms that were already here.
        for (const [logicalId, data] of Object.entries(definitions)) {
            const roomId = this.idMap[logicalId];
            const room = this.rooms[roomId];
            if (!room || !data || typeof data !== 'object' || !data.connections || typeof data.connections !== 'object') continue;
            for (const [door, connectionData] of Object.entries(data.connections)) {
                if (Object.prototype.hasOwnProperty.call(room.connections, door)) continue; // never re-point
                const targetLogicalId = typeof connectionData === 'string'
                    ? connectionData
                    : (connectionData && typeof connectionData === 'object' ? connectionData.target : null);
                if (!this.hasLogicalId(targetLogicalId)) {
                    report.skipped.push({ logicalId, reason: `connection '${door}' targets unknown room '${targetLogicalId}'` });
                    continue;
                }
                const installed = this._installConnection(logicalId, door, connectionData);
                if (installed) report.doorsAdded.push({ roomId, door, target: installed.target });
            }
        }

        if (report.added.length > 0 || report.doorsAdded.length > 0 || report.skipped.length > 0) {
            Logger.info(
                `[RoomsController] reconcile: ${report.added.length} room(s) added, `
                + `${report.doorsAdded.length} door(s) opened, ${report.skipped.length} skipped`
            );
        }
        return report;
    }

    /**
     * Resolve a room given either way — uid or logical key — to the uid. Null when neither.
     * @private
     * @param {string} room
     * @returns {string|null}
     */
    _resolveRoom(room) {
        if (typeof room !== 'string' || room.trim() === '') return null;
        if (this.rooms[room]) return room;
        return this.getUidByLogicalId(room);
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

        const connection = room.connections[doorName];
        const targetRoomId = typeof connection === 'object' ? connection.target : connection;
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

        for (const [doorName, conn] of Object.entries(targetRoom.connections)) {
            const target = typeof conn === 'object' ? conn.target : conn;
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

    /**
     * Retrieves the target room UUID for a specific door connection.
     * Why this is the designated accessor: Centralizes connection object format handling
     * so callers never need to know whether connections are strings or objects.
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
        return typeof connection === 'object' ? connection.target : connection;
    }
}

export default RoomsController;

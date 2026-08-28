/**
 * ContextResolution — stateless, pure helpers for resolving room exits.
 *
 * Shared by BOTH the LLM text layer (LlmContextController) and the frontend
 * event-panel route (worldEventRoutes) so the "which door leads to which
 * room" logic lives in exactly one place. These helpers take the UID-keyed
 * rooms map (as returned by `WorldStateController.getRooms()`) as an
 * argument and never read world state themselves, so they are trivially
 * testable in isolation.
 *
 * @module ContextResolution
 */

/**
 * Fallback room name used when an exit's target UID cannot be resolved in
 * the rooms map (dangling connection). Mirrors the "unknown" token the
 * rest of the spatial context uses for unresolvable rooms.
 * @type {string}
 */
export const UNRESOLVED_ROOM_NAME = 'unknown';

/**
 * Resolves an exit connection to its target room's display name.
 *
 * A room's `connections[door]` entry stores the target either as an object
 * (`{ target: <roomUid> }`) or, in legacy/defensive cases, as the target
 * UID string itself. This helper normalizes both shapes and looks the
 * target up in the UID-keyed rooms map.
 *
 * @param {Object<string, Object>} rooms - UID-keyed rooms map (from `getRooms()`).
 * @param {Object|string|null} conn - The connection value for a door.
 * @returns {string} The target room's name, or {@link UNRESOLVED_ROOM_NAME}
 *   when the target UID is missing or not present in the rooms map.
 */
export function resolveExitTargetRoomName(rooms, conn) {
    const targetUid = (conn && typeof conn === 'object') ? conn.target : conn;
    const targetRoom = targetUid ? rooms[targetUid] : null;
    return targetRoom?.name || UNRESOLVED_ROOM_NAME;
}

/**
 * Builds the resolved exits list for a room, capped at `maxExits`.
 *
 * Each entry pairs a door name with its resolved target room name so both
 * the LLM prompt and the frontend event panel can render "door → room"
 * without re-deriving the UID→name lookup.
 *
 * @param {Object<string, Object>} rooms - UID-keyed rooms map (from `getRooms()`).
 * @param {Object} room - A single room record (must carry `connections`).
 * @param {number} maxExits - Safety cap on the number of exits returned.
 * @returns {Array<{ door: string, targetRoomName: string }>}
 *   One entry per door (up to `maxExits`), each with the resolved target name.
 */
export function resolveRoomExits(rooms, room, maxExits) {
    return Object.entries(room.connections || {})
        .slice(0, maxExits)
        .map(([door, conn]) => ({
            door,
            targetRoomName: resolveExitTargetRoomName(rooms, conn)
        }));
}

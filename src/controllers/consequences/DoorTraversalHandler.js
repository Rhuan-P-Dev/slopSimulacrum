import Logger from '../../utils/Logger.js';

/**
 * Consequence handler for the `crossDoor` action (`traverseDoor` consequence):
 * walk an entity through one door of the room it is standing in, into the room
 * that door leads to.
 *
 * Owns: resolving the named door against the actor's CURRENT room
 * (`rooms[location].connections`, data/mods/core-rooms/rooms.json) and asking
 * the facade for the state change. Everything below that is somebody else's:
 * `RoomsController.getConnectionTarget` owns the connection-shape handling,
 * `WorldStateController.moveEntity` owns the door-to-door spawn position
 * (`getSpawnPositionForDoorTraversal`) and marks BOTH rooms perception-dirty,
 * and the action's data declares the Movement.move requirement that gates it.
 *
 * WHY there is no `log` consequence beside this one in the action data:
 * consequences run independently of each other, so a data-driven log line would
 * announce the crossing even when this handler rejected the door — a sentence
 * in the world-event stream that the world never acted on. The tool result (the
 * agent) and the perception diff of the two rooms (everyone else) carry the
 * truth instead.
 *
 * The handler validates its own inputs, mirroring `handlePlaceMachine`: the
 * same code path serves the LLM tool, the queued turn resolution and a direct
 * `executeAction` call, so no caller gets a free pass.
 *
 * @module DoorTraversalHandler
 */

/**
 * Carries an unresolved template token through from the action data
 * (`":door"` when the caller passed no door at all). Same guard the machine
 * handlers use — a token is never a door name.
 * @type {RegExp}
 */
const UNRESOLVED_TOKEN = /^:[a-zA-Z0-9_.]+$/;

/**
 * Moves `params.entityId` through `params.door`.
 *
 * @param {Object} deps
 * @param {WorldStateController} deps.worldStateController - The world facade.
 * @param {Object} params - Resolved consequence params
 *   (`{ entityId, door }`, from the action data's `:entityId` / `:door` templates).
 * @returns {{ success: boolean, message: string, data: Object|null }}
 */
export function handleDoorTraversal(deps, params) {
    const { worldStateController } = deps;
    if (!worldStateController) return { success: false, message: 'WorldStateController not available.', data: null };

    const entityId = params?.entityId;
    let door = params?.door;
    if (typeof door === 'string' && UNRESOLVED_TOKEN.test(door)) door = null;

    if (!entityId) return { success: false, message: 'Missing entityId.', data: null };
    if (typeof door !== 'string' || door.trim() === '') {
        return { success: false, message: 'Missing door name.', data: null };
    }

    const entity = worldStateController.getEntity(entityId);
    if (!entity) return { success: false, message: `Entity "${entityId}" not found.`, data: null };

    // The door belongs to the room the actor is IN — the model never names a
    // destination, so it can never send an entity through a door that is not
    // under its own feet.
    const fromRoomId = entity.location;
    const targetRoomId = worldStateController.roomsController?.getConnectionTarget?.(fromRoomId, door) ?? null;
    if (!targetRoomId) {
        return { success: false, message: `No door "${door}" in room "${fromRoomId}".`, data: null };
    }

    const moved = worldStateController.moveEntity(entityId, targetRoomId, { sourceDoor: door });
    if (!moved) {
        Logger.warn(`[DoorTraversalHandler] moveEntity refused ${entityId}: ${fromRoomId} -> ${targetRoomId} via "${door}"`);
        return { success: false, message: `Could not move "${entityId}" through "${door}".`, data: null };
    }

    const spatial = worldStateController.getEntity(entityId)?.spatial ?? null;
    return {
        success: true,
        message: `Crossed door "${door}"`,
        data: { door, fromRoomId, toRoomId: targetRoomId, spatial }
    };
}

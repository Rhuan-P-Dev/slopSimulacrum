import Logger from '../../utils/Logger.js';

/**
 * Consequence handler for the `crossDoor` action (`traverseDoor` consequence):
 * walk an entity through one door of the room it is standing in, into the room
 * that door leads to.
 *
 * Owns: resolving the named door against the actor's CURRENT room
 * (`rooms[location].connections`, data/mods/core-rooms/rooms.json), the REACH
 * rule (`measureDoorReach` — the droid must be standing at the door), and asking
 * the facade for the state change. Everything below that is somebody else's:
 * `RoomsController.getConnectionTarget` owns the connection-shape handling,
 * `RoomsController.getDoorPosition` owns the door geometry,
 * `WorldStateController.moveEntity` owns the door-to-door spawn position
 * (`getSpawnPositionForDoorTraversal`) and marks BOTH rooms perception-dirty,
 * and `data/mods/core-actions/actions.json` declares the `range` the reach rule
 * measures against (the single source of that number — the same field the
 * get_actions line prints as `range 50`).
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
 * `executeAction` call, so no caller gets a free pass — and that is why the
 * reach rule is enforced HERE rather than only at the agent seam.
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
 * Measures how far an entity stands from one of its room's doors, and whether
 * that is close enough to cross.
 *
 * Both numbers are resolved server-side — the door position from the room
 * geometry, the threshold from the action's own declared `range` — so a caller
 * can never reach a door by naming a coordinate of its own.
 *
 * Shared by the handler (the world's answer, every caller) and the agent's
 * `use_door` pre-validation (the same verdict before the model spends one of
 * its per-round actions), so there is exactly one reach rule.
 *
 * @param {Object} args
 * @param {Object} args.worldStateController - The world facade.
 * @param {Object} args.entity - The actor record (needs `location` and `spatial`).
 * @param {string} args.door - The door name.
 * @param {string} args.actionName - The action whose declared `range` is the threshold.
 * @returns {{ distance: number, reach: number, reachable: boolean }|null}
 *   Null when there is nothing to enforce: no declared range, or a door/entity
 *   position the world cannot resolve (a door whose target room is missing is
 *   refused by the crossing itself).
 */
export function measureDoorReach({ worldStateController, entity, door, actionName }) {
    const reach = worldStateController?.getActionRegistry?.()?.[actionName]?.range;
    const here = entity?.spatial;
    if (typeof reach !== 'number' || !Number.isFinite(here?.x) || !Number.isFinite(here?.y)) return null;

    const doorPos = worldStateController?.getDoorPosition?.(entity.location, door);
    if (!doorPos || !Number.isFinite(doorPos.x) || !Number.isFinite(doorPos.y)) return null;

    const distance = Math.hypot(doorPos.x - here.x, doorPos.y - here.y);
    return { distance, reach, reachable: distance <= reach };
}

/**
 * Moves `params.entityId` through `params.door`.
 *
 * @param {Object} deps
 * @param {WorldStateController} deps.worldStateController - The world facade.
 * @param {Object} params - Resolved consequence params
 *   (`{ entityId, door }`, from the action data's `:entityId` / `:door` templates).
 * @param {Object} [context] - Action execution context; `context.actionName`
 *   names the action whose declared `range` bounds the reach rule.
 * @returns {{ success: boolean, message: string, data: Object|null }}
 */
export function handleDoorTraversal(deps, params, context) {
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

    // Reach: a door is a place, not a spell — the droid has to walk to it.
    const verdict = measureDoorReach({ worldStateController, entity, door, actionName: context?.actionName });
    if (verdict && !verdict.reachable) {
        return {
            success: false,
            message: `Door "${door}" is ${Math.round(verdict.distance)} units away — stand at it first (reach ${verdict.reach}).`,
            data: null
        };
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

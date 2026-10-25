import Logger from '../../utils/Logger.js';

/**
 * Clamps a world position to a room's bounds (0..width, 0..height). If the room is
 * unknown, the value is clamped to a generous default so a bad client coordinate can
 * never place a machine at a nonsense position.
 * @param {Object} worldStateController
 * @param {string} roomUid
 * @param {{x:number, y:number}} pos
 * @returns {{x:number, y:number}}
 */
function clampToRoom(worldStateController, roomUid, pos) {
  let x = Number.isFinite(pos?.x) ? pos.x : 0;
  let y = Number.isFinite(pos?.y) ? pos.y : 0;
  const room = worldStateController.roomsController?.getRoom?.(roomUid);
  const w = room && Number.isFinite(room.width) ? room.width : 200;
  const h = room && Number.isFinite(room.height) ? room.height : 200;
  x = Math.max(0, Math.min(w, x));
  y = Math.max(0, Math.min(h, y));
  return { x, y };
}

/**
 * Consequence handler for the `placeMachine` action: materializes a carried machine
 * item as a functional world entity at a player-chosen position.
 *
 * The item form (e.g. `knifeGenerator`) is looked up in the machine registry to find
 * the blueprint to spawn. On success the item is consumed and an `isStatic` entity is
 * created in the player's room at the chosen position — `isStatic` excludes it from the
 * turn roster (it never stalls the planning barrier), while its self-sustaining organ
 * is still ticked by `processTurnEffects` every round (see wiki/subMDs/systems/
 * machine_system.md). The entity is tagged (`isMachine`, `machineType`, `placedBy`) so
 * the `retrieveMachine` action can find and reclaim it.
 *
 * The handler runs its OWN validation (item is a machine, is in inventory, spawnable),
 * mirroring DropItemHandler — so both the immediate REST route and the queued
 * /execute-action path behave identically.
 */
export function handlePlaceMachine(deps, params) {
  const { worldStateController, machineRegistry } = deps;
  if (!worldStateController) return { success: false, message: 'WorldStateController not available.' };

  const { entityId, targetX, targetY } = params;
  let itemId = params.itemId;
  let itemType = params.itemType;
  // Guard against unresolved placeholder tokens (":itemId") leaking through the
  // execute_action template when the agent did not provide a concrete value.
  if (typeof itemId === 'string' && /^:[a-zA-Z0-9_.]+$/.test(itemId)) itemId = null;
  if (typeof itemType === 'string' && /^:[a-zA-Z0-9_.]+$/.test(itemType)) itemType = null;
  if (!entityId) return { success: false, message: 'Missing entityId.' };
  if (!itemId && !itemType) return { success: false, message: 'Missing itemId or itemType.' };

  const entity = worldStateController.getEntity(entityId);
  if (!entity) return { success: false, message: 'Entity not found.' };

  // Locate the machine item instance: by itemId if named (REST/player path),
  // otherwise by itemType (the agent path, which names the carried machine type
  // and lets the server resolve the instance). Equipped slot is checked first,
  // then the inventory; first match wins.
  let found = null;
  const equippedItems = worldStateController.getEquippedItems(entityId) || [];
  const inventory = worldStateController.getEntityItems(entityId) || {};
  if (itemId) {
    for (const eq of equippedItems) {
      if (eq.itemId === itemId) { found = eq; break; }
    }
    if (!found) {
      for (const items of Object.values(inventory)) {
        const it = (items || []).find(i => i && i.id === itemId);
        if (it) { found = it; break; }
      }
    }
  }
  if (!found && itemType) {
    for (const eq of equippedItems) {
      if (eq.itemType === itemType) { found = eq; break; }
    }
    if (!found) {
      for (const items of Object.values(inventory)) {
        const it = (items || []).find(i => i && i.type === itemType);
        if (it) { found = it; break; }
      }
    }
  }
  if (!found) return {
    success: false,
    message: `Machine item not found in inventory (itemId=${itemId || 'none'}, itemType=${itemType || 'none'}).`
  };

  // The item's actual type must be a registered machine (authoritative: use the
  // instance's own type, not any caller hint, to prevent a type/instance mismatch).
  const resolvedType = found.type || found.itemType || itemType;
  const machine = machineRegistry ? machineRegistry.machineForItem(resolvedType) : null;
  if (!machine) return { success: false, message: `Item "${resolvedType}" is not a placeable machine.` };

  // Consume the item before materializing (use the resolved instance's id so both
  // the itemId path and the itemType path remove the right item).
  const itemKey = found.id || found.itemId;
  const removeResult = worldStateController.removeItemFromEntity(entityId, itemKey);
  if (!removeResult.success) return { success: false, message: removeResult.message };

  // Spawn the machine entity in the player's room, tagged as a placed machine.
  const blueprints = worldStateController.entityController?.getBlueprints?.() || {};
  if (!blueprints[machine.blueprint]) {
    return { success: false, message: `Unknown blueprint "${machine.blueprint}".` };
  }
  const newEntityId = worldStateController.stateEntityController.spawnEntity(machine.blueprint, entity.location, {
    isStatic: true,
    name: machine.name,
    isMachine: true,
    machineType: machine.type,
    placedBy: entityId,
  });
  if (!newEntityId) return { success: false, message: 'Machine spawn failed.' };

  // Position at the chosen coordinates (clamped to the room bounds).
  const base = entity.spatial || {};
  const pos = clampToRoom(worldStateController, entity.location, {
    x: typeof targetX === 'number' ? targetX : (base.x || 0),
    y: typeof targetY === 'number' ? targetY : (base.y || 0),
  });
  worldStateController.stateEntityController.updateEntitySpatial(newEntityId, pos);

  // Perception choke point: mark the room dirty so this placement surfaces in
  // the room's perception on the next flush. The diff reports it from the
  // entity's machine tag (set above at the spawn choke point): who placed it
  // and where.
  worldStateController._markPerceptionDirty?.(entity.location);
  Logger.info(`[PlaceMachineHandler] ${entityId} placed machine "${machine.name}" (${newEntityId}) at (${pos.x}, ${pos.y}).`);
  return { success: true, machineEntityId: newEntityId, position: { x: pos.x, y: pos.y }, machine: machine.name };
}

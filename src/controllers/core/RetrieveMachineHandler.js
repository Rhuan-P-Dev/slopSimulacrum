import Logger from '../../utils/Logger.js';
import { getDefinitionFootprint } from '../../utils/definitionVolume.js';
import { writeDroppedItem } from '../consequences/DropItemHandler.js';

// Default grab range for retrieving a placed machine (mirrors the pickUpItem range).
// A direct route (not the action queue), so the range is a constant here rather than
// read from the action registry.
const RETRIEVE_RANGE = 50;

/**
 * Finds the player's inventory component with the most free volume that can fit an
 * item of the given footprint. Returns the componentId, or null if no component can.
 * @param {Object} worldStateController
 * @param {Object} entity - The player entity (live reference).
 * @param {number} footprint - The item's host footprint (volume it occupies).
 * @returns {string|null}
 */
function findBestComponentForItem(worldStateController, entity, footprint) {
  const im = worldStateController.inventoryManager;
  if (!im) return null;
  const inventory = im.getEntityItems(entity) || {};
  let bestCompId = null;
  let bestFree = -1;
  for (const compId of Object.keys(inventory)) {
    const free = im.getAvailableVolume(entity, compId);
    if (free >= footprint && free > bestFree) {
      bestFree = free;
      bestCompId = compId;
    }
  }
  return bestCompId;
}

/**
 * Spills one stored item to the floor, trying the base position then a 3x3 grid of
 * nearby slots so a crowded floor does not silently lose the item (writeDroppedItem
 * refuses duplicate writes to an occupied slot).
 * @returns {boolean} true if the item was written to the floor.
 */
function spillItem(worldStateController, itemType, baseX, baseY, roomUid, ownerId, itemDef, nestedItems) {
  for (let dy = 0; dy <= 2; dy++) {
    for (let dx = 0; dx <= 2; dx++) {
      if (writeDroppedItem(worldStateController, itemType, baseX + dx, baseY + dy, roomUid, ownerId, itemDef, nestedItems)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Consequence/route handler for "retrieve a placed machine": despawns a machine entity
 * the player placed earlier and returns the machine item to the player's inventory.
 *
 * Safety contract (nothing is ever lost):
 *   - The machine's stored contents (e.g. the knives a generator has forged into its
 *     belly) are spilled to the floor at the machine's position BEFORE it is despawned,
 *     so the player can still pick them up.
 *   - The machine item itself is re-added to the player's inventory (best-fit component).
 *
 * The handler runs its OWN validation (target is a placed machine, same room, in range,
 * inventory has room) so the direct REST route and any future queued path behave
 * identically.
 */
export function handleRetrieveMachine(deps, params) {
  const { worldStateController, machineRegistry } = deps;
  if (!worldStateController) return { success: false, message: 'WorldStateController not available.' };

  const { entityId, targetEntityId } = params;
  if (!entityId || !targetEntityId) return { success: false, message: 'Missing entityId or targetEntityId.' };

  const player = worldStateController.getEntity(entityId);
  const machine = worldStateController.getEntity(targetEntityId);
  if (!player) return { success: false, message: 'Entity not found.' };
  if (!machine) return { success: false, message: 'Machine not found (it may have been destroyed or already retrieved).' };

  // The target must be a placed machine (tagged at place time).
  if (machine.isMachine !== true) return { success: false, message: 'Target is not a placed machine.' };

  const machineKey = machine.machineType || params.machineType;
  const machineDef = machineRegistry ? machineRegistry.getMachine(machineKey) : null;
  if (!machineDef) return { success: false, message: `Unknown machine type "${machineKey}".` };

  // Same-room gate.
  if (player.location !== machine.location) return { success: false, message: 'Machine is in a different room.' };

  // Range gate.
  const dx = (machine.spatial?.x || 0) - (player.spatial?.x || 0);
  const dy = (machine.spatial?.y || 0) - (player.spatial?.y || 0);
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance > RETRIEVE_RANGE) return { success: false, message: `Machine out of range (${distance.toFixed(1)} > ${RETRIEVE_RANGE}).` };

  // Captured before the despawn below: the machine's room is what we mark
  // dirty for perception. The machine's last-seen snapshot keeps its machine
  // tag, so the diff can report the retrieval with who placed it and where
  // it stood.
  const machineRoom = machine.location ?? null;

  // Spill the machine's stored items to the floor before despawning (nothing is lost).
  const itemRegistry = worldStateController.getItemRegistry?.() || {};
  const storedItems = Array.isArray(machine.items) ? [...machine.items] : [];
  const machinePos = machine.spatial || { x: 0, y: 0 };
  let spilled = 0;
  for (const it of storedItems) {
    if (spillItem(worldStateController, it.type, machinePos.x, machinePos.y, machine.location, entityId, itemRegistry[it.type] || {}, it.nestedItems)) {
      spilled++;
    }
  }

  // Despawn the machine entity (cleans up its organs, removes it from the world and the
  // capability cache).
  worldStateController.despawnEntity(targetEntityId);

  // Re-add the machine item to the player's inventory (best-fit component).
  const itemDef = itemRegistry[machineDef.itemKey] || {};
  const footprint = getDefinitionFootprint(itemDef);
  const bestCompId = findBestComponentForItem(worldStateController, player, footprint);
  if (!bestCompId) return { success: false, message: 'No room in your inventory to carry the machine (free some space first).' };
  const addResult = worldStateController.addItemToEntity(entityId, machineDef.itemKey, bestCompId);
  if (!addResult.success) return { success: false, message: addResult.message };

  if (spilled < storedItems.length) {
    Logger.warn(`[RetrieveMachineHandler] ${spilled}/${storedItems.length} stored item(s) from "${machineDef.name}" spilled; the rest could not be placed on a free floor slot.`);
  }
  // Perception choke point: mark the room dirty so the retrieval (and the
  // floor spill above) surfaces in the room's perception on the next flush.
  // Both rooms are marked: the machine's and the player's (the same room in
  // practice — the range gate requires it — but the mark is idempotent).
  worldStateController._markPerceptionDirty?.(machineRoom);
  worldStateController._markPerceptionDirty?.(player.location);
  Logger.info(`[RetrieveMachineHandler] ${entityId} retrieved machine "${machineDef.name}" (${targetEntityId}); ${spilled} stored item(s) returned to the floor.`);
  return {
    success: true,
    message: `Retrieved ${machineDef.name}.`,
    retrieved: { itemType: machineDef.itemKey, name: machineDef.name },
    spilled
  };
}

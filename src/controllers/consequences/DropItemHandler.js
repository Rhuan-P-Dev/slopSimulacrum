/**
 * DropItemHandler — Handles dropping items at spatial coordinates.
 *
 * Single Responsibility: Remove an equipped item from a component and place it
 * at a world coordinate so other entities can pick it up.
 *
 * Extracted from ConsequenceDispatcher to adhere to the Single Responsibility Principle.
 *
 * §4.4: `writeDroppedItem` helper exported for reuse by handleDropItem,
 * KnifeDropTriggerHandler, and BrokenComponentRemovalHandler spill.
 *
 * @module DropItemHandler
 */

import Logger from '../../utils/Logger.js';
import { generateItemId } from '../../utils/idGenerator.js';

/**
 * Writes a dropped item record to the droppedItems map.
 * §4.4: extracted from handleDropItem, parameterized by nestedItems (default []).
 *
 * @param {Object} worldState - Narrow-deps stub (not the full façade), implementing only:
 *   `getDroppedItems(): object` — returns the dropped-items map;
 *   `setDroppedItems(items: object)` — merges `items` into the map via Object.assign (batch accumulation).
 *   The handler must not assume other WorldStateController methods exist on this dependency.
 * @param {string} itemType - The item type string.
 * @param {number} x - X coordinate.
 * @param {number} y - Y coordinate.
 * @param {string|null} roomId - Room ID for the dropped item.
 * @param {string|null} ownerId - Owner entity ID.
 * @param {Object} [itemDef={}] - Item registry definition (name, description, volume).
 * @param {Array} [nestedItems=[]] - Nested items snapshot (default []).
 * @returns {{ id: string, droppedItemId: string }}
 */
function writeDroppedItem(worldStateController, itemType, x, y, roomId, ownerId, itemDef = {}, nestedItems = []) {
    // Defensive guard: reject falsy itemType to prevent silent junk entries.
    if (!itemType) {
        const entityId = ownerId || 'unknown';
        Logger.warn(`[DropItemHandler] writeDroppedItem called with falsy itemType for entity ${entityId}; aborting.`);
        return;
    }

    // FASE 9: ID gerado via generateItemId() + crypto.randomUUID() para unicidade.
    const itemId = generateItemId();
    
    // FASE 9: usar itemDef passado (sem re-fetch que o sobrescreve)
    const def = itemDef || {};

    // Store dropped item at world coordinates
    const droppedItems = worldStateController.getDroppedItems() || {};
    const droppedItemId = `dropped-${crypto.randomUUID().slice(0, 12)}-${itemId.slice(0, 8)}`;
    droppedItems[droppedItemId] = {
        id: droppedItemId,
        itemType: itemType,
        itemId: itemId,
        x: x,
        y: y,
        roomId: roomId ?? 'unassigned',
        ownerId: ownerId,
        name: def.name || itemType,
        description: def.description || '',
        volume: def.volume ?? 1,
        nestedItems: nestedItems
    };

    // §3.5.3: gatear broadcast por cascata — setDroppedItems gatinga internamente
    worldStateController.setDroppedItems(droppedItems);
    return { id: itemId, droppedItemId };
}

/**
 * Handles the "dropItem" consequence type.
 *
 * @param {Object} deps - Dependencies injected by ConsequenceDispatcher
 * @param {Object} deps.worldStateController - WorldStateController for state access
 * @param {Object} params - Consequence parameters
 * @param {string} params.entityId - The entity dropping the item
 * @param {string} params.itemId - The item ID to drop
 * @param {string} params.itemType - The item type
 * @param {number} params.targetX - Target X coordinate
 * @param {number} params.targetY - Target Y coordinate
 * @param {Object} context - Action execution context
 * @param {Object} context.entityId - The entity executing the action
 * @returns {{ success: boolean, message?: string }}
 */
function handleDropItem(deps, params, context) {
    const { worldStateController } = deps;

    if (!worldStateController) {
        Logger.error('[DropItemHandler] WorldStateController not available.');
        return { success: false, message: 'WorldStateController not available.' };
    }

    const { entityId, itemId, itemType, targetX, targetY } = params;

    // Validate required parameters
    if (!entityId) {
        Logger.warn('[DropItemHandler] Missing entityId for dropItem.');
        return { success: false, message: 'Missing entityId.' };
    }

    if (!itemId) {
        Logger.warn('[DropItemHandler] Missing itemId for dropItem.');
        return { success: false, message: 'Missing itemId.' };
    }

    const entity = worldStateController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[DropItemHandler] Entity "${entityId}" not found for dropItem.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    // Check if the item is equipped
    const equippedItems = worldStateController.getEquippedItems(entityId);
    const equippedItem = equippedItems?.find(eq => eq.itemId === itemId);

    // If equipped, unequip it first
    let usedItemType = itemType;
    if (equippedItem) {
        const unequipResult = worldStateController.unequipItem(entityId, itemId);
        if (!unequipResult.success) {
            Logger.warn(`[DropItemHandler] Failed to unequip item "${itemId}" from entity "${entityId}": ${unequipResult.message}`);
            return { success: false, message: `Failed to unequip: ${unequipResult.message}` };
        }
        usedItemType = usedItemType || equippedItem.itemType;
    } else {
        // Item is in inventory but not equipped — check inventory exists
        // getEntityItems() returns { componentId: [item1, item2] } — need to flatten
        const inventory = worldStateController.getEntityItems(entityId);
        const allItems = Object.values(inventory).flat();
        const foundItem = allItems?.find(invItem => invItem.id === itemId);
        if (!foundItem) {
            Logger.warn(`[DropItemHandler] Item "${itemId}" not found in inventory or equipped items on entity "${entityId}".`);
            return { success: false, message: `Item "${itemId}" not found.` };
        }
        usedItemType = usedItemType || foundItem.type;
    }

    // Collect all nested items from the container before removal.
    // This preserves the contents so they can be restored on pickup.
    const entityBefore = worldStateController.getEntity(entityId);
    const nestedItems = entityBefore
        ? worldStateController.inventoryManager._collectNestedItems(entityBefore, itemId)
        : [];

    // Remove item from the entity's inventory (this also removes descendants)
    const inventoryResult = worldStateController.removeItemFromEntity(entityId, itemId);
    if (!inventoryResult.success) {
        Logger.warn(`[DropItemHandler] Failed to remove item "${itemId}" from entity "${entityId}": ${inventoryResult.message}`);
        return { success: false, message: `Failed to remove item: ${inventoryResult.message}` };
    }

    // Fetch item definition for fallback
    const itemRegistry = worldStateController.getItemRegistry();
    const itemDef = itemRegistry[usedItemType] || {};

    // Use extracted helper to write the dropped item record
    const { droppedItemId } = writeDroppedItem(
        worldStateController,
        usedItemType,
        targetX,
        targetY,
        entity.location || null,
        entityId,
        itemDef,
        nestedItems
    );

    Logger.info(`[DropItemHandler] Dropped item "${usedItemType}" (${itemId}) at (${targetX}, ${targetY}) with ${nestedItems.length} nested item(s).`);
    return { success: true, droppedItemId };
}

/**
 * Validates the drop item params.
 *
 * @param {Object} params - The params to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateParams(params) {
    if (!params || typeof params !== 'object') {
        return { valid: false, error: 'Params must be an object.' };
    }

    if (typeof params.entityId !== 'string' || params.entityId.trim() === '') {
        return { valid: false, error: 'entityId must be a non-empty string.' };
    }

    if (typeof params.itemId !== 'string' || params.itemId.trim() === '') {
        return { valid: false, error: 'itemId must be a non-empty string.' };
    }

    if (typeof params.targetX !== 'number' || typeof params.targetY !== 'number') {
        return { valid: false, error: 'targetX and targetY must be numbers.' };
    }

    return { valid: true };
}

export { handleDropItem, validateParams, writeDroppedItem };

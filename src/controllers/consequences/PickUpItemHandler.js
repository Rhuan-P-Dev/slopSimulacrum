/**
 * PickUpItemHandler — Handles picking up dropped items from world map coordinates.
 *
 * Single Responsibility: Retrieve a dropped item from world coordinates and add it
 * to an entity's inventory component, respecting volume constraints.
 *
 * Extracted from ConsequenceDispatcher to adhere to the Single Responsibility Principle.
 *
 * @module PickUpItemHandler
 */

import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import { PICK_UP_RANGE_FALLBACK, recoverChunkMaterial } from '../../utils/Constants.js';
import { resolveRange } from '../../../shared/RangeResolver.js';
import { ACTION_NAMES } from '../../../shared/ActionVocabulary.js';
import { DEFAULT_ITEM_VOLUME } from '../../../shared/Defaults.js';

/**
 * Handles the "pickUpItem" consequence type for dropped items.
 *
 * @param {Object} deps - Dependencies injected by ConsequenceDispatcher
 * @param {Object} deps.worldStateController - WorldStateController for state access
 * @param {Object} params - Consequence parameters
 * @param {string} params.entityId - The entity picking up the item
 * @param {string} params.droppedItemId - The dropped item ID to pick up
 * @param {string} params.componentId - The component ID to attach the item to
 * @param {Object} context - Action execution context
 * @param {Object} context.entityId - The entity executing the action
 * @returns {{ success: boolean, message?: string, pickedUpItem?: Object }}
 */
function handlePickUpItem(deps, params, context) {
    const { worldStateController } = deps;

    if (!worldStateController) {
        Logger.error('[PickUpItemHandler] WorldStateController not available.');
        return { success: false, message: 'WorldStateController not available.' };
    }

    const { entityId, droppedItemId, componentId } = params;

    // Validate required parameters
    if (!entityId) {
        Logger.warn('[PickUpItemHandler] Missing entityId for pickUpItem.');
        return { success: false, message: 'Missing entityId.' };
    }

    if (!droppedItemId) {
        Logger.warn('[PickUpItemHandler] Missing droppedItemId for pickUpItem.');
        return { success: false, message: 'Missing droppedItemId.' };
    }

    if (!componentId) {
        Logger.warn('[PickUpItemHandler] Missing componentId for pickUpItem.');
        return { success: false, message: 'Missing componentId.' };
    }

    // Get dropped items and find the target
    const droppedItems = worldStateController.getDroppedItems() || {};
    const droppedItem = droppedItems[droppedItemId];

    if (!droppedItem) {
        Logger.warn(`[PickUpItemHandler] Dropped item "${droppedItemId}" not found.`);
        return { success: false, message: `Dropped item "${droppedItemId}" not found.` };
    }

    // Check if the entity exists
    const entity = worldStateController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[PickUpItemHandler] Entity "${entityId}" not found for pickUpItem.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    // Check if the component exists and belongs to the entity
    const component = worldStateController.getComponent(componentId);
    if (!component) {
        Logger.warn(`[PickUpItemHandler] Component "${componentId}" not found for pickUpItem.`);
        return { success: false, message: `Component "${componentId}" not found.` };
    }

    if (component.entityId !== entityId) {
        Logger.warn(`[PickUpItemHandler] Component "${componentId}" does not belong to entity "${entityId}".`);
        return { success: false, message: `Component "${componentId}" does not belong to entity "${entityId}".` };
    }

    // Verify the entity and dropped item are in the same room
    const entityRoomId = entity.location || null;
    const itemRoomId = droppedItem.roomId || null;
    if (entityRoomId !== itemRoomId) {
        Logger.warn(`[PickUpItemHandler] Entity "${entityId}" is in room "${entityRoomId}" but item "${droppedItemId}" is in room "${itemRoomId}".`);
        return { success: false, message: `Item is in a different room. Entity is in "${entityRoomId}", item is in "${itemRoomId}".` };
    }

    // Verify range before allowing pickup
    const droidX = entity.spatial?.x || 0;
    const droidY = entity.spatial?.y || 0;
    const itemX = droppedItem.x || 0;
    const itemY = droppedItem.y || 0;
    const distance = Math.sqrt(Math.pow(itemX - droidX, 2) + Math.pow(itemY - droidY, 2));

    // WHY: the pickup range is data-driven — it resolves against the
    // pickUpItem action definition in actions.json (currently 50). The old
    // hardcoded 100 was a copy of dropItem's range and let entities pick up
    // items far beyond what the action definition allows. The shared
    // RangeResolver is the single source of truth (mirrors RangeValidator /
    // ReachabilityRule): numeric ranges pass through, string expressions are
    // resolved against the entity's stat map, and PICK_UP_RANGE_FALLBACK only
    // fires when the action definition or its range field is missing.
    const actionRegistry = worldStateController.getActionRegistry?.() || {};
    const pickUpAction = actionRegistry[ACTION_NAMES.PICK_UP_ITEM];
    const rangeExpression = pickUpAction?.range;
    let maxRange = PICK_UP_RANGE_FALLBACK;
    if (typeof rangeExpression === 'number') {
        maxRange = rangeExpression;
    } else if (typeof rangeExpression === 'string' && rangeExpression.trim() !== '') {
        const requirementValues = worldStateController.actionController?.requirementResolver
            ? worldStateController.actionController.requirementResolver.resolveEntityRequirementValues(entityId)
            : {};
        maxRange = resolveRange(rangeExpression, requirementValues, PICK_UP_RANGE_FALLBACK);
    }

    if (distance > maxRange) {
        Logger.warn(`[PickUpItemHandler] Item "${droppedItemId}" is out of range. Distance: ${distance.toFixed(2)}, Max Range: ${maxRange}`);
        return { success: false, message: `Item is out of range. Distance: ${distance.toFixed(2)}, Max Range: ${maxRange}` };
    }

    // Get the item definition from inventoryItems.json — OR synthesize it for a
    // dynamically-generated chunk type (feature 2, D8 site 1): chunks have NO registry
    // entry. The ground record is self-describing (name/volume) and the material is
    // recovered from the type string (`chunk_<material>`). A chunk's composition is 100%
    // the recovered material, so its traits derive through the existing material pipeline
    // downstream (InventoryManager._mergeItemTraits).
    const itemDefinitions = DataLoader.loadJsonSafe('data/inventoryItems.json', {});
    let itemDef = itemDefinitions[droppedItem.itemType];
    const chunkMaterial = recoverChunkMaterial(droppedItem.itemType);
    if (!itemDef && chunkMaterial) {
        // Defensive: the recovered material must be a known material. Drops only ever
        // originate from validated recipes, so this should never fire in play — but a
        // corrupt/foreign record must not mint an untyped item.
        // getMaterialRegistry() returns { materials, compositions }; the per-material
        // entries live under .materials.
        const materialsRegistry = worldStateController.getMaterialRegistry?.()?.materials || {};
        if (!materialsRegistry[chunkMaterial]) {
            Logger.warn(`[PickUpItemHandler] Chunk material "${chunkMaterial}" (type "${droppedItem.itemType}") is not a known material; refusing pickup.`);
            return { success: false, message: `Chunk material "${chunkMaterial}" is not a known material.` };
        }
        itemDef = {
            name: droppedItem.name || `${chunkMaterial} chunk`,
            description: droppedItem.description || '',
            volume: droppedItem.volume ?? 1,
            materials: [{ material: chunkMaterial, fraction: 1.0 }]
        };
    }
    if (!itemDef) {
        Logger.warn(`[PickUpItemHandler] Item type "${droppedItem.itemType}" not found in inventoryItems.json.`);
        return { success: false, message: `Item type "${droppedItem.itemType}" not found in registry.` };
    }

    // ?? (not ||): a literal volume of 0 is valid data; 0 is the shared
    // fallback (DEFAULT_ITEM_VOLUME) for a *missing* volume field only.
    const itemVolume = itemDef.volume ?? DEFAULT_ITEM_VOLUME;
    const itemName = itemDef.name || droppedItem.itemType;
    const itemDescription = itemDef.description || '';

    // Check if the target component has enough free volume
    const componentDefinitions = DataLoader.loadJsonSafe('data/components.json', {});
    const componentDef = componentDefinitions[component.type];
    const maxVolume = _getComponentMaxVolume(componentDef) || 0;

    if (maxVolume > 0) {
        const currentVolume = _getCurrentComponentVolume(worldStateController, entityId, componentId);
        if ((currentVolume + itemVolume) > maxVolume) {
            const availableSpace = maxVolume - currentVolume;
            Logger.warn(`[PickUpItemHandler] Component "${componentId}" does not have enough free volume. Need ${itemVolume}, have ${availableSpace}.`);
            return { success: false, message: `Component "${componentId}" does not have enough free volume. Need ${itemVolume}, have ${availableSpace}.` };
        }
    }

    // Add item to entity inventory (attached to the target component). For a chunk, pass
    // the synthesized definition through so InventoryManager bypasses the (empty-for-
    // chunks) registry and uses the self-describing ground-record fields (D8 site 2).
    const addOptions = chunkMaterial ? { itemDef } : {};
    const addResult = worldStateController.addItemToEntity(entityId, droppedItem.itemType, componentId, addOptions);
    if (!addResult.success) {
        Logger.warn(`[PickUpItemHandler] Failed to add item "${droppedItem.itemType}" to entity "${entityId}": ${addResult.message}`);
        return { success: false, message: `Failed to add item: ${addResult.message}` };
    }

    // Restore nested items inside the container (if any were stored during drop)
    const droppedNestedItems = droppedItem.nestedItems || [];
    let nestedItemsRestored = 0;
    let nestedItemsFailed = 0;

    if (droppedNestedItems.length > 0) {
        const entityForNested = worldStateController.getEntity(entityId);

        for (const nestedItem of droppedNestedItems) {
            const nestedResult = worldStateController.addItemToContainer(
                entityId,
                addResult.item.id,
                nestedItem.type
            );

            if (nestedResult.success) {
                nestedItemsRestored++;
            } else {
                nestedItemsFailed++;
                Logger.warn(`[PickUpItemHandler] Failed to restore nested item "${nestedItem.type}" (${nestedItem.id}) to container: ${nestedResult.message}`);
            }
        }
    }

    // Remove the dropped item from world state
    const removeResult = worldStateController.removeDroppedItem(droppedItemId);
    if (!removeResult.success) {
        Logger.warn(`[PickUpItemHandler] Failed to remove dropped item "${droppedItemId}" from world state.`);
        return { success: false, message: `Failed to remove dropped item from world.` };
    }

    Logger.info(`[PickUpItemHandler] Picked up item "${itemName}" (${droppedItem.itemType}) from dropped position (${droppedItem.x}, ${droppedItem.y}) and attached to component "${componentId}" on entity "${entityId}". Restored ${nestedItemsRestored}/${droppedNestedItems.length} nested item(s) (${nestedItemsFailed} failed).`);
    return {
        success: true,
        message: `Picked up ${itemName}.`,
        pickedUpItem: {
            name: itemName,
            description: itemDescription,
            itemType: droppedItem.itemType,
            volume: itemVolume,
            componentId
        }
    };
}

/**
 * Gets the maximum volume for a component from its definition.
 * @private
 * @param {Object} componentDef - The component type definition
 * @returns {number} Maximum volume or 0 if not found
 */
function _getComponentMaxVolume(componentDef) {
    if (!componentDef || !componentDef.traits) return 0;

    // Check Physical.volume.maxVolume first (common pattern)
    if (componentDef.traits.Physical && componentDef.traits.Physical.volume) {
        return componentDef.traits.Physical.volume.maxVolume;
    }

    // Check volume.maxVolume as fallback
    if (componentDef.traits.volume) {
        return componentDef.traits.volume.maxVolume;
    }

    return 0;
}

/**
 * Calculates the current total volume of items on a component.
 * @private
 * @param {Object} worldStateController - The WorldStateController instance
 * @param {string} entityId - The entity ID
 * @param {string} componentId - The component ID
 * @returns {number} Current total volume
 */
function _getCurrentComponentVolume(worldStateController, entityId, componentId) {
    const entityItems = worldStateController.getEntityItems(entityId);
    const componentItems = entityItems?.[componentId] || [];
    return componentItems.reduce((sum, invItem) => sum + (invItem.volume || 1), 0);
}

/**
 * Validates the pick up item params.
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

    if (typeof params.droppedItemId !== 'string' || params.droppedItemId.trim() === '') {
        return { valid: false, error: 'droppedItemId must be a non-empty string.' };
    }

    if (typeof params.componentId !== 'string' || params.componentId.trim() === '') {
        return { valid: false, error: 'componentId must be a non-empty string.' };
    }

    return { valid: true };
}

export { handlePickUpItem, validateParams, _getComponentMaxVolume, _getCurrentComponentVolume };
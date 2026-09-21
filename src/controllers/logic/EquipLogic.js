/**
 * EquipLogic — FASE 7 (facade logic extraction — phase 2).
 *
 * The equipped-item (holding-cost) public API: equip / unequip / transfer
 * (each validates the entity, delegates to the HoldingCostController and
 * broadcasts on success) and the typed-ID (eq-) lookup family used by the
 * capability controller and the routes.
 *
 * Extracted verbatim from WorldStateController (only change: `this.` became
 * `facade.` and the methods became plain functions; the private
 * `_validateEquippedId` dropped its leading underscore, matching FASE 6's
 * naming convention for extracted functions). The facade keeps a thin
 * delegator method per extracted method so instance-level spies/mocks and
 * direct calls keep working. Narrow-deps rule (mirrors
 * consequences/DropItemHandler.js): `facade` is the WorldStateController
 * instance and each function only uses the members named in its JSDoc.
 */

import Logger from '../../utils/Logger.js';
import IdResolver from '../../utils/IdResolver.js';

/**
 * Equips an item on a component (applies holding cost debuffs, triggers capability re-evaluation).
 * @param {string} entityId - The entity ID.
 * @param {string} itemId - The item ID being equipped.
 * @param {string} itemType - The item type (e.g., "knife").
 * @param {string} componentId - The component ID to equip on.
 * @returns {{ success: boolean, message?: string, error?: string }}
 */
function equipItem(facade, entityId, itemId, itemType, componentId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    const result = facade.holdingCostController.equipItem(entityId, itemId, itemType, componentId);

    if (result.success && facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    return result;
}

/**
 * Unequips an item from its component (reverses debuffs, triggers capability re-evaluation).
 * @param {string} entityId - The entity ID.
 * @param {string} itemId - The item ID being unequipped.
 * @returns {{ success: boolean, message?: string, error?: string }}
 */
function unequipItem(facade, entityId, itemId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for unequip.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    const result = facade.holdingCostController.unequipItem(entityId, itemId);

    if (result.success && facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    return result;
}

/**
 * Transfers an equipped item from one component to another (hand swap).
 * @param {string} entityId - The entity ID.
 * @param {string} itemId - The item ID being transferred.
 * @param {string} itemType - The item type.
 * @param {string} fromComponentId - The source component ID.
 * @param {string} toComponentId - The target component ID.
 * @returns {{ success: boolean, message?: string, error?: string }}
 */
function transferEquip(facade, entityId, itemId, itemType, fromComponentId, toComponentId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip transfer.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    const result = facade.holdingCostController.transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId);

    if (result.success && facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    return result;
}

/**
 * Gets all equipped items for an entity.
 * @param {string} entityId - The entity ID.
 * @returns {Array<{ itemId: string, itemType: string, componentId: string }>}
 */
function getEquippedItems(facade, entityId) {
    return facade.holdingCostController.getEquippedItems(entityId);
}

/**
 * Gets all equipped items across all entities.
 * Used by the capability controller to scan all equipped items for action resolution.
 * @returns {Array<{ entityId: string, itemId: string, itemType: string, componentId: string }>}
 */
function getAllEquippedItems(facade) {
    const allEquipped = facade.holdingCostController.getEquippedItemsByEntity();
    if (!allEquipped || typeof allEquipped !== 'object') return [];
    const allItems = [];
    for (const [entityId, items] of Object.entries(allEquipped)) {
        for (const [eqId, item] of Object.entries(items)) {
            allItems.push({
                entityId,
                eqId,
                itemId: item.itemId,
                itemType: item.itemType,
                componentId: item.componentId
            });
        }
    }
    return allItems;
}

// =========================================================================
// TYPED ID MIGRATION: GET EQUIPPED ITEM PUBLIC METHODS
// =========================================================================

/**
 * Gets a specific equipped item by its typed equipped-item ID.
 * TYPED ID MIGRATION: Uses eq- prefixed IDs (e.g., "eq-uuid") for equipped items.
 * @param {string} entityId - The entity ID.
 * @param {string} eqId - The typed equipped-item ID (must start with "eq-").
 * @returns {Object|null} The equipped item data object, or null if not found/invalid.
 */
function getEquippedItem(facade, entityId, eqId) {
    // TYPED ID MIGRATION: Validate that eqId has the proper "eq-" prefix
    if (!facade._validateEquippedId(eqId)) {
        Logger.warn(`[WorldStateController] Invalid equipped-item ID: "${eqId}" — must start with "eq-"`);
        return null;
    }

    const allEquipped = facade.holdingCostController.getEquippedItemsByEntity();
    if (!allEquipped || typeof allEquipped !== 'object') return null;

    const entityItems = allEquipped[entityId];
    if (!entityItems || typeof entityItems !== 'object') return null;

    const item = entityItems[eqId];
    return item ? { ...item } : null;
}

/**
 * Gets a specific equipped item by its item ID (not typed eqId).
 * TYPED ID MIGRATION: Internal use only — prefers eqId for lookups.
 * @param {string} entityId - The entity ID.
 * @param {string} itemId - The item ID to find.
 * @returns {Object|null} The equipped item data object, or null if not found.
 */
function getEquippedItemByItemId(facade, entityId, itemId) {
    const allEquipped = facade.holdingCostController.getEquippedItemsByEntity();
    if (!allEquipped || typeof allEquipped !== 'object') return null;

    const entityItems = allEquipped[entityId];
    if (!entityItems || typeof entityItems !== 'object') return null;

    for (const [_eqId, item] of Object.entries(entityItems)) {
        if (item.itemId === itemId) {
            return { ...item };
        }
    }

    return null;
}

/**
 * Gets an equipped item for a specific component.
 * TYPED ID MIGRATION: Returns equipped item data keyed by eqId for the given component.
 * @param {string} entityId - The entity ID.
 * @param {string} componentId - The component ID to check.
 * @returns {Object|null} The equipped item data, or null if no item is equipped on this component.
 */
function getEquippedItemForComponent(facade, entityId, componentId) {
    const allEquipped = facade.holdingCostController.getEquippedItemsByEntity();
    if (!allEquipped || typeof allEquipped !== 'object') return null;

    const entityItems = allEquipped[entityId];
    if (!entityItems || typeof entityItems !== 'object') return null;

    for (const [_eqId, item] of Object.entries(entityItems)) {
        if (item.componentId === componentId) {
            return { ...item };
        }
    }

    return null;
}

/**
 * Validates that an equipped-item ID has the proper "eq-" prefix.
 * TYPED ID MIGRATION: Internal validation helper for typed ID enforcement.
 * @param {string} eqId - The equipped-item ID to validate.
 * @returns {boolean} True if the ID has the proper "eq-" prefix.
 * @private
 */
function validateEquippedId(facade, eqId) {
    return IdResolver.isEquippedId(eqId);
}

export { equipItem, unequipItem, transferEquip, getEquippedItems, getAllEquippedItems, getEquippedItem, getEquippedItemByItemId, getEquippedItemForComponent, validateEquippedId };

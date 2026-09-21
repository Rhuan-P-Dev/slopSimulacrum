/**
 * ContainerItemLogic — FASE 7 (facade logic extraction — phase 2).
 *
 * The nested-inventory public API: add / remove / move-in / move-out of items
 * on container items, plus direct-children queries. Each operation validates
 * the entity, delegates to the InventoryManager and broadcasts on success.
 *
 * Extracted verbatim from WorldStateController (only change: `this.` became
 * `facade.` and the methods became plain functions). The facade keeps a thin
 * delegator method per extracted method so instance-level spies/mocks and
 * direct calls keep working. Narrow-deps rule (mirrors
 * consequences/DropItemHandler.js): `facade` is the WorldStateController
 * instance and each function only uses the members named in its JSDoc.
 */

import Logger from '../../utils/Logger.js';

/**
 * Adds an item to a container item within an entity's inventory.
 * @param {string} entityId - The entity ID.
 * @param {string} containerItemId - The container item ID.
 * @param {string} itemType - The item type to add.
 * @returns {{ success: boolean, message?: string, item?: Object }}
 */
function addItemToContainer(facade, entityId, containerItemId, itemType) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container add.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    const result = facade.inventoryManager.addItemToContainer(entity, containerItemId, itemType);

    if (result.success && facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    return result;
}

/**
 * Removes an item from a container item within an entity's inventory.
 * @param {string} entityId - The entity ID.
 * @param {string} containerItemId - The container item ID.
 * @param {string} itemId - The item ID to remove.
 * @returns {{ success: boolean, message?: string }}
 */
function removeItemFromContainer(facade, entityId, containerItemId, itemId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container remove.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    const result = facade.inventoryManager.removeItemFromContainer(entity, containerItemId, itemId);

    if (result.success && facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    return result;
}

/**
 * Moves an item from component level (or another container) into a container.
 * @param {string} entityId - The entity ID.
 * @param {string} containerItemId - The container item ID.
 * @param {string} itemId - The item ID to move into container.
 * @returns {{ success: boolean, message?: string }}
 */
function moveItemIntoContainer(facade, entityId, containerItemId, itemId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container move-in.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    const result = facade.inventoryManager.moveItemIntoContainer(entity, containerItemId, itemId);

    if (result.success && facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    return result;
}

/**
 * Moves an item out of a container back to the component level.
 * @param {string} entityId - The entity ID.
 * @param {string} containerItemId - The container item ID.
 * @param {string} itemId - The item ID to move out of container.
 * @param {string} targetComponentId - The component to attach the item to.
 * @returns {{ success: boolean, message?: string }}
 */
function moveItemOutOfContainer(facade, entityId, containerItemId, itemId, targetComponentId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container move-out.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    const result = facade.inventoryManager.moveItemOutOfContainer(entity, containerItemId, itemId, targetComponentId);

    if (result.success && facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    return result;
}

/**
 * Gets direct children of a container item.
 * @param {string} entityId - The entity ID.
 * @param {string} containerItemId - The container item ID.
 * @returns {Array} Array of contained item instances.
 */
function getContainerItems(facade, entityId, containerItemId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container items query.`);
        return [];
    }
    return facade.inventoryManager.getContainerItems(entity, containerItemId);
}

export { addItemToContainer, removeItemFromContainer, moveItemIntoContainer, moveItemOutOfContainer, getContainerItems };

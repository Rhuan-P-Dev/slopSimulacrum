/**
 * PickUpItemHandler — Handles picking up items from other entities' components.
 *
 * Single Responsibility: Transfer an item from one entity's component to another
 * entity's component, with holding cost validation.
 *
 * Extracted from ConsequenceDispatcher to adhere to the Single Responsibility Principle.
 *
 * @module PickUpItemHandler
 */

import Logger from '../../utils/Logger.js';

/**
 * Handles the "pickUpItem" consequence type.
 *
 * @param {Object} deps - Dependencies injected by ConsequenceDispatcher
 * @param {Object} deps.worldStateController - WorldStateController for state access
 * @param {Object} deps.holdingCostController - HoldingCostController for validation
 * @param {Object} params - Consequence parameters
 * @param {string} params.sourceEntityId - The entity owning the source item
 * @param {string} params.sourceItemId - The item ID being picked up
 * @param {string} params.sourceComponentId - The component the item is on
 * @param {string} params.targetEntityId - The entity picking up the item
 * @param {string} params.targetComponentId - The component to attach the item to
 * @param {Object} context - Action execution context
 * @param {Object} context.entityId - The entity executing the action
 * @returns {{ success: boolean, message?: string }}
 */
function handlePickUpItem(deps, params, context) {
    const { worldStateController, holdingCostController } = deps;

    if (!worldStateController) {
        Logger.error('[PickUpItemHandler] WorldStateController not available.');
        return { success: false, message: 'WorldStateController not available.' };
    }

    if (!holdingCostController) {
        Logger.error('[PickUpItemHandler] HoldingCostController not available.');
        return { success: false, message: 'HoldingCostController not available.' };
    }

    const {
        sourceEntityId,
        sourceItemId,
        sourceComponentId,
        targetEntityId,
        targetComponentId
    } = params;

    // Validate required parameters
    if (!sourceEntityId) {
        Logger.warn('[PickUpItemHandler] Missing sourceEntityId for pickUpItem.');
        return { success: false, message: 'Missing sourceEntityId.' };
    }

    if (!sourceItemId) {
        Logger.warn('[PickUpItemHandler] Missing sourceItemId for pickUpItem.');
        return { success: false, message: 'Missing sourceItemId.' };
    }

    if (!targetEntityId) {
        Logger.warn('[PickUpItemHandler] Missing targetEntityId for pickUpItem.');
        return { success: false, message: 'Missing targetEntityId.' };
    }

    if (!targetComponentId) {
        Logger.warn('[PickUpItemHandler] Missing targetComponentId for pickUpItem.');
        return { success: false, message: 'Missing targetComponentId.' };
    }

    // Get source entity
    const sourceEntity = worldStateController.getEntity(sourceEntityId);
    if (!sourceEntity) {
        Logger.warn(`[PickUpItemHandler] Source entity "${sourceEntityId}" not found.`);
        return { success: false, message: `Source entity "${sourceEntityId}" not found.` };
    }

    // Get target entity
    const targetEntity = worldStateController.getEntity(targetEntityId);
    if (!targetEntity) {
        Logger.warn(`[PickUpItemHandler] Target entity "${targetEntityId}" not found.`);
        return { success: false, message: `Target entity "${targetEntityId}" not found.` };
    }

    // Check that the source entity actually has the item
    const sourceItems = worldStateController.getEntityItems(sourceEntityId);
    const sourceComponentItems = sourceItems?.[sourceComponentId];
    if (!sourceComponentItems || !sourceComponentItems[sourceItemId]) {
        Logger.warn(`[PickUpItemHandler] Item "${sourceItemId}" not found on source component "${sourceComponentId}".`);
        return { success: false, message: `Item "${sourceItemId}" not found on source component.` };
    }

    // Get item type from inventory items registry
    const itemRegistry = worldStateController.getItemRegistry();
    const itemDef = Object.values(itemRegistry || {}).find(
        def => def._itemId === sourceItemId || def._itemType === sourceComponentItems[sourceItemId]?.type
    );
    const itemType = sourceComponentItems[sourceItemId]?.type || 'unknown';

    // Check holding cost feasibility on target component
    const targetComponentStats = worldStateController.getComponentStats(targetComponentId);
    if (!targetComponentStats) {
        Logger.warn(`[PickUpItemHandler] Target component "${targetComponentId}" stats not found.`);
        return { success: false, message: `Target component "${targetComponentId}" stats not found.` };
    }

    const holdingCostCheck = holdingCostController.canHoldItem(itemType, targetComponentStats);
    if (!holdingCostCheck.success) {
        Logger.warn(`[PickUpItemHandler] Target component cannot hold "${itemType}": ${holdingCostCheck.message}`);
        return { success: false, message: `Cannot hold "${itemType}": ${holdingCostCheck.message}` };
    }

    // Remove item from source component
    const removeResult = worldStateController.removeItemFromEntity(sourceEntityId, sourceItemId);
    if (!removeResult.success) {
        Logger.warn(`[PickUpItemHandler] Failed to remove item "${sourceItemId}" from source: ${removeResult.message}`);
        return { success: false, message: `Failed to remove from source: ${removeResult.message}` };
    }

    // Add item to target component
    const addResult = worldStateController.addItemToEntity(targetEntityId, itemType, targetComponentId);
    if (!addResult.success) {
        Logger.warn(`[PickUpItemHandler] Failed to add item "${itemType}" to target: ${addResult.message}`);
        return { success: false, message: `Failed to add to target: ${addResult.message}` };
    }

    Logger.info(`[PickUpItemHandler] Picked up item "${itemType}" (${sourceItemId}) from entity "${sourceEntityId}" to entity "${targetEntityId}".`);
    return { success: true, itemType, newItemId: addResult.item?.id };
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

    if (typeof params.sourceEntityId !== 'string' || params.sourceEntityId.trim() === '') {
        return { valid: false, error: 'sourceEntityId must be a non-empty string.' };
    }

    if (typeof params.sourceItemId !== 'string' || params.sourceItemId.trim() === '') {
        return { valid: false, error: 'sourceItemId must be a non-empty string.' };
    }

    if (typeof params.targetEntityId !== 'string' || params.targetEntityId.trim() === '') {
        return { valid: false, error: 'targetEntityId must be a non-empty string.' };
    }

    if (typeof params.targetComponentId !== 'string' || params.targetComponentId.trim() === '') {
        return { valid: false, error: 'targetComponentId must be a non-empty string.' };
    }

    return { valid: true };
}

export { handlePickUpItem, validateParams };
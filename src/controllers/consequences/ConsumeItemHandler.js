/**
 * ConsumeItemHandler — Handles consuming ammo from a T1 container weapon and dealing damage.
 *
 * Single Responsibility: When a T1 weapon is fired, find the first ammo item in its
 * internal inventory, remove it, and deal damage equal to the consumed item's volume.
 *
 * Extracted from ConsequenceDispatcher to adhere to the Single Responsibility Principle.
 *
 * @module ConsumeItemHandler
 */

import Logger from '../../utils/Logger.js';
import IdResolver from '../../utils/IdResolver.js';

/**
 * Handles the "consumeItemAndDamage" consequence type.
 *
 * Finds the T1 weapon equipped on the attacker entity, retrieves the first ammo item
 * from its internal inventory, consumes it, and deals damage equal to the consumed
 * item's volume by delegating to DamageConsequenceHandler.
 *
 * @param {Object} deps - Dependencies injected by ConsequenceHandlers wrapper
 * @param {Object} deps.worldStateController - WorldStateController for state access
 * @param {Object} deps.damageHandler - DamageConsequenceHandler for applying damage
 * @param {string} targetId - The resolved target component/entity ID for damage
 * @param {Object} params - Consequence parameters
 * @param {string} params.trait - The trait name (e.g., "Physical")
 * @param {string} params.stat - The stat name (e.g., "existence")
 * @param {string|number} params.value - The damage value (may be unresolved placeholder string)
 * @param {Object} context - Action execution context
 * @param {string} context.actionParams.entityId - The attacking entity ID
 * @param {string} [context.actionParams.attackerComponentId] - The component executing the action (may be eq- ID)
 * @returns {{ success: boolean, message?: string, data?: Object }}
 */
function handleConsumeItemAndDamage(deps, targetId, params, context) {
    const { worldStateController, damageHandler } = deps;

    if (!worldStateController) {
        Logger.error('[ConsumeItemHandler] WorldStateController not available.');
        return { success: false, message: 'WorldStateController not available.' };
    }

    const entityId = context?.actionParams?.entityId;
    const attackerComponentId = context?.actionParams?.attackerComponentId;

    if (!entityId) {
        Logger.warn('[ConsumeItemHandler] Missing entityId for consumeItemAndDamage.');
        return { success: false, message: 'Missing entityId.' };
    }

    if (!attackerComponentId) {
        Logger.warn('[ConsumeItemHandler] Missing attackerComponentId for consumeItemAndDamage.');
        return { success: false, message: 'Missing attackerComponentId.' };
    }

    // Resolve the actual inventory item ID from the attacker component
    // The attackerComponentId may be an eq- ID (equipped item) pointing to the T1
    let t1ItemId = attackerComponentId;
    let t1ItemType = null;

    if (IdResolver.isEquippedId(attackerComponentId)) {
        const equippedItem = worldStateController.getEquippedItem(entityId, attackerComponentId);
        if (!equippedItem) {
            Logger.warn(`[ConsumeItemHandler] Equipped item "${attackerComponentId}" not found for entity "${entityId}".`);
            return { success: false, message: `Equipped item "${attackerComponentId}" not found.` };
        }
        t1ItemId = equippedItem.itemId;
        t1ItemType = equippedItem.itemType;
    } else {
        // Direct component ID — look up the equipped item to get the T1 item type
        const equippedItem = worldStateController.getEquippedItemByItemId(entityId, attackerComponentId);
        if (equippedItem && equippedItem.itemType) {
            t1ItemType = equippedItem.itemType;
            t1ItemId = equippedItem.itemId || attackerComponentId;
        } else {
            // Try to find any equipped item with this ID as itemId
            const allEquipped = worldStateController.getEquippedItems(entityId);
            const found = allEquipped?.find(eq => eq.itemId === attackerComponentId);
            if (found) {
                t1ItemType = found.itemType;
                t1ItemId = found.itemId;
            }
        }
    }

    if (t1ItemType !== 't1') {
        Logger.warn(`[ConsumeItemHandler] Attacker component is not a T1 weapon (type: "${t1ItemType}").`);
        return { success: false, message: `Attacker is not a T1 weapon (type: "${t1ItemType}").` };
    }

    // Get the entity and its T1 item
    const entity = worldStateController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[ConsumeItemHandler] Entity "${entityId}" not found for consumeItemAndDamage.`);
        return { success: false, message: `Entity "${entityId}" not found.` };
    }

    // Get the children (ammo items) from the T1's internal inventory
    const ammoItems = worldStateController.inventoryManager.getContainerItems(entity, t1ItemId);

    if (!ammoItems || ammoItems.length === 0) {
        Logger.warn(`[ConsumeItemHandler] T1 weapon has no ammunition in inventory.`);
        return { success: false, message: 'No ammunition in T1 inventory.' };
    }

    // Consume the first ammo item
    const ammoItem = ammoItems[0];
    const ammoVolume = ammoItem.volume || 0;

    // Remove the ammo item from the T1's internal inventory
    const removeResult = worldStateController.inventoryManager.removeItemFromContainer(entity, t1ItemId, ammoItem.id);
    if (!removeResult.success) {
        Logger.warn(`[ConsumeItemHandler] Failed to remove ammo item "${ammoItem.id}" from T1: ${removeResult.message}`);
        return { success: false, message: `Failed to consume ammo: ${removeResult.message}` };
    }

    // Store the consumed item's volume in context.actionParams for placeholder resolution
    context.actionParams.itemVolume = ammoVolume;

    // Delegate channel damage to DamageConsequenceHandler. The raw damage is the
    // consumed projectile's volume; the handler converts it to a channel-aware
    // existence loss using the target's resistance to the channel.
    const channel = params?.channel || 'impact';
    const damageResult = damageHandler?._handleDamageComponent(
        targetId,
        { channel, value: ammoVolume },
        context
    );

    if (damageResult && !damageResult.success) {
        Logger.warn(`[ConsumeItemHandler] Failed to apply ${channel} damage to target "${targetId}": ${damageResult.message}`);
    } else if (damageResult) {
        Logger.info(`[ConsumeItemHandler] T1 fired, consuming ammo item "${ammoItem.type}" (volume: ${ammoVolume}), dealt ${channel} damage to "${targetId}".`);
    } else {
        Logger.info(`[ConsumeItemHandler] T1 fired, consuming ammo item "${ammoItem.type}" (volume: ${ammoVolume}), dealing ${channel} damage.`);
    }

    return {
        success: true,
        message: `Consumed ammo with volume ${ammoVolume}.`,
        data: {
            consumedItemType: ammoItem.type,
            itemVolume: ammoVolume,
            damage: ammoVolume,
            damageResult
        }
    };
}

export { handleConsumeItemAndDamage };

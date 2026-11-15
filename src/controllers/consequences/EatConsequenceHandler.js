/**
 * EatConsequenceHandler — the `eatItem` consequence: spend one carried item and
 * charge the body's resource meter (`wiki/decisions/consumable-items.md`).
 *
 * Single Responsibility: resolve WHICH carried item the actor meant, ask the item
 * definition whether it is food, and move the declared energy onto the whole-entity
 * attribute. The rules of the block live in `src/services/ConsumableRules.js`; the
 * rules of the charge (ceiling, clamping) live with the attribute itself.
 *
 * The charge follows the coal burner's law (`consumeFuelGenerateStat` in
 * `src/controllers/core/InternalComponentController.js`), because a body has one
 * way to be refueled:
 *  - the ceiling is the entity attribute's `max`, never a number carried on the
 *    item (`data/mods/core-entity-attributes/entityAttributes.json` is the single
 *    source of truth, enforced by `setEntityAttributeDelta` on every write);
 *  - a full meter refuses BEFORE the item is spent — a golden apple eaten at full
 *    energy is a golden apple thrown away, so the action says no instead;
 *  - the item is spent FIRST and the charge happens only once the removal
 *    succeeded — never a free meal on a failed removal, and no rollback of a
 *    removal (re-adding food would re-derive its footprint from current data).
 *
 * Answer, not exception (CR ERR-3): every refusal is a `{ success: false, message }`
 * naming the rule ("you are not carrying that", "a knife is not food", "already
 * full"), because an action registry entry answers the actor and the round.
 *
 * Broadcast: the charge writes with `broadcast = false`. The `eat` action is
 * executed through `POST /execute-action`, which broadcasts the settled world on
 * success (`src/routes/actionRoutes.js`); a second emit per bite would be noise.
 *
 * @module EatConsequenceHandler
 */

import Logger from '../../utils/Logger.js';
import { resolveConsumable } from '../../services/ConsumableRules.js';

/**
 * Reads the actor's intent: the item instance id (`itemId`) preferred, the item
 * type (`itemType`) as the "any one of these" fallback. A placeholder the
 * dispatcher could not resolve arrives as a `":name"` string, which is treated as
 * absent rather than as a type nobody authored.
 *
 * @param {Object} params - Resolved consequence params.
 * @param {Object} actionParams - The caller's action params (the source of truth).
 * @returns {{ itemId: string|null, itemType: string|null }}
 */
function readIntent(params, actionParams) {
    const clean = (value) => (typeof value === 'string' && value.trim() !== '' && !value.startsWith(':')
        ? value.trim()
        : null);
    return {
        itemId: clean(actionParams?.itemId) ?? clean(params?.itemId),
        itemType: clean(actionParams?.itemType) ?? clean(params?.itemType)
    };
}

/**
 * Finds the item the actor means among everything the entity carries. An explicit
 * instance id wins; otherwise the first carried item of the requested type. The
 * inventory is read through the facade's `getEntityItems`, which answers a map of
 * host component id to the items it holds — the same surface the coal burner
 * searches, so food inside a container is reachable exactly as fuel is.
 *
 * @param {Object} wsc - The world-state facade.
 * @param {string} entityId - The eating entity.
 * @param {{ itemId: string|null, itemType: string|null }} intent - What was asked for.
 * @returns {{ item: Object|null, reason: string|null }} The item, or why there is none.
 */
function findCarriedItem(wsc, entityId, intent) {
    const itemsByHost = wsc.getEntityItems(entityId) ?? {};
    const carried = [];
    for (const hostItems of Object.values(itemsByHost)) {
        if (Array.isArray(hostItems)) carried.push(...hostItems);
    }

    if (intent.itemId) {
        const item = carried.find((candidate) => candidate?.id === intent.itemId) ?? null;
        return item
            ? { item, reason: null }
            : { item: null, reason: `Not carrying an item with id ${intent.itemId}.` };
    }
    if (intent.itemType) {
        const item = carried.find((candidate) => candidate?.type === intent.itemType) ?? null;
        return item
            ? { item, reason: null }
            : { item: null, reason: `Not carrying any "${intent.itemType}".` };
    }
    return { item: null, reason: 'Eating needs an itemId (a specific item) or an itemType (any one of them).' };
}

/**
 * Handles the `eatItem` consequence type.
 *
 * @param {Object} deps - Dependencies injected by the ConsequenceHandlers wrapper.
 * @param {Object} deps.worldStateController - The world-state facade.
 * @param {string|null} targetId - Unused: eating targets the actor, not a component.
 * @param {Object} params - Resolved consequence params (`itemId`, `itemType`).
 * @param {Object} context - Action execution context.
 * @param {Object} context.actionParams - The caller's params (carries `entityId`).
 * @returns {{ success: boolean, message: string, data?: Object }}
 */
export function handleEatItem(deps, targetId, params, context) {
    const wsc = deps?.worldStateController;
    if (!wsc) {
        Logger.error('[EatConsequenceHandler] WorldStateController not available.');
        return { success: false, message: 'WorldStateController not available.' };
    }

    const entityId = context?.actionParams?.entityId;
    if (!entityId) {
        Logger.warn('[EatConsequenceHandler] Missing entityId for eatItem.');
        return { success: false, message: 'Missing entityId.' };
    }

    const intent = readIntent(params, context?.actionParams);
    const { item, reason } = findCarriedItem(wsc, entityId, intent);
    if (!item) {
        Logger.warn(`[EatConsequenceHandler] ${reason} (entity ${entityId})`);
        return { success: false, message: reason };
    }

    // Is it food? The definition answers, so a mod's consumable needs no code here.
    // Read through the facade, never through `wsc.inventoryManager`: an optional
    // chain here would answer `null` for a missing collaborator and the refusal
    // below would blame the apple ("not something you can eat") for a wiring fault.
    const itemDef = wsc.getItemDefinition(item.type);
    const rule = resolveConsumable(itemDef);
    if (!rule) {
        const label = itemDef?.name || item.type;
        Logger.warn(`[EatConsequenceHandler] "${item.type}" is not a consumable (entity ${entityId}).`);
        return { success: false, message: `${label} is not something you can eat.` };
    }

    // The meter the food charges. A body without that attribute has nothing to
    // refill, and the apple stays where it is — the refusal names the missing
    // declaration rather than pretending the bite did something.
    const attrConfig = wsc.getEntityAttributeConfig(entityId, rule.traitId, rule.statName);
    if (!attrConfig || typeof attrConfig.max !== 'number' || !Number.isFinite(attrConfig.max) || attrConfig.max <= 0) {
        Logger.warn(`[EatConsequenceHandler] Entity ${entityId} has no "${rule.targetStat}" attribute to charge.`);
        return { success: false, message: `There is no ${rule.targetStat} to charge, so the ${itemDef?.name || item.type} stays uneaten.` };
    }
    const capacity = attrConfig.max;
    const current = wsc.getEntityAttribute(entityId, rule.traitId, rule.statName) ?? 0;

    // A full meter is a refusal, not a waste: the item survives the attempt.
    if (current >= capacity) {
        Logger.info(`[EatConsequenceHandler] Entity ${entityId} is at full ${rule.targetStat} (${current}/${capacity}) — nothing eaten.`);
        return { success: false, message: `Already at full ${rule.targetStat} (${current}/${capacity}).` };
    }

    // Spend the food FIRST; the charge only happens on a spent item.
    const removed = wsc.removeItemFromEntity(entityId, item.id);
    if (!removed?.success) {
        Logger.warn(`[EatConsequenceHandler] Failed to remove "${item.id}" from ${entityId}: ${removed?.message ?? 'unknown reason'}`);
        return { success: false, message: `Could not take the ${itemDef?.name || item.type} out of your inventory.` };
    }

    const charge = Math.min(rule.energyGain, capacity - current);
    wsc.setEntityAttributeDelta(entityId, rule.traitId, rule.statName, charge, false);
    Logger.info(`[EatConsequenceHandler] Entity ${entityId} ate ${itemDef?.name || item.type}: +${charge} ${rule.targetStat} (${current + charge}/${capacity}).`);

    return {
        success: true,
        message: `Ate ${itemDef?.name || item.type} (+${charge} ${rule.targetStat}).`,
        data: {
            itemId: item.id,
            itemType: item.type,
            targetStat: rule.targetStat,
            energyGain: charge,
            energy: current + charge,
            capacity
        }
    };
}

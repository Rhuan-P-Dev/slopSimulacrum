/**
 * ItemStatsLogic — FASE 7 (facade logic extraction — phase 3).
 *
 * The full stats computation for a single item instance: base traits from
 * the item definition, dynamic stats while equipped, and the holding-cost
 * requirements shown as informational metadata.
 *
 * Extracted verbatim from WorldStateController.getItemStats (only change:
 * `this.<dep>` became a named parameter). Unlike the FASE 6/7 siblings,
 * this module takes EXPLICIT dependencies instead of the facade: its
 * dependency set is exactly four objects and the logic is read-only, the
 * narrow-deps exception the convention ruling permits (plans/
 * FIX-PLAN-2026-09.md T9, step A). The equipped-item-by-itemId lookup the
 * original reached through the facade is delegated to
 * EquipLogic.getEquippedItemByItemId with a one-key { holdingCostController }
 * object — EquipLogic only ever reads that one member, so a one-key object
 * is not a facade; it is the dependency it needs.
 *
 * Read-only: no mutations, no logging, no broadcasts.
 */

import { getEquippedItemByItemId } from './EquipLogic.js';

/**
 * Computes the full stats for a single item instance, combining:
 * - Base traits from inventoryItems.json (always shown)
 * - Dynamic equipped item stats (sharpness, existence current — shown when equipped)
 * - Holding cost requirements (shown when equipped, informational only)
 *
 * Note: Holding cost debuffs are applied to the COMPONENT's stats, not the item's.
 * They are shown as informational metadata, not subtracted from item stats.
 *
 * @param {Object} stateEntityController - must expose getEntity(entityId)
 * @param {Object} inventoryManager - must expose getItem(entity, itemId)
 * @param {Object} holdingCostController - must expose isItemEquipped, getHoldingCostDefinition, getEquippedItemsByEntity
 * @param {Object|null} equippedItemStats - must expose getStats(eqId), or null
 * @param {string} entityId - The entity ID.
 * @param {string} itemId - The item ID.
 * @returns {Object|null} The combined stats object, or null if item not found.
 */
function resolveItemStats(stateEntityController, inventoryManager, holdingCostController, equippedItemStats, entityId, itemId) {
    const entity = stateEntityController.getEntity(entityId);
    if (!entity) return null;

    const item = inventoryManager.getItem(entity, itemId);
    if (!item) return null;

    // 1. Build base stats from item traits (always present)
    const baseStats = {};
    const traitCategories = {}; // Track which trait categories have stats
    if (item.traits && typeof item.traits === 'object') {
        for (const [traitCategory, traitData] of Object.entries(item.traits)) {
            if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                traitCategories[traitCategory] = true;
                for (const [statName, statValue] of Object.entries(traitData)) {
                    if (typeof statValue === 'number') {
                        baseStats[statName] = statValue;
                    }
                }
            }
        }
    }

    // 2. Check if equipped and get dynamic stats
    const isEquipped = holdingCostController.isItemEquipped(entityId, itemId);
    const dynamicStats = {};
    const dynamicStatCategories = {};

    if (isEquipped && equippedItemStats) {
        // FIX: Get eqId from itemId to properly look up equipped item stats.
        // EquipLogic.getEquippedItemByItemId only ever reads
        // facade.holdingCostController, so a one-key object is not a facade -
        // it is the dependency it needs.
        const equippedItem = getEquippedItemByItemId({ holdingCostController }, entityId, itemId);
        if (equippedItem && equippedItem.eqId) {
            const eqStats = equippedItemStats.getStats(equippedItem.eqId);
            if (eqStats) {
                for (const [traitCategory, traitData] of Object.entries(eqStats)) {
                    if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                        dynamicStatCategories[traitCategory] = true;
                        for (const [statName, statValue] of Object.entries(traitData)) {
                            dynamicStats[statName] = statValue;
                        }
                    }
                }
            }
        }
    }

    // 3. Get holding cost requirements if equipped (informational, NOT applied to item stats)
    const holdingCostRequirements = [];
    if (isEquipped) {
        const holdingCostDef = holdingCostController.getHoldingCostDefinition(item.type);
        if (holdingCostDef && holdingCostDef.holdingCost) {
            for (const costEntry of holdingCostDef.holdingCost) {
                holdingCostRequirements.push({
                    trait: costEntry.trait,
                    stat: costEntry.stat,
                    value: costEntry.value
                });
            }
        }
    }

    // 4. Build final result with metadata and separated sections
    const result = {
        _itemId: item.id,
        _type: item.type,
        _name: item.name || item.type,
        _isEquipped: isEquipped,
        _volume: item.volume,
        _baseStats: baseStats,
        _traitCategories: traitCategories
    };

    // Add dynamic stats when equipped
    if (isEquipped && Object.keys(dynamicStats).length > 0) {
        result._dynamicStats = dynamicStats;
        result._dynamicStatCategories = dynamicStatCategories;
    }

    // Add holding cost requirements when equipped
    if (isEquipped && holdingCostRequirements.length > 0) {
        result._holdingCostRequirements = holdingCostRequirements;
    }

    // Also flatten for easy display: base + dynamic merged
    const displayStats = { ...baseStats };
    for (const [statName, statValue] of Object.entries(dynamicStats)) {
        displayStats[statName] = statValue;
    }
    Object.assign(result, displayStats);

    return result;
}

export { resolveItemStats };

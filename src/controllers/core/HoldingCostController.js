/**
 * HoldingCostController manages the holding cost system for equipped items.
 *
 * When an item is equipped on a component:
 * - holdingCost requirements are checked (component's stats must be >= required values)
 * - If requirements pass, HoldingCost debuffs (negative deltas) are applied to the host component
 * - The capability controller re-evaluates so equipped item actions become available
 * - Equipped items are NOT merged into component stats — they are independent action sources
 *
 * When an item is unequipped:
 * - Debuffs are reversed on the host component
 * - The capability controller re-evaluates, removing equipped item action entries
 *
 * Data-driven: configuration loaded from data/holdingCost.json
 *
 * @module HoldingCostController
 */
import DataLoader from '../../utils/DataLoader.js';
import Logger from '../../utils/Logger.js';
import { generateEquippedId } from '../../utils/idGenerator.js';

/**
 * @typedef {Object} HoldingCostEntry
 * @property {string} trait - The trait category (e.g., "Physical")
 * @property {string} stat - The stat name (e.g., "strength")
 * @property {number} value - The minimum value required AND the debuff magnitude
 */

/**
 * @typedef {Object} HoldingCostDefinition
 * @property {string} name - Human-readable name of the item
 * @property {HoldingCostEntry[]} holdingCost - Requirements the component must meet (all must pass)
 */

class HoldingCostController {
    /**
     * @param {Object} deps - Dependencies
     * @param {Object} deps.worldStateController - WorldStateController for component stats access
     * @param {Object} deps.actionController - ActionController for capability re-evaluation
     * @param {EquippedItemStatsController} deps.equippedItemStats - EquippedItemStatsController for in-memory item stats
     */
    constructor({ actionController, equippedItemStats } = {}) {
        /**
         * @type {WorldStateController|null} Injected post-construction via
         * setWorldStateController() (FASE 5: the facade is no longer passed at
         * construction — BUG-100 root cause).
         */
        this.worldStateController = null;
        this.actionController = actionController;
        this.equippedItemStats = equippedItemStats;

        /**
         * Holding cost definitions loaded from data/holdingCost.json
         * Format: { [itemType]: HoldingCostDefinition }
         * @type {Object<string, HoldingCostDefinition>}
         */
        this._holdingCostDefinitions = DataLoader.loadJsonSafe('data/holdingCost.json', {});

        Logger.info(`[HoldingCostController] Initialized with ${Object.keys(this._holdingCostDefinitions).length} item types`);

        // Validate definitions
        this._validateHoldingCostDefinitions();

        /**
         * Tracks which items are equipped: { [entityId]: { [eqId]: { eqId, itemId, itemType, componentId } } }
         * Each equipped item has a dedicated typed eqId for unambiguous identification.
         * @type {Object<string, Object<string, { eqId: string, itemId: string, itemType: string, componentId: string }>>}
         */
        this._equippedItems = {};

        /**
         * Tracks original component stats before equip (for undo): { [entityId]: { [eqId]: { [componentId]: originalStats } } }
         * @type {Object<string, Object<string, Object<string, Object>>>}
         */
        this._preEquipStats = {};
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built.
     * FASE 5: replaces the constructor-time facade dependency (BUG-100 root cause).
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Checks if an item has a holding cost definition.
     * @param {string} itemType - The item type identifier.
     * @returns {boolean} True if the item has a holding cost definition.
     */
    hasHoldingCost(itemType) {
        return Boolean(this._holdingCostDefinitions[itemType]);
    }

    /**
     * Gets the holding cost definition for an item type.
     * @param {string} itemType - The item type identifier.
     * @returns {HoldingCostDefinition|null} The definition, or null if not found.
     */
    getHoldingCostDefinition(itemType) {
        return this._holdingCostDefinitions[itemType] || null;
    }

    /**
     * Checks if a component's stats meet ALL holding cost requirements for a given item type.
     *
     * This method is NON-MUTATING — it only validates whether the component
     * would be capable of holding the item. It does NOT apply debuffs or modify any state.
     *
     * @param {string} itemType - The item type identifier (e.g., "knife", "powerCell").
     * @param {Object} componentStats - The component's current stats object.
     *   Format: { [traitName]: { [statName]: value } }
     *   Example: { Physical: { strength: 5, durability: 100 }, Manipulation: { fine_controls: 25 } }
     * @returns {{ success: boolean, requiredCosts: Array<{trait: string, stat: string, value: number}>, missingStats?: Array<{trait: string, stat: string, required: number, available: number}>, message: string }}
     *
     * @example
     * const result = holdingCostController.canHoldItem('knife', componentStats);
     * if (result.success) {
     *     console.log('Component can hold the item');
     * } else {
     *     console.log('Cannot hold:', result.message);
     * }
     */
    canHoldItem(itemType, componentStats) {
        if (!itemType || typeof itemType !== 'string') {
            Logger.warn('[HoldingCostController] Invalid itemType for canHoldItem check.');
            return {
                success: false,
                requiredCosts: [],
                message: 'Invalid itemType.'
            };
        }

        if (!componentStats || typeof componentStats !== 'object') {
            Logger.warn('[HoldingCostController] Invalid componentStats for canHoldItem check.');
            return {
                success: false,
                requiredCosts: [],
                message: 'Invalid componentStats.'
            };
        }

        const definition = this._holdingCostDefinitions[itemType];
        if (!definition || !Array.isArray(definition.holdingCost)) {
            // No holding cost definition — any item can be held
            Logger.info(`[HoldingCostController] No holding cost definition for "${itemType}" — item can be held.`);
            return {
                success: true,
                requiredCosts: [],
                message: 'No holding cost requirements.'
            };
        }

        const requiredCosts = definition.holdingCost;
        const missingStats = [];

        // Check ALL holding cost requirements
        for (const costEntry of requiredCosts) {
            const traitData = componentStats[costEntry.trait];
            if (!traitData || traitData[costEntry.stat] === undefined) {
                missingStats.push({
                    trait: costEntry.trait,
                    stat: costEntry.stat,
                    required: costEntry.value,
                    available: 0
                });
                continue;
            }

            const available = traitData[costEntry.stat];
            if (available < costEntry.value) {
                missingStats.push({
                    trait: costEntry.trait,
                    stat: costEntry.stat,
                    required: costEntry.value,
                    available
                });
            }
        }

        if (missingStats.length > 0) {
            const details = missingStats.map(
                s => `${s.trait}.${s.stat}: ${s.available} < ${s.required}`
            ).join(', ');
            Logger.info(`[HoldingCostController] Component cannot hold "${itemType}": ${details}`);
            return {
                success: false,
                requiredCosts,
                missingStats,
                message: `Insufficient stats: ${details}`
            };
        }

        Logger.info(`[HoldingCostController] Component can hold "${itemType}" — all ${requiredCosts.length} requirements met.`);
        return {
            success: true,
            requiredCosts,
            message: `All ${requiredCosts.length} holding cost requirements met.`
        };
    }

    /**
     * Equips an item on a component.
     * Checks holding cost requirements first — if the component can't meet them, equip is denied.
     * If requirements pass, the item is added as a child component and debuffs are applied.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being equipped.
     * @param {string} itemType - The item type (e.g., "knife").
     * @param {string} componentId - The component ID to equip on.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    equipItem(entityId, itemId, itemType, componentId) {
        // Validate itemId is present and a non-empty string
        if (!itemId || typeof itemId !== 'string' || itemId.trim() === '') {
            Logger.warn(`[HoldingCostController] Cannot equip item: itemId is invalid.`);
            return { success: false, message: 'Invalid itemId. Must be a non-empty string.' };
        }

        const definition = this._holdingCostDefinitions[itemType];
        if (!definition) {
            Logger.warn(`[HoldingCostController] No holding cost definition for item type "${itemType}". Cannot equip.`);
            return { success: false, message: `No holding cost definition for: ${itemType}` };
        }

        // Get the component's current stats
        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (!componentStats) {
            Logger.warn(`[HoldingCostController] Component "${componentId}" not found for equip.`);
            return { success: false, message: `Component not found: ${componentId}` };
        }

        // Check all holding cost requirements
        for (const costEntry of definition.holdingCost) {
            const traitData = componentStats[costEntry.trait];
            if (!traitData || traitData[costEntry.stat] === undefined) {
                Logger.warn(`[HoldingCostController] Component "${componentId}" does not have required stat ${costEntry.trait}.${costEntry.stat} to equip ${itemType}.`);
                return {
                    success: false,
                    error: 'INSUFFICIENT_STAT',
                    message: `Component "${componentId}" does not have enough ${costEntry.trait}.${costEntry.stat} to equip ${itemType}.`
                };
            }

            if (traitData[costEntry.stat] < costEntry.value) {
                Logger.warn(`[HoldingCostController] Component "${componentId}" ${costEntry.trait}.${costEntry.stat} (${traitData[costEntry.stat]}) < required (${costEntry.value}) for equip ${itemType}.`);
                return {
                    success: false,
                    error: 'INSUFFICIENT_STAT',
                    message: `Component "${componentId}" ${costEntry.trait}.${costEntry.stat} (${traitData[costEntry.stat]}) < required (${costEntry.value}) to equip ${itemType}.`
                };
            }
        }

        // Requirements passed — save original stats for undo
        const originalStats = structuredClone(componentStats);

        // Apply holdingCost debuffs (negative deltas) to host component
        for (const costEntry of definition.holdingCost) {
            this.worldStateController.componentController.updateComponentStatDelta(
                componentId,
                costEntry.trait,
                costEntry.stat,
                -costEntry.value
            );
        }

        // Generate typed eqId for this equipped item
        const eqId = generateEquippedId();

        // Track equipped item with typed eqId
        if (!this._equippedItems[entityId]) {
            this._equippedItems[entityId] = {};
        }
        this._equippedItems[entityId][eqId] = { eqId, itemId, itemType, componentId };

        // Initialize in-memory stats for the equipped item (sharpness, durability, etc.)
        this.equippedItemStats.initializeStats(eqId, itemId, itemType);

        if (!this._preEquipStats[entityId]) {
            this._preEquipStats[entityId] = {};
        }
        this._preEquipStats[entityId][eqId] = { [componentId]: originalStats };

        // Re-evaluate entity capabilities so new actions become available
        const state = this.worldStateController.getAll();
        this.actionController.reEvaluateEntityCapabilities(state, entityId);

        Logger.info(`[HoldingCostController] Equipped ${itemType} on component ${componentId} for entity ${entityId}.`);
        return { success: true };
    }

    /**
     * Unequips an item from its component by item ID.
     * Finds the eqId by itemId, then unequips.
     * Restores the component stats to pre-equip state and re-evaluates capabilities.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being unequipped.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
       unequipItem(entityId, itemId) {
        // Find the eqId for this itemId
        const items = this._equippedItems[entityId] || {};
        const equippedEntry = Object.values(items).find(eq => eq.itemId === itemId);
        if (!equippedEntry) {
            Logger.warn(`[HoldingCostController] Item "${itemId}" is not equipped on entity "${entityId}".`);
            return { success: false, message: `Item not equipped: ${itemId}` };
        }
        const { eqId } = equippedEntry;
        const equippedItem = equippedEntry;

        const { itemType, componentId } = equippedItem;

        // Use eqId for cleanup tracking
        const definition = this._holdingCostDefinitions[itemType];
        if (!definition) {
            Logger.warn(`[HoldingCostController] No holding cost definition for item type "${itemType}" during unequip.`);
            // Do NOT call _cleanupTracking here — debuffs can't be reversed without the definition,
            // but we also shouldn't silently remove tracking. The player should be informed.
            return { success: false, message: `No holding cost definition for: ${itemType}` };
        }

        // Restore original stats for this component
        const originalStats = this._preEquipStats[entityId]?.[eqId]?.[componentId];
        if (!originalStats) {
            Logger.warn(`[HoldingCostController] No original stats found for unequip of "${itemId}" on component "${componentId}".`);
            // Do NOT call _cleanupTracking here — we should NOT silently remove tracking
            // when the debuffs may still be active. Let the player know and keep tracking intact.
            return { success: false, message: `No original stats found for: ${itemId}` };
        }


        // Restore by calculating inverse deltas
        const currentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (currentStats) {
            for (const [traitName, traitStats] of Object.entries(originalStats)) {
                if (!currentStats[traitName]) continue;
                for (const [statName, origValue] of Object.entries(traitStats)) {
                    if (typeof currentStats[traitName][statName] === 'number') {
                        const inverseDelta = origValue - currentStats[traitName][statName];
                        this.worldStateController.componentController.updateComponentStatDelta(
                            componentId,
                            traitName,
                            statName,
                            inverseDelta
                        );
                    }
                }
            }
        }

        // Clean up tracking
        this._cleanupTracking(entityId, eqId);

        // Re-evaluate entity capabilities
        const state = this.worldStateController.getAll();
        this.actionController.reEvaluateEntityCapabilities(state, entityId);

        Logger.info(`[HoldingCostController] Unequipped ${itemType} from component ${componentId} for entity ${entityId}.`);
        return { success: true };
    }

    /**
     * Transfers an equipped item from one component to another (hand swap).
     * Unequips from old component, then equips on new component.
     * The holding cost debuffs apply to whichever component holds the item.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being transferred.
     * @param {string} itemType - The item type.
     * @param {string} fromComponentId - The source component ID.
     * @param {string} toComponentId - The target component ID.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId) {
        if (fromComponentId === toComponentId) {
            return { success: true, message: 'Same component — no transfer needed.' };
        }

        // Unequip from old component
        const unequipResult = this.unequipItem(entityId, itemId);
        if (!unequipResult.success) {
            return unequipResult;
        }

        // Equip on new component (with requirement check)
        const equipResult = this.equipItem(entityId, itemId, itemType, toComponentId);
        if (!equipResult.success) {
            // Rollback: re-equip on original component
            Logger.warn(`[HoldingCostController] Transfer failed — rolling back equip to original component. Reason: ${equipResult.message}`);
            const rollbackResult = this.equipItem(entityId, itemId, itemType, fromComponentId);
            if (!rollbackResult.success) {
                Logger.error(`[HoldingCostController] Critical: Rollback equip failed for "${itemId}" on component "${fromComponentId}".`);
            }
        } else {
            Logger.info(`[HoldingCostController] Transferred equip of ${itemType} from ${fromComponentId} to ${toComponentId} for entity ${entityId}.`);
        }

        return equipResult;
    }

    /**
     * Gets all equipped items for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array<{ eqId: string, itemId: string, itemType: string, componentId: string }>}
     */
    getEquippedItems(entityId) {
        const items = this._equippedItems[entityId] || {};
        return Object.entries(items).map(([eqId, data]) => ({
            eqId: data.eqId,
            itemId: data.itemId,
            itemType: data.itemType,
            componentId: data.componentId
        }));
    }

    /**
     * Gets all equipped items across all entities, keyed by entity.
     * Returns a deep copy filtered to exclude entries with invalid/empty eqId keys.
     *
     * Named `getEquippedItemsByEntity` (Phase 4, BUG cleanup) to distinguish it
     * from `WorldStateController.getAllEquippedItems()`, which returns a FLAT
     * array of `{ entityId, eqId, itemId, itemType, componentId }`. Same shape
     * here as before: { [entityId]: { [eqId]: item } }.
     *
     * @returns {Object<string, Object<string, { eqId: string, itemId: string, itemType: string, componentId: string }>>}
     */
    getEquippedItemsByEntity() {
        const cloned = structuredClone(this._equippedItems);
        const filtered = {};
        for (const [entityId, items] of Object.entries(cloned)) {
            const validItems = {};
            for (const [eqId, data] of Object.entries(items)) {
                if (eqId && typeof eqId === 'string' && eqId.trim() !== '' && data?.eqId) {
                    validItems[eqId] = data;
                }
            }
            if (Object.keys(validItems).length > 0) {
                filtered[entityId] = validItems;
            }
        }
        return filtered;
    }

    /**
     * Returns the holding cost state for serialization/broadcast.
     * Called by WorldStateController.getAll() to include holding cost data
     * in the global world state. The format must match what
     * WorldStateBroadcastService._transformForBroadcast() expects:
     * holdingCost._equippedItems.
     *
     * @returns {{ _equippedItems: Object<string, Object<string, { eqId: string, itemId: string, itemType: string, componentId: string }>> }}
     */
    getAll() {
        return {
            _equippedItems: this.getEquippedItemsByEntity()
        };
    }

    /**
     * Gets the full holding cost registry (all definitions).
     * @returns {Object<string, HoldingCostDefinition>} The holding cost definitions.
     */
    getHoldingCostRegistry() {
        return this._holdingCostDefinitions;
    }

    /**
     * Checks if an item is currently equipped on an entity.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID.
     * @returns {boolean}
     */
    isItemEquipped(entityId, itemId) {
        const items = this._equippedItems[entityId] || {};
        return Object.values(items).some(eq => eq.itemId === itemId);
    }

    /**
     * Gets the component ID an item is equipped on.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID.
     * @returns {string|null} The component ID, or null if not equipped.
     */
    getEquippedComponentId(entityId, itemId) {
        const items = this._equippedItems[entityId] || {};
        const found = Object.values(items).find(eq => eq.itemId === itemId);
        return found?.componentId || null;
    }

    /**
     * Gets the eqId for an equipped item.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID.
     * @returns {string|null} The eqId, or null if not equipped.
     */
    getEquippedItemId(entityId, itemId) {
        const items = this._equippedItems[entityId] || {};
        const found = Object.values(items).find(eq => eq.itemId === itemId);
        return found?.eqId || null;
    }

    // =========================================================================
    // INTERNAL COMPONENTS
    // =========================================================================

    /**
     * Validates all holding cost definitions loaded from data file.
     * Throws TypeError for invalid/malformed data.
     * @private
     */
    _validateHoldingCostDefinitions() {
        const definitions = this._holdingCostDefinitions;

        if (typeof definitions !== 'object' || definitions === null || Array.isArray(definitions)) {
            throw new TypeError('[HoldingCostController] holdingCost definitions must be an object.');
        }

        for (const [itemType, definition] of Object.entries(definitions)) {
            if (typeof definition.name !== 'string' || definition.name.trim() === '') {
                throw new TypeError(`[HoldingCostController] Invalid definition for "${itemType}": name must be a non-empty string.`);
            }

            if (!Array.isArray(definition.holdingCost)) {
                throw new TypeError(`[HoldingCostController] Invalid definition for "${itemType}": holdingCost must be an array.`);
            }

            for (const entry of definition.holdingCost) {
                if (typeof entry.trait !== 'string' || entry.trait.trim() === '') {
                    throw new TypeError(`[HoldingCostController] Invalid holdingCost entry in "${itemType}": trait must be a non-empty string.`);
                }
                if (typeof entry.stat !== 'string' || entry.stat.trim() === '') {
                    throw new TypeError(`[HoldingCostController] Invalid holdingCost entry in "${itemType}": stat must be a non-empty string.`);
                }
                if (typeof entry.value !== 'number' || entry.value <= 0) {
                    throw new TypeError(`[HoldingCostController] Invalid holdingCost entry in "${itemType}": value must be a positive number.`);
                }
            }
        }
    }

    /**
     * Cleans up all tracking data for an equipped item.
     * @param {string} entityId - The entity ID.
     * @param {string} eqId - The equipped item ID.
     * @private
     */
    _cleanupTracking(entityId, eqId) {
        if (this._equippedItems[entityId]) {
            delete this._equippedItems[entityId][eqId];
        }
        if (this._preEquipStats[entityId]) {
            delete this._preEquipStats[entityId][eqId];
        }
    }
}

export default HoldingCostController;
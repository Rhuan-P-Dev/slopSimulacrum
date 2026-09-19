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
        // The data file is a single mass-lever MODEL (not a per-item map): it
        // gates equipping on a strength-to-mass ratio and burdens the function
        // stats (move / fine_controls) by the carried item's mass.
        this._model = DataLoader.loadJsonSafe('data/holdingCost.json', {});
        this._itemMassCache = {};

        Logger.info(`[HoldingCostController] Initialized massBurden model (equipable: ${JSON.stringify(this._model.equipableItems || [])})`);

        // Validate the model
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

    /**
     * Resolves the total mass of an item type from its recipe (matter-derived).
     * Mass is the sum of its material parts (density × volume per part). Cached
     * per type. Returns 0 when it cannot be derived (unknown item / no
     * material controller yet), which makes the equip gate trivially pass.
     * @param {string} itemType
     * @returns {number}
     * @private
     */
    _getItemMass(itemType) {
        if (this._itemMassCache[itemType] !== undefined) return this._itemMassCache[itemType];
        let mass = 0;
        try {
            const wc = this.worldStateController;
            const itemDef = wc?.inventoryManager?.getItemDefinitions?.()[itemType];
            const mc = wc?.materialController;
            if (itemDef && Array.isArray(itemDef.materials) && mc) {
                const derived = mc.derive({ volume: itemDef.form?.volume ?? 1, materials: itemDef.materials });
                // derive() returns the component stat shape { Physical: { mass, … } }
                // (the matter group lives under Physical in this codebase).
                mass = derived?.Physical?.mass ?? derived?.matter?.mass ?? 0;
            }
        } catch (e) {
            Logger.warn(`[HoldingCostController] Could not derive mass for "${itemType}": ${e.message}`);
        }
        this._itemMassCache[itemType] = mass;
        return mass;
    }

    /**
     * Seeds a freshly equipped item's per-instance live stats from its matter when
     * the item's recipe declares no explicit traits.
     *
     * WHY: in the recipe→derivation model a recipe declares structure, not values —
     * existence, the six channel resistances, mass, and (for the knife) a depletable
     * sharpness all derive from matter. `initializeStats` can only seed what a recipe
     * declares explicitly (`form.traits` / legacy `traits`); for post-migration items
     * that is nothing, so the per-instance store was left at the existence-only
     * baseline and every live-stats-first reader (the capability scan, requirement
     * resolution) saw a knife with no sharpness to score `cut` against. This closes
     * the writer-side gap so the per-instance store starts life from the same matter
     * derivation the equip gate already performs — an equipped item is a small
     * component, and its stats derive from its own matter exactly as any component's
     * do (basic-traits spec D4/D6).
     *
     * Precedence: explicit recipe traits (handled by `initializeStats`) > matter
     * derivation (this) > the existence baseline (`initializeStats`'s default). When
     * the recipe declares explicit traits, `initializeStats` already seeded the
     * authoritative values and they are never overwritten here. When matter
     * derivation yields nothing usable (no materials / no derived stats), the
     * existence baseline is left untouched (graceful degradation).
     *
     * Uses the same pre-existing facade-access pattern as `_getItemMass` (the
     * controller holds no direct reference to the material controller).
     *
     * @param {string} eqId - The typed equipped item ID.
     * @param {string} itemType - The item type identifier (e.g., "knife").
     * @private
     */
    _seedDerivedStatsOnEquip(eqId, itemType) {
        const wc = this.worldStateController;
        // Facade public API only (project_rules §2/§3): read item definitions
        // through the root controller's getItemRegistry() rather than reaching
        // into the inventoryManager sub-controller.
        const itemDef = wc?.getItemRegistry?.()[itemType];
        const mc = wc?.materialController;
        if (!itemDef || !mc) return;

        // Explicit recipe traits outrank matter derivation: initializeStats already
        // seeded them (form.traits first, then legacy traits) — never clobber. The
        // guard mirrors the initializer's effective numeric-leaf rule (M2): a traits
        // map with no numeric leaves seeds nothing and must NOT suppress the matter
        // derivation that is the post-migration source of base traits.
        if (this.equippedItemStats.hasSeedableTraitValues(itemDef.form?.traits ?? itemDef.traits)) return;
        // No materials → nothing to derive from; keep the existence baseline.
        if (!Array.isArray(itemDef.materials) || itemDef.materials.length === 0) return;

        let derived;
        try {
            derived = mc.derive(itemDef);
        } catch (e) {
            Logger.warn(`[HoldingCostController] Could not derive stats for "${itemType}" on equip: ${e.message}`);
            return;
        }
        // Graceful degradation: no usable derived stats → leave the baseline intact.
        if (!derived || typeof derived !== 'object' || Object.keys(derived).length === 0) return;

        // Preserve the existence baseline initializeStats established if the derived
        // shape ever omits it, so the wear lifecycle keeps a valid 0–1 reference.
        const existing = this.equippedItemStats.getStats(eqId);
        if (existing?.Physical?.existence !== undefined && typeof derived.Physical?.existence !== 'number') {
            derived.Physical = { ...(derived.Physical || {}), existence: existing.Physical.existence };
        }

        this.equippedItemStats.setStats(eqId, derived);
        Logger.info(`[HoldingCostController] Seeded matter-derived stats for "${itemType}" (eqId ${eqId}): ${Object.keys(derived).join(', ')}.`);
    }

    /**
     * Applies the carrying cost of an equipped item to its host component: the
     * carried item's mass (above the free allowance) reduces the burdened
     * function stats (move / fine_controls) via a linear reduction, floored at
     * `carryingCost.floor` × the original value. Applied as a delta so the
     * unequip restoration (inverse delta against the pre-equip snapshot) cleanly
     * reverses it.
     * @param {string} componentId - The host component instance ID.
     * @param {string} itemType - The equipped item type (for its mass).
     * @param {Object} componentStats - The host's stats (read for the floor).
     * @private
     */
    _applyCarryingCost(componentId, itemType, componentStats) {
        const model = this._model;
        const cost = model.carryingCost;
        const itemMass = this._getItemMass(itemType);
        const excess = Math.max(0, itemMass - cost.freeMassAllowance);
        if (excess <= 0) return;
        const reduction = excess * cost.reductionPerUnitMass;
        for (const burdened of model.burdenedStats) {
            const current = componentStats[burdened.trait]?.[burdened.stat];
            if (typeof current !== 'number') continue;
            const floor = (typeof cost.floor === 'number') ? current * cost.floor : 0;
            const newValue = Math.max(floor, current - reduction);
            if (newValue !== current) {
                this.worldStateController.componentController.updateComponentStatDelta(
                    componentId, burdened.trait, burdened.stat, newValue - current
                );
            }
        }
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
        return Array.isArray(this._model.equipableItems) && this._model.equipableItems.includes(itemType);
    }

    /**
     * Gets the holding cost definition for an item type.
     * @param {string} itemType - The item type identifier.
     * @returns {HoldingCostDefinition|null} The definition, or null if not found.
     */
    getHoldingCostDefinition(itemType) {
        return this.hasHoldingCost(itemType) ? structuredClone(this._model) : null;
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
     *   Example: { Physical: { strength: 5, existence: 100 }, Manipulation: { fine_controls: 25 } }
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
            return { success: false, requiredCosts: [], message: 'Invalid itemType.' };
        }

        if (!componentStats || typeof componentStats !== 'object') {
            Logger.warn('[HoldingCostController] Invalid componentStats for canHoldItem check.');
            return { success: false, requiredCosts: [], message: 'Invalid componentStats.' };
        }

        // Mass lever: an equipable item may be held only if the host's strength
        // meets the strength-to-mass ratio for the item's derived mass. Items
        // outside the equipable set have no gate and can always be held.
        const model = this._model;
        const equipable = Array.isArray(model.equipableItems) && model.equipableItems.includes(itemType);
        if (!equipable) {
            return { success: true, requiredCosts: [], message: 'No equip gate for this item.' };
        }

        const gate = model.equipGate;
        const itemMass = this._getItemMass(itemType);
        const requiredStrength = gate.requiredStrengthPerUnitMass * itemMass;
        const available = componentStats.Physical?.strength ?? 0;
        const requiredCosts = [{ trait: 'Physical', stat: 'strength', value: requiredStrength }];

        if (available < requiredStrength) {
            const details = `Physical.strength: ${available} < ${requiredStrength}`;
            Logger.info(`[HoldingCostController] Component cannot hold "${itemType}": ${details} (item mass ${itemMass}).`);
            return {
                success: false,
                requiredCosts,
                missingStats: [{ trait: 'Physical', stat: 'strength', required: requiredStrength, available }],
                message: `Insufficient strength to equip ${itemType}: ${details}.`
            };
        }

        Logger.info(`[HoldingCostController] Component can hold "${itemType}" — strength ${available} >= ${requiredStrength} (item mass ${itemMass}).`);
        return { success: true, requiredCosts, message: `Strength ${available} >= ${requiredStrength} to equip ${itemType}.` };
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

        // Get the component's current stats
        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (!componentStats) {
            Logger.warn(`[HoldingCostController] Component "${componentId}" not found for equip.`);
            return { success: false, message: `Component not found: ${componentId}` };
        }

        // Mass-lever equip gate: equipable items require the host's strength to
        // meet the strength-to-mass ratio for the item's derived mass.
        const holdCheck = this.canHoldItem(itemType, componentStats);
        if (!holdCheck.success) {
            return { success: false, error: 'INSUFFICIENT_STAT', message: holdCheck.message };
        }

        // Save original stats for undo (the carrying-cost burden is reversed on unequip)
        const originalStats = structuredClone(componentStats);

        // Apply the carrying cost (the carried item's mass burdens function stats)
        this._applyCarryingCost(componentId, itemType, componentStats);

        // Generate typed eqId for this equipped item
        const eqId = generateEquippedId();

        // Track equipped item with typed eqId
        if (!this._equippedItems[entityId]) {
            this._equippedItems[entityId] = {};
        }
        this._equippedItems[entityId][eqId] = { eqId, itemId, itemType, componentId };

        // Initialize in-memory stats for the equipped item (sharpness, existence, etc.)
        this.equippedItemStats.initializeStats(eqId, itemId, itemType);

        // Writer-side seeding (BUG-134): for items whose recipe declares no explicit
        // traits (the post-migration norm), seed the per-instance store from the
        // item's matter so live-stats-first readers see the full derived stat set
        // (e.g. a knife's sharpness) instead of only the existence baseline.
        this._seedDerivedStatsOnEquip(eqId, itemType);

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
     * Unequips an item from its component by eqId OR itemId.
     * Looks up eqId first, falls back to itemId scan — no duplicated logic.
     * Restores the component stats to pre-equip state and re-evaluates capabilities.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} lookupId - The eqId or itemId being unequipped.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
       unequipItem(entityId, lookupId) {
         const items = this._equippedItems[entityId] || {};
         
         // Try eqId first, then fallback to itemId lookup
         let equippedEntry = items[lookupId];
         if (!equippedEntry) {
             equippedEntry = Object.values(items).find(eq => eq.itemId === lookupId);
         }
         if (!equippedEntry) {
             Logger.warn(`[HoldingCostController] ID "${lookupId}" is not equipped on entity "${entityId}".`);
             return { success: false, message: `Not equipped: ${lookupId}` };
         }
         const { eqId, itemId } = equippedEntry;
        const equippedItem = equippedEntry;

        const { itemType, componentId } = equippedItem;

        // Restore original stats for this component (the carrying-cost burden is
        // reversed against the pre-equip snapshot; no per-item definition needed).
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
        return Object.entries(items).map(([, data]) => ({
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
        return structuredClone(this._model);
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
        const model = this._model;
        if (typeof model !== 'object' || model === null || Array.isArray(model)) {
            throw new TypeError('[HoldingCostController] holdingCost data must be an object (massBurden model).');
        }
        if (typeof model.model !== 'string' || model.model.trim() === '') {
            throw new TypeError('[HoldingCostController] massBurden model: "model" must be a non-empty string.');
        }
        const gate = model.equipGate;
        if (!gate || typeof gate.type !== 'string' || typeof gate.requiredStrengthPerUnitMass !== 'number' || gate.requiredStrengthPerUnitMass <= 0) {
            throw new TypeError('[HoldingCostController] massBurden model: equipGate.type and equipGate.requiredStrengthPerUnitMass (positive number) are required.');
        }
        const cost = model.carryingCost;
        if (!cost || typeof cost.freeMassAllowance !== 'number' || typeof cost.reductionPerUnitMass !== 'number') {
            throw new TypeError('[HoldingCostController] massBurden model: carryingCost.freeMassAllowance and carryingCost.reductionPerUnitMass must be numbers.');
        }
        if (!Array.isArray(model.burdenedStats) || model.burdenedStats.length === 0) {
            throw new TypeError('[HoldingCostController] massBurden model: burdenedStats must be a non-empty array.');
        }
        if (!Array.isArray(model.equipableItems)) {
            throw new TypeError('[HoldingCostController] massBurden model: equipableItems must be an array.');
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

    /**
     * Public wrapper for _cleanupTracking (§3.5.2).
     * @param {string} entityId - The entity ID.
     * @param {string} eqId - The equipped item ID.
     */
    cleanupEquippedItem(entityId, eqId) {
        this._cleanupTracking(entityId, eqId);
    }
}

export default HoldingCostController;
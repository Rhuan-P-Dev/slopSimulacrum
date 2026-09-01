/**
 * EquippedItemStatsController manages per-instance mutable stats for equipped items.
 *
 * This controller tracks mutable stats (sharpness, existence, etc.) for equipped items
 * independently from their host component's stats. When an item is equipped, its base
 * stats are loaded from inventoryItems.json and stored as a mutable copy that can be
 * modified independently (e.g., sharpness decreases with use, existence degrades).
 *
 * Data-driven: base stats loaded from data/inventoryItems.json
 *
 * @module EquippedItemStatsController
 */
import DataLoader from '../../utils/DataLoader.js';
import Logger from '../../utils/Logger.js';

/**
 * @typedef {Object} TraitStats
 * @property {number} [mass] - Mass of the item
 * @property {number} [existence] - Current existence
 * @property {number} [sharpness] - Current sharpness
 * @property {number} [quality] - Item quality rating
 * @property {number} [custom] - Custom trait values
 */

/**
 * @typedef {Object.<string, TraitStats>} ItemStats
 * @property {string} [itemId] - The unique item instance ID
 * @property {string} [itemType] - The item type identifier (e.g., "knife")
 */

class EquippedItemStatsController {
    /**
     * FASE 5: the facade reference previously stored here was dead code (stored but
     * never read) — it has been removed. This is now a pure data store with no
     * controller dependencies.
     */
    constructor() {
        /**
         * Callback triggered whenever an item stat changes (delta or absolute).
         * Receives (eqId, traitId, statName, newValue, oldValue).
         * Used to trigger capability re-evaluation when equipped item stats change.
         * @type {Function|null}
         */
        this._statChangeCallback = null;

        /**
         * Tracks per-item mutable stats for equipped items.
         * Format: { [eqId]: { [traitId]: { [statName]: value } } }
         * Keys are typed eqIds (eq-${uuid}) for unambiguous identification.
         * @type {Object<string, ItemStats>}
         */
        this._itemStats = {};

        /**
         * Item definitions loaded from data/inventoryItems.json.
         * Format: { [itemType]: { name, description, volume, traits, ... } }
         * @type {Object<string, Object>}
         */
        this._itemDefinitions = DataLoader.loadJsonSafe('data/inventoryItems.json', {});

        Logger.info(`[EquippedItemStatsController] Initialized with ${Object.keys(this._itemDefinitions).length} item type definitions`);

        // Validate loaded item definitions
        this._validateItemDefinitions();
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Initializes stats for an equipped item based on its item type definition.
     * Creates a mutable copy of the item's base traits as stats.
     * If stats already exist, they are preserved (no overwrites).
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @param {string} itemId - The underlying item instance ID (e.g., "item-...").
     * @param {string} itemType - The item type identifier (e.g., "knife").
     * @returns {{ success: boolean, message: string }}
     */
    initializeStats(eqId, itemId, itemType) {
        if (!eqId || typeof eqId !== 'string' || eqId.trim() === '') {
            Logger.warn('[EquippedItemStatsController] Invalid eqId for initializeStats.');
            return { success: false, message: 'Invalid eqId.' };
        }

        if (!itemType || typeof itemType !== 'string' || itemType.trim() === '') {
            Logger.warn('[EquippedItemStatsController] Invalid itemType for initializeStats.');
            return { success: false, message: 'Invalid itemType.' };
        }

        // If stats already exist, don't overwrite — item is already initialized
        if (this._itemStats[eqId]) {
            Logger.info(`[EquippedItemStatsController] Stats already initialized for eqId "${eqId}" (item: "${itemId}").`);
            return { success: true, message: `Stats already initialized for eqId "${eqId}".` };
        }

        // Look up item definition
        const itemDef = this._itemDefinitions[itemType];
        if (!itemDef) {
            Logger.warn(`[EquippedItemStatsController] No item definition found for type "${itemType}".`);
            return { success: false, message: `No item definition for type: ${itemType}` };
        }

        // recipe→derivation: explicit item traits (if any) live under form.traits
        // (the legacy top-level traits is a fallback). Either way, a newly equipped
        // item starts at full existence (1.0 on the 0–1 scale) so the existence
        // lifecycle (drain → break) has a valid baseline to track.
        const stats = this._buildStatsFromTraits(itemDef.form?.traits ?? itemDef.traits);
        if (typeof stats.Physical?.existence !== 'number') {
            stats.Physical = { ...(stats.Physical || {}), existence: 1 };
        }

        if (Object.keys(stats).length === 0) {
            Logger.info(`[EquippedItemStatsController] Item "${itemType}" has no traits to track. No stats initialized.`);
            return { success: true, message: `No traits to track for item "${itemType}".` };
        }

        // Store a deep copy of the stats keyed by eqId
        this._itemStats[eqId] = structuredClone(stats);

        Logger.info(`[EquippedItemStatsController] Initialized stats for eqId "${eqId}" (item: "${itemId}", type: "${itemType}"): ${Object.keys(stats).join(', ')}`);
        return { success: true, message: `Stats initialized for eqId "${eqId}".` };
    }

    /**
     * Retrieves the stats for an equipped item.
     * Returns a deep clone to prevent external mutation.
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @returns {Object|null} Deep clone of item stats, or null if not found.
     */
    getStats(eqId) {
        const stats = this._itemStats[eqId];
        if (!stats) return null;
        return structuredClone(stats);
    }

    /**
     * Replaces all stats for an equipped item.
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @param {ItemStats} newStats - New stats object to set.
     * @returns {boolean} True if stats were set, false if item not found.
     */
    setStats(eqId, newStats) {
        if (!this._itemStats[eqId]) {
            Logger.warn(`[EquippedItemStatsController] Cannot setStats: eqId "${eqId}" not found.`);
            return false;
        }

        this._itemStats[eqId] = structuredClone(newStats);
        Logger.info(`[EquippedItemStatsController] Replaced stats for eqId "${eqId}".`);
        return true;
    }

    /**
     * Sets a specific stat to an absolute value on an equipped item.
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @param {string} traitId - The trait category (e.g., "Physical").
     * @param {string} statName - The stat name (e.g., "sharpness").
     * @param {number} value - The new absolute value.
     * @returns {boolean} True if the stat was updated, false if item/trait/stat not found.
     */
    updateStat(eqId, traitId, statName, value) {
        const stats = this._itemStats[eqId];
        if (!stats || !stats[traitId]) {
            Logger.warn(`[EquippedItemStatsController] Cannot updateStat: eqId "${eqId}" has no trait "${traitId}".`);
            return false;
        }

        if (typeof stats[traitId][statName] !== 'number') {
            Logger.warn(`[EquippedItemStatsController] Cannot updateStat: stat "${traitId}.${statName}" is not a number on eqId "${eqId}".`);
            return false;
        }

        const oldValue = stats[traitId][statName];
        stats[traitId][statName] = value;

        Logger.info(`[EquippedItemStatsController] Updated eqId "${eqId}" ${traitId}.${statName}: ${oldValue} → ${value}`);

        // Trigger stat change callback (e.g., capability re-evaluation)
        this._notifyStatChange(eqId, traitId, statName, value, oldValue);

        return true;
    }

    /**
     * Adds a delta to a specific stat on an equipped item.
     * This is the primary method for stat drain effects (e.g., sharpness decrease on cut).
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @param {string} traitId - The trait category (e.g., "Physical").
     * @param {string} statName - The stat name (e.g., "sharpness").
     * @param {number} delta - The value to add to the current stat.
     * @returns {boolean} True if the stat was updated, false if item/trait/stat not found or not numeric.
     */
    updateStatDelta(eqId, traitId, statName, delta) {
        const stats = this._itemStats[eqId];
        if (!stats || !stats[traitId]) {
            Logger.warn(`[EquippedItemStatsController] Cannot updateStatDelta: eqId "${eqId}" has no trait "${traitId}".`);
            return false;
        }

        if (typeof stats[traitId][statName] !== 'number') {
            Logger.warn(`[EquippedItemStatsController] Cannot updateStatDelta: stat "${traitId}.${statName}" is not a number on eqId "${eqId}".`);
            return false;
        }

        const oldValue = stats[traitId][statName];
        const newValue = oldValue + delta;
        stats[traitId][statName] = newValue;

        Logger.info(`[EquippedItemStatsController] Updated eqId "${eqId}" ${traitId}.${statName}: ${oldValue} + ${delta} = ${newValue}`);

        // Trigger stat change callback (e.g., capability re-evaluation)
        this._notifyStatChange(eqId, traitId, statName, newValue, oldValue);

        return true;
    }

    /**
     * Removes the stats entry for an equipped item (called on unequip).
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @returns {boolean} True if the entry was removed, false if it didn't exist.
     */
    removeStats(eqId) {
        if (!this._itemStats[eqId]) {
            Logger.info(`[EquippedItemStatsController] No stats found for eqId "${eqId}" to remove.`);
            return false;
        }

        delete this._itemStats[eqId];
        Logger.info(`[EquippedItemStatsController] Removed stats for eqId "${eqId}".`);
        return true;
    }

    /**
     * Checks whether stats are tracked for an equipped item.
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @returns {boolean} True if stats exist for the item.
     */
    hasStats(eqId) {
        return Boolean(this._itemStats[eqId]);
    }

    /**
     * Sets a callback to be invoked whenever an item stat changes.
     * Receives (itemId, traitId, statName, newValue, oldValue).
     * Used to trigger capability re-evaluation when equipped item stats change.
     *
     * @param {Function} callback - The stat change callback.
     */
    setStatChangeCallback(callback) {
        if (typeof callback === 'function') {
            this._statChangeCallback = callback;
            Logger.info('[EquippedItemStatsController] Stat change callback registered.');
        }
    }

    /**
     * Notifies the stat change callback (if registered) about a stat modification.
     * Receives (eqId, traitId, statName, newValue, oldValue).
     * @private
     */
    _notifyStatChange(eqId, traitId, statName, newValue, oldValue) {
        if (this._statChangeCallback) {
            try {
                this._statChangeCallback(eqId, traitId, statName, newValue, oldValue);
            } catch (error) {
                Logger.error(`[EquippedItemStatsController] Stat change callback failed: ${error.message}`);
            }
        }
    }

    /**
     * Returns a deep clone of all tracked item stats.
     *
     * @returns {Object<string, ItemStats>} Deep clone of all item stats.
     */
    getAll() {
        return structuredClone(this._itemStats);
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Builds a stats object from an item's trait definitions.
     * Extracts numeric stat values from trait data.
     *
     * @param {Object} traits - The traits object from item definition.
     * @returns {ItemStats} The stats object keyed by trait.
     * @private
     */
    _buildStatsFromTraits(traits) {
        if (!traits || typeof traits !== 'object') {
            return {};
        }

        const stats = {};
        for (const [traitId, traitData] of Object.entries(traits)) {
            if (typeof traitData !== 'object' || traitData === null || Array.isArray(traitData)) {
                continue;
            }

            stats[traitId] = {};
            for (const [statName, statValue] of Object.entries(traitData)) {
                if (typeof statValue === 'number') {
                    stats[traitId][statName] = statValue;
                }
            }

            // If the trait has no numeric stats, remove the empty entry
            if (Object.keys(stats[traitId]).length === 0) {
                delete stats[traitId];
            }
        }

        return stats;
    }

    /**
     * Validates all item definitions loaded from data file.
     * Ensures each item type has valid trait structures.
     * Throws TypeError for invalid/malformed data.
     *
     * @private
     */
    _validateItemDefinitions() {
        const definitions = this._itemDefinitions;

        if (typeof definitions !== 'object' || definitions === null || Array.isArray(definitions)) {
            throw new TypeError('[EquippedItemStatsController] Item definitions must be an object.');
        }

        for (const [itemType, definition] of Object.entries(definitions)) {
            if (typeof definition.name !== 'string' || definition.name.trim() === '') {
                Logger.warn(`[EquippedItemStatsController] Invalid definition for "${itemType}": name must be a non-empty string.`);
                continue;
            }

            // Traits are optional — items without traits are valid
            if (definition.traits !== undefined) {
                if (typeof definition.traits !== 'object' || definition.traits === null || Array.isArray(definition.traits)) {
                    throw new TypeError(`[EquippedItemStatsController] Invalid definition for "${itemType}": traits must be an object.`);
                }

                for (const [traitId, traitData] of Object.entries(definition.traits)) {
                    if (typeof traitData !== 'object' || traitData === null || Array.isArray(traitData)) {
                        throw new TypeError(`[EquippedItemStatsController] Invalid definition for "${itemType}": trait "${traitId}" must be an object.`);
                    }
                }
            }
        }
    }
}

export default EquippedItemStatsController;

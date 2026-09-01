import ComponentStatsController from './componentStatsController.js';
import TraitsController from '../traits/TraitsController.js';
import Logger from '../../utils/Logger.js';

/**
 * ComponentController is responsible for communicating with all subcontrollers
 * related to components and routing requests to the appropriate logic.
 * Now implemented with a Default-Override Traits System.
 * 
 * It also provides a stat change notification system so dependent controllers
 * (e.g., ActionController) can re-evaluate action capabilities when stats change.
 */
class ComponentController {
    constructor(statsController, traitsController, componentRegistry, materialController = null) {
        this.statsController = statsController;
        this.traitsController = traitsController;
        this.componentRegistry = componentRegistry || {};
        this.materialController = materialController;
        
        // Stat change subscribers (observer pattern for action capability re-evaluation)
        this._statChangeListeners = [];
    }

    /**
     * Registers a listener to be notified whenever a component stat changes.
     * @param {Function} listener - A function called with (componentId, traitId, statName, newValue, oldValue).
     */
    registerStatChangeListener(listener) {
        if (typeof listener === 'function' && !this._statChangeListeners.includes(listener)) {
            this._statChangeListeners.push(listener);
        }
    }

    /**
     * Unregisters a previously registered stat change listener.
     * @param {Function} listener - The function to remove.
     */
    unregisterStatChangeListener(listener) {
        const index = this._statChangeListeners.indexOf(listener);
        if (index !== -1) {
            this._statChangeListeners.splice(index, 1);
        }
    }

    /**
     * Notifies all registered stat change listeners.
     * @param {string} componentId - The component instance ID.
     * @param {string} traitId - The trait category.
     * @param {string} statName - The stat name.
     * @param {any} newValue - The new stat value.
     * @param {any} oldValue - The previous stat value.
     * @private
     */
    _notifyStatChangeListeners(componentId, traitId, statName, newValue, oldValue) {
        for (const listener of this._statChangeListeners) {
            try {
                listener(componentId, traitId, statName, newValue, oldValue);
            } catch (error) {
                Logger.error(`Error in stat change listener for ${componentId}: ${error.message}`, { componentId, traitId: traitId, statName: statName });
            }
        }
    }

    /**
     * Initializes stats for a new component instance using the Merge Process.
     * @param {string} componentType - The type of component (from registry).
     * @param {string} instanceId - The unique ID for this specific component instance.
     * @param {Object} initialOverrides - Additional runtime overrides.
     * @returns {void}
     */
    initializeComponent(componentType, instanceId, initialOverrides = {}) {
        const blueprint = this.componentRegistry[componentType];
        if (!blueprint) {
            throw new Error(`Component type ${componentType} is not registered in ComponentController.`);
        }
  
        // Merge Process: Global Defaults ← Material-Derived ← Blueprint Overrides.
        // In the recipe→derivation model a recipe declares NO stat values (`traits` is
        // absent), so the merge input starts empty; matter-derived stats (existence,
        // resistances, mass, sharpness, volume) are layered in below, and function
        // stats (strength/move/fine_controls/think_level) are granted by the internal
        // components (organs) a recipe installs — applied by the IC install path.
        const mergeInput = { ...(blueprint.traits || {}) };

        // Handle initialOverrides if they are passed in the same trait format
        for (const [traitId, properties] of Object.entries(initialOverrides)) {
            mergeInput[traitId] = { ...(mergeInput[traitId] || {}), ...properties };
        }

        // Fail-safe: on derivation failure, fall back to blueprint/global traits (mirrors InventoryManager semantics).
        let materialDerived = null;
        if (this.materialController && blueprint.materials) {
            try {
                materialDerived = this.materialController.derive(blueprint);
            } catch (error) {
                Logger.warn(`[ComponentController] Material derivation failed for "${componentType}", using blueprint traits: ${error.message}`);
            }
        }

        const finalStats = this.traitsController.mergeTraits(mergeInput, materialDerived);

        // Cache the result in the stats controller
        this.statsController.setStats(instanceId, finalStats);
    }

    /**
     * Updates a specific stat for a component instance.
     * @param {string} instanceId - The unique ID of the component instance.
     * @param {string} traitId - The trait category (e.g., "Physical").
     * @param {string} statName - The stat to modify.
     * @param {any} value - The new value.
     * @returns {boolean}
     */
    updateComponentStat(instanceId, traitId, statName, value) {
        // Read current stats to get the old value.
        // A semantic SET may introduce a brand-new trait group (e.g. an organ
        // granting Movement.move to a component that had no Movement stats yet —
        // the removed traits.json molds no longer seed every group). setStats
        // deep-merges and creates the group as needed, so no pre-existence is
        // required; callers that must only touch existing stats gate upstream.
        const stats = this.statsController.getStats(instanceId);
        const oldValue = (stats && stats[traitId]) ? stats[traitId][statName] : undefined;
        this.statsController.setStats(instanceId, { [traitId]: { [statName]: value } });
        this._notifyStatChangeListeners(instanceId, traitId, statName, value, oldValue);
        return true;
    }

    /**
     * Updates a specific stat for a component instance by adding a delta.
     * @param {string} instanceId - The unique ID of the component instance.
     * @param {string} traitId - The trait category (e.g., "Physical").
     * @param {string} statName - The stat to modify.
     * @param {number} delta - The value to add to the current stat.
     * @returns {boolean}
     */
    updateComponentStatDelta(instanceId, traitId, statName, delta) {
        // Read current stats to get the old value
        const stats = this.statsController.getStats(instanceId);
        if (stats && stats[traitId] && typeof stats[traitId][statName] === 'number') {
            const oldValue = stats[traitId][statName];
            const newValue = oldValue + delta;
            // Apply the delta via setStats with just the changed trait/stat
            this.statsController.setStats(instanceId, { [traitId]: { [statName]: newValue } });
            // Notify listeners of the stat change
            this._notifyStatChangeListeners(instanceId, traitId, statName, newValue, oldValue);
            return true;
        }
        return false;
    }

    /**
     * Updates a specific stat for a component instance by applying a
     * multiplicative factor atomically. The old value is read and the new
     * value (oldValue * factor) is computed inside this single facade method,
     * so the read-then-write cannot race with a concurrent stat change.
     * Expressing the multiplication as a relative delta keeps the change
     * consistent with updateComponentStatDelta and the stat-change
     * notification pipeline.
     * @param {string} instanceId - The unique ID of the component instance.
     * @param {string} traitId - The trait category (e.g., "Physical").
     * @param {string} statName - The stat to modify.
     * @param {number} factor - The multiplicative factor (e.g., 1.5 for +50%).
     * @returns {boolean}
     */
    updateComponentStatRelative(instanceId, traitId, statName, factor) {
        const stats = this.statsController.getStats(instanceId);
        if (stats && stats[traitId] && typeof stats[traitId][statName] === 'number' && typeof factor === 'number') {
            const oldValue = stats[traitId][statName];
            const delta = oldValue * (factor - 1);
            return this.updateComponentStatDelta(instanceId, traitId, statName, delta);
        }
        return false;
    }

    /**
     * Retrieves the stats for a specific component.
     * @param {string} instanceId - The unique ID of the component.
     * @returns {Object|null}
     */
    getComponentStats(instanceId) {
        return this.statsController.getStats(instanceId);
    }

    /**
     * Adds a granted flag to a component (from an organ's `grantsFlags`).
     * Granted flags are STORED (not derived) because they come from the organ
     * itself, not from a stat threshold. They live in the world state
     * (`Physical.grantedFlags`) so they survive save/load.
     * @param {string} instanceId - The component instance ID.
     * @param {string} flagName - The flag name (e.g. "corrosive").
     * @returns {boolean} True when the flag was added.
     */
    addGrantedFlag(instanceId, flagName) {
        if (typeof flagName !== 'string' || flagName.length === 0) return false;
        const stats = this.statsController.getStats(instanceId) || {};
        const current = Array.isArray(stats.Physical?.grantedFlags) ? [...stats.Physical.grantedFlags] : [];
        if (!current.includes(flagName)) current.push(flagName);
        this.statsController.setStats(instanceId, { Physical: { grantedFlags: current } });
        return true;
    }

    /**
     * Adds a transient condition to a component (burning, wet, corroded).
     * Conditions are stored in the world state (`Physical.conditions`) so they
     * survive save/load and are visible to clients and the LLM context.
     * @param {string} instanceId - The component instance ID.
     * @param {string} conditionName - The condition name (e.g. "burning").
     * @returns {boolean} True when the condition was added.
     */
    addCondition(instanceId, conditionName) {
        if (typeof conditionName !== 'string' || conditionName.length === 0) return false;
        const stats = this.statsController.getStats(instanceId) || {};
        const current = Array.isArray(stats.Physical?.conditions) ? [...stats.Physical.conditions] : [];
        if (!current.includes(conditionName)) current.push(conditionName);
        this.statsController.setStats(instanceId, { Physical: { conditions: current } });
        return true;
    }

    /**
     * Removes a transient condition from a component.
     * @param {string} instanceId - The component instance ID.
     * @param {string} conditionName - The condition name to remove.
     * @returns {boolean} True when a condition was removed.
     */
    removeCondition(instanceId, conditionName) {
        const stats = this.statsController.getStats(instanceId);
        if (!stats || !Array.isArray(stats.Physical?.conditions)) return false;
        const before = stats.Physical.conditions.length;
        const current = stats.Physical.conditions.filter(c => c !== conditionName);
        this.statsController.setStats(instanceId, { Physical: { conditions: current } });
        return current.length !== before;
    }

    /**
     * Returns a component's transient conditions (burning, wet, corroded) as a
     * defensive copy. These are stored world state.
     * @param {string} instanceId - The component instance ID.
     * @returns {string[]} Copy of the active condition names.
     */
    getComponentConditions(instanceId) {
        const stats = this.statsController.getStats(instanceId);
        return Array.isArray(stats?.Physical?.conditions) ? [...stats.Physical.conditions] : [];
    }

    /**
     * Returns a component's full flag set. Two sources, unioned and sorted:
     *   - Derived flags (flammable, conductive): a pure function of the material
     *     composition, computed by the MaterialController at derive time (via the
     *     propertyTraitMapping `flagThresholds`) and stored on `Physical.derivedFlags`.
     *     Because they are derived from the fixed composition they never desync.
     *   - Granted flags (e.g. corrosive): set by an organ on install and stored
     *     on `Physical.grantedFlags`.
     * @param {string} instanceId - The component instance ID.
     * @returns {string[]} Sorted array of active flag names.
     */
    getComponentFlags(instanceId) {
        const stats = this.statsController.getStats(instanceId) || {};
        const flags = new Set();

        if (Array.isArray(stats.Physical?.derivedFlags)) {
            for (const flag of stats.Physical.derivedFlags) flags.add(flag);
        }
        if (Array.isArray(stats.Physical?.grantedFlags)) {
            for (const flag of stats.Physical.grantedFlags) flags.add(flag);
        }

        return [...flags].sort();
    }

    /**
     * Retrieves the component definition (blueprint) from the registry.
     * @param {string} componentType - The component type name.
     * @returns {Object|null} The component blueprint or null if not found.
     */
    getComponentDefinition(componentType) {
        return this.componentRegistry[componentType] || null;
    }

    /**
     * Returns a deep clone of the combined state of all components and the global trait molds.
     * Prevents direct mutation of internal state.
     * @returns {Object} Deep clone of the combined component state.
     */
    getAll() {
        return {
            globalTraits: this.traitsController.getGlobalTraits(),
            registry: structuredClone(this.componentRegistry),
            instances: this.statsController.getAll()
        };
    }

    /** @returns {Object<string,Array>} deep-cloned { [componentType]: materials[] } for types that declare materials */
    getComponentMaterialsByType() {
        const out = {};
        for (const [type, def] of Object.entries(this.componentRegistry)) {
            if (Array.isArray(def.materials)) out[type] = structuredClone(def.materials);
        }
        return out;
    }
}

export default ComponentController;

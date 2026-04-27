import ComponentStatsController from './componentStatsController.js';
import TraitsController from './traitsController.js';
import Logger from '../utils/Logger.js';

/**
 * ComponentController is responsible for communicating with all subcontrollers
 * related to components and routing requests to the appropriate logic.
 * Now implemented with a Default-Override Traits System.
 * 
 * It also provides a stat change notification system so dependent controllers
 * (e.g., ActionController) can re-evaluate action capabilities when stats change.
 */
class ComponentController {
    constructor(statsController, traitsController, componentRegistry) {
        this.statsController = statsController;
        this.traitsController = traitsController;
        this.componentRegistry = componentRegistry || {};
        
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
     * @param {Function} listener - The listener function to remove.
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
     * @param {string} instanceId - The unique ID for this specific instance.
     * @param {Object} initialOverrides - Additional runtime overrides.
     * @returns {void}
     */
    initializeComponent(componentType, instanceId, initialOverrides = {}) {
        const blueprint = this.componentRegistry[componentType];
        if (!blueprint) {
            throw new Error(`Component type ${componentType} is not registered in ComponentController.`);
        }
  
        // Merge Process: Blueprint Overrides + Global Defaults
        // We incorporate initialOverrides into the blueprint traits for the merge
        const mergeInput = { ...blueprint.traits };
        
        // Handle initialOverrides if they are passed in the same trait format
        for (const [traitId, properties] of Object.entries(initialOverrides)) {
            mergeInput[traitId] = { ...(mergeInput[traitId] || {}), ...properties };
        }

        const finalStats = this.traitsController.mergeTraits(mergeInput);

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
        // Read current stats to get the old value
        const stats = this.statsController.getStats(instanceId);
        if (stats && stats[traitId]) {
            const oldValue = stats[traitId][statName];
            // Apply the update via setStats with just the changed trait/stat
            this.statsController.setStats(instanceId, { [traitId]: { [statName]: value } });
            // Notify listeners of the stat change
            this._notifyStatChangeListeners(instanceId, traitId, statName, value, oldValue);
            return true;
        }
        return false;
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
     * Retrieves the stats for a specific component.
     * @param {string} instanceId - The unique ID of the component instance.
     * @returns {Object|null}
     */
    getComponentStats(instanceId) {
        return this.statsController.getStats(instanceId);
    }

    /**
     * Returns the combined state of all components and the global trait molds.
     * @returns {Object}
     */
    getAll() {
        return {
            globalTraits: this.traitsController.getGlobalTraits(),
            registry: this.componentRegistry,
            instances: this.statsController.getAll()
        };
    }
}

export default ComponentController;

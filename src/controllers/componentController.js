import ComponentStatsController from './componentStatsController.js';
import TraitsController from './traitsController.js';

/**
 * ComponentController is responsible for communicating with all subcontrollers
 * related to components and routing requests to the appropriate logic.
 * Now implemented with a Default-Override Traits System.
 */
class ComponentController {
    constructor(statsController, traitsController, componentRegistry) {
        this.statsController = statsController;
        this.traitsController = traitsController;
        this.componentRegistry = componentRegistry || {};
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
        const stats = this.statsController.getStats(instanceId);
        if (stats && stats[traitId]) {
            stats[traitId][statName] = value;
            this.statsController.setStats(instanceId, stats);
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
        const stats = this.statsController.getStats(instanceId);
        if (stats && stats[traitId] && typeof stats[traitId][statName] === 'number') {
            stats[traitId][statName] += delta;
            this.statsController.setStats(instanceId, stats);
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

const ComponentStatsController = require('./componentStatsController');
const TraitsController = require('./traitsController');

/**
 * ComponentController is responsible for communicating with all subcontrollers
 * related to components and routing requests to the appropriate logic.
 * Now implemented with a Default-Override Traits System.
 */
class ComponentController {
    constructor(statsController, traitsController) {
        this.statsController = statsController;
        this.traitsController = traitsController;
        
        // Component Registry using Trait-based Blueprints
        // format: "component_id": { traits: { "TraitId": { "property": override_value } } }
        this.componentRegistry = {
            "centralBall": { 
                traits: { 
                    "Physical": { "mass": 20, "durability": 100 },
                    "Spatial": { "x": 0, "y": 0 }
                } 
            },
            "droidHead": { 
                traits: { 
                    "Physical": { "durability": 80 },
                    "Mind": { "think_level": 5},
                    "Spatial": { "x": 0, "y": -20 }
                } 
            },
            "droidArm": { 
                traits: { 
                    "Physical": { "durability": 50 },
                    "Spatial": { "x": 20, "y": 10 }
                } 
            },
            "droidHand": { 
                traits: { 
                    "Physical": { "durability": 40 },
                    "Spatial": { "x": 30, "y": 0 }
                } 
            },
            "humanoidDroidFinger": { 
                traits: { 
                    "Physical": { "durability": 30 },
                    "Spatial": { "x": 40, "y": 0 }
                } 
            },
            "droidRollingBall": { 
                traits: { 
                    "Physical": { "durability": 120 },
                    "Spatial": { "x": 0, "y": 20 },
                    "Movimentation": { "move": 20 },
                } 
            },
        };
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

module.exports = ComponentController;

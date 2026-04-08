/**
 * TraitsController implements the Default-Override architecture for component attributes.
 * It serves as the Source of Truth for global attribute molds (Global_Traits).
 */
class TraitsController {
    constructor() {
        // Global Traits (Source of Truth)
        // Defines the default molds for different categories of attributes.
        this.globalTraits = {
            "Physical": {
                "durability": 100,
                "mass": 10,
                "volume": 1,
                "temperature": 20
            },
            "Electronic": {
                "energy_capacity": 100,
                "processing_speed": 10,
                "connectivity": 1
            }
        };
    }

    /**
     * Adds or updates a property in a global trait.
     * This enables dynamic injection of new properties across all components.
     * @param {string} traitId - The ID of the trait (e.g., "Physical").
     * @param {string} propertyKey - The key of the property (e.g., "temperature").
     * @param {any} defaultValue - The value to set as the global default.
     */
    addGlobalProperty(traitId, propertyKey, defaultValue) {
        if (!this.globalTraits[traitId]) {
            this.globalTraits[traitId] = {};
        }
        this.globalTraits[traitId][propertyKey] = defaultValue;
    }

    /**
     * Performs the Merge Process to calculate the final state of a component.
     * Final Value = Component Override || Global Default Value.
     * @param {Object} blueprintTraits - The traits specified in the component blueprint.
     * @returns {Object} The merged stats object.
     */
    mergeTraits(blueprintTraits) {
        const finalStats = {};

        // Iterate through all traits defined in the blueprint
        for (const [traitId, overrides] of Object.entries(blueprintTraits)) {
            const globalDefaults = this.globalTraits[traitId] || {};
            
            // Initialize the trait category in the final stats
            finalStats[traitId] = { ...globalDefaults };

            // Apply overrides from the blueprint
            for (const [propertyKey, overrideValue] of Object.entries(overrides)) {
                finalStats[traitId][propertyKey] = overrideValue;
            }
        }

        return finalStats;
    }

    /**
     * Returns the current state of global traits.
     * @returns {Object}
     */
    getGlobalTraits() {
        return this.globalTraits;
    }
}

module.exports = TraitsController;

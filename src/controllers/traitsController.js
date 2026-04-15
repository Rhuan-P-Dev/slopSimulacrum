/**
 * TraitsController implements the Default-Override architecture for component attributes.
 * It serves as the Source of Truth for global attribute molds (Global_Traits).
 */
class TraitsController {
    /**
     * @param {Object} globalTraits - The registry of global trait defaults injected from Root Injector.
     */
    constructor(globalTraits = {}) {
        this.globalTraits = globalTraits;
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

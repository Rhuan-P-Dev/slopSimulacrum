/**
 * TraitsController implements the Default-Override architecture for component attributes.
 * It serves as the Source of Truth for global attribute molds (Global_Traits).
 * 
 * Per wiki/code_quality_and_best_practices.md §4.1: Documents the "why" of the Default-Override design.
 */
class TraitsController {
    /**
     * Creates a new TraitsController with the specified global trait defaults.
     * @param {Object<string, Object<string, any>>} [globalTraits={}] - Map of traitId → propertyKey → defaultValue.
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
     * @returns {void}
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
     * 
     * Merge algorithm:
     * 1. Start with global defaults for each trait
     * 2. Overlay blueprint overrides on top
     * 3. Return the merged result
     * 
     * @param {Object<string, Object<string, any>>} blueprintTraits - Map of traitId → propertyKey → overrideValue.
     * @returns {Object<string, Object<string, any>>} The merged stats object with all defaults applied.
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
     * Returns a deep copy of the current state of global traits.
     * @returns {Object<string, Object<string, any>>} A deep copy of the global traits map.
     */
    getGlobalTraits() {
        return JSON.parse(JSON.stringify(this.globalTraits));
    }
}

export default TraitsController;

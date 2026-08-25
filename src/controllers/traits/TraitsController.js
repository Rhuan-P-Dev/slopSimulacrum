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
     * Merge algorithm (4-layer order):
     * 1. Start with global defaults for each trait
     * 2. Overlay material-derived stats (if provided — from MaterialController)
     * 3. Overlay blueprint overrides on top (blueprint wins over materials)
     * 4. Return the merged result
     *
     * @param {Object<string, Object<string, any>>} blueprintTraits - Map of traitId → propertyKey → overrideValue.
     * @param {Object<string, Object<string, any>>} [materialDerived=null] - Optional material-derived stats from MaterialController.derive().
     * @returns {Object<string, Object<string, any>>} The merged stats object with all defaults applied.
     */
    mergeTraits(blueprintTraits, materialDerived = null) {
        const finalStats = {};

        // Collect all trait keys from blueprint and material-derived only (Fix 4: union of blueprint groups ∪ material-derived groups).
        // Global defaults are still used as the base for each key, but we only iterate keys that appear in blueprint or material-derived.
        const blueprintKeys = Object.keys(blueprintTraits || {});
        const derivedKeys = materialDerived ? Object.keys(materialDerived) : [];
        const allTraitKeys = new Set([...blueprintKeys, ...derivedKeys]);

        for (const traitId of allTraitKeys) {
            const globalDefaults = this.globalTraits[traitId] || {};
            const derivedStats = materialDerived && materialDerived[traitId] ? materialDerived[traitId] : {};
            const blueprintOverrides = blueprintTraits[traitId] || {};

            // Layer 1: global defaults → Layer 2: material-derived → Layer 3: blueprint overrides (blueprint wins)
            finalStats[traitId] = { ...globalDefaults, ...derivedStats, ...blueprintOverrides };
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

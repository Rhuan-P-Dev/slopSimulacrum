/**
 * ComponentStatsController is responsible for storing and managing the statistics
 * and attributes of individual component instances.
 */
class ComponentStatsController {
    constructor() {
        // stores stats for each component instance
        // Format: { [componentInstanceId]: { stat_name: value, ... } }
        this.componentStats = {};
    }

    /**
     * Sets or updates the stats for a specific component instance.
     * Performs a deep clone of the input to prevent external reference sharing.
     * @param {string} componentId - The unique ID of the component instance.
     * @param {Object} stats - The stats to set.
     * @returns {void}
     */
    setStats(componentId, stats) {
        if (!this.componentStats[componentId]) {
            this.componentStats[componentId] = {};
        }
        // Deep merge: clone existing + new stats to prevent reference sharing
        const existing = structuredClone(this.componentStats[componentId]);
        const incoming = structuredClone(stats);

        // Deep trait-level merge: merge within each trait category to preserve
        // other stats in the same trait when only a subset is updated.
        // e.g., updating Physical.durability must not erase Physical.mass, Physical.strength, etc.
        for (const [traitId, traitStats] of Object.entries(incoming)) {
            if (!existing[traitId]) {
                existing[traitId] = {};
            }
            existing[traitId] = { ...existing[traitId], ...traitStats };
        }

        this.componentStats[componentId] = existing;
    }

    /**
     * Retrieves a deep copy of the stats for a specific component instance.
     * Returns a defensive copy to prevent external mutation of internal state.
     * @param {string} componentId - The unique ID of the component instance.
     * @returns {Object|null} A deep copy of the component stats, or null if not found.
     */
    getStats(componentId) {
        const stats = this.componentStats[componentId];
        return stats ? structuredClone(stats) : null;
    }

    /**
     * Updates a single stat for a component instance.
     * @param {string} componentId - The unique ID of the component instance.
     * @param {string} statName - The name of the stat to update.
     * @param {any} value - The new value.
     * @returns {boolean} True if the stat was updated, false if the component was not found.
     */
    updateStat(componentId, statName, value) {
        if (this.componentStats[componentId]) {
            this.componentStats[componentId][statName] = value;
            return true;
        }
        return false;
    }

    /**
     * Returns a deep copy of all component stats.
     * @returns {Object} A deep copy of the internal stats store.
     */
    getAll() {
        return structuredClone(this.componentStats);
    }
}

export default ComponentStatsController;

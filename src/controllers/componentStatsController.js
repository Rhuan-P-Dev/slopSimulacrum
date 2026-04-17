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
        const existing = JSON.parse(JSON.stringify(this.componentStats[componentId]));
        const incoming = JSON.parse(JSON.stringify(stats));
        this.componentStats[componentId] = { ...existing, ...incoming };
    }

    /**
     * Retrieves a deep copy of the stats for a specific component instance.
     * Returns a defensive copy to prevent external mutation of internal state.
     * @param {string} componentId - The unique ID of the component instance.
     * @returns {Object|null} A deep copy of the component stats, or null if not found.
     */
    getStats(componentId) {
        const stats = this.componentStats[componentId];
        return stats ? JSON.parse(JSON.stringify(stats)) : null;
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
        return JSON.parse(JSON.stringify(this.componentStats));
    }
}

export default ComponentStatsController;

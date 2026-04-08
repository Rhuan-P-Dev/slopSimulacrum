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
     * @param {string} componentId - The unique ID of the component instance.
     * @param {Object} stats - The stats to set.
     * @returns {void}
     */
    setStats(componentId, stats) {
        if (!this.componentStats[componentId]) {
            this.componentStats[componentId] = {};
        }
        this.componentStats[componentId] = { ...this.componentStats[componentId], ...stats };
    }

    /**
     * Retrieves the stats for a specific component instance.
     * @param {string} componentId - The unique ID of the component instance.
     * @returns {Object|null} The stats of the component, or null if not found.
     */
    getStats(componentId) {
        return this.componentStats[componentId] || null;
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
     * Returns all component stats.
     * @returns {Object}
     */
    getAll() {
        return this.componentStats;
    }
}

module.exports = ComponentStatsController;

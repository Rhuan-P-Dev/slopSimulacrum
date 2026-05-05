/**
 * SynergyConfigManager — Loads and manages synergy configurations from data/synergy.json.
 * Single Responsibility: Load, validate, and provide synergy config for actions.
 *
 * Extracted from SynergyController to adhere to the Single Responsibility Principle.
 *
 * @module SynergyConfigManager
 */

import Logger from '../utils/Logger.js';
import DataLoader from '../utils/DataLoader.js';

const DEFAULT_SYNERGY_CONFIG = {
    enabled: false,
    multiEntity: false,
    scaling: 'linear',
    caps: {},
    componentGroups: []
};

class SynergyConfigManager {
    constructor() {
        this.synergyRegistry = null;
    }

    /**
     * Load synergy config from data/synergy.json.
     * @returns {Object} The synergy registry.
     */
    load() {
        this.synergyRegistry = DataLoader.loadJsonSafe('data/synergy.json') || {};
        Logger.info('[SynergyConfigManager] Synergy config loaded', {
            actionCount: Object.keys(this.synergyRegistry).length
        });
        return this.synergyRegistry;
    }

    /**
     * Get synergy config for an action.
     * @param {string} actionName - The action name.
     * @returns {Object} The synergy config (or default if none defined).
     */
    getConfig(actionName) {
        if (!this.synergyRegistry) return { ...DEFAULT_SYNERGY_CONFIG };
        const config = this.synergyRegistry[actionName];
        if (!config) return { ...DEFAULT_SYNERGY_CONFIG };
        return {
            enabled: config.enabled ?? false,
            multiEntity: config.multiEntity ?? false,
            scaling: config.scaling || 'linear',
            caps: config.caps || {},
            componentGroups: config.componentGroups || []
        };
    }

    /**
     * Check if synergy is enabled for an action.
     * @param {string} actionName - The action name.
     * @returns {boolean}
     */
    isEnabled(actionName) {
        const config = this.getConfig(actionName);
        return config.enabled === true;
    }

    /**
     * Get all actions that have synergy enabled.
     * @returns {string[]} Array of action names.
     */
    getActionsWithSynergy() {
        if (!this.synergyRegistry) return [];
        return Object.entries(this.synergyRegistry)
            .filter(([_, config]) => config.enabled === true)
            .map(([actionName]) => actionName);
    }

    /**
     * Count actions with synergy enabled.
     * @returns {number}
     */
    countActionsWithSynergy() {
        return this.getActionsWithSynergy().length;
    }

    /**
     * Get the full synergy registry.
     * @returns {Object}
     */
    getAllConfigs() {
        return this.synergyRegistry || {};
    }
}

export default SynergyConfigManager;
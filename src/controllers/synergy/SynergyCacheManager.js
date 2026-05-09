/**
 * SynergyCacheManager — Manages TTL-based caching of synergy results.
 * Single Responsibility: Get/set/clear/evict synergy computation cache entries.
 *
 * Extracted from SynergyController to adhere to the Single Responsibility Principle.
 *
 * @module SynergyCacheManager
 */

import Logger from '../../utils/Logger.js';
import { SYNERGY_CACHE_TTL_MS, SYNERGY_CACHE_MAX_SIZE } from '../../utils/Constants.js';

class SynergyCacheManager {
    constructor() {
        this._cache = new Map();
        this._ttlMs = SYNERGY_CACHE_TTL_MS;
    }

    /**
     * Get a cached synergy result if it exists and has not expired.
     * @param {string} actionName - The action name to look up.
     * @returns {Object|null} Cached result or null if expired/missing.
     */
    get(actionName) {
        const entry = this._cache.get(actionName);
        if (!entry) return null;

        const age = Date.now() - entry.timestamp;
        if (age > this._ttlMs) {
            this._cache.delete(actionName);
            Logger.debug(`[SynergyCacheManager] Cache expired for action "${actionName}" (${age}ms > ${this._ttlMs}ms)`);
            return null;
        }

        return entry.result;
    }

    /**
     * Set a cache entry with TTL and size eviction.
     * @param {string} actionName - The action name key.
     * @param {Object} result - The synergy result to cache.
     */
    set(actionName, result) {
        if (this._cache.size >= SYNERGY_CACHE_MAX_SIZE) {
            const firstKey = this._cache.keys().next().value;
            this._cache.delete(firstKey);
            Logger.debug(`[SynergyCacheManager] Cache full (${SYNERGY_CACHE_MAX_SIZE}), evicting oldest entry`);
        }

        this._cache.set(actionName, { result, timestamp: Date.now() });
    }

    /**
     * Clear the entire cache.
     */
    clear() {
        this._cache.clear();
        Logger.info('[SynergyCacheManager] Cache cleared');
    }

    /**
     * Get cache size.
     * @returns {number}
     */
    size() {
        return this._cache.size;
    }
}

export default SynergyCacheManager;
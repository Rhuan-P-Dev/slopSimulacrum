import { AppConfig } from './Config.js';

/**
 * SynergyPreviewController
 * A single-responsibility class for synergy preview fetching, caching, and range calculation.
 *
 * Encapsulates:
 * - Fetching synergy preview data from the server
 * - Caching the current synergy result
 * - Calculating effective ranges for MOVE/DASH actions with synergy multipliers
 *
 * @implements {ISynergyPreviewController}
 */

/**
 * @typedef {Object} SynergyPreviewResult
 * @property {Object} [actionData] - The action definition (targetingType, range, consequences, requirements)
 * @property {Object} [resolvedValues] - Consequence values with placeholders resolved
 * @property {Object} [synergyResult] - The computed synergy (multiplier, contributingComponents, etc.)
 */

/**
 * @typedef {Object} ComponentSelection
 * @property {string} componentId - The unique component identifier
 * @property {string} role - The role of the component (e.g., 'source')
 */

/**
 * @typedef {Object} DroidEntity
 * @property {Array<Object>} components - Array of component objects with `id` property
 */

/**
 * @typedef {Object} GameState
 * @property {Object} components - Components state
 * @property {Object} components.instances - Map of componentId → stats
 */

/**
 * @typedef {Object} IActionManager
 * @property {function(string, string, Array<ComponentSelection>): Promise<Object|null>} previewActionData
 */

/**
 * @typedef {Object} IControllerConfig
 * @property {Object} [MULTIPLIERS] - Configuration multipliers
 * @property {number} [MULTIPLIERS.DASH_RANGE] - DASH range multiplier
 * @property {Object} [ACTIONS] - Action type constants
 * @property {string} [ACTIONS.MOVE] - MOVE action name
 * @property {string} [ACTIONS.DASH] - DASH action name
 */

/**
 * @interface ISynergyPreviewController
 */
class SynergyPreviewController {
    /**
     * Creates a new SynergyPreviewController.
     *
     * @param {IActionManager} actions - The ActionManager instance for fetching preview data.
     * @param {IControllerConfig} [config] - Configuration object (defaults to AppConfig).
     */
    constructor(actions, config = AppConfig) {
        /**
         * The ActionManager instance for fetching preview data.
         * @type {IActionManager}
         */
        this.actions = actions;

        /**
         * Configuration object for defaults.
         * @type {IControllerConfig}
         */
        this.config = config;

        /**
         * Cached synergy preview result.
         * @type {SynergyPreviewResult|null}
         */
        this.currentSynergyResult = null;
    }

    /**
     * Fetches a live synergy preview from the server and caches the result.
     *
     * Builds the payload with componentIds [{componentId, role: 'source'}],
     * calls actions.previewActionData(), and stores the synergyResult.
     *
     * @param {string} actionName - The action name to preview.
     * @param {string} entityId - The entity ID to preview for.
     * @param {Array<string>} componentIds - Array of component ID strings to include.
     * @returns {Promise<SynergyPreviewResult|null>} Full preview object with actionData, resolvedValues, synergyResult, or null on failure.
     */
    async fetchPreview(actionName, entityId, componentIds) {
        if (!actionName || !entityId || !componentIds || componentIds.length < 1) {
            console.warn('[SynergyPreviewController] fetchPreview: Invalid input parameters', { actionName, entityId, componentCount: componentIds?.length });
            this.currentSynergyResult = null;
            return null;
        }

        try {
            const componentPayload = componentIds.map(compId => ({
                componentId: compId,
                role: 'source'
            }));

            const preview = await this.actions.previewActionData(
                actionName,
                entityId,
                componentPayload
            );

            if (preview) {
                // Store synergy result for range calculation
                this.currentSynergyResult = preview.synergyResult || null;

                console.log('[SynergyPreviewController] Preview fetched successfully', {
                    actionName,
                    componentCount: componentIds.length,
                    hasSynergy: !!preview.synergyResult
                });

                return preview;
            } else {
                this.currentSynergyResult = null;
                console.warn('[SynergyPreviewController] Preview returned null', { actionName });
                return null;
            }
        } catch (error) {
            console.error('[SynergyPreviewController] fetchPreview failed', {
                actionName,
                entityId,
                error: error.message
            });
            this.currentSynergyResult = null;
            return null;
        }
    }

    /**
     * Calculates the effective range of an action.
     *
     * For actions with explicit `range` in action data: returns that value.
     * For MOVE/DASH actions:
     * - Finds the component with the highest move stat
     * - Applies the synergy multiplier to the move stat
     * - Returns effective range (for DASH: effectiveMove * DASH_RANGE multiplier)
     *
     * @param {string} actionName - The action name to calculate range for.
     * @param {Object} actionData - The action definition (may contain explicit `range`).
     * @param {DroidEntity} droid - The droid entity object.
     * @param {GameState} state - The game state object.
     * @param {number} [synergyMultiplier=1.0] - Synergy multiplier from current preview.
     * @returns {number|null} Effective range, or null if calculation is not possible.
     */
    calculateRange(actionName, actionData, droid, state, synergyMultiplier = 1.0) {
        // Return explicit range if defined in action data
        if (actionData && typeof actionData.range === 'number' && actionData.range > 0) {
            return actionData.range;
        }

        // Check if config has ACTIONS constants, fall back to string comparison
        const isMove = actionName === (this.config.ACTIONS?.MOVE || 'move');
        const isDash = actionName === (this.config.ACTIONS?.DASH || 'dash');

        if (!isMove && !isDash) {
            return null;
        }

        if (!droid || !droid.components || !state || !state.components || !state.components.instances) {
            console.warn('[SynergyPreviewController] calculateRange: Missing required data', {
                hasDroid: !!droid,
                hasComponents: !!(droid?.components),
                hasState: !!state,
                hasComponentInstances: !!(state?.components?.instances)
            });
            return null;
        }

        // Find the component with the highest move stat
        let maxMoveStat = null;
        for (const comp of droid.components) {
            const stats = state.components.instances[comp.id];
            if (stats && stats.Movement && stats.Movement.move !== undefined) {
                if (maxMoveStat === null || stats.Movement.move > maxMoveStat) {
                    maxMoveStat = stats.Movement.move;
                }
            }
        }

        if (maxMoveStat === null) {
            console.warn('[SynergyPreviewController] calculateRange: No movement stat found');
            return null;
        }

        // Apply synergy multiplier to the move stat before calculating range
        const effectiveMove = maxMoveStat * synergyMultiplier;
        const dashRangeMultiplier = this.config.MULTIPLIERS?.DASH_RANGE || 1.0;

        console.log('[SynergyPreviewController] Range calculated', {
            actionName,
            maxMoveStat,
            synergyMultiplier,
            effectiveMove,
            isDash,
            finalRange: isDash ? effectiveMove * dashRangeMultiplier : effectiveMove
        });

        return isDash ? effectiveMove * dashRangeMultiplier : effectiveMove;
    }

    /**
     * Returns the range for a specific action name from available actions cache.
     * Used by App.js to get range for non-MOVE/DASH actions.
     *
     * @param {string} actionName - The action name.
     * @param {Object} availableActions - The available actions cache.
     * @returns {number|null} Explicit range or null.
     */
    static getExplicitRange(actionName, availableActions) {
        const actionData = availableActions?.[actionName];
        if (actionData && typeof actionData.range === 'number' && actionData.range > 0) {
            return actionData.range;
        }
        return null;
    }

    /**
     * Returns the cached synergy result.
     *
     * @returns {SynergyPreviewResult|null} The current cached synergy result, or null.
     */
    getCachedSynergyResult() {
        return this.currentSynergyResult;
    }

    /**
     * Sets the cached synergy result.
     * Called after fetchPreview to store the result.
     *
     * @param {SynergyPreviewResult|null} result - The synergy result to cache.
     */
    setSynergyResult(result) {
        this.currentSynergyResult = result;
        console.log('[SynergyPreviewController] Synergy result cached', {
            hasResult: !!result
        });
    }

    /**
     * Clears the cached synergy result.
     */
    clearCache() {
        console.log('[SynergyPreviewController] Cache cleared');
        this.currentSynergyResult = null;
    }
}

export { SynergyPreviewController };

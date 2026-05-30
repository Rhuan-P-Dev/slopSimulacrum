/**
 * RangeValidator — Validates spatial range for proximity-based actions.
 * Single Responsibility: Check if source and target are within range, execute range-failure consequences.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * @module RangeValidator
 */

import Logger from '../../utils/Logger.js';
import { checkGrabRange } from '../../utils/RangeChecker.js';
import { resolvePlaceholders } from '../../utils/PlaceholderResolver.js';

class RangeValidator {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     * @param {ActionController} actionController - Reference to ActionController for consequence execution.
     */
    constructor(worldStateController, actionController) {
        this.worldStateController = worldStateController;
        this.actionController = actionController;
    }

    /**
     * Checks if a grab action is within range of the target entity.
     * Resolves range expressions (e.g., ":Physical.strength*2") using the same
     * PlaceholderResolver logic used by consequences and failureConsequences.
     *
     * @param {string} sourceEntityId - The entity performing the grab.
     * @param {string} targetEntityId - The entity being grabbed.
     * @param {string|number} maxRange - The maximum allowed distance (number or expression string).
     * @returns {{ success: boolean, error?: string }}
     */
    checkGrabRange(sourceEntityId, targetEntityId, maxRange) {
        const sourceEntity = this.worldStateController.getEntity(sourceEntityId);
        if (!sourceEntity) {
            return { success: false, error: `Source entity "${sourceEntityId}" not found.` };
        }

        const targetEntity = this.worldStateController.getEntity(targetEntityId);
        if (!targetEntity) {
            return { success: false, error: `Target entity "${targetEntityId}" not found.` };
        }

        // Resolve range expression using PlaceholderResolver (same logic as consequences)
        if (typeof maxRange === 'string') {
            const requirementValues = this._resolveRequirementValues(sourceEntityId);
            const resolved = resolvePlaceholders(maxRange, requirementValues);
            maxRange = typeof resolved === 'number' ? resolved : Number(resolved);
        }

        // Guard: negative or NaN resolved values are invalid — fail the check
        // rather than throwing, to allow graceful handling by the caller.
        if (typeof maxRange !== 'number' || maxRange <= 0 || !isFinite(maxRange)) {
            Logger.warn(`[RangeValidator] Invalid resolved range: ${maxRange}. Action cannot proceed.`);
            return { success: false, error: `Invalid range value: ${maxRange}.` };
        }

        return checkGrabRange(sourceEntity, targetEntity, maxRange);
    }

    /**
     * Resolves requirement values for an entity by gathering all trait stats
     * from its components. Builds a map of "trait.stat" → numeric value.
     * Uses the same resolution pattern as RequirementResolver.resolveRequirementValues().
     *
     * @param {string} entityId - The entity ID.
     * @returns {Object} Map of "trait.stat" → numeric value.
     * @private
     */
    _resolveRequirementValues(entityId) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity || !entity.components) return {};

        const values = {};
        for (const comp of entity.components) {
            const stats = this.worldStateController.getComponentStats(comp.id);
            if (stats) {
                for (const [traitId, traitData] of Object.entries(stats)) {
                    for (const [statName, statValue] of Object.entries(traitData)) {
                        if (typeof statValue === 'number') {
                            values[`${traitId}.${statName}`] = statValue;
                        }
                    }
                }
            }
        }
        return values;
    }

    /**
     * Executes consequences when a range check fails.
     * @param {string} entityId - The entity that attempted the action.
     * @param {string} actionName - The action that failed the range check.
     * @returns {{ success: boolean, results?: Array }}
     */
    executeRangeFailureConsequences(entityId, actionName) {
        const actionData = this.actionController.actionRegistry[actionName];
        if (!actionData || !actionData.consequences || !Array.isArray(actionData.consequences)) {
            return { success: false, error: `Action "${actionName}" has no failure consequences defined.` };
        }

        const results = [];
        for (const consequence of actionData.consequences) {
            if (consequence?.type === 'rangeFailure') {
                try {
                    const result = this.actionController.consequenceHandlers.handle(
                        'rangeFailure',
                        { entityId, ...consequence.params },
                        { entityId }
                    );
                    results.push({ success: true, type: 'rangeFailure', ...result });
                } catch (error) {
                    const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
                    Logger.error(`[RangeValidator] Failed to execute range failure consequence for "${actionName}": ${errorMsg}`);
                    results.push({ success: false, type: 'rangeFailure', error: errorMsg });
                }
            }
        }

        return { success: true, executedRangeConsequences: results.length, results };
    }
}

export default RangeValidator;
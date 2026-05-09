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
     * @param {string} sourceEntityId - The entity performing the grab.
     * @param {string} targetEntityId - The entity being grabbed.
     * @param {number} maxRange - The maximum allowed distance.
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

        return checkGrabRange(sourceEntity, targetEntity, maxRange);
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
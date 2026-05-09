/**
 * ConsequenceDispatcher — Executes action consequences via the handler system.
 * Single Responsibility: Resolve placeholders, apply synergy, and dispatch consequences to handlers.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - Each consequence MUST have a 'target' field: 'self', 'target', or 'entity'.
 * - 'self'    → The source component that fulfilled the action's requirements.
 * - 'target'  → The explicitly targeted component/entity (from actionParams).
 * - 'entity'  → The entire entity performing the action.
 *
 * @module ConsequenceDispatcher
 */

import Logger from '../utils/Logger.js';
import { resolvePlaceholders } from '../utils/PlaceholderResolver.js';
import { SYNERGY_BONUS_THRESHOLD } from '../utils/Constants.js';

class ConsequenceDispatcher {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     * @param {ActionController} actionController - Reference to ActionController.
     * @param {SynergyController} [synergyController] - The synergy system controller.
     */
    constructor(worldStateController, actionController, synergyController) {
        this.worldStateController = worldStateController;
        this.actionController = actionController;
        this.synergyController = synergyController;
    }

    /**
     * Executes success consequences for an action.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity performing the action.
     * @param {Object} requirementValues - Map of trait.stat values.
     * @param {Object} params - Action parameters.
     * @param {Object} fulfillingComponents - Map of requirements to components.
     * @param {Object} [synergyResult] - Optional synergy computation result.
     * @returns {Object} Result of consequence execution.
     */
    execute(actionName, entityId, requirementValues, params, fulfillingComponents = {}, synergyResult = null) {
        const action = this.actionController.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }

        const results = [];
        const context = {
            requirementValues,
            actionParams: { ...params, entityId },
            fulfillingComponents,
            synergyResult
        };

        for (const consequence of action.consequences) {
            const resolvedParams = this._resolveParams(consequence.params, requirementValues, params);

            const handler = this.actionController.consequenceHandlers.handlers[consequence.type];
            if (!handler) {
                results.push({ success: false, error: `Unknown consequence type: "${consequence.type}"` });
                continue;
            }

            try {
                const effectiveParams = this._applySynergy(resolvedParams, synergyResult);
                const targetResult = this._resolveTargetForConsequence(consequence, entityId, params, fulfillingComponents, action, actionName);

                if (!targetResult.success) {
                    results.push({
                        success: false,
                        error: this._resolveError({
                            code: 'CONSEQUENCE_EXECUTION_FAILED',
                            details: { type: consequence.type, error: targetResult.error }
                        }),
                        type: consequence.type
                    });
                    continue;
                }

                // Pass the consequence target type to the handler for interpretation
                const handlerContext = { ...context, actionParams: { ...context.actionParams, consequenceTarget: consequence.target } };
                const result = handler(targetResult.targetId, effectiveParams, handlerContext);

                results.push({
                    success: true,
                    type: consequence.type,
                    synergyApplied: synergyResult !== null,
                    target: consequence.target,
                    ...result
                });
            } catch (error) {
                const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
                results.push({
                    success: false,
                    error: this._resolveError({
                        code: 'CONSEQUENCE_EXECUTION_FAILED',
                        details: { type: consequence.type, error: errorMsg }
                    }),
                    type: consequence.type
                });
            }
        }

        return { success: true, executedConsequences: results.length, results };
    }

    /**
     * Executes consequences for multi-attacker punch actions.
     * Each attacker deals its own separate damage.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The attacking entity ID.
     * @param {Array<string>} attackerComponentIds - Array of attacker component IDs.
     * @param {Object} params - Action parameters.
     * @param {Object} [synergyResult] - Optional synergy computation result.
     * @returns {Object} Result of consequence execution.
     */
    executeMultiAttacker(actionName, entityId, attackerComponentIds, params, synergyResult = null) {
        const action = this.actionController.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }

        const allResults = [];
        const targetComponentId = params.targetComponentId;

        for (const attackerId of attackerComponentIds) {
            const attackerStats = this.worldStateController.componentController.getComponentStats(attackerId);
            if (!attackerStats || !attackerStats.Physical || attackerStats.Physical.strength === undefined) {
                Logger.warn(`[ConsequenceDispatcher] Attacker "${attackerId}" has no Physical.strength — skipping`);
                continue;
            }

            const attackerStrength = attackerStats.Physical.strength;
            const perAttackerReqValues = { 'Physical.strength': attackerStrength };
            const perAttackerFulfilling = { 'Physical.strength': attackerId };
            const perAttackerParams = { ...params, attackerComponentId: attackerId };

            const perAttackerConsequences = this._buildPerAttackerConsequences(action, attackerStrength);

            for (const consequence of perAttackerConsequences) {
                const handler = this.actionController.consequenceHandlers.handlers[consequence.type];
                if (!handler) {
                    allResults.push({ success: false, error: `Unknown consequence type: "${consequence.type}"` });
                    continue;
                }

                try {
                    const resolvedParams = this._resolveParams(consequence.params, perAttackerReqValues, perAttackerParams);
                    const effectiveParams = this._applySynergy(resolvedParams, synergyResult);

                    const targetResult = this._resolveTargetForConsequence(consequence, entityId, perAttackerParams, perAttackerFulfilling, action, actionName);

                    if (!targetResult.success) {
                        allResults.push({
                            success: false,
                            error: this._resolveError({
                                code: 'CONSEQUENCE_EXECUTION_FAILED',
                                details: { type: consequence.type, error: targetResult.error }
                            }),
                            type: consequence.type,
                            attackerComponentId: attackerId
                        });
                        continue;
                    }

                    // Pass the consequence target type to the handler for interpretation
                    const handlerContext = {
                        requirementValues: perAttackerReqValues,
                        actionParams: { ...perAttackerParams, consequenceTarget: consequence.target },
                        fulfillingComponents: perAttackerFulfilling,
                        synergyResult,
                        attackerComponentId: attackerId
                    };
                    const result = handler(targetResult.targetId, effectiveParams, handlerContext);

                    allResults.push({
                        success: true,
                        type: consequence.type,
                        target: consequence.target,
                        attackerComponentId: attackerId,
                        synergyApplied: synergyResult !== null,
                        ...result
                    });
                } catch (error) {
                    const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
                    allResults.push({
                        success: false,
                        error: this._resolveError({
                            code: 'CONSEQUENCE_EXECUTION_FAILED',
                            details: { type: consequence?.type || 'unknown', error: errorMsg }
                        }),
                        type: consequence?.type || 'unknown',
                        attackerComponentId: attackerId
                    });
                }
            }
        }

        return {
            success: true,
            executedConsequences: allResults.filter(r => r.success).length,
            executedPerAttacker: attackerComponentIds.length,
            results: allResults
        };
    }

    /**
     * Executes failure consequences for an action.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Result of failure consequence execution.
     */
    executeFailure(actionName, entityId) {
        const action = this.actionController.actionRegistry[actionName];
        if (!action || !action.failureConsequences) {
            return { success: false, error: `Action "${actionName}" has no failure consequences defined.` };
        }

        const results = [];
        for (const consequence of action.failureConsequences) {
            const resolvedParams = this._resolveParams(consequence.params, {}, {});
            const handler = this.actionController.consequenceHandlers.handlers[consequence.type];

            if (!handler) {
                results.push({
                    success: false,
                    error: `Unknown consequence type: "${consequence.type}"`,
                    type: consequence.type
                });
                continue;
            }

            const targetResult = this._resolveTargetForConsequence(consequence, entityId, {}, {}, action, actionName);

            if (!targetResult.success) {
                results.push({
                    success: false,
                    error: this._resolveError({
                        code: 'CONSEQUENCE_EXECUTION_FAILED',
                        details: { type: consequence.type, error: targetResult.error }
                    }),
                    type: consequence.type
                });
                continue;
            }

            // Pass the consequence target type to the handler for interpretation
            const handlerContext = { actionParams: { consequenceTarget: consequence.target } };
            results.push({
                success: true,
                type: consequence.type,
                target: consequence.target,
                ...handler(targetResult.targetId, resolvedParams, handlerContext)
            });
        }

        return { success: false, executedFailureConsequences: results.length, results };
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Resolves placeholders in consequence params.
     * @private
     */
    _resolveParams(params, requirementValues, actionParams) {
        return resolvePlaceholders(params, requirementValues);
    }

    /**
     * Applies synergy multiplier to numeric consequence properties.
     * @private
     */
    _applySynergy(params, synergyResult) {
        if (synergyResult && synergyResult.synergyMultiplier > SYNERGY_BONUS_THRESHOLD &&
            typeof params === 'object' && params !== null) {
            for (const [key, val] of Object.entries(params)) {
                if (typeof val === 'number') {
                    params[key] = this.synergyController
                        ? this.synergyController.applySynergyToResult(synergyResult, val)
                        : val;
                }
            }
        }
        return params;
    }

    /**
     * Resolves the target ID for a consequence based on its 'target' field.
     *
     * Target types:
     * - 'self':    The source component that fulfilled the action's requirements.
     * - 'target':  The explicitly targeted component/entity from action params.
     * - 'entity':  The entire entity performing the action.
     *
     * @private
     */
    _resolveTargetForConsequence(consequence, entityId, params, fulfillingComponents, action, actionName) {
        // MANDATORY: target field must be specified
        if (!consequence.target) {
            Logger.error(
                `[ConsequenceDispatcher] Consequence type "${consequence.type}" in action "${actionName || 'unknown'}" ` +
                `is missing required 'target' field. Expected: 'self', 'target', or 'entity'.`
            );
            return { success: false, error: 'Missing target field' };
        }

        const targetType = consequence.target;

        switch (targetType) {
            case 'self': {
                // Find the source component that fulfilled the requirement
                const selfKey = Object.keys(fulfillingComponents).find(k => fulfillingComponents[k]);
                const componentId = fulfillingComponents[selfKey] || entityId;
                return { success: true, targetId: componentId };
            }
            case 'target': {
                // Use explicitly targeted component or entity
                const targetId = params.targetComponentId || params.targetEntityId || entityId;
                return { success: true, targetId };
            }
            case 'entity':
                return { success: true, targetId: entityId };
            default:
                Logger.error(
                    `[ConsequenceDispatcher] Unknown target type "${targetType}" for consequence ` +
                    `"${consequence.type}" in action "${actionName || 'unknown'}". Expected: 'self', 'target', or 'entity'.`
                );
                return { success: false, error: `Unknown target type: ${targetType}` };
        }
    }

    /**
     * Builds per-attacker consequences from action definition.
     * @private
     */
    _buildPerAttackerConsequences(action, attackerStrength) {
        return action.consequences.map(consequence => {
            if (consequence.type === 'damageComponent') {
                return {
                    type: 'damageComponent',
                    target: consequence.target,
                    params: {
                        trait: consequence.params.trait,
                        stat: consequence.params.stat,
                        value: -attackerStrength
                    }
                };
            }
            if (consequence.type === 'log' && consequence?.params?.message) {
                return {
                    type: 'log',
                    target: consequence.target,
                    params: {
                        ...consequence.params,
                        message: consequence.params.message.replace(/:Physical\.strength/g, String(attackerStrength))
                    }
                };
            }
            return consequence;
        });
    }

    /**
     * Resolves a structured error to a human-readable message.
     * @private
     */
    _resolveError(error) {
        if (!error || !error.code) {
            Logger.error('An unknown error occurred.');
            return 'An unknown error occurred.';
        }

        const ERROR_REGISTRY = {
            'CONSEQUENCE_EXECUTION_FAILED': {
                message: 'Failed to execute consequence {type}: {error}',
                level: 'ERROR'
            }
        };

        const registryEntry = ERROR_REGISTRY[error.code];
        if (!registryEntry) {
            Logger.error(`An undefined error occurred: ${error.code}`);
            return 'An undefined error occurred.';
        }

        let message = registryEntry.message;
        if (error.details) {
            for (const [key, value] of Object.entries(error.details)) {
                message = message.replace(`{${key}}`, value);
            }
        }

        const logLevel = registryEntry.level || 'ERROR';
        Logger[logLevel.toLowerCase()](message, error.details);

        return message;
    }
}

export default ConsequenceDispatcher;
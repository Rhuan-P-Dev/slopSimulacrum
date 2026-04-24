import Logger from '../utils/Logger.js';

/**
 * Error code registry for structured error handling.
 * @readonly
 * @enum {string}
 */
const ERROR_REGISTRY = {
    'ENTITY_NOT_FOUND': { message: 'Entity "{entityId}" not found.', level: 'ERROR' },
    'ACTION_NOT_FOUND': { message: 'Action "{actionName}" not found.', level: 'ERROR' },
    'MISSING_TRAIT_STAT': { message: 'No component possesses the required {trait}.{stat} (>= {minValue})', level: 'WARN' },
    'UNKNOWN_REQUIREMENT_FAILURE': { message: 'Action requirements were not met.', level: 'WARN' },
    'CONSEQUENCE_EXECUTION_FAILED': { message: 'Failed to execute consequence {type}: {error}', level: 'ERROR' },
    'SYSTEM_RUNTIME_ERROR': { message: 'An unexpected system error occurred: {error}', level: 'CRITICAL' },
};

/**
 * ActionController handles game actions, checking requirements and
 * executing consequences through a decoupled handler system.
 *
 * Component capability management (scanning, caching, scoring, re-evaluation)
 * has been extracted to ComponentCapabilityController to adhere to the
 * Single Responsibility Principle.
 *
 * ActionController responsibilities:
 * - Action execution (executeAction)
 * - Entity-level requirement validation (checkRequirements, _checkRequirements)
 * - Consequence execution (_executeConsequences)
 * - Placeholder resolution (_resolvePlaceholders)
 * - Delegates capability cache queries to ComponentCapabilityController
 *
 * @example
 * // Architecture flow:
 * // Server -> WorldStateController -> ActionController (executeAction)
 * // Server -> WorldStateController -> ComponentCapabilityController (capability queries)
 */
class ActionController {
    /**
     * @param {WorldStateController} worldStateController - The main world state controller.
     * @param {ConsequenceHandlers} consequenceHandlers - The consequence handler system.
     * @param {Object} actionRegistry - The registry of available actions.
     * @param {ComponentCapabilityController} componentCapabilityController - The capability cache manager.
     * @param {SynergyController} [synergyController] - The synergy system controller (optional).
     */
    constructor(worldStateController, consequenceHandlers, actionRegistry, componentCapabilityController, synergyController) {
        this.worldStateController = worldStateController;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry || {};
        this.componentCapabilityController = componentCapabilityController;
        this.synergyController = synergyController || null;
    }

    // =========================================================================
    // PUBLIC API: CAPABILITY DELEGATION
    // =========================================================================
    // All capability cache operations are delegated to ComponentCapabilityController.
    // These wrapper methods maintain backward compatibility for existing callers.

    /**
     * Scans all entities and their components against all registered actions.
     * Delegates to ComponentCapabilityController.scanAllCapabilities().
     *
     * @param {Object} state - The current world state (contains entities).
     * @returns {Object<string, Array<ComponentCapabilityEntry>>} The updated capability cache.
     */
    scanAllCapabilities(state) {
        return this.componentCapabilityController.scanAllCapabilities(state);
    }

    /**
     * Returns the cached capability entries for all actions.
     * Delegates to ComponentCapabilityController.getCachedCapabilities().
     *
     * @returns {Object<string, Array<ComponentCapabilityEntry>>} The capability cache.
     */
    getCachedCapabilities() {
        return this.componentCapabilityController.getCachedCapabilities();
    }

    /**
     * Returns the best component entry for a specific action (highest score).
     * Delegates to ComponentCapabilityController.getBestComponentForAction().
     * @param {string} actionName - The action name.
     * @returns {ComponentCapabilityEntry|null} The best capability entry, or null if none.
     */
    getBestComponentForAction(actionName) {
        return this.componentCapabilityController.getBestComponentForAction(actionName);
    }

    /**
     * Returns all capability entries for a specific action.
     * Delegates to ComponentCapabilityController.getAllCapabilitiesForAction().
     * @param {string} actionName - The action name.
     * @returns {Array<ComponentCapabilityEntry>} Array of capability entries (sorted by score).
     */
    getAllCapabilitiesForAction(actionName) {
        return this.componentCapabilityController.getAllCapabilitiesForAction(actionName);
    }

    /**
     * Returns capability entries for a specific entity across all actions.
     * Delegates to ComponentCapabilityController.getCapabilitiesForEntity().
     *
     * @param {string} entityId - The entity ID.
     * @returns {Array<ComponentCapabilityEntry>} Array of capability entries for this entity.
     */
    getCapabilitiesForEntity(entityId) {
        return this.componentCapabilityController.getCapabilitiesForEntity(entityId);
    }

    /**
     * Retrieves only the actions that are relevant to a specific entity.
     * Delegates to ComponentCapabilityController.getActionsForEntity().
     *
     * @param {Object} state - The current world state.
     * @param {string} entityId - The ID of the entity to filter for.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     * Map of actions and their capability status for the entity.
     */
    getActionsForEntity(state, entityId) {
        return this.componentCapabilityController.getActionsForEntity(state, entityId);
    }

    /**
     * Calculates which entities are capable of executing which actions based on the current world state.
     * Delegates to ComponentCapabilityController.getActionCapabilities().
     *
     * @param {Object} state - The current world state.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     * Map of actions and their capability status.
     */
    getActionCapabilities(state) {
        return this.componentCapabilityController.getActionCapabilities(state);
    }

    /**
     * Re-evaluates ALL actions for a specific entity.
     * Delegates to ComponentCapabilityController.reEvaluateEntityCapabilities().
     *
     * @param {Object} state - The current world state.
     * @param {string} entityId - The entity to re-evaluate.
     * @returns {Array<ComponentCapabilityEntry>} List of updated capability entries.
     */
    reEvaluateEntityCapabilities(state, entityId) {
        return this.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
    }

    /**
     * Removes all capability entries for an entity from all action caches.
     * Delegates to ComponentCapabilityController.removeEntityFromCache().
     *
     * @param {string} entityId - The entity ID to remove.
     */
    removeEntityFromCache(entityId) {
        this.componentCapabilityController.removeEntityFromCache(entityId);
    }

    // =========================================================================
    // PUBLIC API: ACTION EXECUTION
    // =========================================================================

    /**
     * Checks if an entity meets the requirements for an action.
     * Uses entity-level requirement checking (can combine multiple components).
     *
     * @param {string} actionName - The name of the action to check.
     * @param {string} entityId - The entity ID to check.
     * @returns {{passed: boolean, error?: {code: string, details: Object}, componentId?: string, requirementValues?: Object, fulfillingComponents?: Object}}
     * Result indicating if requirements were passed and which components fulfilled them.
     */
    checkRequirements(actionName, entityId) {
        const action = this.actionRegistry[actionName];
        if (!action) {
            return {
                passed: false,
                error: { code: 'ACTION_NOT_FOUND', details: { actionName } }
            };
        }
        return this._checkRequirements(action.requirements, entityId);
    }

    /**
     * Executes an action on an entity.
     * For actions with both attacker and target components (e.g., punch),
     * uses the attacker's component for requirement value resolution and
     * the target's component for consequence application.
     *
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity to perform the action.
     * @param {Object} [params] - Additional action parameters.
     * @param {string} [params.attackerComponentId] - The component performing the action (used for damage value resolution).
     * @param {string} [params.targetComponentId] - The component being targeted (used for consequence application).
     * @returns {Object} Result of the action execution.
     */
    executeAction(actionName, entityId, params = {}) {
        try {
            const action = this.actionRegistry[actionName];

            if (!action) {
                return {
                    success: false,
                    error: this._resolveError({
                        code: 'ACTION_NOT_FOUND',
                        details: { actionName }
                    })
                };
            }

            // Determine which component's stats to use for requirement value resolution
            // Priority: attackerComponentId (for actions like punch) > targetComponentId > entity-wide check
            let requirementValues = {};
            let fulfillingComponents = {};

            if (params && params.attackerComponentId) {
                // Use the attacker component's stats (e.g., droidHand for punch action)
                const attackerComponentId = params.attackerComponentId;
                const componentStats = this.worldStateController.componentController.getComponentStats(attackerComponentId);

                if (componentStats) {
                    // Check that this component meets the requirements
                    const componentCheck = this._checkRequirementsForComponent(
                        action.requirements, entityId, attackerComponentId
                    );

                    if (!componentCheck.passed) {
                        const errorMessage = this._resolveError(componentCheck.error);
                        const failureResults = this._executeFailureConsequences(actionName, entityId);
                        return {
                            success: false,
                            error: `Requirement failed: ${errorMessage}`,
                            ...failureResults
                        };
                    }

                    requirementValues = componentCheck.requirementValues;
                    fulfillingComponents = componentCheck.fulfillingComponents;
                }
            } else if (params && params.targetComponentId) {
                // Legacy: Use the explicitly selected component's stats
                const selectedComponentId = params.targetComponentId;
                const componentStats = this.worldStateController.componentController.getComponentStats(selectedComponentId);

                if (componentStats) {
                    // Check that this component meets the requirements
                    const componentCheck = this._checkRequirementsForComponent(
                        action.requirements, entityId, selectedComponentId
                    );

                    if (!componentCheck.passed) {
                        const errorMessage = this._resolveError(componentCheck.error);
                        const failureResults = this._executeFailureConsequences(actionName, entityId);
                        return {
                            success: false,
                            error: `Requirement failed: ${errorMessage}`,
                            ...failureResults
                        };
                    }

                    requirementValues = componentCheck.requirementValues;
                    fulfillingComponents = componentCheck.fulfillingComponents;
                }
            } else {
                // Fallback: use entity-wide requirement checking
                const requirementCheck = this._checkRequirements(action.requirements, entityId);
                if (!requirementCheck.passed) {
                    const errorMessage = this._resolveError(requirementCheck.error);
                    const failureResults = this._executeFailureConsequences(actionName, entityId);
                    return {
                        success: false,
                        error: `Requirement failed: ${errorMessage}`,
                        ...failureResults
                    };
                }
                requirementValues = requirementCheck.requirementValues;
                fulfillingComponents = requirementCheck.fulfillingComponents;
            }

            // Compute synergy if enabled for this action
            let synergyResult = null;
            if (this.synergyController) {
                synergyResult = this.synergyController.computeSynergy(
                    actionName,
                    entityId,
                    { synergyGroups: params?.synergyGroups }
                );
            }

            // Execute success consequences (with synergy applied)
            const consequenceResult = this._executeConsequences(
                actionName,
                entityId,
                requirementValues,
                params,
                fulfillingComponents,
                synergyResult
            );

            return {
                success: true,
                action: actionName,
                entityId,
                synergy: synergyResult,
                ...consequenceResult
            };
        } catch (error) {
            return {
                success: false,
                error: this._resolveError({
                    code: 'SYSTEM_RUNTIME_ERROR',
                    details: { error: error.message }
                })
            };
        }
    }

    // =========================================================================
    // PRIVATE: ENTITY-LEVEL REQUIREMENT CHECKING
    // =========================================================================

    /**
     * Checks if an entity meets the requirements for an action.
     * Requirements can be satisfied by multiple components.
     * Used during action execution for entity-wide checks.
     *
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID to check.
     * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, componentId?: string, error?: {code: string, details: Object}}}
     * @private
     */
    _checkRequirements(requirements, entityId) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return {
                passed: false,
                error: { code: 'ENTITY_NOT_FOUND', details: { entityId } }
            };
        }

        const reqList = Array.isArray(requirements) ? requirements : [requirements];

        // 1. Score components based on how many requirements they satisfy
        const componentScores = entity.components.map(component => {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            let score = 0;
            const satisfiedReqs = [];

            for (const req of reqList) {
                if (stats && stats[req.trait] && stats[req.trait][req.stat] >= req.minValue) {
                    score++;
                    satisfiedReqs.push(req);
                }
            }
            return { id: component.id, score, satisfiedReqs };
        });

        // 2. Sort components by score descending to prioritize the most capable ones
        componentScores.sort((a, b) => b.score - a.score);

        const requirementValues = {};
        const fulfillingComponents = {};
        let primaryComponentId = null;

        // 3. Assign the best available component for each requirement
        for (const req of reqList) {
            const bestComponent = componentScores.find(cs =>
                cs.satisfiedReqs.some(r => r === req)
            );

            if (!bestComponent) {
                return {
                    passed: false,
                    error: {
                        code: 'MISSING_TRAIT_STAT',
                        details: { trait: req.trait, stat: req.stat, minValue: req.minValue }
                    }
                };
            }

            const stats = this.worldStateController.componentController.getComponentStats(bestComponent.id);
            const key = `${req.trait}.${req.stat}`;
            requirementValues[key] = stats[req.trait][req.stat];
            fulfillingComponents[key] = bestComponent.id;

            if (!primaryComponentId) primaryComponentId = bestComponent.id;
        }

        return { passed: true, requirementValues, fulfillingComponents, componentId: primaryComponentId };
    }

    /**
     * Checks if a specific component meets ALL of the action's requirements.
     * Used during action execution when a specific component is targeted
     * (e.g., attackerComponentId or targetComponentId provided).
     *
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID (used for error logging).
     * @param {string} componentId - The specific component to evaluate.
     * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, error?: {code: string, details: Object}}}
     * @private
     */
    _checkRequirementsForComponent(requirements, entityId, componentId) {
        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (!componentStats) {
            return { passed: false, error: { code: 'ENTITY_NOT_FOUND', details: { entityId } } };
        }

        const reqList = Array.isArray(requirements) ? requirements : [requirements];

        const requirementValues = {};
        const fulfillingComponents = {};

        for (const req of reqList) {
            const key = `${req.trait}.${req.stat}`;

            if (!componentStats[req.trait] ||
                componentStats[req.trait][req.stat] === undefined ||
                componentStats[req.trait][req.stat] < req.minValue) {
                return {
                    passed: false,
                    error: {
                        code: 'MISSING_TRAIT_STAT',
                        details: { trait: req.trait, stat: req.stat, minValue: req.minValue }
                    }
                };
            }

            requirementValues[key] = componentStats[req.trait][req.stat];
            fulfillingComponents[key] = componentId;
        }

        return { passed: true, requirementValues, fulfillingComponents };
    }

    // =========================================================================
    // PRIVATE: CONSEQUENCE EXECUTION
    // =========================================================================

    /**
     * Resolves a structured error into a human-readable message and logs it.
     * @param {Object} error - The error object { code, details }.
     * @returns {string} Formatted error message.
     */
    _resolveError(error) {
        if (!error || !error.code) {
            Logger.error("An unknown error occurred.");
            return "An unknown error occurred.";
        }
        const registryEntry = ERROR_REGISTRY[error.code];
        if (!registryEntry) {
            Logger.error(`An undefined error occurred: ${error.code}`);
            return "An undefined error occurred.";
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

    /**
     * Executes the success consequences of an action using the normalized handler interface.
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity performing the action.
     * @param {Object} requirementValues - Map of trait.stat values for substitution.
     * @param {Object} params - Additional action parameters.
     * @param {Object} fulfillingComponents - Map of requirements to the components that satisfied them.
     * @param {Object} [synergyResult] - Optional synergy computation result.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, requirementValues, params, fulfillingComponents = {}, synergyResult = null) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }

        const results = [];
        const context = {
            requirementValues,
            actionParams: params,
            fulfillingComponents,
            synergyResult
        };

        for (const consequence of action.consequences) {
            const resolvedParams = this._resolvePlaceholders(consequence.params, requirementValues, params);

            const handler = this.consequenceHandlers.handlers[consequence.type];
            if (!handler) {
                results.push({ success: false, error: `Unknown consequence type: "${consequence.type}"` });
                continue;
            }

            try {
                // Apply synergy multiplier to numeric consequence values
                if (synergyResult && synergyResult.synergyMultiplier > 1.0 && typeof resolvedParams?.value === 'number') {
                    const baseValue = resolvedParams.value;
                    resolvedParams.value = this.synergyController
                        ? this.synergyController.applySynergyToResult(synergyResult, baseValue)
                        : baseValue;
                }

                // Spatial consequences (updateSpatial, deltaSpatial) always operate on the entity.
                // Component-level consequences (updateComponentStatDelta, damageComponent) resolve
                // their target from context.actionParams.targetComponentId inside the handler.
                const spatialTypes = ['updateSpatial', 'deltaSpatial'];
                const targetId = spatialTypes.includes(consequence.type)
                    ? entityId
                    : (params.targetComponentId || entityId);
                const result = handler(targetId, resolvedParams, context);

                results.push({ success: true, type: consequence.type, synergyApplied: synergyResult !== null, ...result });
            } catch (error) {
                results.push({
                    success: false,
                    error: this._resolveError({
                        code: 'CONSEQUENCE_EXECUTION_FAILED',
                        details: { type: consequence.type, error: error.message }
                    }),
                    type: consequence.type
                });
            }
        }

        return { success: true, executedConsequences: results.length, results };
    }

    /**
     * Resolves placeholders in params (e.g., ":Movement.move" -> actual value).
     * Now supports embedded placeholders within strings.
     * Includes numeric validation to prevent string concatenation bugs.
     * @private
     * @param {any} params - The value to resolve.
     * @param {Object} requirementValues - Map of "trait.stat" → numeric value.
     * @param {Object} actionParams - Parameters passed from the client.
     * @returns {any} The resolved value (number if placeholder resolved, original otherwise).
     */
    _resolvePlaceholders(params, requirementValues, actionParams) {
        if (params === null || params === undefined) return params;

        if (typeof params === 'string') {
            // If the string is EXACTLY a placeholder (with optional sign/multiplier), return as number
            const exactMatch = params.match(/^(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\*(-?\d+))?$/);
            if (exactMatch) {
                const sign = exactMatch[1] === '-' ? -1 : 1;
                const placeholder = exactMatch[2].substring(1);
                const multiplier = exactMatch[3] ? parseInt(exactMatch[3], 10) : 1;
                const value = requirementValues[placeholder];
                // Validate that the resolved value is numeric
                if (value !== undefined && typeof value === 'number') {
                    return sign * value * multiplier;
                }
                Logger.warn(`[ActionController] Placeholder "${placeholder}" resolved to non-numeric value:`, value);
                return params; // Return original string if not numeric
            }

            // Otherwise, treat as a template string and replace all embedded placeholders
            const resolved = params.replace(/(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(\*(-?\d+))?/g, (match, sign, placeholder, multiplier) => {
                const pName = placeholder.substring(1);
                const val = requirementValues[pName];
                if (val === undefined) return match;

                // Validate numeric resolution
                if (typeof val !== 'number') {
                    Logger.warn(`[ActionController] Placeholder "${pName}" resolved to non-numeric value:`, val);
                    return match; // Keep original placeholder
                }

                const s = sign === '-' ? -1 : 1;
                const m = multiplier ? parseInt(multiplier.substring(1), 10) : 1;
                return s * val * m;
            });
            return resolved;
        }

        if (typeof params === 'number') return params;
        if (Array.isArray(params)) return params.map(p => this._resolvePlaceholders(p, requirementValues, actionParams));
        if (typeof params === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(params)) {
                result[key] = this._resolvePlaceholders(value, requirementValues, actionParams);
            }
            return result;
        }
        return params;
    }

    /**
     * Executes the failure consequences of an action.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Result of failure consequence execution.
     */
    _executeFailureConsequences(actionName, entityId) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.failureConsequences) {
            return { success: false, error: `Action "${actionName}" has no failure consequences defined.` };
        }

        const results = [];
        for (const consequence of action.failureConsequences) {
            const resolvedParams = this._resolvePlaceholders(consequence.params, {}, {});
            const handler = this.consequenceHandlers.handlers[consequence.type];
            if (handler) {
                // Pass an empty context for failure consequences
                results.push({ success: true, type: consequence.type, ...handler(entityId, resolvedParams, {}) });
            }
        }

        return { success: false, executedFailureConsequences: results.length, results };
    }

    // =========================================================================
    // PUBLIC: REGISTRY ACCESS
    // =========================================================================

    /**
     * Returns all registered actions.
     * @returns {Object}
     */
    getRegistry() {
        return this.actionRegistry;
    }
}

export default ActionController;
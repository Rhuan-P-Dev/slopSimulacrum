/**
 * ActionController handles game actions, checking requirements and
 * executing consequences through a decoupled handler system.
 */
class ActionController {
    static ERROR_REGISTRY = {
        'ENTITY_NOT_FOUND': { message: 'Entity "{entityId}" not found.', level: 'ERROR' },
        'ACTION_NOT_FOUND': { message: 'Action "{actionName}" not found.', level: 'ERROR' },
        'MISSING_TRAIT_STAT': { message: 'No component possesses the required {trait}.{stat} (>= {minValue})', level: 'WARN' },
        'UNKNOWN_REQUIREMENT_FAILURE': { message: 'Action requirements were not met.', level: 'WARN' },
        'CONSEQUENCE_EXECUTION_FAILED': { message: 'Failed to execute consequence {type}: {error}', level: 'ERROR' },
        'SYSTEM_RUNTIME_ERROR': { message: 'An unexpected system error occurred: {error}', level: 'CRITICAL' },
    };

    /**
     * @param {WorldStateController} worldStateController - The main world state controller.
     * @param {ConsequenceHandlers} consequenceHandlers - The consequence handler system.
     * @param {Object} actionRegistry - The registry of available actions.
     */
    constructor(worldStateController, consequenceHandlers, actionRegistry) {
        this.worldStateController = worldStateController;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry || {};
    }
    
    /**
     * Checks if an entity meets the requirements for an action.
     * @param {string} actionName - The name of the action to check.
     * @param {string} entityId - The entity ID to check.
     * @returns {Object} { passed: boolean, traitValue: number, error: {code, details}, componentId: string }
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
     * Calculates which entities are capable of executing which actions based on the current world state.
     * Optimized to reduce redundant iterations.
     * @param {Object} state - The current world state.
     * @returns {Object} Map of actions and their capability status.
     */
    getActionCapabilities(state) {
        const actions = this.getRegistry();
        const actionStatus = {};
        const entities = state.entities || {};
        const entityIds = Object.keys(entities);

        for (const [actionName, actionData] of Object.entries(actions)) {
            const entitiesWithAbility = [];
            const cannotExecuteIds = [];
            
            for (const entityId of entityIds) {
                const requirementCheck = this.checkRequirements(actionName, entityId);
                if (requirementCheck.passed) {
                    const entity = entities[entityId];
                    const primaryComponent = entity?.components?.find(c => c.id === requirementCheck.componentId);
                    
                    entitiesWithAbility.push({
                        entityId,
                        componentName: primaryComponent ? primaryComponent.type : 'Entity',
                        componentIdentifier: primaryComponent ? primaryComponent.identifier : entityId,
                        requirementsStatus: actionData.requirements.map(req => ({
                            trait: req.trait,
                            stat: req.stat,
                            current: requirementCheck.requirementValues[`${req.trait}.${req.stat}`] ?? 0,
                            required: req.minValue
                        }))
                    });
                } else {
                    cannotExecuteIds.push({ 
                        entityId,
                        componentName: 'Entity',
                        componentIdentifier: entityId
                    });
                }
            }
            
            actionStatus[actionName] = {
                ...actionData,
                canExecute: entitiesWithAbility,
                cannotExecute: cannotExecuteIds
            };
        }
        return actionStatus;
    }

    /**
     * Retrieves only the actions that are relevant to a specific entity.
     * @param {Object} state - The current world state.
     * @param {string} entityId - The ID of the entity to filter for.
     * @returns {Object} Map of actions relevant to the entity.
     */
    getActionsForEntity(state, entityId) {
        const allActions = this.getActionCapabilities(state);
        const filteredActions = {};

        for (const [actionName, actionData] of Object.entries(allActions)) {
            const capableEntity = actionData.canExecute?.find(e => e.entityId === entityId);
            const incapableEntity = actionData.cannotExecute?.find(e => e.entityId === entityId);

            if (capableEntity) {
                filteredActions[actionName] = {
                    ...actionData,
                    canExecute: [capableEntity],
                    cannotExecute: []
                };
            } else if (incapableEntity) {
                filteredActions[actionName] = {
                    ...actionData,
                    canExecute: [],
                    cannotExecute: [incapableEntity]
                };
            }
        }

        return filteredActions;
    }

    /**
     * Executes an action on an entity.
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity to perform the action.
     * @param {Object} [params] - Additional action parameters.
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
            
            // Check requirements
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
            
            // Execute success consequences
            const consequenceResult = this._executeConsequences(
                actionName, 
                entityId, 
                requirementCheck.requirementValues,
                params,
                requirementCheck.fulfillingComponents
            );
            
            return {
                success: true,
                action: actionName,
                entityId,
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
    
    /**
     * Checks if an entity meets the requirements for an action.
     * Fixed: Requirements can now be satisfied by multiple components.
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID to check.
     * @returns {Object} { passed: boolean, requirementValues: Object, error: {code, details} }
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
     * Resolves a structured error into a human-readable message.
     * @param {Object} error - The error object { code, details }.
     * @returns {string} Formatted error message.
     */
    _resolveError(error) {
        if (!error || !error.code) return "An unknown error occurred.";
        const registryEntry = ActionController.ERROR_REGISTRY[error.code];
        if (!registryEntry) return "An undefined error occurred.";

        let message = registryEntry.message;
        if (error.details) {
            for (const [key, value] of Object.entries(error.details)) {
                message = message.replace(`{${key}}`, value);
            }
        }
        return message;
    }
    
    /**
     * Executes the success consequences of an action.
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity performing the action.
     * @param {Object} requirementValues - Map of trait.stat values for substitution.
     * @param {Object} params - Additional action parameters.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, requirementValues, params, fulfillingComponents = {}) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }
        
        const results = [];
        for (const consequence of action.consequences) {
            const resolvedParams = this._resolvePlaceholders(consequence.params, requirementValues, params);
            
            const handler = this.consequenceHandlers.handlers[consequence.type];
            if (!handler) {
                results.push({ success: false, error: `Unknown consequence type: "${consequence.type}"` });
                continue;
            }

            try {
                // Special handling for component-targeted consequences
                let targetId = params.targetComponentId;
                
                if (consequence.type === 'updateComponentStatDelta' && !targetId) {
                    // For self-updates, first check if a component fulfilled a requirement for this trait/stat
                    const trait = (resolvedParams && typeof resolvedParams === 'object') ? resolvedParams.trait : null;
                    const stat = (resolvedParams && typeof resolvedParams === 'object') ? resolvedParams.stat : null;
                    
                    if (trait && stat) {
                        const key = `${trait}.${stat}`;
                        if (fulfillingComponents[key]) {
                            targetId = fulfillingComponents[key];
                        } else {
                            // Fallback: find the first component that possesses the trait/stat being modified
                            const entity = this.worldStateController.stateEntityController.getEntity(entityId);
                            if (entity) {
                                const component = entity.components.find(comp => {
                                    const s = this.worldStateController.componentController.getComponentStats(comp.id);
                                    return s && s[trait] && s[trait][stat] !== undefined;
                                });
                                targetId = component ? component.id : entityId;
                            } else {
                                targetId = entityId;
                            }
                        }
                    } else {
                        targetId = entityId;
                    }
                }

                const result = (consequence.type === 'updateComponentStatDelta') 
                    ? handler(targetId, resolvedParams)
                    : handler(entityId, resolvedParams, requirementValues, params);
                
                results.push({ success: true, type: consequence.type, ...result });
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
     * Resolves placeholders in params (e.g., ":Movimentation.move" -> actual value).
     * @private
     */
    _resolvePlaceholders(params, requirementValues, actionParams) {
        if (params === null || params === undefined) return params;
        
        if (typeof params === 'string') {
            const match = params.match(/^(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\*(-?\d+))?$/);
            if (match) {
                const sign = match[1] === '-' ? -1 : 1;
                const placeholder = match[2].substring(1);
                const multiplier = match[3] ? parseInt(match[3], 10) : 1;
                const value = requirementValues[placeholder];
                if (value !== undefined) return sign * value * multiplier;
            }
            return params;
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
                results.push({ success: true, type: consequence.type, ...handler(entityId, resolvedParams) });
            }
        }
        
        return { success: false, executedFailureConsequences: results.length, results };
    }
    
    /**
     * Returns all registered actions.
     * @returns {Object}
     */
    getRegistry() {
        return this.actionRegistry;
    }
}

module.exports = ActionController;

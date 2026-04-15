/**
 * ActionController handles game actions, checking requirements and
 * executing consequences through the appropriate sub-controllers.
 * 
 * Follows the Dependency Injection pattern - receives WorldStateController
 * reference rather than creating its own instances.
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
     */
    constructor(worldStateController) {
        this.worldStateController = worldStateController;
        
        // Action Registry - format: "actionName": { requirements, consequences[], failureConsequences[] }
        // Consequences are defined as arrays of objects with type and params properties.
        // Use deltaSpatial for relative movements (adds to current position).
        // Use updateSpatial for absolute coordinate setting.
        this.actionRegistry = {
            "move": {
                requirements: [
                    {
                        trait: "Movimentation",
                        stat: "move",
                        minValue: 5
                    }
                ],
                consequences: [
                    {
                        type: "deltaSpatial",
                        params: { speed: ":Movimentation.move" }
                    }
                ],
                failureConsequences: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move' failed - requirement not met"
                    }
                ]
            },
            "dash": {
                requirements: [
                    {
                        trait: "Movimentation",
                        stat: "move",
                        minValue: 5
                    },
                    {
                        trait: "Physical",
                        stat: "durability",
                        minValue: 30
                    }
                ],
                consequences: [
                    {
                        type: "deltaSpatial",
                        params: { speed: ":Movimentation.move*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                failureConsequences: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'dash' failed - requirement not met"
                    }
                ]
            },
            "selfHeal": {
                requirements: [
                    {
                        trait: "Movimentation",
                        stat: "move",
                        minValue: 1
                    },
                    {
                        trait: "Physical",
                        stat: "durability",
                        minValue: 1
                    }
                ],
                consequences: [
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: 10 }
                    }
                ],
                failureConsequences: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'selfHeal' failed - requirement not met"
                    }
                ]
            },
            "droid punch": {
                range: 100,
                requirements: [
                    {
                        trait: "Physical",
                        stat: "strength",
                        minValue: 15
                    }
                ],
                consequences: [
                    {
                        type: "damageComponent",
                        params: { 
                            trait: "Physical", 
                            stat: "durability", 
                            value: "-:Physical.strength" 
                        }
                    },
                    {
                        type: "log",
                        level: "info",
                        message: "Droid performed a punch dealing :Physical.strength damage!"
                    }
                ],
                failureConsequences: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Punch failed - strength too low"
                    }
                ]
            }
        };
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
     * @param {Object} state - The current world state.
     * @returns {Object} Map of actions and their capability status.
     */
    getActionCapabilities(state) {
        const actions = this.getRegistry();
        const actionStatus = {};
        const entities = state.entities || {};

        for (const [actionName, actionData] of Object.entries(actions)) {
            const entitiesWithAbility = [];
            
            for (const [entityId, entity] of Object.entries(entities)) {
                const requirementCheck = this.checkRequirements(actionName, entityId);
                if (requirementCheck.passed) {
                    const component = entity.components.find(c => c.id === requirementCheck.componentId);
                    if (component) {
                        const stats = this.worldStateController.componentController.getComponentStats(component.id);
                        
                        const requirementsStatus = actionData.requirements.map(req => ({
                            trait: req.trait,
                            stat: req.stat,
                            current: stats[req.trait]?.[req.stat] ?? 0,
                            required: req.minValue
                        }));

                        entitiesWithAbility.push({
                            entityId,
                            componentName: component.type,
                            componentIdentifier: component.identifier,
                            requirementsStatus
                        });
                    }
                }
            }
            
            actionStatus[actionName] = {
                ...actionData,
                requirements: actionData.requirements,
                canExecute: entitiesWithAbility,
                cannotExecute: Object.keys(entities).filter(
                    eId => !entitiesWithAbility.some(ent => ent.entityId === eId)
                ).map(eId => {
                    const entity = entities[eId];
                    let componentData = null;

                    if (actionData.requirements && actionData.requirements.length > 0) {
                        const firstReq = actionData.requirements[0];
                        const matchingComponent = entity.components.find(c => {
                            const stats = this.worldStateController.componentController.getComponentStats(c.id);
                            return stats && stats[firstReq.trait];
                        });
                        
                        if (matchingComponent) {
                            const stats = this.worldStateController.componentController.getComponentStats(matchingComponent.id);
                            componentData = {
                                type: matchingComponent.type,
                                identifier: matchingComponent.identifier,
                                stats: stats
                            };
                        }
                    }

                    return { 
                        entityId: eId,
                        componentName: componentData?.type || "Unknown",
                        componentIdentifier: componentData?.identifier || "N/A",
                        stats: componentData?.stats || null
                    };
                })
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
                // Execute failure consequences
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
                requirementCheck.componentId
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
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID to check.
     * @returns {Object} { passed: boolean, requirementValues: Object, error: {code, details}, componentId: string }
     */
    _checkRequirements(requirements, entityId) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return { 
                passed: false, 
                error: { code: 'ENTITY_NOT_FOUND', details: { entityId } } 
            };
        }

        // If requirements is a single object (for backward compatibility), wrap it in an array
        const reqList = Array.isArray(requirements) ? requirements : [requirements];

        // We need to satisfy ALL requirements in the list.
        // However, requirements might be satisfied by different components.
        // For the sake of this implementation, we will find the first component that satisfies ALL requirements.
        // If requirements are split across components, this logic might need adjustment depending on game design.
        
        for (const component of entity.components) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (!stats) continue;

            let allMet = true;
            const requirementValues = {};

            for (const req of reqList) {
                if (stats[req.trait] && stats[req.trait][req.stat] >= req.minValue) {
                    requirementValues[`${req.trait}.${req.stat}`] = stats[req.trait][req.stat];
                } else {
                    allMet = false;
                    break;
                }
            }

            if (allMet) {
                return { passed: true, requirementValues, componentId: component.id };
            }
        }

        // If we reach here, one or more requirements were not met.
        // Find the first requirement that failed to provide a specific error.
        for (const req of reqList) {
            let requirementSatisfied = false;
            for (const component of entity.components) {
                const stats = this.worldStateController.componentController.getComponentStats(component.id);
                if (stats && stats[req.trait] && stats[req.trait][req.stat] >= req.minValue) {
                    requirementSatisfied = true;
                    break;
                }
            }

            if (!requirementSatisfied) {
                return { 
                    passed: false, 
                    error: { 
                        code: 'MISSING_TRAIT_STAT', 
                        details: { 
                            trait: req.trait, 
                            stat: req.stat, 
                            minValue: req.minValue 
                        } 
                    } 
                };
            }
        }

        return { 
            passed: false, 
            error: { code: 'UNKNOWN_REQUIREMENT_FAILURE' } 
        };
    }

    /**
     * Resolves a structured error into a human-readable message using the ERROR_REGISTRY.
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
     * Reads consequences from the action registry and dispatches them to appropriate handlers.
     * 
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity performing the action.
     * @param {Object} requirementValues - Map of trait.stat values used for parameter substitution.
     * @param {Object} params - Additional action parameters.
     * @param {string} [componentId] - The ID of the component that satisfied the requirements.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, requirementValues, params, componentId) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { 
                success: false, 
                error: `Action "${actionName}" has no consequences defined.` 
            };
        }
        
        const results = [];
        
        for (const consequence of action.consequences) {
            const result = this._dispatchConsequence(
                consequence.type,
                entityId,
                consequence.params,
                requirementValues,
                params,
                componentId
            );
            results.push(result);
        }
        
        // Return summary of all executed consequences
        return {
            success: true,
            executedConsequences: results.length,
            results: results
        };
    }
    
    /**
     * Dispatches a consequence to the appropriate handler based on its type.
     * 
     * @param {string} type - The consequence type (e.g., "updateSpatial", "deltaSpatial", "log", "updateStat").
     * @param {string} entityId - The ID of the entity.
     * @param {Object} params - The consequence parameters.
     * @param {Object} requirementValues - Map of trait.stat values for parameter substitution.
     * @param {Object} actionParams - Additional action parameters.
     * @param {string} [componentId] - The ID of the component that satisfied the requirements.
     * @returns {Object} Result from the handler.
     */
    _dispatchConsequence(type, entityId, params, requirementValues, actionParams, componentId) {
        // Replace placeholders in params with actual values
        const resolvedParams = this._resolvePlaceholders(params, requirementValues, actionParams);
        
        const handlers = {
            updateSpatial: () => this._handleUpdateSpatial(entityId, resolvedParams),
            deltaSpatial: () => this._handleDeltaSpatial(entityId, resolvedParams, requirementValues, actionParams),
            log: () => this._handleLog(resolvedParams),
            updateStat: () => this._handleUpdateStat(entityId, resolvedParams),
            updateComponentStatDelta: () => this._handleUpdateComponentStatDelta(componentId, resolvedParams),
            triggerEvent: () => this._handleTriggerEvent(entityId, resolvedParams),
            damageComponent: () => this._handleDamageComponent(entityId, resolvedParams, actionParams)
        };
        
        const handler = handlers[type];
        if (!handler) {
            return {
                success: false,
                error: `Unknown consequence type: "${type}"`
            };
        }
        
        try {
            const result = handler();
            return {
                success: true,
                type: type,
                ...result
            };
        } catch (error) {
            return {
                success: false,
                error: this._resolveError({ 
                    code: 'CONSEQUENCE_EXECUTION_FAILED', 
                    details: { type, error: error.message } 
                }),
                type: type
            };
        }
    }
    
    /**
     * Resolves placeholders in params (e.g., ":Movimentation.move" -> actual value).
     * 
     * @param {Object} params - The parameters containing placeholders.
     * @param {Object} requirementValues - Map of satisfied trait.stat values.
     * @param {Object} actionParams - Additional action parameters.
     * @returns {Object} Params with placeholders resolved.
     */
    _resolvePlaceholders(params, requirementValues, actionParams) {
        if (params === null || params === undefined) {
            return params;
        }
        
        if (typeof params === 'string') {
            // Replace :trait.stat placeholder with optional sign and multiplier
            // Matches: :Trait.Stat, -:Trait.Stat, :Trait.Stat*2, -:Trait.Stat*2, etc.
            const match = params.match(/^(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\*(-?\d+))?$/);
            if (match) {
                const sign = match[1] === '-' ? -1 : 1;
                const placeholder = match[2].substring(1); // Remove the leading ':'
                const multiplier = match[3] ? parseInt(match[3], 10) : 1;
                
                const value = requirementValues[placeholder];
                if (value !== undefined) {
                    return sign * value * multiplier;
                }
            }
            return params;
        }
        
        if (typeof params === 'number') {
            return params;
        }
        
        if (Array.isArray(params)) {
            return params.map(p => this._resolvePlaceholders(p, requirementValues, actionParams));
        }
        
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
     * Handler for updateSpatial consequence type.
     * Updates an entity's spatial coordinates.
     * 
     * @param {string} entityId - The ID of the entity.
     * @param {Object} spatialUpdate - Object with x and/or y values to update.
     * @returns {Object} Result of the spatial update.
     */
    _handleUpdateSpatial(entityId, spatialUpdate) {
        const success = this.worldStateController.stateEntityController.updateEntitySpatial(
            entityId,
            spatialUpdate
        );
        
        if (success) {
            const updatedEntity = this.worldStateController.stateEntityController.getEntity(entityId);
            return {
                message: "Spatial coordinates updated",
                spatialUpdate: spatialUpdate,
                newSpatial: updatedEntity ? updatedEntity.spatial : null
            };
        }
        
        return {
            message: "Failed to update spatial coordinates",
            success: false
        };
    }
    
    /**
     * Handler for log consequence type.
     * Logs a message with the specified level.
     * 
     * @param {Object} logParams - Object with message and level properties.
     * @returns {Object} Result of the log operation.
     */
    _handleLog(logParams) {
        // Safety guard against undefined or null parameters
        if (!logParams) {
            console.log(`[INFO] Log action triggered without parameters`);
            return {
                message: "Logged empty action",
                level: "info"
            };
        }

        const { message = "No message provided", level = "info" } = logParams;
        
        // Log to console with level prefix
        const prefix = `[${level.toUpperCase()}]`;
        console.log(`${prefix} ${message}`);
        
        return {
            message: `Logged: ${message}`,
            level: level
        };
    }
    
    /**
     * Handler for updateComponentStatDelta consequence type.
     * Updates a specific stat for a specific component by adding a delta.
     * 
     * @param {string} componentId - The ID of the component to update.
     * @param {Object} deltaParams - Object with trait, stat, and value (delta) properties.
     * @returns {Object} Result of the stat delta update.
     */
    _handleUpdateComponentStatDelta(componentId, deltaParams) {
        if (!componentId) {
            return {
                success: false,
                message: "No componentId provided for targeted update"
            };
        }

        const { trait, stat, value } = deltaParams;
        const success = this.worldStateController.componentController.updateComponentStatDelta(
            componentId,
            trait,
            stat,
            value
        );

        return {
            success: success,
            message: success 
                ? `Updated component ${componentId} with ${trait}.${stat} by delta ${value}`
                : `Failed to update component ${componentId}`
        };
    }

    /**
     * Handler for updateStat consequence type.
     * Updates a specific stat for an entity's component.
     * 
     * @param {string} entityId - The ID of the entity.
     * @param {Object} updateParams - Object with trait, stat, and value properties.
     * @returns {Object} Result of the stat update.
     */
    _handleUpdateStat(entityId, updateParams) {
        const { trait, stat, value } = updateParams;
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        
        if (!entity) {
            return {
                success: false,
                message: `Entity "${entityId}" not found`
            };
        }
        
        // Update stats for all components that have the specified trait
        let updatedCount = 0;
        for (const component of entity.components) {
            const componentStats = this.worldStateController.componentController.getComponentStats(component.id);
            if (componentStats && componentStats[trait]) {
                this.worldStateController.componentController.updateComponentStat(
                    component.id,
                    trait,
                    stat,
                    value
                );
                updatedCount++;
            }
        }
        
        return {
            success: true,
            message: `Updated ${updatedCount} component(s) with ${trait}.${stat} = ${value}`
        };
    }
    
    /**
     * Handler for damageComponent consequence type.
     * Deals damage to a specific component of a target entity.
     * 
     * @param {string} entityId - The ID of the attacker entity.
     * @param {Object} resolvedParams - Params containing trait, stat, and value.
     * @param {Object} actionParams - Params containing targetComponentId.
     * @returns {Object} Result from the handler.
     */
    _handleDamageComponent(entityId, resolvedParams, actionParams) {
        const { trait, stat, value } = resolvedParams;
        const targetComponentId = actionParams.targetComponentId;

        if (!targetComponentId) {
            return {
                success: false,
                message: "No target component specified for damage"
            };
        }

        const success = this.worldStateController.componentController.updateComponentStatDelta(
            targetComponentId,
            trait,
            stat,
            value
        );

        return {
            success: success,
            message: success 
                ? `Dealt ${Math.abs(value)} damage to component ${targetComponentId}`
                : `Failed to deal damage to component ${targetComponentId}`
        };
    }

    /**
     * Handler for triggerEvent consequence type.
     * Triggers a server event for client notifications.
     * 
     * @param {string} entityId - The ID of the entity.
     * @param {Object} eventParams - Object with eventType and data properties.
     * @returns {Object} Result from the handler.
     */
    _handleTriggerEvent(entityId, eventParams) {
        const { eventType, data } = eventParams;
        
        // Event trigger - can be extended to notify clients
        console.log(`[EVENT] ${eventType} for entity ${entityId}`, data || {});
        
        return {
            success: true,
            message: `Event "${eventType}" triggered`,
            eventType: eventType,
            entityId: entityId
        };
    }
    
    /**
     * Handler for deltaSpatial consequence type.
     * Updates an entity's spatial coordinates. Supports both explicit deltas 
     * and target-based movement.
     * 
     * @param {string} entityId - The ID of the entity.
     * @param {Object} deltaUpdate - Object with x and/or y values to add to current position.
     * @param {number} traitValue - The movement speed (trait value).
     * @param {Object} actionParams - Additional parameters (e.g., targetX, targetY).
     * @returns {Object} Result of the spatial update.
     */
    _handleDeltaSpatial(entityId, deltaUpdate, requirementValues, actionParams) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        
        if (!entity) {
            return {
                success: false,
                message: `Entity "${entityId}" not found`
            };
        }
        
        // Use resolved speed from deltaUpdate if available, else fallback to 0 (no default traitValue anymore)
        const speed = (typeof deltaUpdate.speed === 'number') ? deltaUpdate.speed : 0;
        
        let moveX = deltaUpdate.x || 0;
        let moveY = deltaUpdate.y || 0;

        // Target-based movement: calculate direction and scale by the resolved speed
        if (actionParams && actionParams.targetX !== undefined && actionParams.targetY !== undefined) {
            const dx = actionParams.targetX - entity.spatial.x;
            const dy = actionParams.targetY - entity.spatial.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance > 0) {
                moveX = (dx / distance) * speed;
                moveY = (dy / distance) * speed;
            } else {
                moveX = 0;
                moveY = 0;
            }
        }
        
        // Calculate new coordinates
        const newX = entity.spatial.x + moveX;
        const newY = entity.spatial.y + moveY;
        
        // Update the entity's spatial coordinates
        const success = this.worldStateController.stateEntityController.updateEntitySpatial(
            entityId,
            { x: newX, y: newY }
        );
        
        if (success) {
            const updatedEntity = this.worldStateController.stateEntityController.getEntity(entityId);
            return {
                message: "Entity moved",
                deltaUpdate: { x: moveX, y: moveY },
                newSpatial: updatedEntity ? updatedEntity.spatial : null
            };
        }
        
        return {
            success: false,
            message: "Failed to update spatial coordinates"
        };
    }
    
    /**
     * Executes the failure consequences of an action.
     * Reads failure consequences from the action registry and dispatches them to appropriate handlers.
     * 
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Result of failure consequence execution.
     */
    _executeFailureConsequences(actionName, entityId) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.failureConsequences) {
            return { 
                success: false, 
                error: `Action "${actionName}" has no failure consequences defined.` 
            };
        }
        
        const results = [];
        
        for (const consequence of action.failureConsequences) {
            const result = this._dispatchConsequence(
                consequence.type,
                entityId,
                consequence.params,
                0,  // No trait value for failure consequences
                {}
            );
            results.push(result);
        }
        
        // Return summary of all executed failure consequences
        return {
            success: false,
            executedFailureConsequences: results.length,
            results: results
        };
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

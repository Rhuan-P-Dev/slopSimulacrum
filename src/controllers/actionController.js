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

    constructor(worldStateController) {
        this.worldStateController = worldStateController;
        
        // Action Registry - format: "actionName": { requirements, consequences[], consequencesDeFalha[] }
        // Consequences are defined as arrays of objects with type and params properties.
        // Use deltaSpatial for relative movements (adds to current position).
        // Use updateSpatial for absolute coordinate setting.
        this.actionRegistry = {
            "move - up": {
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
                        params: { y: "-:traitValue" }  // Move upward by move value pixels
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - up' failed - requirement not met"
                    }
                ]
            },
            "move - down": {
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
                        params: { y: ":traitValue" }  // Move downward by move value pixels
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - down' failed - requirement not met"
                    }
                ]
            },
            "move - left": {
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
                        params: { x: "-:traitValue" }  // Move left by move value pixels
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - left' failed - requirement not met"
                    }
                ]
            },
            "move - right": {
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
                        params: { x: ":traitValue" }  // Move right by move value pixels
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - right' failed - requirement not met"
                    }
                ]
            },
            "move - up-left": {
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
                        params: { x: "-:traitValue", y: "-:traitValue" }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - up-left' failed - requirement not met"
                    }
                ]
            },
            "move - up-right": {
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
                        params: { x: ":traitValue", y: "-:traitValue" }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - up-right' failed - requirement not met"
                    }
                ]
            },
            "move - down-left": {
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
                        params: { x: "-:traitValue", y: ":traitValue" }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - down-left' failed - requirement not met"
                    }
                ]
            },
            "move - down-right": {
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
                        params: { x: ":traitValue", y: ":traitValue" }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'move - down-right' failed - requirement not met"
                    }
                ]
            },
            "droid dash - up": {
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
                        params: { y: "-:traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - up' failed - requirement not met"
                    }
                ]
            },
            "droid dash - down": {
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
                        params: { y: ":traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - down' failed - requirement not met"
                    }
                ]
            },
            "droid dash - left": {
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
                        params: { x: "-:traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - left' failed - requirement not met"
                    }
                ]
            },
            "droid dash - right": {
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
                        params: { x: ":traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - right' failed - requirement not met"
                    }
                ]
            },
            "droid dash - up-left": {
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
                        params: { x: "-:traitValue*2", y: "-:traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - up-left' failed - requirement not met"
                    }
                ]
            },
            "droid dash - up-right": {
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
                        params: { x: ":traitValue*2", y: "-:traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - up-right' failed - requirement not met"
                    }
                ]
            },
            "droid dash - down-left": {
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
                        params: { x: "-:traitValue*2", y: ":traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - down-left' failed - requirement not met"
                    }
                ]
            },
            "droid dash - down-right": {
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
                        params: { x: ":traitValue*2", y: ":traitValue*2" }
                    },
                    {
                        type: "updateComponentStatDelta",
                        params: { trait: "Physical", stat: "durability", value: -5 }
                    }
                ],
                consequencesDeFalha: [
                    {
                        type: "log",
                        level: "warn",
                        message: "Action 'droid dash - down-right' failed - requirement not met"
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
                const failureResults = this._executeConsequencesDeFalha(actionName, entityId);
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
                requirementCheck.traitValue,
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
     * @returns {Object} { passed: boolean, traitValue: number, error: {code, details}, componentId: string }
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
            let firstTraitValue = 0;

            for (const req of reqList) {
                if (stats[req.trait] && stats[req.trait][req.stat] >= req.minValue) {
                    firstTraitValue = stats[req.trait][req.stat];
                } else {
                    allMet = false;
                    break;
                }
            }

            if (allMet) {
                return { passed: true, traitValue: firstTraitValue, componentId: component.id };
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
     * @param {number} traitValue - The trait value used for parameter substitution.
     * @param {Object} params - Additional action parameters.
     * @param {string} [componentId] - The ID of the component that satisfied the requirements.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, traitValue, params, componentId) {
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
                traitValue,
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
     * @param {number} traitValue - The trait value for parameter substitution.
     * @param {Object} actionParams - Additional action parameters.
     * @param {string} [componentId] - The ID of the component that satisfied the requirements.
     * @returns {Object} Result from the handler.
     */
    _dispatchConsequence(type, entityId, params, traitValue, actionParams, componentId) {
        // Replace placeholders in params with actual values
        const resolvedParams = this._resolvePlaceholders(params, traitValue, actionParams);
        
        const handlers = {
            updateSpatial: () => this._handleUpdateSpatial(entityId, resolvedParams),
            deltaSpatial: () => this._handleDeltaSpatial(entityId, resolvedParams),
            log: () => this._handleLog(resolvedParams),
            updateStat: () => this._handleUpdateStat(entityId, resolvedParams),
            updateComponentStatDelta: () => this._handleUpdateComponentStatDelta(componentId, resolvedParams),
            triggerEvent: () => this._handleTriggerEvent(entityId, resolvedParams)
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
     * Resolves placeholders in params (e.g., ":traitValue" -> actual value).
     * 
     * @param {Object} params - The parameters containing placeholders.
     * @param {number} traitValue - The trait value to substitute.
     * @param {Object} actionParams - Additional action parameters.
     * @returns {Object} Params with placeholders resolved.
     */
    _resolvePlaceholders(params, traitValue, actionParams) {
        if (params === null || params === undefined) {
            return params;
        }
        
        if (typeof params === 'string') {
            // Replace :traitValue placeholder with optional sign and multiplier
            // Matches: :traitValue, -:traitValue, :traitValue*2, -:traitValue*2, etc.
            const match = params.match(/^(-)?(:traitValue)(?:\*(-?\d+))?$/);
            if (match) {
                const sign = match[1] === '-' ? -1 : 1;
                const multiplier = match[3] ? parseInt(match[3], 10) : 1;
                return sign * traitValue * multiplier;
            }
            return params;
        }
        
        if (typeof params === 'number') {
            return params;
        }
        
        if (Array.isArray(params)) {
            return params.map(p => this._resolvePlaceholders(p, traitValue, actionParams));
        }
        
        if (typeof params === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(params)) {
                result[key] = this._resolvePlaceholders(value, traitValue, actionParams);
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
     * Handler for triggerEvent consequence type.
     * Triggers a server event (can be extended for client notifications).
     * 
     * @param {string} entityId - The ID of the entity.
     * @param {Object} eventParams - Object with eventType and data properties.
     * @returns {Object} Result of the event trigger.
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
     * Updates an entity's spatial coordinates by adding delta values to current position.
     * This enables relative movement (e.g., move up by 20 pixels from current position).
     * 
     * @param {string} entityId - The ID of the entity.
     * @param {Object} deltaUpdate - Object with x and/or y values to add to current position.
     * @returns {Object} Result of the spatial update.
     */
    _handleDeltaSpatial(entityId, deltaUpdate) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        
        if (!entity) {
            return {
                success: false,
                message: `Entity "${entityId}" not found`
            };
        }
        
        // Calculate new coordinates by adding deltas to current position
        const newX = entity.spatial.x + (deltaUpdate.x || 0);
        const newY = entity.spatial.y + (deltaUpdate.y || 0);
        
        // Update the entity's spatial coordinates
        const success = this.worldStateController.stateEntityController.updateEntitySpatial(
            entityId,
            { x: newX, y: newY }
        );
        
        if (success) {
            const updatedEntity = this.worldStateController.stateEntityController.getEntity(entityId);
            return {
                message: "Entity moved relative",
                deltaUpdate: deltaUpdate,
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
    _executeConsequencesDeFalha(actionName, entityId) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.consequencesDeFalha) {
            return { 
                success: false,
                error: `Action "${actionName}" has no failure consequences defined.` 
            };
        }
        
        const results = [];
        
        for (const consequence of action.consequencesDeFalha) {
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

/**
 * ActionController handles game actions, checking requirements and
 * executing consequences through the appropriate sub-controllers.
 * 
 * Follows the Dependency Injection pattern - receives WorldStateController
 * reference rather than creating its own instances.
 */
class ActionController {
    constructor(worldStateController) {
        this.worldStateController = worldStateController;
        
        // Action Registry - format: "actionName": { requirements, consequences[], consequencesDeFalha[] }
        // Consequences are defined as arrays of objects with type and params properties.
        // Use deltaSpatial for relative movements (adds to current position).
        // Use updateSpatial for absolute coordinate setting.
        this.actionRegistry = {
            "move - up": {
                requirements: {
                    trait: "Movimentation",
                    stat: "move",
                    minValue: 5
                },
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
            }
        };
    }
    
    /**
     * Executes an action on an entity.
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity to perform the action.
     * @param {Object} [params] - Additional action parameters.
     * @returns {Object} Result of the action execution.
     */
    executeAction(actionName, entityId, params = {}) {
        const action = this.actionRegistry[actionName];
        
        if (!action) {
            return { success: false, error: `Action "${actionName}" not found.` };
        }
        
        // Check requirements
        const requirementCheck = this._checkRequirements(action.requirements, entityId);
        if (!requirementCheck.passed) {
            // Execute failure consequences
            return {
                success: false,
                error: `Requirement failed: ${requirementCheck.reason}`,
                ...this._executeConsequencesDeFalha(actionName, entityId)
            };
        }
        
        // Execute success consequences
        const consequenceResult = this._executeConsequences(
            actionName, 
            entityId, 
            requirementCheck.traitValue,
            params
        );
        
        return {
            success: true,
            action: actionName,
            entityId,
            ...consequenceResult
        };
    }
    
    /**
     * Checks if an entity meets the requirements for an action.
     * @param {Object} requirements - The action requirements.
     * @param {string} entityId - The entity ID to check.
     * @returns {Object} { passed: boolean, reason: string, traitValue: number }
     */
    _checkRequirements(requirements, entityId) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return { passed: false, reason: `Entity "${entityId}" not found.` };
        }
        
        // Check each component for the required trait
        for (const component of entity.components) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (stats && stats[requirements.trait]) {
                const traitValue = stats[requirements.trait][requirements.stat];
                if (traitValue > requirements.minValue) {
                    return { passed: true, reason: null, traitValue };
                }
            }
        }
        
        return { 
            passed: false, 
            reason: `No component has "${requirements.trait}.${requirements.stat}" > ${requirements.minValue}` 
        };
    }
    
    /**
     * Executes the success consequences of an action.
     * Reads consequences from the action registry and dispatches them to appropriate handlers.
     * 
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity performing the action.
     * @param {number} traitValue - The trait value used for parameter substitution.
     * @param {Object} params - Additional action parameters.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, traitValue, params) {
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
                params
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
     * @returns {Object} Result from the handler.
     */
    _dispatchConsequence(type, entityId, params, traitValue, actionParams) {
        // Replace placeholders in params with actual values
        const resolvedParams = this._resolvePlaceholders(params, traitValue, actionParams);
        
        const handlers = {
            updateSpatial: () => this._handleUpdateSpatial(entityId, resolvedParams),
            deltaSpatial: () => this._handleDeltaSpatial(entityId, resolvedParams),
            log: () => this._handleLog(resolvedParams),
            updateStat: () => this._handleUpdateStat(entityId, resolvedParams),
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
                error: error.message,
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
            // Replace :traitValue placeholder
            if (params === ':traitValue') {
                return traitValue;
            }
            // Replace :traitValue (e.g., "-:traitValue" or "+:traitValue")
            const match = params.match(/^(.*):traitValue(.*)$/);
            if (match) {
                const prefix = match[1] || '';
                const suffix = match[2] || '';
                const value = parseInt(traitValue, 10) || 0;
                return prefix + value + suffix;
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
        const { message, level = "info" } = logParams;
        
        // Log to console with level prefix
        const prefix = `[${level.toUpperCase()}]`;
        console.log(`${prefix} ${message}`);
        
        return {
            message: `Logged: ${message}`,
            level: level
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

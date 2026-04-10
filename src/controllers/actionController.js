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
        
        // Action Registry - format: "actionName": { requirements, consequences, consequencesDeFalha }
        this.actionRegistry = {
            "move": {
                requirements: {
                    trait: "Movimentation",
                    stat: "move",
                    minValue: 5
                },
                consequences: {
                    // Move upward: decrease y coordinate
                    // Entity spatial: y - moveValue
                },
                consequencesDeFalha: {
                    // TODO: Handle move failure consequences
                    // Possible failure outcomes:
                    // - Log failure to console
                    // - Apply cooldown or penalty
                    // - Trigger failure animation/sound
                    // - Notify client of failure
                }
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
     * Executes the success consequences of a move action.
     * Calls stateEntityController to update entity spatial position.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {number} moveValue - The move stat value used for calculation.
     * @param {Object} params - Action parameters.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, moveValue, params) {
        // Move upward = decrease y coordinate
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (entity) {
            const moveY = moveValue; // Move upward by moveValue pixels
            
            // Use the new updateEntitySpatial method
            const success = this.worldStateController.stateEntityController.updateEntitySpatial(
                entityId,
                { y: entity.spatial.y - moveY }
            );
            
            if (success) {
                return {
                    message: "Entity moved upward",
                    moveValue: moveY,
                    newSpatial: this.worldStateController.stateEntityController.getEntity(entityId).spatial
                };
            }
        }
        
        return { message: "Failed to execute move action" };
    }
    
    /**
     * Executes the failure consequences of an action.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Result of failure consequence execution.
     */
    _executeConsequencesDeFalha(actionName, entityId) {
        // TODO: Implement failure consequences
        // Possible implementations:
        // - Log the failure
        // - Apply penalties (energy cost, cooldown, etc.)
        // - Trigger failure animations
        // - Notify client of failure reason
        
        return {
            message: "Action failed - failure consequences not yet implemented",
            failedAction: actionName,
            entityId: entityId
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

/**
 * ConsequenceHandlers provides a set of strategy functions to execute
 * game consequences. This decouples the execution logic from the ActionController.
 */
class ConsequenceHandlers {
    /**
     * @param {Object} controllers - The set of available controllers (WorldStateController, etc.)
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
    }

    /**
     * Map of handler functions.
     */
    get handlers() {
        return {
            updateSpatial: (entityId, params) => this._handleUpdateSpatial(entityId, params),
            deltaSpatial: (entityId, params, requirementValues, actionParams) => this._handleDeltaSpatial(entityId, params, requirementValues, actionParams),
            log: (entityId, params) => this._handleLog(params),
            updateStat: (entityId, params) => this._handleUpdateStat(entityId, params),
            updateComponentStatDelta: (componentId, params) => this._handleUpdateComponentStatDelta(componentId, params),
            triggerEvent: (entityId, params) => this._handleTriggerEvent(entityId, params),
            damageComponent: (entityId, params, reqValues, actionParams) => this._handleDamageComponent(entityId, params, actionParams),
        };
    }

    /**
     * @param {string} entityId
     * @param {Object} spatialUpdate
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateSpatial(entityId, spatialUpdate) {
        const success = this.worldStateController.stateEntityController.updateEntitySpatial(entityId, spatialUpdate);
        if (success) {
            const updatedEntity = this.worldStateController.stateEntityController.getEntity(entityId);
            return { 
                success: true, 
                message: "Spatial coordinates updated", 
                data: { spatialUpdate, newSpatial: updatedEntity?.spatial } 
            };
        }
        return { success: false, message: "Failed to update spatial coordinates", data: null };
    }

    /**
     * @param {string} entityId
     * @param {Object} deltaUpdate
     * @param {Object} requirementValues
     * @param {Object} actionParams
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDeltaSpatial(entityId, deltaUpdate, requirementValues, actionParams) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return { success: false, message: `Entity "${entityId}" not found`, data: null };
        if (!entity.spatial) return { success: false, message: `Entity "${entityId}" has no spatial data`, data: null };

        const speed = (typeof deltaUpdate.speed === 'number') ? deltaUpdate.speed : 0;
        let moveX = deltaUpdate.x || 0;
        let moveY = deltaUpdate.y || 0;

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

        const success = this.worldStateController.stateEntityController.updateEntitySpatial(
            entityId,
            { x: entity.spatial.x + moveX, y: entity.spatial.y + moveY }
        );

        return success 
            ? { 
                success: true, 
                message: "Entity moved", 
                data: { deltaUpdate: { x: moveX, y: moveY }, newSpatial: this.worldStateController.stateEntityController.getEntity(entityId)?.spatial } 
              } 
            : { success: false, message: "Failed to update spatial coordinates", data: null };
    }

    /**
     * @param {Object} params
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleLog(params) {
        if (!params) return { success: true, message: "Logged empty action", data: { level: "info" } };
        const { message = "No message provided", level = "info" } = params;
        console.log(`[${level.toUpperCase()}] ${message}`);
        return { success: true, message: `Logged: ${message}`, data: { level } };
    }

    /**
     * @param {string} componentId
     * @param {Object} deltaParams
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateComponentStatDelta(componentId, deltaParams) {
        if (!componentId) return { success: false, message: "No componentId provided", data: null };
        const { trait, stat, value } = deltaParams;
        const success = this.worldStateController.componentController.updateComponentStatDelta(componentId, trait, stat, value);
        return { 
            success, 
            message: success ? `Updated ${componentId} ${trait}.${stat} by ${value}` : `Failed to update ${componentId}`, 
            data: success ? { componentId, trait, stat, value } : null 
        };
    }

    /**
     * @param {string} entityId
     * @param {Object} updateParams
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateStat(entityId, updateParams) {
        const { trait, stat, value } = updateParams;
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return { success: false, message: `Entity "${entityId}" not found`, data: null };

        let updatedCount = 0;
        for (const component of entity.components) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (stats && stats[trait]) {
                this.worldStateController.componentController.updateComponentStat(component.id, trait, stat, value);
                updatedCount++;
            }
        }
        return { success: true, message: `Updated ${updatedCount} component(s) with ${trait}.${stat} = ${value}`, data: { updatedCount } };
    }

    /**
     * @param {string} entityId
     * @param {Object} resolvedParams
     * @param {Object} actionParams
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDamageComponent(entityId, resolvedParams, actionParams) {
        const { trait, stat, value } = resolvedParams;
        const targetComponentId = actionParams.targetComponentId;
        if (!targetComponentId) return { success: false, message: "No target component specified", data: null };
        const success = this.worldStateController.componentController.updateComponentStatDelta(targetComponentId, trait, stat, value);
        return { 
            success, 
            message: success ? `Dealt ${Math.abs(value)} damage to ${targetComponentId}` : `Failed to damage ${targetComponentId}`, 
            data: success ? { targetComponentId, trait, stat, value } : null 
        };
    }

    /**
     * @param {string} entityId
     * @param {Object} eventParams
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleTriggerEvent(entityId, eventParams) {
        const { eventType, data } = eventParams;
        console.log(`[EVENT] ${eventType} for entity ${entityId}`, data || {});
        return { success: true, message: `Event "${eventType}" triggered`, data: { eventType, entityId } };
    }
}

module.exports = ConsequenceHandlers;

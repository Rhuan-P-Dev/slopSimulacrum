import Logger from '../utils/Logger.js';

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
     * All handlers now follow a normalized signature: (targetId, params, context)
     * @returns {Object} Map of handler functions.
     */
    get handlers() {
        return {
            updateSpatial: (targetId, params, context) => this._handleUpdateSpatial(targetId, params),
            deltaSpatial: (targetId, params, context) => this._handleDeltaSpatial(targetId, params, context),
            log: (targetId, params, context) => this._handleLog(params),
            updateStat: (targetId, params, context) => this._handleUpdateStat(targetId, params),
            updateComponentStatDelta: (targetId, params, context) => this._handleUpdateComponentStatDelta(targetId, params, context),
            triggerEvent: (targetId, params, context) => this._handleTriggerEvent(targetId, params),
            damageComponent: (targetId, params, context) => this._handleDamageComponent(targetId, params, context),
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
     * @param {Object} context - Context containing actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDeltaSpatial(entityId, deltaUpdate, context) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return { success: false, message: `Entity "${entityId}" not found`, data: null };
        if (!entity.spatial) return { success: false, message: `Entity "${entityId}" has no spatial data`, data: null };

        const speed = (typeof deltaUpdate.speed === 'number') ? deltaUpdate.speed : 0;
        let moveX = deltaUpdate.x || 0;
        let moveY = deltaUpdate.y || 0;

        const actionParams = context?.actionParams;
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
        
        const logMethod = Logger[level.toLowerCase()] || Logger.info;
        logMethod(message);
        
        return { success: true, message: `Logged: ${message}`, data: { level } };
    }

    /**
     * @param {string} targetId - Entity ID or Component ID.
     * @param {Object} deltaParams - Parameters containing trait, stat, and value.
     * @param {Object} context - Context containing fulfillingComponents and actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateComponentStatDelta(targetId, deltaParams, context) {
        let componentId = targetId;
        const { trait, stat, value } = deltaParams;

        // 1. Priority: Explicit targetComponentId from actionParams
        if (context && context.actionParams && context.actionParams.targetComponentId) {
            componentId = context.actionParams.targetComponentId;
        } 
        // 2. Priority: Component that fulfilled the requirement for this trait/stat
        else if (context && context.fulfillingComponents) {
            const key = `${trait}.${stat}`;
            if (context.fulfillingComponents[key]) {
                componentId = context.fulfillingComponents[key];
            } 
            // 3. Priority: Fallback to first component on entity possessing the trait/stat
            else {
                const entity = this.worldStateController.stateEntityController.getEntity(targetId);
                if (entity) {
                    const component = entity.components.find(comp => {
                        const s = this.worldStateController.componentController.getComponentStats(comp.id);
                        return s && s[trait] && s[trait][stat] !== undefined;
                    });
                    if (component) componentId = component.id;
                }
            }
        }

        if (!componentId || componentId === targetId && !this.worldStateController.componentController.getComponentStats(componentId)) {
            // If we still have an entityId instead of a componentId
            return { success: false, message: "No valid component identified for stat update", data: null };
        }

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
     * @param {Object} context - Context containing actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDamageComponent(entityId, resolvedParams, context) {
        const { trait, stat, value } = resolvedParams;
        const targetComponentId = context?.actionParams?.targetComponentId;
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
        Logger.info(`Event triggered: ${eventType} for entity ${entityId}`, data || {});
        return { success: true, message: `Event "${eventType}" triggered`, data: { eventType, entityId } };
    }
}

export default ConsequenceHandlers;

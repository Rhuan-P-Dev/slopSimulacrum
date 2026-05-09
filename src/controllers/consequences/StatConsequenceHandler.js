/**
 * StatConsequenceHandler — Handles stat value updates on components and entities.
 * Single Responsibility: Manage stat modifications (absolute and delta-based) for components and entities.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - 'self'    → Updates the source component that fulfilled the action's requirements.
 * - 'target'  → Updates the explicitly targeted component (from actionParams).
 * - 'entity'  → Updates ALL components of the target entity that have the trait.
 *
 * @module StatConsequenceHandler
 */

import Logger from '../../utils/Logger.js';

class StatConsequenceHandler {
    /**
     * @param {Object} controllers - The set of available controllers.
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
    }

    /**
     * Updates a stat delta on the appropriate component.
     * Resolution priority based on consequence target type:
     *   1. 'self'    → Component that fulfilled the specific trait.stat requirement
     *   2. 'target'  → Explicit targetComponentId from actionParams
     *   3. 'entity'  → All components on the entity with the trait
     *
     * @param {string} targetId - Resolved target ID (component or entity ID based on target type).
     * @param {Object} deltaParams - Parameters containing trait, stat, and value.
     * @param {Object} context - Context containing fulfillingComponents and actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateComponentStatDelta(targetId, deltaParams, context) {
        const { trait, stat, value } = deltaParams;
        const targetType = context?.actionParams?.consequenceTarget || 'target';

        // 'entity' target: update ALL components of the entity with this trait
        if (targetType === 'entity') {
            return this._updateEntityComponentsStat(targetId, trait, stat, value);
        }

        // 'self' or 'target': update a specific component
        if (!targetId) {
            return {
                success: false,
                message: `No component resolved for ${trait}.${stat} update`,
                data: null
            };
        }

        // Validate that the resolved targetId is actually a component (has stats)
        if (!this.worldStateController.componentController.getComponentStats(targetId)) {
            Logger.warn(`[StatConsequenceHandler] Resolved targetId "${targetId}" has no stats. Falling back to entity-wide update.`);
            return this._handleUpdateStat(targetId, deltaParams, context);
        }

        const success = this.worldStateController.componentController.updateComponentStatDelta(targetId, trait, stat, value);
        return {
            success,
            message: success ? `Updated ${targetId} ${trait}.${stat} by ${value}` : `Failed to update ${targetId}`,
            data: success ? { targetId, trait, stat, value } : null
        };
    }

    /**
     * Handles bulk stat updates across all components on an entity.
     * Updates the specified trait.stat on every component that possesses that trait.
     *
     * @param {string} entityId - The entity ID whose components will be updated.
     * @param {Object} updateParams - Object containing trait, stat, and value.
     * @param {Object} context - Context containing action parameters (unused, kept for signature normalization).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateStat(entityId, updateParams, context) {
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
     * Updates a stat delta on ALL components of an entity that have the trait.
     * Used for 'entity' target type.
     * @private
     */
    _updateEntityComponentsStat(entityId, trait, stat, value) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return { success: false, message: `Entity "${entityId}" not found`, data: null };

        let updatedCount = 0;
        for (const component of entity.components) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (stats && stats[trait] && stats[trait][stat] !== undefined) {
                this.worldStateController.componentController.updateComponentStatDelta(component.id, trait, stat, value);
                updatedCount++;
            }
        }
        return { success: true, message: `Updated ${updatedCount} component(s) with ${trait}.${stat} delta ${value}`, data: { entityId, trait, stat, value, updatedCount } };
    }
}

export default StatConsequenceHandler;
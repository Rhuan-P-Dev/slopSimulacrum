/**
 * StatConsequenceHandler — Handles stat value updates on components and entities.
 * Single Responsibility: Manage stat modifications (absolute and delta-based) for components and entities.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * @module StatConsequenceHandler
 */

import Logger from '../utils/Logger.js';

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
     * Resolution priority:
     *   1. Explicit targetComponentId from actionParams (for targeted actions like damage)
     *   2. Component that fulfilled the specific trait.stat requirement (for self-targeted actions)
     *   3. Falls back to entity-wide stat update via _handleUpdateStat
     *      (when no component context is available)
     *
     * @param {string} targetId - Entity ID or Component ID.
     * @param {Object} deltaParams - Parameters containing trait, stat, and value.
     * @param {Object} context - Context containing fulfillingComponents and actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateComponentStatDelta(targetId, deltaParams, context) {
        let componentId = null;
        const { trait, stat, value } = deltaParams;

        // Priority 1: Explicit targetComponentId from actionParams (e.g., damageComponent targeting an enemy)
        if (context?.actionParams?.targetComponentId) {
            componentId = context.actionParams.targetComponentId;
        }
        // Priority 2: Component that fulfilled the specific trait.stat requirement
        else if (context?.fulfillingComponents) {
            const key = `${trait}.${stat}`;
            componentId = context.fulfillingComponents[key] || null;
        }

        // If no component was resolved, the action definition should use updateStat (entity-wide) instead.
        // This prevents accidentally updating the wrong component on multi-component entities.
        if (!componentId) {
            return {
                success: false,
                message: `No component resolved for ${trait}.${stat} update. Use updateStat for entity-wide updates or provide targetComponentId for component-specific updates.`,
                data: null
            };
        }

        // Validate that the resolved componentId is actually a component (has stats)
        if (!this.worldStateController.componentController.getComponentStats(componentId)) {
            Logger.warn(`[ConsequenceHandlers] Resolved componentId "${componentId}" has no stats. Falling back to entity-wide update.`);
            return this._handleUpdateStat(targetId, deltaParams, context);
        }

        const success = this.worldStateController.componentController.updateComponentStatDelta(componentId, trait, stat, value);
        return {
            success,
            message: success ? `Updated ${componentId} ${trait}.${stat} by ${value}` : `Failed to update ${componentId}`,
            data: success ? { componentId, trait, stat, value } : null
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
}

export default StatConsequenceHandler;
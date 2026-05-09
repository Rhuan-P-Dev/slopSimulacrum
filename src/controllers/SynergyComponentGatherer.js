/**
 * SynergyComponentGatherer — Gathers contributing components from world state.
 * Single Responsibility: Query entities and filter components for synergy groups.
 *
 * Extracted from SynergyController to adhere to the Single Responsibility Principle.
 *
 * @module SynergyComponentGatherer
 */

import Logger from '../utils/Logger.js';

class SynergyComponentGatherer {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     * @param {ActionSelectController|null} actionSelectController - Component selection controller.
     */
    constructor(worldStateController, actionSelectController) {
        this.worldStateController = worldStateController;
        this.actionSelectController = actionSelectController;
    }

    /**
     * Gather members for a "sameComponentType" group.
     * Auto-detects the component type from the source component and includes
     * all components of that same type on the entity.
     *
     * @param {Object} entity - The entity object.
     * @param {Object} groupDef - The group definition from synergy config.
     * @param {string} roleFilter - The role filter (source, spatial, self_target).
     * @param {Set<string>} lockedComponentIds - Set of locked component IDs to exclude.
     * @param {string} [sourceComponentId] - The explicitly selected source component ID.
     * @param {Set<string>} [allowedComponentIds] - Set of allowed component IDs to include (client-selected components).
     * @returns {Array} Array of member objects.
     */
    gatherSameComponentType(entity, groupDef, roleFilter, lockedComponentIds, sourceComponentId, allowedComponentIds) {
        // When sourceComponentId is provided, auto-detect the type from the source
        // and include components of that same type (for multi-component synergy).
        if (sourceComponentId) {
            const sourceComponent = entity.components.find(c => c.id === sourceComponentId);
            if (!sourceComponent) return [];

            const sourceStats = this.worldStateController.componentController.getComponentStats(sourceComponentId);
            if (!sourceStats) return [];

            // Auto-detect the component type from the source component
            const detectedType = sourceComponent.type;

            // Check role filter on the source component
            if (roleFilter && !this._passesRoleFilter(sourceStats, roleFilter)) return [];

            // Check if source is locked (shouldn't happen, but be safe)
            if (lockedComponentIds.has(sourceComponentId)) return [];

            // Include the source component itself
            const members = [{
                componentId: sourceComponentId,
                entityId: entity.id,
                componentType: detectedType,
                stats: sourceStats
            }];

            // Include SAME-TYPE siblings only if they are in the allowed set
            // This ensures synergy only counts client-selected components
            for (const comp of entity.components) {
                if (comp.id === sourceComponentId) continue;
                if (lockedComponentIds.has(comp.id)) continue;
                if (comp.type !== detectedType) continue;
                if (allowedComponentIds && !allowedComponentIds.has(comp.id)) continue;
                const compStats = this.worldStateController.componentController.getComponentStats(comp.id);
                if (compStats && this._passesRoleFilter(compStats, roleFilter)) {
                    members.push({
                        componentId: comp.id,
                        entityId: entity.id,
                        componentType: comp.type,
                        stats: compStats
                    });
                }
            }

            return members;
        }

        // No sourceComponentId: gather all components (fallback for non-spatial actions).
        // Without a source component, we cannot auto-detect the type, so include all components.
        const members = entity.components
            .filter(c => {
                if (lockedComponentIds.has(c.id)) return false;
                if (roleFilter) {
                    const stats = this.worldStateController.componentController.getComponentStats(c.id);
                    if (!stats) return false;
                    if (!this._passesRoleFilter(stats, roleFilter)) return false;
                }
                return true;
            })
            .map(c => ({
                componentId: c.id,
                entityId: entity.id,
                componentType: c.type,
                stats: this.worldStateController.componentController.getComponentStats(c.id)
            }));
        return members;
    }

    /**
     * Gather all components for an "anyComponent" group.
     *
     * @param {Object} entity - The entity object.
     * @param {Object} groupDef - The group definition from synergy config.
     * @param {string} roleFilter - The role filter (source, spatial, self_target).
     * @param {Set<string>} lockedComponentIds - Set of locked component IDs to exclude.
     * @param {string} [sourceComponentId] - The explicitly selected source component ID.
     * @returns {Array} Array of member objects.
     */
    gatherAllComponents(entity, groupDef, roleFilter, lockedComponentIds, sourceComponentId) {
        // When sourceComponentId is provided, only include that specific component
        // (if it passes the role filter).
        if (sourceComponentId) {
            const sourceComponent = entity.components.find(c => c.id === sourceComponentId);
            if (!sourceComponent) return [];

            const sourceStats = this.worldStateController.componentController.getComponentStats(sourceComponentId);
            if (!sourceStats) return [];
            if (lockedComponentIds.has(sourceComponentId)) return [];

            if (roleFilter) {
                if (roleFilter === 'source' || roleFilter === 'spatial') {
                    if (!sourceStats.Movement || Object.keys(sourceStats.Movement).length === 0) return [];
                } else if (roleFilter === 'self_target') {
                    if (!sourceStats.Physical || Object.keys(sourceStats.Physical).length === 0) return [];
                }
            }

            return [{
                componentId: sourceComponentId,
                entityId: entity.id,
                componentType: sourceComponent.type,
                stats: sourceStats
            }];
        }

        // No sourceComponentId: gather all components (original behavior)
        if (!roleFilter) {
            return entity.components
                .filter(c => !lockedComponentIds.has(c.id))
                .map(c => ({
                    componentId: c.id,
                    entityId: entity.id,
                    componentType: c.type,
                    stats: this.worldStateController.componentController.getComponentStats(c.id)
                }));
        }
        return entity.components
            .filter(c => {
                if (lockedComponentIds.has(c.id)) return false;
                const stats = this.worldStateController.componentController.getComponentStats(c.id);
                if (!stats) return false;
                if (roleFilter === 'source' || roleFilter === 'spatial') {
                    return stats.Movement && Object.keys(stats.Movement).length > 0;
                }
                if (roleFilter === 'self_target') {
                    return stats.Physical && Object.keys(stats.Physical).length > 0;
                }
                return true;
            })
            .map(c => ({
                componentId: c.id,
                entityId: entity.id,
                componentType: c.type,
                stats: this.worldStateController.componentController.getComponentStats(c.id)
            }));
    }

    /**
     * Check if component stats pass the role filter.
     * @param {Object} stats - The component stats object.
     * @param {string} roleFilter - The role filter to check against.
     * @returns {boolean} True if the stats pass the filter.
     * @private
     */
    _passesRoleFilter(stats, roleFilter) {
        switch (roleFilter) {
            case 'source':
            case 'spatial':
                return (stats.Movement && Object.keys(stats.Movement).length > 0) ||
                       (stats.Physical && Object.keys(stats.Physical).length > 0);
            case 'self_target':
                return stats.Physical && Object.keys(stats.Physical).length > 0;
            default:
                return true;
        }
    }

    /**
     * Get locked component IDs from ActionSelectController.
     * Uses getLockedComponentIds(excludeActionName) to exclude components
     * locked to the current action from the returned set.
     * @param {string} actionName - The current action name to exclude.
     * @returns {Set<string>} Set of locked component IDs to exclude.
     */
    getLockedComponentIds(actionName) {
        if (!this.actionSelectController) return new Set();
        return this.actionSelectController.getLockedComponentIds(actionName);
    }
}

export default SynergyComponentGatherer;
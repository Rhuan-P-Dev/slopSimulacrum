/**
 * DamageConsequenceHandler — Handles damage application to components.
 * Single Responsibility: Apply damage (stat deltas) to specific target components.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - 'self'    → Damages the source component that fulfilled the action's requirements.
 * - 'target'  → Damages the explicitly targeted component (from actionParams).
 * - 'entity'  → Damages ALL components of the target entity.
 *
 * @module DamageConsequenceHandler
 */

class DamageConsequenceHandler {
    /**
     * @param {Object} controllers - The set of available controllers.
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
    }

    /**
     * Applies damage to a target by modifying its stat values.
     *
     * @param {string} targetId - The resolved target ID (component or entity ID based on target type).
     * @param {Object} resolvedParams - Object containing trait, stat, and value (damage amount).
     * @param {Object} context - Context containing actionParams, fulfillingComponents, and target type info.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDamageComponent(targetId, resolvedParams, context) {
        const { trait, stat, value } = resolvedParams;
        const targetType = context?.actionParams?.consequenceTarget || 'target';

        // 'entity' target: damage ALL components of the entity
        if (targetType === 'entity') {
            return this._damageEntityComponents(targetId, trait, stat, value);
        }

        // 'self' or 'target': damage a specific component
        if (!targetId) {
            return { success: false, message: 'No target specified', data: null };
        }

        // Validate that targetId is a component (has stats)
        const componentStats = this.worldStateController.componentController.getComponentStats(targetId);
        if (!componentStats) {
            return {
                success: false,
                message: `Target "${targetId}" has no stats — cannot apply damage`,
                data: null
            };
        }

        const success = this.worldStateController.componentController.updateComponentStatDelta(targetId, trait, stat, value);
        return {
            success,
            message: success ? `Dealt ${Math.abs(value)} damage to ${targetId}` : `Failed to damage ${targetId}`,
            data: success ? { targetId, trait, stat, value } : null
        };
    }

    /**
     * Damages all components of an entity that have the specified trait.
     * @private
     */
    _damageEntityComponents(entityId, trait, stat, value) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return { success: false, message: `Entity "${entityId}" not found`, data: null };
        }

        let totalDamage = 0;
        let updatedCount = 0;

        for (const component of entity.components) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (stats && stats[trait] && stats[trait][stat] !== undefined) {
                const success = this.worldStateController.componentController.updateComponentStatDelta(component.id, trait, stat, value);
                if (success) {
                    totalDamage += Math.abs(value);
                    updatedCount++;
                }
            }
        }

        return {
            success: true,
            message: `Dealt ${totalDamage} total damage across ${updatedCount} component(s) of entity "${entityId}"`,
            data: { entityId, trait, stat, value, updatedCount, totalDamage }
        };
    }
}

export default DamageConsequenceHandler;
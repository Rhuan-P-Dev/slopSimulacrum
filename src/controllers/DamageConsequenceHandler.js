/**
 * DamageConsequenceHandler — Handles damage application to components.
 * Single Responsibility: Apply damage (stat deltas) to specific target components.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
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
     * Applies damage to a specific component by modifying its stat values.
     *
     * @param {string} entityId - The entity ID (used for context, not direct modification).
     * @param {Object} resolvedParams - Object containing trait, stat, and value (damage amount).
     * @param {Object} context - Context containing actionParams with targetComponentId.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDamageComponent(entityId, resolvedParams, context) {
        const { trait, stat, value } = resolvedParams;
        const targetComponentId = context?.actionParams?.targetComponentId;
        if (!targetComponentId) return { success: false, message: 'No target component specified', data: null };

        const success = this.worldStateController.componentController.updateComponentStatDelta(targetComponentId, trait, stat, value);
        return {
            success,
            message: success ? `Dealt ${Math.abs(value)} damage to ${targetComponentId}` : `Failed to damage ${targetComponentId}`,
            data: success ? { targetComponentId, trait, stat, value } : null
        };
    }
}

export default DamageConsequenceHandler;
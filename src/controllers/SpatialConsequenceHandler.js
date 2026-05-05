/**
 * SpatialConsequenceHandler — Handles spatial coordinate updates and delta movements.
 * Single Responsibility: Manage entity spatial state changes (absolute and relative).
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * @module SpatialConsequenceHandler
 */

import Logger from '../utils/Logger.js';
import { MIN_MOVEMENT_DISTANCE } from '../utils/Constants.js';

class SpatialConsequenceHandler {
    /**
     * @param {Object} controllers - The set of available controllers.
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
    }

    /**
     * Handles spatial coordinate updates for an entity (absolute positioning).
     * Sets the entity's x/y coordinates directly.
     *
     * @param {string} entityId - The entity ID to update.
     * @param {Object} spatialUpdate - Object with x and/or y values.
     * @param {Object} context - Context containing action parameters (unused, kept for signature normalization).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateSpatial(entityId, spatialUpdate, context) {
        const success = this.worldStateController.stateEntityController.updateEntitySpatial(entityId, spatialUpdate);
        if (success) {
            const updatedEntity = this.worldStateController.stateEntityController.getEntity(entityId);
            return {
                success: true,
                message: 'Spatial coordinates updated',
                data: { spatialUpdate, newSpatial: updatedEntity?.spatial }
            };
        }
        return { success: false, message: 'Failed to update spatial coordinates', data: null };
    }

    /**
     * Handles delta (relative) spatial movement for an entity.
     * If targetX/targetY are provided in actionParams, normalizes movement direction
     * toward the target, capped by the speed value.
     *
     * @param {string} entityId - The entity ID to move.
     * @param {Object} deltaUpdate - Object with x, y delta values and/or speed.
     * @param {Object} context - Context containing actionParams with optional targetX/targetY.
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
            if (distance > MIN_MOVEMENT_DISTANCE) {
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
                message: 'Entity moved',
                data: { deltaUpdate: { x: moveX, y: moveY }, newSpatial: this.worldStateController.stateEntityController.getEntity(entityId)?.spatial }
            }
            : { success: false, message: 'Failed to update spatial coordinates', data: null };
    }
}

export default SpatialConsequenceHandler;
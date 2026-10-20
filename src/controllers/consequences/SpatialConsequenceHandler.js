/**
 * SpatialConsequenceHandler — Handles spatial coordinate updates and delta movements.
 * Single Responsibility: Manage entity spatial state changes (absolute and relative).
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - 'entity'  → Moves the entire entity (primary use case for spatial operations).
 * - 'self'    → Moves the source component's entity (same as entity for spatial).
 * - 'target'  → Moves the explicitly targeted entity.
 *
 * **Move attribution:** when an *action* repositions an entity (the consequence
 * context carries `context.actionName`), the action name, tick, and the *specific
 * component that powered the move* are recorded as the entity's `lastMoveAction`.
 * That component is the one the action's requirement resolver selected to satisfy
 * `Movement.move` (`fulfillingComponents['Movement.move']`) — i.e. the exact part
 * that did the moving, not just "a move happened". The perception engine reads
 * this tag to credit *which action* and *which component* produced an observed
 * movement delta. (The world event log only stores free-text "turn" lines that
 * cannot be matched back to an entity, so a first-class per-entity tag is the
 * reliable seam.) Additive only: a small `{ action, tick, componentId }` field;
 * the entity's spatial values are untouched.
 *
 * @module SpatialConsequenceHandler
 */

import { MIN_MOVEMENT_DISTANCE } from '../../utils/Constants.js';
import { flatKey, TRAIT_GROUPS, STAT_NAMES } from '../../../shared/StatVocabulary.js';

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
     * @param {string} targetId - The entity ID to update (resolved from consequence target).
     * @param {Object} spatialUpdate - Object with x and/or y values.
     * @param {Object} [context] - Action execution context; `context.actionName`
     *   identifies the action that caused the move (recorded as the entity's
     *   `lastMoveAction` when the position actually changed).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateSpatial(targetId, spatialUpdate, context) {
        const wsc = this.worldStateController;
        // Capture the position *before* the update so we know whether the move
        // actually changed it (a no-op absolute set should not attribute a move).
        const entityBefore = wsc.stateEntityController.getEntity(targetId);
        const spatialBefore = entityBefore?.spatial ?? null;
        const success = wsc.stateEntityController.updateEntitySpatial(targetId, spatialUpdate);
        if (success) {
            const updatedEntity = wsc.stateEntityController.getEntity(targetId);
            this._recordMoveAttribution(
                targetId,
                context,
                spatialChanged(spatialBefore, updatedEntity?.spatial)
            );
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
     * @param {string} targetId - The entity ID to move (resolved from consequence target).
     * @param {Object} deltaUpdate - Object with x, y delta values and/or speed.
     * @param {Object} [context] - Action execution context; `context.actionParams`
     *   carries optional targetX/targetY, and `context.actionName` identifies the
     *   action that caused the move (recorded as the entity's `lastMoveAction`).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDeltaSpatial(targetId, deltaUpdate, context) {
        const wsc = this.worldStateController;
        const entity = wsc.stateEntityController.getEntity(targetId);
        if (!entity) return { success: false, message: `Entity "${targetId}" not found`, data: null };
        if (!entity.spatial) return { success: false, message: `Entity "${targetId}" has no spatial data`, data: null };

        const speed = (typeof deltaUpdate.speed === 'number') ? deltaUpdate.speed : 0;
        let moveX = deltaUpdate.x || 0;
        let moveY = deltaUpdate.y || 0;

        const actionParams = context?.actionParams;
        if (actionParams && actionParams.targetX !== undefined && actionParams.targetY !== undefined) {
            const dx = actionParams.targetX - entity.spatial.x;
            const dy = actionParams.targetY - entity.spatial.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance <= MIN_MOVEMENT_DISTANCE) {
                moveX = 0;
                moveY = 0;
            } else if (distance <= speed) {
                // Target is within movement range — move directly to the clicked position
                moveX = dx;
                moveY = dy;
            } else {
                // Target is beyond range — move exactly `speed` units toward it
                moveX = (dx / distance) * speed;
                moveY = (dy / distance) * speed;
            }
        }

        const success = wsc.stateEntityController.updateEntitySpatial(
            targetId,
            { x: entity.spatial.x + moveX, y: entity.spatial.y + moveY }
        );

        // An action that produced a *non-zero* position change is the one we credit
        // the move to. A zero-delta (clamped to the wall / within the min distance)
        // is not a change, so we skip attribution — this guarantees a stale
        // `lastMoveAction` can never credit a move that never happened.
        if (success && (moveX !== 0 || moveY !== 0)) {
            // Perception: an in-place spatial reposition is a room state change the
            // observer must be told about. Room moves (moveEntity) already mark both
            // rooms dirty; the in-place `updateEntitySpatial()` path did not — a gap
            // that hid action-driven spatial moves (e.g. the `move` action) from the
            // perception stream. Mark the room dirty here so the diff reader can
            // surface a "moved" entry, carrying the components that powered the
            // action (from the generic attribution store).
            wsc._markPerceptionDirty(entity.location);
            this._recordMoveAttribution(targetId, context);
        }

        return success
            ? {
                success: true,
                message: 'Entity moved',
                data: { deltaUpdate: { x: moveX, y: moveY }, newSpatial: wsc.stateEntityController.getEntity(targetId)?.spatial }
            }
            : { success: false, message: 'Failed to update spatial coordinates', data: null };
    }

    /**
     * Records the action that just moved `targetId` as the entity's `lastMoveAction`
     * — a small `{ action, tick }` tag read by the perception engine to credit
     * *which action* produced an observed repositioning.
     *
     * No-op when: the context has no action name (non-action spatial changes, e.g.
     * direct placement), or the position did not actually change.
     *
     * @private
     * @param {string} targetId
     * @param {Object} [context] - consequence context; must carry `context.actionName`.
     * @param {boolean} [spatialChanged=true] - whether the position actually changed.
     */
    _recordMoveAttribution(targetId, context, spatialChanged = true) {
        const actionName = context?.actionName;
        if (!actionName || typeof actionName !== 'string' || !spatialChanged) return;
        const wsc = this.worldStateController;
        const entity = wsc?.stateEntityController?.getEntity(targetId);
        if (!entity) return;
        const tick = wsc?.tickSystem?.currentTick ?? null;
        // The component that *used* the movement is the one that satisfied the
        // movement requirement (fulfillingComponents['Movement.move']) — the
        // specific part the requirement resolver picked to power the move. We
        // prefer that exact key; if the context happened not to carry the movement
        // fulfillment key, fall back to the first fulfillment component (for
        // single-requirement moves like `move` these are the same component).
        const fulfillment = context?.fulfillingComponents;
        const movementKey = flatKey(TRAIT_GROUPS.MOVEMENT, STAT_NAMES.MOVE);
        const usedComponentId = fulfillment
            ? (fulfillment[movementKey] ?? Object.values(fulfillment)[0] ?? null)
            : null;
        entity.lastMoveAction = {
            action: actionName,
            tick,
            componentId: usedComponentId ?? null
        };
    }
}

/**
 * True when the position actually changed between `before` and `after`.
 * A missing `before` (entity just placed) means "changed"; a missing `after`
 * (should not happen after a successful update) means "not changed".
 *
 * @param {{x: number, y: number}|null} before
 * @param {{x: number, y: number}|null} after
 * @returns {boolean}
 */
function spatialChanged(before, after) {
    if (!before) return after != null;
    if (!after) return false;
    return before.x !== after.x || before.y !== after.y;
}

export default SpatialConsequenceHandler;

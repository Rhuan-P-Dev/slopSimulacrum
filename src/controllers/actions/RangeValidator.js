/**
 * RangeValidator — Validates spatial range for proximity-based actions.
 * Single Responsibility: Check if source and target are within range, execute range-failure consequences.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * @module RangeValidator
 */

import Logger from '../../utils/Logger.js';
import { checkGrabRange, checkPointRange } from '../../utils/RangeChecker.js';
import { resolveRange } from '../../../shared/RangeResolver.js';
import IdResolver from '../../utils/IdResolver.js';

class RangeValidator {
    /**
     * @param {ActionController} actionController - Reference to ActionController for consequence execution.
     * @param {RequirementResolver} [requirementResolver] - RequirementResolver used to build the
     *   entity-level trait.stat map for range-expression resolution (single source of truth,
     *   shared with the requirement-checking path). Injected by ActionController so the two
     *   modules never re-implement the same component-scan logic.
     *
     * FASE 5: the facade is no longer passed at construction; it is injected via
     * setWorldStateController() (called by ActionController.setWorldStateController()).
     */
    constructor(actionController, requirementResolver) {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
        this.actionController = actionController;
        this.requirementResolver = requirementResolver || null;
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built.
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
    }

    /**
     * Resolves a raw range value (number or expression string) into a validated
     * numeric maximum distance. This is the single source of truth for range
     * expression resolution — both checkGrabRange() and checkSpatialRange()
     * delegate here so the resolve-and-validate semantics never diverge.
     *
     * When maxRange is a string, it is resolved with the shared RangeResolver
     * (single source of truth, identical semantics to the client). fallback=NaN
     * keeps the previous server behavior: unknown placeholders become NaN and are
     * rejected below.
     *
     * @param {string} sourceEntityId - The entity the range expression is resolved against.
     * @param {string|number} maxRange - The raw range value (number or expression string).
     * @returns {{ maxRange?: number, error?: string }} `{ maxRange }` on success,
     *   `{ error }` when the resolved value is invalid (negative, zero, NaN, non-finite).
     * @private
     */
    _resolveMaxRange(sourceEntityId, maxRange) {
        if (typeof maxRange === 'string') {
            const requirementValues = this._resolveRequirementValues(sourceEntityId);
            maxRange = resolveRange(maxRange, requirementValues, NaN);
        }

        // Guard: negative or NaN resolved values are invalid — fail the check
        // rather than throwing, to allow graceful handling by the caller.
        if (typeof maxRange !== 'number' || maxRange <= 0 || !isFinite(maxRange)) {
            Logger.warn(`[RangeValidator] Invalid resolved range: ${maxRange}. Action cannot proceed.`);
            return { error: `Invalid range value: ${maxRange}.` };
        }

        return { maxRange };
    }

    /**
     * Builds the entity-level "trait.stat" → value map used to resolve range
     * expressions. Delegates to RequirementResolver.resolveEntityRequirementValues()
     * (the single source of truth for entity-level stat maps) instead of
     * re-implementing the component-scan loop here.
     *
     * @param {string} entityId - The entity ID.
     * @returns {Object} Map of "trait.stat" → numeric value.
     * @private
     */
    _resolveRequirementValues(entityId) {
        if (!this.requirementResolver) return {};
        return this.requirementResolver.resolveEntityRequirementValues(entityId);
    }

    /**
     * Checks if a grab action is within range of the target entity.
     * Resolves range expressions (e.g., ":Physical.strength*2") using the shared
     * RangeResolver — the same single source of truth used by the client.
     * Server semantics are preserved: an unknown placeholder resolves to NaN
     * (fallback=NaN), which the validity guard below rejects as an invalid range.
     *
     * @param {string} sourceEntityId - The entity performing the grab (typed ent-... or legacy UUID).
     * @param {string} targetEntityId - The entity being grabbed (typed ent-... or legacy UUID).
     * @param {string|number} maxRange - The maximum allowed distance (number or expression string).
     * @returns {{ success: boolean, error?: string }}
     */
    checkGrabRange(sourceEntityId, targetEntityId, maxRange) {
        // Guard: the facade is injected post-construction; refuse to run without it
        // so a mis-wired caller fails fast with a clear error instead of a TypeError.
        if (!this.worldStateController) {
            return { success: false, error: 'WorldStateController not injected.' };
        }

        // Validate entity IDs are typed (accept legacy UUID for compatibility)
        if (!IdResolver.isEntityId(sourceEntityId) && !IdResolver.isLegacyEntityId(sourceEntityId)) {
            Logger.warn(`[RangeValidator] Invalid source entity ID format: "${sourceEntityId}"`);
            return { success: false, error: `Invalid source entity ID format: ${sourceEntityId}` };
        }
        if (!IdResolver.isEntityId(targetEntityId) && !IdResolver.isLegacyEntityId(targetEntityId)) {
            Logger.warn(`[RangeValidator] Invalid target entity ID format: "${targetEntityId}"`);
            return { success: false, error: `Invalid target entity ID format: ${targetEntityId}` };
        }

        const sourceEntity = this.worldStateController.getEntity(sourceEntityId);
        if (!sourceEntity) {
            return { success: false, error: `Source entity "${sourceEntityId}" not found.` };
        }

        const targetEntity = this.worldStateController.getEntity(targetEntityId);
        if (!targetEntity) {
            return { success: false, error: `Target entity "${targetEntityId}" not found.` };
        }

        // Resolve + validate the range expression (shared with checkSpatialRange).
        const resolved = this._resolveMaxRange(sourceEntityId, maxRange);
        if (resolved.error) {
            return { success: false, error: resolved.error };
        }

        return checkGrabRange(sourceEntity, targetEntity, resolved.maxRange);
    }

    /**
     * Checks whether a spatial target point is within range of a source entity.
     * Used for spatial actions (e.g. dropItem) where the client sends a target
     * coordinate (targetX/targetY) instead of a target entity.
     *
     * This is the SERVER-SIDE enforcement that mirrors the client's range display.
     * The range expression (from data/actions.json) is resolved with the shared
     * RangeResolver — the SAME single source of truth the client uses to render
     * the range indicator — so the actual enforced range always matches the
     * displayed range.
     *
     * @param {string} sourceEntityId - The entity performing the action (typed ent-... or legacy UUID).
     * @param {number} targetX - Target X coordinate (room-center-relative).
     * @param {number} targetY - Target Y coordinate (room-center-relative).
     * @param {string|number} maxRange - The maximum allowed distance (number or expression string).
     * @returns {{ success: boolean, error?: string, distance?: number }}
     */
    checkSpatialRange(sourceEntityId, targetX, targetY, maxRange) {
        // Guard: the facade is injected post-construction; refuse to run without it
        // so a mis-wired caller fails fast with a clear error instead of a TypeError.
        if (!this.worldStateController) {
            return { success: false, error: 'WorldStateController not injected.' };
        }

        // Validate entity ID is typed (accept legacy UUID for compatibility)
        if (!IdResolver.isEntityId(sourceEntityId) && !IdResolver.isLegacyEntityId(sourceEntityId)) {
            Logger.warn(`[RangeValidator] Invalid source entity ID format: "${sourceEntityId}"`);
            return { success: false, error: `Invalid source entity ID format: ${sourceEntityId}` };
        }

        const sourceEntity = this.worldStateController.getEntity(sourceEntityId);
        if (!sourceEntity) {
            return { success: false, error: `Source entity "${sourceEntityId}" not found.` };
        }

        if (!sourceEntity.spatial) {
            return { success: false, error: 'Source entity lacks spatial data.' };
        }

        if (typeof targetX !== 'number' || typeof targetY !== 'number' || !isFinite(targetX) || !isFinite(targetY)) {
            return { success: false, error: 'Invalid spatial target coordinates.' };
        }

        // Resolve + validate the range expression (shared with checkGrabRange).
        const resolved = this._resolveMaxRange(sourceEntityId, maxRange);
        if (resolved.error) {
            return { success: false, error: resolved.error };
        }

        // checkPointRange computes the same Euclidean distance as checkGrabRange
        // but returns a point-appropriate error message ("Target is too far away")
        // — the target is a coordinate, not an item to grab.
        return checkPointRange(sourceEntity, targetX, targetY, resolved.maxRange);
    }

}

export default RangeValidator;
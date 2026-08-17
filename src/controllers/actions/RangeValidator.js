/**
 * RangeValidator — Validates spatial range for proximity-based actions.
 * Single Responsibility: Check if source and target are within range, execute range-failure consequences.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * @module RangeValidator
 */

import Logger from '../../utils/Logger.js';
import { checkGrabRange } from '../../utils/RangeChecker.js';
import { resolveRange } from '../../../shared/RangeResolver.js';
import IdResolver from '../../utils/IdResolver.js';

class RangeValidator {
    /**
     * @param {ActionController} actionController - Reference to ActionController for consequence execution.
     *
     * FASE 5: the facade is no longer passed at construction; it is injected via
     * setWorldStateController() (called by ActionController.setWorldStateController()).
     */
    constructor(actionController) {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
        this.actionController = actionController;
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built.
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
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

        // Resolve range expression using the shared RangeResolver (single source of
        // truth, identical semantics to the client). fallback=NaN keeps the previous
        // server behavior: unknown placeholders become NaN and are rejected below.
        if (typeof maxRange === 'string') {
            const requirementValues = this._resolveRequirementValues(sourceEntityId);
            maxRange = resolveRange(maxRange, requirementValues, NaN);
        }

        // Guard: negative or NaN resolved values are invalid — fail the check
        // rather than throwing, to allow graceful handling by the caller.
        if (typeof maxRange !== 'number' || maxRange <= 0 || !isFinite(maxRange)) {
            Logger.warn(`[RangeValidator] Invalid resolved range: ${maxRange}. Action cannot proceed.`);
            return { success: false, error: `Invalid range value: ${maxRange}.` };
        }

        return checkGrabRange(sourceEntity, targetEntity, maxRange);
    }

    /**
     * Resolves requirement values for an entity by gathering all trait stats
     * from its components. Builds a map of "trait.stat" → numeric value.
     * Uses the same resolution pattern as RequirementResolver.resolveRequirementValues().
     *
     * @param {string} entityId - The entity ID.
     * @returns {Object} Map of "trait.stat" → numeric value.
     * @private
     */
    _resolveRequirementValues(entityId) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity || !entity.components) return {};

        const values = {};
        for (const comp of entity.components) {
            const stats = this.worldStateController.getComponentStats(comp.id);
            if (stats) {
                for (const [traitId, traitData] of Object.entries(stats)) {
                    for (const [statName, statValue] of Object.entries(traitData)) {
                        if (typeof statValue === 'number') {
                            values[`${traitId}.${statName}`] = statValue;
                        }
                    }
                }
            }
        }
        return values;
    }

}

export default RangeValidator;
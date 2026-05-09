/**
 * RequirementResolver — Resolves action requirements to component stats.
 * Single Responsibility: Check if entity/component meets action requirements and resolve values.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * @module RequirementResolver
 */

import Logger from '../../utils/Logger.js';
import { checkRequirements, checkRequirementsForComponent } from '../../utils/RequirementChecker.js';

class RequirementResolver {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     */
    constructor(worldStateController) {
        this.worldStateController = worldStateController;
    }

    /**
     * Checks entity-level requirements for an action.
     * Requirements can be satisfied by multiple components.
     *
     * @param {Array<Object>} requirements - Array of requirement objects.
     * @param {string} entityId - The entity ID to check.
     * @returns {{ passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, componentId?: string, error?: {code: string, details: Object} }}
     */
    checkEntityRequirements(requirements, entityId) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity) {
            return {
                passed: false,
                error: { code: 'ENTITY_NOT_FOUND', details: { entityId } }
            };
        }

        return checkRequirements(requirements, entity, (compId) =>
            this.worldStateController.getComponentStats(compId)
        );
    }

    /**
     * Checks if a specific component meets ALL of the action's requirements.
     *
     * @param {Array<Object>} requirements - Array of requirement objects.
     * @param {string} entityId - The entity ID (used for error logging).
     * @param {string} componentId - The specific component to evaluate.
     * @returns {{ passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, error?: {code: string, details: Object} }}
     */
    checkComponentRequirements(requirements, entityId, componentId) {
        const componentStats = this.worldStateController.getComponentStats(componentId);
        if (!componentStats) {
            return { passed: false, error: { code: 'ENTITY_NOT_FOUND', details: { entityId } } };
        }

        const result = checkRequirementsForComponent(requirements, componentStats);
        // Store the componentId in fulfillingComponents for each requirement
        if (result.passed) {
            for (const key of Object.keys(result.fulfillingComponents)) {
                result.fulfillingComponents[key] = componentId;
            }
        }
        return result;
    }

    /**
     * Resolves requirement values from a component's stats.
     * Builds a map of "trait.stat" → numeric value.
     *
     * @param {string} componentId - The component ID.
     * @returns {Object|null} Map of requirement values, or null if component not found.
     */
    resolveRequirementValues(componentId) {
        const componentStats = this.worldStateController.getComponentStats(componentId);
        if (!componentStats) return null;

        const values = {};
        for (const [traitId, traitData] of Object.entries(componentStats)) {
            for (const [statName, statValue] of Object.entries(traitData)) {
                if (typeof statValue === 'number') {
                    values[`${traitId}.${statName}`] = statValue;
                }
            }
        }
        return values;
    }
}

export default RequirementResolver;
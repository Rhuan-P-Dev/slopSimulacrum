/**
 * Requirement checking utility for game actions.
 * Validates that entities/components meet action requirements (trait.stat thresholds).
 * 
 * Responsibility: Entity-level and component-level requirement validation.
 * This logic was extracted from ActionController to adhere to the Single Responsibility Principle (SRP).
 * 
 * @module RequirementChecker
 */

import Logger from './Logger.js';

/**
 * Error codes for requirement checking failures.
 * @readonly
 * @enum {string}
 */
const ERROR_CODES = {
    ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
    MISSING_TRAIT_STAT: 'MISSING_TRAIT_STAT',
    UNKNOWN_REQUIREMENT_FAILURE: 'UNKNOWN_REQUIREMENT_FAILURE',
};

/**
 * Checks if an entity meets the requirements for an action.
 * Requirements can be satisfied by multiple components (entity-wide checking).
 *
 * @param {Array<Object>} requirements - An array of requirement objects.
 * @param {Object} entity - The entity object (with components array).
 * @param {Function} getComponentStats - Function to get component stats by component ID.
 * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, componentId?: string, error?: {code: string, details: Object}}}
 */
export function checkRequirements(requirements, entity, getComponentStats) {
    if (!entity) {
        return {
            passed: false,
            error: { code: ERROR_CODES.ENTITY_NOT_FOUND, details: { entityId: entity?._id || 'unknown' } }
        };
    }

    const reqList = Array.isArray(requirements) ? requirements : [requirements];

    // 1. Score components based on how many requirements they satisfy
    const componentScores = entity.components.map(component => {
        const stats = getComponentStats(component.id);
        let score = 0;
        const satisfiedReqs = [];

        for (const req of reqList) {
            if (stats && stats[req.trait] && stats[req.trait][req.stat] >= req.minValue) {
                score++;
                satisfiedReqs.push(req);
            }
        }
        return { id: component.id, score, satisfiedReqs };
    });

    // 2. Sort components by score descending to prioritize the most capable ones
    componentScores.sort((a, b) => b.score - a.score);

    const requirementValues = {};
    const fulfillingComponents = {};
    let primaryComponentId = null;

    // 3. Assign the best available component for each requirement
    for (const req of reqList) {
        const bestComponent = componentScores.find(cs =>
            cs.satisfiedReqs.some(r => r === req)
        );

        if (!bestComponent) {
            return {
                passed: false,
                error: {
                    code: ERROR_CODES.MISSING_TRAIT_STAT,
                    details: { trait: req.trait, stat: req.stat, minValue: req.minValue }
                }
            };
        }

        const stats = getComponentStats(bestComponent.id);
        const key = `${req.trait}.${req.stat}`;
        requirementValues[key] = stats[req.trait][req.stat];
        fulfillingComponents[key] = bestComponent.id;

        if (!primaryComponentId) primaryComponentId = bestComponent.id;
    }

    return { passed: true, requirementValues, fulfillingComponents, componentId: primaryComponentId };
}

/**
 * Checks if a specific component meets ALL of an action's requirements.
 * Used when a specific component is targeted (e.g., attackerComponentId or targetComponentId).
 *
 * @param {Array<Object>} requirements - An array of requirement objects.
 * @param {Object} componentStats - The component's stats object.
 * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, error?: {code: string, details: Object}}}
 */
export function checkRequirementsForComponent(requirements, componentStats) {
    if (!componentStats) {
        return { passed: false, error: { code: ERROR_CODES.ENTITY_NOT_FOUND, details: {} } };
    }

    const reqList = Array.isArray(requirements) ? requirements : [requirements];

    const requirementValues = {};
    const fulfillingComponents = {};

    for (const req of reqList) {
        const key = `${req.trait}.${req.stat}`;

        if (!componentStats[req.trait] ||
            componentStats[req.trait][req.stat] === undefined ||
            componentStats[req.trait][req.stat] < req.minValue) {
            return {
                passed: false,
                error: {
                    code: ERROR_CODES.MISSING_TRAIT_STAT,
                    details: { trait: req.trait, stat: req.stat, minValue: req.minValue }
                }
            };
        }

        requirementValues[key] = componentStats[req.trait][req.stat];
        fulfillingComponents[key] = componentStats._componentId || null;
    }

    return { passed: true, requirementValues, fulfillingComponents };
}

/**
 * Checks if a component satisfies ALL of an action's requirements.
 * Used for component binding validation.
 *
 * @param {Object} componentStats - The component's stats.
 * @param {Array<Object>} requirements - An array of requirement objects.
 * @returns {boolean} True if the component satisfies all requirements.
 */
export function componentSatisfiesRequirements(componentStats, requirements) {
    if (!componentStats || !Array.isArray(requirements)) return false;

    for (const req of requirements) {
        if (!componentStats[req.trait] ||
            componentStats[req.trait][req.stat] === undefined ||
            componentStats[req.trait][req.stat] < req.minValue) {
            return false;
        }
    }
    return true;
}
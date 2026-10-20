/**
 * Requirement checking utility for game actions.
 * Validates that entities/components meet action requirements (trait.stat thresholds).
 * 
 * Responsibility: Entity-level and component-level requirement validation.
 * This logic was extracted from ActionController to adhere to the Single Responsibility Principle (SRP).
 * 
 * @module RequirementChecker
 */


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
 * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, componentId?: string,
 *           fulfillment?: {string: {best?: string, ids: string[]}}, allFulfillingIds?: string[],
 *           error?: {code: string, details: Object}}}
 * fulfillment semantics — `best` is the component *selected* to power the
 * requirement (whose stats the action consumes); `ids` lists EVERY component
 * that satisfies the requirement, in most-capable order (eligible, not
 * necessarily used). `allFulfillingIds` is the deduplicated union of all
 * eligible components across the action's requirements.
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

    // 2. Sort components by score descending to prioritize the most capable ones.
    //   The stable sort keeps snapshot order as the tie-break, so a "first" / 
    //   "best" read below is deterministic.
    componentScores.sort((a, b) => b.score - a.score);

    // 3. Build the action-agnostic attribution: for EACH requirement, every
    //   component that satisfies it (in most-capable order) plus the *gate*
    //   component (the most capable one). This is the source of truth for
    //   "which components can power this action" — the checker itself knows
    //   nothing about specific actions (no hard-coded 'Movement.move'); it is
    //   the same code path for move, attack, pickUpItem, etc.
    const fulfillment = {};
    for (const req of reqList) {
        fulfillment[`${req.trait}.${req.stat}`] = { best: null, ids: [] };
    }
    const allFulfillingIds = [];
    const seenAll = new Set();

    for (const cs of componentScores) {
        for (const req of cs.satisfiedReqs) {
            const key = `${req.trait}.${req.stat}`;
            const attr = fulfillment[key];
            if (!attr) continue; // defensive: never happens
            if (attr.best === null) attr.best = cs.id; // most capable = gate
            if (!attr.ids.includes(cs.id)) attr.ids.push(cs.id);
            if (!seenAll.has(cs.id)) {
                seenAll.add(cs.id);
                allFulfillingIds.push(cs.id);
            }
        }
    }

    // 4. Assign the best available component for each requirement (backward
    //    compatible: one "best" per requirement key, exactly as before).
    const requirementValues = {};
    const fulfillingComponents = {};
    let primaryComponentId = null;

    for (const req of reqList) {
        const key = `${req.trait}.${req.stat}`;
        const attr = fulfillment[key];
        if (!attr || !attr.ids.length || attr.best === null) {
            return {
                passed: false,
                error: {
                    code: ERROR_CODES.MISSING_TRAIT_STAT,
                    details: { trait: req.trait, stat: req.stat, minValue: req.minValue }
                }
            };
        }

        const stats = getComponentStats(attr.best);
        requirementValues[key] = stats[req.trait][req.stat];
        fulfillingComponents[key] = attr.best;

        if (!primaryComponentId) primaryComponentId = attr.best;
    }

    return {
        passed: true,
        requirementValues,
        fulfillingComponents,
        componentId: primaryComponentId,
        // NEW (generic, action-agnostic):
        //   fulfillment        — per-requirement breakdown ({ best, ids: all that satisfy });
        //   allFulfillingIds   — deduplicated union of every component that satisfied any
        //                        requirement of the action. This is the *eligibility*
        //                        union — metadata only. The "which & how many
        //                        POWERED action X" answer is the caller's explicit
        //                        designations (when any) or the selected `best`s,
        //                        never this union.
        fulfillment,
        allFulfillingIds,
    };
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
/**
 * ComponentDependents — pure, stateless.
 *
 * Builds the reverse index: parentId → childIds[] from
 * `dependsOn` of component instances (entity.components[]).
 *
 * Input: components[] with `dependsOn: [parentInstanceId, ...]` field
 * Output: Map<parentId, childId[]> in preserved array order.
 *
 * Safe for orphan edges (parentId that doesn't resolve to any component)
 * and for self-dependency (A.dependsOn contains A.id): the cascade's
 * visited-set prevents loops.
 *
 * @module ComponentDependents
 */

/**
 * Builds the reverse index of dependencies.
 * @param {Array<{id: string, dependsOn: string[]}>} components - Component instances with dependsOn.
 * @returns {Map<string, string[]>} parentId → childIds[].
 */
function buildReverseIndex(components) {
    if (!Array.isArray(components)) return new Map();
    const reverseIndex = new Map();

    // Initialize all as empty (ensures all appear in the map)
    for (const comp of components) {
        if (!reverseIndex.has(comp.id)) {
            reverseIndex.set(comp.id, []);
        }
    }

    // For each component, for each parent, add this child to the parent's list
    for (const comp of components) {
        if (Array.isArray(comp.dependsOn)) {
            for (const parentId of comp.dependsOn) {
                if (!reverseIndex.has(parentId)) {
                    reverseIndex.set(parentId, []);
                }
                reverseIndex.get(parentId).push(comp.id);
            }
        }
    }

    return reverseIndex;
}

export { buildReverseIndex };

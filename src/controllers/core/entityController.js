import { generateCompId } from '../../utils/idGenerator.js';
import DataLoader from '../../utils/DataLoader.js';

/**
 * EntityController is responsible for storing entity blueprints and
 * managing the composition of entities.
 * 
 * Blueprints are data-driven: loaded from data/blueprints.json at runtime
 * via the DataLoader utility, following the data-driven design principle.
 * 
 * dependsOn: expandBlueprint builds a tree structure with parent
 * references; createEntityFromBlueprint flattens it and resolves
 * `dependsOn: [parentInstanceId]` after ids are generated.
 */
class EntityController {
    constructor(componentController, blueprints = null) {
        this.componentController = componentController;
        
        // Load blueprints from data file (decoupled from code).
        // If blueprints are injected (e.g., for testing), use those instead.
        this.blueprints = blueprints || DataLoader.loadJsonSafe('data/blueprints.json', {});
    }

    /**
     * Recursively expands a blueprint into a flat list of component definitions.
     * Uses a per-branch visited set to prevent infinite recursion.
     * 
     * Returns array of [compName, identifier, parentFlatIndex] where
     * parentFlatIndex is -1 for roots or the absolute index of the parent
     * in the resulting flat list.
     * 
     * @param {string} blueprintName - The name of the blueprint to expand.
     * @param {Set<string>} [visited] - Set of already-visited blueprint names.
     * @param {number} [parentFlatIndex=-1] - Absolute flat-list index of parent.
     * @param {Array} [result=[]] - Accumulator for the flat list.
     * @returns {Array} A list of components needed for the entity.
     */
    expandBlueprint(blueprintName, visited = new Set(), parentFlatIndex = -1, result = []) {
        if (visited.has(blueprintName)) {
            return result;
        }

        const blueprint = this.blueprints[blueprintName];

        if (!blueprint) {
            throw new Error(`Blueprint ${blueprintName} not found in EntityController.`);
        }

        // Always take the passed-in visited set (default parameter is already a fresh Set);
        // the `isNewCall` flag was always false, so this simplifies to a direct pass-through.
        const branchVisited = visited;
        branchVisited.add(blueprintName);

        for (const item of blueprint) {
            if (Array.isArray(item)) {
                const [compName, identifier] = item;
                // Current length = this component's future index
                const myIndex = result.length;
                
                // Add this component with parent reference
                result.push([compName, identifier, parentFlatIndex]);
                
                // If the component itself is also a blueprint, expand it
                if (this.blueprints[compName]) {
                    const childVisited = new Set(branchVisited);
                    childVisited.add(blueprintName);
                    // Recursively get children — they use myIndex as parent
                    this.expandBlueprint(compName, childVisited, myIndex, result);
                    // Remap identifiers for children: append _${identifier}
                    // Children were added after myIndex, so remap them
                    for (let i = myIndex + 1; i < result.length; i++) {
                        const c = result[i];
                        if (Array.isArray(c) && c.length >= 2 && typeof c[1] === 'string') {
                            result[i] = [c[0], `${c[1]}_${identifier}`, c[2]];
                        }
                    }
                }
            } else {
                const compName = item;
                const identifier = "default";
                const myIndex = result.length;
                
                // Add this component with parent reference
                result.push([compName, identifier, parentFlatIndex]);
                
                // If the component itself is also a blueprint, expand it
                if (this.blueprints[compName]) {
                    const childVisited = new Set(branchVisited);
                    childVisited.add(blueprintName);
                    this.expandBlueprint(compName, childVisited, myIndex, result);
                }
            }
        }
        return result;
    }

    /**
     * Creates a new entity instance based on a blueprint.
     * Resolves parent-index propagation to `dependsOn: [parentInstanceId]`.
     * @param {string} blueprintName - The blueprint to use.
     * @returns {Object} The created entity structure with instance IDs and dependsOn.
     */
    createEntityFromBlueprint(blueprintName) {
        const flattenedComponentsWithParentIndex = this.expandBlueprint(blueprintName);
        const instanceComposition = [];

        // First pass: generate all instance ids
        for (const [compType, identifier] of flattenedComponentsWithParentIndex) {
            const instanceId = generateCompId();
            instanceComposition.push({
                type: compType,
                identifier: identifier,
                id: instanceId
            });
        }

        // Second pass: resolve dependsOn from parent indices
        for (let i = 0; i < instanceComposition.length; i++) {
            const entry = flattenedComponentsWithParentIndex[i];
            const parentIndex = entry[2]; // parent index from expandBlueprint
            if (parentIndex >= 0 && parentIndex < instanceComposition.length) {
                instanceComposition[i].dependsOn = [instanceComposition[parentIndex].id];
            } else {
                instanceComposition[i].dependsOn = [];
            }
        }

        // Initialize all component stats
        for (const comp of instanceComposition) {
            this.componentController.initializeComponent(comp.type, comp.id);
        }

        return {
            blueprint: blueprintName,
            components: instanceComposition
        };
    }

    /**
     * Returns all available blueprints.
     * @returns {Object}
     */
    getBlueprints() {
        return this.blueprints;
    }
}

export default EntityController;

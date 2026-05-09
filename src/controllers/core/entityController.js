import ComponentController from './componentController.js';
import { generateUID } from '../../utils/idGenerator.js';
import DataLoader from '../../utils/DataLoader.js';

/**
 * EntityController is responsible for storing entity blueprints and
 * managing the composition of entities.
 * 
 * Blueprints are data-driven: loaded from data/blueprints.json at runtime
 * via the DataLoader utility, following the data-driven design principle.
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
     * Uses a per-branch visited set to prevent infinite recursion while allowing
     * the same blueprint to be expanded in different branches (e.g., left and right arms).
     * @param {string} blueprintName - The name of the blueprint to expand.
     * @param {Set<string>} [visited] - Set of already-visited blueprint names to prevent infinite recursion.
     * @returns {Array} A list of components needed for the entity.
     */
    expandBlueprint(blueprintName, visited = new Set()) {
        if (visited.has(blueprintName)) {
            // Prevent infinite recursion for leaf-only blueprints (e.g., knife)
            return [];
        }

        const components = [];
        const blueprint = this.blueprints[blueprintName];

        if (!blueprint) {
            throw new Error(`Blueprint ${blueprintName} not found in EntityController.`);
        }

        for (const item of blueprint) {
            if (Array.isArray(item)) {
                const [compName, identifier] = item;
                // Always add the component itself
                components.push([compName, identifier]);
                
                // If the component itself is also a blueprint, expand it to add its children
                // Create a NEW visited set for each branch to allow sibling blueprints
                // to be expanded independently (e.g., left and right arms both expanding droidArm)
                if (this.blueprints[compName]) {
                    const branchVisited = new Set(visited);
                    branchVisited.add(blueprintName);
                    components.push(...this.expandBlueprint(compName, branchVisited).map(c => 
                        Array.isArray(c) ? [c[0], `${c[1]}_${identifier}`] : [c, identifier]
                    ));
                }
            } else {
                // If it's a string, it might be a blueprint or a leaf component
                const compName = item;
                const identifier = "default";
                
                // Always add the component itself
                components.push([compName, identifier]);
                
                // If the component itself is also a blueprint, expand it to add its children
                // Create a NEW visited set for this branch
                if (this.blueprints[compName]) {
                    const branchVisited = new Set(visited);
                    branchVisited.add(blueprintName);
                    components.push(...this.expandBlueprint(compName, branchVisited));
                }
            }
        }
        return components;
    }

    /**
     * Creates a new entity instance based on a blueprint.
     * @param {string} blueprintName - The blueprint to use.
     * @returns {Object} The created entity structure with instance IDs.
     */
    createEntityFromBlueprint(blueprintName) {
        const flattenedComponents = this.expandBlueprint(blueprintName);
        const instanceComposition = [];

        for (const [compType, identifier] of flattenedComponents) {
            const instanceId = generateUID();
            this.componentController.initializeComponent(compType, instanceId);
            instanceComposition.push({
                type: compType,
                identifier: identifier,
                id: instanceId
            });
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

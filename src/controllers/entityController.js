import ComponentController from './componentController.js';
import { generateUID } from '../utils/idGenerator.js';

/**
 * EntityController is responsible for storing entity blueprints and
 * managing the composition of entities.
 */
class EntityController {
    constructor(componentController) {
        this.componentController = componentController;
        
        // Entity Blueprints
        // format: "blueprint_name": [composition_array]
        // Composition array can contain strings (component names) or arrays [component_name, identifier/side]
        this.blueprints = {
            "smallBallDroid": ["centralBall"],
            "centralBall": [
                "droidHead", 
                ["droidArm", "left"], 
                ["droidArm", "right"], 
                "droidRollingBall"
            ],
            "droidArm": ["droidHand"],
            "droidHand": [
                ["humanoidDroidFinger", "left"], 
                ["humanoidDroidFinger", "middle"], 
                ["humanoidDroidFinger", "right"]
            ],
        };
    }

    /**
     * Recursively expands a blueprint into a flat list of component definitions.
     * @param {string} blueprintName - The name of the blueprint to expand.
     * @returns {Array} A list of components needed for the entity.
     */
    expandBlueprint(blueprintName) {
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
                if (this.blueprints[compName]) {
                    components.push(...this.expandBlueprint(compName).map(c => 
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
                if (this.blueprints[compName]) {
                    components.push(...this.expandBlueprint(compName));
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

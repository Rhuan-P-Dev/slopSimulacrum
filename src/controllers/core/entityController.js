import { generateCompId } from '../../utils/idGenerator.js';
import DataLoader from '../../utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';

/**
 * EntityController is responsible for storing entity blueprints and
 * managing the composition of entities.
 * 
 * Blueprints are data-driven: loaded from data/mods/core-blueprints/blueprints.json at runtime
 * via the DataLoader utility, following the data-driven design principle.
 * 
 * dependsOn: expandBlueprint builds a tree structure with parent
 * references; createEntityFromBlueprint flattens it and resolves
 * `dependsOn: [parentInstanceId]` after ids are generated.
 *
 * A mount entry is `["componentType", "slot"]`, and may author a third element —
 * an options object for THAT mount: `["maleBreast", "left",
 * { "hidesWithParent": true }]`. It is per mount, not per component type, because
 * what hangs under whose cloth is a fact about this joint (see `MOUNT_OPTIONS`).
 */

/**
 * Reads the third element of a blueprint mount entry — the options that mount
 * authored.
 *
 * Anything that is not an object (absent, a string, an array) is read as no
 * options: the mount is the historical `[type, slot]` pair and nothing is hidden
 * from it. An object with keys this module does not know is carried through
 * untouched — a future reader owns its own key, and `expandBlueprint` is not the
 * arbiter of what the world may record.
 *
 * @param {Array} item - one entry of a blueprint array
 * @returns {Object|null} the mount's options, or null when it authored none
 */
function mountOptions(item) {
    const raw = Array.isArray(item) && item.length > 2 ? item[2] : null;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * The options a flat-list row carries, in the slot AFTER the parent index: the
 * row stays the `[name, slot, parentIndex]` triple it has always been when the
 * mount authored nothing, so every existing blueprint expands identically.
 * @constant
 */
const MOUNT_OPTIONS = 3;
class EntityController {
    constructor(componentController, blueprints = null) {
        this.componentController = componentController;
        
        // Load blueprints from data file (decoupled from code).
        // If blueprints are injected (e.g., for testing), use those instead.
        this.blueprints = blueprints || DataLoader.loadRegistry(REGISTRY_KINDS.BLUEPRINTS);
    }

    /**
     * Recursively expands a blueprint into a flat list of component definitions.
     * Uses a per-branch visited set to prevent infinite recursion.
     * 
     * Returns array of [compName, identifier, parentFlatIndex] (plus the mount's
     * authored options at `MOUNT_OPTIONS`, only when it authored some) where
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

                // Add this component with parent reference (and what this mount declared)
                const row = [compName, identifier, parentFlatIndex];
                const options = mountOptions(item);
                if (options) row[MOUNT_OPTIONS] = options;
                result.push(row);
                
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
                            // The rename is about the slot; what the mount itself declared
                            // (index MOUNT_OPTIONS) survives it, or a rename under a parent
                            // would quietly un-mark the child.
                            const renamed = [c[0], `${c[1]}_${identifier}`, c[2]];
                            if (c.length > MOUNT_OPTIONS) renamed[MOUNT_OPTIONS] = c[MOUNT_OPTIONS];
                            result[i] = renamed;
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
        for (const entry of flattenedComponentsWithParentIndex) {
            const [compType, identifier] = entry;
            const instance = {
                type: compType,
                identifier: identifier,
                id: generateCompId()
            };
            // What this mount declared about itself travels ON the instance, so a
            // reader of a live body never re-opens a blueprint to learn what a part
            // is under. Absent, not false, when the mount authored nothing.
            if (entry[MOUNT_OPTIONS]?.hidesWithParent === true) instance.hidesWithParent = true;
            instanceComposition.push(instance);
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

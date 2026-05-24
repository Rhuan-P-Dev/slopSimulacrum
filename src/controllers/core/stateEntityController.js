import EntityController from './entityController.js';
import { generateUID } from '../../utils/idGenerator.js';

/**
 * stateEntityController is a subcontroller of WorldStateController.
 * It manages all active entity instances in the game world and manipulates them in memory.
 *
 * When entities are spawned or despawned, this controller triggers capability cache
 * re-evaluation to keep the ActionController's cache in sync.
 *
 * Internal Components: Automatically installs internal components (e.g., durabilityRepairSpheres)
 * on eligible components via the injected InternalComponentController.
 */
class stateEntityController {
    /**
     * @param {EntityController} entityController - The entity blueprint controller.
     * @param {import('../controllers/actionController.js').default|null} actionController - The action controller for capability re-evaluation.
     * @param {any|null} internalComponentController - The internal component controller for auto-installing components.
     */
    constructor(entityController, actionController = null, internalComponentController = null) {
        this.entityController = entityController;

        /**
         * Active entities in the game.
         * Format: { [entityId]: { id: string, blueprint: string, components: Array, location: string, spatial: { x, y }, status: string, internalComponents: Object } }
         * @type {Object<string, Object>}
         */
        this.entities = {};

        /**
         * Reference to the ActionController.
         * @type {import('../controllers/actionController.js').default|null}
         */
        this.actionController = actionController;

        /**
         * Reference to the InternalComponentController for auto-installation.
         * @type {any|null}
         */
        this.internalComponentController = internalComponentController;

        /**
         * Spawn observers — functions called when an entity is spawned.
         * Each observer receives (entityId, entityData).
         * @type {Array<Function>}
         */
        this._spawnObservers = [];
    }

    /**
     * Registers a callback that fires whenever an entity is spawned.
     * Observers are useful for post-spawn side effects (e.g., adding test items).
     * @param {Function} observer - A function that receives (entityId, entityData).
     * @returns {void}
     */
    registerSpawnObserver(observer) {
        if (typeof observer === 'function' && !this._spawnObservers.includes(observer)) {
            this._spawnObservers.push(observer);
        }
    }

    /**
     * Spawns a new entity into the world based on a blueprint.
     * After spawning, triggers capability cache re-evaluation for the new entity
     * and auto-installs internal components.
     *
     * @param {string} blueprintName - The name of the entity blueprint to use.
     * @param {string} roomId - The initial room where the entity is located.
     * @returns {string} The unique ID of the newly created entity.
     */
    spawnEntity(blueprintName, roomId) {
        const entityId = generateUID();
        const entityData = this.entityController.createEntityFromBlueprint(blueprintName);

        this.entities[entityId] = {
            id: entityId,
            ...entityData,
            internalComponents: {}, // Internal components stored per entity
            location: roomId,
            spatial: { x: 0, y: 0 },
            status: 'active'
        };

        // Auto-install internal components (e.g., durabilityRepairSpheres, transcendentSpeedCores)
        if (this.internalComponentController) {
            try {
                this.internalComponentController.autoInstallOnEntitySpawn(entityId, entityData.components, entityData.blueprint || null);
                // Sync internal components from controller to entity so client receives them in broadcast
                this.entities[entityId].internalComponents = this.internalComponentController.getInternalComponentsForEntity(entityId);
            } catch (error) {
                console.error(`[stateEntityController] Auto-install failed for entity ${entityId}: ${error.message}`);
            }
        }

        // Trigger capability cache re-evaluation for the newly spawned entity
        if (this.actionController) {
            const state = this.actionController.worldStateController.getAll();
            this.actionController.reEvaluateEntityCapabilities(state, entityId);
        }

        // Call all registered spawn observers
        for (const observer of this._spawnObservers) {
            try {
                observer(entityId, entityData);
            } catch (error) {
                console.error(`[stateEntityController] Spawn observer failed for entity ${entityId}: ${error.message}`);
            }
        }

        return entityId;
    }

    /**
     * Moves an entity to a different room.
     * @param {string} entityId - The ID of the entity to move.
     * @param {string} newRoomId - The destination room ID.
     * @returns {boolean} True if the move was successful.
     */
    moveEntity(entityId, newRoomId) {
        if (this.entities[entityId]) {
            this.entities[entityId].location = newRoomId;
            return true;
        }
        return false;
    }

    /**
     * Removes an entity from the game.
     * Before removing, triggers cache cleanup to remove all capability entries for this entity
     * and cleans up internal component data.
     *
     * @param {string} entityId - The ID of the entity to remove.
     * @returns {boolean} True if the entity was removed.
     */
    despawnEntity(entityId) {
        if (this.entities[entityId]) {
            // Remove all capability entries for this entity before despawning
            if (this.actionController) {
                this.actionController.removeEntityFromCache(entityId);
            }

            // Clean up internal components for this entity
            if (this.internalComponentController) {
                this.internalComponentController.cleanupEntity(entityId);
            }

            delete this.entities[entityId];
            return true;
        }
        return false;
    }

    /**
     * Retrieves a specific entity's data.
     * @param {string} entityId - The ID of the entity.
     * @returns {Object|null} The entity data or null if not found.
     */
    getEntity(entityId) {
        return this.entities[entityId] || null;
    }

    /**
     * Updates an entity's spatial coordinates.
     * @param {string} entityId - The ID of the entity.
     * @param {Object} spatialUpdate - Object with x and/or y values to update.
     * @returns {boolean} True if update was successful.
     */
    updateEntitySpatial(entityId, spatialUpdate) {
        if (this.entities[entityId]) {
            if (spatialUpdate.x !== undefined) {
                this.entities[entityId].spatial.x = spatialUpdate.x;
            }
            if (spatialUpdate.y !== undefined) {
                this.entities[entityId].spatial.y = spatialUpdate.y;
            }
            return true;
        }
        return false;
    }

    /**
     * Returns a deep clone of all active entities to prevent direct mutation of internal state.
     * @returns {Object} Deep clone of the entities store.
     */
    getAll() {
        return structuredClone(this.entities);
    }
}

export default stateEntityController;
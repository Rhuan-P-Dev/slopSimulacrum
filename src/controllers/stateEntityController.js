import EntityController from './entityController.js';
import { generateUID } from '../utils/idGenerator.js';

/**
 * stateEntityController is a subcontroller of WorldStateController.
 * It manages all active entity instances in the game world and manipulates them in memory.
 *
 * When entities are spawned or despawned, this controller triggers capability cache
 * re-evaluation to keep the ActionController's cache in sync.
 */
class stateEntityController {
    /**
     * @param {EntityController} entityController - The entity blueprint controller.
     */
    constructor(entityController) {
        this.entityController = entityController;

        /**
         * Active entities in the game.
         * Format: { [entityId]: { id: string, blueprint: string, components: Array, location: string, spatial: { x, y }, status: string } }
         * @type {Object<string, Object>}
         */
        this.entities = {};

        /**
         * Reference to the ActionController (set by WorldStateController after construction).
         * @type {import('../controllers/actionController.js').default|null}
         */
        this.actionController = null;
    }

    /**
     * Spawns a new entity into the world based on a blueprint.
     * After spawning, triggers capability cache re-evaluation for the new entity.
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
            location: roomId,
            spatial: { x: 0, y: 0 },
            status: 'active'
        };

        // Trigger capability cache re-evaluation for the newly spawned entity
        if (this.actionController) {
            const state = this.actionController.worldStateController.getAll();
            this.actionController.reEvaluateEntityCapabilities(state, entityId);
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
     * Before removing, triggers cache cleanup to remove all capability entries for this entity.
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
     * Returns the current state of all active entities.
     * This is called by WorldStateController.getAll().
     * @returns {Object}
     */
    getAll() {
        return this.entities;
    }
}

export default stateEntityController;

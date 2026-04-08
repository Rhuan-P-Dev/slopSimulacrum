const EntityController = require('./entityController');
const { generateUID } = require('../utils/idGenerator');

/**
 * stateEntityController is a subcontroller of WorldStateController.
 * It manages all active entity instances in the game world and manipulates them in memory.
 */
class stateEntityController {
    constructor(entityController) {
        this.entityController = entityController;
        
        // Active entities in the game
        // Format: { [entityId]: { id: string, blueprint: string, components: Array, location: string, ... } }
        this.entities = {};
    }

    /**
     * Spawns a new entity into the world based on a blueprint.
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
            status: 'active'
        };

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
     * @param {string} entityId - The ID of the entity to remove.
     * @returns {boolean} True if the entity was removed.
     */
    despawnEntity(entityId) {
        if (this.entities[entityId]) {
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
     * Returns the current state of all active entities.
     * This is called by WorldStateController.getAll().
     * @returns {Object}
     */
    getAll() {
        return this.entities;
    }
}

module.exports = stateEntityController;

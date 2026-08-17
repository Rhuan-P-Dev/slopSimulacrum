import { AppConfig } from './Config.js';

/**
 * WorldStateManager
 * Handles the synchronization and storage of the world state on the client.
 * Acts as the single source of truth for the current simulation state.
 */
export class WorldStateManager {
    constructor() {
        /** @type {Object|null} The full state of the world */
        this.state = null;
        /** @type {string|null} The ID of the entity the user is controlling */
        this.myEntityId = null;
    }

    /**
     * Sets the ID of the entity controlled by this client.
     * @param {string} entityId 
     */
    setMyEntityId(entityId) {
        this.myEntityId = entityId;
    }

    /**
     * Gets the ID of the entity controlled by this client.
     * @returns {string|null}
     */
    getMyEntityId() {
        return this.myEntityId;
    }

    /**
     * Fetches the latest world state from the server.
     * @returns {Promise<Object|null>} The fetched state or null on failure.
     * @throws {Error} If the fetch fails.
     */
    async fetchState() {
        const response = await fetch('/world-state');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        this.state = data.state;
        return this.state;
    }

    /**
     * Determines the primary droid to be used for navigation and rendering.
     * Priority: 1. The incarnated entity, 2. Any droid with the default blueprint.
     * @returns {Object|null} The active droid entity or null.
     */
    getActiveDroid() {
        if (!this.state || !this.state.entities) return null;

        if (this.myEntityId && this.state.entities[this.myEntityId]) {
            return this.state.entities[this.myEntityId];
        }

        return Object.values(this.state.entities).find(e => e.blueprint === AppConfig.DEFAULTS.DROID_BLUEPRINT) || null;
    }

    /**
     * Returns the current world state.
     * @returns {Object|null}
     */
    getState() {
        return this.state;
    }

    /**
     * Gets an equipped item by entity ID and typed equipped ID (eq-uuid).
     * @param {string} entityId - The entity's typed ID (ent-uuid).
     * @param {string} eqId - The equipped item's typed ID (eq-uuid).
     * @returns {Object|null} The equipped item object or null.
     */
    getEquippedItem(entityId, eqId) {
        if (!this.state || !this.state.entities || !this.state.entities[entityId]) {
            return null;
        }
        const entity = this.state.entities[entityId];
        if (!entity.equipped || !Array.isArray(entity.equipped)) {
            return null;
        }
        return entity.equipped.find(eq => eq.eqId === eqId) || null;
    }
}

/**
 * EquipmentController — Orchestrates hand grab and backpack storage operations.
 * Single Responsibility: Delegate to HandEquipment and BackpackInventory modules.
 *
 * Extracted from original monolithic EquipmentController (679 lines → ~120 lines).
 * Hand grab logic extracted to HandEquipment.js.
 * Backpack logic extracted to BackpackInventory.js.
 *
 * @example
 * // Architecture flow:
 * // Client → Server → ActionController.executeAction("grab")
 * //     → ConsequenceHandlers._handleGrabItem()
 * //     → EquipmentController.grabItem()
 * //     → HandEquipment.grabItem() → ComponentController.initializeComponent() + StateEntityController.addComponentToEntity()
 */
import Logger from '../utils/Logger.js';
import HandEquipment from './HandEquipment.js';
import BackpackInventory from './BackpackInventory.js';

class EquipmentController {
    /**
     * Creates a new EquipmentController.
     *
     * @param {WorldStateController} worldStateController - The root state controller (injected).
     */
    constructor(worldStateController) {
        /**
         * @type {WorldStateController}
         */
        this.worldStateController = worldStateController;

        /**
         * Internal grab registry: componentId (item component on entity) → GrabEntry.
         * Shared with HandEquipment module.
         * @type {Map<string, GrabEntry>}
         * @private
         */
        this._grabRegistry = new Map();

        /**
         * Backpack registry: entityId → Array<BackpackEntry>.
         * Shared with BackpackInventory module.
         * @type {Map<string, Array<BackpackEntry>>}
         * @private
         */
        this._backpackRegistry = new Map();

        // Inject extracted modules
        this.handEquipment = new HandEquipment(worldStateController, this._grabRegistry);
        this.backpackInventory = new BackpackInventory(worldStateController, this._backpackRegistry);

        Logger.info('[EquipmentController] Initialized');
    }

    // =========================================================================
    // PUBLIC API: DELEGATION — HAND GRABS
    // =========================================================================

    /**
     * Grab an item entity into a hand component.
     * @param {string} entityId - The ID of the entity receiving the item.
     * @param {string} handComponentId - The hand component that grabs the item.
     * @param {Object} itemEntity - The item entity being grabbed.
     * @returns {{ success: boolean, componentId?: string, error?: string }}
     */
    grabItem(entityId, handComponentId, itemEntity) {
        return this.handEquipment.grabItem(entityId, handComponentId, itemEntity);
    }

    /**
     * Release a grabbed item from a hand component.
     * @param {string} componentId - The item component ID to remove.
     * @returns {{ success: boolean, grabInfo?: GrabEntry, error?: string, spawnedEntityId?: string }}
     */
    releaseItem(componentId) {
        return this.handEquipment.releaseItem(componentId);
    }

    /**
     * Get grab tracking info for a specific item component.
     * @param {string} componentId - The item component ID.
     * @returns {GrabEntry|null}
     */
    getGrabInfo(componentId) {
        return this.handEquipment.getGrabInfo(componentId);
    }

    /**
     * Get all grab entries for a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array<GrabEntry>}
     */
    getGrabInfoByEntity(entityId) {
        return this.handEquipment.getGrabInfoByEntity(entityId);
    }

    /**
     * Check if a component is currently holding an item.
     * @param {string} componentId - The component ID to check.
     * @returns {boolean}
     */
    isHoldingItem(componentId) {
        return this.handEquipment.isHoldingItem(componentId);
    }

    /**
     * Get the number of active grabs.
     * @returns {number}
     */
    getActiveGrabCount() {
        return this.handEquipment.getActiveGrabCount();
    }

    /**
     * Release all hand grabs for an entity during despawn.
     * @param {string} entityId - The entity ID.
     * @returns {number} Number of released grabs.
     */
    releaseEntityHandGrabs(entityId) {
        return this.handEquipment.releaseEntityHandGrabs(entityId);
    }

    // =========================================================================
    // PUBLIC API: DELEGATION — BACKPACK
    // =========================================================================

    /**
     * Grab an item entity into a backpack component.
     * @param {string} entityId - The ID of the entity receiving the item.
     * @param {string} backpackComponentId - The backpack component ID.
     * @param {Object} itemEntity - The item entity being grabbed.
     * @returns {{ success: boolean, componentId?: string, error?: string }}
     */
    grabToBackpack(entityId, backpackComponentId, itemEntity) {
        return this.backpackInventory.grabToBackpack(entityId, backpackComponentId, itemEntity);
    }

    /**
     * Release a backpack item and respawn it in the world.
     * @param {string} componentId - The item component ID stored in the backpack.
     * @returns {{ success: boolean, entry?: BackpackEntry, error?: string, spawnedEntityId?: string }}
     */
    releaseBackpackItem(componentId) {
        return this.backpackInventory.releaseBackpackItem(componentId);
    }

    /**
     * Get all backpack items for a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array<BackpackEntry>}
     */
    getBackpackItems(entityId) {
        return this.backpackInventory.getBackpackItems(entityId);
    }

    /**
     * Get backpack volume capacity and usage for an entity.
     * @param {string} entityId - The entity ID.
     * @param {string} backpackComponentId - The backpack component ID.
     * @returns {{ total: number, used: number, remaining: number }}
     */
    getBackpackVolume(entityId, backpackComponentId) {
        return this.backpackInventory.getBackpackVolume(entityId, backpackComponentId);
    }

    // =========================================================================
    // PUBLIC API: COMBINED OPERATIONS
    // =========================================================================

    /**
     * Release ALL items (hand grabs and backpack) for an entity during despawn.
     * Respawns all items in the world. Registry cleanup is handled by
     * releaseItem() and releaseBackpackItem() internally.
     * Called automatically when an entity is despawned.
     *
     * @param {string} entityId - The entity ID being despawned.
     * @returns {{ droppedItems: Array, releasedHandGrabs: number, releasedBackpackItems: number }}
     */
    releaseEntityGrabs(entityId) {
        const result = {
            droppedItems: [],
            releasedHandGrabs: 0,
            releasedBackpackItems: 0
        };

        // Release all hand grabs → respawn items in world
        // releaseItem() internally handles _grabRegistry cleanup
        const handGrabs = this.handEquipment.getGrabInfoByEntity(entityId);
        result.releasedHandGrabs = handGrabs.length;

        for (const grab of handGrabs) {
            const releaseResult = this.handEquipment.releaseItem(grab.componentId);
            if (releaseResult.success && releaseResult.spawnedEntityId) {
                result.droppedItems.push({
                    type: 'handGrab',
                    itemBlueprint: grab.itemBlueprint,
                    spawnedEntityId: releaseResult.spawnedEntityId
                });
            }
        }

        // Release all backpack items → respawn items in world
        // releaseBackpackItem() internally handles _backpackRegistry cleanup
        const backpackEntries = this.backpackInventory.getBackpackItems(entityId);
        result.releasedBackpackItems = backpackEntries.length;

        for (const entry of backpackEntries) {
            const releaseResult = this.backpackInventory.releaseBackpackItem(entry.componentId);
            if (releaseResult.success && releaseResult.spawnedEntityId) {
                result.droppedItems.push({
                    type: 'backpack',
                    itemBlueprint: entry.itemBlueprint,
                    spawnedEntityId: releaseResult.spawnedEntityId
                });
            }
        }

        Logger.info('[EquipmentController] Entity despawn — released all items', {
            entityId,
            droppedItems: result.droppedItems.length,
            releasedHandGrabs: result.releasedHandGrabs,
            releasedBackpackItems: result.releasedBackpackItems
        });

        return result;
    }

    /**
     * Drop all items from both hand grabs and backpack for an entity.
     * Items are respawned in the world at the entity's position.
     *
     * @param {string} entityId - The entity ID.
     * @returns {{ success: boolean, droppedItems: Array, error?: string }}
     */
    dropAll(entityId) {
        const result = {
            success: false,
            droppedItems: [],
            releasedHandGrabs: 0,
            releasedBackpackItems: 0
        };

        // Step 1: Release all hand grabs
        const handGrabs = this.handEquipment.getGrabInfoByEntity(entityId);
        result.releasedHandGrabs = handGrabs.length;

        for (const grab of handGrabs) {
            const releaseResult = this.handEquipment.releaseItem(grab.componentId);
            if (releaseResult.success && releaseResult.spawnedEntityId) {
                result.droppedItems.push({
                    type: 'handGrab',
                    itemBlueprint: grab.itemBlueprint,
                    spawnedEntityId: releaseResult.spawnedEntityId
                });
            }
        }

        // Step 2: Release all backpack items
        const backpackEntries = this.backpackInventory.getBackpackItems(entityId);
        result.releasedBackpackItems = backpackEntries.length;

        for (const entry of backpackEntries) {
            const releaseResult = this.backpackInventory.releaseBackpackItem(entry.componentId);
            if (releaseResult.success && releaseResult.spawnedEntityId) {
                result.droppedItems.push({
                    type: 'backpack',
                    itemBlueprint: entry.itemBlueprint,
                    spawnedEntityId: releaseResult.spawnedEntityId
                });
            }
        }

        const totalDropped = result.droppedItems.length;
        result.success = totalDropped > 0;

        Logger.info('[EquipmentController] Drop all executed', {
            entityId,
            totalDropped,
            releasedHandGrabs: result.releasedHandGrabs,
            releasedBackpackItems: result.releasedBackpackItems
        });

        return result;
    }
}

/**
 * @typedef {Object} GrabEntry
 * @property {string} handComponentId - The hand component that grabbed the item.
 * @property {string} entityId - The entity that owns the item component.
 * @property {number} originalStrength - The hand's strength before the grab debuff.
 * @property {string} itemBlueprint - The blueprint type of the grabbed item.
 * @property {number} grabbedAt - Unix timestamp when the grab occurred.
 */

/**
 * @typedef {Object} BackpackEntry
 * @property {string} backpackComponentId - The backpack component ID.
 * @property {string} componentId - The item component ID stored in the backpack.
 * @property {string} entityId - The entity that owns the backpack.
 * @property {string} itemBlueprint - The blueprint type of the item.
 * @property {number} itemVolume - Volume consumed by the item.
 * @property {number} grabbedAt - Unix timestamp when the grab occurred.
 */

export default EquipmentController;
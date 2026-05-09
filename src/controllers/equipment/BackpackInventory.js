/**
 * BackpackInventory — Manages backpack storage operations for entities.
 * Single Responsibility: Handle grabbing items into backpacks and managing volume.
 *
 * Extracted from EquipmentController to adhere to the Single Responsibility Principle.
 *
 * @module BackpackInventory
 */

import Logger from '../../utils/Logger.js';
import generateUID from '../../utils/idGenerator.js';
import { DEFAULT_ITEM_VOLUME } from '../../utils/Constants.js';

class BackpackInventory {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     * @param {Map} backpackRegistry - The shared backpack registry Map.
     */
    constructor(worldStateController, backpackRegistry) {
        this.worldStateController = worldStateController;
        this._backpackRegistry = backpackRegistry;
    }

    /**
     * Release a backpack item: remove the item component from the entity and respawn it in the world.
     *
     * @param {string} componentId - The item component ID stored in the backpack.
     * @returns {{ success: boolean, entry?: BackpackEntry, error?: string, spawnedEntityId?: string }} Result of the release.
     */
    releaseBackpackItem(componentId) {
        // Search _backpackRegistry for the entry matching componentId
        for (const [entityId, entries] of this._backpackRegistry) {
            const idx = entries.findIndex((e) => e.componentId === componentId);
            if (idx === -1) continue;

            const entry = entries[idx];
            const { backpackComponentId, itemBlueprint } = entry;

            // Step 1: Remove the component from the entity
            const removed = this.worldStateController.stateEntityController.removeComponentFromEntity(
                entityId, componentId
            );
            if (!removed) {
                Logger.warn('[BackpackInventory] releaseBackpackItem: failed to remove component from entity', {
                    componentId, entityId
                });
                return { success: false, error: `Failed to remove component "${componentId}" from entity "${entityId}".` };
            }

            // Step 2: Remove from backpack registry
            entries.splice(idx, 1);
            this._backpackRegistry.set(entityId, entries);

            // Step 3: Respawn the item as a world entity at the entity's position
            const releasingEntity = this.worldStateController.stateEntityController.getEntity(entityId);
            let spawnedEntityId = null;

            if (releasingEntity) {
                const roomId = releasingEntity.location;
                const spatialOffset = {
                    x: (releasingEntity.spatial?.x || 0) + 5,
                    y: (releasingEntity.spatial?.y || 0) + 5
                };

                spawnedEntityId = this.worldStateController.spawnEntity(itemBlueprint, roomId);

                if (spawnedEntityId) {
                    this.worldStateController.stateEntityController.updateEntitySpatial(spawnedEntityId, spatialOffset);
                    Logger.info('[BackpackInventory] Backpack item respawned in world', {
                        spawnedEntityId,
                        itemBlueprint,
                        roomId,
                        spatial: spatialOffset
                    });
                }
            }

            Logger.info('[BackpackInventory] Backpack item released', {
                componentId,
                entityId,
                itemBlueprint,
                spawnedEntityId
            });

            return {
                success: true,
                entry: { ...entry, componentId },
                componentId,
                spawnedEntityId
            };
        }

        Logger.info('[BackpackInventory] releaseBackpackItem skipped: no backpack entry found', { componentId });
        return { success: false, error: `No backpack entry found for component "${componentId}".` };
    }

    /**
     * Get all backpack items for a specific entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {Array<BackpackEntry>} Array of backpack entries.
     */
    getBackpackItems(entityId) {
        const entries = this._backpackRegistry.get(entityId);
        if (!entries) return [];
        return entries.map((entry, index) => ({
            ...entry,
            index
        }));
    }

    /**
     * Get backpack volume capacity and usage for an entity.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} backpackComponentId - The backpack component ID.
     * @returns {{ total: number, used: number, remaining: number }} Volume info.
     */
    getBackpackVolume(entityId, backpackComponentId) {
        const backpackStats = this.worldStateController.componentController.getComponentStats(backpackComponentId);
        const totalVolume = backpackStats?.Physical?.volume ?? 0;
        const usedVolume = this._getUsedVolume(entityId);
        return {
            total: totalVolume,
            used: usedVolume,
            remaining: totalVolume - usedVolume
        };
    }

    /**
     * Release all backpack entries for a given entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {number} Number of released entries.
     */
    releaseEntityBackpackEntries(entityId) {
        const count = this._backpackRegistry.delete(entityId);
        if (count) {
            Logger.info('[BackpackInventory] Entity backpack entries cleared', { entityId });
        }
        return count ? 1 : 0;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Get the total volume used by backpack items for an entity.
     * @private
     */
    _getUsedVolume(entityId) {
        const entries = this._backpackRegistry.get(entityId);
        if (!entries) return 0;
        return entries.reduce((total, entry) => total + (entry.itemVolume || 0), 0);
    }

    /**
     * Get or create backpack entries array for an entity.
     * @private
     */
    _getOrCreateBackpackEntries(entityId) {
        if (!this._backpackRegistry.has(entityId)) {
            this._backpackRegistry.set(entityId, []);
        }
        return this._backpackRegistry.get(entityId);
    }
}

export default BackpackInventory;
/**
 * BackpackInventory — Manages backpack storage operations for entities.
 * Single Responsibility: Handle grabbing items into backpacks and managing volume.
 *
 * Extracted from EquipmentController to adhere to the Single Responsibility Principle.
 *
 * @module BackpackInventory
 */

import Logger from '../utils/Logger.js';
import generateUID from '../utils/idGenerator.js';
import { DEFAULT_ITEM_VOLUME } from '../utils/Constants.js';

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
     * Grab an item entity and store it in the entity's backpack.
     * The item's traits become available for action requirement checking.
     *
     * @param {string} entityId - The ID of the entity receiving the item.
     * @param {string} backpackComponentId - The backpack component ID.
     * @param {Object} itemEntity - The item entity being grabbed (has id, type, traits).
     * @returns {{ success: boolean, componentId?: string, error?: string }} Result of the grab.
     */
    grabToBackpack(entityId, backpackComponentId, itemEntity) {
        // Validate inputs
        if (!entityId || !backpackComponentId || !itemEntity) {
            const error = 'All parameters (entityId, backpackComponentId, itemEntity) are required.';
            Logger.warn('[BackpackInventory] grabToBackpack failed: missing parameters', {
                entityId, backpackComponentId, itemEntity
            });
            return { success: false, error };
        }

        // Verify the target entity exists
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            const error = `Entity "${entityId}" not found.`;
            Logger.warn('[BackpackInventory] grabToBackpack failed: entity not found', { entityId });
            return { success: false, error };
        }

        // Verify the backpack component exists on the entity
        const backpackComponent = entity.components.find((c) => c.id === backpackComponentId);
        if (!backpackComponent) {
            const error = `Backpack component "${backpackComponentId}" not found on entity "${entityId}".`;
            Logger.warn('[BackpackInventory] grabToBackpack failed: backpack component not found', {
                backpackComponentId, entityId
            });
            return { success: false, error };
        }

        // Check backpack volume capacity
        const backpackStats = this.worldStateController.componentController.getComponentStats(backpackComponentId);
        const backpackVolume = backpackStats?.Physical?.volume ?? 0;
        const usedVolume = this._getUsedVolume(entityId);

        // Get the item's volume (default 1 if not specified)
        const itemType = itemEntity.type || itemEntity.componentType || itemEntity.blueprint || (itemEntity.components?.[0]?.type);
        if (!itemType) {
            const error = 'Item entity must have a "type", "componentType", or "blueprint" property.';
            Logger.warn('[BackpackInventory] grabToBackpack failed: item type missing', { itemEntity });
            return { success: false, error };
        }

        const itemComponentDef = this.worldStateController.componentController.getComponentDefinition(itemType);
        const itemVolume = itemComponentDef?.traits?.Physical?.volume ?? DEFAULT_ITEM_VOLUME;

        if (usedVolume + itemVolume > backpackVolume) {
            const error = `Backpack full: ${usedVolume}/${backpackVolume} volume used, item needs ${itemVolume}.`;
            Logger.warn('[BackpackInventory] grabToBackpack failed: backpack full', {
                entityId, usedVolume, backpackVolume, itemVolume
            });
            return { success: false, error };
        }

        // Generate a unique ID for the new component
        const newComponentId = generateUID();

        // Step 1: Initialize the component from the item blueprint
        try {
            this.worldStateController.componentController.initializeComponent(itemType, newComponentId);
        } catch (error) {
            const errorMsg = `Failed to initialize component "${itemType}" for "${newComponentId}": ${error.message}`;
            Logger.error('[BackpackInventory] grabToBackpack failed: component initialization', {
                itemType, newComponentId, error: error.message
            });
            return { success: false, error: errorMsg };
        }

        // Step 2: Add the component to the entity's component list
        const added = this.worldStateController.stateEntityController.addComponentToEntity(
            entityId, newComponentId, itemType
        );
        if (!added) {
            const error = `Failed to add component "${newComponentId}" to entity "${entityId}".`;
            Logger.warn('[BackpackInventory] grabToBackpack failed: add component to entity', {
                newComponentId, entityId
            });
            return { success: false, error };
        }

        // Step 3: Despawn the item entity (it's now part of the main entity)
        this.worldStateController.stateEntityController.despawnEntity(itemEntity.id);

        // Step 4: Store backpack info for later release
        const backpackEntries = this._getOrCreateBackpackEntries(entityId);
        backpackEntries.push({
            backpackComponentId,
            componentId: newComponentId,
            entityId,
            itemBlueprint: itemType,
            itemVolume,
            grabbedAt: Date.now()
        });
        this._backpackRegistry.set(entityId, backpackEntries);

        Logger.info('[BackpackInventory] Item grabbed to backpack', {
            componentId: newComponentId,
            backpackComponentId,
            entityId,
            itemBlueprint: itemType,
            itemVolume,
            usedVolume: usedVolume + itemVolume,
            backpackVolume
        });

        return { success: true, componentId: newComponentId };
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
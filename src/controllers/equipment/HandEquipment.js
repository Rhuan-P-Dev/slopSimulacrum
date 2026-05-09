/**
 * HandEquipment — Manages hand grab/equip operations for entities.
 * Single Responsibility: Handle grabbing items into hands and releasing them.
 *
 * Extracted from EquipmentController to adhere to the Single Responsibility Principle.
 *
 * @module HandEquipment
 */

import Logger from '../../utils/Logger.js';
import generateUID from '../../utils/idGenerator.js';

class HandEquipment {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     * @param {Map} grabRegistry - The shared grab registry Map.
     */
    constructor(worldStateController, grabRegistry) {
        this.worldStateController = worldStateController;
        this._grabRegistry = grabRegistry;
    }

    /**
     * Grab an item entity and add it as a component to the main entity.
     * The item's traits become available for action requirement checking.
     *
     * @param {string} entityId - The ID of the entity receiving the item.
     * @param {string} handComponentId - The hand component that grabs the item.
     * @param {Object} itemEntity - The item entity being grabbed (has id, type, traits).
     * @returns {{ success: boolean, componentId?: string, error?: string }} Result of the grab.
     */
    grabItem(entityId, handComponentId, itemEntity) {
        // Validate inputs
        if (!entityId || !handComponentId || !itemEntity) {
            const error = 'All parameters (entityId, handComponentId, itemEntity) are required.';
            Logger.warn('[HandEquipment] Grab failed: missing parameters', {
                entityId, handComponentId, itemEntity
            });
            return { success: false, error };
        }

        // Verify the target entity exists
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            const error = `Entity "${entityId}" not found.`;
            Logger.warn('[HandEquipment] Grab failed: entity not found', { entityId });
            return { success: false, error };
        }

        // Verify the hand component exists on the entity
        const handComponent = entity.components.find((c) => c.id === handComponentId);
        if (!handComponent) {
            const error = `Hand component "${handComponentId}" not found on entity "${entityId}".`;
            Logger.warn('[HandEquipment] Grab failed: hand component not found', {
                handComponentId, entityId
            });
            return { success: false, error };
        }

        // Get the item's blueprint type
        const itemType = itemEntity.type || itemEntity.componentType || itemEntity.blueprint || (itemEntity.components?.[0]?.type);
        if (!itemType) {
            const error = 'Item entity must have a "type", "componentType", or "blueprint" property.';
            Logger.warn('[HandEquipment] Grab failed: item type missing', { itemEntity });
            return { success: false, error };
        }

        // Generate a unique ID for the new component
        const newComponentId = generateUID();

        // Step 1: Initialize the component from the item blueprint
        try {
            this.worldStateController.componentController.initializeComponent(itemType, newComponentId);
        } catch (error) {
            const errorMsg = `Failed to initialize component "${itemType}" for "${newComponentId}": ${error.message}`;
            Logger.error('[HandEquipment] Grab failed: component initialization', {
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
            Logger.warn('[HandEquipment] Grab failed: add component to entity', {
                newComponentId, entityId
            });
            return { success: false, error };
        }

        // Step 3: Despawn the item entity (it's now part of the main entity)
        this.worldStateController.stateEntityController.despawnEntity(itemEntity.id);

        // Step 4: Get the original strength of the hand for debuff restoration
        const handStats = this.worldStateController.componentController.getComponentStats(handComponentId);
        const originalStrength = handStats?.Physical?.strength ?? 0;

        // Step 5: Store grab info for later release
        this._grabRegistry.set(newComponentId, {
            handComponentId,
            entityId,
            originalStrength,
            itemBlueprint: itemType,
            grabbedAt: Date.now()
        });

        Logger.info('[HandEquipment] Item grabbed', {
            componentId: newComponentId,
            handComponentId,
            entityId,
            itemBlueprint: itemType,
            originalStrength
        });

        return { success: true, componentId: newComponentId };
    }

    /**
     * Release a grabbed item: remove the item component from the entity.
     * The item is no longer available for actions, and the hand's original
     * strength value can be restored by the consequence handler.
     *
     * @param {string} componentId - The item component ID to remove.
     * @returns {{ success: boolean, grabInfo?: GrabEntry, error?: string, spawnedEntityId?: string }} Result of the release.
     */
    releaseItem(componentId) {
        const grabInfo = this._grabRegistry.get(componentId);
        if (!grabInfo) {
            Logger.info('[HandEquipment] Release skipped: no grab info found', { componentId });
            return { success: false, error: `No grab info found for component "${componentId}".` };
        }

        const { handComponentId, entityId, itemBlueprint } = grabInfo;

        // Step 1: Remove the component from the entity
        const removed = this.worldStateController.stateEntityController.removeComponentFromEntity(
            entityId, componentId
        );
        if (!removed) {
            const error = `Failed to remove component "${componentId}" from entity "${entityId}".`;
            Logger.warn('[HandEquipment] Release failed: remove component from entity', {
                componentId, entityId
            });
            return { success: false, error };
        }

        // Step 2: Clean up grab tracking
        this._grabRegistry.delete(componentId);

        // Step 3: Respawn the item as a world entity at the releasing entity's position
        const releasingEntity = this.worldStateController.stateEntityController.getEntity(entityId);
        let spawnedEntityId = null;

        if (releasingEntity) {
            const roomId = releasingEntity.location;
            const spatialOffset = {
                x: (releasingEntity.spatial?.x || 0) + 5,
                y: (releasingEntity.spatial?.y || 0) + 5
            };

            // Spawn a new entity from the item blueprint
            spawnedEntityId = this.worldStateController.spawnEntity(itemBlueprint, roomId);

            if (spawnedEntityId) {
                // Set spatial coordinates for the spawned item
                this.worldStateController.stateEntityController.updateEntitySpatial(spawnedEntityId, spatialOffset);
                Logger.info('[HandEquipment] Item respawned in world', {
                    spawnedEntityId,
                    itemBlueprint,
                    roomId,
                    spatial: spatialOffset
                });
            }
        }

        Logger.info('[HandEquipment] Item released', {
            componentId,
            handComponentId,
            entityId,
            itemBlueprint,
            spawnedEntityId
        });

        return {
            success: true,
            grabInfo: { ...grabInfo, componentId },
            componentId,
            spawnedEntityId
        };
    }

    /**
     * Get grab tracking info for a specific item component.
     *
     * @param {string} componentId - The item component ID.
     * @returns {GrabEntry|null} The grab entry, or null if not found.
     */
    getGrabInfo(componentId) {
        return this._grabRegistry.get(componentId) || null;
    }

    /**
     * Get all grab entries for a specific entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {Array<GrabEntry>} Array of grab entries for the entity.
     */
    getGrabInfoByEntity(entityId) {
        const result = [];

        for (const [compId, grabInfo] of this._grabRegistry) {
            if (grabInfo.entityId === entityId) {
                result.push({
                    ...grabInfo,
                    componentId: compId
                });
            }
        }

        return result;
    }

    /**
     * Check if a component is currently holding an item.
     *
     * @param {string} componentId - The component ID to check.
     * @returns {boolean} True if the component is holding an item.
     */
    isHoldingItem(componentId) {
        return this._grabRegistry.has(componentId);
    }

    /**
     * Get the number of active grabs.
     *
     * @returns {number}
     */
    getActiveGrabCount() {
        return this._grabRegistry.size;
    }

    /**
     * Release all hand grabs for a given entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {number} Number of released grabs.
     */
    releaseEntityHandGrabs(entityId) {
        let releasedCount = 0;

        for (const [componentId, grabInfo] of this._grabRegistry) {
            if (grabInfo.entityId === entityId) {
                this._grabRegistry.delete(componentId);
                releasedCount++;
            }
        }

        if (releasedCount > 0) {
            Logger.info('[HandEquipment] Entity hand grabs released', {
                entityId,
                releasedCount
            });
        }

        return releasedCount;
    }
}

export default HandEquipment;
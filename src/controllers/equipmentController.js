import Logger from '../utils/Logger.js';
import generateUID from '../utils/idGenerator.js';
import { DEFAULT_ITEM_VOLUME } from '../utils/Constants.js';

/**
 * EquipmentController — Manages grabbing items and adding them as components to entities.
 * When an item is grabbed, it becomes a new component on the entity, unlocking new action
 * capabilities based on the item's traits.
 *
 * Responsibilities (SRP):
 * - Track which components are holding which items
 * - Add item components to entities on grab
 * - Remove item components and return to world on release
 * - Provide grab tracking information for release and debuff restoration
 *
 * Internal state:
 * - _grabRegistry: Map<componentId, GrabEntry> — tracks which item component belongs to which hand
 *
 * @example
 * // Architecture flow:
 * // Client → Server → ActionController.executeAction("grab")
 * //     → ConsequenceHandlers._handleGrabItem()
 * //     → EquipmentController.grabItem()
 * //     → ComponentController.initializeComponent() + StateEntityController.addComponentToEntity()
 */
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
         * @type {Map<string, GrabEntry>}
         * @private
         */
        this._grabRegistry = new Map();

        /**
         * Backpack registry: entityId → Array<BackpackEntry>.
         * Tracks items stored in each entity's backpack.
         * @type {Map<string, Array<BackpackEntry>>}
         * @private
         */
        this._backpackRegistry = new Map();

        Logger.info('[EquipmentController] Initialized');
    }

    // =========================================================================
    // PUBLIC API: GRAB / EQUIP
    // =========================================================================

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
            Logger.warn('[EquipmentController] Grab failed: missing parameters', {
                entityId, handComponentId, itemEntity
            });
            return { success: false, error };
        }

        // Verify the target entity exists
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            const error = `Entity "${entityId}" not found.`;
            Logger.warn('[EquipmentController] Grab failed: entity not found', { entityId });
            return { success: false, error };
        }

        // Verify the hand component exists on the entity
        const handComponent = entity.components.find((c) => c.id === handComponentId);
        if (!handComponent) {
            const error = `Hand component "${handComponentId}" not found on entity "${entityId}".`;
            Logger.warn('[EquipmentController] Grab failed: hand component not found', {
                handComponentId, entityId
            });
            return { success: false, error };
        }

        // Get the item's blueprint type (supports type, componentType, blueprint, or components[0].type)
        const itemType = itemEntity.type || itemEntity.componentType || itemEntity.blueprint || (itemEntity.components?.[0]?.type);
        if (!itemType) {
            const error = 'Item entity must have a "type", "componentType", or "blueprint" property.';
            Logger.warn('[EquipmentController] Grab failed: item type missing', { itemEntity });
            return { success: false, error };
        }

        // Generate a unique ID for the new component
        const newComponentId = generateUID();

        // Step 1: Initialize the component from the item blueprint
        try {
            this.worldStateController.componentController.initializeComponent(itemType, newComponentId);
        } catch (error) {
            const errorMsg = `Failed to initialize component "${itemType}" for "${newComponentId}": ${error.message}`;
            Logger.error('[EquipmentController] Grab failed: component initialization', {
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
            Logger.warn('[EquipmentController] Grab failed: add component to entity', {
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

        Logger.info('[EquipmentController] Item grabbed', {
            componentId: newComponentId,
            handComponentId,
            entityId,
            itemBlueprint: itemType,
            originalStrength
        });

        return { success: true, componentId: newComponentId };
    }

    // =========================================================================
    // PUBLIC API: RELEASE / UNEQUIP
    // =========================================================================

    /**
     * Release a grabbed item: remove the item component from the entity.
     * The item is no longer available for actions, and the hand's original
     * strength value can be restored by the consequence handler.
     *
     * @param {string} componentId - The item component ID to remove.
     * @returns {{ success: boolean, grabInfo?: GrabEntry, error?: string }} Result of the release.
     */
    releaseItem(componentId) {
        const grabInfo = this._grabRegistry.get(componentId);
        if (!grabInfo) {
            Logger.info('[EquipmentController] Release skipped: no grab info found', { componentId });
            return { success: false, error: `No grab info found for component "${componentId}".` };
        }

        const { handComponentId, entityId, itemBlueprint } = grabInfo;

        // Step 1: Remove the component from the entity
        const removed = this.worldStateController.stateEntityController.removeComponentFromEntity(
            entityId, componentId
        );
        if (!removed) {
            const error = `Failed to remove component "${componentId}" from entity "${entityId}".`;
            Logger.warn('[EquipmentController] Release failed: remove component from entity', {
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
                Logger.info('[EquipmentController] Item respawned in world', {
                    spawnedEntityId,
                    itemBlueprint,
                    roomId,
                    spatial: spatialOffset
                });
            }
        }

        Logger.info('[EquipmentController] Item released', {
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

    // =========================================================================
    // PUBLIC API: QUERY
    // =========================================================================

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

        for (const [componentId, grabInfo] of this._grabRegistry) {
            if (grabInfo.entityId === entityId) {
                result.push({
                    ...grabInfo,
                    componentId
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
     * Release all grabs for a given entity.
     * Called when an entity is despawned or removed.
     *
     * @param {string} entityId - The entity ID.
     * @returns {number} Number of released grabs.
     */
    releaseEntityGrabs(entityId) {
        let releasedCount = 0;

        for (const [componentId, grabInfo] of this._grabRegistry) {
            if (grabInfo.entityId === entityId) {
                this._grabRegistry.delete(componentId);
                releasedCount++;
            }
        }

        if (releasedCount > 0) {
            Logger.info('[EquipmentController] Entity grabs released', {
                entityId,
                releasedCount
            });
        }

        return releasedCount;
    }

    // =========================================================================
    // PUBLIC API: BACKPACK (GRAB TO BACKPACK)
    // =========================================================================

    /**
     * Grab an item entity and store it in the entity's backpack.
     * The item's traits become available for action requirement checking.
     * The backpack's Physical.volume determines total storage capacity.
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
            Logger.warn('[EquipmentController] grabToBackpack failed: missing parameters', {
                entityId, backpackComponentId, itemEntity
            });
            return { success: false, error };
        }

        // Verify the target entity exists
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            const error = `Entity "${entityId}" not found.`;
            Logger.warn('[EquipmentController] grabToBackpack failed: entity not found', { entityId });
            return { success: false, error };
        }

        // Verify the backpack component exists on the entity
        const backpackComponent = entity.components.find((c) => c.id === backpackComponentId);
        if (!backpackComponent) {
            const error = `Backpack component "${backpackComponentId}" not found on entity "${entityId}".`;
            Logger.warn('[EquipmentController] grabToBackpack failed: backpack component not found', {
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
            Logger.warn('[EquipmentController] grabToBackpack failed: item type missing', { itemEntity });
            return { success: false, error };
        }

        const itemComponentDef = this.worldStateController.componentController.getComponentDefinition(itemType);
        const itemVolume = itemComponentDef?.traits?.Physical?.volume ?? DEFAULT_ITEM_VOLUME;

        if (usedVolume + itemVolume > backpackVolume) {
            const error = `Backpack full: ${usedVolume}/${backpackVolume} volume used, item needs ${itemVolume}.`;
            Logger.warn('[EquipmentController] grabToBackpack failed: backpack full', {
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
            Logger.error('[EquipmentController] grabToBackpack failed: component initialization', {
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
            Logger.warn('[EquipmentController] grabToBackpack failed: add component to entity', {
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

        Logger.info('[EquipmentController] Item grabbed to backpack', {
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
     * @returns {{ success: boolean, entry?: BackpackEntry, error?: string }} Result of the release.
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
                Logger.warn('[EquipmentController] releaseBackpackItem: failed to remove component from entity', {
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
                    Logger.info('[EquipmentController] Backpack item respawned in world', {
                        spawnedEntityId,
                        itemBlueprint,
                        roomId,
                        spatial: spatialOffset
                    });
                }
            }

            Logger.info('[EquipmentController] Backpack item released', {
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

        Logger.info('[EquipmentController] releaseBackpackItem skipped: no backpack entry found', { componentId });
        return { success: false, error: `No backpack entry found for component "${componentId}".` };
    }

    /**
     * Get the total volume used by backpack items for an entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {number} Total volume used.
     * @private
     */
    _getUsedVolume(entityId) {
        const entries = this._backpackRegistry.get(entityId);
        if (!entries) return 0;
        return entries.reduce((total, entry) => total + (entry.itemVolume || 0), 0);
    }

    /**
     * Get or create backpack entries array for an entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {Array<BackpackEntry>} Backpack entries.
     * @private
     */
    _getOrCreateBackpackEntries(entityId) {
        if (!this._backpackRegistry.has(entityId)) {
            this._backpackRegistry.set(entityId, []);
        }
        return this._backpackRegistry.get(entityId);
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
     * Drop all items from both grab registry and backpack for an entity.
     * Items are respawned in the world at the entity's position.
     *
     * @param {string} entityId - The entity ID.
     * @returns {{ success: boolean, droppedItems: Array, error?: string }} Result.
     */
    dropAll(entityId) {
        const result = {
            success: false,
            droppedItems: [],
            releasedHandGrabs: 0,
            releasedBackpackItems: 0
        };

        // Step 1: Release all hand grabs
        const handGrabs = this.getGrabInfoByEntity(entityId);
        result.releasedHandGrabs = handGrabs.length;

        for (const grab of handGrabs) {
            const releaseResult = this.releaseItem(grab.componentId);
            if (releaseResult.success && releaseResult.spawnedEntityId) {
                result.droppedItems.push({
                    type: 'handGrab',
                    itemBlueprint: grab.itemBlueprint,
                    spawnedEntityId: releaseResult.spawnedEntityId
                });
            }
        }

        // Step 2: Release all backpack items
        const backpackEntries = this._backpackRegistry.get(entityId) || [];
        result.releasedBackpackItems = backpackEntries.length;

        for (const entry of backpackEntries) {
            const releaseResult = this.releaseBackpackItem(entry.componentId);
            if (releaseResult.success && releaseResult.spawnedEntityId) {
                result.droppedItems.push({
                    type: 'backpack',
                    itemBlueprint: entry.itemBlueprint,
                    spawnedEntityId: releaseResult.spawnedEntityId
                });
            }
        }

        // Step 3: Clear backpack tracking (already cleaned up by releaseBackpackItem)
        this._backpackRegistry.delete(entityId);

        // Step 4: Clear hand grab tracking (already done by releaseItem)
        this.releaseEntityGrabs(entityId);

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
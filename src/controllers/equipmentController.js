import Logger from '../utils/Logger.js';
import generateUID from '../utils/idGenerator.js';

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
}

/**
 * @typedef {Object} GrabEntry
 * @property {string} handComponentId - The hand component that grabbed the item.
 * @property {string} entityId - The entity that owns the item component.
 * @property {number} originalStrength - The hand's strength before the grab debuff.
 * @property {string} itemBlueprint - The blueprint type of the grabbed item.
 * @property {number} grabbedAt - Unix timestamp when the grab occurred.
 */

export default EquipmentController;
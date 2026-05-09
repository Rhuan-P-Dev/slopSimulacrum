/**
 * EquipmentConsequenceHandler — Handles equipment grab, release, and drop operations.
 * Single Responsibility: Manage all equipment-related consequence execution (hand grabs, backpack, drop all).
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - 'self'    → The source component (hand/backpack) performing the equipment action.
 * - 'target'  → The explicitly targeted entity/component (item to grab, item to release).
 * - 'entity'  → The entire entity (used for dropAll operations).
 *
 * @module EquipmentConsequenceHandler
 */

import Logger from '../../utils/Logger.js';
import { MIN_STRENGTH_DELTA } from '../../utils/Constants.js';

class EquipmentConsequenceHandler {
    /**
     * @param {Object} controllers - The set of available controllers.
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
    }

    // =========================================================================
    // GRAB / RELEASE ITEM HANDLERS (for equipment system)
    // =========================================================================

    /**
     * Handles grabbing an item entity and adding it as a component to the main entity.
     * The item's traits become available for action requirement checking.
     *
     * @param {string} targetId - The resolved target ID (hand component for 'self'/'target', entity for 'entity').
     * @param {Object} params - Parameters containing debuff configuration.
     * @param {Object} context - Context containing actionParams (entityId, targetEntityId, attackerComponentId).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleGrabItem(targetId, params, context) {
        const actionParams = context?.actionParams || {};
        const entityId = actionParams.entityId;
        const itemEntityId = actionParams.targetEntityId;
        const handComponentId = actionParams.attackerComponentId || targetId;

        // Validate required parameters
        if (!entityId) {
            Logger.warn('[EquipmentConsequenceHandler] Grab failed: missing entityId', { context });
            return { success: false, message: 'Missing entityId in action params', data: null };
        }
        if (!itemEntityId) {
            Logger.warn('[EquipmentConsequenceHandler] Grab failed: missing targetEntityId (item entity)', { context });
            return { success: false, message: 'Missing targetEntityId (item entity ID) in action params', data: null };
        }

        // Get the item entity
        const itemEntity = this.worldStateController.stateEntityController.getEntity(itemEntityId);
        if (!itemEntity) {
            Logger.warn(`[EquipmentConsequenceHandler] Grab failed: item entity "${itemEntityId}" not found`, { itemEntityId });
            return { success: false, message: `Item entity "${itemEntityId}" not found`, data: null };
        }

        // Step 1: Grab the item (add as component to entity)
        const grabResult = this.worldStateController.equipmentController.grabItem(
            entityId,
            handComponentId,
            itemEntity
        );

        if (!grabResult.success) {
            Logger.warn(`[EquipmentConsequenceHandler] Grab failed: ${grabResult.error}`, {
                entityId, handComponentId, itemEntityId
            });
            return { success: false, message: grabResult.error, data: null };
        }

        // Step 2: Apply debuff to the hand (if specified)
        if (params?.debuff) {
            const { trait, stat, value } = params.debuff;
            const debuffSuccess = this.worldStateController.componentController.updateComponentStatDelta(
                handComponentId,
                trait,
                stat,
                value
            );
            if (!debuffSuccess) {
                Logger.warn(`[EquipmentConsequenceHandler] Debuff application failed for hand "${handComponentId}"`, {
                    trait, stat, value
                });
            } else {
                Logger.info(`[EquipmentConsequenceHandler] Debuff applied to hand "${handComponentId}": ${trait}.${stat} ${value}`);
            }
        }

        // Step 3: Re-scan capabilities (new actions may be available from item traits)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
        } catch (error) {
            Logger.error(`[EquipmentConsequenceHandler] Capability re-scan failed for entity "${entityId}": ${error.message}`, {
                entityId, error: error.message
            });
        }

        Logger.info(`[EquipmentConsequenceHandler] Item grabbed successfully by entity "${entityId}"`, {
            componentId: grabResult.componentId,
            handComponentId,
            entityId
        });

        return {
            success: true,
            message: 'Item grabbed and equipped',
            data: {
                componentId: grabResult.componentId,
                handComponentId,
                entityId
            }
        };
    }

    /**
     * Handles releasing a grabbed item: removing it from the entity and restoring the hand.
     * Checks both grab registry (hand grabs) and backpack registry (backpack items).
     *
     * @param {string} targetId - The resolved target ID (hand component or item component ID).
     * @param {Object} params - Parameters (reserved for future configuration).
     * @param {Object} context - Context containing actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleReleaseItem(targetId, params, context) {
        const actionParams = context?.actionParams || {};
        const entityId = actionParams.entityId || '';

        // Step 1: Try to find in grab registry (hand grabs)
        let grabInfo = null;
        const allGrabs = this.worldStateController.equipmentController.getGrabInfoByEntity(entityId);

        // Try to find by targetId matching handComponentId OR item componentId
        for (const g of allGrabs) {
            if (g.handComponentId === targetId || g.componentId === targetId) {
                grabInfo = g;
                break;
            }
        }

        // Step 2: If not found in grab registry, check backpack registry
        if (!grabInfo) {
            const backpackItems = this.worldStateController.equipmentController.getBackpackItems(entityId);
            for (const backpackEntry of backpackItems) {
                if (backpackEntry.componentId === targetId || backpackEntry.backpackComponentId === targetId) {
                    grabInfo = backpackEntry;
                    break;
                }
            }
        }

        if (!grabInfo) {
            Logger.info(`[EquipmentConsequenceHandler] Release failed: no item equipped for target "${targetId}"`, {
                targetId
            });
            return { success: false, message: 'No item equipped for this target', data: null };
        }

        // Step 3: Determine release method and componentId
        const isBackpackItem = 'backpackComponentId' in grabInfo;
        const itemComponentId = grabInfo.componentId || targetId;

        let releaseResult;
        if (isBackpackItem) {
            // Release from backpack
            releaseResult = this.worldStateController.equipmentController.releaseBackpackItem(itemComponentId);
        } else {
            // Release from hand grab
            releaseResult = this.worldStateController.equipmentController.releaseItem(itemComponentId);
        }

        if (!releaseResult.success) {
            Logger.warn(`[EquipmentConsequenceHandler] Release failed: ${releaseResult.error}`, {
                targetId
            });
            return { success: false, message: releaseResult.error, data: null };
        }

        // Step 4: Restore hand strength (only for hand grabs, not backpack)
        if (!isBackpackItem && releaseResult.grabInfo) {
            const { handComponentId: restoredHandId, originalStrength } = releaseResult.grabInfo;
            if (originalStrength !== undefined) {
                const currentStats = this.worldStateController.componentController.getComponentStats(restoredHandId);
                const currentStrength = currentStats?.Physical?.strength ?? 0;
                const delta = originalStrength - currentStrength;
                if (delta !== MIN_STRENGTH_DELTA) {
                    this.worldStateController.componentController.updateComponentStatDelta(
                        restoredHandId,
                        'Physical',
                        'strength',
                        delta
                    );
                    Logger.info(`[EquipmentConsequenceHandler] Hand strength restored: ${currentStrength} → ${originalStrength}`);
                }
            }
        }

        // Step 5: Re-scan capabilities (item traits no longer available)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, releaseResult.grabInfo?.entityId || releaseResult.entry?.entityId || entityId);
        } catch (error) {
            Logger.error(`[EquipmentConsequenceHandler] Capability re-scan failed after release: ${error.message}`, {
                error: error.message
            });
        }

        Logger.info(`[EquipmentConsequenceHandler] Item released from target "${targetId}"`);

        return {
            success: true,
            message: 'Item released',
            data: {
                targetId,
                entityId: releaseResult.grabInfo?.entityId || releaseResult.entry?.entityId
            }
        };
    }

    // =========================================================================
    // BACKPACK HANDLERS (grab to backpack, drop all)
    // =========================================================================

    /**
     * Handles grabbing an item entity and storing it in the entity's backpack.
     * The item's traits become available for action requirement checking.
     * The backpack's Physical.volume determines total storage capacity.
     *
     * @param {string} targetId - The resolved target ID (backpack component for 'self', item for 'target').
     * @param {Object} params - Parameters (reserved for future configuration).
     * @param {Object} context - Context containing actionParams (entityId, targetEntityId, targetComponentId).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleGrabToBackpack(targetId, params, context) {
        const actionParams = context?.actionParams || {};
        const entityId = actionParams.entityId;
        const itemEntityId = actionParams.targetEntityId;
        const backpackComponentId = actionParams.targetComponentId || targetId;

        // Validate required parameters
        if (!entityId) {
            Logger.warn('[EquipmentConsequenceHandler] grabToBackpack failed: missing entityId', { context });
            return { success: false, message: 'Missing entityId in action params', data: null };
        }
        if (!itemEntityId) {
            Logger.warn('[EquipmentConsequenceHandler] grabToBackpack failed: missing targetEntityId (item entity)', { context });
            return { success: false, message: 'Missing targetEntityId (item entity ID) in action params', data: null };
        }

        // Get the item entity
        const itemEntity = this.worldStateController.stateEntityController.getEntity(itemEntityId);
        if (!itemEntity) {
            Logger.warn(`[EquipmentConsequenceHandler] grabToBackpack failed: item entity "${itemEntityId}" not found`, { itemEntityId });
            return { success: false, message: `Item entity "${itemEntityId}" not found`, data: null };
        }

        // Step 1: Grab the item into backpack
        const grabResult = this.worldStateController.equipmentController.grabToBackpack(
            entityId,
            backpackComponentId,
            itemEntity
        );

        if (!grabResult.success) {
            Logger.warn(`[EquipmentConsequenceHandler] grabToBackpack failed: ${grabResult.error}`, {
                entityId, backpackComponentId, itemEntityId
            });
            return { success: false, message: grabResult.error, data: null };
        }

        // Step 2: Re-scan capabilities (new actions may be available from item traits)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
        } catch (error) {
            Logger.error(`[EquipmentConsequenceHandler] Capability re-scan failed for entity "${entityId}": ${error.message}`, {
                entityId, error: error.message
            });
        }

        Logger.info(`[EquipmentConsequenceHandler] Item grabbed to backpack successfully by entity "${entityId}"`, {
            componentId: grabResult.componentId,
            backpackComponentId,
            entityId
        });

        return {
            success: true,
            message: 'Item stored in backpack',
            data: {
                componentId: grabResult.componentId,
                backpackComponentId,
                entityId
            }
        };
    }

    /**
     * Handles dropping all items from both hand grabs and backpack for an entity.
     * Items are respawned in the world at the entity's position.
     *
     * @param {string} targetId - The resolved target ID (entity ID for 'entity' target type).
     * @param {Object} params - Parameters (reserved for future configuration).
     * @param {Object} context - Context containing actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDropAll(targetId, params, context) {
        const actionParams = context?.actionParams || {};
        const entityId = actionParams.entityId || targetId;

        // Validate required parameters
        if (!entityId) {
            Logger.warn('[EquipmentConsequenceHandler] dropAll failed: missing entityId', { context });
            return { success: false, message: 'Missing entityId in action params', data: null };
        }

        // Step 1: Drop all items (hand grabs + backpack)
        const dropResult = this.worldStateController.equipmentController.dropAll(entityId);

        if (!dropResult.success) {
            Logger.info(`[EquipmentConsequenceHandler] dropAll failed: nothing to drop for entity "${entityId}"`, { entityId });
            return { success: false, message: 'Nothing to drop', data: null };
        }

        // Step 2: Re-scan capabilities (item traits no longer available)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
        } catch (error) {
            Logger.error(`[EquipmentConsequenceHandler] Capability re-scan failed after dropAll: ${error.message}`, {
                entityId, error: error.message
            });
        }

        Logger.info(`[EquipmentConsequenceHandler] All items dropped by entity "${entityId}"`, {
            entityId,
            totalDropped: dropResult.droppedItems.length,
            releasedHandGrabs: dropResult.releasedHandGrabs,
            releasedBackpackItems: dropResult.releasedBackpackItems
        });

        return {
            success: true,
            message: 'All items dropped',
            data: {
                entityId,
                droppedItems: dropResult.droppedItems,
                releasedHandGrabs: dropResult.releasedHandGrabs,
                releasedBackpackItems: dropResult.releasedBackpackItems
            }
        };
    }
}

export default EquipmentConsequenceHandler;
import Logger from '../utils/Logger.js';
import { MIN_MOVEMENT_DISTANCE, MIN_STRENGTH_DELTA } from '../utils/Constants.js';

/**
 * ConsequenceHandlers provides a set of strategy functions to execute
 * game consequences. This decouples the execution logic from the ActionController.
 */
class ConsequenceHandlers {
    /**
     * @param {Object} controllers - The set of available controllers (WorldStateController, etc.)
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
    }

    /**
     * Map of handler functions. 
     * All handlers now follow a normalized signature: (targetId, params, context)
     * @returns {Object} Map of handler functions.
     */
    get handlers() {
        return {
            updateSpatial: (targetId, params, context) => this._handleUpdateSpatial(targetId, params, context),
            deltaSpatial: (targetId, params, context) => this._handleDeltaSpatial(targetId, params, context),
            log: (targetId, params, context) => this._handleLog(targetId, params, context),
            updateStat: (targetId, params, context) => this._handleUpdateStat(targetId, params, context),
            updateComponentStatDelta: (targetId, params, context) => this._handleUpdateComponentStatDelta(targetId, params, context),
            triggerEvent: (targetId, params, context) => this._handleTriggerEvent(targetId, params, context),
            damageComponent: (targetId, params, context) => this._handleDamageComponent(targetId, params, context),
            grabItem: (targetId, params, context) => this._handleGrabItem(targetId, params, context),
            releaseItem: (targetId, params, context) => this._handleReleaseItem(targetId, params, context),
            grabToBackpack: (targetId, params, context) => this._handleGrabToBackpack(targetId, params, context),
            dropAll: (targetId, params, context) => this._handleDropAll(targetId, params, context),
        };
    }

    /**
     * Handles spatial coordinate updates for an entity.
     * @param {string} entityId - The entity ID to update.
     * @param {Object} spatialUpdate - Object with x and/or y values.
     * @param {Object} context - Context containing action parameters.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateSpatial(entityId, spatialUpdate, context) {
        const success = this.worldStateController.stateEntityController.updateEntitySpatial(entityId, spatialUpdate);
        if (success) {
            const updatedEntity = this.worldStateController.stateEntityController.getEntity(entityId);
            return { 
                success: true, 
                message: "Spatial coordinates updated", 
                data: { spatialUpdate, newSpatial: updatedEntity?.spatial } 
            };
        }
        return { success: false, message: "Failed to update spatial coordinates", data: null };
    }

    /**
     * @param {string} entityId
     * @param {Object} deltaUpdate
     * @param {Object} context - Context containing actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDeltaSpatial(entityId, deltaUpdate, context) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return { success: false, message: `Entity "${entityId}" not found`, data: null };
        if (!entity.spatial) return { success: false, message: `Entity "${entityId}" has no spatial data`, data: null };

        const speed = (typeof deltaUpdate.speed === 'number') ? deltaUpdate.speed : 0;
        let moveX = deltaUpdate.x || 0;
        let moveY = deltaUpdate.y || 0;

        const actionParams = context?.actionParams;
        if (actionParams && actionParams.targetX !== undefined && actionParams.targetY !== undefined) {
            const dx = actionParams.targetX - entity.spatial.x;
            const dy = actionParams.targetY - entity.spatial.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > MIN_MOVEMENT_DISTANCE) {
                moveX = (dx / distance) * speed;
                moveY = (dy / distance) * speed;
            } else {
                moveX = 0;
                moveY = 0;
            }
        }

        const success = this.worldStateController.stateEntityController.updateEntitySpatial(
            entityId,
            { x: entity.spatial.x + moveX, y: entity.spatial.y + moveY }
        );

        return success 
            ? { 
                success: true, 
                message: "Entity moved", 
                data: { deltaUpdate: { x: moveX, y: moveY }, newSpatial: this.worldStateController.stateEntityController.getEntity(entityId)?.spatial } 
              } 
            : { success: false, message: "Failed to update spatial coordinates", data: null };
    }

    /**
     * Handles a log consequence, writing a message to the server log.
     * @param {string} targetId - The entity/component ID associated with the log entry.
     * @param {Object} params - Parameters containing message and log level.
     * @param {Object} context - Context containing action parameters.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleLog(targetId, params, context) {
        if (!params) return { success: true, message: "Logged empty action", data: { level: "info" } };
        const { message = "No message provided", level = "info" } = params;
        
        const logMethod = Logger[level.toLowerCase()] || Logger.info;
        logMethod(`[Action:${targetId}] ${message}`);
        
        return { success: true, message: `Logged: ${message}`, data: { level, targetId } };
    }

    /**
     * Updates a stat delta on the appropriate component.
     * Resolution priority:
     *   1. Explicit targetComponentId from actionParams (for targeted actions like damage)
     *   2. Component that fulfilled the specific trait.stat requirement (for self-targeted actions)
     *   3. Entity-wide stat update via _handleUpdateStat (when no component context is available)
     * 
     * @param {string} targetId - Entity ID or Component ID.
     * @param {Object} deltaParams - Parameters containing trait, stat, and value.
     * @param {Object} context - Context containing fulfillingComponents and actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateComponentStatDelta(targetId, deltaParams, context) {
        let componentId = null;
        const { trait, stat, value } = deltaParams;

        // Priority 1: Explicit targetComponentId from actionParams (e.g., damageComponent targeting an enemy)
        if (context?.actionParams?.targetComponentId) {
            componentId = context.actionParams.targetComponentId;
        } 
        // Priority 2: Component that fulfilled the specific trait.stat requirement (e.g., selfHeal uses the component with durability)
        else if (context?.fulfillingComponents) {
            const key = `${trait}.${stat}`;
            componentId = context.fulfillingComponents[key] || null;
        }

        // If no component was resolved, the action definition should use updateStat (entity-wide) instead.
        // This prevents accidentally updating the wrong component on multi-component entities.
        if (!componentId) {
            return { 
                success: false, 
                message: `No component resolved for ${trait}.${stat} update. Use updateStat for entity-wide updates or provide targetComponentId for component-specific updates.`, 
                data: null 
            };
        }

        // Validate that the resolved componentId is actually a component (has stats)
        if (!this.worldStateController.componentController.getComponentStats(componentId)) {
            Logger.warn(`[ConsequenceHandlers] Resolved componentId "${componentId}" has no stats. Falling back to entity-wide update.`);
            // Fallback: perform entity-wide update as a safety net
            return this._handleUpdateStat(targetId, deltaParams, context);
        }

        const success = this.worldStateController.componentController.updateComponentStatDelta(componentId, trait, stat, value);
        return { 
            success, 
            message: success ? `Updated ${componentId} ${trait}.${stat} by ${value}` : `Failed to update ${componentId}`, 
            data: success ? { componentId, trait, stat, value } : null 
        };
    }

    /**
     * Handles bulk stat updates across all components on an entity.
     * @param {string} entityId - The entity ID whose components will be updated.
     * @param {Object} updateParams - Object containing trait, stat, and value.
     * @param {Object} context - Context containing action parameters.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleUpdateStat(entityId, updateParams, context) {
        const { trait, stat, value } = updateParams;
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return { success: false, message: `Entity "${entityId}" not found`, data: null };

        let updatedCount = 0;
        for (const component of entity.components) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (stats && stats[trait]) {
                this.worldStateController.componentController.updateComponentStat(component.id, trait, stat, value);
                updatedCount++;
            }
        }
        return { success: true, message: `Updated ${updatedCount} component(s) with ${trait}.${stat} = ${value}`, data: { updatedCount } };
    }

    /**
     * @param {string} entityId
     * @param {Object} resolvedParams
     * @param {Object} context - Context containing actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDamageComponent(entityId, resolvedParams, context) {
        const { trait, stat, value } = resolvedParams;
        const targetComponentId = context?.actionParams?.targetComponentId;
        if (!targetComponentId) return { success: false, message: "No target component specified", data: null };
        const success = this.worldStateController.componentController.updateComponentStatDelta(targetComponentId, trait, stat, value);
        return { 
            success, 
            message: success ? `Dealt ${Math.abs(value)} damage to ${targetComponentId}` : `Failed to damage ${targetComponentId}`, 
            data: success ? { targetComponentId, trait, stat, value } : null 
        };
    }

    /**
     * Handles event triggering for logging/notification purposes.
     * @param {string} entityId - The entity ID associated with the event.
     * @param {Object} eventParams - Object containing eventType and optional data.
     * @param {Object} context - Context containing action parameters.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleTriggerEvent(entityId, eventParams, context) {
        const { eventType, data } = eventParams;
        Logger.info(`Event triggered: ${eventType} for entity ${entityId}`, data || {});
        return { success: true, message: `Event "${eventType}" triggered`, data: { eventType, entityId } };
    }

    // =========================================================================
    // GRAB / RELEASE ITEM HANDLERS (for equipment system)
    // =========================================================================

    /**
     * Handles grabbing an item entity and adding it as a component to the main entity.
     * The item's traits become available for action requirement checking.
     *
     * @param {string} targetId - The hand component ID (source of the grab).
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
            Logger.warn('[ConsequenceHandlers] Grab failed: missing entityId', { context });
            return { success: false, message: 'Missing entityId in action params', data: null };
        }
        if (!itemEntityId) {
            Logger.warn('[ConsequenceHandlers] Grab failed: missing targetEntityId (item entity)', { context });
            return { success: false, message: 'Missing targetEntityId (item entity ID) in action params', data: null };
        }

        // Get the item entity
        const itemEntity = this.worldStateController.stateEntityController.getEntity(itemEntityId);
        if (!itemEntity) {
            Logger.warn(`[ConsequenceHandlers] Grab failed: item entity "${itemEntityId}" not found`, { itemEntityId });
            return { success: false, message: `Item entity "${itemEntityId}" not found`, data: null };
        }

        // Step 1: Grab the item (add as component to entity)
        const grabResult = this.worldStateController.equipmentController.grabItem(
            entityId,
            handComponentId,
            itemEntity
        );

        if (!grabResult.success) {
            Logger.warn(`[ConsequenceHandlers] Grab failed: ${grabResult.error}`, {
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
                Logger.warn(`[ConsequenceHandlers] Debuff application failed for hand "${handComponentId}"`, {
                    trait, stat, value
                });
            } else {
                Logger.info(`[ConsequenceHandlers] Debuff applied to hand "${handComponentId}": ${trait}.${stat} ${value}`);
            }
        }

        // Step 3: Re-scan capabilities (new actions may be available from item traits)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
        } catch (error) {
            Logger.error(`[ConsequenceHandlers] Capability re-scan failed for entity "${entityId}": ${error.message}`, {
                entityId, error: error.message
            });
        }

        Logger.info(`[ConsequenceHandlers] Item grabbed successfully by entity "${entityId}"`, {
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
     * @param {string} targetId - The hand component ID or item component ID.
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
            Logger.info(`[ConsequenceHandlers] Release failed: no item equipped for target "${targetId}"`, {
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
            Logger.warn(`[ConsequenceHandlers] Release failed: ${releaseResult.error}`, {
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
                    Logger.info(`[ConsequenceHandlers] Hand strength restored: ${currentStrength} → ${originalStrength}`);
                }
            }
        }

        // Step 5: Re-scan capabilities (item traits no longer available)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, releaseResult.grabInfo?.entityId || releaseResult.entry?.entityId || entityId);
        } catch (error) {
            Logger.error(`[ConsequenceHandlers] Capability re-scan failed after release: ${error.message}`, {
                error: error.message
            });
        }

        Logger.info(`[ConsequenceHandlers] Item released from target "${targetId}"`);

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
     * @param {string} targetId - The backpack component ID.
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
            Logger.warn('[ConsequenceHandlers] grabToBackpack failed: missing entityId', { context });
            return { success: false, message: 'Missing entityId in action params', data: null };
        }
        if (!itemEntityId) {
            Logger.warn('[ConsequenceHandlers] grabToBackpack failed: missing targetEntityId (item entity)', { context });
            return { success: false, message: 'Missing targetEntityId (item entity ID) in action params', data: null };
        }

        // Get the item entity
        const itemEntity = this.worldStateController.stateEntityController.getEntity(itemEntityId);
        if (!itemEntity) {
            Logger.warn(`[ConsequenceHandlers] grabToBackpack failed: item entity "${itemEntityId}" not found`, { itemEntityId });
            return { success: false, message: `Item entity "${itemEntityId}" not found`, data: null };
        }

        // Step 1: Grab the item into backpack
        const grabResult = this.worldStateController.equipmentController.grabToBackpack(
            entityId,
            backpackComponentId,
            itemEntity
        );

        if (!grabResult.success) {
            Logger.warn(`[ConsequenceHandlers] grabToBackpack failed: ${grabResult.error}`, {
                entityId, backpackComponentId, itemEntityId
            });
            return { success: false, message: grabResult.error, data: null };
        }

        // Step 2: Re-scan capabilities (new actions may be available from item traits)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
        } catch (error) {
            Logger.error(`[ConsequenceHandlers] Capability re-scan failed for entity "${entityId}": ${error.message}`, {
                entityId, error: error.message
            });
        }

        Logger.info(`[ConsequenceHandlers] Item grabbed to backpack successfully by entity "${entityId}"`, {
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
     * @param {string} targetId - The component/entity ID associated with the drop.
     * @param {Object} params - Parameters (reserved for future configuration).
     * @param {Object} context - Context containing actionParams.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDropAll(targetId, params, context) {
        const actionParams = context?.actionParams || {};
        const entityId = actionParams.entityId;

        // Validate required parameters
        if (!entityId) {
            Logger.warn('[ConsequenceHandlers] dropAll failed: missing entityId', { context });
            return { success: false, message: 'Missing entityId in action params', data: null };
        }

        // Step 1: Drop all items (hand grabs + backpack)
        const dropResult = this.worldStateController.equipmentController.dropAll(entityId);

        if (!dropResult.success) {
            Logger.info(`[ConsequenceHandlers] dropAll failed: nothing to drop for entity "${entityId}"`, { entityId });
            return { success: false, message: 'Nothing to drop', data: null };
        }

        // Step 2: Re-scan capabilities (item traits no longer available)
        try {
            const state = this.worldStateController.getAll();
            this.worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
        } catch (error) {
            Logger.error(`[ConsequenceHandlers] Capability re-scan failed after dropAll: ${error.message}`, {
                entityId, error: error.message
            });
        }

        Logger.info(`[ConsequenceHandlers] All items dropped by entity "${entityId}"`, {
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

export default ConsequenceHandlers;

import { AppConfig } from './Config.js';

/**
 * ActionExecutor
 * A single-responsibility class for all action execution handlers.
 * Uses Dependency Injection to accept dependencies via constructor.
 *
 * All cross-module communication uses public API methods — no direct
 * internal property access (BUG-031 prevention).
 */
export class ActionExecutor {
    /**
     * @param {Object} worldState - World state manager instance.
     * @param {Object} actions - ActionManager instance.
     * @param {Object} ui - UIManager instance.
     * @param {Object} errorController - ClientErrorController instance.
     * @param {Function} refreshCallback - Callback to refresh world state and actions.
     * @param {Object} selectionController - SelectionController instance (for selectedComponentIds).
     * @param {Object} availableActions - Available actions cache from App.js.
     */
    constructor(worldState, actions, ui, errorController, refreshCallback, selectionController, availableActions) {
        /** @type {Object} World state manager instance. */
        this.worldState = worldState;
        /** @type {Object} Action manager instance. */
        this.actions = actions;
        /** @type {Object} UI manager instance. */
        this.ui = ui;
        /** @type {Object} Error controller instance. */
        this.errorController = errorController;
        /** @type {Function} Callback to refresh world state and actions. */
        this.refreshCallback = refreshCallback;
        /** @type {Object} Selection controller instance (for selected component IDs). */
        this.selectionController = selectionController;
        /** @type {Object} Available actions cache from App.js. */
        this.availableActions = availableActions || {};
    }

    /**
     * Executes a self-targeting action (e.g., selfHeal, dropAll).
     * For dropAll: calls actions.executeDropAll() with entity-level params.
     * For others: uses _sendActionRequest with targetComponentId.
     *
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The entity ID performing the action.
     * @param {string} componentId - The component ID to use.
     * @param {string} componentIdentifier - The component identifier.
     * @returns {Promise<void>}
     */
    async executeSelfTarget(actionName, entityId, componentId, componentIdentifier) {
        try {
            if (actionName === 'dropAll') {
                const result = await this.actions.executeDropAll(actionName, entityId);
                console.log(`[ActionExecutor] Drop all executed for entity ${entityId}`, { actionName, entityId });
                return;
            }

            const result = await this.actions._sendActionRequest({
                actionName,
                entityId,
                params: { targetComponentId: componentId, componentIdentifier }
            }, 'ACTION_FAILED');

            console.log(`[ActionExecutor] Self-target action "${actionName}" executed successfully`, { actionName, entityId, componentId });
        } catch (error) {
            console.error(`[ActionExecutor] Self-target action "${actionName}" failed: ${error.message}`, { actionName, entityId, componentId, error: error.message });
        }
    }

    /**
     * Executes a spatial action with multiple components.
     * Clears pending action and selections, builds components array,
     * calls actions.selectComponents() then actions.executeWithComponents().
     *
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The entity ID performing the action.
     * @param {string[]} componentIds - Array of component IDs to use.
     * @param {Object} extraParams - Additional parameters (e.g., targetX, targetY).
     * @returns {Promise<void>}
     */
    async executeMultiComponentSpatial(actionName, entityId, componentIds, extraParams) {
        try {
            const components = componentIds.map(compId => ({
                componentId: compId,
                role: 'source'
            }));

            await this.actions.selectComponents(actionName, entityId, components);

            await this.actions.executeWithComponents(
                actionName, entityId, components, extraParams
            );

            await this.refreshCallback();

            console.log(`[ActionExecutor] Multi-component spatial action "${actionName}" executed successfully`, { actionName, entityId, componentCount: componentIds.length });
        } catch (error) {
            console.error(`[ActionExecutor] Multi-component spatial action "${actionName}" failed: ${error.message}`, { actionName, entityId, componentIds, error: error.message });
        }
    }

    /**
     * Executes a grab action.
     * Performs distance check against action range, finds closest entity,
     * grabs via actions.executeGrab(), then clears pending + selections and refreshes.
     *
     * @param {Object} pending - The pending action object.
     * @param {number} targetX - The target X coordinate.
     * @param {number} targetY - The target Y coordinate.
     * @returns {Promise<void>}
     */
     async executeGrab(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) {
            console.warn('[ActionExecutor] No active droid or state for grab action');
            return;
        }

        // Use availableActions cache passed from App.js (BUG-031 prevention)
        const actionData = this.availableActions[pending.actionName] || {};
        const range = actionData?.range || 100;

        const distance = this.actions.calculateDistance(targetX, targetY, droid.spatial.x, droid.spatial.y);

        if (distance > range) {
            this.errorController.handleError({
                code: 'TARGET_OUT_OF_RANGE',
                details: {
                    distance: Math.round(distance),
                    range: range
                }
            });
            this.actions.clearPendingAction();
            console.warn(`[ActionExecutor] Grab out of range: distance=${Math.round(distance)}, range=${range}`);
            return;
        }

        const closestEntity = this.actions.findClosestEntity(
            state.entities,
            targetX,
            targetY,
            AppConfig.TARGETING.PUNCH_TOLERANCE
        );

        if (!closestEntity) {
            this.errorController.handleError({ code: 'NO_TARGET_FOUND' });
            this.actions.clearPendingAction();
            console.warn('[ActionExecutor] No target found for grab action');
            return;
        }

        try {
            // Use selectionController public API instead of direct property access
            const selectedIds = this.selectionController ? this.selectionController.getSelectedComponentIdsArray() : [];
            const handCompId = selectedIds[0] || pending.componentId;
            await this.actions.executeGrab(pending.actionName, pending.entityId, handCompId, closestEntity.id);

            this.actions.clearPendingAction();
            await this.refreshCallback();

            console.log(`[ActionExecutor] Grab executed: entity ${closestEntity.id} grabbed by entity ${pending.entityId}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity.id, handComponentId: handCompId });
        } catch (error) {
            console.error(`[ActionExecutor] Grab failed: ${error.message}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity?.id, error: error.message });
        }
    }

    /**
     * Executes a grab-to-backpack action.
     * Same as grab + checks for droidBackpack component on the droid.
     *
     * @param {Object} pending - The pending action object.
     * @param {number} targetX - The target X coordinate.
     * @param {number} targetY - The target Y coordinate.
     * @returns {Promise<void>}
     */
     async executeGrabToBackpack(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) {
            console.warn('[ActionExecutor] No active droid or state for grab-to-backpack action');
            return;
        }

        // Use availableActions cache passed from App.js (BUG-031 prevention)
        const actionData = this.availableActions[pending.actionName] || {};
        const range = actionData?.range || 100;

        const distance = this.actions.calculateDistance(targetX, targetY, droid.spatial.x, droid.spatial.y);

        if (distance > range) {
            this.errorController.handleError({
                code: 'TARGET_OUT_OF_RANGE',
                details: {
                    distance: Math.round(distance),
                    range: range
                }
            });
            this.actions.clearPendingAction();
            console.warn(`[ActionExecutor] Grab-to-backpack out of range: distance=${Math.round(distance)}, range=${range}`);
            return;
        }

        const closestEntity = this.actions.findClosestEntity(
            state.entities,
            targetX,
            targetY,
            AppConfig.TARGETING.PUNCH_TOLERANCE
        );

        if (!closestEntity) {
            this.errorController.handleError({ code: 'NO_TARGET_FOUND' });
            this.actions.clearPendingAction();
            console.warn('[ActionExecutor] No target found for grab-to-backpack action');
            return;
        }

        try {
            const backpackComp = droid.components.find(c => c.type === 'droidBackpack');
            if (!backpackComp) {
                this.errorController.handleError({
                    code: 'BACKPACK_NOT_FOUND',
                    message: 'No backpack component found on this entity.'
                });
                this.actions.clearPendingAction();
                console.warn('[ActionExecutor] No backpack component found on droid');
                return;
            }

            await this.actions.executeGrabToBackpack(pending.actionName, pending.entityId, backpackComp.id, closestEntity.id);

            this.actions.clearPendingAction();
            await this.refreshCallback();

            console.log(`[ActionExecutor] Grab-to-backpack executed: entity ${closestEntity.id} stored in backpack of entity ${pending.entityId}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity.id, backpackComponentId: backpackComp.id });
        } catch (error) {
            console.error(`[ActionExecutor] Grab-to-backpack failed: ${error.message}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity?.id, error: error.message });
        }
    }

    /**
     * Executes a punch action.
     * Performs distance check, finds closest entity, shows component selection,
     * supports multi-attacker via executeMultiPunch or executePunch.
     *
     * @param {Object} pending - The pending action object.
     * @param {number} targetX - The target X coordinate.
     * @param {number} targetY - The target Y coordinate.
     * @param {Set<string>} selectedComponentIds - Set of selected attacker component IDs.
     * @returns {Promise<void>}
     */
     async executePunch(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) {
            console.warn('[ActionExecutor] No active droid or state for punch action');
            return;
        }

        // Use availableActions cache passed from App.js (BUG-031 prevention)
        const actionData = this.availableActions[pending.actionName] || {};
        const range = actionData?.range || 0;

        const distance = this.actions.calculateDistance(targetX, targetY, droid.spatial.x, droid.spatial.y);

        if (distance > range) {
            this.errorController.handleError({
                code: 'TARGET_OUT_OF_RANGE',
                details: {
                    distance: Math.round(distance),
                    range: range
                }
            });
            console.warn(`[ActionExecutor] Punch out of range: distance=${Math.round(distance)}, range=${range}`);
            return;
        }

        const closestEntity = this.actions.findClosestEntity(
            state.entities,
            targetX,
            targetY,
            AppConfig.TARGETING.PUNCH_TOLERANCE
        );

        if (!closestEntity) {
            this.errorController.handleError({ code: 'NO_TARGET_FOUND' });
            console.warn('[ActionExecutor] No target found for punch action');
            return;
        }

        try {
            this.ui.showComponentSelection(closestEntity, state, async (targetCompId) => {
                try {
                    // Use selectionController public API instead of passed parameter
                    const selectedComponentIds = this.selectionController ? this.selectionController.getSelectedComponentIds() : new Set();
                    const attackerComponentIds = Array.from(selectedComponentIds);

                    if (attackerComponentIds.length > 1) {
                        const components = attackerComponentIds.map(compId => ({
                            componentId: compId,
                            role: 'source'
                        }));
                        await this.actions.executeMultiPunch(
                            pending.actionName,
                            pending.entityId,
                            components,
                            targetCompId
                        );
                        console.log(`[ActionExecutor] Multi-attacker punch executed: ${attackerComponentIds.length} attackers vs target component ${targetCompId}`, { actionName: pending.actionName, entityId: pending.entityId, attackerCount: attackerComponentIds.length, targetComponentId: targetCompId });
                    } else {
                        const attackerCompId = attackerComponentIds[0] || pending.componentId;
                        await this.actions.executePunch(pending.actionName, pending.entityId, attackerCompId, targetCompId);
                        console.log(`[ActionExecutor] Single attacker punch executed: attacker component ${attackerCompId} vs target component ${targetCompId}`, { actionName: pending.actionName, entityId: pending.entityId, attackerComponentId: attackerCompId, targetComponentId: targetCompId });
                    }

                    this.ui.closeDetails();
                    this.actions.clearPendingAction();
                    await this.refreshCallback();
                } catch (error) {
                    console.error(`[ActionExecutor] Punch action failed: ${error.message}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity.id, error: error.message });
                }
            });
        } catch (error) {
            console.error(`[ActionExecutor] Punch component selection failed: ${error.message}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity.id, error: error.message });
        }
    }

    /**
     * Executes a move droid action.
     * Sends HTTP POST to AppConfig.ENDPOINTS.MOVE_ENTITY, handles errors.
     *
     * @param {string} entityId - The entity ID to move.
     * @param {string} targetRoomId - The target room ID.
     * @returns {Promise<void>}
     */
    async executeMoveDroid(entityId, targetRoomId) {
        try {
            const response = await fetch(AppConfig.ENDPOINTS.MOVE_ENTITY, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityId, targetRoomId })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to move droid');
            }

            await this.refreshCallback();
            console.log(`[ActionExecutor] Droid moved successfully: entity ${entityId} to room ${targetRoomId}`, { entityId, targetRoomId });
        } catch (error) {
            this.errorController.handleError({
                code: 'MOVEMENT_FAILED',
                message: error.message
            });
            console.error(`[ActionExecutor] Move droid failed: ${error.message}`, { entityId, targetRoomId, error: error.message });
        }
    }
}

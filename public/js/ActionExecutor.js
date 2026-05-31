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
     * Resolves a range expression string to a numeric value.
     * Handles :Trait.stat expressions like ":Physical.strength*2+3".
     * Falls back to a provided default value if no expression or resolution fails.
     *
     * @param {string} expression - The range expression (e.g., ":Physical.strength*2+3")
     * @param {number} strength - The resolved Physical.strength value
     * @param {number} fallback - Fallback range value if expression is undefined or invalid
     * @returns {number} The resolved numeric range
     * @private
     */
    _resolveRangeExpression(expression, strength, fallback) {
        if (!expression) return fallback;

        // Match tokens: [+|-](:Placeholder[multiplier])
        // Pattern: optional +/-, then :Trait.stat, then optional *multiplier
        const tokenRegex = /([+])|(-)?(:[a-zA-Z0-9_.]+)(?:\*(-?\d+))?/g;
        let result = 0;
        let foundPlaceholder = false;

        let match;
        while ((match = tokenRegex.exec(expression)) !== null) {
            // Skip standalone '+' signs
            if (match[1] === '+') continue;

            const sign = match[2] === '-' ? -1 : 1;
            const placeholder = match[3] ? match[3].substring(1) : null; // Remove leading ':'
            const multiplier = match[4] ? parseInt(match[4].substring(1), 10) : 1;

            if (placeholder) {
                const value = (placeholder === 'Physical.strength') ? strength : 0;
                result += sign * value * multiplier;
                foundPlaceholder = true;
            }
        }

        // If no placeholders found, try safe arithmetic evaluation
        if (!foundPlaceholder) {
            try {
                if (/^[\d+\-*/(). ]+$/.test(expression)) {
                    return Function('"use strict"; return (' + expression + ')')();
                }
            } catch (_) {
                // Expression invalid — return fallback
            }
            return fallback;
        }

        return result;
    }

    /**
     * Executes a self-targeting action (e.g., selfHeal).
     * Uses _sendActionRequest with targetComponentId.
     *
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The entity ID performing the action.
     * @param {string} componentId - The component ID to use.
     * @param {string} componentIdentifier - The component identifier.
     * @returns {Promise<void>}
     */
    async executeSelfTarget(actionName, entityId, componentId, componentIdentifier) {
        try {
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
     * Executes an action directly without targeting (self-target with no targetingType,
     * or action targetingType === 'none'). This is the generic fallback for all actions
     * that don't require map interaction.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID performing the action.
     * @param {string} componentId - The component ID to use.
     * @param {string} componentIdentifier - The component identifier.
     * @returns {Promise<void>}
     */
    async executeAction(actionName, entityId, componentId, componentIdentifier) {
        try {
            const result = await this.actions._sendActionRequest({
                actionName,
                entityId,
                params: { targetComponentId: componentId, componentIdentifier }
            }, 'ACTION_FAILED');

            console.log(`[ActionExecutor] Action "${actionName}" executed successfully`, { actionName, entityId, componentId });
        } catch (error) {
            console.error(`[ActionExecutor] Action "${actionName}" failed: ${error.message}`, { actionName, entityId, componentId, error: error.message });
        }
    }

    /**
     * Executes a component-targeted action (e.g., punch, cut-attack, or any future
     * action with targetingType === 'component').
     *
     * This is a generic handler that reads the action definition from availableActions,
     * validates range, resolves the closest target entity, shows component selection,
     * and dispatches to the server via the appropriate ActionManager method.
     *
     * @param {Object} pending - The pending action object { actionName, entityId, componentId, targetingType }.
     * @param {number} targetX - The target X coordinate on the map.
     * @param {number} targetY - The target Y coordinate on the map.
     * @returns {Promise<void>}
     */
    async executeComponentAttack(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) {
            console.warn(`[ActionExecutor] No active droid or state for action "${pending.actionName}"`);
            return;
        }

        // Read range from action definition (data-driven, not hardcoded)
        const actionData = this.availableActions[pending.actionName] || {};
        const rawRange = actionData?.range;

        // Resolve range: support both numeric values and expressions like ":Physical.strength*2+3"
        let range;
        if (typeof rawRange === 'string' && rawRange.includes(':')) {
            // Range is an expression — resolve it using droid stats
            const strength = droid.components?.reduce((max, comp) => {
                const stats = state.components?.instances?.[comp.id];
                const str = stats?.Physical?.strength || 0;
                return str > max ? str : max;
            }, 0) || 0;
            range = this._resolveRangeExpression(rawRange, strength, 0);
        } else if (typeof rawRange === 'number' && rawRange > 0) {
            // Range is a plain number
            range = rawRange;
        } else {
            // Fallback: no range defined
            range = 0;
        }

        // Validate distance
        const distance = this.actions.calculateDistance(targetX, targetY, droid.spatial.x, droid.spatial.y);
        if (distance > range) {
            this.errorController.handleError({
                code: 'TARGET_OUT_OF_RANGE',
                details: {
                    distance: Math.round(distance),
                    range: range
                }
            });
            console.warn(`[ActionExecutor] Action "${pending.actionName}" out of range: distance=${Math.round(distance)}, range=${range}`);
            return;
        }

        // Find closest entity to the clicked position
        const closestEntity = this.actions.findClosestEntity(
            state.entities,
            targetX,
            targetY,
            AppConfig.TARGETING.PUNCH_TOLERANCE
        );
        if (!closestEntity) {
            this.errorController.handleError({ code: 'NO_TARGET_FOUND' });
            console.warn(`[ActionExecutor] No target found for action "${pending.actionName}"`);
            return;
        }

        // Show component selection for the target entity
        try {
            this.ui.showComponentSelection(closestEntity, state, async (targetCompId) => {
                try {
                    const selectedComponentIds = this.selectionController ? this.selectionController.getSelectedComponentIds() : new Set();
                    const attackerComponentIds = Array.from(selectedComponentIds);

                    // Route to correct server method based on component count
                    if (attackerComponentIds.length > 1) {
                        // Multi-attacker: use executeMultiComponentAttack with the action's own params
                        const components = attackerComponentIds.map(compId => ({
                            componentId: compId,
                            role: 'source'
                        }));
                        await this.actions.executeMultiComponentAttack(
                            pending.actionName,
                            pending.entityId,
                            components,
                            targetCompId
                        );
                        console.log(`[ActionExecutor] Multi-component action "${pending.actionName}" executed: ${attackerComponentIds.length} attackers vs target component ${targetCompId}`, { actionName: pending.actionName, entityId: pending.entityId, attackerCount: attackerComponentIds.length, targetComponentId: targetCompId });
                    } else {
                        // Single attacker: use executeComponentAttack with the action's own params
                        const attackerCompId = attackerComponentIds[0] || pending.componentId;
                        await this.actions.executeComponentAttack(
                            pending.actionName,
                            pending.entityId,
                            attackerCompId,
                            targetCompId
                        );
                        console.log(`[ActionExecutor] Single attacker action "${pending.actionName}" executed: attacker ${attackerCompId} vs target ${targetCompId}`, { actionName: pending.actionName, entityId: pending.entityId, attackerComponentId: attackerCompId, targetComponentId: targetCompId });
                    }

                    this.ui.closeDetails();
                    this.actions.clearPendingAction();
                    await this.refreshCallback();
                } catch (error) {
                    console.error(`[ActionExecutor] Action "${pending.actionName}" failed: ${error.message}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity.id, error: error.message });
                }
            });
        } catch (error) {
            console.error(`[ActionExecutor] Action "${pending.actionName}" component selection failed: ${error.message}`, { actionName: pending.actionName, entityId: pending.entityId, targetEntityId: closestEntity.id, error: error.message });
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

    /**
     * Executes a pick-up item action at target coordinates.
     * Mirrors the drop flow: shows range indicator on map, user clicks, then sends pickup request.
     *
     * Coordinate system: Both targetX/targetY and droid.spatial.x/y are relative
     * to the room center (same as how UIManager renders entities: CENTER_X + spatial.x).
     * This matches the coordinate system used by SpatialConsequenceHandler for spatial actions.
     *
     * @param {Object} pending - The pending pick-up item object { droppedItemId, itemType, name, volume, id, componentIds }.
     * @param {number} targetX - Target X coordinate relative to room center.
     * @param {number} targetY - Target Y coordinate relative to room center.
     * @param {Object} droid - The active droid entity.
     * @param {Object} state - The current world state.
     * @returns {Promise<void>}
     */
    async executePickUpItem(pending, targetX, targetY, droid, state) {
        if (!droid || !state) {
            console.warn('[ActionExecutor] No active droid or state for pick-up item action');
            return;
        }

        const entityId = droid.id;
        const componentId = pending.componentIds?.[0] || null;

        if (!componentId) {
            this.errorController.handleError({
                code: 'NO_COMPONENT_SELECTED',
                message: 'No component selected for pick-up.'
            });
            return;
        }

        try {
            const response = await fetch('/pick-up-item', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entityId,
                    droppedItemId: pending.droppedItemId || pending.id,
                    componentId
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to pick up item.');
            }

            const result = await response.json();
            console.log(`[ActionExecutor] Item "${pending.itemType}" picked up successfully.`, result);

            // Clear range indicator (green matches pickup flow)
            this.ui.renderRangeIndicator(droid, 0, '#44ff44');

            await this.refreshCallback();
        } catch (error) {
            console.error(`[ActionExecutor] Pick-up item failed: ${error.message}`, {
                entityId,
                droppedItemId: pending.droppedItemId || pending.id,
                componentId,
                targetX,
                targetY,
                error: error.message
            });
            this.errorController.handleError({
                code: 'PICKUP_FAILED',
                message: error.message
            });
        }
    }

    /**
     * Executes a drop item action at target coordinates.
     * Validates range, sends to server, refreshes world.
     *
     * Coordinate system: Both targetX/targetY and droid.spatial.x/y are relative
     * to the room center (same as how UIManager renders entities: CENTER_X + spatial.x).
     * This matches the coordinate system used by SpatialConsequenceHandler for spatial actions.
     *
     * @param {Object} pending - The pending drop item action object.
     * @param {number} targetX - Target X coordinate relative to room center.
     * @param {number} targetY - Target Y coordinate relative to room center.
     * @param {Object} droid - The active droid entity.
     * @param {Object} state - The current world state.
     * @returns {Promise<void>}
     */
    async executeDropItem(pending, targetX, targetY, droid, state) {
        if (!droid || !state) {
            console.warn('[ActionExecutor] No active droid or state for drop item action');
            return;
        }

        // Always use 'dropItem' action definition for range resolution.
        // This defensive fix ensures the drop flow is resilient to pending.actionName mismatches
        // (e.g., when _handleEquippedItemClick previously stored the item's action name like 'cut').
        const dropActionData = this.availableActions['dropItem'] || {};
        const rangeExpression = dropActionData?.range;

        // Calculate max Physical.strength from droid's components
        const strength = droid.components?.reduce((max, comp) => {
            const stats = state.components?.instances?.[comp.id];
            const str = stats?.Physical?.strength || 0;
            return str > max ? str : max;
        }, 0) || 0;

        // Use expression-based range if available, fallback to hardcoded formula
        const dropRange = this._resolveRangeExpression(
            rangeExpression,
            strength,
            AppConfig.DROP.BASE_RANGE + (strength * AppConfig.MULTIPLIERS.DROP_RANGE)
        );

        // Get droid spatial position (relative to room center, same coordinate system as targetX/Y)
        const droidSpatialX = droid.spatial?.x || 0;
        const droidSpatialY = droid.spatial?.y || 0;

        // Calculate Euclidean distance in room-center-relative coordinates.
        // This matches the coordinate system used by SpatialConsequenceHandler
        // for spatial actions like dash/move.
        const distance = Math.sqrt(
            Math.pow(targetX - droidSpatialX, 2) + Math.pow(targetY - droidSpatialY, 2)
        );

        if (distance > dropRange) {
            this.errorController.handleError({
                code: 'DROP_OUT_OF_RANGE',
                details: {
                    distance: Math.round(distance),
                    range: dropRange,
                    strength
                }
            });
            console.warn(`[ActionExecutor] Drop out of range: distance=${Math.round(distance)}, range=${dropRange}`);
            return;
        }

        try {
            await this.actions.executeDropItem(
                pending.actionName,
                pending.entityId,
                pending.itemId,
                pending.itemType,
                targetX,
                targetY
            );

            console.log(`[ActionExecutor] Item "${pending.itemType}" dropped at (${targetX}, ${targetY})`);
            // Clear range indicator
            this.ui.renderRangeIndicator(droid, 0, 'red');
            await this.refreshCallback();
        } catch (error) {
            console.error(`[ActionExecutor] Drop item failed: ${error.message}`, {
                actionName: pending.actionName,
                entityId: pending.entityId,
                itemType: pending.itemType,
                targetX,
                targetY,
                error: error.message
            });
        }
    }
}

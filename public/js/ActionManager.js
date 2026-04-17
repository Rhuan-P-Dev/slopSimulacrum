import { AppConfig } from './Config.js';

/**
 * ActionManager
 * Coordinates the execution of game actions and handles the target selection flow for movement.
 */
export class ActionManager {
    constructor(uiManager, errorController) {
        /** @type {UIManager} */
        this.uiManager = uiManager;
        /** @type {ClientErrorController} */
        this.errorController = errorController;
        /** @type {Object|null} The action currently awaiting a target click on the map */
        this.pendingMovementAction = null;
    }

    /**
     * Fetches available actions for a specific entity.
     * @param {string|null} entityId The entity ID to fetch actions for.
     * @returns {Promise<Object|null>} The actions data or null on failure.
     */
    async fetchActions(entityId) {
        try {
            const url = entityId ? `${AppConfig.ENDPOINTS.ACTIONS}?entityId=${entityId}` : AppConfig.ENDPOINTS.ACTIONS;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const data = await response.json();
            return data.actions;
        } catch (error) {
            console.error('[ActionManager] Failed to fetch actions:', error);
            throw error;
        }
    }

    /**
     * Centralized method to send action requests to the server.
     * @param {Object} payload The request body.
     * @param {string} errorCode The error code to use if the request fails.
     * @returns {Promise<Object>} The server response.
     * @throws {Error} If the response is not OK.
     */
    async _sendActionRequest(payload, errorCode) {
        try {
            const response = await fetch(AppConfig.ENDPOINTS.EXECUTE_ACTION, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.result?.error || err.error || 'Action execution failed');
            }

            return await response.json();
        } catch (error) {
            this.errorController.handleError({ 
                code: errorCode, 
                message: error.message 
            });
            throw error;
        }
    }

    /**
     * Handles the logic for executing an action.
     * Actions with targeting requirements are intercepted to trigger target selection.
     * @param {string} actionName 
     * @param {string} entityId 
     * @param {string} componentId - The unique ID of the selected component.
     * @param {string} componentIdentifier - The identifier of the selected component.
     * @param {Object} actionData - Metadata about the action (including targetingType).
     * @param {Function} onActionStateChange Callback to refresh UI when pending action changes.
     */
    async executeAction(actionName, entityId, componentId, componentIdentifier, actionData, onActionStateChange) {
        if (actionData?.targetingType && actionData.targetingType !== 'none') {
            this._handleTargetingSelection(actionName, entityId, componentId, componentIdentifier, actionData.targetingType);
            if (onActionStateChange) onActionStateChange();
            return;
        }

        try {
            const result = await this._sendActionRequest({ 
                actionName: actionName,
                entityId: entityId,
                params: { targetComponentId: componentId, componentIdentifier }
            }, 'ACTION_FAILED');
            console.log('[ActionManager] Action executed successfully:', result);
        } catch (error) {
            // Error already handled by _sendActionRequest
        }
    }

    /**
     * Internal helper to toggle the pending targeting action state.
     * Stores componentId (unique UUID) for precise highlighting in the UI.
     */
    _handleTargetingSelection(actionName, entityId, componentId, componentIdentifier, targetingType) {
        if (this.pendingMovementAction && 
            this.pendingMovementAction.actionName === actionName && 
            this.pendingMovementAction.componentId === componentId) {
            this.pendingMovementAction = null;
            console.log(`[ActionManager] Action ${actionName} deselected.`);
        } else {
            this.pendingMovementAction = {
                actionName,
                entityId,
                componentId,
                componentIdentifier,
                targetingType
            };
            console.log(`[ActionManager] Action ${actionName} selected. Awaiting target (${targetingType}).`);
        }
    }

    /**
     * Executes a movement action with specific target coordinates.
     * Includes the originally selected componentId so the server can
     * correctly resolve which component's stats to use for requirements
     * and consequences (e.g., durability loss from dash).
     * @param {string} actionName 
     * @param {string} entityId 
     * @param {number} targetX 
     * @param {number} targetY 
     */
    async moveToTarget(actionName, entityId, targetX, targetY) {
        const pending = this.getPendingAction();
        try {
            await this._sendActionRequest({ 
                actionName: actionName,
                entityId: entityId,
                params: { 
                    targetX, 
                    targetY,
                    targetComponentId: pending?.componentId,
                    componentIdentifier: pending?.componentIdentifier
                }
            }, 'MOVEMENT_FAILED');
        } catch (error) {
            // Error already handled by _sendActionRequest
        }
    }

    /**
     * Executes a punch action on a specific component of a target entity.
     * @param {string} actionName 
     * @param {string} entityId 
     * @param {string} attackerComponentId - The component ID of the attacker (used for damage value resolution).
     * @param {string} targetComponentId - The component ID of the target being punched.
     */
    async executePunch(actionName, entityId, attackerComponentId, targetComponentId) {
        try {
            const result = await this._sendActionRequest({ 
                actionName: actionName,
                entityId: entityId,
                params: { attackerComponentId, targetComponentId }
            }, 'PUNCH_FAILED');
            console.log('[ActionManager] Punch executed successfully:', result);
            return result;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Calculates the Euclidean distance between two points.
     * @param {number} x1 
     * @param {number} y1 
     * @param {number} x2 
     * @param {number} y2 
     * @returns {number}
     */
    calculateDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    }

    /**
     * Finds the closest entity to the given coordinates within a specific tolerance.
     * @param {Object} entities The entities map.
     * @param {number} x The target X coordinate.
     * @param {number} y The target Y coordinate.
     * @param {number} tolerance The maximum distance to consider.
     * @returns {Object|null} The closest entity or null.
     */
    findClosestEntity(entities, x, y, tolerance) {
        let closestEntity = null;
        let minDistance = tolerance;

        Object.values(entities).forEach(e => {
            const dist = this.calculateDistance(x, y, e.spatial.x, e.spatial.y);
            if (dist < minDistance) {
                minDistance = dist;
                closestEntity = e;
            }
        });

        return closestEntity;
    }

    /**
     * Returns the currently pending movement action.
     * @returns {Object|null}
     */
    getPendingAction() {
        return this.pendingMovementAction;
    }

    /**
     * Clears the pending movement action.
     */
    clearPendingAction() {
        this.pendingMovementAction = null;
    }
}

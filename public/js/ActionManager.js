import { AppConfig } from './Config.js';

/**
 * ActionManager
 * Coordinates the execution of game actions and handles the target selection flow for movement.
 */
export class ActionManager {
    constructor(uiManager) {
        /** @type {UIManager} */
        this.uiManager = uiManager;
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
     * Handles the logic for executing an action.
     * Movement actions are intercepted to trigger target selection.
     * @param {string} actionName 
     * @param {string} entityId 
     * @param {string} componentName 
     * @param {string} componentIdentifier 
     * @param {Function} onActionStateChange Callback to refresh UI when pending action changes.
     */
    async executeAction(actionName, entityId, componentName, componentIdentifier, onActionStateChange) {
        if (actionName === 'move' || actionName === 'dash') {
            this._handleMovementSelection(actionName, entityId, componentName, componentIdentifier);
            if (onActionStateChange) onActionStateChange();
            return;
        }

        try {
            const response = await fetch(AppConfig.ENDPOINTS.EXECUTE_ACTION, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    actionName: actionName,
                    entityId: entityId,
                    params: { componentName, componentIdentifier }
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.result?.error || 'Failed to execute action');
            }

            const result = await response.json();
            console.log('[ActionManager] Action executed successfully:', result);
        } catch (error) {
            alert('Action failed: ' + error.message);
        }
    }

    /**
     * Internal helper to toggle the pending movement action state.
     */
    _handleMovementSelection(actionName, entityId, componentName, componentIdentifier) {
        if (this.pendingMovementAction && 
            this.pendingMovementAction.actionName === actionName && 
            this.pendingMovementAction.entityId === entityId) {
            this.pendingMovementAction = null;
            console.log(`[ActionManager] Action ${actionName} deselected.`);
        } else {
            this.pendingMovementAction = {
                actionName,
                entityId,
                componentName,
                componentIdentifier
            };
            console.log(`[ActionManager] Action ${actionName} selected. Awaiting map target.`);
        }
    }

    /**
     * Executes a movement action with specific target coordinates.
     * @param {string} actionName 
     * @param {string} entityId 
     * @param {number} targetX 
     * @param {number} targetY 
     */
    async moveToTarget(actionName, entityId, targetX, targetY) {
        try {
            const response = await fetch(AppConfig.ENDPOINTS.EXECUTE_ACTION, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    actionName: actionName,
                    entityId: entityId,
                    params: { targetX, targetY }
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.result?.error || 'Failed to move droid');
            }
        } catch (error) {
            console.error('[ActionManager] Movement failed:', error.message);
        }
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

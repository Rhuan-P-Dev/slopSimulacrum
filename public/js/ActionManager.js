import { AppConfig } from './Config.js';
import ClientLogger from '/utils/ClientLogger.js';

/**
 * ActionManager
 * Coordinates the execution of game actions and handles the target selection flow for movement.
 */
export class ActionManager {
    /**
     * @param {UIManager} uiManager
     * @param {ClientErrorController} errorController
     * @param {Function} [queueModeProvider] - Optional lazy getter (Feature A): returns
     *   true when the client is in Turn mode AND the round is in the planning
     *   window, so every action request is sent with `queueForRound: true`
     *   (enqueued instead of executed). Defaults to null → always immediate
     *   (100% backward compatible).
     */
    constructor(uiManager, errorController, queueModeProvider = null) {
        /** @type {UIManager} */
        this.uiManager = uiManager;
        /** @type {ClientErrorController} */
        this.errorController = errorController;
        /** @type {Object|null} The action currently awaiting a target click on the map */
        this.pendingMovementAction = null;
        /** @private {Function|null} Lazy queue-mode getter (Feature A). */
        this._queueModeProvider = queueModeProvider;
    }

    /**
     * True when the next action request should be enqueued for the round
     * instead of executed immediately (Feature A, Turn mode + planning window).
     * Never throws: any error falls back to immediate (legacy) behavior.
     * @private
     * @returns {boolean}
     */
    _shouldQueueForRound() {
        if (typeof this._queueModeProvider !== 'function') return false;
        try {
            return this._queueModeProvider() === true;
        } catch (e) {
            return false;
        }
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
            ClientLogger.error('ActionManager', 'Failed to fetch actions:', error);
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
            // Feature A (Turn mode): when active, enqueue for the round instead of
            // executing immediately. The server gate is the additive `queueForRound`
            // flag; absent/false → the exact legacy immediate behavior.
            const requestPayload = this._shouldQueueForRound()
                ? { ...payload, queueForRound: true }
                : payload;
            const response = await fetch(AppConfig.ENDPOINTS.EXECUTE_ACTION, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestPayload)
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
            ClientLogger.info('ActionManager', 'Action executed successfully:', result);
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
            ClientLogger.debug('ActionManager', `Action ${actionName} deselected.`);
        } else {
            this.pendingMovementAction = {
                actionName,
                entityId,
                componentId,
                componentIdentifier,
                targetingType
            };
            ClientLogger.debug('ActionManager', `Action ${actionName} selected. Awaiting target (${targetingType}).`);
        }
    }

    /**
     * Executes a movement action with specific target coordinates.
     * Includes the originally selected componentId so the server can
     * correctly resolve which component's stats to use for requirements
     * and consequences (e.g., existence loss from dash).
     * @param {string} actionName 
     * @param {string} entityId 
     * @param {number} targetX 
     * @param {number} targetY 
     */
    async moveToTarget(actionName, entityId, targetX, targetY, pending = null) {
        const effectivePending = pending || this.getPendingAction();
        try {
            await this._sendActionRequest({ 
                actionName: actionName,
                entityId: entityId,
                params: { 
                    targetX, 
                    targetY,
                    targetComponentId: effectivePending?.componentId,
                    componentIdentifier: effectivePending?.componentIdentifier
                }
            }, 'MOVEMENT_FAILED');
        } catch (error) {
            // Error already handled by _sendActionRequest
        }
    }

    /**
     * Executes a component attack action on a specific component of a target entity.
     * Generic handler for ANY targetingType === 'component' action (punch, cut, kick, etc.).
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID of the attacker.
     * @param {string} attackerComponentId - The component ID of the attacker (used for damage value resolution).
     * @param {string} targetComponentId - The component ID of the target being attacked.
     */
    async executeComponentAttack(actionName, entityId, attackerComponentId, targetComponentId) {
        // Phase 4: the try/catch that only re-threw was removed (no added behavior).
        const result = await this._sendActionRequest({
            actionName: actionName,
            entityId: entityId,
            params: { attackerComponentId, targetComponentId }
        }, 'ACTION_FAILED');
        ClientLogger.info('ActionManager', `Component attack "${actionName}" executed successfully:`, result);
        return result;
    }

    /**
     * Executes a multi-attacker component attack.
     * All selected attacker components deal their own separate damage to the target.
     * Generic handler for ANY targetingType === 'component' action with multiple attackers.
     * @param {string} actionName - The action name (e.g., 'droid punch').
     * @param {string} entityId - The entity ID of the attacker.
     * @param {Array<{componentId: string, role: string}>} attackerComponents - Array of attacker component IDs with roles.
     * @param {string} targetComponentId - The component ID of the target being attacked.
     */
    async executeMultiComponentAttack(actionName, entityId, attackerComponents, targetComponentId) {
        // Phase 4: the try/catch that only re-threw was removed (no added behavior).
        const result = await this._sendActionRequest({
            actionName: actionName,
            entityId: entityId,
            params: {
                componentIds: attackerComponents,
                targetComponentId
            }
        }, 'ACTION_FAILED');
        ClientLogger.info('ActionManager', `Multi-attacker component attack "${actionName}" executed successfully:`, result);
        return result;
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

    /**
     * Executes a drop item action at target coordinates.
     * Sends POST /execute-action with spatial drop parameters.
     *
     * @param {string} actionName - The action name (e.g., 'dropItem').
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being dropped.
     * @param {string} itemType - The item type.
     * @param {number} targetX - Target X coordinate.
     * @param {number} targetY - Target Y coordinate.
     * @returns {Promise<Object>} Server response.
     */
    async executeDropItem(actionName, entityId, itemId, itemType, targetX, targetY) {
        try {
            const payload = {
                actionName,
                entityId,
                params: {
                    itemId,
                    itemType,
                    targetX,
                    targetY
                }
            };
            // Capture the queueing decision ONCE: it drives both the request
            // body (queueForRound) and the log line below, so the two can
            // never disagree.
            const queued = this._shouldQueueForRound();
            // Two-phase barrier fence (spec §3): this raw fetch honors the
            // SAME queueForRound gate as _sendActionRequest — drops made
            // during planning queue for the round instead of executing
            // immediately.
            const response = await fetch(AppConfig.ENDPOINTS.EXECUTE_ACTION, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queued ? { ...payload, queueForRound: true } : payload)
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.result?.error || err.error || 'Drop item failed');
            }

            const data = await response.json();
            // A queued drop has NOT executed yet — the log must say so.
            ClientLogger.info('ActionManager', queued ? `Drop queued for round at (${targetX}, ${targetY})` : `Item dropped at (${targetX}, ${targetY})`, data);
            return data;
        } catch (error) {
            this.errorController.handleError({
                code: 'DROP_ITEM_FAILED',
                message: error.message
            });
            throw error;
        }
    }

    // =========================================================================
    // MULTI-COMPONENT SELECTION API
    // =========================================================================

    /**
     * Batch-locks multiple components to a specific action.
     * Sends POST /select-components to the server.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Array<{componentId: string, role: string}>} components - Array of component IDs with roles.
     * @returns {Promise<Object>} Server response with { success, lockedCount, errors }.
     */
    async selectComponents(actionName, entityId, components) {
        try {
            const response = await fetch(AppConfig.ENDPOINTS.SELECT_COMPONENTS, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actionName, entityId, components })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to lock components');
            }

            const result = await response.json();
            if (!result.success) {
                // Build a detailed error message including all conflicts
                const errorMessages = Array.isArray(result.errors) ? result.errors : [this._extractErrorMessage(result.error) || 'Batch lock failed'];
                const detail = errorMessages.join('; ');

                // Structured error protocol (preferred): the server returns
                // result.errorDetails with machine-readable { code, details: { componentId,
                // lockedAction } } entries. Fall back to the legacy regex parse of the
                // human-readable message text when details are absent (older server).
                let conflictDetails = (Array.isArray(result.errorDetails) ? result.errorDetails : [])
                    .filter(e => e && e.code === 'COMPONENT_LOCKED' && e.details)
                    .map(e => ({ componentId: e.details.componentId, lockedAction: e.details.lockedAction }));

                if (conflictDetails.length === 0) {
                    conflictDetails = errorMessages.map(msg => {
                        const match = msg.match(/Component "([^"]+)" is already locked to action "([^"]+)"/);
                        if (match) {
                            return { componentId: match[1], lockedAction: match[2] };
                        }
                        return null;
                    }).filter(Boolean);
                }

                // If components are locked to the SAME action, this is a refresh scenario -
                // the server already has them locked, so we can treat it as success
                const isRefreshScenario = conflictDetails.length > 0 &&
                    conflictDetails.every(c => c.lockedAction === actionName);

                if (isRefreshScenario) {
                    ClientLogger.info('ActionManager', `Components already locked to "${actionName}", refreshing locks`);
                    return { success: true, lockedCount: components.length, refreshed: true };
                }

                throw new Error(detail);
            }

            ClientLogger.info('ActionManager', `Batch locked ${result.lockedCount} components for "${actionName}"`);
            return result;
        } catch (error) {
            this.errorController.handleError({
                code: 'SELECTION_FAILED',
                message: error.message
            });
            throw error;
        }
    }

    /**
     * Extracts a human-readable message from a server error payload that may be
     * either a plain string (legacy) or a structured object
     * ({ code, message, details }) per the error protocol.
     * @param {string|Object} error - The error payload from the server.
     * @returns {string|null} The message text, or null when absent.
     * @private
     */
    _extractErrorMessage(error) {
        if (!error) return null;
        if (typeof error === 'string') return error;
        if (typeof error === 'object') {
            return error.message ?? error.error ?? null;
        }
        return null;
    }

    /**
     * Previews synergy computation for an action without executing it.
     * Sends POST /synergy/preview to the server.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Array<{componentId: string, role: string}>} componentIds - Array of component IDs with roles.
     * @returns {Promise<Object|null>} Synergy preview object or null.
     */
    async previewSynergy(actionName, entityId, componentIds) {
        try {
            const response = await fetch(AppConfig.ENDPOINTS.SYNERGY_PREVIEW, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actionName,
                    entityId,
                    componentIds
                })
            });

            if (!response.ok) {
                ClientLogger.warn('ActionManager', 'Synergy preview HTTP error:', response.status);
                return null;
            }

            const data = await response.json();
            return data.synergyResult || null;
        } catch (error) {
            ClientLogger.warn('ActionManager', 'Synergy preview failed:', error);
            return null;
        }
    }

    /**
     * Executes an action with multiple components.
     * Sends POST /execute-action with componentIds array for synergy computation.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Array<{componentId: string, role: string}>} componentIds - Array of component IDs with roles.
     * @param {Object} [extraParams] - Additional params (e.g., targetX, targetY for spatial actions).
     * @returns {Promise<Object>} Server response including synergyPreview.
     */
    async executeWithComponents(actionName, entityId, componentIds, extraParams = {}) {
        try {
            const payload = {
                actionName,
                entityId,
                params: {
                    componentIds,
                    ...extraParams
                }
            };

            // Capture the queueing decision ONCE: it drives both the request
            // body (queueForRound) and the log line below, so the two can
            // never disagree.
            const queued = this._shouldQueueForRound();
            // Two-phase barrier fence (spec §3): same queueForRound gate as
            // _sendActionRequest — multi-component actions made during
            // planning queue for the round instead of executing immediately.
            const response = await fetch(AppConfig.ENDPOINTS.EXECUTE_ACTION, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queued ? { ...payload, queueForRound: true } : payload)
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.result?.error || err.error || 'Multi-component action failed');
            }

            const data = await response.json();
            // A queued action has NOT executed yet — the log must say so.
            ClientLogger.info('ActionManager', queued ? 'Multi-component action queued for round:' : 'Multi-component action executed:', data);
            return data;
        } catch (error) {
            this.errorController.handleError({
                code: 'ACTION_FAILED',
                message: error.message
            });
            throw error;
        }
    }

    // =========================================================================
    // ENHANCED SYNERGY PREVIEW API
    // =========================================================================

    /**
     * Previews action data including resolved values and synergy for a given component selection.
     * Sends POST /synergy/preview-data to the server.
     *
     * Returns:
     * - actionData: The action definition (targetingType, range, consequences, requirements)
     * - resolvedValues: Consequence values with placeholders resolved (e.g., { damageComponent: { value: -25 } })
     * - synergyResult: The computed synergy (multiplier, contributingComponents, etc.)
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Array<{componentId: string, role: string}>} componentIds - Array of component IDs with roles.
     * @returns {Promise<Object|null>} Preview data object or null.
     */
    async previewActionData(actionName, entityId, componentIds) {
        try {
            const response = await fetch(AppConfig.ENDPOINTS.SYNERGY_PREVIEW_DATA, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actionName,
                    entityId,
                    componentIds
                })
            });

            if (!response.ok) {
                ClientLogger.warn('ActionManager', 'Preview data HTTP error:', response.status);
                return null;
            }

            const data = await response.json();
            return data.actionPreviewData || null;
        } catch (error) {
            ClientLogger.warn('ActionManager', 'Preview data failed:', error);
            return null;
        }
    }
}

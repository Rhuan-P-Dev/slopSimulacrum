/**
 * SelectionController
 * A single-responsibility class for managing component selection state,
 * cross-action selections, and action list rendering coordination.
 *
 * @implements {ISelectionController}
 */

/**
 * @typedef {Object} SelectionState
 * @property {string|null} activeActionName
 * @property {string[]} selectedComponentIds
 * @property {Map<string, string[]>} crossActionSelections
 */

/**
 * @typedef {Object} PreviousActionState
 * Stores the complete state of the last active action for Alt-key restoration.
 * @property {string} actionName - The action name.
 * @property {string[]} selectedComponentIds - Component IDs selected for this action.
 * @property {string} [targetingType] - The targeting type (spatial, component, self_target, none).
 * @property {string} [entityId] - The entity ID used when the action was active.
 * @property {string} [componentId] - The last component ID toggled (for targeting flow).
 * @property {string} [componentIdentifier] - The last component identifier toggled (for targeting flow).
 */

/**
 * @typedef {Object} IWorldState
 * @property {function(): string|null} getMyEntityId
 */

/**
 * @typedef {Object} IUIManager
 * @property {function(Object, Object, Function, string|null, Set<string>, Map<string, Set<string>>, Function): void} renderActionList
 * @property {function(): void} clearSynergyPreview
 */

/**
 * @typedef {Object} IActionManager
 * @property {function(): Object} getPendingAction
 * @property {function(string): Promise<Object>} fetchActions
 * @property {function(string, string, string, string, string): void} _handleTargetingSelection
 * @property {function(): void} clearPendingAction
 */

/**
 * @interface ISelectionController
 */
class SelectionController {
    /**
     * Creates a new SelectionController.
     *
     * @param {IWorldState} worldState - World state manager instance.
     * @param {IUIManager} ui - UI manager instance.
     * @param {IActionManager} actions - Action manager instance.
     * @param {Object} synergyController - Synergy preview controller instance.
     * @param {Object} app - ClientApp reference for cross-module callbacks.
     */
    constructor(worldState, ui, actions, synergyController, app) {
        /** @type {IWorldState} World state manager instance. */
        this.worldState = worldState;

        /** @type {IUIManager} UI manager instance. */
        this.ui = ui;

        /** @type {IActionManager} Action manager instance. */
        this.actions = actions;

        /** @type {Object} Synergy preview controller instance. */
        this.synergyController = synergyController;

        /** @type {Object} ClientApp reference for cross-module callbacks. */
        this.app = app;

        /**
         * @type {string|null} The action currently being selected into.
         */
        this.activeActionName = null;

        /**
         * @type {string|null} The previously active action name, restored via Alt key.
         * @deprecated Use previousActionState instead. Maintained for backward compatibility.
         */
        this.previousActionName = null;

        /**
         * @type {PreviousActionState|null} Complete state of the last active action for Alt-key restoration.
         * Stores action name, selected components, targeting type, and entity info needed to
         * fully restore the previous action's execution state including range indicators.
         */
        this.previousActionState = null;

        /**
         * @type {Set<string>} Component IDs selected for the active action.
         */
        this.selectedComponentIds = new Set();

        /**
         * @type {Map<string, Set<string>>}
         * Maps actionName → Set of component IDs (for cross-action graying).
         * Only contains entries for non-active actions.
         */
        this.crossActionSelections = new Map();
    }

    /**
     * Returns the active action name.
     * @returns {string|null}
     */
    getActiveActionName() {
        return this.activeActionName;
    }

    /**
     * Returns the Set of selected component IDs.
     * @returns {Set<string>}
     */
    getSelectedComponentIds() {
        return this.selectedComponentIds;
    }

    /**
     * Returns selected component IDs as an array.
     * @returns {string[]}
     */
    getSelectedComponentIdsArray() {
        return Array.from(this.selectedComponentIds);
    }

    /**
     * Toggles a component in/out of the selection for a given action.
     *
     * - If clicking a different action, moves current selections to cross map.
     * - Clears stale entries for the NEW action from cross map (prevents duplicates).
     * - Toggles the component in/out of selected set.
     * - For spatial/component/self_target actions: sets pending action.
     * - For self_target with 1 component: executes immediately.
     * - Calls app.onSelectionChange() callback after changes.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component ID to toggle.
     * @param {string} componentIdentifier - The component identifier.
     * @returns {Promise<void>}
     */
    async toggleComponent(actionName, entityId, componentId, componentIdentifier) {
        console.log('[SelectionController DEBUG] === TOGGLE COMPONENT ===', {
            actionName, entityId, componentId, componentIdentifier,
            previousActiveActionName: this.activeActionName,
            previousSelectedIds: Array.from(this.selectedComponentIds),
            previousCrossSelections: Object.fromEntries(this.crossActionSelections),
            availableActionsKeys: Object.keys(this.app.availableActions || {})
        });

        const actionData = this.app.availableActions?.[actionName];
        const targetingType = actionData?.targetingType;
        console.log('[SelectionController DEBUG] actionData:', { actionName, targetingType, hasActionData: !!actionData });

        // If clicking a different action than current active, switch actions
        if (this.activeActionName && this.activeActionName !== actionName) {
            // Save current action as previous before switching (backward compat)
            this.previousActionName = this.activeActionName;

            // Capture full previous action state for Alt-key restoration.
            // IMPORTANT: Use data from the PREVIOUS action (via pending action or selected components),
            // NOT the new click's parameters which belong to the target action.
            const prevActionData = this.app.availableActions?.[this.activeActionName];
            const pending = this.actions.getPendingAction();
            const lastSelectedId = this.selectedComponentIds.size > 0
                ? Array.from(this.selectedComponentIds)[this.selectedComponentIds.size - 1]
                : null;
            this.previousActionState = {
                actionName: this.activeActionName,
                selectedComponentIds: Array.from(this.selectedComponentIds),
                targetingType: prevActionData?.targetingType || null,
                entityId: pending?.entityId || this.worldState.getMyEntityId(),
                componentId: pending?.componentId || lastSelectedId,
                componentIdentifier: pending?.componentIdentifier || null
            };
            // Move current selections to cross map
            if (this.selectedComponentIds.size > 0) {
                this.crossActionSelections.set(this.activeActionName, new Set(this.selectedComponentIds));
            }
            this.selectedComponentIds.clear();

            // Clear stale entries for the NEW action from cross map (prevents duplicate/stale state)
            this.crossActionSelections.delete(actionName);

            this.activeActionName = actionName;

            // Clear pending action and synergy preview
            this.actions.clearPendingAction();
            this.ui.clearSynergyPreview();
        } else if (!this.activeActionName) {
            this.activeActionName = actionName;
        }

        // Toggle the component
        if (this.selectedComponentIds.has(componentId)) {
            this.selectedComponentIds.delete(componentId);
            console.log(`[SelectionController DEBUG] → Component DESELECTED: ${componentId}`);
        } else {
            this.selectedComponentIds.add(componentId);
            console.log(`[SelectionController DEBUG] → Component SELECTED: ${componentId}`);
        }
        console.log('[SelectionController DEBUG] After toggle, selectedComponentIds:', Array.from(this.selectedComponentIds));

        // For spatial/component/self_target actions: set pending action so map/entity clicks trigger execution
        if (this.selectedComponentIds.size > 0 && targetingType && targetingType !== 'none') {
            console.log('[SelectionController DEBUG] → Calling actions._handleTargetingSelection:', {
                actionName, entityId, componentId, componentIdentifier, targetingType
            });
            this.actions._handleTargetingSelection(
                actionName, entityId, componentId, componentIdentifier, targetingType
            );
            console.log('[SelectionController DEBUG] → _handleTargetingSelection completed');
        } else if (this.selectedComponentIds.size === 0) {
            // If no components selected, clear pending
            console.log('[SelectionController DEBUG] → No components selected, clearing pending action');
            this.actions.clearPendingAction();
        } else {
            console.log('[SelectionController DEBUG] → targetingType is none or null, NOT setting pending action');
        }

        // For self_target actions: execute immediately with selected component
        if (this.selectedComponentIds.size === 1 && targetingType === 'self_target') {
            const compId = Array.from(this.selectedComponentIds)[0];
            console.log('[SelectionController DEBUG] → self_target action, executing immediately');
            await this.app.executor.executeSelfTarget(actionName, entityId, compId, componentIdentifier);
            // Clear pending action to prevent stale state on subsequent map clicks
            this.actions.clearPendingAction();
        }

        console.log('[SelectionController DEBUG] → Final state:', {
            activeActionName: this.activeActionName,
            selectedComponentIds: Array.from(this.selectedComponentIds),
            pendingAction: this.actions.getPendingAction()
        });

        // Notify app of selection change (triggers UI re-render + synergy preview)
        console.log('[SelectionController DEBUG] → Calling app.onSelectionChange()');
        this.app.onSelectionChange();
    }

    /**
     * Removes a grayed component from another action's selection.
     *
     * @param {string} lockedActionName - The action the component is selected in.
     * @param {string} componentId - The component to remove.
     */
    removeGrayedComponent(lockedActionName, componentId) {
        // If the grayed component belongs to the cross-action map
        const crossSet = this.crossActionSelections.get(lockedActionName);
        if (crossSet) {
            crossSet.delete(componentId);
            if (crossSet.size === 0) {
                this.crossActionSelections.delete(lockedActionName);
            }
            console.log(`[SelectionController] Grayed component removed from cross-action: ${componentId}`, { lockedActionName });
        }

        // Also clear from active selection if present (edge case)
        this.selectedComponentIds.delete(componentId);

        // Notify app of selection change
        this.app.onSelectionChange();
    }

    /**
     * Clears all component selections (for all actions).
     * Captures the full previous action state before clearing, so Alt-key restoration
     * can recover the action name, component selections, and targeting configuration.
     */
    clearAllSelections() {
        console.log('[SelectionController DEBUG] clearAllSelections called', {
            activeActionName: this.activeActionName,
            currentPreviousActionName: this.previousActionName,
            previousActionState: this.previousActionState,
            selectedComponentIds: Array.from(this.selectedComponentIds)
        });
        if (this.activeActionName) {
            // Preserve backward compat
            this.previousActionName = this.activeActionName;
            // Capture full previous action state for Alt-key restoration
            const prevActionData = this.app.availableActions?.[this.activeActionName];
            const pending = this.actions.getPendingAction();
            this.previousActionState = {
                actionName: this.activeActionName,
                selectedComponentIds: Array.from(this.selectedComponentIds),
                targetingType: prevActionData?.targetingType || null,
                entityId: pending?.entityId || this.worldState.getMyEntityId(),
                componentId: pending?.componentId || (this.selectedComponentIds.size === 1 ? Array.from(this.selectedComponentIds)[0] : null),
                componentIdentifier: pending?.componentIdentifier || null
            };
        }
        this.selectedComponentIds.clear();
        this.crossActionSelections.clear();
        this.activeActionName = null;
        this.ui.clearSynergyPreview();
        console.log('[SelectionController] All selections cleared');
    }

    /**
     * Checks whether a component is still valid for action restoration.
     * A component is valid if it exists in the world state and has positive durability.
     *
     * @param {string} componentId - The component ID to validate.
     * @returns {boolean} True if the component exists and has durability > 0.
     * @private
     */
    _isComponentValid(componentId) {
        if (!componentId) {
            return false;
        }

        const state = this.worldState.getState();
        if (!state || !state.components || !state.components.instances) {
            return false;
        }

        const componentStats = state.components.instances[componentId];
        if (!componentStats) {
            return false;
        }

        const durability = componentStats.Physical?.durability;
        return durability !== undefined && durability > 0;
    }

    /**
     * Restores the previously active action with full state restoration.
     * Recovers the action name, component selections, and triggers the targeting
     * flow if the previous action required spatial or component targeting.
     * Restoration will fail if the component referenced in the previous action
     * no longer exists or has durability <= 0.
     *
     * @returns {boolean} True if a previous action was restored, false if none exists or component is invalid.
     */
    restorePreviousAction() {
        // Use previousActionState if available (full restoration), fallback to previousActionName
        if (this.previousActionState !== null) {
            return this._restoreFromState(this.previousActionState);
        } else if (this.previousActionName !== null) {
            return this._restoreFromName(this.previousActionName);
        }

        return false;
    }

    /**
     * Restores the previous action from the full PreviousActionState snapshot.
     * Restores component selections and triggers the targeting flow for spatial/component actions.
     * Returns false and clears the saved state if the referenced component is no longer valid.
     *
     * @param {PreviousActionState} state - The captured previous action state.
     * @returns {boolean} True if restoration succeeded, false if component is invalid.
     * @private
     */
    _restoreFromState(state) {
        // Validate component before restoring
        if (state.componentId && !this._isComponentValid(state.componentId)) {
            this.previousActionName = null;
            this.previousActionState = null;
            return false;
        }

        // Save current active action's selections to cross map before switching
        if (this.activeActionName && this.selectedComponentIds.size > 0) {
            this.crossActionSelections.set(this.activeActionName, new Set(this.selectedComponentIds));
        }

        // Restore action name
        this.activeActionName = state.actionName;

        // Restore component selections
        this.selectedComponentIds = new Set(state.selectedComponentIds || []);

        // Clear cross-action selections and synergy preview
        this.crossActionSelections.clear();
        this.ui.clearSynergyPreview();

        // Trigger targeting flow for spatial/component actions
        if (state.targetingType && state.targetingType !== 'none' &&
            this.selectedComponentIds.size > 0 && state.entityId && state.componentId) {
            this.actions._handleTargetingSelection(
                state.actionName,
                state.entityId,
                state.componentId,
                state.componentIdentifier,
                state.targetingType
            );
        }

        // Trigger onSelectionChange to update synergy preview and other UI
        this.app.onSelectionChange();

        return true;
    }

    /**
     * Restores the previous action from name only (backward compatibility fallback).
     * Only restores the action name without component selections or targeting flow.
     *
     * @param {string} actionName - The previous action name.
     * @returns {boolean} True if restoration succeeded.
     * @private
     */
    _restoreFromName(actionName) {
        // Save current active action's selections to cross map before switching
        if (this.activeActionName && this.selectedComponentIds.size > 0) {
            this.crossActionSelections.set(this.activeActionName, new Set(this.selectedComponentIds));
        }

        this.activeActionName = actionName;
        this.selectedComponentIds.clear();
        this.crossActionSelections.clear();
        this.ui.clearSynergyPreview();
        return true;
    }

    /**
     * Returns the previously active action name.
     *
     * @returns {string|null}
     */
    getPreviousActionName() {
        return this.previousActionState?.actionName || this.previousActionName;
    }

    /**
     * Builds a cross-action selections map for UI rendering.
     * Includes BOTH crossActionSelections AND the active action's selectedComponentIds
     * so they appear grayed in other actions.
     *
     * @returns {Map<string, Set<string>>}
     */
    buildCrossMap() {
        const crossMap = new Map();

        // Add cross-action selections
        if (this.crossActionSelections) {
            for (const [actionName, compSet] of this.crossActionSelections) {
                if (actionName !== this.activeActionName) {
                    crossMap.set(actionName, compSet);
                }
            }
        }

        // Add active action's selections so they appear grayed in OTHER actions
        if (this.activeActionName && this.selectedComponentIds.size > 0) {
            crossMap.set(this.activeActionName, new Set(this.selectedComponentIds));
        }

        return crossMap;
    }

    /**
     * Returns the current selection state as a serializable object.
     *
     * @returns {SelectionState}
     */
    getSelectionState() {
        return {
            activeActionName: this.activeActionName,
            selectedComponentIds: Array.from(this.selectedComponentIds),
            crossActionSelections: Object.fromEntries(
                Array.from(this.crossActionSelections.entries()).map(
                    ([key, value]) => [key, Array.from(value)]
                )
            )
        };
    }

    /**
     * Restores selection state from a serializable object.
     *
     * @param {SelectionState} state
     */
    setSelectionState(state) {
        this.activeActionName = state.activeActionName || null;
        this.selectedComponentIds = new Set(state.selectedComponentIds || []);
        this.crossActionSelections = new Map();
        if (state.crossActionSelections) {
            for (const [key, value] of Object.entries(state.crossActionSelections)) {
                this.crossActionSelections.set(key, new Set(value || []));
            }
        }
        console.log('[SelectionController] Selection state restored', {
            activeAction: this.activeActionName,
            selectedCount: this.selectedComponentIds.size
        });
    }
}

export { SelectionController };
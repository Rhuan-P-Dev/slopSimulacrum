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
        const actionData = this.app.availableActions?.[actionName];
        const targetingType = actionData?.targetingType;

        // If clicking a different action than current active, switch actions
        if (this.activeActionName && this.activeActionName !== actionName) {
            // Move current selections to cross map
            if (this.selectedComponentIds.size > 0) {
                this.crossActionSelections.set(this.activeActionName, new Set(this.selectedComponentIds));
            }
            this.selectedComponentIds.clear();
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
            console.log(`[SelectionController] Component deselected: ${componentId}`, { actionName, componentId });
        } else {
            this.selectedComponentIds.add(componentId);
            console.log(`[SelectionController] Component selected: ${componentId}`, { actionName, componentId });
        }

        // For spatial/component/self_target actions: set pending action so map/entity clicks trigger execution
        if (this.selectedComponentIds.size > 0 && targetingType && targetingType !== 'none') {
            this.actions._handleTargetingSelection(
                actionName, entityId, componentId, componentIdentifier, targetingType
            );
        } else if (this.selectedComponentIds.size === 0) {
            // If no components selected, clear pending
            this.actions.clearPendingAction();
        }

        // For self_target actions: execute immediately with selected component
        if (this.selectedComponentIds.size === 1 && targetingType === 'self_target') {
            const compId = Array.from(this.selectedComponentIds)[0];
            await this.app.executor.executeSelfTarget(actionName, entityId, compId, componentIdentifier);
            // Clear pending action to prevent stale state on subsequent map clicks
            this.actions.clearPendingAction();
        }

        // Notify app of selection change (triggers UI re-render + synergy preview)
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
     */
    clearAllSelections() {
        this.selectedComponentIds.clear();
        this.crossActionSelections.clear();
        this.activeActionName = null;
        this.ui.clearSynergyPreview();
        console.log('[SelectionController] All selections cleared');
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
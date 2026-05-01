import { AppConfig } from './Config.js';
import { WorldStateManager } from './WorldStateManager.js';
import { UIManager } from './UIManager.js';
import { ActionManager } from './ActionManager.js';
import { ClientErrorController } from './ClientErrorController.js';

/**
 * ClientApp
 * The main orchestrator for the SlopSimulacrum client.
 * Coordinates communication between WorldStateManager, UIManager, and ActionManager.
 */
export class ClientApp {
    constructor() {
        this.worldState = new WorldStateManager();
        this.ui = new UIManager();
        this.errorController = new ClientErrorController(this.ui);
        this.actions = new ActionManager(this.ui, this.errorController);
        this.availableActions = {};

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

        this.socket = io();
        this._setupSocketListeners();
        this._setupMapClickListener();
        this._setupReleaseHandler();

        /**
         * @type {Object|null} Current synergy preview result (from _updateSynergyPreview).
         */
        this.currentSynergyResult = null;
    }

    /**
     * Initializes the application boot sequence.
     */
    async init() {
        console.log('%c[ClientApp] 🚀 Initializing System...', 'color: #00ff00; font-weight: bold;');
        try {
            await this.refreshWorldAndActions();
        } catch (error) {
            this.errorController.handleError({
                code: 'INITIALIZATION_ERROR',
                message: error.message
            });
        }
    }

    /**
     * Triggers a full refresh of the world state and available actions.
     */
    async refreshWorldAndActions() {
        try {
            await this.worldState.fetchState();
            const droid = this.worldState.getActiveDroid();

            // Update the visual world view
            this.ui.updateWorldView(
                this.worldState.getState(),
                droid,
                (entityId, targetId) => this.handleMoveDroid(entityId, targetId)
            );

            // Re-render entities and components with callbacks
            if (droid) {
                const state = this.worldState.getState();
                const room = state.rooms[droid.location];
                this.ui.updateEntityAndComponentViews(
                    room,
                    state.entities,
                    droid,
                    state,
                    (entity) => this.ui.showEntityDetails(entity, state),
                    (comp, stats) => this.ui.showComponentDetails(comp, stats)
                );
            }

            await this.updateActionList();
            this.ui.hideStatus();
        } catch (error) {
            console.error('[ClientApp] Refresh failed:', error);
            this.errorController.handleError({
                code: 'CONNECTION_ERROR',
                message: error.message
            });
        }
    }

    /**
     * Updates the list of available actions with selection state.
     */
    async updateActionList() {
        try {
            const entityId = this.worldState.getMyEntityId();
            this.availableActions = await this.actions.fetchActions(entityId);

            const pending = this.actions.getPendingAction();
            if (pending && this.availableActions[pending.actionName]) {
                const droid = this.worldState.getActiveDroid();
                const state = this.worldState.getState();
                if (droid && state) {
                    // Get synergy multiplier from current preview (if available)
                    const synergyMultiplier = this.currentSynergyResult
                        ? parseFloat(this.currentSynergyResult.synergyMultiplier) || 1.0
                        : 1.0;
                    const range = this._calculateActionRange(
                        pending.actionName, droid, state, synergyMultiplier
                    );
                    if (range !== null) {
                        const isMovement = pending.actionName === AppConfig.ACTIONS.MOVE || pending.actionName === AppConfig.ACTIONS.DASH;
                        const color = isMovement ? 'white' : 'red';
                        this.ui.renderRangeIndicator(droid, range, color);
                    }
                }
            }

            // Build cross-action selections map: include BOTH crossActionSelections
            // AND the active action's selectedComponentIds so they appear grayed in other actions
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

            this.ui.renderActionList(
                this.availableActions,
                pending,
                (actionName, entityId, compId, compIdentifier) =>
                    this._handleComponentToggle(actionName, entityId, compId, compIdentifier),
                this.activeActionName,
                this.selectedComponentIds,
                crossMap,
                (lockedActionName, compId) => this._handleGrayedComponentClick(lockedActionName, compId)
            );
        } catch (error) {
            console.error('[ClientApp] Action list update failed:', error);
            this.errorController.handleError({
                code: 'ACTION_LIST_UPDATE_FAILED',
                message: error.message
            });
        }
    }

    /**
     * Handles clicking a component row (toggle selection).
     * - If no active action, set this as active action.
     * - If clicking in a different action, switch active action (move old selections to cross map).
     * - Toggle the component in/out of selected set.
     * - After toggle, update synergy preview.
     * - For spatial/component actions: set pending action so map clicks trigger execution.
     *
     * @param {string} actionName
     * @param {string} entityId
     * @param {string} componentId
     * @param {string} componentIdentifier
     */
    async _handleComponentToggle(actionName, entityId, componentId, componentIdentifier) {
        const actionData = this.availableActions[actionName];
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
        } else {
            this.selectedComponentIds.add(componentId);
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
            await this._executeSelfTargetAction(actionName, entityId, compId, componentIdentifier);
            // Clear pending action to prevent stale state on subsequent map clicks
            this.actions.clearPendingAction();
        }

        // Re-render
        this.updateActionList();

        // Show synergy preview for 1+ components:
        // - 1 component: shows action data (range, consequences, requirements)
        // - 2+ components: shows synergy with modified values
        if (this.selectedComponentIds.size >= 1) {
            await this._updateSynergyPreview(entityId);
        } else {
            this.ui.clearSynergyPreview();
        }
    }

    /**
     * Handles clicking a grayed component (selected in another action).
     * Clears that component from the other action's selection.
     *
     * @param {string} lockedActionName - The action the component is selected in.
     * @param {string} componentId - The component to remove.
     */
    _handleGrayedComponentClick(lockedActionName, componentId) {
        // If the grayed component belongs to the cross-action map
        const crossSet = this.crossActionSelections.get(lockedActionName);
        if (crossSet) {
            crossSet.delete(componentId);
            if (crossSet.size === 0) {
                this.crossActionSelections.delete(lockedActionName);
            }
        }

        // Also clear from active selection if present (edge case)
        this.selectedComponentIds.delete(componentId);

        this.updateActionList();

        // Update synergy preview for 1+ components
        if (this.selectedComponentIds.size >= 1) {
            const entityId = this.worldState.getMyEntityId();
            this._updateSynergyPreview(entityId);
        } else {
            this.ui.clearSynergyPreview();
        }
    }

    /**
     * Fetches live synergy preview from the server.
     * Uses the enhanced preview-data API that returns action data + resolved values + synergy.
     * 
     * Display modes:
     * - 1 component: Shows action data (range, consequences, requirements)
     * - 2+ components: Shows synergy with modified values (before → after + bonus%)
     * 
     * Stores the synergy result so _calculateActionRange can apply it to the range indicator.
     * 
     * @param {string} entityId
     */
    async _updateSynergyPreview(entityId) {
        if (!this.activeActionName || !entityId || this.selectedComponentIds.size < 1) {
            this.currentSynergyResult = null;
            this.ui.clearSynergyPreview();
            return;
        }

        try {
            const componentIds = Array.from(this.selectedComponentIds).map(compId => ({
                componentId: compId,
                role: 'source'
            }));

            const preview = await this.actions.previewActionData(
                this.activeActionName, entityId, componentIds
            );

            if (preview) {
                // Store synergy result for range calculation
                this.currentSynergyResult = preview.synergyResult || null;
                this.ui.renderSynergyPreview(preview);
            } else {
                this.currentSynergyResult = null;
                this.ui.clearSynergyPreview();
            }
        } catch (error) {
            console.warn('[ClientApp] Synergy preview failed:', error);
            this.currentSynergyResult = null;
            this.ui.clearSynergyPreview();
        }
    }

    /**
     * Clears all component selections (for all actions).
     */
    _clearAllSelections() {
        this.selectedComponentIds.clear();
        this.crossActionSelections.clear();
        this.activeActionName = null;
        this.ui.clearSynergyPreview();
    }

    /**
     * Calculates the effective range of an action.
     * Applies synergy multiplier when available (multi-component selection).
     * @param {string} actionName
     * @param {Object} droid
     * @param {Object} state
     * @param {number} [synergyMultiplier=1.0] - Synergy multiplier from current preview.
     * @returns {number|null}
     */
    _calculateActionRange(actionName, droid, state, synergyMultiplier = 1.0) {
        const actionData = this.availableActions[actionName];
        if (!actionData) return null;

        if (actionData.range) return actionData.range;

        const isMove = actionName === AppConfig.ACTIONS.MOVE;
        const isDash = actionName === AppConfig.ACTIONS.DASH;

        if (isMove || isDash) {
            if (!droid || !droid.components || !state || !state.components || !state.components.instances) return null;

            // Use the component with the highest move stat for synergy calculation
            let maxMoveStat = null;
            for (const comp of droid.components) {
                const stats = state.components.instances[comp.id];
                if (stats && stats.Movement && stats.Movement.move !== undefined) {
                    if (maxMoveStat === null || stats.Movement.move > maxMoveStat) {
                        maxMoveStat = stats.Movement.move;
                    }
                }
            }

            if (maxMoveStat === null) return null;

            // Apply synergy multiplier to the move stat before calculating range
            const effectiveMove = maxMoveStat * synergyMultiplier;
            return isDash ? effectiveMove * AppConfig.MULTIPLIERS.DASH_RANGE : effectiveMove;
        }

        return null;
    }

    /**
     * Sets up socket.io listeners for real-time server communication.
     */
    _setupSocketListeners() {
        this.socket.on('incarnate', (data) => {
            console.log('[Socket] Incarnated as:', data.entityId);
            this.worldState.setMyEntityId(data.entityId);
            this.refreshWorldAndActions();
        });

        this.socket.on('world-state-update', () => {
            console.log('%c[Socket] ⚡ WORLD STATE UPDATE SIGNAL', 'color: #00ff00; font-weight: bold;');
            this.refreshWorldAndActions();
        });

        this.socket.on('error', (data) => {
            console.error('[Socket Error]:', data.message);
            this.errorController.handleError({
                code: 'SOCKET_ERROR',
                message: data.message
            });
        });
    }

    /**
     * Sets up the release handler for grabbed items.
     * Listens for the 'release-component' custom event from UIManager's detail overlay.
     */
    _setupReleaseHandler() {
        // Attach listener after DOM is ready (the overlay may not exist yet)
        const attachListener = () => {
            const detailOverlay = document.getElementById('detail-overlay');
            if (!detailOverlay) {
                // Retry after a short delay
                setTimeout(attachListener, 100);
                return;
            }

            detailOverlay.addEventListener('release-component', async (event) => {
                const { componentId: grabbedItemCompId, componentType } = event.detail;
                const entityId = this.worldState.getMyEntityId();
                if (!entityId) {
                    console.error('[ClientApp] No active entity to release from.');
                    return;
                }

                console.log(`[ClientApp] Executing release action for ${componentType} (grabbed item: ${grabbedItemCompId})`);

                try {
                    const result = await this.actions.executeRelease('release', entityId, grabbedItemCompId);
                    console.log('[ClientApp] Release executed successfully:', result);

                    // Clear pending action and refresh
                    this.actions.clearPendingAction();
                    this._clearAllSelections();
                    await this.refreshWorldAndActions();
                } catch (error) {
                    console.error('[ClientApp] Release failed:', error);
                    this.errorController.handleError({
                        code: 'RELEASE_FAILED',
                        message: error.message
                    });
                }
            });

            console.log('[ClientApp] Release handler attached to detail overlay.');
        };

        attachListener();
    }

    /**
     * Configures the map click handler for spatial targeting.
     */
    _setupMapClickListener() {
        const map = document.getElementById('world-map');
        if (!map) return;

        map.addEventListener('click', (event) => {
            const pending = this.actions.getPendingAction();
            if (!pending) return;

            const pt = map.createSVGPoint();
            pt.x = event.clientX;
            pt.y = event.clientY;
            const svgP = pt.matrixTransform(map.getScreenCTM().inverse());

            const targetX = svgP.x - AppConfig.VIEW.CENTER_X;
            const targetY = svgP.y - AppConfig.VIEW.CENTER_Y;

            if (pending.targetingType === 'spatial') {
                // Clear pending action FIRST to prevent stale state triggering
                // a second execution (race condition causing extra droid balls)
                this.actions.clearPendingAction();

                // Capture selection state BEFORE clearing
                const isMultiComponent = this.selectedComponentIds.size >= 2 && this.activeActionName === pending.actionName;
                const componentIdsToExecute = isMultiComponent
                    ? Array.from(this.selectedComponentIds)
                    : [];

                // Clear selections to prevent duplicate execution
                this._clearAllSelections();
                this.updateActionList();

                // Execute with captured state
                if (isMultiComponent) {
                    this._executeMultiComponentSpatial(
                        pending.actionName, pending.entityId,
                        componentIdsToExecute,
                        { targetX, targetY }
                    );
                } else {
                    this.actions.moveToTarget(pending.actionName, pending.entityId, targetX, targetY);
                }
            } else if (pending.targetingType === 'component') {
                if (pending.actionName === 'grab') {
                    this.handleGrabTarget(pending, targetX, targetY);
                } else if (pending.actionName === 'grabToBackpack') {
                    this.handleGrabToBackpackTarget(pending, targetX, targetY);
                } else if (pending.actionName === 'cut' || pending.actionName === 'droid punch') {
                    this.handlePunchTarget(pending, targetX, targetY);
                }
            }
        });
    }

    /**
     * Executes a self-targeting action (e.g., selfHeal) instantly with the selected component.
     * @param {string} actionName
     * @param {string} entityId
     * @param {string} componentId
     * @param {string} componentIdentifier
     */
    async _executeSelfTargetAction(actionName, entityId, componentId, componentIdentifier) {
        try {
            // dropAll: execute with entity-level params (no targetComponentId needed)
            if (actionName === 'dropAll') {
                const result = await this.actions.executeDropAll(actionName, entityId);
                console.log(`[ClientApp] Drop all executed:`, result);
                this._clearAllSelections();
                await this.refreshWorldAndActions();
                return;
            }

            const result = await this.actions._sendActionRequest(
                {
                    actionName,
                    entityId,
                    params: { targetComponentId: componentId, componentIdentifier }
                },
                'ACTION_FAILED'
            );
            console.log(`[ClientApp] Self-target action "${actionName}" executed:`, result);
        } catch (error) {
            console.error(`[ClientApp] Self-target action "${actionName}" failed:`, error);
        }
    }

    /**
     * Executes a spatial action with multiple components.
     */
    async _executeMultiComponentSpatial(actionName, entityId, componentIds, extraParams) {
        try {
            const components = componentIds.map(compId => ({
                componentId: compId,
                role: 'source'
            }));

            await this.actions.selectComponents(actionName, entityId, components);

            await this.actions.executeWithComponents(
                actionName, entityId, components, extraParams
            );

            await this.refreshWorldAndActions();
        } catch (error) {
            // Clear stale client-side selections to prevent UI/server state mismatch
            this.selectedComponentIds.clear();
            this.crossActionSelections.clear();
            this.activeActionName = null;
            this.ui.clearSynergyPreview();
            console.error('[ClientApp] Multi-component spatial action failed:', error);
        }
    }

    /**
     * Handles targeting for "grab" actions.
     * Finds the closest entity to the click and attempts to grab it.
     * @param {Object} pending
     * @param {number} targetX
     * @param {number} targetY
     */
    async handleGrabTarget(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) return;

        const actionData = this.availableActions[pending.actionName];
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
            return;
        }

        const closestEntity = this.actions.findClosestEntity(
            state.entities,
            targetX,
            targetY,
            AppConfig.TARGETING.PUNCH_TOLERANCE
        );

        if (!closestEntity) {
            this.errorController.handleError({
                code: 'NO_TARGET_FOUND'
            });
            this.actions.clearPendingAction();
            return;
        }

        try {
            const handCompId = Array.from(this.selectedComponentIds)[0] || pending.componentId;
            await this.actions.executeGrab(pending.actionName, pending.entityId, handCompId, closestEntity.id);

            this.actions.clearPendingAction();
            this._clearAllSelections();
            await this.refreshWorldAndActions();
        } catch (error) {
            console.error('[ClientApp] Grab failed:', error);
        }
    }

    /**
     * Handles targeting for "grabToBackpack" actions.
     * Finds the closest entity to the click and attempts to grab the item into the backpack.
     * @param {Object} pending
     * @param {number} targetX
     * @param {number} targetY
     */
    async handleGrabToBackpackTarget(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) return;

        const actionData = this.availableActions[pending.actionName];
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
            return;
        }

        const closestEntity = this.actions.findClosestEntity(
            state.entities,
            targetX,
            targetY,
            AppConfig.TARGETING.PUNCH_TOLERANCE
        );

        if (!closestEntity) {
            this.errorController.handleError({
                code: 'NO_TARGET_FOUND'
            });
            this.actions.clearPendingAction();
            return;
        }

        try {
            // Find the backpack component on the droid
            const backpackComp = droid.components.find(c => c.type === 'droidBackpack');
            if (!backpackComp) {
                this.errorController.handleError({
                    code: 'BACKPACK_NOT_FOUND',
                    message: 'No backpack component found on this entity.'
                });
                this.actions.clearPendingAction();
                return;
            }

            await this.actions.executeGrabToBackpack(pending.actionName, pending.entityId, backpackComp.id, closestEntity.id);

            this.actions.clearPendingAction();
            this._clearAllSelections();
            await this.refreshWorldAndActions();
        } catch (error) {
            console.error('[ClientApp] Grab to backpack failed:', error);
        }
    }

    /**
     * Handles targeting for "punch" style actions.
     * Sends ALL selected attacker component IDs so each deals its own damage.
     * @param {Object} pending
     * @param {number} targetX
     * @param {number} targetY
     */
    async handlePunchTarget(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) return;

        const actionData = this.availableActions[pending.actionName];
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
            return;
        }

        const closestEntity = this.actions.findClosestEntity(
            state.entities,
            targetX,
            targetY,
            AppConfig.TARGETING.PUNCH_TOLERANCE
        );

        if (!closestEntity) {
            this.errorController.handleError({
                code: 'NO_TARGET_FOUND'
            });
            return;
        }

        this.ui.showComponentSelection(closestEntity, state, async (targetCompId) => {
            try {
                // Send ALL selected attacker component IDs for multi-attacker punch
                const attackerComponentIds = Array.from(this.selectedComponentIds);

                if (attackerComponentIds.length > 1) {
                    // Multi-component punch: send componentIds array for multi-attacker execution
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
                } else {
                    // Legacy single-component punch
                    const attackerCompId = attackerComponentIds[0] || pending.componentId;
                    await this.actions.executePunch(pending.actionName, pending.entityId, attackerCompId, targetCompId);
                }

                this.ui.closeDetails();
                this.actions.clearPendingAction();
                this._clearAllSelections();
                await this.refreshWorldAndActions();
            } catch (error) {
                // ActionManager already handles the error reporting
            }
        });
    }

    /**
     * Executes a movement request for an entity to a different room.
     * @param {string} entityId
     * @param {string} targetRoomId
     */
    async handleMoveDroid(entityId, targetRoomId) {
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
            this.refreshWorldAndActions();
        } catch (error) {
            this.errorController.handleError({
                code: 'MOVEMENT_FAILED',
                message: error.message
            });
        }
    }
}

// Bootstrap the application
const app = new ClientApp();
app.init();
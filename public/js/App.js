import { AppConfig } from './Config.js';
import { WorldStateManager } from './WorldStateManager.js';
import { UIManager } from './UIManager.js';
import { ActionManager } from './ActionManager.js';
import { ClientErrorController } from './ClientErrorController.js';
import { SelectionController } from './SelectionController.js';
import { SynergyPreviewController } from './SynergyPreviewController.js';
import { ActionExecutor } from './ActionExecutor.js';
import { EventDispatcher } from './EventDispatcher.js';
import { StatBarsManager } from './StatBarsManager.js';
import { ComponentViewer } from './ComponentViewer.js';
import { NavActionsPanel } from './NavActionsPanel.js';
import { ConfigBarManager } from './ConfigBarManager.js';

/**
 * ClientApp
 * The main orchestrator for the SlopSimulacrum client.
 * Coordinates communication between all extracted modules.
 *
 * Module Architecture:
 * - SelectionController: Component selection state management
 * - SynergyPreviewController: Synergy preview + range calculation
 * - ActionExecutor: All action execution handlers
 * - EventDispatcher: Socket + DOM event listener management
 * - StatBarsManager: Configurable stat bar visualization
 * - ComponentViewer: Component detail overlay panel
 * - NavActionsPanel: Navigation & actions overlay panel
 * - ConfigBarManager: Top config bar management
 */
export class ClientApp {
    constructor() {
        // 1. Available actions cache
        this.availableActions = {};

        // 2. Instantiate core modules
        this.worldState = new WorldStateManager();
        this.ui = new UIManager();
        this.errorController = new ClientErrorController(this.ui);
        this.actions = new ActionManager(this.ui, this.errorController);

        // 3. Extracted modules
        this.selection = new SelectionController(
            this.worldState,
            this.ui,
            this.actions,
            null, // synergy controller (passed via fetchPreview)
            this // self-reference for callbacks
        );
        this.synergy = new SynergyPreviewController(this.actions, AppConfig);

        // 4. New modules for three-section layout
        this.statBars = new StatBarsManager(this.ui, this.worldState);
        this.componentViewer = new ComponentViewer(this.ui, this.statBars);
        this.navActions = new NavActionsPanel(this.ui);

        this.executor = new ActionExecutor(
            this.worldState,
            this.actions,
            this.ui,
            this.errorController,
            () => this.refreshWorldAndActions(),
            this.selection,
            this.availableActions
        );

        // 5. Config bar manager (wires everything together)
        this.configBar = new ConfigBarManager({
            uiManager: this.ui,
            componentViewer: this.componentViewer,
            statBarsManager: this.statBars,
            navActionsPanel: this.navActions,
            worldStateManager: this.worldState,
            onMoveEntity: (entityId, targetRoomId) => this.executor.executeMoveDroid(entityId, targetRoomId),
            onExecuteAction: (actionName, entityId, componentId, componentIdentifier) => {
                // Toggle component selection for the action, then execute if components selected
                if (entityId && actionName) {
                    this.selection.toggleComponent(actionName, entityId, componentId, componentIdentifier);
                    // If component was selected (not toggled off), execute the action
                    if (this.selection.getSelectedComponentIds().size > 0) {
                        const pending = this.actions.getPendingAction();
                        if (pending) {
                            // For non-targeting actions, execute immediately
                            const actionData = this.availableActions[actionName];
                            if (!actionData || !actionData?.targetingType || actionData.targetingType === 'none') {
                                this.executor.executeAction(actionName, entityId, componentId, componentIdentifier);
                            }
                        }
                    }
                }
            },
            onGetSelectionState: () => ({
                activeActionName: this.selection.getActiveActionName(),
                selectedComponentIds: this.selection.getSelectedComponentIds(),
                crossActionSelections: this.selection.crossActionSelections
            }),
            onGrayedComponentCallback: (lockedActionName, componentId) => {
                this.selection.removeGrayedComponent(lockedActionName, componentId);
            },
        });

        // 6. Socket connection
        this.socket = io();

        // 7. Wire event dispatcher with handler callbacks
        this.dispatcher = new EventDispatcher(this.socket, AppConfig, {
            setMyEntityId: (entityId) => this.worldState.setMyEntityId(entityId),
            refreshWorldAndActions: () => this.refreshWorldAndActions(),
            handleError: (err) => this.errorController.handleError(err),
            // Immediate stat bar update from socket payload (before full refresh)
            // Sync WorldStateManager.state first so getActiveDroid() reads fresh data
            onStatBarsUpdate: (state) => {
                this.worldState.state = state;
                this.statBars.updateAll(state);
            },
            moveToTarget: (actionName, entityId, targetX, targetY) =>
                this.actions.moveToTarget(actionName, entityId, targetX, targetY),
            executeMultiComponentSpatial: (actionName, entityId, componentIds, extraParams) =>
                this.executor.executeMultiComponentSpatial(actionName, entityId, componentIds, extraParams),
            executePunch: (pending, targetX, targetY) =>
                this.executor.executePunch(pending, targetX, targetY, this.selection.getSelectedComponentIds()),
            getMyEntityId: () => this.worldState.getMyEntityId(),
            _isMultiComponent: () => this.selection.getSelectedComponentIds().size >= 2 &&
                this.selection.getActiveActionName() === this.actions.getPendingAction()?.actionName,
            _getComponentIdsToExecute: () => Array.from(this.selection.getSelectedComponentIds()),
            _clearAllSelections: () => {
                this.selection.clearAllSelections();
                this.actions.clearPendingAction();
                this.updateActionList();
            },
            _reRenderActionList: () => this.updateActionList()
        });

        // 8. Setup event listeners
        this._setupListeners();

        console.log('%c[ClientApp] 🚀 Modules initialized', 'color: #00ff00; font-weight: bold;');
    }

    /**
     * Sets up all event listeners after module instantiation.
     * @private
     */
    _setupListeners() {
        // Socket.io listeners (managed by EventDispatcher)
        this.dispatcher.setupSocketListeners();

        // Map click listener (managed by EventDispatcher)
        const map = document.getElementById('world-map');
        if (map) {
            this.dispatcher.setupMapClickListener(
                map,
                () => this.actions.getPendingAction(),
                {} // extraHandlers already wired in constructor
            );
        }
    }

    /**
     * Initializes the application boot sequence.
     */
    async init() {
        console.log('%c[ClientApp] 🚀 Initializing System...', 'color: #00ff00; font-weight: bold;');
        try {
            // Initialize new modules
            this.statBars.init();
            this.componentViewer.init();
            this.navActions.init();
            this.configBar.init();

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
                (entityId, targetRoomId) => this.executor.executeMoveDroid(entityId, targetRoomId)
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

                // Update stat bars with current state
                this.statBars.updateAll(state);
            }

            await this.updateActionList();

            // Update NavActionsPanel if it's currently open
            this._updateNavActionsPanelIfOpen();

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
     * Callback invoked by SelectionController after any selection change.
     * Triggers UI re-render and synergy preview update.
     * Also updates NavActionsPanel if it's currently open so cross-action selection
     * highlighting is immediately visible without a full refresh.
     * Called from: SelectionController.toggleComponent(), removeGrayedComponent(), clearAllSelections()
     * @private
     */
    onSelectionChange() {
        this.updateActionList();

        // Update NavActionsPanel if it's open so cross-action highlighting updates immediately
        this._updateNavActionsPanelIfOpen();

        const componentIds = this.selection.getSelectedComponentIdsArray();
        const entityId = this.worldState.getMyEntityId();

        if (componentIds.length >= 1 && entityId) {
            this._updateSynergyPreview(entityId);
        } else {
            this.ui.clearSynergyPreview();
            this.synergy.clearCache();
        }
    }

    /**
     * Updates the list of available actions with selection state.
     */
    async updateActionList() {
        try {
            const entityId = this.worldState.getMyEntityId();
            this.availableActions = await this.actions.fetchActions(entityId);
            // Sync with ActionExecutor so it has fresh action data for range checks
            this.executor.availableActions = this.availableActions;

            const pending = this.actions.getPendingAction();
            if (pending && this.availableActions[pending.actionName]) {
                const droid = this.worldState.getActiveDroid();
                const state = this.worldState.getState();
                if (droid && state) {
                    const actionData = this.availableActions[pending.actionName];

                    // Compute live synergy multiplier from selected components for accurate range
                    const selectedIds = this.selection.getSelectedComponentIdsArray();
                    const synergyMultiplier = selectedIds.length > 0
                        ? await this.synergy.computeSynergyMultiplier(pending.actionName, entityId, selectedIds)
                        : 1.0;

                    const range = this.synergy.calculateRange(
                        pending.actionName, actionData, droid, state, synergyMultiplier
                    );
                    if (range !== null) {
                        const isMovement = pending.actionName === AppConfig.ACTIONS.MOVE || pending.actionName === AppConfig.ACTIONS.DASH;
                        const color = isMovement ? 'white' : 'red';
                        this.ui.renderRangeIndicator(droid, range, color);
                    }
                }
            }

            // renderActionList removed: NavActionsPanel handles action list rendering
        } catch (error) {
            console.error('[ClientApp] Action list update failed:', error);
            this.errorController.handleError({
                code: 'ACTION_LIST_UPDATE_FAILED',
                message: error.message
            });
        }
    }

    /**
     * Updates the NavActionsPanel if it's currently open.
     * Re-renders the panel content with fresh room and action data.
     * @private
     */
    _updateNavActionsPanelIfOpen() {
        if (!this.navActions._overlay || this.navActions._overlay.style.display !== 'block') {
            return;
        }

        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        const room = droid?.location ? state?.rooms?.[droid.location] : null;

        this.navActions.updateRoom(
            room,
            this.availableActions,
            this.worldState.getMyEntityId(),
            (entityId, targetRoomId) => this.executor.executeMoveDroid(entityId, targetRoomId),
            (actionName, entityId, compId, compIdentifier) => {
                // Toggle component selection for the action, then execute if components selected
                if (entityId && actionName) {
                    this.selection.toggleComponent(actionName, entityId, compId, compIdentifier);
                    if (this.selection.getSelectedComponentIds().size > 0) {
                        const pending = this.actions.getPendingAction();
                        if (pending) {
                            const actionData = this.availableActions[actionName];
                            if (!actionData || !actionData?.targetingType || actionData.targetingType === 'none') {
                                this.executor.executeAction(actionName, entityId, compId, compIdentifier);
                            }
                        }
                    }
                }
            },
            this.selection.getActiveActionName(),
            this.selection.getSelectedComponentIds(),
            this.selection.buildCrossMap(),
            (lockedActionName, compId) => this.selection.removeGrayedComponent(lockedActionName, compId)
        );
    }

    /**
     * Fetches live synergy preview from the server.
     * @param {string} entityId
     * @private
     */
    async _updateSynergyPreview(entityId) {
        const componentIds = this.selection.getSelectedComponentIdsArray();
        const preview = await this.synergy.fetchPreview(
            this.selection.getActiveActionName(),
            entityId,
            componentIds
        );

        if (preview) {
            this.ui.renderSynergyPreview(preview);
        } else {
            this.ui.clearSynergyPreview();
        }
    }

    // ==================== Delegate Methods ====================
    // Backward-compatible delegates to WorldStateManager

    /**
     * @returns {Object|null}
     */
    getActiveDroid() {
        return this.worldState.getActiveDroid();
    }

    /**
     * @returns {Object}
     */
    getState() {
        return this.worldState.getState();
    }

    /**
     * @returns {string|null}
     */
    getMyEntityId() {
        return this.worldState.getMyEntityId();
    }
}

// Bootstrap the application
const app = new ClientApp();
app.init();
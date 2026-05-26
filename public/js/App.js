/**
 * ClientApp
 * The main orchestrator for the SlopSimulacrum client.
 * Coordinates communication between all modules.
 *
 * Module Architecture:
 * - SelectionController: Component selection state management
 * - SynergyPreviewController: Synergy preview + range calculation
 * - ActionExecutor: All action execution handlers
 * - EventDispatcher: Socket + DOM event listener management
 * - StatBarsManager: Configurable stat bar visualization
 * - ComponentViewer: Component detail overlay with internal component panel
 * - NavActionsPanel: Navigation & actions overlay
 * - OverlayManager: Floating window coordination (exclusive visibility, shortcuts)
 */
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
import { WorldMapView } from './WorldMapView.js';
import { InventoryManager } from './InventoryManager.js';
import { OverlayManager } from './OverlayManager.js';

export class ClientApp {
    constructor() {
        // 1. Available actions cache
        this.availableActions = {};

        // 2. Core modules
        this.worldState = new WorldStateManager();
        this.ui = new UIManager();
        this.errorController = new ClientErrorController(this.ui);
        this.actions = new ActionManager(this.ui, this.errorController);

        // 3. Controllers
        this.selection = new SelectionController(
            this.worldState,
            this.ui,
            this.actions,
            null, // synergy controller (passed via fetchPreview)
            this  // self-reference for callbacks
        );
        this.synergy = new SynergyPreviewController(this.actions, AppConfig);

        // 4. UI modules
        this.statBars = new StatBarsManager(this.ui, this.worldState);
        this.componentViewer = new ComponentViewer(this.ui, this.statBars);
        this.navActions = new NavActionsPanel(this.ui);
        this.worldMap = new WorldMapView({
            onRoomClick: (roomId) => this._handleWorldMapRoomClick(roomId)
        });
        this.inventory = new InventoryManager(this.worldState, this.ui, this.statBars);

        // 5. Action executor
        this.executor = new ActionExecutor(
            this.worldState,
            this.actions,
            this.ui,
            this.errorController,
            () => this.refreshWorldAndActions(),
            this.selection,
            this.availableActions
        );

        // 6. Overlay manager (replaces ConfigBarManager)
        this.overlayManager = new OverlayManager();

        // 7. Wire action execution callback to NavActionsPanel
        this._setupActionCallback();

        // 8. Socket connection
        this.socket = io();

        // 9. Wire event dispatcher
        this.dispatcher = new EventDispatcher(this.socket, AppConfig, {
            setMyEntityId: (entityId) => this.worldState.setMyEntityId(entityId),
            refreshWorldAndActions: () => this.refreshWorldAndActions(),
            handleError: (err) => this.errorController.handleError(err),
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
        }, {
            worldStateManager: this.worldState
        });

        // 10. Setup listeners
        this._setupListeners();

        // 11. Drop item state
        /** @type {Object|null} Pending drop item state { actionName, entityId, itemId, itemType, componentId } */
        this._pendingDropItem = null;
    }

    /**
     * Sets up the action execution callback for NavActionsPanel.
     * @private
     */
    _setupActionCallback() {
        this.navActions.setExecuteActionCallback((actionName, entityId, componentId, componentIdentifier) => {
            // Check if this is an equipped item click
            if (componentId && componentId.startsWith('equipped-')) {
                this._handleEquippedItemClick(actionName, entityId, componentId, componentIdentifier);
                return;
            }

            // Toggle component selection, then execute if selected
            if (entityId && actionName) {
                this.selection.toggleComponent(actionName, entityId, componentId, componentIdentifier);
                if (this.selection.getSelectedComponentIds().size > 0) {
                    const pending = this.actions.getPendingAction();
                    if (pending) {
                        const actionData = this.availableActions[actionName];
                        if (!actionData || !actionData?.targetingType || actionData.targetingType === 'none') {
                            this.executor.executeAction(actionName, entityId, componentId, componentIdentifier);
                        }
                    }
                }
            }
        });

        this.navActions.setGrayedComponentCallback((lockedActionName, compId) => {
            this.selection.removeGrayedComponent(lockedActionName, compId);
        });
    }

    /**
     * Handles clicking a room node on the world map overlay.
     * @private
     */
    _handleWorldMapRoomClick(roomId) {
        const droid = this.worldState.getActiveDroid();
        if (!droid) return;
        if (droid.location === roomId) return;
        this.executor.executeMoveDroid(droid.id, roomId);
    }

    /**
     * Sets up all event listeners after module instantiation.
     * @private
     */
    _setupListeners() {
        this.dispatcher.setupSocketListeners();

        const map = document.getElementById('world-map');
        if (map) {
            this.dispatcher.setupMapClickListener(
                map,
                () => this.actions.getPendingAction(),
                {
                    hasPendingDropAction: () => this._pendingDropItem !== null,
                    onDropItemClick: (targetX, targetY) => {
                        const pending = this._pendingDropItem;
                        if (pending) {
                            const droid = this.worldState.getActiveDroid();
                            const state = this.worldState.getState();
                            this.executor.executeDropItem(pending, targetX, targetY, droid, state);
                            this._pendingDropItem = null;
                            if (droid) {
                                this.ui.renderRangeIndicator(droid, 0, 'red', 'drop');
                            }
                        }
                    }
                }
            );
        }

        this.socket.on('dropped-items-update', (data) => {
            // Handled by server-side tracking
        });
    }

    /**
     * Initializes the application boot sequence.
     */
    async init() {
        try {
            // Initialize modules
            this.statBars.init();
            this.componentViewer.init();
            this.navActions.init();
            this.worldMap.init();
            this.inventory.init();

            // Register panels with overlay manager
            this.overlayManager.register('component-viewer', this.componentViewer, 'btn-component-viewer', '1',
                () => ({ entity: this.worldState.getActiveDroid(), state: this.worldState.getState() })
            );
            this.overlayManager.register('nav-actions', this.navActions, 'btn-nav-actions', '2',
                () => this._buildNavActionsData()
            );
            this.overlayManager.register('world-map', this.worldMap, 'btn-world-map', '3');
            this.overlayManager.register('inventory', this.inventory, 'btn-inventory', '4');
            this.overlayManager.init();

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

                // Update stat bars
                this.statBars.updateAll(state);
            }

            await this.updateActionList();

            // Update NavActionsPanel if it's currently open
            this._updateNavActionsPanelIfOpen();

            this.ui.hideStatus();
        } catch (error) {
            this.errorController.handleError({
                code: 'CONNECTION_ERROR',
                message: error.message
            });
        }
    }

    /**
     * Callback invoked by SelectionController after any selection change.
     * Triggers UI re-render and synergy preview update.
     * @private
     */
    onSelectionChange() {
        this.updateActionList();
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
            this.executor.availableActions = this.availableActions;

            const pending = this.actions.getPendingAction();
            if (pending && this.availableActions[pending.actionName]) {
                const droid = this.worldState.getActiveDroid();
                const state = this.worldState.getState();
                if (droid && state) {
                    const actionData = this.availableActions[pending.actionName];

                    // Compute live synergy multiplier from selected components
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
        } catch (error) {
            this.errorController.handleError({
                code: 'ACTION_LIST_UPDATE_FAILED',
                message: error.message
            });
        }
    }

    /**
     * Updates the NavActionsPanel if it's currently open.
     * @private
     */
    _updateNavActionsPanelIfOpen() {
        if (!this.navActions._overlay || this.navActions._overlay.style.display !== 'block') {
            return;
        }

        this.navActions.updateRoom(
            this.availableActions,
            this.worldState.getMyEntityId(),
            (actionName, entityId, compId, compIdentifier) => {
                // Delegate to the callback set in _setupActionCallback
                this.navActions._actionCallback?.(actionName, entityId, compId, compIdentifier);
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

    /**
     * Handles clicking on an equipped item in the action list.
     * @private
     */
    _handleEquippedItemClick(actionName, entityId, componentId, componentIdentifier) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) return;

        // Parse componentId: "equipped-${itemId}-${itemType}"
        const prefix = 'equipped-';
        const afterPrefix = componentId.substring(prefix.length);
        const lastDash = afterPrefix.lastIndexOf('-');
        if (lastDash <= 0) return;

        const itemId = afterPrefix.substring(0, lastDash);
        const itemType = afterPrefix.substring(lastDash + 1);

        // Calculate drop range from strength stat
        let maxStrength = 0;
        if (droid.components) {
            for (const comp of droid.components) {
                const stats = state.components?.instances?.[comp.id];
                if (stats?.Physical?.strength) {
                    maxStrength = Math.max(maxStrength, stats.Physical.strength);
                }
            }
        }

        const dropRange = AppConfig.DROP.BASE_RANGE + (maxStrength * AppConfig.MULTIPLIERS.DROP_RANGE);

        this._pendingDropItem = { actionName, entityId, itemId, itemType, componentId };
        this.actions.setPendingDropAction(this._pendingDropItem);
        this.ui.renderRangeIndicator(droid, dropRange, '#ff4444', 'drop');
    }

    /**
     * Builds data object for NavActionsPanel show().
     * @returns {Promise<Object>} Data object with actions, callbacks, selection state.
     * @private
     */
    async _buildNavActionsData() {
        const entityId = this.worldState.getMyEntityId();
        const actions = await this.actions.fetchActions(entityId);
        return {
            actions,
            entityId,
            onActionClick: (actionName, entityId, compId, compIdentifier) => {
                if (compId && compId.startsWith('equipped-')) {
                    this._handleEquippedItemClick(actionName, entityId, compId, compIdentifier);
                    return;
                }
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
            activeActionName: this.selection.getActiveActionName(),
            selectedComponentIds: this.selection.getSelectedComponentIds(),
            crossActionSelections: this.selection.buildCrossMap(),
            onGrayedComponentClick: (lockedActionName, compId) => {
                this.selection.removeGrayedComponent(lockedActionName, compId);
            }
        };
    }

    // ==================== Delegate Methods ====================

    getActiveDroid() {
        return this.worldState.getActiveDroid();
    }

    getState() {
        return this.worldState.getState();
    }

    getMyEntityId() {
        return this.worldState.getMyEntityId();
    }
}

// Bootstrap the application
const app = new ClientApp();
app.init();
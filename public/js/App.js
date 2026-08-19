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
import { TurnController } from './TurnController.js';
import { DropSelectorController } from './DropSelectorController.js';
import { PickUpOverlayController } from './PickUpOverlayController.js';
import { RoomConnectionRenderer } from './RoomConnectionRenderer.js';
import { RoomChatController } from './RoomChatController.js';
import { HintManager } from './HintManager.js';
import IdResolver from '/utils/IdResolver.js';
import ClientLogger from '/utils/ClientLogger.js';

export class ClientApp {
    constructor() {
        // 1. Available actions cache
        this.availableActions = {};

        // 2. Core modules
        this.worldState = new WorldStateManager();
        this.ui = new UIManager();
        this.errorController = new ClientErrorController(this.ui);
        // Feature A: turn system HUD + targeting mode. The mode provider is
        // passed to ActionManager LAZILY (it reads turns.shouldQueueForRound()
        // at request time), so it is safe to reference `this.turns` from the
        // closure before it is fully constructed below.
        this.turns = new TurnController({
            worldState: () => this.worldState.getState(),
            getMyEntityId: () => this.worldState.getMyEntityId(),
            onModeChange: () => this.turns.update(),
            onCancelQueued: (entityId, queueId) => this._cancelQueuedAction(entityId, queueId)
        });
        this.actions = new ActionManager(this.ui, this.errorController, () => this.turns.shouldQueueForRound());
        // 2b. Hint system (v1: reachability-move hint only).
        this.hintManager = new HintManager({ uiManager: this.ui });

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
        // Phase 4: the onRoomClick wiring was removed — _handleWorldMapRoomClick()
        // was deprecated (door clicks route through _handleDoorClick instead) and
        // had no other callers. Room node clicks are now no-ops.
        this.worldMap = new WorldMapView({});
        this.inventory = new InventoryManager(this.worldState, this.ui, this.statBars);

        // 5. Socket connection (must be before EventDispatcher)
        this.socket = io();

        // 6. Action executor (must be before EventDispatcher — dispatcher callbacks reference this.executor)
        this.executor = new ActionExecutor(
            this.worldState,
            this.actions,
            this.ui,
            this.errorController,
            () => this.refreshWorldAndActions(),
            this.selection,
            this.availableActions
        );

        // 7. Wire event dispatcher (must be after executor, before DropSelectorController)
        this.dispatcher = new EventDispatcher(this.socket, AppConfig, {
            setMyEntityId: (entityId) => this.worldState.setMyEntityId(entityId),
            refreshWorldAndActions: () => this.refreshWorldAndActions(),
            handleError: (err) => this.errorController.handleError(err),
            onStatBarsUpdate: (state) => {
                this.worldState.state = state;
                this.statBars.updateAll(state);
            },
            moveToTarget: (actionName, entityId, targetX, targetY, pending) =>
                this.actions.moveToTarget(actionName, entityId, targetX, targetY, pending),
            executeMultiComponentSpatial: (actionName, entityId, componentIds, extraParams) =>
                this.executor.executeMultiComponentSpatial(actionName, entityId, componentIds, extraParams),
            executeComponentAttack: (pending, targetX, targetY) =>
                this.executor.executeComponentAttack(pending, targetX, targetY),
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

        // 8. Drop selector controller (depends on dispatcher)
        this.dropSelector = new DropSelectorController(
            this.dispatcher,
            this.worldState,
            this.selection,
            this.ui,
            this.actions
        );

        // 9. Feature D: per-room chat overlay (spec §7.4). Focused room =
        // the active droid's room; synced in refreshWorldAndActions().
        this.roomChat = new RoomChatController({
            getState: () => this.worldState.getState(),
            handleError: (err) => this.errorController.handleError(err)
        });

        // 10. Overlay manager (replaces ConfigBarManager)
        this.overlayManager = new OverlayManager();
        // 10. Pick-up overlay controller for dropped items on world map
        this.pickUpOverlay = new PickUpOverlayController({
            onPickUp: (droppedItemInfo) => this._handlePickUpClick(droppedItemInfo),
            onClose: () => {}
        });

        // 11. Wire action execution callback to NavActionsPanel
        this._setupActionCallback();

        // 12. Register pick-up overlay with overlay manager
        this.overlayManager.register('pick-up', this.pickUpOverlay, null, null);

        // 13. Setup listeners
        this._setupListeners();

        // 13b. Feature A: initialize the turn HUD in the config-bar slot.
        // Wrapped so a missing slot / DOM issue can never break app startup.
        try {
            this.turns.init();
        } catch (err) {
            ClientLogger.error('App', 'Turn HUD init failed (UI unaffected):', err);
        }

        // 13c. Feature D: initialize the room chat panel. Same guard — a
        // missing panel must never break startup.
        try {
            this.roomChat.init();
        } catch (err) {
            ClientLogger.error('App', 'Room chat init failed (UI unaffected):', err);
        }

        // 14. Drop item state
        /** @type {Object|null} Pending drop item state { actionName, entityId, itemId, itemType, componentIds } */
        this._pendingDropItem = null;

        // 15. Pending pick-up selector state (pickup mode — mirrors drop flow)
        /** @type {Object|null} Pending pick-up selector { droppedItemId, itemType, name, volume, id, componentIds } */
        this._pendingPickUpSelector = null;
    }

    /**
     * Sets up the action execution callback for NavActionsPanel.
     * @private
     */
    _setupActionCallback() {
        this.navActions.setExecuteActionCallback((actionName, entityId, componentId, componentIdentifier) => {
            // Check if this is an equipped item click (uses typed eq- prefix)
            if (componentId && IdResolver.isEquippedId(componentId)) {
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
                            this.executor.executeAction(actionName, entityId, componentId, componentIdentifier).then(() => {
                                // Clear selections and UI displays after action execution
                                this.selection.clearAllSelections();
                            });
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
     * Cancels one queued action for the client entity (Feature A).
     * Calls DELETE /turns/queue/:entityId/:queueId, then refreshes so the HUD
     * and action list reflect the removal. Failures surface via the error
     * controller; the UI never breaks.
     * @param {string} entityId - Typed entity ID (ent-...).
     * @param {string} queueId - Typed queue entry ID (q-...).
     * @private
     */
    async _cancelQueuedAction(entityId, queueId) {
        try {
            const response = await fetch(`${AppConfig.ENDPOINTS.TURNS_QUEUE}/${entityId}/${queueId}`, {
                method: 'DELETE'
            });
            const data = await response.json();
            if (!response.ok || !data?.success) {
                throw new Error(data?.error || `Cancel failed (HTTP ${response.status})`);
            }
            ClientLogger.info('App', `Queued action ${queueId} cancelled for ${entityId}`);
            await this.refreshWorldAndActions();
        } catch (error) {
            ClientLogger.error('App', `Failed to cancel queued action ${queueId}:`, error);
            this.errorController.handleError({
                code: 'TURN_QUEUE_CANCEL_FAILED',
                message: error.message
            });
        }
    }

    /**
     * Computes the entity's effective movement range from its Movement.move stat.
     * Finds the maximum Movement.move value across all droid components,
     * matching the pattern in SynergyPreviewController.calculateRange().
     *
     * @param {Object} droid - The droid entity object.
     * @param {Object} state - The world state object.
     * @returns {number|null} The effective movement range, or null if no movement stat found.
     * @private
     */
    _getEntityMovementRange(droid, state) {
        if (!droid || !droid.components || !state || !state.components || !state.components.instances) {
            return null;
        }

        let maxMove = null;
        for (const comp of droid.components) {
            const stats = state.components.instances[comp.id];
            if (stats && stats.Movement && stats.Movement.move !== undefined) {
                if (maxMove === null || stats.Movement.move > maxMove) {
                    maxMove = stats.Movement.move;
                }
            }
        }

        return maxMove;
    }

    /**
     * Handles clicking a door connection line on the spatial map.
     * Validates range before allowing the room transition. If out of range,
     * prevents the move and triggers visual feedback (red flash on connection line).
     * Range is computed from the entity's Movement.move stat, not from the door.
     *
     * @param {string} entityId - The entity ID performing the move.
     * @param {string} targetRoomId - The target room ID.
     * @param {string} doorName - The name of the door (e.g., "right_door").
     * @returns {boolean} True if the move was executed, false if blocked by range.
     * @private
     */
    _handleDoorClick(entityId, targetRoomId, doorName) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        const moveRange = this._getEntityMovementRange(droid, state);

        // If entity has no movement stat, allow unrestricted movement (no range check)
        if (moveRange === null) {
            this.executor.executeMoveDroid(entityId, targetRoomId, doorName);
            return true;
        }

        const result = this._checkDoorRange(doorName, moveRange);
        if (!result.inRange) {
            // Show error feedback
            this.errorController.handleError({
                code: 'OUT_OF_RANGE',
                message: result.message
            });
            // Trigger visual feedback on the connection line
            this._flashDoorConnectionRed(doorName);
            return false;
        }

        // In range — proceed with move
        this.executor.executeMoveDroid(entityId, targetRoomId, doorName);
        return true;
    }

    /**
     * Calculates whether the active droid is within range of a door position.
     * Uses Euclidean distance in room-center-relative coordinates, matching
     * the calculation in _handleDoorHover().
     *
     * @param {string} doorName - The name of the door (e.g., "right_door").
     * @param {number} range - The maximum allowed distance to the door (from entity's Movement.move).
     * @returns {{ inRange: boolean, distance: number, maxRange: number, message: string }}
     *   Object containing the range check result with a human-readable message.
     * @private
     */
    _checkDoorRange(doorName, range) {
        const droid = this.worldState.getActiveDroid();
        if (!droid) {
            return {
                inRange: false,
                distance: Infinity,
                maxRange: range,
                message: 'No active droid.'
            };
        }

        // Get door position from the room's connections data.
        // Door positions are computed as the edge point of the current room toward
        // the target room, expressed in room-center-relative coordinates.
        const state = this.worldState.getState();
        const currentRoom = state?.rooms?.[droid.location];
        if (!currentRoom || !currentRoom.connections || !currentRoom.connections[doorName]) {
            return {
                inRange: false,
                distance: Infinity,
                maxRange: range,
                message: `Door "${doorName}" not found in current room.`
            };
        }

        const connData = currentRoom.connections[doorName];
        const targetId = typeof connData === 'object' ? connData.target : connData;
        const targetRoom = state?.rooms?.[targetId];
        if (!targetRoom) {
            return {
                inRange: false,
                distance: Infinity,
                maxRange: range,
                message: `Target room for door "${doorName}" not found.`
            };
        }

        // Calculate the door position (edge point of current room toward target room)
        // in room-center-relative coordinates, matching RoomConnectionRenderer._drawConnection()
        const offsetX = AppConfig.VIEW.CENTER_X - currentRoom.width / 2;
        const offsetY = AppConfig.VIEW.CENTER_Y - currentRoom.height / 2;
        const roomCX = offsetX + currentRoom.width / 2;
        const roomCY = offsetY + currentRoom.height / 2;

        // Use the same edge point calculation as RoomConnectionRenderer
        const [doorSVGX, doorSVGY] = RoomConnectionRenderer._getEdgePoint(
            currentRoom, targetRoom, roomCX, roomCY, offsetX, offsetY
        );
        // Convert to room-center-relative coordinates
        const doorX = doorSVGX - AppConfig.VIEW.CENTER_X;
        const doorY = doorSVGY - AppConfig.VIEW.CENTER_Y;

        // Calculate Euclidean distance from droid to door (room-center-relative coordinates)
        const droidX = droid.spatial?.x || 0;
        const droidY = droid.spatial?.y || 0;
        const distance = Math.sqrt(Math.pow(doorX - droidX, 2) + Math.pow(doorY - droidY, 2));

        const inRange = distance <= range;
        return {
            inRange,
            distance,
            maxRange: range,
            message: inRange
                ? ''
                : `Door "${doorName}" is out of range. Distance: ${distance.toFixed(1)}, Max Range: ${range}`
        };
    }

    /**
     * Triggers a brief red flash on the connection line for the given door
     * to provide visual feedback when a click is rejected due to being out of range.
     *
     * @param {string} doorName - The name of the door whose connection line to flash.
     * @private
     */
    _flashDoorConnectionRed(doorName) {
        // Find the visible connection line element by data-door attribute
        const line = document.querySelector(`.room-connection-line[data-door="${doorName}"]`);
        if (!line) return;

        const originalStroke = line.getAttribute('stroke');
        const originalOpacity = line.getAttribute('opacity');

        // Flash red
        line.setAttribute('stroke', AppConfig.COLORS.RANGE.OUT_OF_RANGE);
        line.setAttribute('opacity', '1');

        // Restore after brief delay
        setTimeout(() => {
            line.setAttribute('stroke', originalStroke);
            line.setAttribute('opacity', originalOpacity);
        }, AppConfig.ANIMATION.DOOR_FLASH_DURATION);
    }

    /**
     * Sets up all event listeners after module instantiation.
     * @private
     */
    _setupListeners() {
        this.dispatcher.setupSocketListeners();

        // Listen for drop selector execute event
        document.addEventListener('drop-selector:execute', (event) => {
            this._onDropSelectorExecute(event.detail);
        });

        // Listen for ESC key to cancel pending actions
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this._cancelPendingAction();
            }
        });

        // Listen for Alt key to restore previous action
        // Use event.code instead of event.key because browsers (especially on Linux)
        // may not fire keydown with event.key==='Alt' for bare modifier keys.
        document.addEventListener('keydown', (event) => {
            if (event.code === 'AltLeft' || event.code === 'AltRight') {
                event.preventDefault();
                this._restorePreviousAction().catch(err => {
                    // Suppress unhandled promise rejection for key handler
                    ClientLogger.error('App', 'Error restoring previous action:', err);
                });
            }
        });

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
                    },
                    hasPendingPickUpAction: () => this._pendingPickUpSelector !== null,
                    onPickUpItemClick: (targetX, targetY) => {
                        this._onPickUpMapClick(targetX, targetY);
                    }
                }
            );
        }

        this.socket.on('dropped-items-update', (data) => {
            // Dropped items are refreshed when world-map is opened via /world-map-with-items
        });

        // Listen for pick-up selector execute event (mirrors drop-selector:execute)
        document.addEventListener('pick-up-selector:execute', (event) => {
            this._onPickUpSelectorExecute(event.detail);
        });

        // Feature A: dedicated turn transition event (phase/round flips).
        // The payload does NOT carry queues — just re-read the latest full state
        // (a full-state broadcast follows on the same tick for resolutions).
        this.socket.on('turn-round-update', (payload) => {
            try {
                this.turns.onTransition(payload);
            } catch (err) {
                ClientLogger.error('App', 'turn-round-update handler failed:', err);
            }
        });

        // Feature D: GLOBAL room-chat broadcast (spec §7.3) — the payload
        // carries the roomId; the controller filters by focused room.
        this.socket.on('room-chat-message', (message) => {
            try {
                this.roomChat.onRoomChatMessage(message);
            } catch (err) {
                ClientLogger.error('App', 'room-chat-message handler failed:', err);
            }
        });
    }

    /**
     * Central function to cancel any pending action, selection, or overlay state.
     * Called by the ESC key handler.
     * @private
     */
    /**
     * Restores the previously active action when the Alt key is pressed.
     * Delegates to SelectionController.restorePreviousAction() which validates
     * the component before restoring. Shows a notification if restoration fails
     * due to an invalid component. Updates the UI after successful restoration.
     * @private
     * @returns {Promise<void>}
     */
    async _restorePreviousAction() {
        const previousName = this.selection.getPreviousActionName();
        if (!previousName) {
            this.ui.showErrorPopup('No previous action to restore', 3000);
            return;
        }

        const restored = await this.selection.restorePreviousAction();
        if (restored) {
            // Update action list for UI refresh after restoration
            this.updateActionList();
            this._updateNavActionsPanelIfOpen();

            // Check if the restored action has components that cannot execute
            // and show why the requirements are not met
            this._checkRestoredActionRequirements(previousName);
        } else {
            this.ui.showErrorPopup('Cannot restore action — component no longer valid', 3000);
        }
    }

    /**
     * After restoring a previous action, checks if the restored action's
     * components meet the action's requirements. If components appear in
     * the cannotExecute array, extracts and displays the failure reason.
     * @param {string} actionName - The name of the restored action.
     * @private
     */
    _checkRestoredActionRequirements(actionName) {
        const actionData = this.availableActions[actionName];
        if (!actionData) return;

        const cannotExecute = actionData.cannotExecute || [];
        if (cannotExecute.length === 0) return;

        // Build failure reason from the action's requirements definition
        const requirements = actionData.requirements || [];
        if (requirements.length === 0) return;

        const reasons = requirements.map(req =>
            `${req.trait}.${req.stat} >= ${req.minValue}`
        );

        this.ui.showErrorPopup(
            `Restored ${actionName} — Requirements not met: ${reasons.join(', ')}`,
            4000
        );
    }

    _cancelPendingAction() {
        // 1. Clear all component selections and action state
        this.selection.clearAllSelections();

        // 2. Clear pending movement/action in ActionManager
        this.actions.clearPendingAction();

        // 3. Clear pending drop/pickup states
        this._pendingDropItem = null;
        this._pendingPickUpSelector = null;

        // 4. Hide any active overlays (e.g., drop selector)
        if (this.dropSelector) {
            this.dropSelector.hide();
        }

        // 5. Clear visual indicators
        this.ui.clearRangeIndicator();

        // 6. Refresh UI to reflect cleared state
        this.updateActionList();
        this._updateNavActionsPanelIfOpen();
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
            this.dropSelector.init();
            this.pickUpOverlay.init();

            // Wire drop selector to inventory manager
            this.inventory.setDropSelector(this.dropSelector);

            // Register panels with overlay manager
            this.overlayManager.register('component-viewer', this.componentViewer, 'btn-component-viewer', '1',
                () => ({ entity: this.worldState.getActiveDroid(), state: this.worldState.getState() })
            );
            this.overlayManager.register('nav-actions', this.navActions, 'btn-nav-actions', '2',
                () => this._buildNavActionsData()
            );
            this.overlayManager.register('world-map', this.worldMap, 'btn-world-map', '3');
            this.overlayManager.register('inventory', this.inventory, 'btn-inventory', '4');
            // Feature D: room chat panel (button in the config bar, no number
            // shortcut — only 1-4 are wired in OverlayManager).
            this.overlayManager.register('room-chat', this.roomChat, 'btn-room-chat', null);

            // Drop selector is NOT registered with OverlayManager — it only opens from inventory clicks
            // and has its own show/hide lifecycle

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

            // Feature D: keep the chat panel scoped to the focused room
            // (the active droid's room). No-op when the room is unchanged.
            this.roomChat.setFocusedRoom(droid?.location || null);

            // Update the visual world view
            this.ui.updateWorldView(
                this.worldState.getState(),
                droid,
                (entityId, targetRoomId, doorName) => this._handleDoorClick(entityId, targetRoomId, doorName),
                (doorName, doorPosition) => this._handleDoorHover(doorName, doorPosition),
                () => this._hideDoorRangeIndicator()
            );

            // Re-render entities and components with callbacks
            if (droid) {
                const state = this.worldState.getState();
                const room = state.rooms[droid.location];
                this.ui.updateEntityAndComponentViews(
                    room,
                    state.entities,
                    droid,
                    state
                );

                // Render dropped items on the spatial map with hover range indicator
                const droppedItems = state.droppedItems || {};
                const currentRoom = droid.location || null;
                const roomFilteredItems = {};
                for (const [id, item] of Object.entries(droppedItems)) {
                    if (item.roomId === currentRoom) {
                        roomFilteredItems[id] = item;
                    }
                }
                this.ui.renderDroppedItemsOnSpatialMap(
                    roomFilteredItems,
                    (id, item) => this._handleDroppedItemClick(id, item),
                    (id, item) => this._handleDroppedItemHover(id, item),
                    (id, item) => this._handleDroppedItemLeave(id, item)
                );

                // Update stat bars
                this.statBars.updateAll(state);
            }

            await this.updateActionList();

            // Update NavActionsPanel if it's currently open
            this._updateNavActionsPanelIfOpen();

            // Feature A: refresh the turn HUD (state.turns rides every full state)
            try {
                this.turns.update();
            } catch (err) {
                ClientLogger.error('App', 'Turn HUD refresh failed (UI unaffected):', err);
            }

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

                    // Resolve range using generic logic: synergy for MOVE/DASH, explicit for component attacks
                    let range = this.synergy.calculateRange(
                        pending.actionName, actionData, droid, state, synergyMultiplier
                    );

                    // For component-targeted actions, try explicit range if synergy calculation returned null
                    if (range === null && actionData?.targetingType === 'component') {
                        range = SynergyPreviewController.getExplicitRange(pending.actionName, this.availableActions);
                    }

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
        if (!this.navActions.overlay || this.navActions.overlay.style.display !== 'block') {
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
     * Handles clicking on an equipped item in the ⚔️ Actions panel.
     * - For targetingType === 'component' actions (e.g., cut): trigger attack flow (toggle component selection)
     * - For other actions: store drop info for Inventory drop button flow
     *
     * @private
     */
    _handleEquippedItemClick(actionName, entityId, eqId, componentIdentifier) {
        // eqId is a typed ID (eq-uuid) — no legacy parsing needed
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) {
            return;
        }

        // Look up the equipped item to get itemId and itemType
        const equippedItem = this.worldState.getEquippedItem(entityId, eqId);
        if (!equippedItem) {
            return;
        }

        const itemId = equippedItem.itemId;
        const itemType = equippedItem.itemType;

        const actionData = this.availableActions[actionName] || {};

        // Component-targeted actions (like 'cut') should trigger the attack flow, not the drop flow.
        // The drop flow is handled exclusively by the Inventory drop button → DropSelector path.
        if (actionData?.targetingType === 'component') {
            // Toggle component selection for attack — the existing targeting flow handles map click → executeComponentAttack
            this.selection.toggleComponent(actionName, entityId, eqId, componentIdentifier);
            // Ensure the action list reflects the selection (range indicator, etc.).
            this.updateActionList();
            this._updateNavActionsPanelIfOpen();
            return;
        }

        // For non-component actions (spatial, self_target), store drop info for Inventory-style drop flow
        // Resolve drop range from dropItem action (NOT the item's primary action)
        const dropActionData = this.availableActions['dropItem'] || {};
        const rangeExpression = dropActionData?.range;

        // Calculate max Physical.strength from droid's components
        let maxStrength = 0;
        if (droid.components) {
            for (const comp of droid.components) {
                const compId = comp.id || comp;
                const stats = state.components?.instances?.[compId];
                if (stats?.Physical?.strength) {
                    maxStrength = Math.max(maxStrength, stats.Physical.strength);
                }
            }
        }

        const dropRange = this._resolveDropRange(rangeExpression, maxStrength);

        // Store drop info — this is a DROP operation, not the item's primary action
        this._pendingDropItem = { actionName: 'dropItem', entityId, itemId, itemType, componentId: eqId };
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
                if (compId && IdResolver.isEquippedId(compId)) {
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

    /**
     * Handles the drop selector "Execute" event.
     * Stores pending drop item and shows the range indicator.
     * @param {Object} detail - The event detail.
     * @param {Object} detail.pendingDropItem - The pending drop item.
     * @param {string[]} detail.componentIds - Selected component IDs.
     * @private
     */
    _onDropSelectorExecute(detail) {
        const { pendingDropItem, componentIds } = detail;
        if (!pendingDropItem) return;

        // Store 'dropItem' as the actionName — this is a DROP operation, not the item's primary action
        this._pendingDropItem = {
            actionName: 'dropItem',
            entityId: pendingDropItem.entityId,
            itemId: pendingDropItem.itemId,
            itemType: pendingDropItem.itemType,
            componentIds
        };

        // Resolve drop range from dropItem action (NOT the item's primary action)
        const dropActionData = this.availableActions['dropItem'] || {};
        const rangeExpression = dropActionData?.range;

        const droid = this.worldState.getActiveDroid();
        if (!droid) return;

        const state = this.worldState.getState();
        let maxStrength = 0;
        if (droid.components && Array.isArray(droid.components)) {
            for (const comp of droid.components) {
                const compId = comp.id || comp;
                const stats = state.components?.instances?.[compId];
                if (stats?.Physical?.strength) {
                    maxStrength = Math.max(maxStrength, stats.Physical.strength);
                }
            }
        }

        const dropRange = this._resolveDropRange(rangeExpression, maxStrength);
        this.ui.renderRangeIndicator(droid, dropRange, '#ff4444', 'drop');
    }

    /**
     * Handles the pick-up selector "Execute" event.
     * Mirrors the drop flow: stores pending pick-up, resolves range, shows range indicator.
     * @param {Object} detail - The event detail.
     * @param {Object} detail.pendingPickUpItem - The pending pick-up item.
     * @param {string[]} detail.componentIds - Selected component IDs.
     * @private
     */
    _onPickUpSelectorExecute(detail) {
        const { pendingPickUpItem, componentIds } = detail;
        if (!pendingPickUpItem) return;

        // Store pick-up info with component IDs for execution
        this._pendingPickUpSelector = {
            droppedItemId: pendingPickUpItem.id,
            itemType: pendingPickUpItem.itemType,
            name: pendingPickUpItem.name,
            volume: pendingPickUpItem.volume,
            componentIds
        };

        // Range is already verified and indicator shown when item was clicked.
        // Execute immediately upon component selection.
        this._executePickUpImmediately(pendingPickUpItem);
    }

    /**
     * Executes the pickup action immediately after component selection.
     * @private
     */
    async _executePickUpImmediately(pendingPickUpItem) {
        const droid = this.worldState.getActiveDroid();
        if (!droid) return;

        const state = this.worldState.getState();

        // Execute pickup with stored pending selector and item coordinates
        this.executor.executePickUpItem(this._pendingPickUpSelector, pendingPickUpItem.x, pendingPickUpItem.y, droid, state);
        this._pendingPickUpSelector = null;
    }

    /**
     * Handles clicking a dropped item marker on the spatial map.
     * Opens the pick-up overlay panel with item information.
     * @private
     */
    _handleDroppedItemClick(droppedItemId, droppedItem) {
        // Check range immediately when item is clicked
        const rangeCheckResult = this._checkPickUpRange(droppedItem);
        
        if (!rangeCheckResult.inRange) {
            this.errorController.handleError({
                code: 'OUT_OF_RANGE',
                message: rangeCheckResult.message
            });
            // Fire-and-forget hint suggestion.
            const entityId = this.worldState.getMyEntityId();
            if (entityId && this.hintManager) {
                this.hintManager.onOutOfRangeClick(entityId, droppedItemId);
            }
            return;
        }

        // Item is in range, show overlay and range indicator
        this.pickUpOverlay.show(droppedItem);
        
        // Show range indicator to give visual feedback
        const droid = this.worldState.getActiveDroid();
        if (droid) {
            const state = this.worldState.getState();
            const dropActionData = this.availableActions['dropItem'] || {};
            const rangeExpression = dropActionData?.range;
            
            let maxStrength = 0;
            if (droid.components && Array.isArray(droid.components)) {
                for (const comp of droid.components) {
                    const compId = comp.id || comp;
                    const stats = state.components?.instances?.[compId];
                    if (stats?.Physical?.strength) {
                        maxStrength = Math.max(maxStrength, stats.Physical.strength);
                    }
                }
            }
            
            const pickUpRange = this._resolveDropRange(rangeExpression, maxStrength);
            this.ui.renderRangeIndicator(droid, pickUpRange, AppConfig.COLORS.RANGE.IN_RANGE, 'pickup');
        }
    }

    /**
     * Handles hovering over a dropped item marker on the spatial map.
     * Calculates the pickup range and displays a range circle colored by reachability:
     * green if the item is within range, red if out of range.
     * Returns the range-status color so UIManager can apply it to the marker stroke.
     * @param {string} id - The dropped item ID.
     * @param {Object} item - The dropped item object with x, y coordinates.
     * @returns {string} The range-status color (#44ff44 for in-range, #ff4444 for out-of-range).
     * @private
     */
    _handleDroppedItemHover(id, item) {
        const droid = this.worldState.getActiveDroid();
        if (!droid) return AppConfig.COLORS.RANGE.OUT_OF_RANGE;

        // Only show hover for items in the current room
        if (item.roomId !== droid.location) {
            return AppConfig.COLORS.RANGE.OUT_OF_RANGE;
        }

        const state = this.worldState.getState();
        const pickupRange = this._resolvePickupRange(droid, state);

        // Calculate Euclidean distance from droid to item (center-relative coordinates)
        const droidX = droid.spatial?.x || 0;
        const droidY = droid.spatial?.y || 0;
        const itemX = item.x || 0;
        const itemY = item.y || 0;
        const distance = Math.sqrt(Math.pow(itemX - droidX, 2) + Math.pow(itemY - droidY, 2));

        // Determine color based on whether the item is within pickup range
        const color = distance <= pickupRange
            ? AppConfig.COLORS.RANGE.IN_RANGE
            : AppConfig.COLORS.RANGE.OUT_OF_RANGE;

        // Render the range indicator circle
        this.ui.renderRangeIndicator(droid, pickupRange, color, 'hover-pickup');

        return color;
    }

    /**
     * Handles leaving a dropped item marker on the spatial map.
     * Clears the hover-based range indicator. UIManager resets the marker stroke.
     * @param {string} id - The dropped item ID.
     * @param {Object} item - The dropped item object.
     * @private
     */
    _handleDroppedItemLeave(id, item) {
        this.ui.clearRangeIndicator();
    }

    /**
     * Handles hovering over a room door connection line on the spatial map.
     * Calculates the Euclidean distance from the player entity to the door position
     * and displays a range indicator circle colored by reachability:
     * green if the entity is within range, red if out of range.
     * Range is computed from the entity's Movement.move stat, not from the door.
     *
     * @param {string} doorName - The name of the door (e.g., "right_door").
     * @param {Object} doorPosition - The door position in room-center-relative coordinates {x, y}.
     * @private
     */
    _handleDoorHover(doorName, doorPosition) {
        const droid = this.worldState.getActiveDroid();
        if (!droid) {
            return;
        }

        const state = this.worldState.getState();
        const moveRange = this._getEntityMovementRange(droid, state);

        // If entity has no movement stat, skip range indicator
        if (moveRange === null) {
            return;
        }

        // Calculate Euclidean distance from droid spatial position to door position
        // Both are in room-center-relative coordinates.
        const droidX = droid.spatial?.x || 0;
        const droidY = droid.spatial?.y || 0;
        const doorX = doorPosition.x || 0;
        const doorY = doorPosition.y || 0;
        const distance = Math.sqrt(Math.pow(doorX - droidX, 2) + Math.pow(doorY - droidY, 2));

        // Determine color based on whether the entity is within movement range.
        const color = distance <= moveRange
            ? AppConfig.COLORS.RANGE.IN_RANGE
            : AppConfig.COLORS.RANGE.OUT_OF_RANGE;

        // Render the range indicator circle centered on the droid with the entity's movement range as radius.
        this.ui.renderRangeIndicator(droid, moveRange, color, 'default');
    }

    /**
     * Handles leaving a room door connection line on the spatial map.
     * Clears the hover-based range indicator.
     * @private
     */
    _hideDoorRangeIndicator() {
        this.ui.clearRangeIndicator();
    }

    /**
     * Resolves the pickup range from the dropItem action's range expression.
     * Pickup uses the same range as drop (symmetric reachability).
     * @param {Object} droid - The active droid entity.
     * @param {Object} state - The current world state.
     * @returns {number} The resolved pickup range in pixels.
     * @private
     */
    _resolvePickupRange(droid, state) {
        const dropActionData = this.availableActions['dropItem'] || {};
        const rangeExpression = dropActionData?.range;

        let maxStrength = 0;
        if (droid.components && Array.isArray(droid.components)) {
            for (const comp of droid.components) {
                const compId = comp.id || comp;
                const stats = state.components?.instances?.[compId];
                if (stats?.Physical?.strength) {
                    maxStrength = Math.max(maxStrength, stats.Physical.strength);
                }
            }
        }

        return this._resolveDropRange(rangeExpression, maxStrength);
    }

    /**
     * Checks if the dropped item is within pickup range.
     * @private
     */
    _checkPickUpRange(droppedItem) {
        const droid = this.worldState.getActiveDroid();
        if (!droid) return { inRange: false, message: 'No active droid.' };

        const state = this.worldState.getState();
        const dropActionData = this.availableActions['dropItem'] || {};
        const rangeExpression = dropActionData?.range;

        let maxStrength = 0;
        if (droid.components && Array.isArray(droid.components)) {
            for (const comp of droid.components) {
                const compId = comp.id || comp;
                const stats = state.components?.instances?.[compId];
                if (stats?.Physical?.strength) {
                    maxStrength = Math.max(maxStrength, stats.Physical.strength);
                }
            }
        }

        const pickUpRange = this._resolveDropRange(rangeExpression, maxStrength);
        const droidX = droid.spatial?.x || 0;
        const droidY = droid.spatial?.y || 0;
        const itemX = droppedItem.x || 0;
        const itemY = droppedItem.y || 0;

        const distance = Math.sqrt(Math.pow(itemX - droidX, 2) + Math.pow(itemY - droidY, 2));

        if (distance > pickUpRange) {
            return { 
                inRange: false, 
                message: `Item is out of range. Distance: ${distance.toFixed(2)}, Max Range: ${pickUpRange}` 
            };
        }

        return { inRange: true, distance };
    }

    /**
     * Handles the "Pick Up" button click in the pick-up overlay.
     * Opens the drop selector overlay in pickup mode — mirrors the drop flow.
     * User selects a component, clicks Execute, range indicator appears on map, then map click picks up item.
     * @private
     */
    async _handlePickUpClick(droppedItemInfo) {
        const entityId = this.worldState.getMyEntityId();
        if (!entityId) return;

        const state = this.worldState.getState();
        const entity = state.entities?.[entityId];
        if (!entity || !entity.components || entity.components.length === 0) {
            this.errorController.handleError({
                code: 'NO_COMPONENTS',
                message: 'No components available to pick up this item.'
            });
            this.pickUpOverlay.hide();
            return;
        }

        // Close pick-up overlay and open drop selector in pickup mode
        this.pickUpOverlay.hide();

        // Clear any pending pick-up selector state
        this._pendingPickUpSelector = null;

        // Pass the full item info (including coordinates) to the drop selector
        const fullItemInfo = this.pickUpOverlay._getCurrentItem() || droppedItemInfo;

        this.dropSelector.showPickup({
            pendingPickUpItem: fullItemInfo,
            entityId
        });
    }

    /**
     * Handles clicking on the map during pick-up selector pending state.
     * Mirrors the drop flow: sends pickup request with component IDs.
     * @param {number} targetX - Target X coordinate relative to room center.
     * @param {number} targetY - Target Y coordinate relative to room center.
     * @private
     */
    _onPickUpMapClick(targetX, targetY) {
        if (!this._pendingPickUpSelector) return;

        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();

        this.executor.executePickUpItem(this._pendingPickUpSelector, targetX, targetY, droid, state);
        this._pendingPickUpSelector = null;
    }

    /**
     * Resolves drop range from the action's range expression.
     * Reads from availableActions cache, falls back to hardcoded formula.
     *
     * @param {string} rangeExpression - The range expression (e.g., ":Physical.strength*2+3")
     * @param {number} strength - The max Physical.strength value
     * @returns {number} The resolved drop range
     * @private
     */
    _resolveDropRange(rangeExpression, strength) {
        if (!rangeExpression) {
            return AppConfig.DROP.BASE_RANGE + (strength * AppConfig.MULTIPLIERS.DROP_RANGE);
        }

        // Match tokens: [+|-](:Placeholder[multiplier])
        const tokenRegex = /([+])|(-)?(:[a-zA-Z0-9_.]+)(?:\*(-?\d+))?/g;
        let result = 0;
        let foundPlaceholder = false;

        let match;
        while ((match = tokenRegex.exec(rangeExpression)) !== null) {
            if (match[1] === '+') continue;

            const sign = match[2] === '-' ? -1 : 1;
            const placeholder = match[3] ? match[3].substring(1) : null;
            const multiplier = match[4] ? parseInt(match[4].substring(1), 10) : 1;

            if (placeholder) {
                const value = (placeholder === 'Physical.strength') ? strength : 0;
                result += sign * value * multiplier;
                foundPlaceholder = true;
            }
        }

        if (!foundPlaceholder) {
            return AppConfig.DROP.BASE_RANGE + (strength * AppConfig.MULTIPLIERS.DROP_RANGE);
        }

        return result;
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
import { AppConfig } from './Config.js';
import { WorldStateManager } from './WorldStateManager.js';
import { UIManager } from './UIManager.js';
import { ActionManager } from './ActionManager.js';
import { ClientErrorController } from './ClientErrorController.js';
import { SelectionController } from './SelectionController.js';
import { SynergyPreviewController } from './SynergyPreviewController.js';
import { ActionExecutor } from './ActionExecutor.js';
import { EventDispatcher } from './EventDispatcher.js';

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
 */
export class ClientApp {
    constructor() {
        // 1. Available actions cache (needed by ActionExecutor)
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
            null, // synergy controller (we pass this via fetchPreview)
            this // self-reference for callbacks
        );
        this.synergy = new SynergyPreviewController(this.actions, AppConfig);
        this.executor = new ActionExecutor(
            this.worldState,
            this.actions,
            this.ui,
            this.errorController,
            () => this.refreshWorldAndActions(),
            this.selection,
            this.availableActions
        );

        // 4. Socket connection
        this.socket = io();

        // 5. Wire event dispatcher with handler callbacks
        this.dispatcher = new EventDispatcher(this.socket, AppConfig, {
            setMyEntityId: (entityId) => this.worldState.setMyEntityId(entityId),
            refreshWorldAndActions: () => this.refreshWorldAndActions(),
            handleError: (err) => this.errorController.handleError(err),
            moveToTarget: (actionName, entityId, targetX, targetY) =>
                this.actions.moveToTarget(actionName, entityId, targetX, targetY),
            executeMultiComponentSpatial: (actionName, entityId, componentIds, extraParams) =>
                this.executor.executeMultiComponentSpatial(actionName, entityId, componentIds, extraParams),
            executeGrab: (pending, targetX, targetY) =>
                this.executor.executeGrab(pending, targetX, targetY),
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

        // 6. Setup event listeners
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

        // Release handler (managed by EventDispatcher)
        this.dispatcher.setupReleaseHandler(null, async (entityId, grabbedItemCompId) => {
            const componentType = 'grabbedItem'; // fallback
            const result = await this.actions.executeRelease('release', entityId, grabbedItemCompId);
            console.log('[ClientApp] Release executed successfully:', result);
            this.selection.clearAllSelections();
            await this.refreshWorldAndActions();
        });
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
                (entityId, targetId) => this.executor.executeMoveDroid(entityId, targetId)
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
     * Callback invoked by SelectionController after any selection change.
     * Triggers UI re-render and synergy preview update.
     * Called from: SelectionController.toggleComponent(), removeGrayedComponent(), clearAllSelections()
     * @private
     */
    onSelectionChange() {
        this.updateActionList();

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
                    const synergyMultiplier = this.synergy.getCachedSynergyResult()
                        ? parseFloat(this.synergy.getCachedSynergyResult().synergyMultiplier) || 1.0
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

            const crossMap = this.selection.buildCrossMap();

            this.ui.renderActionList(
                this.availableActions,
                pending,
                (actionName, entityId, compId, compIdentifier) =>
                    this.selection.toggleComponent(actionName, entityId, compId, compIdentifier),
                this.selection.getActiveActionName(),
                this.selection.getSelectedComponentIds(),
                crossMap,
                (lockedActionName, compId) => this.selection.removeGrayedComponent(lockedActionName, compId)
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
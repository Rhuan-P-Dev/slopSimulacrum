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
        
        this.socket = io();
        this._setupSocketListeners();
        this._setupMapClickListener();
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
     * Updates the list of available actions and renders range indicators if a movement action is pending.
     * @returns {Promise<void>}
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
                    const range = this._calculateActionRange(pending.actionName, droid, state);
                    if (range !== null) {
                        const isMovement = pending.actionName === AppConfig.ACTIONS.MOVE || pending.actionName === AppConfig.ACTIONS.DASH;
                        const color = isMovement ? 'white' : 'red';
                        this.ui.renderRangeIndicator(droid, range, color);
                    }
                }
            }

            this.ui.renderActionList(
                this.availableActions, 
                pending, 
                (name, eid, cname, cid) => this.handleActionSelection(name, eid, cname, cid)
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
     * Calculates the effective range of an action.
     * If the action has a static range, it uses that.
     * If it's a movement action, it calculates range based on the droid's stats.
     * @param {string} actionName The name of the action.
     * @param {Object} droid The active droid entity.
     * @param {Object} state The current world state.
     * @returns {number|null} The calculated range or null if cannot be determined.
     */
    _calculateActionRange(actionName, droid, state) {
        const actionData = this.availableActions[actionName];
        if (!actionData) return null;

        // Static range check
        if (actionData.range) return actionData.range;

        // Dynamic movement range
        const isMove = actionName === AppConfig.ACTIONS.MOVE;
        const isDash = actionName === AppConfig.ACTIONS.DASH;

        if (isMove || isDash) {
            if (!droid || !droid.components || !state || !state.components || !state.components.instances) return null;

            // Find a component that possesses the Movement trait
            let moveStat = null;
            for (const comp of droid.components) {
                const stats = state.components.instances[comp.id];
                if (stats && stats.Movement && stats.Movement.move !== undefined) {
                    moveStat = stats.Movement.move;
                    break;
                }
            }

            if (moveStat === null) return null;
            return isDash ? moveStat * AppConfig.MULTIPLIERS.DASH_RANGE : moveStat;
        }

        return null;
    }

    /**
     * Sets up socket.io listeners for real-time server communication.
     * @returns {void}
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
     * Configures the map click handler to process spatial and component targeting.
     * @returns {void}
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
                this.actions.moveToTarget(pending.actionName, pending.entityId, targetX, targetY);
                this.actions.clearPendingAction();
                this.updateActionList();
            } else if (pending.targetingType === 'component') {
                this.handlePunchTarget(pending, targetX, targetY);
            }
        });
    }

    /**
     * Handles targeting for "punch" style actions by finding the closest entity to the clicked coordinates.
     * @param {Object} pending The pending action data.
     * @param {number} targetX The clicked X coordinate.
     * @param {number} targetY The clicked Y coordinate.
     * @returns {Promise<void>}
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

        // Find closest entity within tolerance to avoid ambiguous selection
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

        this.ui.showComponentSelection(closestEntity, state, async (compId) => {
            try {
                await this.actions.executePunch(pending.actionName, pending.entityId, compId);
                this.ui.closeDetails();
                this.actions.clearPendingAction();
                await this.refreshWorldAndActions();
            } catch (error) {
                // ActionManager already handles the error reporting via errorController
            }
        });
    }

    /**
     * Executes a movement request for an entity to a specific room.
     * @param {string} entityId The ID of the entity to move.
     * @param {string} targetRoomId The ID of the target room.
     * @returns {Promise<void>}
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

    /**
     * Handles the selection of an action from the UI list.
     * @param {string} actionName The name of the selected action.
     * @param {string} entityId The entity performing the action.
     * @param {string} componentName The name of the target component.
     * @param {string} componentIdentifier The unique ID of the target component.
     * @returns {Promise<void>}
     */
    async handleActionSelection(actionName, entityId, componentName, componentIdentifier) {
        const actionData = this.availableActions[actionName];
        await this.actions.executeAction(
            actionName, 
            entityId, 
            componentName, 
            componentIdentifier, 
            actionData,
            () => this.updateActionList()
        );
    }
}

// Bootstrap the application
const app = new ClientApp();
app.init();

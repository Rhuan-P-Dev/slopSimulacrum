import { AppConfig } from './Config.js';
import { WorldStateManager } from './WorldStateManager.js';
import { UIManager } from './UIManager.js';
import { ActionManager } from './ActionManager.js';

/**
 * ClientApp
 * The main orchestrator for the SlopSimulacrum client.
 * Coordinates communication between WorldStateManager, UIManager, and ActionManager.
 */
export class ClientApp {
    constructor() {
        this.worldState = new WorldStateManager();
        this.ui = new UIManager();
        this.actions = new ActionManager(this.ui);
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
            this.ui.setStatus(`Initialization Error: ${error.message}`, true);
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
            this.ui.setStatus(`Connection Error: ${error.message}`, true);
        }
    }

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
                        const color = (pending.actionName === 'move' || pending.actionName === 'dash') ? 'white' : 'red';
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
        if (actionName === 'move' || actionName === 'dash') {
            if (!droid || !droid.components || !state || !state.components || !state.components.instances) return null;

            // Find a component that possesses the Movimentation trait
            let moveStat = null;
            for (const comp of droid.components) {
                const stats = state.components.instances[comp.id];
                if (stats && stats.Movimentation && stats.Movimentation.move !== undefined) {
                    moveStat = stats.Movimentation.move;
                    break;
                }
            }

            if (moveStat === null) return null;
            return actionName === 'dash' ? moveStat * 2 : moveStat;
        }

        return null;
    }

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
            this.ui.setStatus(data.message, true);
        });
    }

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

    async handlePunchTarget(pending, targetX, targetY) {
        const droid = this.worldState.getActiveDroid();
        const state = this.worldState.getState();
        if (!droid || !state) return;

        const actionData = this.availableActions[pending.actionName];
        const range = actionData?.range || 0;

        const dx = targetX - droid.spatial.x;
        const dy = targetY - droid.spatial.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > range) {
            this.ui.setStatus(`Target out of range (${Math.round(distance)}px > ${range}px)`, true);
            return;
        }

        // Find entity at target location (with a small tolerance)
        const tolerance = AppConfig.TARGETING.PUNCH_TOLERANCE;
        const targetEntity = Object.values(state.entities).find(e => {
            const edx = targetX - e.spatial.x;
            const edy = targetY - e.spatial.y;
            return Math.sqrt(edx * edx + edy * edy) < tolerance;
        });

        if (!targetEntity) {
            this.ui.setStatus("No target entity found at this location", true);
            return;
        }

        this.ui.showComponentSelection(targetEntity, state, async (compId) => {
            try {
                await this.actions.executePunch(pending.actionName, pending.entityId, compId);
                this.ui.closeDetails();
                this.actions.clearPendingAction();
                await this.refreshWorldAndActions();
            } catch (error) {
                this.ui.setStatus(`Punch failed: ${error.message}`, true);
            }
        });
    }

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
            this.ui.setStatus('System Error: ' + error.message, true);
        }
    }

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

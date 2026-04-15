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
                this.ui._renderEntities(room, state.entities, (entity) => this.ui.showEntityDetails(entity, state));
                this.ui._renderDroidComponents(droid, state, (comp, stats) => this.ui.showComponentDetails(comp, stats));
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
                const actionData = this.availableActions[pending.actionName];
                if (actionData.range) {
                    const droid = this.worldState.getActiveDroid();
                    if (droid) {
                        this.ui.renderRangeIndicator(droid, actionData.range);
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

            if (pending.actionName === 'move' || pending.actionName === 'dash') {
                this.actions.moveToTarget(pending.actionName, pending.entityId, targetX, targetY);
                this.actions.clearPendingAction();
                this.updateActionList();
            } else if (pending.actionName === 'droid punch') {
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
        const tolerance = 20;
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
            alert('System Error: ' + error.message);
        }
    }

    async handleActionSelection(actionName, entityId, componentName, componentIdentifier) {
        await this.actions.executeAction(
            actionName, 
            entityId, 
            componentName, 
            componentIdentifier, 
            () => this.updateActionList()
        );
    }
}

// Bootstrap the application
const app = new ClientApp();
app.init();

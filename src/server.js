import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import LLMController from './controllers/LLMController.js';
import WorldStateController from './controllers/WorldStateController.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.static('public'));

// Initialize Controllers
const llmController = new LLMController();
const worldStateController = new WorldStateController();

/**
 * Broadcasts the current world state to all connected clients via Socket.io.
 */
function broadcastWorldState() {
    try {
        const state = worldStateController.getAll();
        if (!state) {
            console.warn('[Socket] Warning: Attempted to broadcast null/undefined world state');
            return;
        }
        
        const clientCount = io.engine.clientsCount;
        io.emit('world-state-update', { state });
        console.log(`[Socket] World state broadcasted to ${clientCount} connected clients at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
        console.error(`[Server Error] Failed to broadcast world state: ${error.message}`);
    }
}

// Socket.io state management
const socketToEntityMap = new Map();

/**
 * Handle WebSocket connections and "Incarnation"
 */
io.on('connection', (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    // 1. Determine a starting room (use public API wrapper)
    let startRoomId = worldStateController.getRoomUidByLogicalId('start_room');
    
    // Fallback if start_room is not found (use public API)
    if (!startRoomId) {
        const allRooms = worldStateController.getAll().rooms;
        const roomIds = Object.keys(allRooms || {});
        if (roomIds.length > 0) {
            startRoomId = roomIds[0];
        }
    }

    if (!startRoomId) {
        console.error('[Socket Error] No valid room found for incarnation.');
        socket.emit('error', { message: 'World initialization error: No rooms available.' });
        return;
    }

    // 2. Incarnate the player: Spawn an entity (use public API wrapper)
    const entityId = worldStateController.spawnEntity('smallBallDroid', startRoomId);
    socketToEntityMap.set(socket.id, entityId);

    console.log(`[Socket] Player ${socket.id} incarnated as entity ${entityId} in room ${startRoomId}`);

    // 3. Notify the client of its incarnation
    socket.emit('incarnate', { entityId });

    // 4. Handle disconnection (use public API wrapper)
    socket.on('disconnect', () => {
        const entityIdToRemove = socketToEntityMap.get(socket.id);
        if (entityIdToRemove) {
            console.log(`[Socket] Player ${socket.id} disconnected. Despawning entity ${entityIdToRemove}`);
            worldStateController.despawnEntity(entityIdToRemove);
            socketToEntityMap.delete(socket.id);
        }
    });
});

/**
 * POST /chat
 * Endpoint to handle chat requests.
 * Expects a JSON payload with a 'messages' array.
 */
app.post('/chat', async (req, res) => {
    const { messages } = req.body;

    // Input Validation
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({
            error: 'Invalid request. "messages" array is required.'
        });
    }

    try {
        // Use the LLMController as the single source of truth for LLM communication
        const response = await llmController.chat(messages);
        res.json({ response });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * GET /actions
 * Returns actions. If entityId is provided, returns only actions relevant to that entity.
 * Logic is decoupled into ActionController.getActionCapabilities/getActionsForEntity.
 */
app.get('/actions', (req, res) => {
    try {
        const state = worldStateController.getAll();
        const { entityId } = req.query;

        let actionStatus;
        if (entityId) {
            actionStatus = worldStateController.actionController.getActionsForEntity(state, entityId);
        } else {
            actionStatus = worldStateController.actionController.getActionCapabilities(state);
        }
        
        res.json({ actions: actionStatus });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

/**
 * GET /action-capabilities
 * Returns the cached action capability data for all actions.
 * Each entry includes the best component(s) for executing the action.
 * Delegates to ComponentCapabilityController.
 */
app.get('/action-capabilities', (req, res) => {
    try {
        const capabilities = worldStateController.componentCapabilityController.getCachedCapabilities();
        res.json({ capabilities });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

/**
 * GET /action-capabilities/:actionName
 * Returns the best component for a specific action across all entities.
 * Delegates to ComponentCapabilityController.
 * @param {string} actionName - The name of the action (e.g., "move", "dash").
 */
app.get('/action-capabilities/:actionName', (req, res) => {
    try {
        const { actionName } = req.params;
        const bestComponent = worldStateController.componentCapabilityController.getBestComponentForAction(actionName);

        if (!bestComponent) {
            return res.status(404).json({
                error: 'Action not found or no entity can execute it.',
                actionName
            });
        }

        res.json({ actionName, bestComponent });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

/**
 * GET /action-capabilities/entity/:entityId
 * Returns all capability entries for a specific entity across all actions.
 * Each entry represents one component's ability to perform one action.
 * Delegates to ComponentCapabilityController.
 * @param {string} entityId - The entity ID.
 */
app.get('/action-capabilities/entity/:entityId', (req, res) => {
    try {
        const { entityId } = req.params;
        const capabilities = worldStateController.componentCapabilityController.getCapabilitiesForEntity(entityId);

        if (capabilities.length === 0) {
            return res.status(404).json({
                error: 'No capabilities found for this entity.',
                entityId
            });
        }

        res.json({ entityId, capabilities });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

/**
 * POST /refresh-entity-capabilities
 * Re-evaluates all action capabilities for a specific entity.
 * Called when an entity's component set changes (e.g., picks up/drops an item).
 * Delegates to ComponentCapabilityController.
 * Expects: { "entityId": "..." }
 */
app.post('/refresh-entity-capabilities', (req, res) => {
    const { entityId } = req.body;

    if (!entityId) {
        return res.status(400).json({
            error: 'Invalid request. "entityId" is required.'
        });
    }

    try {
        const state = worldStateController.getAll();
        const updatedEntries = worldStateController.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
        res.json({ entityId, updatedEntries });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * POST /execute-action
 * Endpoint to execute an action on an entity.
 * Expects: { "actionName": "move", "entityId": "...", "params": {} }
 */
app.post('/execute-action', (req, res) => {
    const { actionName, entityId, params } = req.body;

    if (!actionName || !entityId) {
        return res.status(400).json({
            error: 'Invalid request. "actionName" and "entityId" are required.'
        });
    }

    try {
        // Expire stale selections before executing any action
        worldStateController.actionSelectController.expireStaleSelections();

        const result = worldStateController.actionController.executeAction(actionName, entityId, params);

        // Build response with synergy preview for successful executions
        const responseResult = { ...result };
        if (result.success && result.synergy) {
            responseResult.synergyPreview = {
                multiplier: result.synergy.synergyMultiplier,
                finalValue: result.synergy.finalValue,
                capped: result.synergy.capped,
                capKey: result.synergy.capKey,
                contributingComponents: result.synergy.contributingComponents.map((c) => ({
                    componentId: c.componentId,
                    entityId: c.entityId,
                    componentType: c.componentType,
                    contribution: c.contribution
                })),
                summary: result.synergy.summary
            };
        }

        // Only broadcast world state on successful action execution
        if (result.success) {
            broadcastWorldState();
        }
        res.json({ result: responseResult });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * POST /move-entity
 * Endpoint to move an entity to a different room.
 * Expects: { "entityId": "...", "targetRoomId": "..." }
 */
app.post('/move-entity', (req, res) => {
    const { entityId, targetRoomId } = req.body;

    if (!entityId || !targetRoomId) {
        return res.status(400).json({
            error: 'Invalid request. "entityId" and "targetRoomId" are required.'
        });
    }

    try {
        // Use public API wrapper instead of direct sub-controller access
        const success = worldStateController.moveEntity(entityId, targetRoomId);
        if (success) {
            broadcastWorldState();
            res.json({ message: 'Entity moved successfully.' });
        } else {
            res.status(404).json({ error: 'Entity not found.' });
        }
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * GET /world-state
 * Endpoint to retrieve the current state of the world.
 * Returns rooms with coordinates, entities with spatial data, and components.
 */
app.get('/world-state', (req, res) => {
    try {
        const state = worldStateController.getAll();
        res.json({ state });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * GET /rooms
 * Endpoint to retrieve all rooms with their coordinates.
 */
app.get('/rooms', (req, res) => {
    try {
        const rooms = worldStateController.roomsController.getAll();
        res.json({ rooms });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

// =========================================================================
// SYNERGY ENDPOINTS
// =========================================================================

/**
 * GET /synergy/actions
 * Returns all actions that have synergy enabled.
 */
app.get('/synergy/actions', (req, res) => {
    try {
        const actionsWithSynergy = worldStateController.getActionsWithSynergy();
        res.json({ actionsWithSynergy });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * GET /synergy/config/:actionName
 * Returns the synergy configuration for a specific action.
 * @param {string} actionName - The action name
 */
app.get('/synergy/config/:actionName', (req, res) => {
    try {
        const { actionName } = req.params;
        const config = worldStateController.getSynergyConfig(actionName);
        res.json({ actionName, synergyConfig: config });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * POST /synergy/preview
 * Previews synergy computation for an action without executing it.
 * Expects: { "actionName": "...", "entityId": "...", "componentIds": [...], "synergyGroups": [...] }
 * - componentIds: Array of {componentId, role} for client-provided component synergy
 * - synergyGroups: Optional multi-entity synergy groups (legacy)
 */
app.post('/synergy/preview', (req, res) => {
    const { actionName, entityId, componentIds, synergyGroups } = req.body;

    if (!actionName || !entityId) {
        return res.status(400).json({
            error: 'Invalid request. "actionName" and "entityId" are required.'
        });
    }

    try {
        const context = {};
        if (componentIds && Array.isArray(componentIds) && componentIds.length > 0) {
            context.providedComponentIds = componentIds;
        }
        if (synergyGroups) {
            context.synergyGroups = synergyGroups;
        }

        const synergyResult = worldStateController.computeSynergy(actionName, entityId, context);
        res.json({ synergyResult });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

// =========================================================================
// Component Selection Endpoints
// =========================================================================

/**
 * POST /select-components
 * Lock multiple components to a specific action (batch selection).
 * Expects: { "actionName": "...", "entityId": "...", "components": [{ "componentId": "...", "role": "..." }] }
 */
app.post('/select-components', (req, res) => {
    const { actionName, entityId, components } = req.body;

    if (!actionName || !entityId || !components || !Array.isArray(components) || components.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Invalid request. "actionName", "entityId", and non-empty "components" array are required.'
        });
    }

    try {
        const result = worldStateController.actionSelectController.registerSelections(
            actionName, entityId, components
        );
        res.json(result);
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * POST /select-component
 * Lock a component to a specific action (enforces "one component, one action" rule).
 * Expects: { "actionName": "...", "entityId": "...", "componentId": "...", "role": "..." }
 */
app.post('/select-component', (req, res) => {
    const { actionName, entityId, componentId, role } = req.body;

    if (!actionName || !entityId || !componentId || !role) {
        return res.status(400).json({
            success: false,
            error: 'Invalid request. "actionName", "entityId", "componentId", and "role" are required.'
        });
    }

    try {
        const result = worldStateController.actionSelectController.registerSelection(
            actionName, componentId, entityId, role
        );
        res.json(result);
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * POST /release-selection
 * Release (unlock) a component selection.
 * Expects: { "componentId": "..." }
 */
app.post('/release-selection', (req, res) => {
    const { componentId } = req.body;

    if (!componentId) {
        return res.status(400).json({
            success: false,
            error: 'Invalid request. "componentId" is required.'
        });
    }

    try {
        const released = worldStateController.actionSelectController.releaseSelection(componentId);
        res.json({ success: true, released });
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * GET /selections/:entityId
 * Get all current component selections for an entity.
 */
app.get('/selections/:entityId', (req, res) => {
    const { entityId } = req.params;

    if (!entityId) {
        return res.status(400).json({
            error: 'Invalid request. entityId is required.'
        });
    }

    try {
        const selections = worldStateController.actionSelectController.getLockedComponents(entityId);
        res.json(selections);
    } catch (error) {
        console.error(`[Server Error] ${error.message}`);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

server.listen(port, () => {
    console.log(`SlopSimulacrum Server running at http://localhost:${port}`);
});

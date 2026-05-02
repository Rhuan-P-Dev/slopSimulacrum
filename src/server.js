import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import LLMController from './controllers/LLMController.js';
import WorldStateController from './controllers/WorldStateController.js';
import Logger from './utils/Logger.js';

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
 * @returns {void}
 */
function broadcastWorldState() {
    try {
        const worldState = worldStateController.getAll();
        if (!worldState) {
            Logger.warn('Attempted to broadcast null/undefined world state');
            return;
        }
        
        const clientCount = io.engine.clientsCount;
        io.emit('world-state-update', { state: worldState });
        Logger.info('World state broadcasted', { clientCount, time: new Date().toLocaleTimeString() });
    } catch (error) {
        Logger.error('Failed to broadcast world state', { error: error.message });
    }
}

// Socket.io state management
const socketToEntityMap = new Map();

/**
 * Clean up socket-to-entity mapping on socket error.
 * Prevents orphaned entries in socketToEntityMap when sockets fail unexpectedly.
 * @param {string} socketId - The socket ID to clean up.
 */
function cleanupSocketMapping(socketId) {
    const entityId = socketToEntityMap.get(socketId);
    if (entityId) {
        Logger.warn('Cleaning up socket mapping after error', { socketId, entityId });
        worldStateController.despawnEntity(entityId);
        socketToEntityMap.delete(socketId);
    }
}

/**
 * Handle WebSocket connections and "Incarnation".
 * - Spawns a player entity for each connected client.
 * - Maps socket IDs to entity IDs for lifecycle management.
 * - Cleans up entities on disconnect or error.
 * @param {import('socket.io').Socket} socket - The client socket connection.
 */
io.on('connection', (socket) => {
    Logger.info('New socket connection', { socketId: socket.id });

    // Handle socket errors to prevent orphaned entity mappings
    socket.on('error', (error) => {
        Logger.error('Socket error', { socketId: socket.id, error: error.message });
        cleanupSocketMapping(socket.id);
    });

    try {
        // 1. Determine a starting room (use public API wrapper)
        let startRoomId = worldStateController.getRoomUidByLogicalId('start_room');
        
        // Fallback if start_room is not found (use public API)
        if (!startRoomId) {
            const availableRooms = worldStateController.getAll().rooms;
            const availableRoomIds = Object.keys(availableRooms || {});
            if (availableRoomIds.length > 0) {
                startRoomId = availableRoomIds[0];
            }
        }

        if (!startRoomId) {
            Logger.critical('No valid room found for incarnation', { socketId: socket.id });
            socket.emit('error', { message: 'World initialization error: No rooms available.' });
            return;
        }

        // 2. Incarnate the player: Spawn an entity (use public API wrapper)
        const entityId = worldStateController.spawnEntity('smallBallDroid', startRoomId);
        socketToEntityMap.set(socket.id, entityId);

        Logger.info('Player incarnated', { socketId: socket.id, entityId, roomId: startRoomId });

        // 3. Notify the client of its incarnation
        socket.emit('incarnate', { entityId });
    } catch (error) {
        Logger.error('Failed to incarnate player', { socketId: socket.id, error: error.message });
        socket.emit('error', { message: 'Failed to incarnate player entity.' });
        cleanupSocketMapping(socket.id);
        return;
    }

    // 4. Handle disconnection (use public API wrapper)
    socket.on('disconnect', () => {
        const entityIdToRemove = socketToEntityMap.get(socket.id);
        if (entityIdToRemove) {
            Logger.info('Player disconnected, despawning entity', { socketId: socket.id, entityId: entityIdToRemove });
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
        Logger.error('Chat endpoint error', { error: error.message });
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
        const { entityId } = req.query;

        let actionStatus;
        if (entityId) {
            actionStatus = worldStateController.getActionsForEntity(entityId);
        } else {
            actionStatus = worldStateController.getActionCapabilities();
        }
        
        res.json({ actions: actionStatus });
    } catch (error) {
        Logger.error('/actions endpoint error', { error: error.message });
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
        const capabilities = worldStateController.getCachedCapabilities();
        res.json({ capabilities });
    } catch (error) {
        Logger.error('/action-capabilities endpoint error', { error: error.message });
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
        const bestComponent = worldStateController.getBestComponentForAction(actionName);

        if (!bestComponent) {
            return res.status(404).json({
                error: 'Action not found or no entity can execute it.',
                actionName
            });
        }

        res.json({ actionName, bestComponent });
    } catch (error) {
        Logger.error('/action-capabilities/:actionName endpoint error', { error: error.message, actionName });
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
        const capabilities = worldStateController.getCapabilitiesForEntity(entityId);

        if (capabilities.length === 0) {
            return res.status(404).json({
                error: 'No capabilities found for this entity.',
                entityId
            });
        }

        res.json({ entityId, capabilities });
    } catch (error) {
        Logger.error('/action-capabilities/entity/:entityId endpoint error', { error: error.message, entityId });
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
        const updatedEntries = worldStateController.reEvaluateEntityCapabilities(entityId);
        res.json({ entityId, updatedEntries });
    } catch (error) {
        Logger.error('/refresh-entity-capabilities endpoint error', { error: error.message, entityId });
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
        worldStateController.expireStaleSelections();

        const result = worldStateController.executeAction(actionName, entityId, params);

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
        Logger.error('/execute-action endpoint error', { error: error.message, actionName, entityId });
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
        Logger.error('/move-entity endpoint error', { error: error.message, entityId, targetRoomId });
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
        const worldState = worldStateController.getAll();
        res.json({ state: worldState });
    } catch (error) {
        Logger.error('/world-state endpoint error', { error: error.message });
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
        const rooms = worldStateController.getRooms();
        res.json({ rooms });
    } catch (error) {
        Logger.error('/rooms endpoint error', { error: error.message });
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
        Logger.error('/synergy/actions endpoint error', { error: error.message });
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
        Logger.error('/synergy/config/:actionName endpoint error', { error: error.message, actionName });
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
        Logger.error('/synergy/preview endpoint error', { error: error.message, actionName, entityId });
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

/**
 * POST /synergy/preview-data
 * Enhanced synergy preview: returns action definition, resolved consequence values,
 * and synergy result for a given component selection.
 * Used by the frontend to display action data (single component) and synergy
 * with modified values (multi-component).
 *
 * Expects: { "actionName": "...", "entityId": "...", "componentIds": [...] }
 * Returns: { actionData, resolvedValues, synergyResult }
 */
app.post('/synergy/preview-data', (req, res) => {
    const { actionName, entityId, componentIds } = req.body;

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

        const previewData = worldStateController.previewActionData(actionName, entityId, context);
        res.json({ actionPreviewData: previewData });
    } catch (error) {
        Logger.error('/synergy/preview-data endpoint error', { error: error.message, actionName, entityId });
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
        const result = worldStateController.registerSelections(
            actionName, entityId, components
        );
        res.json(result);
    } catch (error) {
        Logger.error('/select-components endpoint error', { error: error.message, actionName, entityId });
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
        const result = worldStateController.registerSelection(
            actionName, componentId, entityId, role
        );
        res.json(result);
    } catch (error) {
        Logger.error('/select-component endpoint error', { error: error.message, actionName, entityId, componentId });
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
        const released = worldStateController.releaseSelection(componentId);
        res.json({ success: true, released });
    } catch (error) {
        Logger.error('/release-selection endpoint error', { error: error.message, componentId });
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
        const selections = worldStateController.getLockedComponents(entityId);
        res.json(selections);
    } catch (error) {
        Logger.error('/selections/:entityId endpoint error', { error: error.message, entityId });
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
    }
});

server.listen(port, () => {
    Logger.info('SlopSimulacrum Server running', { port, url: `http://localhost:${port}` });
});

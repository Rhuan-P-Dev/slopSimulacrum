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

    // 1. Determine a starting room
    let startRoomId = worldStateController.roomsController.getUidByLogicalId('start_room');
    
    // Fallback if start_room is not found
    if (!startRoomId) {
        const rooms = worldStateController.roomsController.getAll();
        const roomIds = Object.keys(rooms);
        if (roomIds.length > 0) {
            startRoomId = roomIds[0];
        }
    }

    if (!startRoomId) {
        console.error('[Socket Error] No valid room found for incarnation.');
        socket.emit('error', { message: 'World initialization error: No rooms available.' });
        return;
    }

    // 2. Incarnate the player: Spawn an entity
    const entityId = worldStateController.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    socketToEntityMap.set(socket.id, entityId);

    console.log(`[Socket] Player ${socket.id} incarnated as entity ${entityId} in room ${startRoomId}`);

    // 3. Notify the client of its incarnation
    socket.emit('incarnate', { entityId });

    // 4. Handle disconnection
    socket.on('disconnect', () => {
        const entityIdToRemove = socketToEntityMap.get(socket.id);
        if (entityIdToRemove) {
            console.log(`[Socket] Player ${socket.id} disconnected. Despawning entity ${entityIdToRemove}`);
            worldStateController.stateEntityController.despawnEntity(entityIdToRemove);
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
        const result = worldStateController.actionController.executeAction(actionName, entityId, params);
        broadcastWorldState();
        res.json({ result });
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
        const success = worldStateController.stateEntityController.moveEntity(entityId, targetRoomId);
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

server.listen(port, () => {
    console.log(`SlopSimulacrum Server running at http://localhost:${port}`);
});

const express = require('express');
const LLMController = require('./controllers/LLMController');
const WorldStateController = require('./controllers/WorldStateController');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.static('public'));

// Initialize Controllers
const llmController = new LLMController();
const worldStateController = new WorldStateController();

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

app.listen(port, () => {
    console.log(`SlopSimulacrum Server running at http://localhost:${port}`);
});

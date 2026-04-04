const express = require('express');
const LLMController = require('./controllers/LLMController');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Initialize LLM Controller
const llmController = new LLMController();

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

app.listen(port, () => {
    console.log(`SlopSimulacrum Server running at http://localhost:${port}`);
});

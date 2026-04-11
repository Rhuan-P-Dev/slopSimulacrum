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
 * GET /actions
 * Returns all actions with current entity status for each requirement.
 */
app.get('/actions', (req, res) => {
    try {
        const state = worldStateController.getAll();
        const actions = worldStateController.actionController.getRegistry();
        
        // For each action, check each entity's components
        const actionStatus = {};
        
        for (const [actionName, actionData] of Object.entries(actions)) {
            const entitiesWithAbility = [];
            
            for (const [entityId, entity] of Object.entries(state.entities || {})) {
                const capableComponents = [];
                
                // Check if the entity meets action requirements via ActionController
                const requirementCheck = worldStateController.actionController.checkRequirements(actionName, entityId);
                if (requirementCheck.passed) {
                    const component = entity.components.find(c => c.id === requirementCheck.componentId);
                    if (component) {
                        capableComponents.push({
                            type: component.type,
                            identifier: component.identifier,
                            currentValue: requirementCheck.traitValue
                        });
                    }
                }
                
                if (capableComponents.length > 0) {
                    // Map all requirements to their current and required values for this entity
                    const requirementsStatus = actionData.requirements.map(req => {
                        // Find the value for this specific requirement from the component's stats
                        // Note: This assumes the component that satisfied the requirements also contains all required stats
                        const component = entity.components.find(c => c.id === requirementCheck.componentId);
                        const stats = worldStateController.componentController.getComponentStats(component.id);
                        
                        return {
                            trait: req.trait,
                            stat: req.stat,
                            current: stats[req.trait]?.[req.stat] ?? 0,
                            required: req.minValue
                        };
                    });

                    entitiesWithAbility.push({
                        entityId,
                        componentName: capableComponents[0].type,
                        componentIdentifier: capableComponents[0].identifier,
                        requirementsStatus
                    });
                }
            }
            
            actionStatus[actionName] = {
                requirements: actionData.requirements,
                canExecute: entitiesWithAbility,
                cannotExecute: Object.keys(state.entities || {}).filter(
                    eId => !entitiesWithAbility.some(ent => ent.entityId === eId)
                ).map(eId => {
                    const entity = state.entities[eId];
                    let componentData = null;

                    if (actionData.requirements && actionData.requirements.length > 0) {
                        const firstReq = actionData.requirements[0];
                        const matchingComponent = entity.components.find(c => {
                            const stats = worldStateController.componentController.getComponentStats(c.id);
                            return stats && stats[firstReq.trait];
                        });
                        
                        if (matchingComponent) {
                            const stats = worldStateController.componentController.getComponentStats(matchingComponent.id);
                            componentData = {
                                type: matchingComponent.type,
                                identifier: matchingComponent.identifier,
                                stats: stats
                            };
                        }
                    }

                    return { 
                        entityId: eId,
                        componentName: componentData?.type || "Unknown",
                        componentIdentifier: componentData?.identifier || "N/A",
                        stats: componentData?.stats || null
                    };
                })
            };
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

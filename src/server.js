import bootstrapServer from './utils/serverBootstrap.js';
import LLMController from './controllers/networking/LLMController.js';
import LLMAgentController from './controllers/networking/LLMAgentController.js';
import NpcAIController from './controllers/ai/NpcAIController.js';
import { buildWorldState } from './composition/WorldComposition.js';
import SocketLifecycleController from './controllers/networking/SocketLifecycleController.js';
import WorldStateBroadcastService from './services/WorldStateBroadcastService.js';
import { registerRoutes } from './routes/index.js';
import Logger from './utils/Logger.js';
import { UniversalTickSystem } from './utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from './utils/Constants.js';

// 1. Bootstrap server (Express + HTTP + Socket.IO)
const { app, server, io } = bootstrapServer();

// 2. Initialize the Universal Tick System (e.g., 60 ticks per second)
const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);

// 3. Initialize controllers
const llmController = new LLMController();
// FASE 5: the world state graph (facade + all sub-controllers) is built by the
// composition root, which handles topological construction and facade injection.
const { worldStateController, subControllers } = buildWorldState(tickSystem);

// 4. Initialize broadcast service
const broadcastService = new WorldStateBroadcastService(io, worldStateController);

// 5. Register socket lifecycle
const socketLifecycle = new SocketLifecycleController(worldStateController, io);
socketLifecycle.registerHandlers();

// 6. Register all routes
registerRoutes(app, llmController, worldStateController, broadcastService);

// 7. Inject broadcast service into WorldStateController for stat-change-driven broadcasts
worldStateController.setBroadcastService(broadcastService);

// 7b. Feature A (spec §5.3): give the turn system its broadcaster (full-state
//     broadcasts after resolution + the dedicated turn-round-update transition
//     event).
if (worldStateController.turnSystemController) {
    worldStateController.turnSystemController.setBroadcaster(broadcastService);
    Logger.info('[Server] Turn system wired (broadcaster set)');
}

// 7c. Feature D backend (spec §7.3): the room chat layer needs the broadcast
//     service for the global `room-chat-message` emit.
if (subControllers.roomChatController) {
    subControllers.roomChatController.setBroadcaster(broadcastService);
    Logger.info('[Server] Room chat wired (broadcaster set; POST/GET /rooms/:roomId/chat)');
}

// 7d. Feature C (spec §6.6) + AI system (spec §4.4): construct the NPC LLM agent (LLM
//     tier — built HERE, not in the composition root) AND the deterministic AI brain.
//     The dispatcher routes NPCs with `ai.behavior` to the brain; others go to LLM.
const llmAgentController = new LLMAgentController({
    llmController,
    worldStateController,
    llmContextController: worldStateController.llmContextController,
    roomChatController: worldStateController.roomChatController,
    turnSystemController: worldStateController.turnSystemController
});

// Build the deterministic AI brain (outside composition root — spec §A6).
const npcAIController = new NpcAIController({
    worldStateController,
    turnSystemController: worldStateController.turnSystemController
});

if (worldStateController.turnSystemController) {
    worldStateController.turnSystemController.setNpcAgent((npcEntityId, round) => {
        const entity = worldStateController.getEntity(npcEntityId);
        if (NpcAIController.hasDeterministicBrain(entity)) {
            // Deterministic NPC → brain (synchronous, stateless; pass pre-fetched entity to avoid double-fetch).
            return Promise.resolve(npcAIController.think(npcEntityId, round, entity));
        }
        // LLM NPC → fallback to LLM agent.
        return llmAgentController.runRound(npcEntityId, round);
    });
    Logger.info('[Server] NPC agent wired (dispatcher: NpcAIController brain for deterministic NPCs → turn system agent hook)');
}

// 7b. Wire the per-agent action-outcome feedback store into the NPC agent
// controller so pre-validation failures (Capture Point B) are recorded.
if (worldStateController.llmAgentFeedbackController) {
    llmAgentController.setFeedbackController(worldStateController.llmAgentFeedbackController);
    Logger.info('[Server] LLM Agent feedback store wired (LLMAgentController → setFeedbackController)');
}

// 8. Trigger initial broadcast to sync full initial state (including spawn items) to connected clients
worldStateController.triggerInitialBroadcast();

// 9. START THE WORLD (Start the Tick System)
tickSystem.start();

// 10. Graceful shutdown for unified tick system
let isShuttingDown = false;

function gracefulShutdown(signal) {
    // Prevent duplicate shutdown sequences
    if (isShuttingDown) {
        Logger.warn(`[Server] ${signal} received during shutdown — ignoring duplicate`);
        return;
    }
    isShuttingDown = true;

    Logger.info(`[Server] ${signal} received. Shutting down gracefully...`);

    // Stop the Universal Tick System
    if (tickSystem) {
        tickSystem.stop();
    }

    // Force disconnect all connected Socket.IO clients.
    // This prevents server.close() from hanging on browsers that do not
    // close their WebSocket connections promptly during page unload.
    if (io && io.sockets && io.sockets.sockets) {
        const socketCount = io.sockets.sockets.size;
        if (socketCount > 0) {
            Logger.info(`[Server] Force disconnecting ${socketCount} connected client(s)...`);
            // Iterate over connected sockets and call disconnect(true) on each.
            // Socket.IO 4.x stores connected sockets in the 'sockets' Map.
            for (const [socketId, socket] of io.sockets.sockets) {
                socket.disconnect(true); // true = force immediate disconnect, no close packet
            }
        }
    }

    // Close Socket.IO server
    if (io) {
        io.close();
    }

    // Close HTTP server (now fast because all clients are already disconnected)
    server.close(() => {
        Logger.info('[Server] Server closed.');
        process.exit(0);
    });

    // Force exit after 10 seconds if server.close() still hangs (safety net)
    setTimeout(() => {
        Logger.error('[Server] Forced shutdown after timeout.');
        process.exit(1);
    }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
import dotenv from 'dotenv';
import bootstrapServer from './utils/serverBootstrap.js';
import LLMController from './controllers/networking/LLMController.js';
import LLMAgentController from './controllers/networking/LLMAgentController.js';
import AgentBodyController from './controllers/networking/AgentBodyController.js';
import WorldAuthoringController from './controllers/networking/WorldAuthoringController.js';
import ModPackageWriter from './services/ModPackageWriter.js';
import WorldOperatorService from './services/WorldOperatorService.js';
import NpcAIController from './controllers/ai/NpcAIController.js';
import { buildWorldState } from './composition/WorldComposition.js';
import SocketLifecycleController from './controllers/networking/SocketLifecycleController.js';
import WorldStateBroadcastService from './services/WorldStateBroadcastService.js';
import { registerRoutes } from './routes/index.js';
import Logger from './utils/Logger.js';
import { UniversalTickSystem } from './utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND, FORCED_SHUTDOWN_TIMEOUT_MS } from './utils/Constants.js';

// 0. Load .env into process.env, before any other boot step reads env (all
//    reads are function-time, so this step-0 ordering is sufficient). Existing
//    process.env entries (shell-exported values) win via dotenv's no-override
//    default — the file only provides defaults.
dotenv.config();

// 1. Bootstrap server (Express + HTTP + Socket.IO)
const { app, server, io } = bootstrapServer();

// 2. Initialize the Universal Tick System (e.g., 60 ticks per second)
const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);

// 3. Initialize controllers
const llmController = new LLMController();
// FASE 5: the world state graph (facade + all sub-controllers) is built by the
// composition root, which handles topological construction and facade injection.
const { worldStateController, subControllers, modService, registryStore } = buildWorldState(tickSystem);

// 4. Initialize broadcast service
const broadcastService = new WorldStateBroadcastService(io, worldStateController);

// 5. Register socket lifecycle
const socketLifecycle = new SocketLifecycleController(worldStateController, io);
socketLifecycle.registerHandlers();

// 5b. The mod package view: what is installed under data/mods/, and what applying
// it would change. Scanned once here so GET /mods answers without touching the disk
// and so the startup log names the package set the world was built from — the
// official ones and anything somebody else added.
const bootScan = modService.rescan();
Logger.info(
    `[server] mod packages: ${bootScan.mods.length} installed`
    + ` (${bootScan.mods.filter((mod) => mod.official).length} official),`
    + ` ${bootScan.invalid.length} rejected`
);

// 6. Register all routes
registerRoutes(app, llmController, worldStateController, broadcastService, modService);

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
    turnSystemController: worldStateController.turnSystemController,
    instinctController: worldStateController.instinctController
});

// 7e. Expose the LLM agent controller on the facade for the dev "Agent View"
//     inspector (GET /llm/agent/:entityId). Read-only: routes call
//     describeAgentView() only. The agent is built AFTER registerRoutes(), so
//     it cannot be a route dependency; the routes read it off the facade.
worldStateController.llmAgentController = llmAgentController;

// 7f. "Create Agent Body" (dev feature, Feature A — the new LLM prompt kind
//     `agent-body-design`, versioned; RP-1/RP-2). Designing is judgment-only; the
//     explicit Save writes the design as one mod package under data/mods/ and never
//     touches the official `core-*` files (wiki/decisions/agent-body-design.md). One LLM
//     call per design request, rate-limited in the route (SEC-9); provider
//     timeout is the seam's REQUEST_TIMEOUT_MS (env LLM_TIMEOUT_MS), same as
//     /llm/chat — no second timeout knob.
const agentBodyController = new AgentBodyController({ llmController });
worldStateController.agentBodyController = agentBodyController;

// 7g. "The System" (the System tab): the operator says what they want the world to
// contain, the System reads the live definition through tools and proposes a data-only
// mod package. Fourth LLM prompt kind, `system-authoring` (RP-1/RP-2), and judgment-only
// like the body designer: a proposal becomes a package only on the operator's write
// click, and the world takes a package only at the round boundary (CR B-2 keeps every
// provider call behind the LLM seam; wiki/decisions/system-authoring.md).
const worldAuthoringController = new WorldAuthoringController({
    llmController,
    registryStore,
    writer: new ModPackageWriter(),
    // The live-world half: the operator service reads and mutates the running world
    // (set Physical.existence, drop an organ, move an item, ...). It is built here from
    // the same facade + registry store that feeds the authoring flow, so one world view
    // backs both halves. wiki/decisions/system-live-operator.md
    operatorService: new WorldOperatorService({ worldStateController, registryStore })
});
worldStateController.worldAuthoringController = worldAuthoringController;

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

// 8. STAND THE WORLD DOWN: this server boots IDLE. `buildWorldState()` above
//    assembles the world definition (mod packages, map, controllers) and seeds a
//    population the way the composition root always has; this step removes it
//    again through the same action the "Stop world" button calls, so "a world
//    that is not running" has one definition (`WorldRecreateLogic`). Nothing
//    ticks, no round starts, and the LLM provider is not called until the
//    operator creates a world (`POST /world/create` -> `startWorld`).
//    Why the stand-down happens HERE and not behind a `seed: false` argument of
//    `buildWorldState()`: that function is also how the suite builds a working
//    world, and a boolean that switches the behavior of a 500-line root is the
//    shape `CHG-4` refuses. The tick system is deliberately never started here;
//    `gracefulShutdown` stopping it is a no-op on an idle server.
const bootStandDown = worldStateController.stopWorld();
Logger.info(
    `[server] idle: ${bootStandDown.despawned} boot-spawn entity(ies) stood down;`
    + ' no world runs until POST /world/create'
);

// 9. Broadcast the initial state — which, on an idle server, is an empty world.
worldStateController.triggerInitialBroadcast();

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
            for (const [, socket] of io.sockets.sockets) {
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

    // Force exit after FORCED_SHUTDOWN_TIMEOUT_MS if server.close() still hangs (safety net)
    setTimeout(() => {
        Logger.error('[Server] Forced shutdown after timeout.');
        process.exit(1);
    }, FORCED_SHUTDOWN_TIMEOUT_MS);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
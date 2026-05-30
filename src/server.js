import bootstrapServer from './utils/serverBootstrap.js';
import LLMController from './controllers/networking/LLMController.js';
import WorldStateController from './controllers/WorldStateController.js';
import SocketLifecycleController from './controllers/networking/SocketLifecycleController.js';
import WorldStateBroadcastService from './services/WorldStateBroadcastService.js';
import { registerRoutes } from './routes/index.js';
import Logger from './utils/Logger.js';

// 1. Bootstrap server (Express + HTTP + Socket.IO)
const { app, server, io } = bootstrapServer();

// 2. Initialize controllers
const llmController = new LLMController();
const worldStateController = new WorldStateController();

// 3. Initialize broadcast service
const broadcastService = new WorldStateBroadcastService(io, worldStateController);

// 4. Register socket lifecycle
const socketLifecycle = new SocketLifecycleController(worldStateController, io);
socketLifecycle.registerHandlers();

// 5. Register all routes
registerRoutes(app, llmController, worldStateController, broadcastService);

// 6. Inject broadcast service into WorldStateController for stat-change-driven broadcasts
worldStateController.setBroadcastService(broadcastService);

// 7. Trigger initial broadcast to sync full initial state (including spawn items) to connected clients
worldStateController.triggerInitialBroadcast();

    // 8. Graceful shutdown for unified tick system
    let isShuttingDown = false;

    function gracefulShutdown(signal) {
        // Prevent duplicate shutdown sequences
        if (isShuttingDown) {
            Logger.warn(`[Server] ${signal} received during shutdown — ignoring duplicate`);
            return;
        }
        isShuttingDown = true;

        Logger.info(`[Server] ${signal} received. Shutting down gracefully...`);

        // Stop unified internal component tick system
        if (worldStateController?.internalComponentController) {
            worldStateController.internalComponentController.stopTickSystem();
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

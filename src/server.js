import bootstrapServer from './utils/serverBootstrap.js';
import LLMController from './controllers/networking/LLMController.js';
import WorldStateController from './controllers/WorldStateController.js';
import SocketLifecycleController from './controllers/networking/SocketLifecycleController.js';
import WorldStateBroadcastService from './services/WorldStateBroadcastService.js';
import { registerRoutes } from './routes/index.js';

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

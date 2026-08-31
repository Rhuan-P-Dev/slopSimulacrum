import express from 'express';
import authMiddleware from '../utils/authMiddleware.js';
import { register as registerChatRoutes } from './chatRoutes.js';
import { register as registerWorldRoutes } from './worldRoutes.js';
import { register as registerActionRoutes } from './actionRoutes.js';
import { register as registerCapabilityRoutes } from './capabilityRoutes.js';
import { register as registerSynergyRoutes } from './synergyRoutes.js';
import { register as registerSelectionRoutes } from './selectionRoutes.js';
import { register as registerInternalComponentRoutes } from './internalComponentRoutes.js';
import registerInventoryRoutes from './inventoryRoutes.js';
import { register as registerLlmRoutes } from './llmRoutes.js';
import { register as registerTurnRoutes } from './turnRoutes.js';
import { register as registerRoomChatRoutes } from './roomChatRoutes.js';
import { register as registerHintRoutes } from './hintRoutes.js';
import { register as registerWorldEventRoutes } from './worldEventRoutes.js';
import { register as registerMaterialRoutes } from './materialRoutes.js';
import { register as registerCraftingRoutes } from './craftingRoutes.js';
import { register as registerKnowledgeRoutes } from './knowledgeRoutes.js';

/**
 * Registers all routes with the given Express app.
 *
 * All API routers are mounted behind the shared auth gate
 * (`src/utils/authMiddleware.js`), which is a pass-through in local
 * development and enforces `Authorization: Bearer <API_TOKEN>` when
 * `REQUIRE_AUTH === 'true'`. Every route module follows the standard
 * `register(router, { deps })` shape (BUG-069: internalComponentRoutes
 * joined this pattern, replacing the standalone router that reached for a
 * request-scope side channel nobody ever set, 4/5 endpoints 503).
 * Static assets (public/, shared/) and Socket.IO are NOT gated: they are
 * mounted/attached before this router and Socket.IO upgrades bypass
 * Express routing entirely.
 *
 * @param {import('express').Application} app - Express application instance
 * @param {Object} llmController - LLM controller instance
 * @param {Object} worldStateController - World state controller instance
 * @param {Object} broadcastService - Broadcast service instance
 */
export function registerRoutes(app, llmController, worldStateController, broadcastService) {
	const router = express.Router();

	registerChatRoutes(router, { llmController });
	registerWorldRoutes(router, { worldStateController, broadcastService });
	registerActionRoutes(router, { worldStateController, broadcastService });
	registerCapabilityRoutes(router, { worldStateController });
	registerSynergyRoutes(router, { worldStateController });
	registerSelectionRoutes(router, { worldStateController });
	registerInventoryRoutes(router, { worldStateController });
	registerInternalComponentRoutes(router, { worldStateController });
	registerLlmRoutes(router, { worldStateController });
	registerTurnRoutes(router, { worldStateController });
	registerRoomChatRoutes(router, { worldStateController });
	registerHintRoutes(router, { worldStateController });
	registerWorldEventRoutes(router, { worldStateController });
	registerMaterialRoutes(router, { worldStateController });
	registerCraftingRoutes(router, { worldStateController });
	registerKnowledgeRoutes(router, { worldStateController });

	// Single mount point for all API routes (auth gate kept).
	app.use('/', authMiddleware, router);
}

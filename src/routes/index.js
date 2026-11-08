import express from 'express';
import authMiddleware from '../utils/authMiddleware.js';
import { serverErrorHandler } from '../utils/routeError.js';
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
import { register as registerObjectInspectRoutes } from './objectInspectRoutes.js';
// Feature A (Create Agent Body, dev tab): body-designer from a character card
// (RP-1 prompt kind `agent-body-design` in AgentBodyController). Designing is
// judgment-only; the explicit Save writes one mod package under data/mods/ and never the
// official `core-*` files, so it needs the mod service to rescan what is installed.
import { register as registerAgentBodyRoutes } from './agentBodyRoutes.js';
// Mod packages: GET /mods, POST /mods/rescan, POST /mods/plan. Read-only over the
// package directory (data/mods/) — the apply point is a separate change. Dependency
// is the ModService, not the world facade.
import { register as registerModRoutes } from './modRoutes.js';
// "The System" (System tab): POST /system/chat, GET /system/history/:sessionId, POST
// /system/write. A fourth LLM prompt kind (`system-authoring`, RP-1) that reads the live
// definition through tools and proposes a data-only package; the proposal reaches disk only
// through the operator's write click, and applying stays the mod route's (`wiki/decisions/
// system-authoring.md`). Needs both the facade (the controller is built after the routes)
// and the ModService (rescan the package directory after a write).
import { register as registerSystemRoutes } from './systemRoutes.js';
// Feature G (perception): room-level delta reads + agent "what happened to me"
// summary. Read-only observer surface — worldStateController passed through to
// the perception controller the facade owns (null-tolerant, 503 when absent).
import { register as registerPerceptionRoutes } from './perceptionRoutes.js';

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
 * @param {Object} modService - The mod package view (installed packages, plan).
 */
export function registerRoutes(app, llmController, worldStateController, broadcastService, modService) {
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
	registerPerceptionRoutes(router, { worldStateController });
	registerMaterialRoutes(router, { worldStateController });
	registerCraftingRoutes(router, { worldStateController });
	registerKnowledgeRoutes(router, { worldStateController });
	registerObjectInspectRoutes(router, { worldStateController });
	registerAgentBodyRoutes(router, { worldStateController, modService });
	registerModRoutes(router, { modService });
	registerSystemRoutes(router, { worldStateController, modService });

	// Single mount point for all API routes (auth gate kept).
	app.use('/', authMiddleware, router);

	// Terminal error handler: must be registered after every route so it also
	// catches throws that escape a route body. Kept out of bootstrapServer()
	// because Express orders middleware by registration time and the routes
	// are not mounted yet at bootstrap.
	app.use(serverErrorHandler);
}

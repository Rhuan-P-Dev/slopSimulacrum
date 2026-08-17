import express from 'express';
import authMiddleware from '../utils/authMiddleware.js';
import { register as registerChatRoutes } from './chatRoutes.js';
import { register as registerWorldRoutes } from './worldRoutes.js';
import { register as registerActionRoutes } from './actionRoutes.js';
import { register as registerCapabilityRoutes } from './capabilityRoutes.js';
import { register as registerSynergyRoutes } from './synergyRoutes.js';
import { register as registerSelectionRoutes } from './selectionRoutes.js';
import registerInventoryRoutes from './inventoryRoutes.js';
import internalComponentRoutes from './internalComponentRoutes.js';

/**
 * Registers all routes with the given Express app.
 *
 * All API routers are mounted behind the shared auth gate
 * (`src/utils/authMiddleware.js`), which is a pass-through in local
 * development and enforces `Authorization: Bearer <API_TOKEN>` when
 * `REQUIRE_AUTH === 'true'`. The gate is applied to:
 *   - the internal-components router (routes defined under /internal-components)
 *   - the main router, which carries every other API endpoint
 * Both routers are mounted behind the single authMiddleware gate at '/'
 * (Phase 4: previously internal-component routes were mounted on a separate
 * app.use('/api/internal-components') line with a divergent /api prefix; they
 * are now consistent with the rest of the API surface, which is unprefixed).
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

	// Phase 4: single mount point for all API routes (auth gate kept).
	// internalComponentRoutes defines its own /internal-components paths.
	app.use('/', authMiddleware, internalComponentRoutes, router);
}
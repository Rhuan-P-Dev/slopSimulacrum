import express from 'express';
import { register as registerChatRoutes } from './chatRoutes.js';
import { register as registerWorldRoutes } from './worldRoutes.js';
import { register as registerActionRoutes } from './actionRoutes.js';
import { register as registerCapabilityRoutes } from './capabilityRoutes.js';
import { register as registerSynergyRoutes } from './synergyRoutes.js';
import { register as registerSelectionRoutes } from './selectionRoutes.js';

/**
 * Registers all routes with the given Express app.
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

	app.use('/', router);
}
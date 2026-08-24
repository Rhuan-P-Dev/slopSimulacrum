/**
 * worldEventRoutes — REST surface for the world event log.
 *
 * Follows the standard `register(router, { deps })` shape (BUG-069): deps
 * are injected, no request-scope side channels.
 *
 * Endpoints:
 *   GET /world-events?limit=50
 *     → 200 { events: [ …oldest → newest… ] }
 *
 * @module worldEventRoutes
 */

import Logger from '../utils/Logger.js';
import { WORLD_EVENTS_MAX_LIMIT } from '../utils/Constants.js';

/**
 * Registers world event routes with the given Express router.
 * @param {import('express').Router} router - Express router instance.
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.worldStateController - World state controller instance.
 */
export function register(router, { worldStateController }) {
    /**
     * GET /world-events?limit=50
     * Returns the most recent world events, oldest → newest (for panel refresh).
     */
    router.get('/world-events', (req, res) => {
        const limitParam = Number.parseInt(req.query.limit, 10);
        const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, WORLD_EVENTS_MAX_LIMIT) : WORLD_EVENTS_MAX_LIMIT;

        try {
            res.json({ events: worldStateController.getRecentEvents(limit) });
        } catch (error) {
            Logger.error('/world-events endpoint error', { error: error.message });
            res.status(500).json({ error: 'Internal Server Error', details: error.message });
        }
    });
}

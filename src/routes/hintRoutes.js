/**
 * hintRoutes — REST surface for the hint system.
 *
 * GET /hints?entityId=ent-...&targetId=... → { entityId, hints: [...] }
 *
 * @module hintRoutes
 */

import { isEntityId } from '../utils/IdResolver.js';
import Logger from '../utils/Logger.js';

/**
 * Register hint routes with the given router.
 * @param {import('express').Router} router
 * @param {Object} deps
 * @param {import('../controllers/WorldStateController.js')} deps.worldStateController
 */
export function register(router, { worldStateController }) {
    /**
     * GET /hints — Get actionable hint suggestions for an entity.
     * Query: entityId (required), targetId (optional)
     */
    router.get('/hints', (req, res) => {
        const entityId = req.query.entityId;

        // Validate required entityId.
        if (!entityId || typeof entityId !== 'string' || entityId.trim() === '') {
            return res.status(400).json({ error: 'Missing or empty entityId query parameter.' });
        }
        if (!isEntityId(entityId)) {
            return res.status(400).json({ error: 'Malformed entityId — must start with "ent-".', code: 'INVALID_ENTITY_ID' });
        }

        // Check entity existence.
        const entity = worldStateController.getEntity(entityId);
        if (!entity) {
            return res.status(404).json({ error: 'ENTITY_NOT_FOUND' });
        }

        // Graceful empty when hintController is absent (spec §6).
        if (!worldStateController.hintController?.getHints) {
            return res.status(200).json({ entityId, hints: [] });
        }

        const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : undefined;

        try {
            const result = worldStateController.hintController.getHints(entityId, { targetId });
            return res.status(200).json(result);
        } catch (err) {
            Logger.error('[hintRoutes]', `Unexpected error: ${err?.message || err}`);
            return res.status(500).json({ error: 'Internal Server Error', details: err?.message });
        }
    });
}

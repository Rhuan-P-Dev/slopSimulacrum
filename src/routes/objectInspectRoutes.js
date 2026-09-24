/**
 * Object inspection routes — GET /world-objects/:entityId.
 *
 * Serves the Object Viewer payload (wiki/subMDs/frontend/object_viewer.md):
 * an object's inventory and stats — its components with live matter
 * existence, its organs (internal components) with their effects, the items
 * it currently stores, and the production summary ("how many knives does it
 * generate per turn?").
 *
 * Standard route shape (route_patterns §5): the sole injected dependency is
 * the root world-state controller (facade-only-dependency rule) — the route
 * never reaches into a sub-controller. The payload is assembled entirely by
 * WorldStateController.getObjectInspectData().
 *
 * Envelope:
 *   200 { object: <payload> }
 *   404 { error: 'Object not found', details }          (unknown entity id)
 *   500 { error: 'Internal Server Error', details }
 *
 * @module objectInspectRoutes
 */

import Logger from '../utils/Logger.js';

/**
 * Registers the object inspection routes on the shared router.
 * @param {import('express').Router} router - The shared routes router.
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.worldStateController - The root world-state controller (facade).
 */
export function register(router, { worldStateController }) {
    router.get('/world-objects/:entityId', (req, res) => {
        try {
            const entityId = typeof req.params.entityId === 'string' ? req.params.entityId : '';
            const object = worldStateController.getObjectInspectData(entityId);

            if (!object) {
                res.status(404).json({
                    error: 'Object not found',
                    details: `No entity with id "${entityId}".`
                });
                return;
            }

            res.json({ object });
        } catch (error) {
            Logger.error(`[ObjectInspectRoutes] GET /world-objects/${req.params.entityId} failed: ${error.message}`);
            res.status(500).json({
                error: 'Internal Server Error',
                details: error.message
            });
        }
    });
}

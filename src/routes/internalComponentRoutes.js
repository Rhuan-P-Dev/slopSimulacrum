import Logger from '../utils/Logger.js';
import DataLoader from '../utils/DataLoader.js';
import InternalComponentUtils from '../utils/InternalComponentUtils.js';

/**
 * Registers the internal-component routes on the shared API router.
 *
 * BUG-069: this module used to be a standalone router that read a
 * request-scope side channel nobody ever set, so 4 of the 5 endpoints
 * always answered 503. It now follows the standard
 * `register(router, { deps })` shape used by every other route module.
 *
 * The handlers keep their full `/internal-components/...` paths, so mounting
 * them on the main router (behind the shared auth gate) changes no client
 * URLs.
 *
 * @param {import('express').Router} router - The main API router.
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export function register(router, { worldStateController }) {
    /**
     * GET /internal-components/registry
     * Returns all internal component type definitions from the registry.
     */
    router.get('/internal-components/registry', (req, res) => {
        try {
            const registry = DataLoader.loadJsonSafe('data/internalComponents.json', {});
            return res.json(registry);
        } catch (error) {
            Logger.error(`[InternalComponentRoutes] GET /registry error: ${error.message}`);
            return res.status(500).json({ error: 'Internal server error', message: error.message });
        }
    });

    /**
     * GET /internal-components/:entityId/:hostComponentId
     * Returns all internal components for a specific host component of an entity.
     */
    router.get('/internal-components/:entityId/:hostComponentId', (req, res) => {
        try {
            const icController = worldStateController.internalComponentController;
            const internalComponents = icController.getInternalComponents(
                req.params.entityId,
                req.params.hostComponentId
            );
            // Enrich with the programmatic description so the component
            // viewer's on-demand fetch renders the same text the world-state
            // broadcast carries.
            InternalComponentUtils.enrichWithDescriptions(internalComponents, icController.registry);
            return res.json(internalComponents);
        } catch (error) {
            Logger.error(`[InternalComponentRoutes] GET /:entityId/:hostComponentId error: ${error.message}`);
            return res.status(500).json({ error: 'Internal server error', message: error.message });
        }
    });

    /**
     * GET /internal-components/:entityId
     * Returns all internal components for an entity.
     */
    router.get('/internal-components/:entityId', (req, res) => {
        try {
            const icController = worldStateController.internalComponentController;
            const internalComponents = worldStateController.getInternalComponentsForEntity(req.params.entityId);
            for (const comps of Object.values(internalComponents)) {
                InternalComponentUtils.enrichWithDescriptions(comps, icController.registry);
            }
            return res.json({ success: true, data: internalComponents });
        } catch (error) {
            Logger.error(`[InternalComponentRoutes] GET /:entityId error: ${error.message}`);
            return res.status(500).json({ error: 'Internal server error', message: error.message });
        }
    });

    /**
     * POST /internal-components/:entityId/:hostComponentId/add
     * Adds an internal component to a host component.
     */
    router.post('/internal-components/:entityId/:hostComponentId/add', (req, res) => {
        try {
            const { internalComponentType } = req.body;
            if (!internalComponentType) {
                return res.status(400).json({ error: 'internalComponentType is required' });
            }
            const result = worldStateController.addInternalComponent(
                req.params.entityId,
                req.params.hostComponentId,
                internalComponentType
            );
            if (!result) {
                return res.status(400).json({ error: 'Failed to add internal component' });
            }
            return res.json({ success: true, message: `Internal component ${internalComponentType} added`, data: result });
        } catch (error) {
            Logger.error(`[InternalComponentRoutes] POST error: ${error.message}`);
            return res.status(500).json({ error: 'Internal server error', message: error.message });
        }
    });

    /**
     * DELETE /internal-components/:entityId/:hostComponentId/:internalComponentId
     * Removes an internal component from a host component.
     */
    router.delete('/internal-components/:entityId/:hostComponentId/:internalComponentId', (req, res) => {
        try {
            const result = worldStateController.internalComponentController.removeInternalComponent(
                req.params.entityId,
                req.params.hostComponentId,
                req.params.internalComponentId
            );
            if (!result) {
                return res.status(404).json({ error: 'Internal component not found' });
            }
            return res.json({ success: true, message: 'Internal component removed' });
        } catch (error) {
            Logger.error(`[InternalComponentRoutes] DELETE error: ${error.message}`);
            return res.status(500).json({ error: 'Internal server error', message: error.message });
        }
    });
}

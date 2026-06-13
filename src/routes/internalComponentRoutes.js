import express from 'express';
import Logger from '../utils/Logger.js';

const router = express.Router();

/**
 * GET /api/internal-components/registry
 * Returns all internal component type definitions from the registry.
 */
router.get('/registry', (req, res) => {
    try {
        const registry = require('../utils/DataLoader').default.loadJsonSafe('data/internalComponents.json', {});
        return res.json(registry);
    } catch (error) {
        Logger.error(`[InternalComponentRoutes] GET /registry error: ${error.message}`);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

/**
 * GET /api/internal-components/:entityId/:hostComponentId
 * Returns all internal components for a specific host component of an entity.
 */
router.get('/:entityId/:hostComponentId', (req, res) => {
    const worldStateController = req.app.locals.worldStateController;
    if (!worldStateController) {
        return res.status(503).json({ error: 'WorldStateController not available' });
    }
    try {
        const internalComponents = worldStateController.internalComponentController.getInternalComponents(
            req.params.entityId,
            req.params.hostComponentId
        );
        return res.json(internalComponents);
    } catch (error) {
        Logger.error(`[InternalComponentRoutes] GET /:entityId/:hostComponentId error: ${error.message}`);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

/**
 * GET /api/internal-components/:entityId
 * Returns all internal components for an entity.
 */
router.get('/:entityId', (req, res) => {
    const worldStateController = req.app.locals.worldStateController;
    if (!worldStateController) {
        return res.status(503).json({ error: 'WorldStateController not available' });
    }
    try {
        const internalComponents = worldStateController.getInternalComponentsForEntity(req.params.entityId);
        return res.json({ success: true, data: internalComponents });
    } catch (error) {
        Logger.error(`[InternalComponentRoutes] GET /:entityId error: ${error.message}`);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

/**
 * POST /api/internal-components/:entityId/:hostComponentId/add
 * Adds an internal component to a host component.
 */
router.post('/:entityId/:hostComponentId/add', (req, res) => {
    const worldStateController = req.app.locals.worldStateController;
    if (!worldStateController) {
        return res.status(503).json({ error: 'WorldStateController not available' });
    }
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
 * DELETE /api/internal-components/:entityId/:hostComponentId/:internalComponentId
 * Removes an internal component from a host component.
 */
router.delete('/:entityId/:hostComponentId/:internalComponentId', (req, res) => {
    const worldStateController = req.app.locals.worldStateController;
    if (!worldStateController) {
        return res.status(503).json({ error: 'WorldStateController not available' });
    }
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

export default router;
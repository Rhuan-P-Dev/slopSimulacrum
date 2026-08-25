/**
 * materialRoutes unit tests.
 *
 * Covers: GET /materials/registry returns { materials, compositions },
 * and server-error degradation (500 with `{ error, details }`).
 *
 * @module test/unit/materialRoutes
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/materialRoutes.js';

/**
 * Creates a fake worldStateController stub with a spied getMaterialRegistry method.
 * @param {Object} [fallbackRegistry={}] - Returned when no custom handler is set.
 * @returns {Object} Object with `worldStateController` and `spy` properties.
 */
function makeWorldStateControllerStub(fallbackRegistry = {}) {
    const spy = vi.fn(() => ({ ...fallbackRegistry }));
    return {
        worldStateController: { getMaterialRegistry: spy },
        spy,
    };
}

/**
 * Registers the material routes on a fresh Express Router.
 * @param {Object} deps - Dependencies map with worldStateController.
 * @returns {import('express').Router}
 */
function buildApp(deps) {
    const router = express.Router();
    register(router, deps);
    return express().use(router);
}

describe('materialRoutes', () => {
    it('GET /materials/registry → 200, { materials, compositions }', async () => {
        const testRegistry = {
            materials: {
                wood: { name: 'Wood', density: 0.6 },
                iron: { name: 'Iron', density: 7.8 },
            },
            compositions: {
                centralBall: [{ material: 'iron', fraction: 1.0 }],
                knife: [
                    { material: 'iron', fraction: 0.6, role: 'blade' },
                    { material: 'wood', fraction: 0.4, role: 'handle' },
                ],
            },
        };

        const { worldStateController, spy } = makeWorldStateControllerStub(testRegistry);
        const app = buildApp({ worldStateController });

        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/materials/registry`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalled();
        expect(body).toEqual(testRegistry);
        expect(body.materials).toHaveProperty('wood');
        expect(body.materials).toHaveProperty('iron');
        expect(body.compositions).toHaveProperty('centralBall');
        expect(body.compositions).toHaveProperty('knife');

        server.close();
    });

    it('GET /materials/registry → 500 on error', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        spy.mockImplementationOnce(() => {
            throw new Error('Simulated server error');
        });

        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/materials/registry`);
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        expect(body.details).toBe('Simulated server error');

        server.close();
    });

    it('GET /materials/registry → returns the stubbed registry data', async () => {
        const { worldStateController } = makeWorldStateControllerStub({
            materials: { wood: { name: 'Wood' } },
            compositions: {},
        });
        const app = buildApp({ worldStateController });

        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/materials/registry`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({
            materials: { wood: { name: 'Wood' } },
            compositions: {},
        });

        server.close();
    });
});

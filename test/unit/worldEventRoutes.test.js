/**
 * worldEventRoutes unit tests.
 *
 * Covers: default/capped/invalid limit parameters, and server-error
 * degradation (500 with `{ error, details }`).
 *
 * @module test/unit/worldEventRoutes
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/worldEventRoutes.js';
import { WORLD_EVENTS_MAX_LIMIT } from '../../src/utils/Constants.js';

/**
 * Creates a fake worldStateController stub with a spied getRecentEvents method.
 * @param {Array} [fallbackEvents=[]] - Returned when no custom handler is set.
 * @returns {Object} Object with `worldStateController` and `spy` properties.
 */
function makeWorldStateControllerStub(fallbackEvents = []) {
    const spy = vi.fn(() => [...fallbackEvents]);
    return {
        worldStateController: { getRecentEvents: spy },
        spy,
    };
}

/**
 * Registers the world event routes on a fresh Express Router.
 * @param {Object} deps - Dependencies map with worldStateController.
 * @returns {import('express').Router}
 */
function buildApp(deps) {
    const router = express.Router();
    register(router, deps);
    return express().use(router);
}

describe('worldEventRoutes', () => {
    it('GET /world-events with no limit → getRecentEvents(50), 200, { events }', async () => {
        const testEvents = [{ tick: 1, message: 'hello' }, { tick: 2, message: 'world' }];
        const { worldStateController, spy } = makeWorldStateControllerStub(testEvents);
        const app = buildApp({ worldStateController });

        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(WORLD_EVENTS_MAX_LIMIT);
        expect(body.events).toEqual(testEvents);

        server.close();
    });

    it('GET /world-events?limit=10 → getRecentEvents(10)', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        await fetch(`http://localhost:${port}/world-events?limit=10`);

        expect(spy).toHaveBeenCalledWith(10);
        server.close();
    });

    it('GET /world-events?limit=200 → capped at WORLD_EVENTS_MAX_LIMIT (50)', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        await fetch(`http://localhost:${port}/world-events?limit=200`);

        expect(spy).toHaveBeenCalledWith(WORLD_EVENTS_MAX_LIMIT);
        server.close();
    });

    it('GET /world-events?limit=0 → defaults to WORLD_EVENTS_MAX_LIMIT', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        await fetch(`http://localhost:${port}/world-events?limit=0`);

        expect(spy).toHaveBeenCalledWith(WORLD_EVENTS_MAX_LIMIT);
        server.close();
    });

    it('GET /world-events?limit=-5 → defaults to WORLD_EVENTS_MAX_LIMIT', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        await fetch(`http://localhost:${port}/world-events?limit=-5`);

        expect(spy).toHaveBeenCalledWith(WORLD_EVENTS_MAX_LIMIT);
        server.close();
    });

    it('GET /world-events?limit=abc → defaults to WORLD_EVENTS_MAX_LIMIT', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        await fetch(`http://localhost:${port}/world-events?limit=abc`);

        expect(spy).toHaveBeenCalledWith(WORLD_EVENTS_MAX_LIMIT);
        server.close();
    });

    it('when getRecentEvents throws → 500 with { error, details }', async () => {
        const { worldStateController } = makeWorldStateControllerStub();
        worldStateController.getRecentEvents = () => {
            throw new Error('boom');
        };
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events`);
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        expect(body.details).toBe('boom');

        server.close();
    });
});

/**
 * knowledgeRoutes unit tests (knowledge_viewer_spec.md §7.2).
 *
 * Covers:
 *   - GET /knowledge → 200 with the exact `{ knowledge: <payload> }` envelope,
 *     facade.getKnowledge() called EXACTLY ONCE per request.
 *   - 500 error mapping: `{ error: 'Internal Server Error', details: <message> }`.
 *   - The facade-only-dependency rule: the route's sole injected dependency is
 *     the root world-state controller; it must never reach into a sub-controller.
 *
 * @module test/unit/knowledgeRoutes
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/knowledgeRoutes.js';

/**
 * A minimal, representative knowledge payload for the stub.
 * @type {Object}
 */
const PAYLOAD = {
    traitStats: {
        groups: { Physical: { durability: 100 } },
        mappings: [],
        materials: [{ type: 'wood', name: 'Wood', density: 0.6, properties: {} }],
        vocabulary: { traitGroups: ['Physical'], stats: ['durability'], durability: { brokenAt: 1, usableMin: 30 } },
    },
    recipes: [{ id: 'knife_to_t1', name: 'T1 Assembly', description: null, inputs: [], outputs: [] }],
    items: [{ type: 'knife', name: 'Knife', description: null, volume: 1, externalVolume: null, materials: null, traits: {} }],
};

/**
 * Creates a fake worldStateController stub with a spied getKnowledge method.
 * @param {Object} [fallbackKnowledge=PAYLOAD] - Returned when no custom handler is set.
 * @returns {{ worldStateController: Object, spy: import('vitest').Mock }}
 */
function makeWorldStateControllerStub(fallbackKnowledge = PAYLOAD) {
    const spy = vi.fn(() => fallbackKnowledge);
    return {
        worldStateController: { getKnowledge: spy },
        spy,
    };
}

/**
 * Registers the knowledge routes on a fresh Express Router.
 * @param {Object} deps - Dependencies map (worldStateController, and optionally
 *   extra keys to prove the route ignores sub-controllers).
 * @returns {import('express').Express}
 */
function buildApp(deps) {
    const router = express.Router();
    register(router, deps);
    return express().use(router);
}

/**
 * Starts an ephemeral server for the given app and returns a fetcher bound to
 * its port.
 * @param {import('express').Express} app
 * @returns {Promise<{ fetch: (path: string) => Promise<import('node-fetch')>, close: () => void }>}
 */
async function withServer(app) {
    const server = await new Promise((resolve) => {
        const s = app.listen(0);
        resolve(s);
    });
    const port = server.address().port;
    return {
        fetch: (path) => fetch(`http://localhost:${port}${path}`),
        close: () => server.close(),
    };
}

describe('knowledgeRoutes', () => {
    it('GET /knowledge → 200 with the { knowledge } envelope; facade.getKnowledge() called exactly once', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        const app = buildApp({ worldStateController });
        const { fetch: doFetch, close } = await withServer(app);

        const res = await doFetch('/knowledge');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        // The envelope is exactly { knowledge: <payload> } — the payload itself
        // is the facade's return value, nested under the `knowledge` key.
        expect(body).toEqual({ knowledge: PAYLOAD });
        expect(body.knowledge).toHaveProperty('traitStats');
        expect(body.knowledge).toHaveProperty('recipes');
        expect(body.knowledge).toHaveProperty('items');

        close();
    });

    it('GET /knowledge → 500 { error, details } on failure', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        spy.mockImplementationOnce(() => {
            throw new Error('Simulated knowledge failure');
        });
        const app = buildApp({ worldStateController });
        const { fetch: doFetch, close } = await withServer(app);

        const res = await doFetch('/knowledge');
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        expect(body.details).toBe('Simulated knowledge failure');

        close();
    });

    it('facade-only-dependency guard: the route uses only the facade even when a sub-controller is present in deps', async () => {
        const spy = vi.fn(() => PAYLOAD);
        const worldStateController = { getKnowledge: spy };

        // A sub-controller is intentionally placed in deps; if the route
        // violated the facade-only-dependency rule and reached into it, this
        // would throw and the request would 500. It must not.
        const subController = {
            getKnowledge: () => {
                throw new Error('sub-controller must never be reached by the route');
            },
        };

        const app = buildApp({ worldStateController, knowledgeController: subController });
        const { fetch: doFetch, close } = await withServer(app);

        const res = await doFetch('/knowledge');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ knowledge: PAYLOAD });
        expect(spy).toHaveBeenCalledTimes(1);

        close();
    });
});

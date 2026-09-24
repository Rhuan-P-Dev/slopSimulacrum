/**
 * objectInspectRoutes unit tests (wiki/subMDs/frontend/object_viewer.md).
 *
 * Covers:
 *   - GET /world-objects/:entityId → 200 with the exact `{ object: <payload> }`
 *     envelope, facade.getObjectInspectData() called EXACTLY ONCE per request.
 *   - 404 error mapping for an unknown entity id (facade returns null):
 *     `{ error: 'Object not found', details }`.
 *   - 500 error mapping: `{ error: 'Internal Server Error', details: <message> }`.
 *   - The facade-only-dependency rule: the route's sole injected dependency is
 *     the root world-state controller; it must never reach into a sub-controller.
 *
 * @module test/unit/objectInspectRoutes
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/objectInspectRoutes.js';

/**
 * A minimal, representative inspect payload for the stub.
 * @type {Object}
 */
const PAYLOAD = {
    entity: { id: 'gen-1', name: 'Knife Generator', blueprint: 'knifeGenerator', isStatic: true, spatial: { x: -80, y: 0 }, roomId: 'room-1', roomName: 'Entrance Hall' },
    components: [
        {
            id: 'comp-1', type: 'generatorCore', exists: true, existence: 1, broken: false,
            volume: 10, stats: { Physical: { existence: 1, volume: 10 } },
            materials: [{ material: 'iron', fraction: 1 }], form: { volume: 10 },
            internalComponents: [
                { id: 'ic-1', type: 'knifeGeneratorIC', broken: false, description: 'Every 1 turn, produces 1 knife.' }
            ]
        }
    ],
    items: [
        { id: 'item-1', type: 'knife', name: 'Knife', description: 'A sharp blade.', volume: 1, hostComponentId: 'comp-1' }
    ],
    inventory: { used: 1, capacity: 10, percent: 10 },
    production: [
        {
            organType: 'knifeGeneratorIC', organDescription: 'Every 1 turn, produces 1 knife.', organBroken: false,
            hostComponentId: 'comp-1', hostBroken: false, itemKey: 'knife', itemName: 'Knife',
            itemVolume: 1, countPerTurn: 1, intervalTurns: 1, active: true, stored: 1, capacity: 10
        }
    ]
};

/**
 * Creates a fake worldStateController stub with a spied getObjectInspectData.
 * @param {Object|null} [fallback=PAYLOAD] - Returned for any id (null → 404 path).
 * @returns {{ worldStateController: Object, spy: import('vitest').Mock }}
 */
function makeWorldStateControllerStub(fallback = PAYLOAD) {
    const spy = vi.fn((entityId) => (fallback === null ? null : { ...fallback, entity: { ...fallback.entity, id: entityId } }));
    return {
        worldStateController: { getObjectInspectData: spy },
        spy,
    };
}

/**
 * Registers the object inspect routes on a fresh Express Router.
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
 * @returns {Promise<{ fetch: (path: string) => Promise<Response>, close: () => void }>}
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

describe('objectInspectRoutes', () => {
    it('GET /world-objects/:entityId → 200 with the { object } envelope; facade called exactly once with the id', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        const app = buildApp({ worldStateController });
        const { fetch: doFetch, close } = await withServer(app);

        const res = await doFetch('/world-objects/gen-1');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('gen-1');
        // The envelope is exactly { object: <payload> } — the payload itself is
        // the facade's return value, nested under the `object` key.
        expect(body).toEqual({ object: PAYLOAD });
        expect(body.object).toHaveProperty('production');
        expect(body.object.production[0].countPerTurn).toBe(1);

        close();
    });

    it('GET /world-objects/:entityId → 404 { error, details } for an unknown id (facade null)', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub(null);
        const app = buildApp({ worldStateController });
        const { fetch: doFetch, close } = await withServer(app);

        const res = await doFetch('/world-objects/nope');
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(spy).toHaveBeenCalledWith('nope');
        expect(body.error).toBe('Object not found');
        expect(body.details).toContain('nope');

        close();
    });

    it('GET /world-objects/:entityId → 500 { error, details } on failure', async () => {
        const { worldStateController, spy } = makeWorldStateControllerStub();
        spy.mockImplementationOnce(() => {
            throw new Error('Simulated inspect failure');
        });
        const app = buildApp({ worldStateController });
        const { fetch: doFetch, close } = await withServer(app);

        const res = await doFetch('/world-objects/gen-1');
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        expect(body.details).toBe('Simulated inspect failure');

        close();
    });

    it('facade-only-dependency guard: the route uses only the facade even when a sub-controller is present in deps', async () => {
        const spy = vi.fn(() => PAYLOAD);
        const worldStateController = { getObjectInspectData: spy };

        // A sub-controller is intentionally placed in deps; if the route
        // violated the facade-only-dependency rule and reached into it, this
        // would throw and the request would 500. It must not.
        const subController = {
            getObjectInspectData: () => {
                throw new Error('sub-controller must never be reached by the route');
            },
        };

        const app = buildApp({ worldStateController, inventoryManager: subController });
        const { fetch: doFetch, close } = await withServer(app);

        const res = await doFetch('/world-objects/gen-1');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ object: PAYLOAD });
        expect(spy).toHaveBeenCalledTimes(1);

        close();
    });
});

/**
 * viewRoutes unit tests — the GET /view/:id generic viewer.
 *
 * Covers:
 *   - 200 envelope `{ view: <node> }` for each typed id prefix, with the
 *     facade called EXACTLY ONCE per request as getViewData(id, kind), kind
 *     classified by prefix (ent- → ENTITY, comp- → COMPONENT, item- → ITEM,
 *     eq- → EQUIPPED);
 *   - 400 `{ error: 'Invalid id type', details }` for: a missing id, an
 *     overlong id, and an id with no known typed prefix;
 *   - 404 `{ error: 'View not found', details }` when the classified kind
 *     exists but no live object carries that id (facade returns null);
 *   - 500 `{ error: 'Internal Server Error', details }` when getViewData
 *     throws (the sendRouteError path);
 *   - the facade-only-dependency rule: the route uses only the facade even
 *     when sub-controllers are present in deps.
 *
 * @module test/unit/viewRoutes
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/viewRoutes.js';

/**
 * Minimal representative view nodes (one per kind) for the stub.
 * @type {Object}
 */
const NODES = {
    ent: { kind: 'entity', entity: { id: 'ent-0', name: 'Generator' }, components: [], items: [], inventory: { used: 0, capacity: 1, percent: 0 } },
    comp: { kind: 'component', id: 'comp-1', type: 'generatorCore', materials: [{ material: 'iron', fraction: 1 }] },
    clothing: { kind: 'clothing', componentId: 'comp-1', worn: [{ itemId: 'item-1', itemType: 'tshirt' }] },
    item: { kind: 'item', id: 'item-1', itemId: 'item-1', itemType: 'knife' },
};

/**
 * Creates a fake worldStateController stub with a spied getViewData. The stub
 * resolves the id prefix to its node (null → 404 path, throw → 500 path
 * can be armed via the mockImplementationOnce used in individual tests).
 * @param {Object|null} [node=null] - The node to return (or a function of the
 *   classified kind to return one of the four representative nodes).
 * @returns {{ worldStateController: Object, spy: import('vitest').Mock }}
 */
function makeWorldStateControllerStub(node = null) {
    const spy = vi.fn((id, kind) => {
        switch (kind) {
            case 'ENTITY': return node === null ? null : NODES.ent;
            case 'COMPONENT': return node === null ? null : NODES.comp;
            case 'ITEM': return node === null ? null : NODES.item;
            case 'EQUIPPED': return node === null ? null : NODES.item;
            default: return null;
        }
    });
    return {
        worldStateController: { getViewData: spy },
        spy,
    };
}

/**
 * Registers the view routes on a fresh Express app (no auth middleware — unit
 * level, like objectInspectRoutes.test.js).
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

describe('viewRoutes', () => {
    describe('200 — the { view } envelope', () => {
        it('entity prefix: 200 with the node; facade called exactly once as (id, "ENTITY")', async () => {
            const { worldStateController, spy } = makeWorldStateControllerStub(NODES.ent);
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/ent-0');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith('ent-0', 'ENTITY');
            expect(body).toEqual({ view: NODES.ent });

            close();
        });

        it('component prefix: 200 with the node; facade called exactly once as (id, "COMPONENT")', async () => {
            const { worldStateController, spy } = makeWorldStateControllerStub(NODES.comp);
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/comp-1');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith('comp-1', 'COMPONENT');
            expect(body).toEqual({ view: NODES.comp });

            close();
        });

        it('item prefix: 200 with the node; facade called exactly once as (id, "ITEM")', async () => {
            const { worldStateController, spy } = makeWorldStateControllerStub(NODES.item);
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/item-1');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith('item-1', 'ITEM');
            expect(body).toEqual({ view: NODES.item });

            close();
        });

        it('equipped prefix: 200 with the node; facade called exactly once as (id, "EQUIPPED")', async () => {
            const { worldStateController, spy } = makeWorldStateControllerStub(NODES.item);
            const app = buildApp({ worldStateController });
            // eq- ids resolve to the same item node as item- ids (the eq id is
            // preserved in the node's `id` field by the controller).
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/eq-777');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith('eq-777', 'EQUIPPED');
            expect(body).toEqual({ view: NODES.item });

            close();
        });
    });

    describe('400 — invalid id type at the boundary', () => {
            // (A missing id never reaches the handler: the route "/view/:id"
        // requires the segment, so Express answers 404 for "/view/". The
        // in-handler empty guard stays as belt-and-suspenders for the mount
        // contract — documented in viewRoutes.js.)

        it('overlong id → 400 size cap (SEC-2)', async () => {
            const { worldStateController } = makeWorldStateControllerStub();
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const id = 'ent-'.repeat(100);
            const res = await doFetch(`/view/${id}`);
            const body = await res.json();

            expect(res.status).toBe(400);
            expect(body.error).toBe('Invalid id type');
            expect(body.details).toContain('too long');

            close();
        });

        it('no known typed prefix → 400 with the accepted prefixes listed', async () => {
            const { worldStateController } = makeWorldStateControllerStub();
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/tree-1');
            const body = await res.json();

            expect(res.status).toBe(400);
            expect(body.error).toBe('Invalid id type');
            expect(body.details).toContain('ent-');
            expect(body.details).toContain('comp-');
            expect(body.details).toContain('item-');
            expect(body.details).toContain('eq-');

            close();
        });
    });

    describe('404 — classified kind, no live object', () => {
        it('unknown entity id → 404 "No entity found"', async () => {
            const { worldStateController, spy } = makeWorldStateControllerStub(null);
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/ent-404');
            const body = await res.json();

            expect(res.status).toBe(404);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith('ent-404', 'ENTITY');
            expect(body.error).toBe('View not found');
            expect(body.details).toContain('No entity found');

            close();
        });

        it('unknown equipped id → 404 "No equipped item found"', async () => {
            const { worldStateController } = makeWorldStateControllerStub(null);
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/eq-404');
            const body = await res.json();

            expect(res.status).toBe(404);
            expect(body.error).toBe('View not found');
            expect(body.details).toContain('No equipped item found');

            close();
        });
    });

    describe('500 — failure path', () => {
        it('getViewData throws → 500 { error, details }', async () => {
            const { worldStateController } = makeWorldStateControllerStub();
            worldStateController.getViewData.mockImplementationOnce(() => {
                throw new Error('Simulated view failure');
            });
            const app = buildApp({ worldStateController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/ent-0');
            const body = await res.json();

            expect(res.status).toBe(500);
            expect(body.error).toBe('Internal Server Error');

            close();
        });
    });

    describe('facade-only-dependency guard', () => {
        it('the route uses only the facade even when a sub-controller is present in deps', async () => {
            const spy = vi.fn(() => NODES.ent);
            const worldStateController = { getViewData: spy };

            // A sub-controller is intentionally placed in deps; if the route
            // violated the facade-only-dependency rule and reached into it,
            // this would throw and the request would 500. It must not.
            const subController = {
                getViewData: () => {
                    throw new Error('sub-controller must never be reached by the route');
                },
            };

            const app = buildApp({ worldStateController, inventoryManager: subController, holdingCostController: subController });
            const { fetch: doFetch, close } = await withServer(app);

            const res = await doFetch('/view/ent-0');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body).toEqual({ view: NODES.ent });
            expect(spy).toHaveBeenCalledTimes(1);

            close();
        });
    });
});

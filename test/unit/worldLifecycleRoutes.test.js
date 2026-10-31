/**
 * UNIT TEST — the HTTP surface of the world lifecycle.
 *
 * Three claims, one per button the operator has:
 *
 *   - `GET /world-state` carries `running` next to `state`, read from the tick
 *     system. The launcher says "no world running" from that field, not from an
 *     empty entity map (`README §World lifecycle`);
 *   - `POST /world/create` goes through `startWorld`, not `recreateWorld`. The
 *     difference is the tick: a route that called the older function would build
 *     a population nobody advances, which is the exact bug the launcher would
 *     ship;
 *   - `POST /world/stop` calls `stopWorld`, broadcasts once so connected clients
 *     redraw the emptied world, and answers `{ success, despawned, running:false }`.
 *
 * The facade is a stub that records which lifecycle function was called; routes
 * map a request to one call and one answer, and nothing here should depend on
 * rooms, entities or the provider.
 *
 * @module test/unit/worldLifecycleRoutes
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/worldRoutes.js';
import { GameError } from '../../src/utils/CustomErrors.js';

/**
 * A facade stub recording the lifecycle calls, with the answers the routes echo.
 * @param {Object} [options]
 * @param {boolean} [options.running] - What the tick says at the time of the request.
 * @param {Error} [options.throwOn] - Failure to raise from every lifecycle call.
 */
function makeFacade({ running = false, throwOn = null } = {}) {
    /** @type {string[]} */
    const calls = [];
    return {
        calls,
        isWorldRunning: () => running,
        getAll: () => ({ rooms: { 'room-1': { id: 'room-1' } }, entities: {}, turns: { roundNumber: 3 } }),
        startWorld: (options) => {
            calls.push(`startWorld:${(options?.cardIds ?? []).join('+') || 'all'}`);
            if (throwOn) throw throwOn;
            return { despawned: 0, cards: { total: 1, spawned: 1, entities: [] }, round: 3, running: true };
        },
        stopWorld: () => {
            calls.push('stopWorld');
            if (throwOn) throw throwOn;
            return { despawned: 2, running: false };
        }
    };
}

/** Mount the world routes over a stub facade and a broadcast spy. */
async function withServer(facade, { broadcast = () => {} } = {}) {
    const router = express.Router();
    register(router, {
        worldStateController: facade,
        broadcastService: { broadcast, _transformForBroadcast: (state) => state }
    });
    const app = express().use(express.json()).use(router);
    const server = await new Promise((resolve) => resolve(app.listen(0)));
    const port = server.address().port;
    return {
        get: async (path) => {
            const res = await fetch(`http://localhost:${port}${path}`);
            return { status: res.status, body: await res.json() };
        },
        post: async (path, body) => {
            const res = await fetch(`http://localhost:${port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {})
            });
            return { status: res.status, body: await res.json() };
        },
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

describe('GET /world-state', () => {
    it('answers 200 with an empty world and running:false while idle', async () => {
        const client = await withServer(makeFacade({ running: false }));

        const res = await client.get('/world-state');
        await client.close();

        expect(res.status).toBe(200);
        expect(res.body.running).toBe(false);
        expect(Object.keys(res.body.state.entities)).toEqual([]);
    });

    it('reports running:true when the tick is running', async () => {
        const client = await withServer(makeFacade({ running: true }));

        const res = await client.get('/world-state');
        await client.close();

        expect(res.body.running).toBe(true);
    });
});

describe('POST /world/create', () => {
    it('starts the world, not only its population', async () => {
        const facade = makeFacade();
        const client = await withServer(facade);

        const res = await client.post('/world/create', { cardIds: ['Minako'] });
        await client.close();

        // The route must reach `startWorld`; `recreateWorld` would leave the world
        // built and nothing advancing it.
        expect(facade.calls).toEqual(['startWorld:Minako']);
        expect(res.status).toBe(200);
        expect(res.body.running).toBe(true);
        expect(res.body.cards.spawned).toBe(1);
    });
});

describe('POST /world/stop', () => {
    it('stands the world down and tells connected clients', async () => {
        const facade = makeFacade({ running: true });
        let broadcasts = 0;
        const client = await withServer(facade, { broadcast: () => { broadcasts += 1; } });

        const res = await client.post('/world/stop');
        await client.close();

        expect(facade.calls).toEqual(['stopWorld']);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, despawned: 2, running: false });
        expect(broadcasts).toBe(1);
    });

    it('keeps the shared error contract when the teardown fails', async () => {
        const facade = makeFacade({ throwOn: new GameError('WORLD_TEARDOWN_FAILED', 'boom') });
        const client = await withServer(facade);

        const res = await client.post('/world/stop');
        await client.close();

        expect(res.status).toBe(500);
        expect(res.body.error).toBeTruthy();
    });
});

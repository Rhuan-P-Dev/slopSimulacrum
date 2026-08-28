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
    const worldStateController = {
        getRecentEvents: spy,
        getEntity: () => null,
        getRooms: () => ({}),
        getEntities: () => ({}),
        getDroppedItemsByRoom: () => ({}),
    };
    return { worldStateController, spy };
}

/**
 * Builds a facade stub whose getEntity/getRooms/getEntities/getDroppedItemsByRoom
 * resolve a real room context for the given entityId (used to assert the
 * enriched `context` object on /world-events responses).
 * @param {Array} [fallbackEvents=[]]
 * @returns {Object}
 */
function makeWorldStubWithRoom(fallbackEvents = []) {
    const rooms = {
        'room-1': {
            id: 'room-1',
            name: 'The Entrance Hall',
            description: 'A dimly lit hall.',
            width: 300,
            height: 200,
            x: 0,
            y: 0,
            connections: { right_door: { target: 'room-2' } },
        },
        'room-2': {
            id: 'room-2',
            name: 'The Deep Vault',
            description: 'Cold and metallic.',
            width: 320,
            height: 220,
            x: 900,
            y: 250,
            connections: { left_door: { target: 'room-1' } },
        },
    };
    const entities = {
        'ent-self': { id: 'ent-self', name: 'Bolt', location: 'room-1', spatial: { x: 100, y: 100 } },
        'ent-other': { id: 'ent-other', name: 'Rover', location: 'room-1', spatial: { x: 134, y: 100 } },
    };
    const droppedItems = {
        'dropped-1': { id: 'dropped-1', itemType: 'knife', name: 'Knife', x: 150, y: 120, roomId: 'room-1' },
    };
    const spy = vi.fn(() => [...fallbackEvents]);
    return {
        worldStateController: {
            getRecentEvents: spy,
            getEntity: (id) => entities[id] ?? null,
            getRooms: () => rooms,
            getEntities: () => entities,
            getDroppedItemsByRoom: (roomId) => (roomId === 'room-1' ? droppedItems : {}),
        },
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
        // Each event now carries an additive `context` (null here — no entityId).
        expect(body.events).toEqual(testEvents.map(ev => ({ ...ev, context: null })));

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

    it('GET /world-events with no entityId → 200, events carry context: null', async () => {
        const testEvents = [{ tick: 1, action: 'punch', message: 'hello', level: 'info', ts: 1000 }];
        const { worldStateController } = makeWorldStubWithRoom(testEvents);
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.events).toHaveLength(1);
        expect(body.events[0].context).toBeNull();
        expect(body.events[0].tick).toBe(1);
        expect(body.events[0].message).toBe('hello');

        server.close();
    });

    it('GET /world-events?entityId=ent-self → context describes the current room', async () => {
        const testEvents = [{ tick: 5, action: 'drop', message: 'dropped knife', level: 'info', ts: 2000 }];
        const { worldStateController } = makeWorldStubWithRoom(testEvents);
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events?entityId=ent-self`);
        const body = await res.json();

        expect(res.status).toBe(200);
        const ctx = body.events[0].context;
        expect(ctx).not.toBeNull();
        expect(ctx.roomId).toBe('room-1');
        expect(ctx.roomName).toBe('The Entrance Hall');
        expect(ctx.roomDescription).toBe('A dimly lit hall.');
        expect(ctx.roomWidth).toBe(300);
        expect(ctx.roomHeight).toBe(200);
        expect(ctx.playerPosition).toEqual({ x: 100, y: 100 });
        // Other same-room entities (player excluded), with positions.
        expect(ctx.entities).toEqual([{ name: 'Rover', x: 134, y: 100 }]);
        expect(ctx.droppedItems).toEqual([{ name: 'Knife', x: 150, y: 120 }]);
        // Exits resolved to room NAMES (not UIDs).
        expect(ctx.exits).toEqual([{ door: 'right_door', targetRoomName: 'The Deep Vault' }]);

        server.close();
    });

    // L4-4: entity without spatial → context.playerPosition is null (200)
    it('L4-4: a requesting entity without spatial → context.playerPosition is null (200)', async () => {
        const testEvents = [{ tick: 5, action: 'drop', message: 'dropped knife', level: 'info', ts: 2000 }];
        const { worldStateController } = makeWorldStubWithRoom(testEvents);
        // Strip spatial from the requesting entity.
        worldStateController.getEntity = (id) => {
            if (id === 'ent-self') return { id: 'ent-self', name: 'Bolt', location: 'room-1' };
            return null;
        };
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events?entityId=ent-self`);
        const body = await res.json();

        expect(res.status).toBe(200);
        const ctx = body.events[0].context;
        expect(ctx).not.toBeNull();
        expect(ctx.playerPosition).toBeNull();
        expect(ctx.roomId).toBe('room-1');

        server.close();
    });

    // L4-5: entityId provided but UNKNOWN entity → context null, 200, lean fields unchanged
    it('L4-5: a well-formed-but-unknown entityId → context null, 200, lean fields unchanged', async () => {
        const testEvents = [{ tick: 7, action: 'move', targetId: null, message: 'moved', level: 'info', ts: 3000 }];
        const { worldStateController } = makeWorldStubWithRoom(testEvents);
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events?entityId=ent-00000000-0000-0000-0000-000000000000`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.events).toHaveLength(1);
        expect(body.events[0].context).toBeNull();
        // Lean fields are unchanged.
        expect(body.events[0].tick).toBe(7);
        expect(body.events[0].action).toBe('move');
        expect(body.events[0].message).toBe('moved');
        expect(body.events[0].level).toBe('info');
        expect(body.events[0].ts).toBe(3000);

        server.close();
    });

    // L4-6: dangling connection target (door → non-existent room) → targetRoomName 'unknown'
    it('L4-6: a dangling connection target → context.exits targetRoomName is "unknown"', async () => {
        const testEvents = [{ tick: 9, action: 'punch', targetId: null, message: 'punched', level: 'info', ts: 4000 }];
        const { worldStateController } = makeWorldStubWithRoom(testEvents);
        // Inject a dangling connection: a door pointing to a room that does not exist.
        worldStateController.getRooms = () => ({
            'room-1': {
                id: 'room-1',
                name: 'The Entrance Hall',
                description: 'A dimly lit hall.',
                width: 300,
                height: 200,
                x: 0,
                y: 0,
                connections: {
                    ghost_door: { target: 'room-missing' },
                    right_door: { target: 'room-2' }
                }
            },
            'room-2': {
                id: 'room-2',
                name: 'The Deep Vault',
                description: 'Cold and metallic.',
                width: 320,
                height: 220,
                x: 900,
                y: 250,
                connections: { left_door: { target: 'room-1' } }
            }
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events?entityId=ent-self`);
        const body = await res.json();

        expect(res.status).toBe(200);
        const ctx = body.events[0].context;
        expect(ctx).not.toBeNull();
        expect(ctx.exits).toEqual([
            { door: 'ghost_door', targetRoomName: 'unknown' },
            { door: 'right_door', targetRoomName: 'The Deep Vault' }
        ]);

        server.close();
    });

    it('GET /world-events?entityId=<malformed> → 400', async () => {
        const { worldStateController } = makeWorldStubWithRoom([]);
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });

        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}/world-events?entityId=not-an-entity`);
        expect(res.status).toBe(400);

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

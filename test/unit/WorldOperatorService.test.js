/**
 * UNIT TEST — WorldOperatorService: the two world-structure intents.
 *
 * `create_room` and `spawn_world_object` are the live half of
 * `wiki/decisions/world-structure-authoring.md`: they change the running world, they are
 * memory only, and neither moves what already exists. What is pinned is the contract the
 * model sees — a proposal is refused with a rule list *before* it reaches the table, and
 * the same checks run again at execute (`T-1`) — and that the operation reaches the facade,
 * which owns the map, rather than a private path into it (`B-1`, `AP-5`).
 *
 * The world is a fake implementing the facade reads the service uses (`TST-3`); no LLM,
 * no filesystem.
 *
 * @module test/unit/WorldOperatorService
 */

import { describe, it, expect } from 'vitest';
import WorldOperatorService from '../../src/services/WorldOperatorService.js';

/**
 * A live world with two rooms, each reachable under both vocabularies: the uid the world
 * runs on and the key the `rooms` registry reads.
 * @param {Object} [overrides]
 * @returns {Object} the fake facade
 */
function makeWorld(overrides = {}) {
    const rooms = {
        'room-start': { id: 'room-start', name: 'The Entrance', width: 300, height: 200, connections: { right_door: { target: 'room-east' } } },
        'room-east': { id: 'room-east', name: 'Corridor', width: 200, height: 200, connections: {} },
        ...(overrides.rooms ?? {})
    };
    const logical = { start_room: 'room-start', east: 'room-east', ...(overrides.logical ?? {}) };
    /** @type {Array<[string, Object]>} the facade calls this service made */
    const calls = [];
    return {
        calls,
        getRooms: () => rooms,
        getRoomUidByLogicalId: (key) => logical[key] ?? null,
        getRoomLogicalId: (uid) => Object.keys(logical).find((key) => logical[key] === uid) ?? null,
        getEntity: () => null,
        createRoom: (spec) => {
            calls.push(['createRoom', spec]);
            return { logicalId: spec.logicalId, roomId: 'room-new', door: spec.connectFrom?.door ?? null, targetDoor: null };
        },
        spawnWorldObject: (spec) => {
            calls.push(['spawnWorldObject', spec]);
            return 'ent-prop';
        }
    };
}

/** A definition store with one blueprint and nothing else to resolve against. */
const store = {
    has: (kind) => kind === 'blueprints',
    read: (kind) => (kind === 'blueprints' ? { tree: { name: 'Tree' } } : {})
};

const service = (world = makeWorld()) => new WorldOperatorService({ worldStateController: world, registryStore: store });

/** A room definition the map would build. */
const definition = (over = {}) => ({
    name: 'Annex',
    connections: {},
    x: 400,
    y: 0,
    width: 200,
    height: 200,
    ...over
});

describe('create_room', () => {
    it('is offered to the operator, and a well-formed one stands', () => {
        const svc = service();
        const result = svc.validateAction('create_room', {
            logicalId: 'annex',
            definition: definition(),
            connectFrom: { roomId: 'room-start', door: 'north_door' }
        });
        expect(result.ok).toBe(true);
        expect(result.intent.summary).toContain('annex');
    });

    it('names a source room by its registry key as well as by its live id', () => {
        const svc = service();
        expect(svc.validateAction('create_room', {
            logicalId: 'annex', definition: definition(), connectFrom: { roomId: 'start_room', door: 'north_door' }
        }).ok).toBe(true);
    });

    it('refuses a room nobody can reach: connectFrom is not optional', () => {
        const svc = service();
        const result = svc.validateAction('create_room', { logicalId: 'annex', definition: definition() });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('connectFrom');
    });

    it('refuses the room boot would refuse, an installed key, an unknown source room and a door name already used', () => {
        const svc = service();
        const base = { logicalId: 'annex', definition: definition(), connectFrom: { roomId: 'room-start', door: 'north_door' } };
        expect(svc.validateAction('create_room', { ...base, definition: { name: 'Annex' } }).errors.join(' '))
            .toContain('must have numeric');
        expect(svc.validateAction('create_room', { ...base, logicalId: 'start_room' }).errors.join(' '))
            .toContain('already installed');
        expect(svc.validateAction('create_room', { ...base, connectFrom: { roomId: 'nowhere', door: 'north_door' } }).errors.join(' '))
            .toContain('no room "nowhere"');
        expect(svc.validateAction('create_room', { ...base, connectFrom: { roomId: 'room-start', door: 'right_door' } }).errors.join(' '))
            .toContain('already has a door "right_door"');
    });

    it('executes through the facade, re-validating first, and reports what it did', () => {
        const world = makeWorld();
        const svc = service(world);
        const intent = svc.validateAction('create_room', {
            logicalId: 'annex',
            definition: definition(),
            connectFrom: { roomId: 'start_room', door: 'north_door', targetDoor: 'back' }
        }).intent;

        const report = svc.executeActions([intent]);

        expect(report.results[0].status).toBe('ok');
        expect(world.calls.map(([name]) => name)).toEqual(['createRoom']);
        expect(world.calls[0][1]).toMatchObject({
            logicalId: 'annex',
            connectFrom: { roomId: 'start_room', door: 'north_door', targetDoor: 'back', position: null }
        });
    });

    it('is refused at execute too when the world moved in between', () => {
        const world = makeWorld();
        const svc = service(world);
        const intent = svc.validateAction('create_room', {
            logicalId: 'annex', definition: definition(), connectFrom: { roomId: 'room-start', door: 'north_door' }
        }).intent;
        // Someone opened that door while the plan sat on the table.
        world.getRooms()['room-start'].connections.north_door = { target: 'room-east' };

        const report = svc.executeActions([intent]);

        expect(report.results[0].status).toBe('error');
        expect(report.results[0].error).toContain('already has a door');
        expect(world.calls).toEqual([]);
    });
});

describe('spawn_world_object', () => {
    it('places a prop whose blueprint exists, by uid or by room key', () => {
        const world = makeWorld();
        const svc = service(world);

        const byKey = svc.validateAction('spawn_world_object', { blueprint: 'tree', roomId: 'start_room', name: 'Fern', position: { x: 0, y: -80 } });
        expect(byKey.ok).toBe(true);
        const report = svc.executeActions([byKey.intent]);

        expect(report.results[0].status).toBe('ok');
        expect(world.calls).toEqual([['spawnWorldObject', {
            blueprint: 'tree', roomId: 'room-start', name: 'Fern', position: { x: 0, y: -80 }
        }]]);
    });

    it('refuses a blueprint the definition does not have, a room it cannot find, and a position that is not a point', () => {
        const svc = service();
        expect(svc.validateAction('spawn_world_object', { blueprint: 'unobtainium', roomId: 'room-start' }).errors.join(' '))
            .toContain('No "blueprints" definition "unobtainium"');
        expect(svc.validateAction('spawn_world_object', { blueprint: 'tree', roomId: 'nowhere' }).errors.join(' '))
            .toContain('No room "nowhere"');
        expect(svc.validateAction('spawn_world_object', { blueprint: 'tree', roomId: 'room-start', position: { x: 'left' } }).errors.join(' '))
            .toContain('position.x must be a finite number');
    });
});

describe('list_rooms', () => {
    it('answers with both vocabularies and the door names, so a proposal can name a target', () => {
        const rooms = service().listRooms().rooms;
        expect(rooms).toContainEqual(expect.objectContaining({
            id: 'room-start', logicalId: 'start_room', name: 'The Entrance', doors: ['right_door']
        }));
    });
});

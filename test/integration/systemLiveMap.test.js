/**
 * INTEGRATION TEST — the System's live map levers against a real world.
 *
 * The unit tests of `WorldOperatorService` run against a fake facade, which proves the
 * proposals are refused or accepted; only a real world proves the wiring — that
 * `create_room` reaches `RoomsController` and produces a room the rest of the graph can
 * actually use, and that `spawn_world_object` produces the same kind of prop boot spawns.
 *
 * The claims pinned here (`wiki/decisions/world-structure-authoring.md`):
 *
 *   - the live map grows: 3 rooms become 4, and the new one is reachable — an entity walks
 *     into it through the door the action opened in both directions;
 *   - the door geometry works on a runtime door (`getDoorPosition` resolves it);
 *   - a prop placed live is a real, `isStatic` entity in that room — the same tag boot's
 *     `_spawnStaticProps` gives, which is what keeps it out of the planner roster;
 *   - and the change is MEMORY ONLY: the definition the world restarts from does not gain
 *     the room. The package is what persists; this is the sentence the operator is told.
 *
 * The world is the official package set (`buildWorldState`), nothing is enabled or disabled,
 * so no state file is written.
 *
 * @module test/integration/systemLiveMap
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import WorldOperatorService from '../../src/services/WorldOperatorService.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

const ANNEX = 'itest_live_annex';

/** A room the map can be built from, joined to the official `start_room`. */
const annexDefinition = () => ({
    name: 'Live Annex',
    connections: {},
    x: 1500,
    y: 600,
    width: 240,
    height: 180,
    atmosphere: { lightLevel: 'bright', airQuality: 'clean', fog: 'none' },
    surface: 'tile',
    ceiling: 'vaulted',
    power: 'live'
});

/** A real world, and the operator service over its facade. */
function buildOperatedWorld() {
    const built = buildWorldState(null, null, {});
    return {
        wsc: built.worldStateController,
        store: built.registryStore,
        service: new WorldOperatorService({
            worldStateController: built.worldStateController,
            registryStore: built.registryStore
        })
    };
}

/** Propose then execute one action, returning the plan's single result. */
function run(service, operation, params) {
    const proposal = service.validateAction(operation, params);
    if (!proposal.ok) return { status: 'error', error: proposal.errors.join('; ') };
    return service.executeActions([proposal.intent]).results[0];
}

describe('the live map lever on a running world', () => {
    it('adds a room the world can walk into, and leaves the definition alone', () => {
        const { wsc, store, service } = buildOperatedWorld();
        const roomsAtStart = Object.keys(wsc.getRooms()).length;
        const startUid = wsc.getRoomUidByLogicalId('start_room');

        const result = run(service, 'create_room', {
            logicalId: ANNEX,
            definition: annexDefinition(),
            connectFrom: { roomId: 'start_room', door: 'annex_door', targetDoor: 'out' }
        });
        expect(result.status).toBe('ok');

        const annexUid = wsc.getRoomUidByLogicalId(ANNEX);
        expect(annexUid).toBeTruthy();
        expect(Object.keys(wsc.getRooms())).toHaveLength(roomsAtStart + 1);
        expect(wsc.getRooms()[annexUid]).toMatchObject({ name: 'Live Annex', x: 1500, width: 240, surface: 'tile' });
        // The door opened both ways, and the geometry that draws it and spawns traversal
        // resolves a runtime door exactly as an authored one.
        expect(wsc.getRooms()[annexUid].connections.out.target).toBe(startUid);
        expect(wsc.getRooms()[startUid].connections.annex_door.target).toBe(annexUid);
        expect(wsc.getDoorPosition(startUid, 'annex_door')).toMatchObject({ x: 150 });

        // Reachable, not merely present: an entity moves in and the world agrees it is there.
        const droid = wsc.spawnEntity('smallBallDroid', startUid);
        expect(run(service, 'move_entity', { entityId: droid, targetRoomId: annexUid }).status).toBe('ok');
        expect(wsc.getEntity(droid).location).toBe(annexUid);

        // Memory only. The room is the running world's, not the definition's — a restart
        // builds the map from the packages, which is why the prompt offers the package.
        expect(store.read(REGISTRY_KINDS.ROOMS)[ANNEX]).toBeUndefined();
    });

    it('places a prop that is the same kind of entity boot spawns', () => {
        const { wsc, service } = buildOperatedWorld();
        const startUid = wsc.getRoomUidByLogicalId('start_room');
        const atBoot = Object.values(wsc.getEntities()).filter((e) => e.isStatic).length;

        const result = run(service, 'spawn_world_object', {
            blueprint: 'tree', roomId: 'start_room', name: 'Live Tree', position: { x: 20, y: -30 }
        });
        expect(result.status).toBe('ok');

        const prop = wsc.getEntity(result.result);
        expect(prop).toMatchObject({ isStatic: true, name: 'Live Tree', location: startUid });
        expect(prop.spatial).toEqual({ x: 20, y: -30 });
        // The invariant that keeps a prop from stalling the planner: it is static, and the
        // count of them went up by exactly one.
        expect(Object.values(wsc.getEntities()).filter((e) => e.isStatic)).toHaveLength(atBoot + 1);
    });

    it('refuses an island room and a prop with no blueprint, against the real map', () => {
        const { service } = buildOperatedWorld();

        expect(run(service, 'create_room', {
            logicalId: 'itest_island', definition: { name: 'Island', connections: {}, x: 0, y: 0, width: 50, height: 50 }
        }).error).toContain('connectFrom');
        expect(run(service, 'create_room', {
            logicalId: 'start_room', definition: annexDefinition(), connectFrom: { roomId: 'start_room', door: 'another_door' }
        }).error).toContain('already installed');
        expect(run(service, 'spawn_world_object', { blueprint: 'unobtainium', roomId: 'start_room' }).error)
            .toContain('unobtainium');
    });
});

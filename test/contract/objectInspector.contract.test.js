/**
 * Object Inspector — contract tests for the object inspection payload
 * (wiki/subMDs/frontend/object_viewer.md; GET /world-objects/:entityId via
 * WorldStateController.getObjectInspectData()).
 *
 * The payload answers "what is inside this object and what does it do per
 * turn" (the knife-generator use case: how many knives does it generate per
 * turn). These tests pin, against the real world boot:
 *   - the envelope shape (entity / components / items / inventory /
 *     production / takeOptions — the exact keys the client renders);
 *   - the knife generator's production line: 1 knife every 1 turn, 10-volume
 *     host, "active" — derived from the same data the round-start overTime
 *     channel fires from (no second source of truth);
 *   - the stored count tracking the overTime channel across rounds, and the
 *     inventory summary staying in sync (used = stored × item volume);
 *   - the organ description including the generateItem clause (the shared
 *     InternalComponentUtils enrichment the broadcast also applies);
 *   - the production `active` gate mirroring processTurnEffects (broken organ
 *     or broken host ⇒ halted);
 *   - null for unknown ids (the route's 404 path).
 *
 * @module test/contract/objectInspector.contract
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/** Fresh world with the knifeGenerator prop auto-spawned. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    const gen = findEntity(world, 'knifeGenerator');
    expect(gen, 'knifeGenerator prop must spawn at boot').toBeTruthy();
    return { world, genId: gen.id, startRoomId: world.roomsController.getUidByLogicalId('start_room') };
}

function findEntity(wsc, blueprint) {
    return Object.values(wsc.getAll().entities).find(e => e.blueprint === blueprint);
}

/** Drives the per-turn overTime channel directly (same seam the turn system uses). */
function driveRound(world, round) {
    world.internalComponentController.processTurnEffects(round);
}

/** The single production entry of the generator's inspect payload. */
function theProducer(world, genId) {
    const payload = world.getObjectInspectData(genId);
    expect(payload.production.length, 'the generator has exactly one producer').toBe(1);
    return payload.production[0];
}

describe('Object Inspector — getObjectInspectData payload contract (knife generator)', () => {
    it('returns null for an unknown entity id (the route 404 path)', () => {
        const { world } = buildWorld();
        expect(world.getObjectInspectData('no-such-entity')).toBeNull();
    });

    it('lists only non-static entities with components in takeOptions', () => {
        const { world, genId, startRoomId } = buildWorld();
        const droidId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const droid = world.stateEntityController.getEntity(droidId);

        const p = world.getObjectInspectData(genId);
        expect(Array.isArray(p.takeOptions)).toBe(true);
        const mine = p.takeOptions.find(o => o.id === droidId);
        expect(mine, 'the spawned droid is a take destination').not.toBeNull();
        const ball = mine.components.find(c => c.type === 'centralBall');
        expect(ball, 'the droid centralBall is offered').not.toBeNull();
        expect(ball.capacity, 'centralBall form.volume from data/components.json').toBe(10);
        // Used tracks the droid's live items (a spawned droid carries a
        // starter kit, so this is computed, not assumed).
        const expectedUsed = droid.items
            .filter(i => i.hostComponentId === ball.id)
            .reduce((s, i) => s + (i.hostVolume ?? i.volume ?? 0), 0);
        expect(ball.used).toBe(expectedUsed);

        // The generator itself (static) is never a take destination, even
        // though it has free volume.
        expect(p.takeOptions.find(o => o.id === genId), 'static props excluded').toBeUndefined();
    });

    it('reports live used capacity in takeOptions after items land in the droid', () => {
        const { world, genId, startRoomId } = buildWorld();
        const droidId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const droid = world.stateEntityController.getEntity(droidId);
        const ball = droid.components.find(c => c.type === 'centralBall');

        const baseline = droid.items
            .filter(i => i.hostComponentId === ball.id)
            .reduce((s, i) => s + (i.hostVolume ?? i.volume ?? 0), 0);

        const knifeDef = world.inventoryManager.getItemDefinition('knife');
        const knifeVol = knifeDef && knifeDef.form && typeof knifeDef.form.volume === 'number'
            ? knifeDef.form.volume : 1;
        const added = world.addItemToEntity(droidId, 'knife', ball.id);
        expect(added.success, added.message).toBe(true);

        const p = world.getObjectInspectData(genId);
        const mine = p.takeOptions.find(o => o.id === droidId);
        const live = mine.components.find(c => c.type === 'centralBall');
        expect(live.used, 'the knife volume counts against the droid capacity').toBe(baseline + knifeVol);
        expect(live.capacity).toBe(10);
    });

    it('has the exact envelope shape the client renders', () => {
        const { world, genId } = buildWorld();
        const p = world.getObjectInspectData(genId);

        expect(p).toHaveProperty('entity');
        expect(p).toHaveProperty('components');
        expect(p).toHaveProperty('items');
        expect(p).toHaveProperty('inventory');
        expect(p).toHaveProperty('production');
        expect(p).toHaveProperty('takeOptions');
        expect(Array.isArray(p.takeOptions)).toBe(true);
        for (const t of p.takeOptions) {
            expect(Object.keys(t).sort()).toEqual(['components', 'id', 'name'].sort());
            for (const c of t.components) {
                expect(Object.keys(c).sort()).toEqual(['capacity', 'id', 'type', 'used'].sort());
            }
        }

        expect(Object.keys(p.entity).sort()).toEqual(
            ['blueprint', 'id', 'isStatic', 'name', 'roomId', 'roomName', 'spatial'].sort()
        );
        expect(p.entity.isStatic).toBe(true);
        expect(p.entity.name).toBe('Knife Generator');
        expect(p.entity.roomName, 'room resolved by name, not just id').toBeTruthy();

        for (const c of p.components) {
            expect(Object.keys(c).sort()).toEqual(
                ['broken', 'existence', 'form', 'id', 'internalComponents', 'materials', 'stats', 'type', 'volume', 'exists'].sort()
            );
        }
        for (const i of p.items) {
            expect(Object.keys(i).sort()).toEqual(
                ['description', 'hostComponentId', 'id', 'name', 'type', 'volume'].sort()
            );
        }
        expect(Object.keys(p.inventory).sort()).toEqual(['capacity', 'percent', 'used'].sort());
        for (const pr of p.production) {
            expect(Object.keys(pr).sort()).toEqual(
                ['active', 'capacity', 'countPerTurn', 'hostBroken', 'hostComponentId', 'intervalTurns',
                    'itemKey', 'itemName', 'itemVolume', 'organBroken', 'organDescription', 'organType', 'stored'].sort()
            );
        }
    });

    it('exposes the live component stats (existence + 10-volume capacity) for the iron host', () => {
        const { world, genId } = buildWorld();
        const p = world.getObjectInspectData(genId);

        expect(p.components.length).toBe(1);
        const comp = p.components[0];
        expect(comp.type).toBe('generatorCore');
        expect(comp.exists).toBe(true);
        expect(comp.broken).toBe(false);
        expect(comp.existence).toBe(1);
        expect(comp.volume, 'the 10-slot host capacity').toBe(10);
        expect(comp.stats.Physical.volume).toBe(10);
        // The full live stats store crosses the wire (the stats the user asked about).
        expect(comp.stats.Physical.existence).toBe(1);
        expect(comp.materials?.[0]?.material).toBe('iron');
    });

    it('states the production line: 1 knife every 1 turn, active, nothing stored yet at r0', () => {
        const { world, genId } = buildWorld();
        const prod = theProducer(world, genId);

        expect(prod.organType).toBe('knifeGeneratorIC');
        expect(prod.itemKey).toBe('knife');
        expect(prod.itemName, 'resolved through the item definitions').toBe('Knife');
        expect(prod.itemVolume).toBe(1);
        expect(prod.countPerTurn, 'the user question: how many knives per turn').toBe(1);
        expect(prod.intervalTurns).toBe(1);
        expect(prod.active).toBe(true);
        expect(prod.organBroken).toBe(false);
        expect(prod.hostBroken).toBe(false);
        expect(prod.stored).toBe(0);
        expect(prod.capacity).toBe(10);
        // The shared generated description carries the generateItem clause —
        // the same prose the world-state broadcast shows.
        expect(prod.organDescription).toMatch(/produces 1 knife/);
    });

    it('the stored count tracks the overTime channel round by round (r0 → r3 → r10, at capacity)', () => {
        const { world, genId } = buildWorld();

        // r0: the round-start gate fires nothing (rounds start at 1).
        expect(world.getObjectInspectData(genId).production[0].stored).toBe(0);

        driveRound(world, 1);
        driveRound(world, 2);
        driveRound(world, 3);
        const p3 = world.getObjectInspectData(genId);
        expect(p3.production[0].stored, '3 knives stored by r3').toBe(3);
        expect(p3.inventory.used, '3 × 1 volume').toBe(3);
        expect(p3.inventory.capacity).toBe(10);
        expect(p3.inventory.percent, '30%').toBe(30);
        expect(p3.items.length).toBe(3);
        expect(p3.items.every(i => i.type === 'knife' && i.name === 'Knife')).toBe(true);

        driveRound(world, 4);
        driveRound(world, 5);
        driveRound(world, 6);
        driveRound(world, 7);
        driveRound(world, 8);
        driveRound(world, 9);
        driveRound(world, 10);
        const p10 = world.getObjectInspectData(genId);
        expect(p10.production[0].stored, 'host full at 10 by r10').toBe(10);
        expect(p10.inventory.percent, '100%').toBe(100);
        expect(p10.production[0].active, 'still active at capacity (it sheds, it does not stop)').toBe(true);
    });

    it('production halts when the host component is broken (the same gate processTurnEffects applies)', () => {
        const { world, genId } = buildWorld();
        driveRound(world, 1);

        // Drive the host's existence to zero in the stats store directly (NOT
        // through the facade delta — the facade path fires the break cascade
        // and despawns the entity, which is the OTHER contract, tested in
        // knifeGenerator.contract.test.js). Here we want the payload's gate
        // evaluated against a broken-but-present host.
        const compId = world.getObjectInspectData(genId).components[0].id;
        world.componentController.statsController.setStats(compId, { Physical: { existence: 0 } });

        const p = world.getObjectInspectData(genId);
        expect(p.components[0].broken, 'existence 0 ⇒ broken').toBe(true);
        expect(p.production[0].active, 'gate: host broken ⇒ halted').toBe(false);
        expect(p.production[0].hostBroken).toBe(true);
    });

    it('production halts when the organ itself is flagged broken (organ gate, independent of the host)', () => {
        const { world, genId } = buildWorld();
        driveRound(world, 1);

        const compId = world.getObjectInspectData(genId).components[0].id;
        const instance = world.internalComponentController.internalComponents[genId][compId][0];
        instance.broken = true; // the flag the break cascade sets when a host dies

        const p = world.getObjectInspectData(genId);
        expect(p.production[0].active, 'gate: organ broken ⇒ halted').toBe(false);
        expect(p.production[0].organBroken).toBe(true);
        expect(p.production[0].hostBroken, 'host is fine — only the organ is broken').toBe(false);
    });

    it('works for a non-static entity too (the panel is generic; the map opens it for objects)', () => {
        const { world, startRoomId } = buildWorld();
        // The bare composition world only auto-spawns static props — spawn an
        // M1 droid explicitly to prove the payload is entity-generic.
        const droidId = world.stateEntityController.spawnEntity('m1Droid', startRoomId);
        const droid = world.stateEntityController.getEntity(droidId);
        expect(droid, 'the M1 droid spawned').toBeTruthy();
        const p = world.getObjectInspectData(droidId);
        expect(p.entity.isStatic).toBe(false);
        expect(p.components.length, 'the M1 has several components').toBeGreaterThan(1);
        expect(Array.isArray(p.items)).toBe(true);
        expect(Array.isArray(p.production)).toBe(true);
    });
});

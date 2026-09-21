import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

const GEN_POS = { x: -80, y: 0 };

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

/** Knives currently stored in the generator's host component inventory. */
function knivesInGenerator(world, genId) {
    let n = 0;
    for (const list of Object.values(world.getEntityItems(genId) || {})) {
        for (const item of list || []) if (item?.type === 'knife') n++;
    }
    return n;
}

/** Knives on the floor (all rooms). */
function knifeDrops(world) {
    return Object.values(world.getDroppedItems() || []).filter(d => d?.itemType === 'knife').length;
}

function dropsOfType(world, type) {
    return Object.values(world.getDroppedItems() || []).filter(d => d?.itemType === type).length;
}

function driveRound(world, round) {
    world.internalComponentController.processTurnEffects(round);
}

/** The strongest punch component on the given NPC. */
function strongestPunchComponent(world, entityId) {
    const inst = world.getAll().components.instances;
    const npc = world.stateEntityController.getEntity(entityId);
    const comps = npc.components;
    let best = -1, id = comps[0].id;
    for (const c of comps) {
        const s = inst[c.id]?.Physical?.strength || 0;
        if (s > best) { best = s; id = c.id; }
    }
    return id;
}

/** Move a puncher NPC next to the generator and punch it to death. */
function punchToDeath(world, genId, puncherId, attackerComponentId) {
    const genStart = findEntity(world, 'knifeGenerator');
    // Puncher sits 40 units toward-camera from the generator (same geometry as the tree punch).
    world.stateEntityController.updateEntitySpatial(puncherId, { x: genStart.spatial.x, y: genStart.spatial.y - 40 });
    for (let i = 0; i < 40; i++) {
        const g = findEntity(world, 'knifeGenerator');
        if (!g) break;
        world.executeAction('droid punch', puncherId, {
            attackerComponentId,
            targetComponentId: g.components[0].id,
            targetEntityId: g.id,
        });
    }
}

describe('Knife Generator — data-driven, fuel-free item organ (generateItem overTime)', () => {
    it('spawns as an isStatic prop at (-80, 0), 100% iron, volume 10, with the generateItem organ and no loadout', () => {
        const { world, genId, startRoomId } = buildWorld();
        const gen = world.stateEntityController.getEntity(genId);
        expect(gen.isStatic, 'generator is a static prop').toBe(true);
        expect(gen.name, 'generator has its display name').toBe('Knife Generator');
        expect(gen.spatial, 'generator sits at the placed position').toEqual(GEN_POS);
        expect(gen.location, 'generator is in the entrance hall').toBe(startRoomId);
        expect(gen, 'no items attached to a static prop').not.toHaveProperty('items');
        expect(gen, 'not an NPC').not.toHaveProperty('isNPC');

        // 100% iron matter and a 10-unit host (the knife capacity).
        const compId = gen.components[0].id;
        expect(world.getComponentStats(compId).Physical.volume).toBe(10);
        // The host is 100% iron (single material, fraction 1.0), with a 10-slot bounded inventory.
        const compDef = world.getAll().components.registry[gen.components[0].type];
        expect(compDef.materials?.[0]?.material, 'host is iron').toBe('iron');
        expect(compDef.materials?.length, 'host is a single-material 100% composition').toBe(1);
        expect(compDef.materials?.[0]?.fraction).toBe(1);
        expect(compDef.traits?.Physical?.volume, 'host has a 10-slot inventory capacity').toBe(10);

        // The generateItem organ auto-installed on the host component.
        const ics = world.internalComponentController.getInternalComponents(genId, compId);
        expect(ics.some(i => i.type === 'knifeGeneratorIC'), 'knifeGeneratorIC organ present').toBe(true);
    });

    it('round 0 is a no-op — no knives yet before the first tick', () => {
        const { world, genId } = buildWorld();
        driveRound(world, 0);
        expect(knivesInGenerator(world, genId), 'nothing stored at r0').toBe(0);
        expect(knifeDrops(world), 'nothing shed at r0').toBe(0);
    });

    it('generates 1 knife per round into its inventory until the host is full (intervalTurns 1, capacity 10)', () => {
        const { world, genId } = buildWorld();
        driveRound(world, 1);
        driveRound(world, 2);
        driveRound(world, 3);
        expect(knivesInGenerator(world, genId), '3 knives stored by r3').toBe(3);
        expect(knifeDrops(world), 'still nothing shed').toBe(0);
    });

    it('at capacity the extra fire sheds a knife to the floor around the generator; inventory stays at 10', () => {
        const { world, genId, startRoomId } = buildWorld();
        // Fill the host (r1..r10 -> 10 knives, full capacity).
        for (let r = 1; r <= 10; r++) driveRound(world, r);
        expect(knivesInGenerator(world, genId), 'host full at 10').toBe(10);
        expect(knifeDrops(world), 'still nothing shed').toBe(0);

        // r11: host at capacity -> the 11th knife sheds to the floor instead.
        driveRound(world, 11);
        expect(knivesInGenerator(world, genId), 'host stays full at 10').toBe(10);
        expect(knifeDrops(world), '1 shed to the floor').toBe(1);

        // The shed knife lives in the generator's room at finite, near-by coords.
        const shed = Object.values(world.getDroppedItems()).find(d => d.itemType === 'knife');
        expect(shed, 'a knife exists on the floor').toBeTruthy();
        expect(shed.roomId, 'shed in the generator\'s room').toBe(startRoomId);
        expect(Number.isFinite(shed.x) && Number.isFinite(shed.y), 'shed at finite spatial coords').toBe(true);

        // A couple more rounds: 2, then 3 total shed; inventory still pinned at 10.
        driveRound(world, 12);
        driveRound(world, 13);
        expect(knifeDrops(world), '3 total shed by r13').toBe(3);
        expect(knivesInGenerator(world, genId), 'inventory pinned at capacity').toBe(10);
    });

    it('breaking the generator despawns it and spills its stored knives + sheds iron chunks', () => {
        const { world, genId, startRoomId } = buildWorld();
        // Generate a handful first so there are stored knives to spill on break.
        for (let r = 1; r <= 5; r++) driveRound(world, r);
        expect(knivesInGenerator(world, genId), '5 stored before break').toBe(5);

        // The registry no longer ships a puncher droid (the smallBallDroid
        // "Rogue Droid" entry was removed from data/npcs.json): spawn one.
        const puncher = world.getEntity(world.stateEntityController.spawnEntity('smallBallDroid', startRoomId));
        const attacker = strongestPunchComponent(world, puncher.id);

        const knivesBeforeBreak = knifeDrops(world);
        punchToDeath(world, genId, puncher.id, attacker);

        const after = findEntity(world, 'knifeGenerator');
        expect(after, 'generator despawns when its host is destroyed').toBeFalsy();
        // The 5 stored knives spilled onto the floor (broken-component cascade).
        expect(knifeDrops(world) - knivesBeforeBreak, 'stored knives spilled on break').toBeGreaterThanOrEqual(5);
        // The 100%-iron host sheds iron chunks.
        expect(dropsOfType(world, 'chunk_iron'), 'iron host sheds iron chunks').toBeGreaterThanOrEqual(1);
    });
});

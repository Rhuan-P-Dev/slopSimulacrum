/**
 * Contract tests for the world-objects system (static props) — see
 * wiki/subMDs/systems/world_objects.md.
 *
 * A world object (e.g. the tree in data/worldObjects.json) is materialized at
 * boot as a STATIC ENTITY (isStatic: true) built from a blueprint. Being a real
 * entity, it is targetable and damageable through the normal combat pipeline
 * (a punch drains its component's existence; at 0 it breaks, drops material
 * chunks, and despawns). Being isStatic, it is excluded from the turn roster,
 * so it never plans, signals, or gates the all-ready planning barrier — the
 * load-bearing invariant that keeps a decorative object from stalling the world.
 */
import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

const findEntity = (wsc, blueprint) =>
    Object.values(wsc.getAll().entities).find(e => e.blueprint === blueprint);

describe('World objects (static props) — data/worldObjects.json', () => {
    it('spawns the declared tree as an isStatic entity at the declared position with real matter and no loadout', () => {
        const { worldStateController: wsc } = buildWorldState(null);
        const tree = findEntity(wsc, 'tree');

        expect(tree, 'the tree prop should spawn at boot').toBeTruthy();
        expect(tree.isStatic).toBe(true);
        expect(tree.name).toBe('Tree');
        // Position straight from data/worldObjects.json (center-top: x 0, y -80).
        expect(tree.spatial).toEqual({ x: 0, y: -80 });
        // Matter is real, validated data — the tree component is 100% wood.
        const compId = tree.components[0].id;
        const stats = wsc.getComponentStats(compId);
        expect(stats.Physical.volume).toBe(40);
        // A prop is not a droid — it never carries the player's world.json loadout.
        expect(tree).not.toHaveProperty('items');
        expect(tree).not.toHaveProperty('isNPC');
    });

    it('excludes the prop from the turn roster (a prop must never gate the barrier)', () => {
        const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        const { worldStateController: wsc, subControllers } = buildWorldState(tick);
        const turns = subControllers.turnSystemController;
        // Spawn a test droid so there is at least one non-NPC actor besides the
        // data-driven NPCs; advance the turn machine deterministically (the
        // spec's "set tick N, onTick()" primitive) to build the round roster.
        const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
        wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        tick.currentTick = 1;
        turns.onTick();

        const tree = findEntity(wsc, 'tree');
        const state = wsc.getAll();
        const roster = (state.turns.actorOrder || []).map(a => a.entityId);
        expect(roster, 'roster should be populated (droid + NPCs)').not.toHaveLength(0);
        expect(roster, 'the prop is never an actor').not.toContain(tree.id);
        expect(state.turns.barrier?.pendingEntityIds || [], 'the prop is never a pending planner')
            .not.toContain(tree.id);
    });

    it('is hittable: a punch drains its component existence', () => {
        const { worldStateController: wsc } = buildWorldState(null);
        const tree = findEntity(wsc, 'tree');
        // The registry no longer ships a puncher droid (the smallBallDroid
        // "Rogue Droid" entry was removed from data/npcs.json): spawn one,
        // the same way test 1 spawns its roster droid.
        const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
        const rogue = wsc.getEntity(wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId));
        // Move the puncher next to the tree (tree at (0,-80); punch range 100).
        wsc.stateEntityController.updateEntitySpatial(rogue.id, { x: 0, y: -40 });

        const instances = wsc.getAll().components.instances;
        let attacker = rogue.components[0].id;
        for (const c of rogue.components) {
            if ((instances[c.id]?.Physical?.strength || 0) >= 15) { attacker = c.id; break; }
        }
        const compId = tree.components[0].id;
        const before = wsc.getComponentStats(compId).Physical.existence;

        const res = wsc.executeAction('droid punch', rogue.id, {
            attackerComponentId: attacker,
            targetComponentId: compId,
            targetEntityId: tree.id,
        });

        expect(res.success, `punch should connect: ${res?.error}`).toBe(true);
        const after = wsc.getComponentStats(compId).Physical.existence;
        expect(after, 'the punch must drain the prop\'s existence').toBeLessThan(before);
    });

    it('breaks and despawns, dropping wood chunks (the loop closes)', () => {
        const { worldStateController: wsc } = buildWorldState(null);
        const tree = findEntity(wsc, 'tree');
        expect(tree, 'the tree should exist before we start breaking it').toBeTruthy();
        // Same test-spawned puncher as the hittable test (registry rogue removed).
        const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
        const rogue = wsc.getEntity(wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId));
        wsc.stateEntityController.updateEntitySpatial(rogue.id, { x: 0, y: -40 });

        const instances = wsc.getAll().components.instances;
        let attacker = rogue.components[0].id;
        for (const c of rogue.components) {
            if ((instances[c.id]?.Physical?.strength || 0) >= 15) { attacker = c.id; break; }
        }

        // Punch until the prop is gone.
        for (let i = 0; i < 10; i++) {
            const t = findEntity(wsc, 'tree');
            if (!t) break;
            wsc.executeAction('droid punch', rogue.id, {
                attackerComponentId: attacker,
                targetComponentId: t.components[0].id,
                targetEntityId: t.id,
            });
        }

        expect(findEntity(wsc, 'tree'), 'the broken prop should be despawned').toBeFalsy();
        // Breaking a 100%-wood prop drops wood chunks on the ground.
        const chunks = Object.values(wsc.getAll().droppedItems || {})
            .filter(d => d.itemType === 'chunk_wood');
        expect(chunks.length, 'the broken tree should have dropped wood chunks').toBeGreaterThan(0);
    });
});

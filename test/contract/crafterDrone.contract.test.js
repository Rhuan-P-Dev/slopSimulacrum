/**
 * Crafter Drone contract test — full real world (data files + composition
 * root), no network, no mocks.
 *
 * Boots the world via buildWorldState and drives the turn machine manually by
 * advancing the tick clock (same pattern as
 * test/contract/TurnSystem.contract.test.js). The deterministic brain is
 * registered exactly as server.js does it (NpcAIController via setNpcAgent).
 *
 * Covers the spec §5 contract checklist:
 *   1. Drone boots in start_room with the correct flags (isNPC, craft_loop,
 *      displayName) and the room-center position; component set matches the
 *      blueprint with the stats from data/components.json.
 *   2. Full end-to-end cycle over ≥3 tick rounds: dropped knife → approach →
 *      knife in inventory → T1 crafted → NEW dropped t1 on the ground at the
 *      drone's position with ownerId === drone.id.
 *   3. Three rounds with no knife → spatial unchanged, no items, no drops.
 *   4. Data contract: `single_knife_to_t1` exists in the real
 *      CraftingController registry with the exact inputs/outputs, and the
 *      knife/t1 item types exist in the item registry; the 2-knife
 *      `knife_to_t1` recipe is untouched.
 *   5. Regression guard (spec §7.2.5): the smallBallDroid rogue still spawns
 *      (isNPC, displayName, chase_attack, start_room) and still pursues over
 *      one driven round (closes the gap by one move step; drone untouched).
 *
 * @module test/contract/crafterDrone.contract
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import NpcAIController from '../../src/controllers/ai/NpcAIController.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import {
    MAX_TICKS_PER_SECOND,
    TURN_NPC_AGENT_TICK,
    TURN_PLANNING_TICKS,
    TURN_ROUND_TICKS
} from '../../src/utils/Constants.js';

describe('Crafter Drone contract (real world, data-driven)', () => {

    let tick, world, turns;
    let drone, rogue;

    beforeEach(() => {
        tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        ({ worldStateController: world } = buildWorldState(tick));
        // Sanctioned composition root (mirrors src/server.js:68) — documented exception.
        turns = world.turnSystemController;

        const all = () => Object.values(world.getEntities());
        drone = all().find(e => e.blueprint === 'crafterDrone');
        rogue = all().find(e => e.blueprint === 'smallBallDroid');
    });

    /** @returns {string} the UUID of the logical start room. */
    const startRoomId = () => world.getRoomUidByLogicalId('start_room');

    /**
     * Drops a knife at (x, y) using a temporary helper entity (public API
     * only), then removes the helper.
     * @param {number} x
     * @param {number} y
     */
    function dropKnifeAt(x, y) {
        const helper = world.spawnEntity('smallBallDroid', startRoomId());
        // Position the helper inside the dropItem range (≤100) of the target.
        // No facade equivalent for absolute spatial positioning (documented exception; the production AI never needs it).
        world.stateEntityController.updateEntitySpatial(helper, { x: x - 90, y });
        const head = world.getEntity(helper)
            .components.find(c => c.type === 'droidHead');
        const add = world.addItemToEntity(helper, 'knife', head.id);
        expect(add.success).toBe(true);

        const drop = world.executeAction('dropItem', helper, {
            itemId: add.item.id,
            itemType: 'knife',
            targetX: x,
            targetY: y
        });
        expect(drop.success).toBe(true);

        // The helper is scaffolding only — remove it after the drop.
        world.despawnEntity(helper);
    }

    /**
     * Registers the deterministic brain exactly as server.js does, and
     * drives ONE full turn round (start → agent → resolution) by advancing
     * the tick clock manually.
     */
    function registerBrainAndDrive() {
        const brain = new NpcAIController({
            worldStateController: world,
            turnSystemController: turns
        });
        turns.setNpcAgent((npcId, round) => {
            const ent = world.getEntity(npcId);
            if (NpcAIController.hasDeterministicBrain(ent)) {
                return brain.think(npcId, round, ent);
            }
            return { acted: false };
        });

        return async () => {
            // Drive the NEXT clean round (a multiple of the round length) so
            // each onTick lands on a distinct tick: start → agent → resolution.
            const base = (Math.floor(tick.currentTick / TURN_ROUND_TICKS) + 1) * TURN_ROUND_TICKS;
            tick.currentTick = base;                            // round start
            turns.onTick();
            tick.currentTick = base + TURN_NPC_AGENT_TICK;      // agent slot
            turns.onTick();
            // Settle margin for the fire-and-forget agent slot (synchronous
            // brain callback here); if a truly async agent (e.g. LLM) is ever
            // wired in, replace this sleep with the agent's promise.
            await new Promise(res => setTimeout(res, 25));
            tick.currentTick = base + TURN_PLANNING_TICKS;      // resolution
            turns.onTick();
        };
    }

    it('1. boots in start_room with the right flags and room-center position', () => {
        expect(drone).toBeDefined();
        const roomId = startRoomId();
        // Room lookup has no verified facade equivalent (documented exception).
        const room = world.roomsController.getRoom(roomId);
        expect(room).toBeDefined();

        // Flags stamped from data/npcs.json by _spawnNpcs.
        expect(drone.isNPC).toBe(true);
        expect(drone.name).toBe('Crafter Drone');
        expect(drone.npcConfig.personality).toBeTypeOf('string');
        expect(drone.npcConfig.personality.length).toBeGreaterThan(0);
        expect(drone.npcConfig.ai.behavior).toBe('craft_loop');
        expect(drone.npcConfig.ai.attackRange).toBeUndefined();

        // Spawned at the room center (midpoint of the room's bounding box),
        // in the start room.
        expect(drone.location).toBe(roomId);
        const center = {
            x: room.x + room.width / 2,
            y: room.y + room.height / 2
        };
        expect(drone.spatial.x).toBe(center.x);
        expect(drone.spatial.y).toBe(center.y);

        // Component set matches the blueprint (core + 2 arms + 2 wheels).
        const types = drone.components.map(c => c.type).sort();
        expect(types).toEqual([
            'crafterArm', 'crafterArm', 'crafterCore',
            'crafterRollingBall', 'crafterRollingBall'
        ]);

        // Stats from data/components.json (via the real stats controller).
        const core = drone.components.find(c => c.type === 'crafterCore');
        const arm = drone.components.find(c => c.type === 'crafterArm');
        const wheel = drone.components.find(c => c.type === 'crafterRollingBall');
        expect(world.getComponentStats(core.id).Physical).toMatchObject({
            durability: 100, mass: 20, volume: 12
        });
        expect(world.getComponentStats(arm.id).Physical).toMatchObject({
            durability: 50, strength: 10, volume: 6
        });
        expect(world.getComponentStats(wheel.id)).toMatchObject({
            Physical: { durability: 80, volume: 10 },
            Movement: { move: 10 }
        });
    });

    it('2. full cycle over ≥3 rounds: approach → pick → craft → T1 dropped at the drone, owned by it', async () => {
        // Deterministic world: remove the chase attacker (it would otherwise
        // fight the drone and disturb the forage loop).
        world.despawnEntity(rogue.id);

        // The knife is dropped 120 away (beyond PICK_RANGE) to force the
        // approach phase first.
        dropKnifeAt(270, 100);
        const knife = Object.values(world.getDroppedItems()).find(i => i.itemType === 'knife');
        expect(knife).toBeDefined();
        expect(knife.roomId).toBe(drone.location);

        const driveRound = registerBrainAndDrive();

        // Drive rounds until the forged T1 appears on the ground
        // (budget of 8; expected ≤ 6: 2× move + pick + craft/drop).
        let t1 = null;
        for (let i = 0; i < 8 && !t1; i++) {
            await driveRound();
            t1 = Object.values(world.getDroppedItems()).find(i => i.itemType === 't1');
        }

        // Converged: the T1 is on the ground at the drone's position, owned
        // by the drone, in its room.
        expect(t1).toBeDefined();
        const after = world.getEntity(drone.id);
        expect(t1.x).toBe(after.spatial.x);
        expect(t1.y).toBe(after.spatial.y);
        expect(t1.roomId).toBe(after.location);
        expect(t1.ownerId).toBe(drone.id);

        // The foraged knife no longer exists anywhere; the drone is empty.
        expect(Object.values(world.getDroppedItems()).some(i => i.itemType === 'knife')).toBe(false);
        expect(Object.values(world.getEntityItems(drone.id)).flat()).toHaveLength(0);

        // More than 3 tick rounds elapsed.
        expect(Math.floor(tick.currentTick / TURN_ROUND_TICKS)).toBeGreaterThanOrEqual(4);
    });

    it('3. three rounds with no knife: spatial unchanged, no items, no drops', async () => {
        // Same deterministic-world hygiene as test 2.
        world.despawnEntity(rogue.id);

        const driveRound = registerBrainAndDrive();
        const before = { ...world.getEntity(drone.id).spatial };

        for (let i = 0; i < 3; i++) {
            await driveRound();
        }

        const after = world.getEntity(drone.id).spatial;
        expect(after.x).toBe(before.x);
        expect(after.y).toBe(before.y);
        expect(Object.values(world.getDroppedItems())).toHaveLength(0);
        expect(Object.values(world.getEntityItems(drone.id)).flat()).toHaveLength(0);
    });

    it('4. data contract: single_knife_to_t1 recipe and item types via the real controllers', () => {
        const recipes = world.getCraftingRecipes();

        const recipe = recipes.find(r => r.id === 'single_knife_to_t1');
        expect(recipe).toBeDefined();
        expect(recipe.name).toBe('T1 Field Assembly');
        expect(recipe.description).toBe('Forge a single knife into a T1 container weapon.');
        expect(recipe.inputs).toEqual([{ type: 'knife', quantity: 1 }]);
        expect(recipe.outputs).toEqual([{ type: 't1', quantity: 1 }]);

        // Both item types resolve in the real item registry.
        const registry = world.getItemRegistry();
        expect(registry['knife']).toBeDefined();
        expect(registry['t1']).toBeDefined();

        // The pre-existing 2-knife recipe is untouched.
        expect(recipes.find(r => r.id === 'knife_to_t1')).toBeDefined();
    });

    it('5. regression guard (spec §7.2.5): the rogue droid still spawns with chase_attack and still pursues over a driven round', async () => {
        // Spawn assertions — the boot path still produces the rogue in start_room.
        expect(rogue).toBeDefined();
        expect(rogue.isNPC).toBe(true);
        expect(rogue.name).toBe('Rogue Droid');
        expect(rogue.npcConfig.ai.behavior).toBe('chase_attack');
        expect(rogue.location).toBe(startRoomId());

        const room = world.roomsController.getRoom(startRoomId()); // documented exception (test 1)
        const center = { x: room.x + room.width / 2, y: room.y + room.height / 2 };

        // Displace the rogue 120 units from the (stationary) drone toward the
        // room origin: same room, beyond the 100 attack range → chase_attack must
        // decide MOVE, not attack. Absolute spatial positioning has no facade
        // equivalent (documented exception, same as dropKnifeAt's helper).
        const d0 = Math.hypot(center.x - 0, center.y - 0);
        world.stateEntityController.updateEntitySpatial(rogue.id, {
            x: center.x + (0 - center.x) / d0 * 120,
            y: center.y + (0 - center.y) / d0 * 120
        });

        const brain = new NpcAIController({
            worldStateController: world,
            turnSystemController: turns
        });
        turns.setNpcAgent((npcId, round) => {
            const ent = world.getEntity(npcId);
            if (NpcAIController.hasDeterministicBrain(ent)) {
                return brain.think(npcId, round, ent);
            }
            return { acted: false };
        });

        // Drive ONE round, inspecting the queue between agent tick and resolution.
        const base = (Math.floor(tick.currentTick / TURN_ROUND_TICKS) + 1) * TURN_ROUND_TICKS;
        tick.currentTick = base;                      // round start (queue cleared)
        turns.onTick();
        tick.currentTick = base + TURN_NPC_AGENT_TICK; // agent slot — brains fire
        turns.onTick();
        await new Promise(res => setTimeout(res, 25)); // same settle margin as the helper

        // The rogue queued a MOVE toward the drone's position (its nearest entity).
        const queuedRogue = turns.getQueuedActions(rogue.id);
        expect(queuedRogue).toHaveLength(1);
        expect(queuedRogue[0].actionName).toBe('move');
        expect(queuedRogue[0].params).toEqual({ targetX: center.x, targetY: center.y });
        expect(queuedRogue[0].source).toBe('npc');

        // The drone (no knife in this fresh world) stays idle — it does not
        // react to the rogue.
        expect(turns.getQueuedActions(drone.id)).toHaveLength(0);

        // Resolution applies the queued move: the rogue closes 20 units (120 → 100).
        const before = world.getEntity(rogue.id).spatial;
        const distBefore = Math.hypot(center.x - before.x, center.y - before.y);
        tick.currentTick = base + TURN_PLANNING_TICKS; // resolution
        turns.onTick();

        const after = world.getEntity(rogue.id).spatial;
        const distAfter = Math.hypot(center.x - after.x, center.y - after.y);
        expect(distBefore).toBeCloseTo(120, 5);
        expect(distAfter).toBeLessThan(distBefore);
        expect(distAfter).toBeCloseTo(100, 5);

        // The drone never moved (nothing to forage).
        const droneAfter = world.getEntity(drone.id).spatial;
        expect(droneAfter.x).toBe(center.x);
        expect(droneAfter.y).toBe(center.y);
    });
});

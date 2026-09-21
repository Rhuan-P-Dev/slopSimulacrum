/**
 * Crafter Drone contract test — full real world (data files + composition
 * root), no network. ONE documented mock (same pattern as the KillerLlmDrone
 * tests): the DataLoader is served a fixture `data/npcs.json` whose entries
 * are verbatim copies of the registry this test was written against — the
 * live registry no longer ships the `crafterDrone` entry (removed from the
 * world), so the fixture keeps this pipeline contract independent of the
 * live registry.
 *
 * Boots the world via buildWorldState and drives the turn machine manually
 * by advancing the tick clock (same pattern as
 * test/contract/TurnSystem.contract.test.js). The deterministic brain is
 * registered exactly as server.js does it (NpcAIController via setNpcAgent).
 *
 * WHY THIS FILE WAS REBASED ONTO THE v2 TURN MACHINE (event-driven rounds,
 * wiki/llm_turns_npc_spec.md §5.1). This driver predated the v2 refactor:
 * it drove each round with three onTick() calls spaced by fixed tick
 * geometry (start → agent slot → resolution slot) derived from three
 * constants in src/utils/Constants.js (TURN_ROUND_TICKS,
 * TURN_NPC_AGENT_TICK, TURN_PLANNING_TICKS). The v2 refactor
 * (d15fcb6/9460fc2) deleted that geometry — and those constants — when it
 * moved rounds to event-driven semantics, but this file kept importing
 * them: the imports became undefined, the driver's round base became NaN,
 * and it poisoned the tick clock (tick.currentTick = NaN), so every round
 * "fired at tick NaN". The rebase removes the dead imports and drives by
 * v2 semantics instead:
 *   - ONE onTick() call per round (the round starts lazily on the first
 *     onTick and again on every subsequent tick);
 *   - the roster NPCs' agent callbacks fire at ROUND START, inside that
 *     same call;
 *   - the planning window closes when every roster planner has signaled
 *     plan-complete (event-driven — there is no deadline and no separate
 *     agent/resolution tick slot);
 *   - close AND resolution complete inside the same onTick() call; the
 *     next round starts on the next tick;
 *   - the tick clock is observability only (state.turns.currentTick,
 *     queue/watchdog timestamps) — nothing is derived from it, so the
 *     driver merely advances it by one per round;
 *   - a small settle window after each call lets the fire-and-forget
 *     agent promises settle (synchronous brain callback here); if a truly
 *     async agent (e.g. LLM) is ever wired in, replace that sleep with the
 *     agent's promise.
 * The v2 analogue of the old "inspect the queue between the agent tick and
 * resolution" is a SYNCHRONOUS inspection right after the onTick() call:
 * the agents have already queued, while the close/resolution settles in
 * the settle window that follows.
 *
 * MEASURED TIMELINE (real world; data-driven pickUpItem range 50 from
 * data/actions.json — the same source the handler validates; 20 px/round
 * from the moveCore grant 20 in data/internalComponents.json, resolved
 * through the move action's ":Movement.move" speed parameter — the last
 * wheel in the drone's component order wins the entity aggregation):
 * knife dropped 120 from the drone at (270, 100) → rounds 0–3: four
 * approach moves (120 → 40); round 4: immediate pickup at 40 ≤ 50
 * (zero cost); round 5: craft + drop → the T1 is first observable
 * after 6 onTick calls. The test budget is 10.
 *
 * Covers the spec §5 contract checklist:
 *   1. Drone boots in start_room with the correct flags (isNPC, craft_loop,
 *      displayName) and the room-center position; component set matches the
 *      blueprint with the stats from data/components.json.
 *   2. Full end-to-end cycle: dropped knife → approach → pick at the
 *      range boundary → T1 crafted → NEW dropped t1 on the ground at the
 *      drone's position with ownerId === drone.id.
 *   3. Three rounds with no knife → spatial unchanged, no items, no drops.
 *   4. Data contract: `single_knife_to_t1` exists in the real
 *      CraftingController registry with the exact inputs/outputs, and the
 *      knife/t1 item types exist in the item registry; the 2-knife
 *      `knife_to_t1` recipe is untouched.
 *
 * @module test/contract/crafterDrone.contract
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import NpcAIController from '../../src/controllers/ai/NpcAIController.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

// =========================================================================
// Fixture registry (verbatim copy of the data/npcs.json this test was
// written against — the live file no longer carries the crafterDrone entry,
// which was removed from the world)
// =========================================================================

const FIXTURE_NPCS = {
    crafterDrone: {
        displayName: 'Crafter Drone',
        personality: 'A tireless field-fabrication drone that forages dropped knives, forges each one into a T1 container weapon, and leaves the finished weapon on the ground.',
        room: 'start_room',
        ai: {
            behavior: 'craft_loop'
        }
    },
    killerLlmDrone: {
        displayName: 'Killer LLM Drone',
        room: 'start_room',
        personality: 'A cold, relentless hunter. It does not hesitate, does not warn, and does not stop.',
        objective: 'Attack all other entities: each round, strike the nearest entity you can reach; when nothing is in range, move toward the nearest one. Never help, never idle while a target is reachable.',
        maxWorldActionsPerRound: 2,
        maxChatMessagesPerRound: 0,
        envGate: 'KILLER_LLM_DRONE_ENABLED',
        initialItems: [
            { item: 't1', count: 1, equip: true, contents: [{ item: 'knife', count: 10 }] },
            { item: 'knife', count: 1, equip: true }
        ]
    }
};

// =========================================================================
// Top-level DataLoader mock (hoisted by vitest)
// =========================================================================

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');
    const realDefault = actual.default || {};

    return {
        default: {
            loadJsonSafe(path, defaultValue) {
                if (path === 'data/npcs.json') {
                    return FIXTURE_NPCS;
                }
                // Delegate all other paths to the real DataLoader
                if (realDefault.loadJsonSafe) {
                    return realDefault.loadJsonSafe(path, defaultValue);
                }
                return defaultValue;
            }
        }
    };
});

describe('Crafter Drone contract (real world, data-driven)', () => {

    let tick, world, turns;
    let drone;

    beforeEach(() => {
        tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        ({ worldStateController: world } = buildWorldState(tick));
        // Sanctioned composition root (mirrors src/server.js:68) — documented exception.
        turns = world.turnSystemController;

        const all = () => Object.values(world.getEntities());
        drone = all().find(e => e.blueprint === 'crafterDrone');
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
     * returns a driver that advances the world by ONE full turn round per
     * call — v2 event-driven semantics (see the header): one onTick() per
     * round (round start → agent fire at round start → all-ready close →
     * resolution, all inside that call), a one-tick advance for
     * observability, then a small settle window for the fire-and-forget
     * agent promises (synchronous brain callback here; if a truly async
     * agent (e.g. LLM) is ever wired in, replace the sleep with the
     * agent's promise).
     * @returns {() => Promise<void>} one round per call
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
            tick.currentTick += 1;   // v2: the tick clock is observability only
            turns.onTick();          // round start → agent fire → close + resolution
            await new Promise(res => setTimeout(res, 25)); // settle window
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
        // recipe→derivation: existence is on the 0–1 scale (new items start at 1),
        // and mass is derived from the components' material densities (not hand-tuned).
        expect(world.getComponentStats(core.id).Physical).toMatchObject({
            existence: 1, mass: 93.6, volume: 12
        });
        expect(world.getComponentStats(arm.id).Physical).toMatchObject({
            existence: 1, mass: 33.84, volume: 6
        });
        expect(world.getComponentStats(wheel.id).Physical).toMatchObject({
            existence: 1, volume: 10
        });
    });

    it('2. full cycle: dropped knife → approach → pick → craft → T1 dropped at the drone, owned by it', async () => {
        // The knife is dropped 120 away — beyond the data-driven pickUpItem
        // range (50, data/actions.json: the same source the handler
        // validates) — to force the approach phase first.
        dropKnifeAt(270, 100);
        const knife = Object.values(world.getDroppedItems()).find(i => i.itemType === 'knife');
        expect(knife).toBeDefined();
        expect(knife.roomId).toBe(drone.location);

        const driveRound = registerBrainAndDrive();

        // Drive rounds until the forged T1 appears on the ground
        // (budget of 10; measured 6 — see the header timeline: four
        // approach moves 120→40 at 20 px/round, pickup at 40 ≤ 50 in
        // round 4, craft + drop in round 5).
        let t1 = null;
        for (let i = 0; i < 10 && !t1; i++) {
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

        // The drone stopped the moment it entered the pickup range: the
        // knife was at x=270 and the resolved pickUpItem range is 50, so
        // the last of the 20 px/round approach moves (120 → 40) landed at
        // 230 and the pickup committed from 40 ≤ 50 — the range contract
        // (single source of truth, brain and handler) is the reason the
        // cycle converged at all.
        expect(after.spatial.x).toBe(230);
        expect(after.spatial.y).toBe(100);

        // The foraged knife no longer exists anywhere; the drone is empty.
        expect(Object.values(world.getDroppedItems()).some(i => i.itemType === 'knife')).toBe(false);
        expect(Object.values(world.getEntityItems(drone.id)).flat()).toHaveLength(0);

        // v2 equivalent of "more than 3 rounds elapsed": the round counter
        // is stored state (state.turns.roundNumber) — event-driven, never
        // derived from the tick clock.
        expect(turns.getRoundState().roundNumber).toBeGreaterThanOrEqual(4);
    });

    it('3. three rounds with no knife: spatial unchanged, no items, no drops', async () => {
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
});

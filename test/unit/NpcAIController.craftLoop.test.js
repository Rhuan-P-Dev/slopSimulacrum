/**
 * NpcAIController `craft_loop` behavior unit tests (Crafter Drone, spec §3/§4).
 *
 * Everything external is mocked (no composition root, no data files, no
 * network): the facade / turn system are hand-built objects exposing only
 * the surface the AI brain reads — same mock-facade pattern as
 * test/unit/NpcAIController.test.js.
 *
 * Covers the spec §4 decision-flow checklist:
 *   1. idle — nothing held, no knife dropped in the room (no calls at all)
 *   2. move — nearest in-room knife beyond PICK_RANGE → move queued, source 'npc'
 *   3. cross-room knife is ignored (own room only)
 *   4. pick-up at distance ≤ PICK_RANGE — including boundary 100 — via
 *      executePickUpItem on the CORE component; nothing queued (idle);
 *      4e — pickup rejected by the handler → visible rejection + clean idle
 *      (spec §4.4 edge)
 *   5. craft + drop — set-difference detection with a PRE-EXISTING T1 present
 *      (the new T1 id is dropped, not the old one)
 *   6. craft failure → idle (retry next round)
 *   7. capability-gate rejection → reason 'capability' (no dispatch)
 *   8. window closed (resolution phase) → decision discarded; no queue, no exec
 *   9. no turn system → immediate executeAction fallback
 *  10. multi-round convergence simulation (move… → pick → craft + drop)
 *
 * Simulation constants (e.g. the convergence step size) derive from the same
 * data files the system under test loads — a data change must change this
 * simulation, not be silently ignored by it.
 *
 * @module test/unit/NpcAIController.craftLoop
 */

import { describe, it, expect, vi } from 'vitest';
import NpcAIController from '../../src/controllers/ai/NpcAIController.js';
import DataLoader from '../../src/utils/DataLoader.js';
import Logger from '../../src/utils/Logger.js';
import { PICK_RANGE } from '../../src/utils/npcAiUtils.js';

// =========================================================================
// Fixtures
// =========================================================================

const DRONE_ID = 'ent-drone-0001';
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';
const CORE_ID = 'comp-core-d';

/** The single recipe the behavior uses (mirrors data/crafting.json). */
const RECIPE = {
    id: 'single_knife_to_t1',
    name: 'T1 Field Assembly',
    inputs: [{ type: 'knife', quantity: 1 }],
    outputs: [{ type: 't1', quantity: 1 }]
};

// Derived from the real component data (same source the stats controller
// loads) — no hardcoded movement: a data change must change this simulation,
// not be silently ignored by it.
const components = DataLoader.loadJsonSafe('data/components.json', {});
const stepSize = components.crafterRollingBall?.traits?.Movement?.move;
if (typeof stepSize !== 'number') throw new Error('crafterRollingBall.Movement.move missing in data/components.json');

function makeDrone(overrides = {}) {
    return {
        id: DRONE_ID,
        name: 'Crafter Drone',
        blueprint: 'crafterDrone',
        isNPC: true,
        location: ROOM_A,
        spatial: { x: 0, y: 0 },
        components: [
            { id: CORE_ID, type: 'crafterCore' },
            { id: 'comp-arm-l', type: 'crafterArm' },
            { id: 'comp-arm-r', type: 'crafterArm' },
            { id: 'comp-ball-l', type: 'crafterRollingBall' },
            { id: 'comp-ball-r', type: 'crafterRollingBall' }
        ],
        npcConfig: {
            personality: 'A tireless field-fabrication drone.',
            ai: { behavior: 'craft_loop' }
        },
        ...overrides
    };
}

/**
 * Builds the mock facade + turn system for a craft_loop scenario.
 *
 * @param {Object} [opts]
 * @param {Object[]} [opts.held] — items held by the drone
 *   (`{ id, type, hostComponentId }`)
 * @param {Object[]} [opts.dropped] — dropped items
 *   (`{ id, itemType, roomId, x, y }`)
 * @param {'planning'|'resolution'} [opts.phase='planning']
 * @param {boolean} [opts.noTurnSystem=false] — null turn system (immediate exec)
 * @param {function} [opts.capabilityGate] — custom canEntityExecuteAction
 * @param {function} [opts.craftItems] — custom craft implementation
 * @param {function} [opts.executePickUpItem] — custom pickup implementation
 * @returns {{
 *   facade: Object,
 *   turnSystem: Object|null,
 *   brain: NpcAIController,
 *   calls: {
 *     queueAction: Array,
 *     executeAction: Array,
 *     craftItems: Array,
 *     executePickUpItem: Array
 *   }
 * }}
 */
function buildCraftLoopWorld(opts = {}) {
    const held = Array.isArray(opts.held) ? [...opts.held] : [];
    const dropped = Array.isArray(opts.dropped) ? [...opts.dropped] : [];
    const drone = opts.drone ?? makeDrone();

    const calls = {
        queueAction: [],
        executeAction: [],
        craftItems: [],
        executePickUpItem: []
    };

    const facade = {
        getEntity: (id) => (id === drone.id ? drone : null),
        getEntities: () => ({}),
        getEntityItems: (id) => {
            if (id !== drone.id) return {};
            const map = {};
            for (const item of held) {
                if (!map[item.hostComponentId]) map[item.hostComponentId] = [];
                map[item.hostComponentId].push({ ...item });
            }
            return map;
        },
        getDroppedItems: () =>
            Object.fromEntries(dropped.map(i => [i.id, { ...i }])),
        getCraftingRecipes: () => [RECIPE],
        craftItems: (entityId, recipeId, hostComponentId, itemIds) => {
            calls.craftItems.push({ entityId, recipeId, hostComponentId, itemIds });
            if (typeof opts.craftItems === 'function') {
                return opts.craftItems(entityId, recipeId, hostComponentId, itemIds, { held, dropped });
            }
            // Default: consume one held knife, produce one t1 on the same host.
            const knife = held.find(i => i.id === itemIds[0] && i.type === 'knife');
            if (!knife || recipeId !== 'single_knife_to_t1') {
                return { success: false, code: 'INVALID_INPUT' };
            }
            const idx = held.indexOf(knife);
            held.splice(idx, 1);
            held.push({ id: `t1-produced-${held.length}`, type: 't1', hostComponentId });
            return { success: true, data: { crafted: [{ id: held[held.length - 1].id, type: 't1' }] } };
        },
        executePickUpItem: (entityId, itemId, targetComponentId) => {
            calls.executePickUpItem.push({ entityId, itemId, targetComponentId });
            if (typeof opts.executePickUpItem === 'function') {
                return opts.executePickUpItem(entityId, itemId, targetComponentId, { held, dropped });
            }
            const drop = dropped.find(i => i.id === itemId);
            if (!drop || targetComponentId !== CORE_ID) {
                return { success: false, code: 'PICKUP_FAILED' };
            }
            const idx = dropped.indexOf(drop);
            dropped.splice(idx, 1);
            held.push({ id: `knife-held-${dropped.length}`, type: 'knife', hostComponentId: targetComponentId });
            return { success: true, data: {} };
        },
        executeAction: (actionName, entityId, params) => {
            calls.executeAction.push({ actionName, entityId, params });
            return { success: true };
        },
        canEntityExecuteAction: (entityId, actionName) =>
            (typeof opts.capabilityGate === 'function'
                ? opts.capabilityGate(entityId, actionName)
                : true)
    };

    const turnSystem = opts.noTurnSystem ? null : {
        queueAction: (entityId, actionName, params, source) => {
            calls.queueAction.push({ entityId, actionName, params, source });
            return { success: true };
        },
        getRoundState: () => ({
            phase: opts.phase ?? 'planning',
            round: 1,
            roundStartTick: 0,
            planningDeadlineTick: 300,
            roundStartCount: 0,
            actionQueue: [],
            turnCount: 0
        })
    };

    const brain = new NpcAIController({
        worldStateController: facade,
        turnSystemController: turnSystem
    });

    return { facade, turnSystem, brain, calls, drone, held, dropped };
}

// =========================================================================
// Tests
// =========================================================================

describe('NpcAIController.craft_loop — Stage B (no knife held)', () => {

    it('1. idle — nothing held, no knife dropped in the room; no facade actions', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: []
        });

        const result = brain.think(DRONE_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.queueAction).toHaveLength(0);
        expect(calls.executeAction).toHaveLength(0);
        expect(calls.craftItems).toHaveLength(0);
        expect(calls.executePickUpItem).toHaveLength(0);
    });

    it('2. move — nearest in-room knife beyond PICK_RANGE → move queued with source "npc"', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: [
                { id: 'kn-far', itemType: 'knife', roomId: ROOM_A, x: 150, y: 0 } // dist 150 > 100
            ]
        });

        const result = brain.think(DRONE_ID, 1);

        expect(result.acted).toBe(true);
        expect(calls.queueAction).toHaveLength(1);
        const q = calls.queueAction[0];
        expect(q.entityId).toBe(DRONE_ID);
        expect(q.actionName).toBe('move');
        expect(q.params).toEqual({ targetX: 150, targetY: 0 });
        expect(q.source).toBe('npc');
        expect(calls.executePickUpItem).toHaveLength(0);
        expect(calls.craftItems).toHaveLength(0);
    });

    it('3. cross-room knife is ignored (own room only) → idle', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: [
                { id: 'kn-other', itemType: 'knife', roomId: ROOM_B, x: 5, y: 0 }
            ]
        });

        const result = brain.think(DRONE_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.queueAction).toHaveLength(0);
        expect(calls.executePickUpItem).toHaveLength(0);
    });

    it('4a. pick-up within range (dist 30) → executePickUpItem on the CORE component; idle, nothing queued', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: [
                { id: 'kn-near', itemType: 'knife', roomId: ROOM_A, x: 30, y: 0 }
            ]
        });

        const result = brain.think(DRONE_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.executePickUpItem).toHaveLength(1);
        expect(calls.executePickUpItem[0]).toEqual({
            entityId: DRONE_ID,
            itemId: 'kn-near',
            targetComponentId: CORE_ID
        });
        expect(calls.queueAction).toHaveLength(0);
        expect(calls.craftItems).toHaveLength(0);
    });

    it('4b. pick-up exactly AT the PICK_RANGE boundary (dist 100) → still picks up (≤)', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: [
                { id: 'kn-edge', itemType: 'knife', roomId: ROOM_A, x: 100, y: 0 }
            ]
        });

        const result = brain.think(DRONE_ID, 1);

        expect(calls.executePickUpItem).toHaveLength(1);
        expect(calls.executePickUpItem[0].itemId).toBe('kn-edge');
        expect(calls.executePickUpItem[0].targetComponentId).toBe(CORE_ID);
        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.queueAction).toHaveLength(0);
    });

    it('4c. two in-room knives → picks the NEAREST (id tie-break for equal distances)', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: [
                { id: 'kn-b', itemType: 'knife', roomId: ROOM_A, x: -40, y: 30 }, // dist 50
                { id: 'kn-a', itemType: 'knife', roomId: ROOM_A, x: 40, y: 30 }   // dist 50
            ]
        });

        brain.think(DRONE_ID, 1);

        expect(calls.executePickUpItem).toHaveLength(1);
        expect(calls.executePickUpItem[0].itemId).toBe('kn-a');
    });

    it('4d. non-knife dropped item in range is ignored by the forage scan', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: [
                { id: 'scrap', itemType: 'scrapMetal', roomId: ROOM_A, x: 5, y: 0 }
            ]
        });

        const result = brain.think(DRONE_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.executePickUpItem).toHaveLength(0);
    });

    it('4e. pickup rejected by the handler → clean idle (no throw, no queue, no retry this round)', () => {
        const warnSpy = vi.spyOn(Logger, 'warn');
        const { brain, calls } = buildCraftLoopWorld({
            held: [],
            dropped: [
                { id: 'kn-rej', itemType: 'knife', roomId: ROOM_A, x: 30, y: 0 }
            ],
            // Mirrors the real handler's rejection shape ({ success, message }).
            executePickUpItem: () => ({ success: false, message: 'Item is out of range.' })
        });

        try {
            const result = brain.think(DRONE_ID, 1);

            expect(result).toEqual({ acted: false, reason: 'idle' });
            expect(calls.executePickUpItem).toHaveLength(1);
            expect(calls.queueAction).toHaveLength(0);
            expect(calls.executeAction).toHaveLength(0);
            expect(calls.craftItems).toHaveLength(0);
            // M2: the rejection is visible in the log (with the item id),
            // never a false success.
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('kn-rej'));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('NpcAIController.craft_loop — Stage A (knife held)', () => {

    it('5. craft success + drop-new-T1 — set-difference with a PRE-EXISTING T1 present', () => {
        // The drone already holds an old t1 ('t1-old') — the decision must
        // drop the NEW t1 produced by this craft, not the old one.
        const { brain, calls, held } = buildCraftLoopWorld({
            held: [
                { id: 't1-old', type: 't1', hostComponentId: CORE_ID },
                { id: 'kn-1', type: 'knife', hostComponentId: CORE_ID }
            ],
            dropped: []
        });

        const result = brain.think(DRONE_ID, 1);

        // The craft call used the held knife's host component.
        expect(calls.craftItems).toHaveLength(1);
        expect(calls.craftItems[0]).toEqual({
            entityId: DRONE_ID,
            recipeId: 'single_knife_to_t1',
            hostComponentId: CORE_ID,
            itemIds: ['kn-1']
        });

        // The decision (dispatched via queueAction) drops the NEW t1 at the
        // drone's own position.
        expect(result.acted).toBe(true);
        expect(calls.queueAction).toHaveLength(1);
        const q = calls.queueAction[0];
        expect(q.actionName).toBe('dropItem');
        expect(q.source).toBe('npc');
        expect(q.params.itemType).toBe('t1');
        expect(q.params.targetX).toBe(0);
        expect(q.params.targetY).toBe(0);

        // The pre-existing t1 is still held (only the knife was consumed);
        // the dropped id is the NEW t1 (set-difference), never the old one.
        const flat = Object.values(held);
        expect(flat.some(i => i.id === 't1-old')).toBe(true);
        expect(flat.some(i => i.id === 'kn-1')).toBe(false);
        const t1IdsAfter = flat.filter(i => i.type === 't1').map(i => i.id);
        expect(t1IdsAfter).toContain(q.params.itemId);
        expect(q.params.itemId).not.toBe('t1-old');
    });

    it('6. craft failure → idle (no drop, no queue; retry next round)', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [
                { id: 'kn-nested', type: 'knife', hostComponentId: CORE_ID }
            ],
            dropped: [],
            craftItems: () => ({ success: false, code: 'ITEM_HAS_NESTED_ITEMS', message: 'host has nested items' })
        });

        const result = brain.think(DRONE_ID, 1);

        expect(calls.craftItems).toHaveLength(1);
        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.queueAction).toHaveLength(0);
        expect(calls.executeAction).toHaveLength(0);
        // Stage-A terminality: a craft-failure round never falls through to
        // the forage scan (no pickup attempted, even if a knife were dropped).
        expect(calls.executePickUpItem).toHaveLength(0);
    });

    it('7. capability-gate rejection (dropItem not executable) → reason "capability", no dispatch', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [
                { id: 'kn-2', type: 'knife', hostComponentId: CORE_ID }
            ],
            dropped: [],
            capabilityGate: (entityId, actionName) => actionName !== 'dropItem'
        });

        const result = brain.think(DRONE_ID, 1);

        expect(calls.craftItems).toHaveLength(1); // the craft still happened (zero cost)
        expect(result).toEqual({ acted: false, reason: 'capability' });
        expect(calls.queueAction).toHaveLength(0);
        expect(calls.executeAction).toHaveLength(0);
    });

    it('8. window closed (resolution phase) → drop decision discarded; no queue, no immediate exec', () => {
        const { brain, calls } = buildCraftLoopWorld({
            held: [
                { id: 'kn-3', type: 'knife', hostComponentId: CORE_ID }
            ],
            dropped: [],
            phase: 'resolution'
        });

        const result = brain.think(DRONE_ID, 1);

        expect(calls.craftItems).toHaveLength(1);
        expect(result.acted).toBe(false);
        expect(result.reason).toBe('window_closed');
        expect(calls.queueAction).toHaveLength(0);
        expect(calls.executeAction).toHaveLength(0);
    });

    it('9. no turn system → immediate executeAction fallback with the drop params', () => {
        const { brain, calls, held } = buildCraftLoopWorld({
            noTurnSystem: true,
            held: [
                { id: 'kn-4', type: 'knife', hostComponentId: CORE_ID }
            ],
            dropped: []
        });

        const result = brain.think(DRONE_ID, 1);

        expect(calls.craftItems).toHaveLength(1);
        expect(result.acted).toBe(true);
        expect(calls.executeAction).toHaveLength(1);
        const exec = calls.executeAction[0];
        expect(exec.actionName).toBe('dropItem');
        expect(exec.entityId).toBe(DRONE_ID);
        expect(exec.params.itemType).toBe('t1');
        // The executed drop targets the NEW t1 (the only one now held).
        const flat = Object.values(held);
        const t1Ids = flat.filter(i => i.type === 't1').map(i => i.id);
        expect(t1Ids).toContain(exec.params.itemId);
    });
});

describe('NpcAIController.craft_loop — guards', () => {

    it('non-finite spatial on the drone → idle (structured, no throw)', () => {
        const { brain, calls } = buildCraftLoopWorld({
            drone: makeDrone({ spatial: { x: NaN, y: 0 } }),
            dropped: [
                { id: 'kn-near', itemType: 'knife', roomId: ROOM_A, x: 5, y: 0 }
            ]
        });

        const result = brain.think(DRONE_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.executePickUpItem).toHaveLength(0);
        expect(calls.queueAction).toHaveLength(0);
    });

    it('missing room (location undefined) → idle (structured, no throw)', () => {
        const { brain, calls } = buildCraftLoopWorld({
            drone: makeDrone({ location: undefined })
        });

        const result = brain.think(DRONE_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.queueAction).toHaveLength(0);
    });
});

describe('NpcAIController.craft_loop — multi-round convergence simulation', () => {

    /**
     * A minimal in-test world: a drone at (0,0) and a knife dropped at
     * (150, 0) in its room. Queued turn actions are applied by the harness
     * (move = advance 10 units toward the target; dropItem = the held item
     * becomes a dropped record at the target with the drone as owner) —
     * mirroring what the real consequence handlers do.
     */
    function runConvergence() {
        const drone = makeDrone();
        const held = [];
        const dropped = [
            { id: 'kn-start', itemType: 'knife', roomId: ROOM_A, x: 150, y: 0 }
        ];
        const applied = [];
        let seq = 0;

        const facade = {
            getEntity: (id) => (id === drone.id ? drone : null),
            getEntities: () => ({}),
            getEntityItems: (id) => {
                if (id !== drone.id) return {};
                const map = {};
                for (const item of held) {
                    if (!map[item.hostComponentId]) map[item.hostComponentId] = [];
                    map[item.hostComponentId].push({ ...item });
                }
                return map;
            },
            getDroppedItems: () =>
                Object.fromEntries(dropped.map(i => [i.id, { ...i }])),
            getCraftingRecipes: () => [RECIPE],
            craftItems: (entityId, recipeId, hostComponentId, itemIds) => {
                const knife = held.find(i => i.id === itemIds[0] && i.type === 'knife');
                if (!knife || recipeId !== 'single_knife_to_t1') {
                    return { success: false, code: 'INVALID_INPUT' };
                }
                held.splice(held.indexOf(knife), 1);
                held.push({ id: `t1-${++seq}`, type: 't1', hostComponentId });
                return { success: true, data: {} };
            },
            executePickUpItem: (entityId, itemId, targetComponentId) => {
                const drop = dropped.find(i => i.id === itemId);
                if (!drop || targetComponentId !== CORE_ID) {
                    return { success: false, code: 'PICKUP_FAILED' };
                }
                dropped.splice(dropped.indexOf(drop), 1);
                held.push({ id: `knife-${++seq}`, type: 'knife', hostComponentId: targetComponentId });
                return { success: true, data: {} };
            },
            executeAction: (actionName, entityId, params) => {
                apply(actionName, params);
                return { success: true };
            },
            canEntityExecuteAction: () => true
        };

        const queueAction = (entityId, actionName, params, source) => {
            apply(actionName, params);
            return { success: true };
        };

        /** Applies a resolved turn action to the in-test world. */
        function apply(actionName, params) {
            applied.push({ actionName, params });
            if (actionName === 'move') {
                const dx = params.targetX - drone.spatial.x;
                const dy = params.targetY - drone.spatial.y;
                const d = Math.hypot(dx, dy);
                if (d <= stepSize) {
                    drone.spatial.x = params.targetX;
                    drone.spatial.y = params.targetY;
                } else {
                    drone.spatial.x += (dx / d) * stepSize;
                    drone.spatial.y += (dy / d) * stepSize;
                }
            } else if (actionName === 'dropItem') {
                const item = held.find(i => i.id === params.itemId);
                if (!item) return;
                held.splice(held.indexOf(item), 1);
                dropped.push({
                    id: `dropped-${item.id}`,
                    itemType: item.type,
                    roomId: drone.location,
                    x: params.targetX,
                    y: params.targetY,
                    ownerId: drone.id
                });
            }
        }

        const turnSystem = {
            queueAction,
            getRoundState: () => ({ phase: 'planning', round: 1 })
        };

        const brain = new NpcAIController({
            worldStateController: facade,
            turnSystemController: turnSystem
        });

        // Drive up to 10 rounds; the loop converges (drops the t1) once the
        // forged item is on the ground.
        const history = [];
        for (let round = 1; round <= 10; round++) {
            const appliedBefore = applied.length;
            const result = brain.think(DRONE_ID, round);
            history.push({
                round,
                result,
                // Turn actions actually applied during this round's dispatch
                // (move / dropItem). Pick-up and craft are zero-cost and do
                // NOT appear here — they happen inside the strategy.
                actions: applied.slice(appliedBefore).map(a => a.actionName),
                spatial: { ...drone.spatial },
                held: held.map(i => i.id)
            });
            if (dropped.some(i => i.itemType === 't1')) break;
        }

        return { drone, held, dropped, history, applied };
    }

    it('10. convergence: move… → pick (≤ range) → craft + drop the T1 at the drone\'s position', () => {
        const { drone, held, dropped, history, applied } = runConvergence();

        // Convergence within the budget: at least 3 rounds (moves + pick +
        // craft/drop) and at most the 10-round budget.
        expect(history.length).toBeGreaterThanOrEqual(3);
        expect(history.length).toBeLessThanOrEqual(10);

        // Approach phase: the knife is 150 away and the drone moves `stepSize`
        // units/round until it reaches the PICK_RANGE boundary →
        // ceil((150 - PICK_RANGE) / stepSize) move rounds, then the pick-up
        // happens (zero-cost: no turn action applied that round).
        const moveRounds = history.filter(h => h.actions.includes('move'));
        const approachDistance = 150 - PICK_RANGE;
        expect(moveRounds.length).toBe(Math.ceil(approachDistance / stepSize));
        const pickRound = history.findIndex(h => h.held.some(id => id.startsWith('knife-')));
        expect(pickRound).toBe(5);
        expect(history[pickRound].actions).toHaveLength(0);

        // After the knife is held, no more moves: the craft is zero-cost and
        // the next round applies exactly one dropItem (the forged t1).
        for (const h of history.slice(pickRound + 1)) {
            expect(h.actions).not.toContain('move');
        }
        const dropRound = history.findIndex(h => h.actions.includes('dropItem'));
        expect(dropRound).toBe(pickRound + 1);

        // End state: the knife is gone from the world, and exactly ONE t1 is
        // dropped on the ground at the drone's final position, owned by it.
        expect(held).toHaveLength(0);
        const t1Drops = dropped.filter(i => i.itemType === 't1');
        expect(t1Drops).toHaveLength(1);
        const t1 = t1Drops[0];
        expect(t1.x).toBeCloseTo(drone.spatial.x, 5);
        expect(t1.y).toBeCloseTo(drone.spatial.y, 5);
        expect(t1.roomId).toBe(ROOM_A);
        expect(t1.ownerId).toBe(drone.id);

        // No knife remains anywhere in the in-test world.
        expect(dropped.some(i => i.itemType === 'knife')).toBe(false);

        // Every applied action was a turn action of the expected shape.
        for (const a of applied) {
            expect(['move', 'dropItem']).toContain(a.actionName);
        }
    });
});

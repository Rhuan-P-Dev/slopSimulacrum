/**
 * NpcAIController — ghost-targeting defense-in-depth (subtask 2b).
 *
 * The root fix (WorldStateController despawns fully-eliminated entities) is
 * pinned by test/unit/WorldStateController.entityElimination.test.js. These
 * tests pin the INDEPENDENT hardening in the deterministic brain: even if a
 * component-less "ghost" briefly lingers in the world state (mid-cascade or
 * not yet despawned), chase_attack must NEVER target or chase it — the droid
 * either attacks/moves toward a viable entity or idles.
 *
 * Everything external is mocked (no composition root, no data files): the
 * facade / turn system are hand-built objects exposing only the surface the
 * AI brain reads (same pattern as test/unit/NpcAIController.test.js).
 *
 * What these tests verify:
 *   G1. Ghost in room (dist ≈ 0, where the droid "chased" it) + a living
 *       entity in range → droid punches the LIVING entity's component, never
 *       the ghost (old code idled stuck on the corpse: zero usable components).
 *   G2. Ghost in room (dist ≈ 0) + a living entity OUT of range → droid moves
 *       toward the LIVING entity (old code moved toward the ghost forever).
 *   G3. Ghost present (out of range), no other entity → droid idles: no
 *       attack and no move at the ghost (old code emitted a move toward it).
 *   G4. Ghost id still in the snapshot but getEntity() returns null (the
 *       entity despawned after the snapshot was taken) → treated as
 *       non-viable; with a living entity present the droid targets the one.
 *   G5. Entity whose components all have existence 0 (broken, not yet
 *       removed) → non-viable; the droid targets the living entity instead.
 *   G6. Regression: no ghost at all → nearest living entity targeted exactly
 *       as before (the filter is transparent to healthy worlds).
 *
 * @module test/unit/NpcAIController.ghostTargeting
 */

import { describe, it, expect } from 'vitest';
import NpcAIController from '../../src/controllers/ai/NpcAIController.js';

// =========================================================================
// Fixtures & mocks
// =========================================================================

const NPC_ID = 'ent-npc-ghost-0001';
const GHOST_ID = 'ent-ghost-0001';
const LIVING_ID = 'ent-live-0001';

/**
 * The chasing droid — deterministic chase_attack brain (exactly like
 * data/npcs.json → WorldStateController._spawnNpcs), standing at the origin.
 */
const NPC_ENTITY = {
    id: NPC_ID,
    name: 'TestDroid',
    blueprint: 'smallBallDroid',
    isNPC: true,
    location: 'room-main',
    spatial: { x: 0, y: 0 },
    components: [
        { id: 'comp-core-1', type: 'centralBall', stats: { 'Physical.existence': 1 } },
        { id: 'comp-hand-1', type: 'droidHand', stats: { 'Physical.strength': 25 } },
        { id: 'comp-wheel-1', type: 'droidRollingBall', stats: { 'Movement.move': 20 } }
    ],
    npcConfig: {
        personality: 'Hunts everything',
        ai: { behavior: 'chase_attack' }
    },
    status: 'active',
    internalComponents: {}
};

/**
 * A component-less "ghost": the droid chased it to its own position
 * (distance ≈ 0 — the exact shape of the stale-lock bug).
 * @param {string} [id]
 * @param {number} [x]
 * @param {number} [y]
 */
function makeGhost(id = GHOST_ID, x = 1, y = 0) {
    return {
        id,
        name: 'Ghost Droid',
        blueprint: 'smallBallDroid',
        isNPC: false,
        location: 'room-main',
        spatial: { x, y },
        components: [],
        status: 'active',
        internalComponents: {},
        items: []
    };
}

/**
 * A living entity with a single healthy core (existence 1 on the 0–1 matter
 * scale — the authoritative store value for an intact component).
 */
function makeLiving(id, name, x, y) {
    return {
        id,
        name,
        blueprint: 'smallBallDroid',
        isNPC: false,
        location: 'room-main',
        spatial: { x, y },
        components: [
            { id: `${id}-core`, type: 'centralBall', stats: { 'Physical.existence': 1 } }
        ],
        status: 'active',
        internalComponents: {},
        items: []
    };
}

/**
 * An entity whose single component is broken (existence 0) but not yet
 * removed from the entity copy — the mid-cascade shape the trigger system
 * can briefly expose.
 */
function makeWreck(id, name, x, y) {
    return {
        id,
        name,
        blueprint: 'smallBallDroid',
        isNPC: false,
        location: 'room-main',
        spatial: { x, y },
        components: [
            { id: `${id}-core`, type: 'centralBall', stats: { 'Physical.existence': 0 } }
        ],
        status: 'active',
        internalComponents: {},
        items: []
    };
}

const ACTION_REGISTRY = {
    'droid punch': { description: 'punch with droid hand', range: 100, requirements: [{ trait: 'Physical.strength', min: 15 }] },
    'move': { description: 'walk', range: null, requirements: [{ trait: 'Movement.move', min: 5 }] }
};

/** Capability gate default: both actions executable (mirrors NpcAIController.test.js). */
const CAN_EXECUTE = { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } };

/**
 * Fake facade. `snapshot` is what getEntities() returns (the per-tick
 * world snapshot) and `live` is what getEntity() resolves against (defaults
 * to `snapshot` — omit an id from `live` to simulate a despawn that landed
 * AFTER the snapshot was taken).
 *
 * getComponentStats() is wired to the snapshot's flat-keyed fixture stats
 * (same wiring as test/unit/NpcAIController.test.js) so _readExistence()
 * reads the authoritative nested store exactly as in production.
 */
function makeFacade({ snapshot, live, canExecute = CAN_EXECUTE }) {
    const executeCalls = [];

    const compStatsMap = {};
    for (const ent of Object.values(snapshot)) {
        for (const comp of Array.isArray(ent.components) ? ent.components : []) {
            if (!comp || !comp.id || !comp.stats) continue;
            const nested = {};
            for (const [flatKey, val] of Object.entries(comp.stats)) {
                if (typeof flatKey === 'string' && flatKey.includes('.')) {
                    const [trait, stat] = flatKey.split('.');
                    if (!nested[trait]) nested[trait] = {};
                    nested[trait][stat] = val;
                }
            }
            compStatsMap[comp.id] = nested;
        }
    }

    const liveMap = live ?? snapshot;
    return {
        executeCalls,
        getEntity: (id) => liveMap[id] || null,
        getEntities: () => snapshot,
        getActionRegistry: () => ACTION_REGISTRY,
        canEntityExecuteAction: (id, actionName) => {
            const available = canExecute[id] || canExecute['default'] || {};
            const entries = available[actionName];
            return Array.isArray(entries) && entries.length > 0;
        },
        executeAction: (actionName, entityId, params) => {
            executeCalls.push({ actionName, entityId, params });
            return { success: true };
        },
        getComponentStats: (compId) => compStatsMap[compId] || null
    };
}

/** Recording stand-in for the turn system (planning phase open). */
function makeTurns() {
    const queued = [];
    return {
        queued,
        getRoundState: () => ({ phase: 'planning', roundNumber: 1 }),
        queueAction: (entityId, actionName, params, source) => {
            queued.push({ entityId, actionName, params, source });
            return { success: true, queueId: `q-${queued.length}` };
        }
    };
}

function makeBrain(facade) {
    const turns = makeTurns();
    const controller = new NpcAIController({ worldStateController: facade, turnSystemController: turns });
    return { controller, turns };
}

// =========================================================================
// Tests
// =========================================================================

describe('NpcAIController ghost-targeting (defense-in-depth, subtask 2b)', () => {
    it('G1. ghost in room (dist ≈ 0) + living entity in range → punches the LIVING entity, never the ghost', () => {
        const ghost = makeGhost();
        const living = makeLiving(LIVING_ID, 'Living Droid', 30, 0); // dist 30 ≤ 100
        const snapshot = { [NPC_ID]: NPC_ENTITY, [ghost.id]: ghost, [living.id]: living };
        const { controller, turns } = makeBrain(makeFacade({ snapshot }));

        const result = controller.think(NPC_ID, 1);

        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');
        expect(turns.queued[0].params.targetComponentId).toBe(`${LIVING_ID}-core`);
    });

    it('G2. ghost in room (dist ≈ 0) + living entity OUT of range → moves toward the LIVING entity (never the ghost)', () => {
        const ghost = makeGhost();
        const living = makeLiving('ent-live-0002', 'Far Living', 150, 0); // dist 150 > 100
        const snapshot = { [NPC_ID]: NPC_ENTITY, [ghost.id]: ghost, [living.id]: living };
        const { controller, turns } = makeBrain(makeFacade({ snapshot }));

        const result = controller.think(NPC_ID, 1);

        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('move');
        expect(turns.queued[0].params).toEqual({ targetX: 150, targetY: 0 });
    });

    it('G3. ghost present (out of range), no other entity → idles: no attack, no move at the ghost', () => {
        const ghost = makeGhost('ent-ghost-far', 200, 0); // dist 200 > 100
        const snapshot = { [NPC_ID]: NPC_ENTITY, [ghost.id]: ghost };
        const { controller, turns } = makeBrain(makeFacade({ snapshot }));

        const result = controller.think(NPC_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(turns.queued).toHaveLength(0);
    });

    it('G4. ghost id in snapshot but getEntity() → null (despawned after snapshot) → not targeted', () => {
        const ghost = makeGhost();
        const living = makeLiving('ent-live-0004', 'Living Droid', 30, 0);
        const snapshot = { [NPC_ID]: NPC_ENTITY, [ghost.id]: ghost, [living.id]: living };
        // The ghost is GONE from the live state — the snapshot is stale.
        const live = { [NPC_ID]: NPC_ENTITY, [living.id]: living };
        const { controller, turns } = makeBrain(makeFacade({ snapshot, live }));

        const result = controller.think(NPC_ID, 1);

        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');
        expect(turns.queued[0].params.targetComponentId).toBe('ent-live-0004-core');
    });

    it('G5. all components broken (existence 0, not yet removed) → non-viable; living entity targeted instead', () => {
        const wreck = makeWreck('ent-wreck-0005', 'Wreck', 1, 0);
        const living = makeLiving('ent-live-0005', 'Living Droid', 30, 0);
        const snapshot = { [NPC_ID]: NPC_ENTITY, [wreck.id]: wreck, [living.id]: living };
        const { controller, turns } = makeBrain(makeFacade({ snapshot }));

        const result = controller.think(NPC_ID, 1);

        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');
        expect(turns.queued[0].params.targetComponentId).toBe('ent-live-0005-core');
    });

    it('G6. regression: no ghost → nearest living entity targeted exactly as before', () => {
        const near = makeLiving('ent-live-near', 'Near Living', 30, 0);
        const far = makeLiving('ent-live-far', 'Far Living', 150, 0);
        const snapshot = { [NPC_ID]: NPC_ENTITY, [near.id]: near, [far.id]: far };
        const { controller, turns } = makeBrain(makeFacade({ snapshot }));

        const result = controller.think(NPC_ID, 1);

        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');
        expect(turns.queued[0].params.targetComponentId).toBe('ent-live-near-core'); // nearest wins
    });

    // =========================================================================
    // L2 — live-read semantics (subtask 4c). The candidate filter must
    // evaluate the LIVE entity (facade.getEntity) when available, never the
    // stale snapshot, so a mid-cascade wreck is not targeted and a
    // snapshot-ghost that is actually alive is not hidden.
    // =========================================================================

    it('G7. live entity is a mid-cascade wreck (all existence 0, not yet removed) while snapshot looks alive → non-viable, never targeted (live read wins)', () => {
        // The stale snapshot still shows g7 alive (existence 1); the LIVE
        // entity is a wreck (existence 0) — the shape the root fix despawns,
        // but the brain must not target it during the window where it lingers.
        const wreckSnapshot = {
            id: 'ent-g7', name: 'Wreck Droid', blueprint: 'smallBallDroid', isNPC: false,
            location: 'room-main', spatial: { x: 10, y: 0 },
            components: [{ id: 'g7-snap-core', type: 'centralBall', stats: { 'Physical.existence': 1 } }],
            status: 'active', internalComponents: {}, items: []
        };
        const wreckLive = {
            id: 'ent-g7', name: 'Wreck Droid', blueprint: 'smallBallDroid', isNPC: false,
            location: 'room-main', spatial: { x: 10, y: 0 },
            components: [{ id: 'g7-live-core', type: 'centralBall', stats: { 'Physical.existence': 0 } }],
            status: 'active', internalComponents: {}, items: []
        };
        const living = makeLiving('ent-live-0007', 'Living Droid', 30, 0);
        const snapshot = { [NPC_ID]: NPC_ENTITY, [wreckSnapshot.id]: wreckSnapshot, [living.id]: living };
        const live = { [NPC_ID]: NPC_ENTITY, [wreckLive.id]: wreckLive, [living.id]: living };
        const { controller, turns } = makeBrain(makeFacade({ snapshot, live }));

        const result = controller.think(NPC_ID, 1);

        // The live read (existence 0) wins: the wreck is never targeted, even
        // though the stale snapshot looks alive and is closer than the living
        // entity (pre-fix would punch the wreck at dist 10 instead of dist 30).
        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');
        expect(turns.queued[0].params.targetComponentId).toBe('ent-live-0007-core');
    });

    it('G8. snapshot is a ghost (no components) but live entity is ALIVE with usable components → viable, targeted (live read wins)', () => {
        // The stale snapshot shows g8 as a component-less ghost; the LIVE
        // entity is fully alive. The brain must target the live entity — the
        // live read wins over the stale snapshot (a snapshot-ghost that is
        // actually alive must not be hidden by the filter).
        const ghostSnapshot = {
            id: 'ent-g8', name: 'Revived Droid', blueprint: 'smallBallDroid', isNPC: false,
            location: 'room-main', spatial: { x: 10, y: 0 },
            components: [], status: 'active', internalComponents: {}, items: []
        };
        const aliveLive = {
            id: 'ent-g8', name: 'Revived Droid', blueprint: 'smallBallDroid', isNPC: false,
            location: 'room-main', spatial: { x: 10, y: 0 },
            components: [{ id: 'g8-live-core', type: 'centralBall', stats: { 'Physical.existence': 1 } }],
            status: 'active', internalComponents: {}, items: []
        };
        const snapshot = { [NPC_ID]: NPC_ENTITY, [ghostSnapshot.id]: ghostSnapshot };
        const live = { [NPC_ID]: NPC_ENTITY, [aliveLive.id]: aliveLive };
        const { controller, turns } = makeBrain(makeFacade({ snapshot, live }));

        const result = controller.think(NPC_ID, 1);

        // The live read (existence 1, alive) wins: the "ghost" is actually
        // alive and is targeted (pre-fix would idle on the ghost snapshot).
        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');
        expect(turns.queued[0].params.targetComponentId).toBe('g8-live-core');
    });
});

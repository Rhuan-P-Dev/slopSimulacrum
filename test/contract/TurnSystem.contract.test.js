/**
 * CONTRACT TEST — TurnSystemController (Feature A + spec v2, event-driven rounds).
 *
 * Driven WITHOUT real timers: build the world via buildWorldState(tickSystem)
 * (tick not started), set tickSystem.currentTick = N, call turnSystem.onTick().
 *
 * Spec v2 driving pattern: round 0 starts lazily on the FIRST onTick(); the
 * suites do not wire an agent, so the data-driven NPC auto-signals as a
 * vacuous plan at round start (synchronous); a round closes when every
 * roster planner has signaled (signalPlanComplete — there is no deadline);
 * the next round starts on the next onTick(). The stepTo() helper is kept
 * as-is — it merely stops steering round geometry.
 *
 * Covers the §5.12 checklist under v2 semantics:
 *   - first tick: phase 'planning', roundNumber 0, v2 state.turns key set
 *     (planningDeadlineTick absent), NPC already auto-signaled.
 *   - queueAction during planning → q- id; 4th entry → QUEUE_FULL.
 *   - close via the droid's signal: resolution in the SAME call (real
 *     pipeline durability delta), turn event logged, queue cleared,
 *     closeReason 'all-ready'.
 *   - out-of-range 'droid punch' (target in another room) → discarded with a
 *     failure log, no exception, other entries still execute.
 *   - queueAction in the resolution phase → PLANNING_CLOSED; the next onTick
 *     starts round 1 and the same queueAction succeeds again.
 *   - state.turns shape (v2 key set) + turn-round-update transitions.
 *   - serialize/restore round-trip of the pending queue (schema v3).
 *
 * @module test/contract/TurnSystem
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/**
 * Builds a fresh world wired to a (non-started) tick system. Returns the
 * facade, the tick system, the turn system controller, and spawns a test droid.
 *
 * The roster is kept DETERMINISTIC against data/npcs.json: all data-driven
 * NPCs are despawned before the first tick EXCEPT one, so the round-start
 * roster is always [one data-driven NPC, test droid] = 2 planners — the
 * invariant the barrier assertions below rely on (readyCount, the signaled
 * set in the serialize/restore round-trip). Without this pin, npcs.json
 * growth (the crafterDrone merge 7b54605) silently added planners and broke
 * those assertions.
 * @returns {{ world: import('../../src/controllers/WorldStateController.js'), tick: UniversalTickSystem, turns: import('../../src/controllers/core/TurnSystemController.js'), entityId: string }}
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    // Spawn a test droid entity (default world has no pre-spawned droids).
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    // Keep a single data-driven NPC (first in registry order); despawn the rest.
    const npcs = Object.values(world.stateEntityController.entities).filter(e => e.isNPC === true);
    for (let i = 1; i < npcs.length; i++) world.despawnEntity(npcs[i].id);
    return { world, tick, turns: subControllers.turnSystemController, entityId };
}

/**
 * Advances the turn machine to an absolute tick and returns the round state.
 * (The spec's "set tick N, onTick()" primitive — in v2 the tick merely
 * observes the event-driven state machine, it does not derive geometry.)
 */
function stepTo(world, tick, turns, targetTick) {
    tick.currentTick = targetTick;
    turns.onTick();
    return turns.getRoundState();
}

/** Finds a droidHead component id on the given entity (selfHeal target). */
function aHeadComponentId(world, entityId) {
    const entity = world.stateEntityController.getEntity(entityId);
    const head = entity.components.find(c => c.type === 'droidHead');
    return head.id;
}

/** The id of the data-driven NPC entity (or null when none). */
function aNpcEntityId(world) {
    const npcs = Object.values(world.stateEntityController.entities).filter(e => e.isNPC === true);
    return npcs.length > 0 ? npcs[0].id : null;
}

describe('TurnSystemController (Feature A)', () => {
    it('first tick: round 0 planning, v2 key set, NPC already auto-signaled (empty agent slot)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the data-driven NPC').toBeTruthy();

        const state = stepTo(world, tick, turns, 0);

        expect(state.phase).toBe('planning');
        expect(state.roundNumber).toBe(0);
        expect(state.currentTick).toBe(0);

        // v2 state.turns key set — planningDeadlineTick is gone (spec v2 §2.3).
        expect(Object.keys(state).sort()).toEqual([
            'actorOrder', 'barrier', 'currentTick', 'phase', 'queues', 'roundNumber'
        ]);

        // The spawned droid has initiative 40 (2× droidRollingBall × move(20)).
        expect(state.actorOrder.length).toBeGreaterThanOrEqual(1);
        const droidActor = state.actorOrder.find(a => a.entityId === entity.id);
        expect(droidActor).toBeTruthy();
        expect(droidActor.initiative).toBe(40);
        expect(droidActor.queuedCount).toBe(0);

        // state.turns is present in the facade's full state (spec §5.7).
        const full = world.getAll();
        expect(full).toHaveProperty('turns');
        expect(full.turns.roundNumber).toBe(0);
        expect(full.turns.phase).toBe('planning');
        expect(full.turns).toHaveProperty('barrier');

        // Two-phase barrier (spec v2 §2.3): the round-start roster snapshot
        // covers every entity present at round start (test droid + data
        // NPC). The NPC is ALREADY signaled — the empty agent slot auto-
        // signals it as a vacuous plan at round start, synchronously
        // (spec v2 §1.4 ii). Only the droid is still pending.
        expect(state.barrier).toEqual(expect.objectContaining({
            closed: false,
            closedAtTick: null,
            closeReason: null,
            readyCount: 1,
            pendingCount: 1,
            pendingEntityIds: [entityId]
        }));
    });

    it('queueAction during planning → q- id; 4th entry → QUEUE_FULL', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 10);

        const head = aHeadComponentId(world, entityId);

        const q1 = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q1.success).toBe(true);
        expect(q1.queueId).toMatch(/^q-/);
        expect(q1.queue).toHaveLength(1);

        const q2 = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q2.success).toBe(true);
        const q3 = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q3.success).toBe(true);

        // Cap is 3 → the 4th is rejected QUEUE_FULL.
        const q4 = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q4.success).toBe(false);
        expect(q4.code).toBe('QUEUE_FULL');

        // The live queue count is reflected in the round state.
        const state = turns.getRoundState();
        const mine = state.actorOrder.find(a => a.entityId === entityId);
        expect(mine.queuedCount).toBe(3);
    });

    it('close via the droid signal: resolution in the SAME call — selfHeal via the REAL pipeline; turn event logged; queue cleared; closeReason all-ready', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 5);
        const head = aHeadComponentId(world, entityId);
        const before = world.getComponentStats(head).Physical.durability;

        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');

        // The NPC already auto-signaled at round start (empty agent slot) —
        // the droid is the only pending planner.
        expect(turns.getRoundState().barrier.pendingEntityIds).toEqual([entityId]);

        // The droid's signal closes planning AND resolves in the same call —
        // no deadline, no further ticking (spec v2 §1.1).
        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.success).toBe(true);
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');

        const state = turns.getRoundState();
        expect(state.phase).toBe('resolution');
        // Resolution is synchronous — roundNumber is unchanged (still 0).
        expect(state.roundNumber).toBe(0);
        // Queue emptied at resolution.
        expect(Object.keys(state.queues)).toHaveLength(0);

        // selfHeal ran through the real pipeline: durability +10.
        const after = world.getComponentStats(head).Physical.durability;
        expect(after).toBe(before + 10);

        // worldEventLog surfaced the "who acted in what order" turn line.
        const events = world.getRecentEvents(10).filter(e => e.action === 'turn');
        const actorLine = events.find(e => e.message.includes('executed selfHeal') && e.message.includes('order'));
        expect(actorLine, 'expected a turn log line naming the actor + order').toBeTruthy();
        expect(actorLine.message).toContain('Round 0');
    });

    it('out-of-range droid punch is discarded with a log; the round still executes the other entry', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 5);

        // Spawn a second entity to act as the out-of-range target — MID-ROUND,
        // on purpose: a late joiner is excluded from the round-start roster
        // snapshot and never gates the barrier (spec v2 §1.4 v). A pre-round
        // spawn would join the roster as a ready-button planner and, with no
        // deadline in v2, hold the round open indefinitely.
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const targetEntityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        const entity = world.stateEntityController.getEntity(entityId);
        const head = aHeadComponentId(world, entityId);

        // Push the target droid far away so the punch (range 100) is out of range.
        world.stateEntityController.updateEntitySpatial(targetEntityId, { x: 5000, y: 5000 });

        // Two entries for the SAME actor: a valid selfHeal + an out-of-range punch.
        const heal = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(heal.success).toBe(true);
        const punch = turns.queueAction(entityId, 'droid punch', { targetEntityId: targetEntityId }, 'player');
        expect(punch.success).toBe(true);

        const before = world.getComponentStats(head).Physical.durability;

        // Signal-driven close: the droid's signal resolves the round in the
        // same call (the NPC auto-signaled at round start).
        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');

        // The valid entry still executed (round did not abort).
        const after = world.getComponentStats(head).Physical.durability;
        expect(after).toBe(before + 10);

        // The punch was discarded with a failure log line (not executed).
        const events = world.getRecentEvents(12).filter(e => e.action === 'turn');
        const discarded = events.find(e => e.message.includes('discarded') && e.message.includes('droid punch'));
        expect(discarded, 'expected a discard log line for the out-of-range punch').toBeTruthy();
        expect(discarded.level).toBe('warn');
    });

    it('queueAction in the resolution phase → PLANNING_CLOSED; the next onTick re-opens planning (round 1)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 0);
        const head = aHeadComponentId(world, entityId);

        // Close round 0: the NPC auto-signaled, so the droid's signal suffices.
        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');
        expect(turns.getRoundState().phase).toBe('resolution');

        // The PLANNING_CLOSED window: from the close tick until the next
        // round starts on the next tick (spec v2 §6).
        const q = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q.success).toBe(false);
        expect(q.code).toBe('PLANNING_CLOSED');

        // One more onTick() starts round 1 — planning re-opens and the same
        // queueAction succeeds again.
        const state = stepTo(world, tick, turns, 1);
        expect(state.phase).toBe('planning');
        expect(state.roundNumber).toBe(1);
        const q2 = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q2.success).toBe(true);
    });

    it('emits turn-round-update on every transition (round starts + close) with the spec v2 payload', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const updates = [];
        const broadcaster = {
            broadcastTurnUpdate: (payload) => updates.push(payload),
            broadcast: () => {}
        };
        turns.setBroadcaster(broadcaster);

        stepTo(world, tick, turns, 0);            // round 0 planning start
        const sig = turns.signalPlanComplete(entityId, 'player'); // close → resolution
        expect(sig.closed).toBe(true);
        stepTo(world, tick, turns, 1);            // round 1 planning start

        expect(updates).toHaveLength(3);
        expect(updates[0]).toMatchObject({ roundNumber: 0, phase: 'planning' });
        expect(updates[1]).toMatchObject({ roundNumber: 0, phase: 'resolution' });
        expect(updates[2]).toMatchObject({ roundNumber: 1, phase: 'planning' });
        for (const u of updates) {
            // Exactly the v2 payload keys (spec v2 §2.3).
            expect(Object.keys(u).sort()).toEqual([
                'actorOrder', 'barrier', 'currentTick', 'phase', 'roundNumber'
            ]);
            expect(u).not.toHaveProperty('queues'); // queues ride the full state
        }
    });

    it('state.turns shape matches the v2 key set (keys + types + per-entry queue shape)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const head = aHeadComponentId(world, entityId);

        stepTo(world, tick, turns, 0);
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');

        const turnsState = world.getAll().turns;
        // Exactly the v2 key set — planningDeadlineTick is gone (spec v2 §2.3).
        expect(Object.keys(turnsState).sort()).toEqual([
            'actorOrder', 'barrier', 'currentTick', 'phase', 'queues', 'roundNumber'
        ]);
        expect(typeof turnsState.phase).toBe('string');
        expect(['planning', 'resolution']).toContain(turnsState.phase);

        const actor = turnsState.actorOrder.find(a => a.entityId === entityId);
        expect(actor).toMatchObject({
            entityId: entityId,
            initiative: 40,
            queuedCount: 1
        });
        expect(typeof actor.name).toBe('string');

        const entry = turnsState.queues[entityId][0];
        expect(entry).toEqual(expect.objectContaining({
            queueId: expect.stringMatching(/^q-/),
            actionName: 'selfHeal',
            params: expect.any(Object),
            queuedAtTick: expect.any(Number),
            source: 'player'
        }));
    });

    it('serialize/restore round-trip: pending queue + barrier preserved, post-restore signal closes and resolves', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        const head = aHeadComponentId(world, entityId);

        stepTo(world, tick, turns, 100);
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');

        // Serialize mid-planning with a pending queue.
        const snapshot = world.serialize();
        expect(snapshot.state).toHaveProperty('turns');
        expect(snapshot.state.turns.roundNumber).toBe(0);
        expect(snapshot.state.turns.phase).toBe('planning');
        expect(Object.keys(snapshot.state.turns.queues)).toContain(entityId);
        // The barrier round-trips: the NPC auto-signaled at round start, the
        // droid has not yet, planning is open.
        expect(snapshot.state.turns.barrier).toEqual(expect.objectContaining({
            closed: false,
            closeReason: null,
            signaled: [npcId]
        }));
        expect(snapshot.state.turns.barrier.roster).toEqual(expect.arrayContaining([entityId, npcId]));

        // Restore onto a FRESH instance.
        const { world: world2, tick: tick2, turns: turns2 } = buildWorld();
        const restored = world2.restore(snapshot);
        expect(restored.success).toBe(true);

        const q2 = turns2.getQueuedActions(entityId);
        expect(q2).toHaveLength(1);
        expect(q2[0].actionName).toBe('selfHeal');
        expect(q2[0].queuedAtTick).toBe(100);
        expect(q2[0].queueId).toMatch(/^q-/);
        expect(world2.serialize().state.turns.roundNumber).toBe(0);

        // The barrier RESUMES: the remaining signal (the droid) closes and
        // resolves the restored queue through the real pipeline.
        expect(turns2.getRoundState().barrier.pendingEntityIds).toEqual([entityId]);
        const before2 = world2.getComponentStats(head).Physical.durability;
        const sig2 = turns2.signalPlanComplete(entityId, 'player');
        expect(sig2.closed).toBe(true);
        expect(sig2.barrier.closeReason).toBe('all-ready');
        expect(world2.getComponentStats(head).Physical.durability).toBe(before2 + 10);
    });

    it('TURNS_DISABLED when the tick system is absent (driven world with null tickSystem)', () => {
        // A world built without a tick system: queueing is disabled, no crash.
        const { worldStateController: world } = buildWorldState(null);
        const turns = world.turnSystemController;
        // Spawn a test droid (no default droids in empty world).
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const head = world.stateEntityController.entities[entityId].components.find(c => c.type === 'droidHead').id;

        const q = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q.success).toBe(false);
        expect(q.code).toBe('TURNS_DISABLED');
    });
});

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
 *     pipeline existence delta), turn event logged, queue cleared,
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
 * The roster is kept DETERMINISTIC against data/entities/npcs.json: any NPCs
 * spawned during world boot (cards in data/cards/, gitignored local image
 * content, spawned as M1 LLM NPCs) are despawned, so the round-start roster
 * is always [one NPC, test droid] = 2 planners — the invariant the barrier
 * assertions below rely on (readyCount, the signaled set in the
 * serialize/restore round-trip). Since the live registry no longer spawns an
 * un-gated NPC (crafterDrone removed; killerLlmDrone is env-gated OFF in
 * tests), the pin spawns an explicit crafterDrone-blueprint entity (isNPC)
 * instead of keeping one from the registry; npcs.json growth (the
 * crafterDrone merge 7b54605) can no longer silently add planners.
 * @returns {{ world: import('../../src/controllers/WorldStateController.js'), tick: UniversalTickSystem, turns: import('../../src/controllers/core/TurnSystemController.js'), entityId: string }}
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);

    // Despawn any NPCs spawned during world boot (cards in data/cards/, a
    // gitignored local image file set, always spawned as M1 LLM NPCs) so the
    // roster stays pinned to [test droid, explicit crafter NPC] = 2 planners
    // no matter what image files land in data/cards/.
    Object.values(world.stateEntityController.entities)
        .filter((e) => e.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));

    // Spawn a test droid entity (default world has no pre-spawned droids).
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    // Explicit roster NPC (documented exception): the turn machine only needs
    // isNPC for the agent slot — the blueprint's matter-only components keep
    // the entity inert, exactly like the old registry-spawned crafterDrone.
    world.stateEntityController.spawnEntity('crafterDrone', startRoomId, {
        isNPC: true,
        name: 'Crafter Drone',
        npcConfig: {
            displayName: 'Crafter Drone',
            personality: 'A tireless field-fabrication drone that forages dropped knives, forges each one into a T1 container weapon, and leaves the finished weapon on the ground.'
        }
    });
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

/** The id of the roster NPC entity (or null when none). */
function aNpcEntityId(world) {
    const npcs = Object.values(world.stateEntityController.entities).filter(e => e.isNPC === true);
    return npcs.length > 0 ? npcs[0].id : null;
}

describe('TurnSystemController (Feature A)', () => {
    it('first tick: round 0 planning, v2 key set, NPC already auto-signaled (empty agent slot)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the roster NPC').toBeTruthy();

        const state = stepTo(world, tick, turns, 0);

        expect(state.phase).toBe('planning');
        expect(state.roundNumber).toBe(0);
        expect(state.currentTick).toBe(0);

        // v2 state.turns key set — planningDeadlineTick is gone (spec v2 §2.3).
        // The additive `recurring` section (recurring-action re-queue plans) is
        // present for every snapshot.
        expect(Object.keys(state).sort()).toEqual([
            'actorOrder', 'barrier', 'currentTick', 'phase', 'queues', 'recurring', 'roundNumber'
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
        const before = world.getComponentStats(head).Physical.existence;

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

        // selfHeal ran through the real pipeline: existence +10.
        const after = world.getComponentStats(head).Physical.existence;
        expect(after).toBe(before + 0.1);

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

        const head = aHeadComponentId(world, entityId);

        // Push the target droid far away so the punch (range 100) is out of range.
        world.stateEntityController.updateEntitySpatial(targetEntityId, { x: 5000, y: 5000 });

        // Two entries for the SAME actor: a valid selfHeal + an out-of-range punch.
        const heal = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(heal.success).toBe(true);
        const punch = turns.queueAction(entityId, 'droid punch', { targetEntityId: targetEntityId }, 'player');
        expect(punch.success).toBe(true);

        const before = world.getComponentStats(head).Physical.existence;

        // Signal-driven close: the droid's signal resolves the round in the
        // same call (the NPC auto-signaled at round start).
        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');

        // The valid entry still executed (round did not abort).
        const after = world.getComponentStats(head).Physical.existence;
        expect(after).toBe(before + 0.1);

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
        // The additive `recurring` section (recurring-action re-queue plans) is
        // present for every snapshot.
        expect(Object.keys(turnsState).sort()).toEqual([
            'actorOrder', 'barrier', 'currentTick', 'phase', 'queues', 'recurring', 'roundNumber'
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
        const queued = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(queued.success).toBe(true);
        // Mark it RECURRING so the additive `recurring` section has content
        // to serialize/restore.
        turns.setRecurring(entityId, queued.queueId, true);

        // Serialize mid-planning with a pending queue.
        const snapshot = world.serialize();
        expect(snapshot.state).toHaveProperty('turns');
        expect(snapshot.state.turns.roundNumber).toBe(0);
        expect(snapshot.state.turns.phase).toBe('planning');
        expect(Object.keys(snapshot.state.turns.queues)).toContain(entityId);
        // The additive recurring plan is present and complete (schema v3, additive).
        expect(snapshot.state.turns.recurring).toEqual({
            [entityId]: {
                selfHeal: {
                    params: { targetComponentId: head },
                    source: 'player'
                }
            }
        });
        // The barrier round-trips: the NPC auto-signaled at round start, the
        // droid has not yet, planning is open.
        expect(snapshot.state.turns.barrier).toEqual(expect.objectContaining({
            closed: false,
            closeReason: null,
            signaled: [npcId]
        }));
        expect(snapshot.state.turns.barrier.roster).toEqual(expect.arrayContaining([entityId, npcId]));

        // Restore onto a FRESH instance.
        const { world: world2, turns: turns2 } = buildWorld();
        const restored = world2.restore(snapshot);
        expect(restored.success).toBe(true);

        // The recurring plan survived the restore (additive section round-trip).
        expect(world2.serialize().state.turns.recurring[entityId].selfHeal).toEqual(expect.anything());

        const q2 = turns2.getQueuedActions(entityId);
        expect(q2).toHaveLength(1);
        expect(q2[0].actionName).toBe('selfHeal');
        expect(q2[0].queuedAtTick).toBe(100);
        expect(q2[0].queueId).toMatch(/^q-/);
        expect(world2.serialize().state.turns.roundNumber).toBe(0);

        // The barrier RESUMES: the remaining signal (the droid) closes and
        // resolves the restored queue through the real pipeline.
        expect(turns2.getRoundState().barrier.pendingEntityIds).toEqual([entityId]);
        const before2 = world2.getComponentStats(head).Physical.existence;
        const sig2 = turns2.signalPlanComplete(entityId, 'player');
        expect(sig2.closed).toBe(true);
        expect(sig2.barrier.closeReason).toBe('all-ready');
        expect(world2.getComponentStats(head).Physical.existence).toBe(before2 + 0.1);
    });

    it('recurring: queue with recurring=true flags the entry + records a plan; the next round auto-requeues the same action/params; toggling off or cancelling stops it', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const head = aHeadComponentId(world, entityId);

        stepTo(world, tick, turns, 10);

        // 1) queueAction(recurring=true) flags the entry and records the plan.
        const q = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player', true);
        expect(q.success).toBe(true);
        expect(q.queue[0].recurring).toBe(true);
        expect(turns.getRoundState().recurring).toEqual({
            [entityId]: {
                selfHeal: {
                    params: { targetComponentId: head },
                    source: 'player'
                }
            }
        });

        // 2) setRecurring toggles the flag and the plan independently of the
        //    entry (the entry stays queued either way).
        const off = turns.setRecurring(entityId, q.queueId, false);
        expect(off.success).toBe(true);
        expect(off.recurring).toBe(false);
        expect(off.actionName).toBe('selfHeal');
        expect(turns.getRoundState().queues[entityId][0].recurring).toBe(false);
        expect(turns.getRoundState().recurring).toEqual({});
        const on = turns.setRecurring(entityId, q.queueId, true);
        expect(on.success).toBe(true);
        expect(on.recurring).toBe(true);
        expect(turns.getRoundState().queues[entityId][0].recurring).toBe(true);
        expect(turns.getRoundState().recurring[entityId].selfHeal.source).toBe('player');

        // 3) toggle a missing queueId → NOT_IN_QUEUE (not a malformed ID).
        const missing = turns.setRecurring(entityId, 'q-notreal', true);
        expect(missing.success).toBe(false);
        expect(missing.code).toBe('NOT_IN_QUEUE');

        // 4) close round 0: resolution executes selfHeal ONCE and empties the queue.
        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');
        // Empty player queue drops the entity key from the queues map — null-safe.
        expect((turns.getRoundState().queues[entityId] || []).length).toBe(0);
        const before = world.getComponentStats(head).Physical.existence;

        // 5) round 1 (next tick): the recurring action is auto-requeued with
        //    the SAME actionName/params, flagged recurring, and the plan persists.
        const state1 = stepTo(world, tick, turns, 11);
        expect(state1.phase).toBe('planning');
        expect(state1.roundNumber).toBe(1);
        expect(state1.queues[entityId]).toHaveLength(1);
        expect(state1.queues[entityId][0]).toEqual(expect.objectContaining({
            actionName: 'selfHeal',
            params: { targetComponentId: head },
            recurring: true,
            source: 'player'
        }));
        expect(state1.recurring[entityId].selfHeal.params).toEqual({ targetComponentId: head });

        // 6) toggling off during round 1 stops the re-queue for round 2.
        turns.setRecurring(entityId, state1.queues[entityId][0].queueId, false);
        expect(turns.getRoundState().recurring[entityId]).toBeUndefined();
        const close1 = turns.signalPlanComplete(entityId, 'player'); // runs round-1 selfHeal
        expect(close1.closed).toBe(true);
        const after = world.getComponentStats(head).Physical.existence;
        // selfHeal ran once in round 1 (already counted once in round 0, in `before`)
        expect(after).toBe(before + 0.1);

        const state2 = stepTo(world, tick, turns, 12);
        expect(state2.phase).toBe('planning');
        expect(state2.roundNumber).toBe(2);
        // Not re-queued: the flag was off at the end of round 1.
        expect((state2.queues[entityId] || []).length).toBe(0);

        // 7) cancelAction on a recurring entry removes the plan too.
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player', true);
        const q3 = turns.getRoundState().queues[entityId][0];
        expect(q3.recurring).toBe(true);
        expect(turns.getRoundState().recurring[entityId]).toBeDefined();
        const cancel = turns.cancelAction(entityId, q3.queueId);
        expect(cancel.removed).toBe(true);
        expect(cancel.success).toBe(true);
        expect(turns.getRoundState().recurring[entityId]).toBeUndefined();
        expect((turns.getRoundState().queues[entityId] || []).length).toBe(0);
        const close3 = turns.signalPlanComplete(entityId, 'player');
        expect(close3.closed).toBe(true);
        // round-2 queue was empty (entry cancelled) → nothing executed this round.
        const round3 = stepTo(world, tick, turns, 13);
        expect(round3.phase).toBe('planning');
        expect(round3.roundNumber).toBe(3);
        // The plan was cancelled → the action is not re-queued in round 3.
        expect((round3.queues[entityId] || []).length).toBe(0);
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

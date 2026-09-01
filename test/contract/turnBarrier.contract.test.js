/**
 * CONTRACT TEST — Two-phase barrier turns, spec v2 (event-driven rounds, 23 tests).
 *
 * Driven WITHOUT real timers (same contract as TurnSystem.contract.test.js):
 * build the world, set tickSystem.currentTick = N, call turnSystem.onTick().
 *
 * World note: buildWorld() pins the roster to exactly ONE data-driven NPC
 * from data/npcs.json (all extras are despawned before the first tick) in
 * addition to the test droid, so a plain buildWorld() roster always has
 * 2 planners — deterministic against npcs.json growth (the crafterDrone
 * merge 7b54605 broke this invariant and drifted this suite).
 * `buildSoloWorld()` despawns that remaining NPC before the first tick so
 * the roster is exactly the test droid (single-entity world).
 *
 * v2 note: planning has NO deadline — the barrier closes only when every
 * roster planner has signaled plan-complete (a removal counts as vacuously
 * complete). Where a test needs the NPC to STAY un-signaled (removal,
 * route, late-settlement cases), it injects a never-settling stub agent
 * BEFORE the first tick; without a stub, the NPC auto-signals as a vacuous
 * plan at round start (empty agent slot) and the round could never be
 * observed mid-planning.
 *
 * Coverage (spec v2 §11 list, one test each):
 *   1. All-ready close — real pipeline execution + resolution transition in
 *      the same call; the next round starts on the next tick (fresh roster
 *      snapshot, barrier reset, ready button re-armed).
 *   2. No deadline — a planner who never signals keeps planning open past
 *      tick 500 (no resolution, no barrier close, queue intact).
 *   3. The never-signaling planner then signals — close + resolution in the
 *      same call.
 *   4. Idempotent signaling — exactly one close, exactly one resolution.
 *   5. OUT_OF_ROUND for a mid-round spawn; it does not block the close.
 *   6. Roster removal during planning — vacuous completion + warn log.
 *   7. NPC agent fires at round start; settlement (success) signals the
 *      barrier; close on the other planner's signal.
 *   8. NPC agent settlement (rejection) still signals — the round never
 *      hangs on an agent failure.
 *   9. POST /turns/ready/:entityId handler-level contract (200 shape / 400).
 *   10. TURNS_DISABLED for signals with a null tick system.
 *   11. Persistence round-trip with barrier state (mid-planning with the
 *      agent in flight + post-resolution closed).
 *   12. PLANNING_CLOSED after an all-ready close; the window re-opens when
 *      the next round starts on the next tick.
 *   13. Mid-planning spawn policy: never gates; queued entry still executes.
 *   14. Late cross-round NPC agent settlement — warn, ignore, no double
 *      resolution.
 *   15. Restore with barrier: {} — warn + defaults, phase intact.
 *   16. Restore with barrier absent — warn + defaults, phase intact.
 *   17. Roster fully removed during planning — vacuous "all-ready" close
 *      with empty pending (tick liveness sweep).
 *   18. Ready route with a missing turn system → 503.
 *   19. Synchronous agentFn throw — settled immediately as "did nothing"
 *      (warn + signal inside round start); the round still closes on the
 *      other planner's signal.
 *   20. All-NPC roster, empty agent slot — round 0 closes synchronously
 *      inside round start: exactly ONE transition (round 0 → resolution),
 *      no planning transition; round 1 starts on the next tick.
 *   21. Malformed persisted phase (phase absent + round history) —
 *      restore fail-safe: error log + reset to idle; round 0 starts
 *      lazily on the next tick (M1).
 *   22. Dirty-gated planning broadcast — 0 while the barrier view is
 *      unchanged, exactly 1 after a ready signal changes it; the
 *      settlement watchdog stays quiet under the threshold (M2).
 *   23. Restore with an empty agent slot — the un-signaled roster NPC is
 *      auto-signaled vacuously (no re-fire); the remaining signal closes
 *      the round (L1).
 *
 * @module test/contract/turnBarrier
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { register as registerTurnRoutes } from '../../src/routes/turnRoutes.js';
import Logger from '../../src/utils/Logger.js';

/**
 * Builds a fresh world wired to a (non-started) tick system, spawns the test
 * droid, and returns the facade + tick system + turn system + droid id.
 *
 * The roster is kept DETERMINISTIC against data/npcs.json: all data-driven
 * NPCs are despawned before the first tick EXCEPT one, so the round-start
 * roster is always [one data-driven NPC, test droid] = 2 planners — the
 * invariant every test in this file was written against. Without this pin,
 * npcs.json growth (the crafterDrone merge 7b54605) silently added planners
 * and broke the all-ready barrier / single-NPC agent assertions.
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    // Keep a single data-driven NPC (first in registry order); despawn the rest.
    const npcs = Object.values(world.stateEntityController.entities).filter(e => e.isNPC === true);
    for (let i = 1; i < npcs.length; i++) world.despawnEntity(npcs[i].id);
    return { world, tick, turns: subControllers.turnSystemController, entityId };
}

/**
 * Same as buildWorld(), but despawns the data-driven NPC BEFORE the first
 * tick so the round-start roster is exactly the test droid (single-entity
 * world).
 */
function buildSoloWorld() {
    const ctx = buildWorld();
    const npcs = Object.values(ctx.world.stateEntityController.entities).filter(e => e.isNPC === true);
    for (const npc of npcs) ctx.world.despawnEntity(npc.id);
    return ctx;
}

/** Advances the turn machine to an absolute tick and returns the round state. */
function stepTo(world, tick, turns, targetTick) {
    tick.currentTick = targetTick;
    turns.onTick();
    return turns.getRoundState();
}

/**
 * Finds a move-capable component id on the given entity (selfHeal target).
 * In the recipe→derivation model only organ-bearing components carry
 * function stats: the droidHead has think only, while the droidRollingBall
 * carries a moveCore (move). selfHeal requires `move >= 1`, so the target
 * must be a move-capable component for the marker effect to apply.
 */
function aHeadComponentId(world, entityId) {
    const entity = world.stateEntityController.getEntity(entityId);
    const moveComp = entity.components.find(c => {
        const stats = world.getComponentStats(c.id);
        return typeof stats?.Movement?.move === 'number' && stats.Movement.move > 0;
    });
    if (moveComp) return moveComp.id;
    const head = entity.components.find(c => c.type === 'droidHead');
    return head.id;
}

/** The id of the data-driven NPC entity (or null when none). */
function aNpcEntityId(world) {
    const npcs = Object.values(world.stateEntityController.entities).filter(e => e.isNPC === true);
    return npcs.length > 0 ? npcs[0].id : null;
}

/** Flushes pending microtasks (agent-promise settlement hooks). */
function flush() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('Two-phase barrier turns (spec v2 — event-driven rounds)', () => {
    it('1. all-ready close — real pipeline execution + resolution transition in the same call; the next round starts on the next tick', () => {
        const { world, tick, turns, entityId } = buildSoloWorld();
        stepTo(world, tick, turns, 0);
        const head = aHeadComponentId(world, entityId);

        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        const before = world.getComponentStats(head).Physical.existence;

        const updates = [];
        turns.setBroadcaster({
            broadcastTurnUpdate: (payload) => updates.push(payload),
            broadcast: () => {}
        });

        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.success).toBe(true);
        expect(sig.alreadySignaled).toBe(false);
        expect(sig.closed).toBe(true);

        // The phase flipped WITHIN the signal call (there is no deadline to
        // wait for — the close is event-driven).
        const state = turns.getRoundState();
        expect(state.phase).toBe('resolution');
        expect(state.currentTick).toBe(0);
        expect(state.barrier.closed).toBe(true);
        expect(state.barrier.closeReason).toBe('all-ready');
        expect(state.barrier.closedAtTick).toBe(0);
        expect(Object.keys(state.queues)).toHaveLength(0);

        // The queued action executed through the REAL pipeline.
        const after = world.getComponentStats(head).Physical.existence;
        expect(after).toBe(before + 0.1);

        // A turn-round-update with phase 'resolution' was emitted on the close tick.
        const resUpdate = updates.find(u => u.phase === 'resolution');
        expect(resUpdate, 'expected a resolution turn-round-update').toBeTruthy();
        expect(resUpdate.currentTick).toBe(0);
        expect(resUpdate.barrier).toEqual(expect.objectContaining({ closed: true, closeReason: 'all-ready' }));

        // The next round starts on the tick AFTER resolution: a fresh roster
        // snapshot, the barrier reset, the ready button re-armed.
        const next = stepTo(world, tick, turns, 1);
        expect(next.roundNumber).toBe(1);
        expect(next.phase).toBe('planning');
        expect(next.barrier).toEqual({
            closed: false,
            closedAtTick: null,
            closeReason: null,
            readyCount: 0,
            pendingCount: 1,
            pendingEntityIds: [entityId]
        });
    });

    it('2. no deadline — a planner who never signals keeps planning open past tick 500', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 0);
        const head = aHeadComponentId(world, entityId);
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');

        // The data NPC auto-signaled at round start (empty agent slot) — the
        // droid is the only remaining planner, and it NEVER signals.
        for (let t = 1; t <= 500; t++) {
            tick.currentTick = t;
            turns.onTick();
        }

        // After 500 ticks the round is STILL planning: no deadline exists to
        // force a close (binding product decision — the wait is visible in
        // the barrier, never hidden behind a timer).
        const state = turns.getRoundState();
        expect(state.phase).toBe('planning');
        expect(state.roundNumber).toBe(0);
        expect(state.barrier.closed).toBe(false);
        expect(state.barrier.closeReason).toBe(null);
        expect(state.barrier.pendingEntityIds).toEqual([entityId]);
        expect(turns.getQueuedActions(entityId)).toHaveLength(1);
    });

    it('3. the never-signaling planner then signals — close + resolution in the same call', () => {
        const { world, tick, turns, entityId } = buildSoloWorld();
        stepTo(world, tick, turns, 0);
        const head = aHeadComponentId(world, entityId);
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        const before = world.getComponentStats(head).Physical.existence;

        // The very signal that completes the roster closes AND resolves in
        // this same call.
        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.success).toBe(true);
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');
        expect(turns.getRoundState().phase).toBe('resolution');
        expect(world.getComponentStats(head).Physical.existence).toBe(before + 0.1);
    });

    it('4. idempotent signaling — a second signal is a no-op; exactly one close + one resolution', () => {
        const { world, tick, turns, entityId } = buildSoloWorld();
        stepTo(world, tick, turns, 0);
        const head = aHeadComponentId(world, entityId);
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        const before = world.getComponentStats(head).Physical.existence;

        const updates = [];
        turns.setBroadcaster({
            broadcastTurnUpdate: (payload) => updates.push(payload),
            broadcast: () => {}
        });

        const first = turns.signalPlanComplete(entityId, 'player');
        expect(first.success).toBe(true);
        expect(first.alreadySignaled).toBe(false);
        expect(first.closed).toBe(true);

        const second = turns.signalPlanComplete(entityId, 'player');
        expect(second.success).toBe(true);
        expect(second.alreadySignaled).toBe(true);
        expect(second.closed).toBe(true);

        // Exactly one resolution: the queued selfHeal ran exactly once
        // (+10, NOT +20), and exactly one resolution transition was emitted.
        expect(world.getComponentStats(head).Physical.existence).toBe(before + 0.1);
        expect(updates.filter(u => u.phase === 'resolution')).toHaveLength(1);
        expect(Object.keys(turns.getRoundState().queues)).toHaveLength(0);
    });

    it('5. OUT_OF_ROUND for a mid-round spawn — it does not block the rest of the roster', () => {
        const { world, tick, turns, entityId } = buildSoloWorld();
        stepTo(world, tick, turns, 0);

        // Spawn AFTER the round-start snapshot.
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const lateId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        const sig = turns.signalPlanComplete(lateId, 'player');
        expect(sig.success).toBe(false);
        expect(sig.code).toBe('OUT_OF_ROUND');

        // The late joiner's (rejected) signal did not gate the close: the
        // original roster member's signal still closes the round.
        const close = turns.signalPlanComplete(entityId, 'player');
        expect(close.success).toBe(true);
        expect(close.closed).toBe(true);
        expect(close.barrier.closeReason).toBe('all-ready');
    });

    it('6. roster entity removed during planning — vacuous completion + warn log', () => {
        const { world, tick, turns, entityId } = buildWorld();
        // Never-settling agent: the NPC must stay UN-signaled so its removal
        // is a real vacuous-completion case (without a stub the NPC would
        // have auto-signaled at round start).
        turns.setNpcAgent(() => new Promise(() => {}));
        stepTo(world, tick, turns, 0);
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the data-driven NPC').toBeTruthy();

        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            // The NPC leaves the world while planning is still open.
            world.despawnEntity(npcId);

            // The remaining planner's signal closes the round: the removed
            // roster member is counted as vacuously complete.
            const sig = turns.signalPlanComplete(entityId, 'player');
            expect(sig.success).toBe(true);
            expect(sig.closed).toBe(true);
            expect(sig.barrier.closeReason).toBe('all-ready');
            expect(sig.barrier.pendingCount).toBe(0);

            expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('removed during planning')),
                'expected a warn log line for the removed roster entity').toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('7. NPC agent fires at round start; settlement (success) signals the barrier; close on the other planner', async () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the data-driven NPC').toBeTruthy();

        // Stub agent: a promise we control (the real LLMAgentController shape).
        const agentCalls = [];
        let resolveAgent = null;
        turns.setNpcAgent((npcEntityId, round) => {
            agentCalls.push({ npcEntityId, round });
            return new Promise(resolve => { resolveAgent = resolve; });
        });

        // The agent fires at ROUND START (the first onTick — there is no
        // local-tick-20 trigger in v2) and exactly once, for round 0.
        stepTo(world, tick, turns, 0);
        expect(agentCalls).toHaveLength(1);
        expect(agentCalls[0]).toEqual({ npcEntityId: npcId, round: 0 });
        expect(turns.getRoundState().barrier.pendingEntityIds).toContain(npcId);

        // Settle the agent promise — the settlement hook signals plan-complete.
        resolveAgent();
        await flush();
        expect(turns.getRoundState().barrier.pendingEntityIds).not.toContain(npcId);

        // The barrier closes with the other planner.
        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');
    });

    it('8. NPC agent settlement (rejection) still signals — the round never hangs on an agent failure', async () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the data-driven NPC').toBeTruthy();

        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            turns.setNpcAgent(() => Promise.reject(new Error('LLM unavailable')));

            // The agent fires at round start; the rejection settles in a
            // microtask.
            stepTo(world, tick, turns, 0);
            await flush();

            // The rejected promise still settled → the NPC signaled.
            expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('failed'))).toBe(true);
            expect(turns.getRoundState().barrier.pendingEntityIds).not.toContain(npcId);

            // The barrier closes; nothing waits on the dead agent.
            const sig = turns.signalPlanComplete(entityId, 'player');
            expect(sig.closed).toBe(true);
            expect(sig.barrier.closeReason).toBe('all-ready');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('9. POST /turns/ready/:entityId — 200 { success, alreadySignaled, closed, barrier }; malformed ID → 400', async () => {
        const { world, tick, turns, entityId } = buildWorld();
        // Never-settling agent: the NPC stays pending so the droid's signal
        // does NOT close the barrier (the 200 shape asserts closed: false).
        turns.setNpcAgent(() => new Promise(() => {}));
        stepTo(world, tick, turns, 0);
        const npcId = aNpcEntityId(world);

        const router = express.Router();
        registerTurnRoutes(router, { worldStateController: world });
        const app = express().use(router);
        const server = await new Promise(resolve => {
            const s = app.listen(0);
            resolve(s);
        });
        const port = server.address().port;

        try {
            // The droid signals via the route; the NPC is still pending.
            const res = await fetch(`http://localhost:${port}/turns/ready/${entityId}`, { method: 'POST' });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.alreadySignaled).toBe(false);
            expect(body.closed).toBe(false);
            expect(body.barrier).toEqual(expect.objectContaining({
                readyCount: expect.any(Number),
                pendingCount: expect.any(Number),
                pendingEntityIds: expect.arrayContaining([npcId])
            }));

            // Idempotent through the route too.
            const res2 = await fetch(`http://localhost:${port}/turns/ready/${entityId}`, { method: 'POST' });
            expect(res2.status).toBe(200);
            const body2 = await res2.json();
            expect(body2.success).toBe(true);
            expect(body2.alreadySignaled).toBe(true);
            expect(body2.closed).toBe(false);

            // Malformed ID → 400 (the only non-2xx rule outcome).
            const bad = await fetch(`http://localhost:${port}/turns/ready/not-an-entity-id`, { method: 'POST' });
            expect(bad.status).toBe(400);
        } finally {
            server.close();
        }
    });

    it('10. TURNS_DISABLED regression for signals — null tick system rejects the signal', () => {
        const { worldStateController: world } = buildWorldState(null);
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        const sig = world.turnSystemController.signalPlanComplete(entityId, 'player');
        expect(sig.success).toBe(false);
        expect(sig.code).toBe('TURNS_DISABLED');
    });

    it('11. persistence round-trip with barrier state — mid-planning agent in flight + post-resolution closed', async () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        const head = aHeadComponentId(world, entityId);

        // Controllable agent: fires at round start (round 0) and stays
        // pending — the in-flight plan is what restore must survive.
        const agentCalls1 = [];
        let resolveAgent1 = null;
        turns.setNpcAgent((npcEntityId, round) => {
            agentCalls1.push({ npcEntityId, round });
            return new Promise(resolve => { resolveAgent1 = resolve; });
        });
        stepTo(world, tick, turns, 50);
        expect(agentCalls1).toEqual([{ npcEntityId: npcId, round: 0 }]);

        // Mid-planning: pending queue + neither planner signaled yet.
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(turns.getRoundState().barrier.pendingEntityIds)
            .toEqual(expect.arrayContaining([entityId, npcId]));

        const snapshot = world.serialize();
        expect(snapshot.state.turns).toMatchObject({
            phase: 'planning',
            barrier: expect.objectContaining({ closed: false, closeReason: null })
        });
        expect(snapshot.state.turns.barrier.roster).toEqual(expect.arrayContaining([entityId, npcId]));
        expect(snapshot.state.turns.barrier.signaled).toEqual([]);

        // Restore onto a FRESH instance: the un-signaled roster NPC re-fires
        // its agent (the in-flight promise was lost with the process, and
        // with no deadline a lost plan would wait forever).
        const { world: world2, turns: turns2 } = buildWorld();
        const agentCalls2 = [];
        let resolveAgent2 = null;
        turns2.setNpcAgent((npcEntityId, round) => {
            agentCalls2.push({ npcEntityId, round });
            return new Promise(resolve => { resolveAgent2 = resolve; });
        });
        const restored = world2.restore(snapshot);
        expect(restored.success).toBe(true);
        expect(agentCalls2).toEqual([{ npcEntityId: npcId, round: 0 }]);

        // Roster/closed match; the queue is intact.
        const state2 = turns2.getRoundState();
        expect(state2.barrier.closed).toBe(false);
        expect(state2.barrier.pendingEntityIds).toEqual(expect.arrayContaining([entityId, npcId]));
        expect(turns2.getQueuedActions(entityId)).toHaveLength(1);

        // The re-fired agent settles post-restore; the remaining signal then
        // closes the barrier and resolves the restored queue through the
        // real pipeline.
        resolveAgent2();
        await flush();
        const before = world2.getComponentStats(head).Physical.existence;
        const sig2 = turns2.signalPlanComplete(entityId, 'player');
        expect(sig2.closed).toBe(true);
        expect(sig2.barrier.closeReason).toBe('all-ready');
        expect(world2.getComponentStats(head).Physical.existence).toBe(before + 0.1);

        // Post-resolution snapshot: restores as closed, no re-resolution,
        // and the queue gate stays closed.
        const snapshotB = world2.serialize();
        expect(snapshotB.state.turns).toMatchObject({
            phase: 'resolution',
            barrier: expect.objectContaining({ closed: true, closeReason: 'all-ready' })
        });
        const { world: world3, turns: turns3 } = buildWorld();
        expect(world3.restore(snapshotB).success).toBe(true);
        expect(turns3.getRoundState().barrier.closed).toBe(true);
        const q3 = turns3.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q3.success).toBe(false);
        expect(q3.code).toBe('PLANNING_CLOSED');
    });

    it('12. PLANNING_CLOSED after an all-ready close — the window re-opens when the next round starts on the next tick', () => {
        const { world, tick, turns, entityId } = buildSoloWorld();
        stepTo(world, tick, turns, 0);
        const head = aHeadComponentId(world, entityId);

        const sig = turns.signalPlanComplete(entityId, 'player');
        expect(sig.closed).toBe(true);
        expect(sig.barrier.closeReason).toBe('all-ready');

        // The STORED phase is resolution → the queue is rejected…
        const q = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q.success).toBe(false);
        expect(q.code).toBe('PLANNING_CLOSED');

        // …until the next tick starts the next round: planning re-opens and
        // the same queueAction succeeds again.
        const next = stepTo(world, tick, turns, 1);
        expect(next.phase).toBe('planning');
        expect(next.roundNumber).toBe(1);
        const q2 = turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q2.success).toBe(true);
    });

    it('13. mid-planning spawn policy — never gates the close; its queued entry still executes', () => {
        const { world, tick, turns, entityId } = buildSoloWorld();
        stepTo(world, tick, turns, 0);

        // Spawn mid-planning (after the round-start snapshot).
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const lateId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Not in the roster → its signal is OUT_OF_ROUND…
        expect(turns.signalPlanComplete(lateId, 'player').code).toBe('OUT_OF_ROUND');

        // …but it may still queue before the close…
        const lateHead = aHeadComponentId(world, lateId);
        const lateQueue = turns.queueAction(lateId, 'selfHeal', { targetComponentId: lateHead }, 'player');
        expect(lateQueue.success).toBe(true);

        // …and the original roster member's signal closes the round — the
        // spawn did not delay it.
        const close = turns.signalPlanComplete(entityId, 'player');
        expect(close.closed).toBe(true);
        expect(close.barrier.closeReason).toBe('all-ready');

        // The late joiner's entry executed via the late-joiner reconciliation.
        expect(world.getComponentStats(lateHead).Physical.existence).toBeGreaterThan(0);
    });

    it('14. late cross-round NPC agent settlement — warn, ignore, no double resolution', async () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the data-driven NPC').toBeTruthy();

        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            // Controllable agent promise: fired at round start, stays pending.
            let resolveAgent = null;
            turns.setNpcAgent(() => new Promise(resolve => { resolveAgent = resolve; }));
            stepTo(world, tick, turns, 0);
            expect(turns.getRoundState().barrier.pendingEntityIds)
                .toEqual(expect.arrayContaining([entityId, npcId]));

            const updates = [];
            turns.setBroadcaster({
                broadcastTurnUpdate: (payload) => updates.push(payload),
                broadcast: () => {}
            });

            // BOTH planners leave the world while the agent is still in
            // flight: removal is vacuously complete, so the tick liveness
            // sweep closes round 0 all-ready on the next tick.
            world.despawnEntity(entityId);
            world.despawnEntity(npcId);
            const closed = stepTo(world, tick, turns, 1);
            expect(closed.phase).toBe('resolution');
            expect(closed.barrier.closeReason).toBe('all-ready');

            // A fresh droid joins, and the next tick starts round 1 with a
            // fresh barrier for the fresh roster.
            const startRoomId = world.roomsController.getUidByLogicalId('start_room');
            const freshId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
            const next = stepTo(world, tick, turns, 2);
            expect(next.phase).toBe('planning');
            expect(next.roundNumber).toBe(1);
            expect(next.barrier.pendingEntityIds).toEqual([freshId]);

            // NOW the round-0 agent settles (a very late LLM response): the
            // round-key guard must drop it — no signal may land in round 1's
            // barrier.
            resolveAgent();
            await flush();

            expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('settled after the round advanced')),
                'expected the late-settlement warn log').toBe(true);

            const state = turns.getRoundState();
            expect(state.phase).toBe('planning');
            expect(state.roundNumber).toBe(1);
            expect(state.barrier.closed).toBe(false);
            expect(state.barrier.pendingEntityIds).toEqual([freshId]);

            // Exactly ONE resolution happened (round 0's all-ready close).
            expect(updates.filter(u => u.phase === 'resolution')).toHaveLength(1);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('15. restore with barrier: {} — warn + defaults, phase intact', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 50);
        const head = aHeadComponentId(world, entityId);
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        const snapshot = world.serialize();
        snapshot.state.turns.barrier = {};

        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            // Fresh instance restores the wiped snapshot directly.
            const { world: world2, turns: turns2 } = buildWorld();
            const restored = world2.restore(snapshot);
            expect(restored.success).toBe(true);

            // A keyless {} barrier is malformed (the _restoreBarrier
            // refinement): warn + empty (not closed) defaults.
            expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('"barrier" section')),
                'expected the malformed-barrier warn log').toBe(true);

            const state2 = turns2.getRoundState();
            expect(state2.phase).toBe('planning');
            expect(state2.barrier).toEqual(expect.objectContaining({ closed: false, readyCount: 0, pendingCount: 0 }));
            expect(state2.barrier.pendingEntityIds).toHaveLength(0);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('16. restore with barrier absent — warn + defaults, phase intact', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 50);
        const head = aHeadComponentId(world, entityId);
        turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        const snapshot = world.serialize();
        delete snapshot.state.turns.barrier;

        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            const { world: world2, turns: turns2 } = buildWorld();
            const restored = world2.restore(snapshot);
            expect(restored.success).toBe(true);

            expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('"barrier" section')),
                'expected the missing-barrier warn log').toBe(true);

            const state2 = turns2.getRoundState();
            expect(state2.phase).toBe('planning');
            expect(state2.barrier).toEqual(expect.objectContaining({ closed: false, readyCount: 0, pendingCount: 0 }));
            expect(state2.barrier.pendingEntityIds).toHaveLength(0);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('17. roster fully removed during planning — vacuous "all-ready" close with empty pending', () => {
        const { world, tick, turns, entityId } = buildWorld();
        // Never-settling agent: the NPC must stay UN-signaled so BOTH
        // removals warn (without a stub the NPC would have auto-signaled).
        turns.setNpcAgent(() => new Promise(() => {}));
        stepTo(world, tick, turns, 0);
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the data-driven NPC').toBeTruthy();

        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            // Every roster planner leaves the world while planning is open.
            world.despawnEntity(npcId);
            world.despawnEntity(entityId);

            // The tick liveness sweep sees zero live planners: vacuous
            // all-ready close (one warn per removal).
            const state = stepTo(world, tick, turns, 1);
            expect(state.phase).toBe('resolution');
            expect(state.barrier).toEqual(expect.objectContaining({
                closed: true,
                closeReason: 'all-ready',
                pendingCount: 0,
                pendingEntityIds: []
            }));
            const removalWarns = warnSpy.mock.calls
                .filter(([msg]) => String(msg).includes('removed during planning'));
            expect(removalWarns, 'expected one warn per removed roster member').toHaveLength(2);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('18. ready route with a missing turn system → 503', async () => {
        const router = express.Router();
        registerTurnRoutes(router, { worldStateController: { turnSystemController: null } });
        const app = express().use(router);
        const server = await new Promise(resolve => {
            const s = app.listen(0);
            resolve(s);
        });
        const port = server.address().port;

        try {
            const res = await fetch(`http://localhost:${port}/turns/ready/ent-00000000-0000-0000-0000-000000000000`, { method: 'POST' });
            expect(res.status).toBe(503);
            const body = await res.json();
            expect(body.error).toBe('Turn system is not available.');
        } finally {
            server.close();
        }
    });

    it('19. synchronous agentFn throw — settled immediately as "did nothing" inside round start', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        expect(npcId, 'test world must contain the data-driven NPC').toBeTruthy();

        const agentCalls = [];
        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            turns.setNpcAgent((npcEntityId) => {
                agentCalls.push(npcEntityId);
                throw new Error('agent exploded synchronously');
            });

            // The throw is caught INSIDE round start (no tick-loop break) and
            // the planner is settled as "did nothing" — with no deadline an
            // un-settled throw would hang the round forever (spec v2 §1.4 i).
            stepTo(world, tick, turns, 0);
            expect(agentCalls).toEqual([npcId]);
            expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('threw')),
                'expected the sync-throw warn log').toBe(true);

            // The NPC already signaled inside the round-start call.
            const state = turns.getRoundState();
            expect(state.phase).toBe('planning');
            expect(state.roundNumber).toBe(0);
            expect(state.barrier.pendingEntityIds).toEqual([entityId]);

            // The round still closes on the other planner's signal.
            const sig = turns.signalPlanComplete(entityId, 'player');
            expect(sig.success).toBe(true);
            expect(sig.closed).toBe(true);
            expect(sig.barrier.closeReason).toBe('all-ready');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('20. all-NPC roster with an empty agent slot — round 0 closes synchronously in round start; exactly ONE transition', () => {
        const { world, tick, turns, entityId } = buildWorld();
        // Remove the test droid BEFORE the first tick: the round-start roster
        // is the data NPC alone, and with no agent wired the NPC auto-signals
        // vacuously DURING _roundStart — closing the round before it returns.
        world.despawnEntity(entityId);

        const updates = [];
        turns.setBroadcaster({
            broadcastTurnUpdate: (payload) => updates.push(payload),
            broadcast: () => {}
        });

        const state = stepTo(world, tick, turns, 0);
        expect(state.roundNumber).toBe(0);
        expect(state.phase).toBe('resolution');
        expect(state.barrier).toEqual(expect.objectContaining({
            closed: true,
            closeReason: 'all-ready'
        }));

        // Exactly ONE round-0 transition, and it is the RESOLUTION one: the
        // out-of-order planning transition was suppressed (the close emitted
        // its own transition during agent firing).
        const round0 = updates.filter(u => u.roundNumber === 0);
        expect(round0).toHaveLength(1);
        expect(round0[0].phase).toBe('resolution');
        expect(updates.filter(u => u.roundNumber === 0 && u.phase === 'planning')).toHaveLength(0);

        // The NEXT tick starts round 1 (duty 2): the round is already in
        // resolution, so the tick never re-enters duty 3 for it. Round 1's
        // roster is still the NPC alone, so it closes again in round start —
        // and round 0's single resolution transition is untouched.
        const next = stepTo(world, tick, turns, 1);
        expect(next.roundNumber).toBe(1);
        expect(next.phase).toBe('resolution');
        expect(updates.filter(u => u.roundNumber === 0)).toHaveLength(1);
    });

    it('21. malformed persisted phase (phase absent + round history) — restore fail-safe resets to idle (M1)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        stepTo(world, tick, turns, 50);
        const snapshot = world.serialize();
        expect(snapshot.state.turns.phase).toBe('planning');
        expect(snapshot.state.turns.lastRound).toBe(0);
        // Corrupt the snapshot: drop the stored phase while keeping the round
        // history — a state the live round machine can never reach.
        delete snapshot.state.turns.phase;

        const { world: world2, tick: tick2, turns: turns2 } = buildWorld();
        const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});
        try {
            const restored = world2.restore(snapshot);
            expect(restored.success).toBe(true);
            expect(errorSpy.mock.calls.some(([msg]) => String(msg).includes('malformed persisted turn state')),
                'expected the M1 malformed-phase error log').toBe(true);

            // Reset to idle: the public read maps the null phase to planning
            // and the missing round to 0 — the controller looks like a fresh
            // world, because it IS one.
            const idle = turns2.getRoundState();
            expect(idle.phase).toBe('planning');
            expect(idle.roundNumber).toBe(0);
            expect(idle.barrier.closed).toBe(false);
            expect(idle.barrier.pendingEntityIds).toHaveLength(0);

            // Round 0 starts LAZILY on the next tick (duty 1): restore
            // replaced world2's entities with the snapshot's, and the data NPC
            // (agent slot empty in world2) auto-signals vacuously.
            const state2 = stepTo(world2, tick2, turns2, 0);
            expect(state2.roundNumber).toBe(0);
            expect(state2.phase).toBe('planning');
            expect(state2.barrier.pendingEntityIds).toEqual([entityId]);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('22. dirty-gated planning broadcast — 0 while unchanged, exactly 1 after a signal; watchdog quiet under threshold (M2)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        // Never-settling agent: the NPC stays un-signaled so the barrier view
        // is stable across ticks (no close, no vacuous completion).
        turns.setNpcAgent(() => new Promise(() => {}));
        stepTo(world, tick, turns, 0);
        expect(turns.getRoundState().barrier.pendingEntityIds)
            .toEqual(expect.arrayContaining([entityId, npcId]));

        // The baseline (lastBroadcastBarrier) was captured at round start,
        // before this broadcaster existed.
        let broadcasts = 0;
        turns.setBroadcaster({
            broadcastTurnUpdate: () => {},
            broadcast: () => { broadcasts += 1; }
        });

        const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});
        try {
            // Quiet tick: nothing changed → the gate holds the broadcast.
            stepTo(world, tick, turns, 1);
            expect(broadcasts).toBe(0);
            expect(errorSpy).not.toHaveBeenCalled();

            // A ready signal changes the barrier view (one fewer pending).
            const sig = turns.signalPlanComplete(entityId, 'player');
            expect(sig.success).toBe(true);
            expect(sig.closed).toBe(false);
            expect(turns.getRoundState().barrier.pendingEntityIds).toEqual([npcId]);

            // The NEXT tick sees the change → exactly one full-state
            // broadcast, and no more while the view stays unchanged.
            stepTo(world, tick, turns, 2);
            expect(broadcasts).toBe(1);
            stepTo(world, tick, turns, 3);
            expect(broadcasts).toBe(1);

            // Watchdog: the NPC's agent is unsettled, but only a few ticks
            // into the 300-tick observability window — no error, no
            // intervention (the round is still planning).
            expect(errorSpy).not.toHaveBeenCalled();
            expect(turns.getRoundState().phase).toBe('planning');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('23. restore with an empty agent slot — un-signaled roster NPC auto-signaled vacuously, no re-fire (L1)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const npcId = aNpcEntityId(world);
        // Never-settling agent: at snapshot time the NPC is mid-plan (no
        // signal yet) with its promise in flight.
        turns.setNpcAgent(() => new Promise(() => {}));
        stepTo(world, tick, turns, 0);
        const snapshot = world.serialize();
        expect(snapshot.state.turns.phase).toBe('planning');
        expect(snapshot.state.turns.barrier.signaled).toEqual([]);

        // Restore onto a FRESH world WITHOUT an agent wired: the in-flight
        // promise is gone, and the empty slot must settle the plan vacuously
        // instead of leaving the signal outstanding (L1).
        const { world: world2, turns: turns2 } = buildWorld();
        const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {});
        try {
            expect(world2.restore(snapshot).success).toBe(true);
            expect(infoSpy.mock.calls.some(([msg]) => String(msg).includes('auto-signaled as a vacuous plan')),
                'expected the L1 vacuous auto-signal info log').toBe(true);

            // The NPC signaled; only the droid is still pending.
            const state2 = turns2.getRoundState();
            expect(state2.phase).toBe('planning');
            expect(state2.barrier.pendingEntityIds).toEqual([entityId]);

            // The remaining signal closes the round — nothing waits on the
            // lost promise.
            const sig2 = turns2.signalPlanComplete(entityId, 'player');
            expect(sig2.success).toBe(true);
            expect(sig2.closed).toBe(true);
            expect(sig2.barrier.closeReason).toBe('all-ready');
        } finally {
            infoSpy.mockRestore();
        }
    });
});

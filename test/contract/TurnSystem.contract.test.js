/**
 * CONTRACT TEST — TurnSystemController (Feature A, spec §5.12).
 *
 * Driven WITHOUT real timers: build the world via buildWorldState(tickSystem)
 * (tick not started), set tickSystem.currentTick = N, call turnSystem.onTick().
 * This is the spec's deterministic test contract — the state machine is
 * advanced by the injected tick counter, never by the event loop.
 *
 * Covers the full §5.12 checklist:
 *   - tick 0: phase 'planning', roundNumber 0, initiative 40 tie → entityId order,
 *     state.turns present in facade.getAll().
 *   - queueAction during planning → q- id; 4th entry → QUEUE_FULL.
 *   - tick 300: phase 'resolution', selfHeal ran via the REAL pipeline
 *     (durability delta asserted), worldEventLog has a turn line naming the
 *     actor + order, queue empty, roundNumber unchanged.
 *   - out-of-range 'droid punch' (target in another room) → discarded with a
 *     failure log, no exception, other entries still execute.
 *   - queueAction at tick 350 → PLANNING_CLOSED.
 *   - setNpcAgent(stub): fired exactly once per NPC at tick 20 with
 *     (npcEntityId, 0); a late queue (after 300) → rejected, no crash.
 *   - state.turns shape (Appendix A) + turn-round-update transitions.
 *   - serialize/restore round-trip of the pending queue at schema v2.
 *
 * @module test/contract/TurnSystem
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/**
 * Builds a fresh world wired to a (non-started) tick system. Returns the
 * facade, the tick system, and the turn system controller.
 * @returns {{ world: import('../../src/controllers/WorldStateController.js'), tick: UniversalTickSystem, turns: import('../../src/controllers/core/TurnSystemController.js') }}
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    return { world, tick, turns: subControllers.turnSystemController };
}

/**
 * Advances the turn machine to an absolute tick and returns the round state.
 * (The spec's "set tick N, onTick()" primitive.)
 */
function stepTo(world, tick, turns, targetTick) {
    tick.currentTick = targetTick;
    turns.onTick();
    return turns.getRoundState();
}

/** Finds a droidHead component id on the first droid (selfHeal target). */
function aHeadComponentId(world) {
    const entities = Object.values(world.stateEntityController.entities);
    const droid = entities[0];
    const head = droid.components.find(c => c.type === 'droidHead');
    return head.id;
}

describe('TurnSystemController (Feature A)', () => {
    it('tick 0: planning, round 0, initiative 40 tie → ascending entityId, state.turns in getAll()', () => {
        const { world, tick, turns } = buildWorld();
        const entities = Object.values(world.stateEntityController.entities);
        expect(entities.length).toBeGreaterThanOrEqual(2);

        const state = stepTo(world, tick, turns, 0);

        expect(state.phase).toBe('planning');
        expect(state.roundNumber).toBe(0);
        expect(state.currentTick).toBe(0);
        expect(state.planningDeadlineTick).toBe(300);

        // Feature D: the world now also contains the NPC (data/npcs.json).
        // Player droids: 2× droidRollingBall × move(20) = initiative 40 (tie).
        // Bolt the Merchant: 2× merchantRollingBall × move(10) = initiative 20
        // → sorts strictly AFTER every player droid (spec §7.1 / §7.7).
        expect(state.actorOrder.length).toBeGreaterThanOrEqual(3);
        for (const actor of state.actorOrder.slice(0, -1)) {
            expect(actor.initiative).toBe(40);
            expect(actor.queuedCount).toBe(0);
        }
        const bolt = state.actorOrder[state.actorOrder.length - 1];
        expect(bolt.name).toBe('Bolt the Merchant');
        expect(bolt.initiative).toBe(20);
        expect(bolt.queuedCount).toBe(0);
        // Tiebreak among the droids: ascending entityId.
        for (let i = 1; i < state.actorOrder.length - 1; i++) {
            expect(state.actorOrder[i - 1].entityId < state.actorOrder[i].entityId).toBe(true);
        }

        // state.turns is present in the facade's full state (spec §5.7).
        const full = world.getAll();
        expect(full).toHaveProperty('turns');
        expect(full.turns.roundNumber).toBe(0);
        expect(full.turns.phase).toBe('planning');
    });

    it('queueAction during planning → q- id; 4th entry → QUEUE_FULL', () => {
        const { world, tick, turns } = buildWorld();
        stepTo(world, tick, turns, 10);

        const entity = Object.values(world.stateEntityController.entities)[0];
        const head = aHeadComponentId(world);

        const q1 = turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q1.success).toBe(true);
        expect(q1.queueId).toMatch(/^q-/);
        expect(q1.queue).toHaveLength(1);

        const q2 = turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q2.success).toBe(true);
        const q3 = turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q3.success).toBe(true);

        // Cap is 3 → the 4th is rejected QUEUE_FULL.
        const q4 = turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q4.success).toBe(false);
        expect(q4.code).toBe('QUEUE_FULL');

        // The live queue count is reflected in the round state.
        const state = turns.getRoundState();
        const mine = state.actorOrder.find(a => a.entityId === entity.id);
        expect(mine.queuedCount).toBe(3);
    });

    it('tick 300: resolution runs selfHeal via the REAL pipeline; turn event logged; queue cleared', () => {
        const { world, tick, turns } = buildWorld();
        stepTo(world, tick, turns, 5);
        const entity = Object.values(world.stateEntityController.entities)[0];
        const head = aHeadComponentId(world);
        const before = world.getComponentStats(head).Physical.durability;

        turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');

        const state = stepTo(world, tick, turns, 300);
        expect(state.phase).toBe('resolution');
        // Resolution is mid-round — roundNumber is unchanged (still 0).
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
        const { world, tick, turns } = buildWorld();
        const [client, vault] = Object.values(world.stateEntityController.entities);
        const head = client.components.find(c => c.type === 'droidHead').id;

        // Push the target droid far away so the punch (range 100) is out of range.
        world.stateEntityController.updateEntitySpatial(vault.id, { x: 5000, y: 5000 });

        stepTo(world, tick, turns, 5);
        // Two entries for the SAME actor: a valid selfHeal + an out-of-range punch.
        const heal = turns.queueAction(client.id, 'selfHeal', { targetComponentId: head }, 'player');
        expect(heal.success).toBe(true);
        const punch = turns.queueAction(client.id, 'droid punch', { targetEntityId: vault.id }, 'player');
        expect(punch.success).toBe(true);

        const before = world.getComponentStats(head).Physical.durability;
        expect(() => stepTo(world, tick, turns, 300)).not.toThrow();

        // The valid entry still executed (round did not abort).
        const after = world.getComponentStats(head).Physical.durability;
        expect(after).toBe(before + 10);

        // The punch was discarded with a failure log line (not executed).
        const events = world.getRecentEvents(12).filter(e => e.action === 'turn');
        const discarded = events.find(e => e.message.includes('discarded') && e.message.includes('droid punch'));
        expect(discarded, 'expected a discard log line for the out-of-range punch').toBeTruthy();
        expect(discarded.level).toBe('warn');
    });

    it('queueAction at tick 350 (resolution/settle) → PLANNING_CLOSED', () => {
        const { world, tick, turns } = buildWorld();
        // Step through the whole round so the machine is in settle (L=350).
        stepTo(world, tick, turns, 0);
        stepTo(world, tick, turns, 300);
        stepTo(world, tick, turns, 350);
        expect(turns.getRoundState().phase).toBe('resolution');

        const entity = Object.values(world.stateEntityController.entities)[0];
        const head = aHeadComponentId(world);

        const q = turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q.success).toBe(false);
        expect(q.code).toBe('PLANNING_CLOSED');
    });

    it('setNpcAgent: fired exactly once per NPC at tick 20; a late queue (post-300) is rejected, no crash', async () => {
        const { world, tick, turns } = buildWorld();
        // Feature D: a REAL NPC (Bolt) is spawned by the world; mark one of
        // the player droids as an NPC on top (the pre-D stubbing pattern) so
        // the agent must fire for BOTH.
        const droid = Object.values(world.stateEntityController.entities).find(e => e.blueprint === 'smallBallDroid');
        const npc = droid;
        const bolt = Object.values(world.stateEntityController.entities).find(e => e.isNPC === true);
        const head = npc.components.find(c => c.type === 'droidHead').id;
        // Mark the entity as an NPC (Feature D spawns do this natively).
        world.stateEntityController.entities[npc.id].isNPC = true;

        const calls = [];
        let lateQueueResult;
        // Async agent: queues on a microtask (simulating the LLM returning).
        turns.setNpcAgent((npcEntityId, round) => {
            calls.push({ npcEntityId, round });
            return Promise.resolve().then(() => {
                lateQueueResult = turns.queueAction(npcEntityId, 'selfHeal', { targetComponentId: head }, 'npc');
            });
        });

        stepTo(world, tick, turns, 0);
        // tick 20 → agent fires (once per NPC: the spawned Bolt + the stub droid).
        stepTo(world, tick, turns, 20);
        // A second tick at 20 must NOT re-fire (once per round).
        stepTo(world, tick, turns, 20);
        expect(calls).toHaveLength(2);
        expect(calls.map(c => c.npcEntityId).sort()).toEqual([bolt.id, droid.id].sort());
        expect(calls.every(c => c.round === 0)).toBe(true);

        // Advance to resolution (synchronous) BEFORE the microtask runs.
        expect(() => stepTo(world, tick, turns, 300)).not.toThrow();

        // Let the agent's microtask run — it now lands after the window closed.
        await Promise.resolve();
        expect(lateQueueResult.success).toBe(false);
        expect(lateQueueResult.code).toBe('PLANNING_CLOSED');
    });

    it('emits turn-round-update on both transitions (planning start + resolution) with the spec payload', () => {
        const { world, tick, turns } = buildWorld();
        const updates = [];
        const broadcaster = {
            broadcastTurnUpdate: (payload) => updates.push(payload),
            broadcast: () => {}
        };
        turns.setBroadcaster(broadcaster);

        stepTo(world, tick, turns, 0); // planning start
        stepTo(world, tick, turns, 300); // resolution start

        expect(updates).toHaveLength(2);
        expect(updates[0].phase).toBe('planning');
        expect(updates[1].phase).toBe('resolution');
        for (const u of updates) {
            expect(u).toHaveProperty('roundNumber');
            expect(u).toHaveProperty('currentTick');
            expect(u).toHaveProperty('planningDeadlineTick');
            expect(u).toHaveProperty('actorOrder');
            expect(u).not.toHaveProperty('queues'); // queues ride the full state
        }
    });

    it('state.turns shape matches Appendix A (keys + types + per-entry queue shape)', () => {
        const { world, tick, turns } = buildWorld();
        const entity = Object.values(world.stateEntityController.entities)[0];
        const head = aHeadComponentId(world);

        stepTo(world, tick, turns, 0);
        turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');

        const turnsState = world.getAll().turns;
        expect(turnsState).toEqual(expect.objectContaining({
            roundNumber: expect.any(Number),
            phase: expect.any(String),
            currentTick: expect.any(Number),
            planningDeadlineTick: expect.any(Number),
            actorOrder: expect.any(Array),
            queues: expect.any(Object)
        }));
        expect(typeof turnsState.phase).toBe('string');
        expect(['planning', 'resolution']).toContain(turnsState.phase);

        const actor = turnsState.actorOrder.find(a => a.entityId === entity.id);
        expect(actor).toMatchObject({
            entityId: entity.id,
            initiative: 40,
            queuedCount: 1
        });
        expect(typeof actor.name).toBe('string');

        const entry = turnsState.queues[entity.id][0];
        expect(entry).toEqual(expect.objectContaining({
            queueId: expect.stringMatching(/^q-/),
            actionName: 'selfHeal',
            params: expect.any(Object),
            queuedAtTick: expect.any(Number),
            source: 'player'
        }));
    });

    it('serialize/restore round-trip: pending queue preserved, bookkeeping identical', () => {
        const { world, tick, turns } = buildWorld();
        const entity = Object.values(world.stateEntityController.entities)[0];
        const head = aHeadComponentId(world);

        stepTo(world, tick, turns, 100);
        turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');

        // Serialize mid-round with a pending queue.
        const snapshot = world.serialize();
        expect(snapshot.state).toHaveProperty('turns');
        expect(snapshot.state.turns.roundNumber).toBe(0);
        expect(Object.keys(snapshot.state.turns.queues)).toContain(entity.id);

        // Restore onto a FRESH instance.
        const { world: world2, tick: tick2, turns: turns2 } = buildWorld();
        const restored = world2.restore(snapshot);
        expect(restored.success).toBe(true);

        const q2 = turns2.getQueuedActions(entity.id);
        expect(q2).toHaveLength(1);
        expect(q2[0].actionName).toBe('selfHeal');
        expect(q2[0].queuedAtTick).toBe(100);
        expect(q2[0].queueId).toMatch(/^q-/);
        expect(world2.serialize().state.turns.roundNumber).toBe(0);
    });

    it('TURNS_DISABLED when the tick system is absent (driven world with null tickSystem)', () => {
        // A world built without a tick system: queueing is disabled, no crash.
        const { worldStateController: world } = buildWorldState(null);
        const turns = world.turnSystemController;
        const entity = Object.values(world.stateEntityController.entities)[0];
        const head = world.stateEntityController.entities[entity.id].components.find(c => c.type === 'droidHead').id;

        const q = turns.queueAction(entity.id, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q.success).toBe(false);
        expect(q.code).toBe('TURNS_DISABLED');
    });
});

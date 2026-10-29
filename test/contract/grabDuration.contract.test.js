/**
 * Feature: GRAB duration — CONTRACT test (turn-system driven).
 *
 * The one-shot grab consequence (Movement.move -= 5) is stateless by design, so
 * "durability" (how long the debuff lasts, and whether re-grabbing stacks) must
 * live in the TURN SYSTEM, not the action data. This suite drives the real
 * resolution loop (`TurnSystemController._resolveRound`) across multiple rounds
 * and pins the three behaviors the player asked for:
 *
 *   1. FLAT / RENEWED — a grab's -5 is a FLAT value, not additive. Re-grabbing
 *      a component that is already debuffed restores it to its recorded baseline
 *      and re-applies -5, so the victim stays at (baseline - 5) every round while
 *      the grab is re-executed (never baseline - 10, baseline - 15, ...).
 *   2. DURATION — the debuff lasts one round. If grab is NOT re-executed the
 *      following round, the effect EXPIRES at that round's end and the victim's
 *      move is restored to its baseline.
 *   3. REGRABBLE — after a grab expires, it can be applied again (move drops
 *      by 5 from the restored baseline).
 *
 * The expected values are derived from the SAME data the server reads (the target
 * component's live Movement.move) so the primary assertions are formula-exact,
 * not hard-coded balance numbers. Relative assertions (re-grabbed value === first
 * round value; expired value === baseline) double as drift guards.
 *
 * Driving model (matches TurnSystem.contract.test.js): the world is built with a
 * (non-started) tick system and rounds are advanced by `tick.currentTick = N;
 * turns.onTick()`. NPCs are despawned at boot so the barrier roster is exactly
 * [attacker, victim]; both are regular entities that close the round via
 * `turns.signalPlanComplete(entityId, 'player')` (close+resolution are synchronous
 * in the same call).
 *
 * @module test/contract/grabDuration
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8'));

// Grab contract — asserted once so a registry change fails loudly.
const GRAB = readJson('data/systems/actions.json').grab;

/** Builds a two-droid world: an attacker at (0,0) and a target within grab range. */
function buildTurnWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    // Despawn any boot NPCs so the round-start barrier roster is exactly
    // [attacker, victim] (two regular entities — both close the round manually).
    Object.values(world.stateEntityController.entities)
        .filter((e) => e.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));
    // Pin the onDamage Bernoulli stream (design §7.4) so the world is deterministic
    // even though the grab suite never triggers damage (always-fail -> identical
    // to the pre-feature world).
    if (world.onDamageDropListener) {
        world.onDamageDropListener._randomFn = () => 1;
    }
    const roomId = world.roomsController.getUidByLogicalId('start_room');
    const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    // vx=40 keeps the target strictly inside grab's data-driven range (50).
    world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
    world.stateEntityController.updateEntitySpatial(victimId, { x: 40, y: 0 });
    return { world, tick, turns: subControllers.turnSystemController, attackerId, victimId };
}

/** Advances the round machine to the next round and returns the round state. */
function stepTo(world, tick, turns, targetTick) {
    tick.currentTick = targetTick;
    turns.onTick();
    return turns.getRoundState();
}

/** Closes the current round and returns the post-resolution round state.
 * Signals every entity in the barrier roster (the actorOrder snapshot). NPCs
 * auto-signal as vacuous plans at round start; signaling them again is
 * idempotent (alreadySignaled). Signaling only the roster — not every entry
 * in the entities map — keeps despawned/stale entities out of the barrier. */
function closeRound(turns) {
    const rosterIds = turns.getRoundState().actorOrder.map((a) => a.entityId);
    expect(rosterIds.length, 'the round roster must contain the acting entities').toBeGreaterThan(0);
    for (const entityId of rosterIds) {
        const result = turns.signalPlanComplete(entityId, 'player');
        // The roster is the round-start actor set; every roster member must be
        // signalable. A failure means a setup assumption broke, not the grab
        // duration logic.
        expect(result.success, `signalPlanComplete should succeed for ${entityId} (code=${result.code})`).toBe(true);
    }
    const state = turns.getRoundState();
    expect(state.phase, 'signaling the full roster closes and resolves the round').toBe('resolution');
    return state;
}

/** The victim's droidRollingBall (the moveCore host) component id. */
function ballId(world, entityId) {
    return world.getEntity(entityId).components.find((c) => c.type === 'droidRollingBall').id;
}

const moveOf = (world, compId) => world.getComponentStats(compId)?.Movement?.move;

/** grab params targeting the victim's move component. */
function grabParams(world, victimId) {
    return {
        targetEntityId: victimId,
        targetComponentId: ballId(world, victimId)
    };
}

// Rounds are advanced with a small, strictly increasing tick so each onTick()
// observes the "tick after resolution" invariant (v2 round geometry is tick-agnostic).
const TICK = 10;

describe('Feature: grab duration (flat, renewed, expires — driven through the turn machine)', () => {
    it('re-grab is flat and renewed: move stays (baseline - 5) across rounds, never stacks', () => {
        const { world, tick, turns, attackerId, victimId } = buildTurnWorld();
        const victimBallId = ballId(world, victimId);
        const baseline = moveOf(world, victimBallId);
        expect(baseline, 'the victim should start with a positive move stat').toBeGreaterThan(0);

        // Round 0: enqueue a RECURRING grab, then close the round.
        stepTo(world, tick, turns, 0);
        const queued0 = turns.queueAction(attackerId, 'grab', grabParams(world, victimId), 'player', true);
        expect(queued0.success, 'the grab must be queueable for round 0').toBe(true);
        expect(turns.getRoundState().phase, 'queueing happens during planning').toBe('planning');

        // The recurring grab executes on round 0 resolution -> move = baseline - 5.
        closeRound(turns);
        const round0Move = moveOf(world, victimBallId);
        expect(
            round0Move,
            'after round 0 grab the target move is baseline - 5 (formula-exact from the live stat)'
        ).toBeCloseTo(baseline - 5, 6);

        // Round 1: the recurring grab is auto-queued at round start and re-executed.
        stepTo(world, tick, turns, TICK * 1);
        const q1 = turns.getRoundState().queues[attackerId];
        expect(q1?.length, 'round 1 auto-queues the recurring grab (it is not a one-shot)').toBe(1);
        closeRound(turns);
        const round1Move = moveOf(world, victimBallId);
        expect(
            round1Move,
            'after the round-1 re-grab the move is STILL baseline - 5 (flat, renewed — not baseline - 10)'
        ).toBeCloseTo(baseline - 5, 6);
        expect(
            round1Move,
            'the re-grab must not stack to baseline - 10'
        ).not.toBeCloseTo(baseline - 10, 6);
        expect(
            round1Move,
            'flat across rounds: re-grabbed move equals the first-round move value'
        ).toBeCloseTo(round0Move, 6);

        // Round 2: a third re-grab still yields baseline - 5.
        stepTo(world, tick, turns, TICK * 2);
        closeRound(turns);
        const round2Move = moveOf(world, victimBallId);
        expect(
            round2Move,
            'after round 2 re-grab the move remains baseline - 5 (flat across N rounds)'
        ).toBeCloseTo(baseline - 5, 6);
        expect(
            round2Move,
            'flat across all rounds: every re-grab yields the same value'
        ).toBeCloseTo(round0Move, 6);

        // The recurring plan is still live (it would re-queue in future rounds).
        expect(
            turns.getRoundState().recurring,
            'the recurring grab plan survives the rounds'
        ).not.toEqual({});
    });

    it('one-shot grab expires after 1 round: move restores to baseline when grab is not re-executed', () => {
        const { world, tick, turns, attackerId, victimId } = buildTurnWorld();
        const victimBallId = ballId(world, victimId);
        const baseline = moveOf(world, victimBallId);
        expect(baseline, 'the victim should start with a positive move stat').toBeGreaterThan(0);

        // Round 0: ONE-SHOT grab (recurring=false) -> no re-queue plan.
        stepTo(world, tick, turns, 0);
        turns.queueAction(attackerId, 'grab', grabParams(world, victimId), 'player', false);
        closeRound(turns);
        const round0Move = moveOf(world, victimBallId);
        expect(
            round0Move,
            'after round 0 one-shot grab the target move is baseline - 5'
        ).toBeCloseTo(baseline - 5, 6);
        expect(
            turns.getRoundState().recurring,
            'a one-shot grab records no recurring plan'
        ).toEqual({});

        // Round 1: no grab is queued (one-shot). The debuff should EXPIRE at round-1
        // end and restore the target's move to its baseline.
        stepTo(world, tick, turns, TICK * 1);
        closeRound(turns);
        const round1Move = moveOf(world, victimBallId);
        expect(
            round1Move,
            'after round 1 (no re-grab) the grab expired and the target move was restored to baseline'
        ).toBeCloseTo(baseline, 6);
        expect(
            round1Move,
            'the expired grab must not leave the target debuffed (move !== baseline - 5)'
        ).not.toBeCloseTo(baseline - 5, 6);
    });

    it('after expiration the grab can be re-applied: move drops by 5 from the restored baseline again', () => {
        const { world, tick, turns, attackerId, victimId } = buildTurnWorld();
        const victimBallId = ballId(world, victimId);
        const baselineMove = moveOf(world, victimBallId);
        expect(baselineMove, 'the victim should start with a positive move stat').toBeGreaterThan(0);

        // Round 0: one-shot grab -> baseline - 5.
        stepTo(world, tick, turns, 0);
        turns.queueAction(attackerId, 'grab', grabParams(world, victimId), 'player', false);
        closeRound(turns);
        expect(moveOf(world, victimBallId), 'after round 0 grab the move is baseline - 5').toBeCloseTo(baselineMove - 5, 6);

        // Round 1: no grab -> expires -> baseline (from the prior test's flow).
        stepTo(world, tick, turns, TICK * 1);
        closeRound(turns);
        expect(moveOf(world, victimBallId), 'grab expired, move restored to baseline').toBeCloseTo(baselineMove, 6);

        // Round 2: a FRESH grab re-applies on top of the restored baseline -> baseline - 5.
        stepTo(world, tick, turns, TICK * 2);
        turns.queueAction(attackerId, 'grab', grabParams(world, victimId), 'player', false);
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'after expiration a new grab re-applies the -5 on the restored baseline'
        ).toBeCloseTo(baselineMove - 5, 6);
    });
});

describe('grab duration — registry guard', () => {
    it('grab is still declared in the registry (so queueAction never rejects it)', () => {
        expect(GRAB, 'grab must be declared in data/systems/actions.json').toBeTruthy();
        expect(GRAB.targetingType, 'grab must remain a component-targeting action').toBe('component');
        expect(Number.isFinite(GRAB.range), 'grab must keep a data-driven finite range').toBe(true);
    });
});

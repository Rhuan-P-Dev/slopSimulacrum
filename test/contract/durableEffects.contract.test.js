/**
 * Feature: durable effects (EffectTracker) — CONTRACT tests driven through the
 * real turn machine. Two scenarios the grabDuration suite does not cover:
 *
 *   1. TWO coexisting tracked effects on the SAME trait.stat must undo each effect's
 *      OWN contribution on expiration (commuting restores). The pre-fix engine
 *      restored each effect to its absolute first baseline, so the LAST-iterated
 *      restore clobbered the other live effect's contribution (wrong final value).
 *
 *   2. An Immediate-mode grab (`executeAction`, NOT queued) must track its expiration
 *      against the live round when a round is active (pre-round 1 it is correctly
 *      NOT tracked: applied but permanent). Pre-fix the turn machine only published
 *      the round at resolution, so an immediate grab mid-round was untracked and
 *      could never be reverted.
 *
 * Driving model (matches grabDuration.contract.test.js): the world is built with a
 * (non-started) tick system and rounds are advanced by `tick.currentTick = N;
 * turns.onTick()`. NPCs are despawned at boot so the barrier roster is exactly
 * [attacker, victim]; both close the round manually via `turns.signalPlanComplete`.
 * The onDamage Bernoulli stream is pinned to always-fail for byte determinism.
 *
 * @module test/contract/durableEffects
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

// The live grab registry entry (so our synthetic reducer can be declared the same
// way and the grab's own declared duration (1 round) is the single source of truth).
const GRAB = readJson('data/systems/actions.json').grab;

/** Builds a two-droid world: attacker at (0,0) and a target within grab range. */
function buildTurnWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    // Despawn any boot NPCs so the round-start barrier roster is exactly
    // [attacker, victim] (two regular entities — both close the round manually).
    Object.values(world.stateEntityController.entities)
        .filter((e) => e.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));
    // Pin the onDamage Bernoulli stream (design §7.4) so the world is deterministic
    // even though the grab/reducer deltas are strict decreases. Always-fail ->
    // the drop outcome is identical to a world where the damage rule never fires.
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
        // signalable. A failure means a setup assumption broke, not the effect logic.
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

const liveEffects = (world) => world.effectTracker?.getActiveEffects?.() ?? {};
const activeCount = (world) => Object.keys(liveEffects(world)).length;

// Rounds are advanced with a small, strictly increasing tick so each onTick()
// observes the "tick after resolution" invariant (v2 round geometry is tick-agnostic).
const TICK = 10;

describe('durable effects — two coexisting effects on one stat restore independently', () => {
    it('a live grab and a second tracked reducer coexist, then each expires without clobbering the other', () => {
        const { world, tick, turns, attackerId, victimId } = buildTurnWorld();
        const victimBallId = ballId(world, victimId);
        const baseline = moveOf(world, victimBallId);
        expect(baseline, 'the victim should start with a positive move stat').toBeGreaterThan(0);

        // Inject a SECOND tracked reducer action into the in-memory actionRegistry.
        // It mirrors grab (component-targeting, strength-gated) but drains 3 move
        // and lasts 2 rounds (vs grab's 1). Because the two effects on the SAME
        // stat coexist, each must undo ONLY ITS OWN contribution on expiration.
        const REDUCER = 'testReduceMove';
        world.actionController.actionRegistry[REDUCER] = {
            description: 'Test reducer: target loses 3 of its move for two rounds.',
            targetingType: 'component',
            range: GRAB.range,
            requirements: GRAB.requirements,
            consequences: [
                {
                    type: 'updateComponentStatDelta',
                    target: 'target',
                    params: { trait: 'Movement', stat: 'move', value: -3 },
                    expiresInRounds: 2
                }
            ],
            failureConsequences: []
        };

        // Round 1 (turn system round 1): a one-shot grab -> baseline - 5.
        stepTo(world, tick, turns, 0);
        turns.queueAction(attackerId, 'grab', grabParams(world, victimId), 'player', false);
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'after the round-1 grab the target move is baseline - 5 (formula-exact)'
        ).toBeCloseTo(baseline - 5, 6);
        expect(activeCount(world), 'the grab is tracked: exactly one live effect').toBe(1);

        // Round 2: apply the REDUCER in Immediate mode so the grab and the reducer
        // are simultaneously live. The grab (expiresRound=2) has not yet expired at
        // mid-round, so both effects are live and the move is baseline - 5 - 3.
        stepTo(world, tick, turns, TICK * 1);
        const immediate = world.actionController.executeAction(REDUCER, attackerId, grabParams(world, victimId));
        expect(immediate.success, `the injected reducer should execute in range: ${JSON.stringify(immediate.error)}`).toBe(true);
        expect(
            moveOf(world, victimBallId),
            'both effects live: grab (-5) plus reducer (-3) on the true baseline -> baseline - 8'
        ).toBeCloseTo(baseline - 8, 6);
        expect(activeCount(world), 'both effects are live at the same time').toBe(2);

        // Round-2 close: the grab (expiresRound=2 <= currentRound=2) expires at round
        // end and must undo ONLY ITS -5. The live reducer (-3) must survive, so the
        // move lands on baseline - 3 (true baseline minus the reducer), not on
        // `baseline` (which is what an absolute-baseline restore would produce by
        // clobbering the reducer's contribution).
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'grab expires: its own -5 is removed, leaving the live reducer -> baseline - 3 ' +
            '(an absolute-baseline restore would drop the still-live reducer and land on `baseline`)'
        ).toBeCloseTo(baseline - 3, 6);
        expect(activeCount(world), 'only the longer-lived reducer remains').toBe(1);

        // Round 3: no new effect; the reducer is still live (expiresRound=4 > 3).
        stepTo(world, tick, turns, TICK * 2);
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'the reducer outlives the grab: still baseline - 3 with nothing new applied'
        ).toBeCloseTo(baseline - 3, 6);
        expect(activeCount(world), 'the reducer is still the sole live effect').toBe(1);

        // Round 4: the reducer expires (expiresRound=4 <= currentRound=4) and must
        // undo ONLY ITS -3 -> true baseline. Order-independent (commuting) restores
        // mean the final value is the true baseline, not a polluted residual.
        stepTo(world, tick, turns, TICK * 3);
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'after the reducer expires the move is restored to the TRUE baseline (commuting, ' +
            'order-independent) — not the polluted value a clobbered absolute restore leaves'
        ).toBeCloseTo(baseline, 6);
        expect(activeCount(world), 'no live effects remain after both have expired').toBe(0);
    });
});

describe('durable effects — Immediate-mode (non-queued) grab tracking', () => {
    it('a grab executed before any round is applied but NOT tracked (no active round to anchor its expiration)', () => {
        const { world, tick, turns, attackerId, victimId } = buildTurnWorld();
        const victimBallId = ballId(world, victimId);
        const baseline = moveOf(world, victimBallId);
        expect(baseline, 'the victim should start with a positive move stat').toBeGreaterThan(0);
        expect(world.effectTracker.getCurrentRound(), 'no round has started yet').toBeNull();

        const result = world.actionController.executeAction('grab', attackerId, grabParams(world, victimId));
        expect(result.success, `an immediate in-range grab should succeed: ${JSON.stringify(result.error)}`).toBe(true);
        expect(
            moveOf(world, victimBallId),
            'the pre-round grab still drains the target move by 5 (it is applied, just untracked)'
        ).toBeCloseTo(baseline - 5, 6);
        expect(
            activeCount(world),
            'a pre-round grab is NOT tracked (currentRound is null): no effect record is made, ' +
            'per the documented "applied but not reverted" behavior'
        ).toBe(0);

        // A later round must NOT restore the untracked grab: advance one full round
        // and the move must stay debuffed (the effect was never registered to expire).
        stepTo(world, tick, turns, 0);
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'an untracked grab survives an entire round untouched (it has no expiration to revert it)'
        ).toBeCloseTo(baseline - 5, 6);
        expect(activeCount(world), 'no live effect is recorded even after a round').toBe(0);
    });

    it('a grab executed during a live round is tracked against the live round and expires after one round', () => {
        const { world, tick, turns, attackerId, victimId } = buildTurnWorld();
        const victimBallId = ballId(world, victimId);
        const baseline = moveOf(world, victimBallId);
        expect(baseline, 'the victim should start with a positive move stat').toBeGreaterThan(0);

        // Open round 1 (turn system round 1). The round is live during planning; an
        // Immediate-mode grab fired in this window must be tracked against round 1
        // (expiresRound = 1 + grab.expiresInRounds = 2).
        stepTo(world, tick, turns, 0);
        const result = world.actionController.executeAction('grab', attackerId, grabParams(world, victimId));
        expect(result.success, `an immediate grab mid-round should succeed: ${JSON.stringify(result.error)}`).toBe(true);
        expect(
            moveOf(world, victimBallId),
            'the mid-round grab drains the target move by 5'
        ).toBeCloseTo(baseline - 5, 6);
        expect(
            activeCount(world),
            'the mid-round grab IS tracked when a round is active (one live effect)'
        ).toBe(1);
        expect(
            world.effectTracker.getCurrentRound(),
            'a round is live during planning (the grab expiration is anchored to it)'
        ).not.toBeNull();

        // Round-1 close: the grab (expiresRound=2) is still > currentRound=1, so it
        // survives. move stays baseline - 5.
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'the grab outlasts the round it was applied in'
        ).toBeCloseTo(baseline - 5, 6);
        expect(activeCount(world), 'the grab is still live after round 1').toBe(1);

        // Round 2: the grab expires at round-2 end (expiresRound=2 <= currentRound=2)
        // and reverts the target move to its true baseline.
        stepTo(world, tick, turns, TICK * 1);
        closeRound(turns);
        expect(
            moveOf(world, victimBallId),
            'after the mid-round grab expires, the move is restored to the true baseline'
        ).toBeCloseTo(baseline, 6);
        expect(activeCount(world), 'no live effect remains after the grab expired').toBe(0);
    });
});

describe('durable effects — registry guard', () => {
    it('grab still declares a positive expiresInRounds (so the engine has something to track)', () => {
        const consequence = GRAB.consequences.find(
            (c) => c.type === 'updateComponentStatDelta' && c.params.trait === 'Movement'
        );
        expect(consequence, 'grab must carry the durable stat consequence').toBeTruthy();
        expect(
            typeof GRAB.consequences[0].expiresInRounds === 'number' && GRAB.consequences[0].expiresInRounds > 0,
            'grab must declare a positive expiresInRounds'
        ).toBe(true);
    });
});

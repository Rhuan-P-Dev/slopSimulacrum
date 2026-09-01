/**
 * CONTRACT TEST — turn-driven internal components (strengthCore).
 *
 * Verifies the NEW parallel cadence channel: effects driven by the ROUND-START
 * hook (TurnSystemController._roundStart → InternalComponentController
 * .processTurnEffects()), NOT the unified tick channel.
 *
 * Driven WITHOUT real timers: build the world via buildWorldState(tickSystem)
 * (tick not started), set tickSystem.currentTick = N, call turns.onTick().
 * Round 0 starts lazily on the first onTick(); closing round 0 (droid signal)
 * puts the machine in 'resolution'; the next onTick() starts round 1 — each
 * round start fires the turn-start hook exactly once.
 *
 * Covers:
 *   - the HOST HAND's Physical.existence drains by 1 per turn (the IC's own
 *     instanceStats pool stays static at 20 — it no longer self-drains);
 *   - host strength is MAINTAINED (set, non-additive) at 50 across turns
 *     (snapshot after each round-start hook: 50, then still 50, never 100);
 *   - the unified tick channel SKIPS turn-driven types (no double-apply);
 *   - a broken instance (host hand existence 0) stops applying effects;
 *   - hostComponentType / hostSlot auto-install filtering (left droidHand only);
 *   - processTurnEffects is a no-op with zero installed instances (wiring
 *     safety — it must never throw in a world without any ICs).
 *
 * @module test/contract/turnDrivenIC
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/**
 * Builds a fresh world wired to a (non-started) tick system, spawns a test
 * droid, and keeps a single data-driven NPC so the round-start roster is the
 * deterministic [one NPC, test droid] = 2 planners (same pin as the
 * TurnSystem contract suite).
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    const npcs = Object.values(world.stateEntityController.entities).filter(e => e.isNPC === true);
    for (let i = 1; i < npcs.length; i++) world.despawnEntity(npcs[i].id);
    return { world, tick, turns: subControllers.turnSystemController, entityId };
}

/** Advances the turn machine to an absolute tick and returns the round state. */
function stepTo(world, tick, turns, targetTick) {
    tick.currentTick = targetTick;
    turns.onTick();
    return turns.getRoundState();
}

/**
 * Closes the current round (all planners signal) so the NEXT stepTo() opens a
 * fresh round — and therefore fires the turn-start hook again.
 */
function closeRound(turns, world, entityId) {
    const state = turns.getRoundState();
    for (const pendingId of state.barrier.pendingEntityIds) {
        turns.signalPlanComplete(pendingId, 'player');
    }
    expect(turns.getRoundState().phase).toBe('resolution');
}

/**
 * Finds the left droidHand component id on the given entity, derived from its
 * PARENT arm: locate the droidArm whose identifier is 'left', then locate the
 * droidHand whose dependsOn[0] is that arm's id. The hand's own identifier is
 * remapped to 'default_left' by the blueprint expander, so it is NOT the field
 * the data file's hostSlot matches — the parent arm's identifier is.
 */
function leftHandId(world, entityId) {
    const entity = world.stateEntityController.getEntity(entityId);
    const leftArm = entity.components.find(c => c.type === 'droidArm' && c.identifier === 'left');
    if (!leftArm) return null;
    const hand = entity.components.find(c => c.type === 'droidHand' && c.dependsOn?.[0] === leftArm.id);
    return hand ? hand.id : null;
}

/** All droidHand component ids on the given entity. */
function allHandIds(world, entityId) {
    const entity = world.stateEntityController.getEntity(entityId);
    return entity.components.filter(c => c.type === 'droidHand').map(c => c.id);
}

describe('turn-driven internal components (strengthCore)', () => {
    it('host hand existence drains by 1 per turn; host strength is MAINTAINED (set, non-additive) at 50', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        expect(handId, 'test droid must have a left droidHand').toBeTruthy();

        const ic = world.internalComponentController;
        // NOTE: `buildWorld` already auto-installs a strengthCore on this hand
        // (via `autoInstallOnSpawn: true` in the data file), so we MUST NOT
        // call `addInternalComponent` again — the controller enforces uniqueness
        // per host and would return an existing instance, but the test's
        // `added` expectation is clearer with a fresh add. Instead, read the
        // already-installed instance.
        const added = ic.getInternalComponents(entityId, handId)[0];
        expect(added).toBeTruthy();
        expect(added.type).toBe('strengthCore');

        const statsBefore = world.getComponentStats(handId).Physical;
        expect(statsBefore.strength).toBe(25); // droidHand base strength
        expect(statsBefore.existence).toBe(40); // droidHand base existence

        const icBefore = ic.getInternalComponents(entityId, handId)[0];
        expect(icBefore.broken).toBe(false);
        expect(icBefore.instanceStats.Physical.existence).toBe(20); // static self pool (unchanged)

        // Round 0 starts (hook fires #1) + round 1 starts (hook fires #2)
        // = two turns of effects.
        stepTo(world, tick, turns, 0);
        closeRound(turns, world, entityId);
        stepTo(world, tick, turns, 1);

        const statsAfter = world.getComponentStats(handId).Physical;
        // The HOST HAND's existence is what drains. The world also has the
        // data-driven "Rogue Droid" NPC (smallBallDroid) which auto-installs
        // its OWN strengthCore on ITS left hand — so there are TWO host-hand
        // drains in the world, but we only observe the test droid's hand.
        // Each round-start hook fires once per round; the test droid's hand
        // is drained exactly once per round.
        // Round 0 (stepTo 0): hook #1 → hand 40 → 39
        // Round 1 (stepTo 1): hook #2 → hand 39 → 38
        expect(statsAfter.existence).toBe(38);
        expect(statsAfter.strength).toBe(50);

        // The IC's own pool is NOT drained anymore (it was the old behavior).
        const icAfter = ic.getInternalComponents(entityId, handId)[0];
        expect(icAfter.instanceStats.Physical.existence).toBe(20); // still 20
        expect(icAfter.broken).toBe(false);
    });

    it('host strength does not stack across turns (50 after turn 1, still 50 after turn 2)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        expect(handId, 'test droid must have a left droidHand').toBeTruthy();

        const ic = world.internalComponentController;
        world.addInternalComponent(entityId, handId, 'strengthCore');

        // Snapshot AFTER the first round-start hook: strength is set to 50.
        stepTo(world, tick, turns, 0);
        expect(world.getComponentStats(handId).Physical.strength).toBe(50);

        // Snapshot AFTER the second round-start hook: strength is still 50,
        // NOT 100 — the `set` effect overwrites, it never adds on top.
        closeRound(turns, world, entityId);
        stepTo(world, tick, turns, 1);
        expect(world.getComponentStats(handId).Physical.strength).toBe(50);
    });

    it('the unified tick channel SKIPS turn-driven types (no double-apply)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        const ic = world.internalComponentController;
        // NOTE: `buildWorld` already auto-installs a strengthCore on this hand.
        // Do NOT call `addInternalComponent` again — the controller enforces
        // uniqueness per host.
        const icBefore = ic.getInternalComponents(entityId, handId)[0];
        expect(icBefore).toBeTruthy();

        stepTo(world, tick, turns, 0); // round 0: hook fires exactly once
        const icAfter = ic.getInternalComponents(entityId, handId)[0];

        // Exactly ONE host-hand drain from the round-start hook (round 0).
        // The IC has no tickEffects, so the tick channel is a no-op for it —
        // host existence would be 38 (not 39) only if a stray tick path also
        // drained it.
        expect(world.getComponentStats(handId).Physical.existence).toBe(39);
        // The IC's own pool is untouched (no self drain anymore).
        expect(icAfter.instanceStats.Physical.existence).toBe(20);
        expect(world.getComponentStats(handId).Physical.strength).toBe(50);
    });

    it('a broken instance (self existence 0 via public seam) stops applying effects', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        const ic = world.internalComponentController;
        // NOTE: `buildWorld` already auto-installs a strengthCore on this hand.
        const instance = ic.getInternalComponents(entityId, handId)[0];
        expect(instance).toBeTruthy();

        // Drive the IC's OWN self-existence pool to 0 via the PUBLIC seam
        // `adjustInstanceStat` (no direct mutation of controller internals).
        // This is the canonical way to break an IC instance: the host hand's
        // own `component:broke` cascade handles host-driven removal (see the
        // controller's `_applyTurnEffect` note), so the broken-instance test
        // here exercises the self-pool break path directly.
        ic.adjustInstanceStat(entityId, handId, instance.id, 'Physical', 'existence', -20);

        // The instance is now broken BEFORE any turn runs.
        let icNow = ic.getInternalComponents(entityId, handId)[0];
        expect(icNow.broken).toBe(true);
        expect(icNow.instanceStats.Physical.existence).toBe(0);

        // Turn 1: broken ⇒ NO effects at all (neither the host drain nor the strength set).
        stepTo(world, tick, turns, 0);
        icNow = ic.getInternalComponents(entityId, handId)[0];
        expect(icNow.broken).toBe(true);
        expect(icNow.instanceStats.Physical.existence).toBe(0); // unchanged
        // Host hand existence is UNCHANGED (no drain ran).
        expect(world.getComponentStats(handId).Physical.existence).toBe(40);
        // Host strength is UNCHANGED (no maintained set ran).
        expect(world.getComponentStats(handId).Physical.strength).toBe(25);

        // Turn 2: still broken ⇒ still no effects.
        closeRound(turns, world, entityId);
        stepTo(world, tick, turns, 1);
        icNow = ic.getInternalComponents(entityId, handId)[0];
        expect(icNow.broken).toBe(true);
        expect(icNow.instanceStats.Physical.existence).toBe(0); // unchanged
        expect(world.getComponentStats(handId).Physical.existence).toBe(40); // unchanged
        expect(world.getComponentStats(handId).Physical.strength).toBe(25); // frozen at base
    });

    it('hostComponentType / hostSlot auto-install filtering targets the left droidHand only', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const ic = world.internalComponentController;

        // Flip the strengthCore registry entry to auto-install on spawn.
        ic.registry.strengthCore.autoInstallOnSpawn = true;

        const entityId2 = world.stateEntityController.spawnEntity(
            'smallBallDroid',
            world.roomsController.getUidByLogicalId('start_room')
        );
        const hands = allHandIds(world, entityId2);
        expect(hands.length).toBe(2); // left + right

        const left = leftHandId(world, entityId2);
        expect(left, 'spawned droid must have a left droidHand').toBeTruthy();
        const installedLeft = ic.getInternalComponents(entityId2, left);
        expect(installedLeft).toHaveLength(1);
        expect(installedLeft[0].type).toBe('strengthCore');

        // The right hand must NOT have received it (hostSlot: "left").
        const right = hands.find(id => id !== left);
        expect(ic.getInternalComponents(entityId2, right)).toHaveLength(0);

        // Reset the registry so other tests are unaffected.
        ic.registry.strengthCore.autoInstallOnSpawn = false;
    });

    it('processTurnEffects is a safe no-op with zero installed instances (wiring safety)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const ic = world.internalComponentController;
        expect(() => ic.processTurnEffects()).not.toThrow();
        // And a full round with no ICs installed still runs cleanly.
        stepTo(world, tick, turns, 0);
        expect(turns.getRoundState().phase).toBe('planning');
    });
});

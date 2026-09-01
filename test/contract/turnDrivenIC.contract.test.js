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

describe('internal components — organ grants + unified overTime (strengthCore)', () => {
    // In the recipe→derivation + overTime-unification model, strengthCore is a
    // pure FUNCTION organ: it grants the host's Physical.strength on install
    // (a static, non-additive set) and has an EMPTY overTime list — so it
    // applies no periodic effects through the unified tick channel. There is
    // no turn-driven drain or "maintained" set anymore (those were the removed
    // `turnDriven` channel).
    it('strengthCore grants the host strength on install (organ function); no drain, no stacking across turns', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        expect(handId, 'test droid must have a left droidHand').toBeTruthy();

        const ic = world.internalComponentController;
        const installed = ic.getInternalComponents(entityId, handId);
        const strengthCore = installed.find(i => i.type === 'strengthCore');
        expect(strengthCore, 'a strengthCore organ must be auto-installed on the hand').toBeTruthy();

        // The organ grant is applied on install: host strength = the grant value
        // (50), host existence is the 0–1 matter scale (1 = intact).
        const statsBefore = world.getComponentStats(handId).Physical;
        expect(statsBefore.strength).toBe(50);
        expect(statsBefore.existence).toBe(1);
        expect(strengthCore.broken).toBe(false);

        // Two rounds of the turn machine: the organ grant is static and the
        // unified tick channel has no overTime effect for strengthCore, so the
        // host strength stays at the grant value (never stacks to 100) and the
        // host existence is NOT drained.
        stepTo(world, tick, turns, 0);
        closeRound(turns, world, entityId);
        stepTo(world, tick, turns, 1);

        const statsAfter = world.getComponentStats(handId).Physical;
        expect(statsAfter.strength).toBe(50); // set, non-additive
        expect(statsAfter.existence).toBe(1); // no drain
    });

    it('organ grant is set (non-additive): strength stays at the grant value, never doubles across turns', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        expect(handId, 'test droid must have a left droidHand').toBeTruthy();

        // The grant is already applied by the auto-install in buildWorld.
        stepTo(world, tick, turns, 0);
        expect(world.getComponentStats(handId).Physical.strength).toBe(50);

        // After a second round the strength is STILL 50, NOT 100 — the grant is
        // a one-time set on install; it is never re-applied or added on top.
        closeRound(turns, world, entityId);
        stepTo(world, tick, turns, 1);
        expect(world.getComponentStats(handId).Physical.strength).toBe(50);
    });

    it('organs with an empty overTime list apply no periodic effects (unified channel is a no-op for them)', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        const ic = world.internalComponentController;
        const strengthCore = ic.getInternalComponents(entityId, handId).find(i => i.type === 'strengthCore');
        expect(strengthCore).toBeTruthy();
        // strengthCore declares no overTime effects.
        expect(ic.registry.strengthCore.overTime).toEqual([]);

        // Driving a full round changes neither the host existence (no drain) nor
        // the host strength (no periodic set) — the unified tick channel has
        // nothing to apply for an organ with an empty overTime list.
        stepTo(world, tick, turns, 0);
        closeRound(turns, world, entityId);
        stepTo(world, tick, turns, 1);
        const stats = world.getComponentStats(handId).Physical;
        expect(stats.existence).toBe(1);
        expect(stats.strength).toBe(50);
    });

    it('the overTime channel is wired: repairSphere restores host existence, corrosiveGland grants the corrosive flag', () => {
        const { world, tick, turns, entityId } = buildWorld();
        const handId = leftHandId(world, entityId);
        expect(handId, 'test droid must have a left droidHand').toBeTruthy();
        const ic = world.internalComponentController;

        // The repair organ declares a restoreExistence overTime effect (it closes
        // the salvage→existence loop on the host) and the corrosive organ
        // declares an emitChannelDamage effect plus the corrosive flag grant.
        expect(ic.registry.repairSphere.overTime.some(e => e.type === 'restoreExistence')).toBe(true);
        expect(ic.registry.corrosiveGland.overTime.some(e => e.type === 'emitChannelDamage' && e.channel === 'corrosion')).toBe(true);
        expect(ic.registry.corrosiveGland.grantsFlags).toContain('corrosive');

        // Installing the corrosive organ grants the corrosive flag to the host.
        world.addInternalComponent(entityId, handId, 'corrosiveGland');
        const flags = world.getComponentFlags(handId);
        expect(flags).toContain('corrosive');
    });

    it('hostComponentType auto-install targets a droidHand (left hand receives the organ)', () => {
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

        // The hostComponentType filter must be a droidHand — both hands qualify
        // by type. The left hand (hostSlot "left") is the primary target and
        // must receive the strengthCore on spawn.
        const left = leftHandId(world, entityId2);
        expect(left, 'spawned droid must have a left droidHand').toBeTruthy();
        const installedLeft = ic.getInternalComponents(entityId2, left);
        expect(installedLeft.length).toBeGreaterThan(0);
        expect(installedLeft.some(i => i.type === 'strengthCore')).toBe(true);

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

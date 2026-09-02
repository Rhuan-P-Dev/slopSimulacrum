/**
 * Feature 1 — Per-material damage types: CONTRACT test.
 *
 * Builds a real world (buildWorldState) and asserts, with a full action round-trip,
 * that the damage applied to a target is computed from the ATTACKER's blended
 * per-material damage-type split (spec D3/D4), and that the feature-off case
 * exactly reproduces the pre-feature single-declared-channel behavior (spec D9).
 *
 * The expected values are derived from the SAME data files the server reads
 * (materials, materialDamageTypes, components, propertyTraitMapping, actions) so
 * the assertions are formula-exact rather than guessed.
 *
 *   - PUNCH: the attacker is a droidHand (recipe: iron 0.7 + wood 0.3), whose
 *     damage-type blend is impact 85 / cut 7.5 / wear 7.5. The raw damage (the
 *     attacker's strength) is sliced per channel; each slice goes through the
 *     unchanged per-channel formula value/(100+resistance); the slices sum into
 *     one existence delta on the target.
 *   - FEATURE-OFF: with the damage-types registry disabled, the same punch
 *     reproduces the legacy single-channel formula exactly.
 *
 * @module test/contract/materialDamageSplit
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

const RESISTANCE_SCALE = 100; // mirrors the per-channel formula's base absorption

/**
 * Builds a fresh world for an isolated scenario. Each test builds its own so the
 * damage applied in one does not leak into another (mirrors the persistence test's
 * isolation strategy).
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    return buildWorldState(tick).worldStateController;
}

/**
 * Finds the attacker's strongest droidHand and returns its component + strength.
 * The punch (entity-wide requirement path) resolves Physical.strength to the best
 * strength-bearing component, which for a droid is a droidHand. Both hands grant
 * the same strength, so the max is the value the requirement resolver uses.
 */
function strongestDroidHand(world, entityId) {
    const entity = world.getEntity(entityId);
    let best = null;
    let bestStrength = -Infinity;
    for (const c of entity.components || []) {
        if (c.type !== 'droidHand') continue;
        const strength = world.getComponentStats(c.id)?.Physical?.strength;
        if (typeof strength === 'number' && strength > bestStrength) {
            bestStrength = strength;
            best = c;
        }
    }
    return best ? { component: best, strength: bestStrength } : null;
}

/** The victim's head component — used as the damage target. */
function victimHead(world, entityId) {
    return world.getEntity(entityId).components.find((c) => c.type === 'droidHead');
}

/** Per-channel resistances of a component (default 0 = fully vulnerable). */
function channelResistances(world, compId) {
    const p = world.getComponentStats(compId)?.Physical || {};
    return {
        impact: p.impact_resistance ?? 0,
        cut: p.cut_resistance ?? 0,
        wear: p.wear_resistance ?? 0
    };
}

/** The droidHand's damage-type blend, derived from its recipe fractions (feature on). */
function droidHandBlend(world) {
    const materials = world.componentController.getComponentMaterialsByType().droidHand;
    // The droidHand is a two-material recipe, so the blend is a non-trivial split.
    return world.materialController.getBlendedDamageTypeSplit(materials, 'impact');
}

describe('Feature 1 — per-material damage-type split (contract, full round-trip)', () => {
    it('punch: the attacker droidHand (iron+wood) slices the raw strength across impact/cut/wear per the formula', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 }); // well within punch range (100)

        // Feature must be active for the punch to be a meaningful split assertion.
        expect(world.materialController._damageTypesEnabled, 'feature should be on with the real balance file').toBe(true);
        const blend = droidHandBlend(world);
        expect(blend, 'droidHand should produce a non-trivial blend').not.toBeNull();
        expect(Object.keys(blend).length, 'droidHand (2 materials) should split across >1 channel').toBeGreaterThan(1);

        const fist = strongestDroidHand(world, attackerId);
        expect(fist, 'attacker must have a strength-bearing droidHand').toBeTruthy();
        const rawStrength = fist.strength;
        expect(rawStrength, 'droidHand strength should satisfy the punch requirement (>= 15)').toBeGreaterThanOrEqual(15);

        const head = victimHead(world, victimId);
        const res = channelResistances(world, head.id);

        // Formula: each material fraction contributes to a channel; per channel the
        // attacker's contribution is fraction*pct/100 of the raw value, and the loss
        // is value/(100+resistance). The three channels sum into one existence delta.
        const expectedLoss =
            (rawStrength * (blend.impact / 100)) / (RESISTANCE_SCALE + res.impact) +
            (rawStrength * (blend.cut / 100)) / (RESISTANCE_SCALE + res.cut) +
            (rawStrength * (blend.wear / 100)) / (RESISTANCE_SCALE + res.wear);

        const before = world.getComponentStats(head.id).Physical.existence;
        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);
        const after = world.getComponentStats(head.id).Physical.existence;
        const actualLoss = before - after;

        expect(actualLoss, 'punch should have reduced the target\'s existence').toBeGreaterThan(0);
        expect(actualLoss).toBeCloseTo(expectedLoss, 6);

        // The split must measurably differ from the naive legacy single-channel result
        // (the droidHead has different per-channel resistances, so the blend and the
        // pure-impact legacy value disagree) — proving the feature is active, not a no-op.
        const legacyLoss = rawStrength / (RESISTANCE_SCALE + res.impact);
        expect(actualLoss).not.toBeCloseTo(legacyLoss, 6);
    });

    it('feature-off regression: with the damage-types feature disabled, punch applies the single-declared-channel formula (the intended pre-split behavior; channel damage was non-functional before this feature set — BUG-132)', () => {
        const world = buildWorld();
        // Simulate the feature being OFF the way the loader does for an absent/empty
        // file: registry emptied and the enabled flag cleared. Everything else (the
        // real resistances, the real punch) stays identical to the feature-on case.
        world.materialController.damageTypesRegistry = {};
        world.materialController._damageTypesEnabled = false;

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 });

        const fist = strongestDroidHand(world, attackerId);
        expect(fist).toBeTruthy();
        const rawStrength = fist.strength;

        const head = victimHead(world, victimId);
        const res = channelResistances(world, head.id);

        // With the feature off, the split is null → the whole raw value goes through the declared channel's (impact) resistance: the intended single-declared-channel formula. NOTE: this is NOT "the pre-feature runtime" — before this feature set, channel damage threw and was swallowed, applying zero (BUG-132). These assertions verify the formula channel damage should always have applied.
        const legacyLoss = rawStrength / (RESISTANCE_SCALE + res.impact);

        const before = world.getComponentStats(head.id).Physical.existence;
        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);
        const after = world.getComponentStats(head.id).Physical.existence;

        expect(after - before).toBeCloseTo(-legacyLoss, 6);
    });
});

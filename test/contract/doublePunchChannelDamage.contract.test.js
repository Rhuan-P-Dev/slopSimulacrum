/**
 * BUG-133 — Two-fist droid punch channel damage: CONTRACT test.
 *
 * The two-fist case is the ONLY combat path routed through the multi-attacker
 * consequence builder (executeMultiAttacker). Before this fix, that builder was
 * written for the legacy stat-delta model and silently dropped the `channel`
 * field of the modern channel-damage model, causing both defects that zeroed
 * the damage: (1) the channel was lost, and (2) the value was negative (clamped
 * to 0 by channelLossFromResistance).
 *
 * This test builds a real world, spawns a droid with two droidHand fists, and
 * executes 'droid punch' with BOTH fist componentIds (role 'source') + a
 * targetComponentId — the exact routing condition that triggers
 * executeMultiAttacker (attackerComponentIds.length > 1 && targetComponentId).
 *
 * The expected values are derived from the SAME data files the server reads
 * (materials, materialDamageTypes, components, propertyTraitMapping, actions)
 * so the assertions are formula-exact rather than guessed. The synergy
 * multiplier is read from the action result itself (not hardcoded).
 *
 * @module test/contract/doublePunchChannelDamage
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { RESISTANCE_SCALE, channelLossFromResistance } from '../../src/utils/channelLoss.js';

/**
 * Builds a fresh world for an isolated scenario.
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    return buildWorldState(tick).worldStateController;
}

/**
 * Finds all droidHand components on the attacker.
 */
function droidHands(world, entityId) {
    const entity = world.getEntity(entityId);
    return (entity.components || []).filter(c => c.type === 'droidHand');
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
    return world.materialController.getBlendedDamageTypeSplit(materials, 'impact');
}

describe('BUG-133 — two-fist punch channel damage (contract, full round-trip)', () => {
    it('two-fist punch: both fists deal synergy-scaled channel damage (formula-exact)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 }); // well within punch range (100)

        // Feature must be active for the punch to produce a meaningful split assertion.
        expect(world.materialController.isDamageTypesEnabled(), 'feature should be on with the real balance file').toBe(true);
        const blend = droidHandBlend(world);
        expect(blend, 'droidHand should produce a non-trivial blend').not.toBeNull();
        expect(Object.keys(blend).length, 'droidHand (2 materials) should split across >1 channel').toBeGreaterThan(1);

        // Find both fists (the multi-attacker path requires > 1 source component).
        const fists = droidHands(world, attackerId);
        expect(fists.length, 'attacker must have two droidHands for the multi-attacker path').toBe(2);

        // Get each fist's strength (should be identical for two droidHands).
        const strengths = fists.map(f => world.getComponentStats(f.id)?.Physical?.strength);
        expect(strengths[0], 'left fist strength should be defined').toBeTypeOf('number');
        expect(strengths[1], 'right fist strength should be defined').toBeTypeOf('number');

        const head = victimHead(world, victimId);
        const res = channelResistances(world, head.id);

        // Execute the multi-attacker punch: both fists as 'source', victim head as target.
        const before = world.getComponentStats(head.id).Physical.existence;
        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id,
            componentIds: fists.map(f => ({ componentId: f.id, role: 'source' }))
        });

        // (c) Top-level action success.
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // Synergy must have been computed (two same-type source components, minCount 2).
        const synergyMult = result.synergy?.synergyMultiplier ?? 1.0;
        expect(synergyMult, 'synergy multiplier should exceed 1 for two cooperating fists').toBeGreaterThan(1.0);

        // (a) Formula-exact loss: per-attacker the raw value is synergy-scaled, then
        // sliced by the attacker's blend across channels; each slice goes through
        // value/(100+resistance). Both per-attacker losses sum into the total.
        // Expected loss per attacker, derived from the SAME single source of truth the
        // handler uses: channelLossFromResistance over each channel's resistance. The raw
        // value is synergy-scaled, sliced by the attacker's material blend across channels
        // (a percentage on the 0-100 RESISTANCE_SCALE), and each slice run through the
        // per-channel loss ratio — bit-identical to the handler's math, no re-derivation.
        const expectedLossPerAttacker = (s) =>
            channelLossFromResistance(s * synergyMult * (blend.impact / RESISTANCE_SCALE), res.impact) +
            channelLossFromResistance(s * synergyMult * (blend.cut / RESISTANCE_SCALE), res.cut) +
            channelLossFromResistance(s * synergyMult * (blend.wear / RESISTANCE_SCALE), res.wear);

        const totalExpectedLoss = expectedLossPerAttacker(strengths[0]) + expectedLossPerAttacker(strengths[1]);

        const after = world.getComponentStats(head.id).Physical.existence;
        const actualLoss = before - after;

        expect(actualLoss, 'two-fist punch should have reduced the target\'s existence').toBeGreaterThan(0);
        expect(actualLoss).toBeCloseTo(totalExpectedLoss, 6);

        // (b) Both per-attacker damageComponent results are success with channel 'impact'.
        const damageResults = result.results.filter(r => r.type === 'damageComponent' && r.success);
        expect(damageResults.length, 'both per-attacker damageComponent results should be present and successful').toBe(2);
        for (const r of damageResults) {
            expect(r.data, 'each damage result should carry a data object').toBeTruthy();
            expect(r.data.channel, 'damage result should carry the channel').toBe('impact');
            expect(r.data.existenceLoss, 'damage result should report a positive existenceLoss').toBeGreaterThan(0);
        }
    });

    it('two-fist punch: no chunks dropped (propagateParams is false on the multi-attacker path — spec D11)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 });

        const fists = droidHands(world, attackerId);
        expect(fists.length, 'attacker must have two droidHands for the multi-attacker path').toBe(2);

        const head = victimHead(world, victimId);

        // Baseline: the count of ground items BEFORE the punch. A fresh world has none,
        // but capturing the baseline keeps the "no new items" assertion robust to any
        // ambient items a fixture might have placed.
        const beforeGroundCount = Object.keys(world.getDroppedItems()).length;

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id,
            componentIds: fists.map(f => ({ componentId: f.id, role: 'source' }))
        });

        expect(result.success).toBe(true);

        // One dropMaterialChunk consequence runs per attacker (the multi-attacker path
        // passes each consequence through per attacker), so exactly one drop result per fist.
        const dropResults = result.results.filter(r => r.type === 'dropMaterialChunk');
        expect(dropResults.length, 'one dropMaterialChunk result should run per attacker').toBe(2);

        // The drop handler's only damage input is the published channel loss, which the
        // multi-attacker path never propagates (propagateParams: false). Assert it
        // UNCONDITIONALLY reports zero dropped chunks for every per-attacker drop result.
        // (This is the assertion that was previously vacuous: it guarded on the wrong
        // field name, `chunksDropped`, which the handler never returns — it returns
        // `droppedChunks`.)
        for (const r of dropResults) {
            expect(r.data, 'each drop result should carry a data object').toBeTruthy();
            expect(r.data.droppedChunks, 'no chunks should be dropped on the multi-attacker path (spec D11)').toBe(0);
        }

        // Real D11 check: no new ground items appeared after the punch (the chunk drop
        // was a no-op because no published loss reached the drop handler).
        const afterGroundCount = Object.keys(world.getDroppedItems()).length;
        expect(afterGroundCount, 'no new ground items should appear after a multi-attacker punch (spec D11)')
            .toBe(beforeGroundCount);
    });
});

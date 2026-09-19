/**
 * CONTRACT TEST — the M1 player droid (data-driven blueprint + loadout).
 *
 * Verifies the M1 feature end-to-end through the PUBLIC facade only:
 *   - the blueprint expands to exactly 23 components with the documented
 *     per-type counts and the 3-toes-per-leg / 3-fingers-per-hand topology;
 *   - the recipe-declared organs are auto-installed through the install
 *     filters (coalGenerator on the body, thinkCore on the head, moveCore on
 *     every leg, strengthCore+precisionCore on the hand) and their grants
 *     land on the host components — including the strengthCore 120 override
 *     that clears the T1 (gate 117) hold-out;
 *   - the data/world.json initial coal loadout applies on spawn (10 coal in
 *     the body, T1 with 1 knife projectile in the hand, 5 knives on the
 *     frontal-left leg);
 *   - the optional initial-spawn `count` multiplicity is honored, and an
 *     entry WITHOUT `count` adds exactly one item (backward compatibility).
 *
 * No timers are started; the world is built with a (non-started) tick system
 * so the IC registry is fully validated at boot.
 *
 * @module test/contract/m1Droid
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/** Builds a fresh world and spawns the M1 player droid. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('m1Droid', startRoomId);
    return { world, tick, entityId };
}

/** Counts of the given entity's components, keyed by component type. */
function countsByType(entity) {
    const counts = {};
    for (const c of entity.components) counts[c.type] = (counts[c.type] ?? 0) + 1;
    return counts;
}

describe('M1 droid — blueprint topology', () => {
    it('expands to exactly 23 components with the documented per-type counts', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);

        expect(entity.components.length).toBe(23);
        expect(countsByType(entity)).toEqual({
            m1CentralBody: 1,
            m1Head: 1,
            m1Leg: 4,
            m1Toe: 12,
            m1ArticulatedHand: 1,
            m1Finger: 3,
            m1Gun: 1,
        });
    });

    it('each leg carries exactly 3 toes and the hand carries exactly 3 fingers (dependsOn topology)', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);

        const legs = entity.components.filter(c => c.type === 'm1Leg');
        expect(legs.length).toBe(4);
        for (const leg of legs) {
            const toes = entity.components.filter(
                c => c.type === 'm1Toe' && c.dependsOn?.[0] === leg.id
            );
            expect(toes.length, `leg ${leg.identifier} must have 3 toes`).toBe(3);
        }

        const hands = entity.components.filter(c => c.type === 'm1ArticulatedHand');
        expect(hands.length).toBe(1);
        const fingers = entity.components.filter(
            c => c.type === 'm1Finger' && c.dependsOn?.[0] === hands[0].id
        );
        expect(fingers.length).toBe(3);
    });
});

describe('M1 droid — organ install filters + grants', () => {
    it('auto-installs the recipe-declared organs through the install filters', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);
        const ic = world.internalComponentController;

        const body = entity.components.find(c => c.type === 'm1CentralBody');
        const head = entity.components.find(c => c.type === 'm1Head');
        const hand = entity.components.find(c => c.type === 'm1ArticulatedHand');
        const legs = entity.components.filter(c => c.type === 'm1Leg');

        expect(ic.getInternalComponents(entityId, body.id).some(i => i.type === 'coalGenerator')).toBe(true);
        expect(ic.getInternalComponents(entityId, head.id).some(i => i.type === 'thinkCore')).toBe(true);
        expect(ic.getInternalComponents(entityId, hand.id).some(i => i.type === 'strengthCore')).toBe(true);
        expect(ic.getInternalComponents(entityId, hand.id).some(i => i.type === 'precisionCore')).toBe(true);
        for (const leg of legs) {
            expect(ic.getInternalComponents(entityId, leg.id).some(i => i.type === 'moveCore')).toBe(true);
        }
    });

    it('lands the organ grants on the host components (energy/think/move/strength/fine-controls)', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);

        const body = entity.components.find(c => c.type === 'm1CentralBody');
        const head = entity.components.find(c => c.type === 'm1Head');
        const hand = entity.components.find(c => c.type === 'm1ArticulatedHand');
        const legFL = entity.components.find(c => c.type === 'm1Leg' && c.identifier === 'frontal_left');

        // Energy mechanic removed from the data: the (now inert) coalGenerator
        // grants nothing, so the body carries no energy stat at all.
        expect(world.getComponentStats(body.id).Physical?.energy).toBeUndefined();
        expect(world.getComponentStats(head.id).Mind.think_level).toBe(10);
        expect(world.getComponentStats(legFL.id).Movement.move).toBe(20);
        expect(world.getComponentStats(hand.id).Manipulation.fine_controls).toBe(50);
    });

    it('applies the strengthCore 120 override on the hand (clears the T1 gate of 117, not the default 50)', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);
        const hand = entity.components.find(c => c.type === 'm1ArticulatedHand');

        const strength = world.getComponentStats(hand.id).Physical.strength;
        expect(strength).toBe(120);
        expect(strength).toBeGreaterThan(117); // T1 gate
    });
});

describe('M1 droid — initial coal loadout (data/world.json)', () => {
    it('carries 10 coal in the body, a T1 with 1 knife projectile in the hand, and 5 knives on the frontal-left leg', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);
        const items = world.getEntityItems(entityId);

        const body = entity.components.find(c => c.type === 'm1CentralBody');
        const hand = entity.components.find(c => c.type === 'm1ArticulatedHand');
        const legFL = entity.components.find(c => c.type === 'm1Leg' && c.identifier === 'frontal_left');

        const bodyCoals = (items[body.id] ?? []).filter(i => i.type === 'coal');
        expect(bodyCoals.length).toBe(10);

        const handItems = items[hand.id] ?? [];
        const t1 = handItems.find(i => i.type === 't1');
        expect(t1, 'the hand must carry a T1').toBeTruthy();
        const ammo = (items[t1.id] ?? []).filter(i => i.type === 'knife');
        expect(ammo.length).toBe(1);

        const legKnives = (items[legFL.id] ?? []).filter(i => i.type === 'knife');
        expect(legKnives.length).toBe(5);
    });
});

describe('M1 droid — move action requirement path', () => {
    it('pins the ACTUAL move contract: the best single leg (20) gates the action, not a 4-leg aggregate', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);
        const legs = entity.components.filter(c => c.type === 'm1Leg');
        expect(legs.length).toBe(4);

        // The ACTUAL move contract, read from data (no magic numbers in the
        // assertions): the move action's requirements as declared in
        // data/actions.json, via the public action registry.
        const moveRequirements = world.getActionRegistry().move.requirements;
        const moveReq = moveRequirements.find(r => r.trait === 'Movement' && r.stat === 'move');
        expect(moveReq, 'the move action must declare a Movement.move requirement').toBeTruthy();
        const minValue = moveReq.minValue;

        // Per-leg values from the component stats: each leg's moveCore grants
        // its own Movement.move — the best-single-component value the
        // requirement path can ever see for this entity.
        const perLegMove = legs.map(leg => world.getComponentStats(leg.id).Movement.move);
        const bestSingleLeg = Math.max(...perLegMove);
        expect(bestSingleLeg).toBe(20); // moveCore grant (data/internalComponents.json)
        expect(bestSingleLeg).toBeGreaterThanOrEqual(minValue);

        // The 4-leg aggregate, asserted as a data property (sum of the per-leg
        // values): the spec's "aggregate 80" — present in the data, but NOT
        // what gates movement today.
        const legAggregate = perLegMove.reduce((sum, v) => sum + v, 0);
        expect(legAggregate).toBe(legs.length * bestSingleLeg); // 4 × 20 = 80

        // The ACTUAL gate (the path actionController uses to run move):
        // checkEntityRequirements resolves to the BEST single component, so it
        // passes on the best leg's 20 — not on the aggregate.
        const resolver = world.actionController.requirementResolver;
        const check = resolver.checkEntityRequirements(moveRequirements, entityId);
        expect(check.passed).toBe(true);
        expect(check.requirementValues['Movement.move']).toBe(bestSingleLeg); // 20, not 80

        // TRIPWIRE PIN: the entity-level aggregate map
        // (resolveEntityRequirementValues) is last-write-wins across the whole
        // component set — it yields 20 for move, not the 4-leg aggregate of 80.
        // No code path sums legs today.
        const entityValues = resolver.resolveEntityRequirementValues(entityId);
        expect(entityValues['Movement.move']).toBe(bestSingleLeg);

        /*
         * SPEC GAP (recorded here, deliberately NOT implemented):
         * the M1 spec §3/§10.2 frames movement as gated on the 4-leg aggregate
         * (4 × 20 = 80). The effective move value used by the requirement path
         * is the best leg's 20 (best-single-component resolution), and the
         * entity-level aggregate map is last-write-wins (also 20) — the auditor's
         * original "aggregate 80 through resolveEntityRequirementValues" idea is
         * wrong: that path cannot sum legs. This test pins the ACTUAL contract
         * so any future leg-summing is a conscious change, not a silent drift.
         * Follow-up design decision; out of scope for this change.
         */
    });
});

describe('M1 droid — initial-spawn count extension', () => {
    it('honors an explicit top-level count and adds exactly one when count is absent', () => {
        const { world, entityId } = buildWorld();
        const entity = world.stateEntityController.getEntity(entityId);
        const gun = entity.components.find(c => c.type === 'm1Gun');
        const head = entity.components.find(c => c.type === 'm1Head');

        // Explicit count: 3 knives into the (empty) gun.
        const r1 = world._applyInitialSpawns(entityId, {
            initialSpawns: [{ item: 'knife', slot: 'm1Gun', count: 3 }],
        });
        expect(r1).toEqual({ applied: 1, failed: 0 });
        const gunKnives = world.getEntityItems(entityId)[gun.id].filter(i => i.type === 'knife');
        expect(gunKnives.length).toBe(3);

        // No count: exactly one coal into the (empty) head — pre-count behavior.
        const r2 = world._applyInitialSpawns(entityId, {
            initialSpawns: [{ item: 'coal', slot: 'm1Head' }],
        });
        expect(r2).toEqual({ applied: 1, failed: 0 });
        const headCoals = world.getEntityItems(entityId)[head.id].filter(i => i.type === 'coal');
        expect(headCoals.length).toBe(1);
    });
});

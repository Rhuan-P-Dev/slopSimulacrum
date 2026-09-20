/**
 * Hand shotgun — random-component spread: CONTRACT test.
 *
 * Proves the new "hand shotgun" action fires the NEW `damageRandomComponents`
 * consequence (NOT the existing single-component `damageComponent`): N pellets,
 * each hitting a randomly-chosen living component of the target entity, with
 * per-pellet impact damage scaled by Manipulation.fine_controls*2, at long range.
 *
 * Full action round-trips (buildWorldState, tick NOT started) with the random
 * streams pinned so assertions are deterministic:
 *   - world.onDamageDropListener._randomFn always-fails → no real onDamage drops
 *     (the same pin used by the materialChunkDropCutShootT1 suite).
 *   - DamageConsequenceHandler._randomFn = () => 0 → the spread deterministically
 *     picks the FIRST living candidate repeatedly (Fisher-Yates always index 0 =
 *     the first N components in entity.components order).
 *
 * The dispatcher wraps each handler result in res.results (tagged by consequence
 * type + the handler's {success, message, data}), so the per-pellet data is read
 * from res.results.find(r => r.type === 'damageRandomComponents').data.
 *
 * @module test/contract/handShotgunRandomSpread
 */
import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/** A fresh, not-started world with the onDamage Bernoulli stream pinned (no real drops). */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick).worldStateController;
    world.onDamageDropListener._randomFn = () => 1;
    return world;
}

function existence(world, compId) {
    return world.getComponentStats(compId)?.Physical?.existence ?? 0;
}

describe('Hand shotgun — random-component spread (contract, full round-trip)', () => {
    it('fires N pellets across N RANDOM living components of the target, each dealing impact damage scaled by fine_controls*2 (long range)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');

        // Attacker (smallBallDroid) at (0,0); victim (m1Droid, 23 components) at (100,0).
        // Distance 100 < shotgun range 400 → "long range" is exercised.
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('m1Droid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 100, y: 0 });

        // The hand-mounted shotgun fires from a droidHand (fine_controls 50).
        const hand = world.getEntity(attackerId).components.find((c) => c.type === 'droidHand');
        expect(hand, 'attacker needs a droidHand component to fire the hand shotgun').toBeTruthy();

        // Pin the spread RNG: always pick index 0 → the first N living components, in order.
        world.actionController.consequenceHandlers.damageHandler._randomFn = () => 0;

        const victimComps = world.getEntity(victimId).components;
        expect(victimComps.length, 'victim (m1Droid) needs several living components to spread').toBeGreaterThan(3);
        // A valid aim-at component (matches the frontend's targetComponentId).
        const targetComponentId = victimComps[0].id;

        // Record pre-hit existence for every victim component.
        const before = new Map(victimComps.map((c) => [c.id, existence(world, c.id)]));
        expect(before.size, 'all victim components should be living before the shot').toBe(victimComps.length);

        const res = world.actionController.executeAction('hand shotgun', attackerId, {
            attackerComponentId: hand.id,
            targetEntityId: victimId,
            targetComponentId: targetComponentId,
        });

        expect(res.success, 'hand shotgun should succeed within range 100 < 400').toBe(true);
        // The dispatcher wraps per-consequence handler results in res.results, each
        // tagged with the consequence type and the handler's {success, message, data}.
        const damageRes = res.results.find((r) => r.type === 'damageRandomComponents');
        expect(damageRes, 'the hand shotgun must execute its damageRandomComponents consequence').toBeTruthy();
        expect(damageRes.success, `the damage consequence must succeed: ${JSON.stringify(damageRes)}`).toBe(true);
        const data = damageRes.data;
        expect(data.channel, 'spreads use the impact channel').toBe('impact');
        expect(data.count, 'fires 3 pellets (declared count)').toBe(3);
        expect(data.candidates, 'all living m1 components are spread candidates').toBe(victimComps.length);
        expect(data.hitIds, '3 distinct components were struck').toHaveLength(3);
        // The pinned RNG picked the first 3 living components, in order.
        expect(data.hitIds, 'the pinned RNG selects the first N living components').toEqual(victimComps.slice(0, 3).map((c) => c.id));

        const hitSet = new Set(data.hitIds);
        for (const [cid, beforeExist] of before) {
            const after = existence(world, cid);
            if (hitSet.has(cid)) {
                // Each struck component lost existence (a pellet landed).
                expect(after, `hit component ${cid} should lose existence (was ${beforeExist})`).toBeLessThan(beforeExist);
                expect(after, `hit component ${cid} damage must not over-shred below 0`).toBeGreaterThanOrEqual(0);
            } else {
                // Random spread: untouched components keep exactly their prior existence.
                expect(after, `component ${cid} should be untouched by the random spread`).toBe(beforeExist);
            }
        }

        // Total loss is the sum of the three per-pellet (clamped) losses.
        expect(data.totalLoss, 'total loss must be positive').toBeGreaterThan(0);
        const perPelletSum = data.hitIds.reduce((s, id) => s + (before.get(id) - existence(world, id)), 0);
        expect(data.totalLoss, 'totalLoss equals the sum of per-hit existence losses').toBeCloseTo(perPelletSum, 3);

        // Per-pellet raw value is fine_controls * 2 (attacker droidHand fine_controls = 50 → 100).
        const handFc = world.getComponentStats(hand.id)?.Manipulation?.fine_controls;
        expect(handFc, 'attacker droidHand must carry a fine_controls value').toBeGreaterThan(1);
        expect(data.value, 'per-pellet raw value is fine_controls * 2').toBe(handFc * 2);
    });

    it('resolves an entity ID target and reports the target entity (LLM-agent path)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');

        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('m1Droid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 300, y: 0 });

        const hand = world.getEntity(attackerId).components.find((c) => c.type === 'droidHand');
        world.actionController.consequenceHandlers.damageHandler._randomFn = () => 0;

        // LLM-agent path: targetEntityId only (no targetComponentId).
        const res = world.actionController.executeAction('hand shotgun', attackerId, {
            attackerComponentId: hand.id,
            targetEntityId: victimId,
        });

        expect(res.success, 'entity-ID targeting should succeed').toBe(true);
        const damageRes = res.results.find((r) => r.type === 'damageRandomComponents');
        expect(damageRes?.success, 'entity-ID targeting must fire the damage consequence').toBe(true);
        expect(damageRes?.data?.targetEntityId, 'resolves the target entity and reports its id').toBe(victimId);
        expect(damageRes?.data?.candidates, 'resolves the target entity and enumerates its living components').toBeGreaterThan(0);
        expect(damageRes?.data?.totalLoss, 'entity-ID targeting must deal damage').toBeGreaterThan(0);
    });

    it('fails when the attacker has fine_controls below the requirement', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');

        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('m1Droid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 });

        // Fire from the droidHead (no fine_controls / below the min 2).
        const head = world.getEntity(attackerId).components.find((c) => c.type === 'droidHead');
        expect(head, 'attacker needs a droidHead to try a low-fine-controls shot').toBeTruthy();
        const headFc = world.getComponentStats(head.id)?.Manipulation?.fine_controls;
        expect(headFc, 'droidHead should not meet the fine_controls >= 2 requirement').toBeUndefined();

        const res = world.actionController.executeAction('hand shotgun', attackerId, {
            attackerComponentId: head.id,
            targetEntityId: victimId,
        });

        expect(res.success, `low fine_controls attack must be rejected: ${JSON.stringify(res)}.results`).toBe(false);
    });

    it('two-handed shot (multi-attacker path): both hands fire, and total damage is the sum of each hand (not a silent no-op)', () => {
        const world = buildWorld(); // onDamage pinned to fail → no drops, pure damage round-trip.
        const roomId = world.roomsController.getUidByLogicalId('start_room');

        // Attacker smallBallDroid (carries two droidHands, each fine_controls=50);
        // victim m1Droid (23 living components, high impact resistance — survives 6 pellets).
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('m1Droid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 100, y: 0 }); // 100 < range 400.

        const attacker = world.getEntity(attackerId);
        const hands = attacker.components.filter((c) => c.type === 'droidHand');
        expect(hands.length, 'smallBallDroid must have two droidHands to trigger multi-attacker').toBe(2);

        const victimComps = world.getEntity(victimId).components;
        expect(victimComps.length, 'victim must have living components to spread across').toBeGreaterThan(0);
        const targetComponentId = victimComps[0].id; // a valid aim-at component (m1CentralBody).

        // Record pre-shot existence for every victim component (spread may hit any of them).
        const before = new Map(victimComps.map((c) => [c.id, existence(world, c.id)]));

        // Fire with BOTH hands as 'source' + a targetComponentId → executeMultiAttacker path.
        const res = world.actionController.executeAction('hand shotgun', attackerId, {
            targetComponentId,
            targetEntityId: victimId,
            componentIds: hands.map((h) => ({ componentId: h.id, role: 'source' })),
        });

        // (1) The multi-attacker path was actually routed (2 source components + component target).
        expect(res.success, `two-handed shot should succeed: ${JSON.stringify(res.error)}`).toBe(true);
        expect(res.executedPerAttacker, 'two source components must route through executeMultiAttacker (not the single-attacker path)').toBe(2);

        // (2) Each hand produces its own damageRandomComponents consequence; both succeed.
        const damageResults = res.results.filter((r) => r.type === 'damageRandomComponents');
        expect(damageResults.length, 'one damageRandomComponents consequence per hand').toBe(2);
        expect(damageResults.every((r) => r.success), 'each hand\'s damage consequence must succeed (pre-fix it was a silent no-op)').toBe(true);

        // (3) Per-pellet value scales with fine_controls*2 AND the two-hand synergy
        //     multiplier (the multi-attacker path applies synergy, per the damageComponent
        //     channel model it reuses).
        const synergyMult = res.synergy?.synergyMultiplier ?? 1.0;
        const hand0Fc = world.getComponentStats(hands[0].id)?.Manipulation?.fine_controls;
        const hand1Fc = world.getComponentStats(hands[1].id)?.Manipulation?.fine_controls;
        expect(hand0Fc, 'shooter hands must carry fine_controls').toBeGreaterThan(1);
        expect(damageResults[0].data.value, 'hand 0 per-pellet value = fine_controls*2*synergy').toBeCloseTo(hand0Fc * 2 * synergyMult, 6);
        expect(damageResults[1].data.value, 'hand 1 per-pellet value = fine_controls*2*synergy').toBeCloseTo(hand1Fc * 2 * synergyMult, 6);

        // (4) BOTH hands dealt damage — the pre-fix multi-attacker path dealt none.
        const sumReported = damageResults.reduce((s, r) => s + (r.data.totalLoss ?? 0), 0);
        expect(sumReported, 'both hands must have dealt damage (no silent no-op)').toBeGreaterThan(0);

        // (5) The sum of per-hand losses equals the victim\'s actual existence loss,
        //     across ALL its components (the spread may hit any of them).
        const after = new Map(victimComps.map((c) => [c.id, existence(world, c.id)]));
        const actualLoss = victimComps.reduce((s, c) => s + Math.max(0, before.get(c.id) - after.get(c.id)), 0);
        expect(sumReported, 'sum of per-hand reported losses equals the victim\'s actual loss').toBeCloseTo(actualLoss, 3);

        // (6) The victim is not fully shredded: it retains at least one living component.
        const livingAfter = victimComps.filter((c) => after.get(c.id) > 0).length;
        expect(livingAfter, 'victim should retain living components after a 6-pellet shot').toBeGreaterThan(0);
    });

    it('damage fires the onDamage drop stream (forced 100% Bernoulli → drop count rises, proving the shotgun triggers the rule)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');

        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('m1Droid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 100, y: 0 });

        const hand = world.getEntity(attackerId).components.find((c) => c.type === 'droidHand');
        expect(hand, 'attacker needs a droidHand to fire the hand shotgun').toBeTruthy();
        const targetComponentId = world.getEntity(victimId).components[0].id;

        // buildWorld pinned onDamage to ALWAYS FAIL. Force it to ALWAYS SUCCEED so any pellet
        // hitting a living component mints a drop — this proves the shotgun's damage actually
        // routes through the onDamage world rule (the previous test only proved its absence).
        world.onDamageDropListener._randomFn = () => 0;

        const beforeDrops = Object.keys(world.getDroppedItems()).length;
        const res = world.actionController.executeAction('hand shotgun', attackerId, {
            attackerComponentId: hand.id,
            targetEntityId: victimId,
            targetComponentId,
        });
        expect(res.success, 'single-hand shotgun should succeed within range').toBe(true);

        const afterDrops = Object.keys(world.getDroppedItems()).length;
        expect(
            afterDrops,
            'the onDamage rule should mint at least one drop in response to shotgun damage'
        ).toBeGreaterThan(beforeDrops);
    });
});

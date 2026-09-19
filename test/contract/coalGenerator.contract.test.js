/**
 * CONTRACT TEST — the M1 coal generator organ (now INERT).
 *
 * The energy mechanic was removed from the shipped data:
 *   - data/internalComponents.json — `coalGenerator` has an empty `overTime`
 *     list and empty `grants`: it consumes no coal and grants no energy;
 *   - data/world_rules.json — no `energyFlow` rule, so nothing redistributes
 *     energy between components.
 *
 * This contract pins the INERT state against the REAL per-turn channel,
 * driven WITHOUT real timers (the same house pattern the old coal contract
 * used): build the world via buildWorldState(tickSystem) (tick not started),
 * spawn the m1Droid, and call the IC controller's `processTurnEffects(round)`
 * directly with the round number — the same per-turn method the round-start
 * hook calls.
 *
 * Pins:
 *   - spawn state: the organ is still auto-installed (recipe compatibility —
 *     m1CentralBody still declares it), 10 coal aboard from the world.json
 *     loadout, and NO `Physical.energy` stat (the old organ seed-at-0 is gone);
 *   - the old cadence rounds (5, 10, 15, ...) are no-ops: coal untouched, no
 *     energy stat ever created, and no "exhausted on" warning ever logged
 *     — not even when the tank is drained (nothing can run out — nothing
 *     can burn);
 *   - a manually SET energy stat is untouched by the IC channel: nothing
 *     charges it, nothing clamps it, nothing drains it (the old full-battery
 *     skip and clamp-at-margin semantics simply do not exist);
 *   - the internal dry-transition marker map never receives a key.
 *
 * @module test/contract/coalGenerator
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import Logger from '../../src/utils/Logger.js';

/** Builds a fresh world (non-started tick system) and spawns the M1 droid. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('m1Droid', startRoomId);
    const entity = world.stateEntityController.getEntity(entityId);
    const body = entity.components.find(c => c.type === 'm1CentralBody');
    return { world, tick, entityId, bodyId: body.id, startRoomId };
}

/** Drives the IC per-turn channel at a given round (no real timers). */
function driveIC(world, round) {
    world.internalComponentController.processTurnEffects(round);
}

/** Raw body energy value — undefined while the stat is unseeded. */
function energyOf(world, bodyId) {
    const stats = world.getComponentStats(bodyId);
    return stats?.Physical?.energy;
}

/** Coal units aboard the whole entity (across every host component). */
function coalUnits(world, entityId) {
    const items = world.getEntityItems(entityId);
    let count = 0;
    for (const list of Object.values(items)) {
        for (const item of list) if (item?.type === 'coal') count++;
    }
    return count;
}

/** Removes every coal unit from the entity (leaves it with an empty tank). */
function drainCoal(world, entityId) {
    const items = world.getEntityItems(entityId);
    for (const list of Object.values(items)) {
        for (const item of list) {
            if (item?.type === 'coal') world.removeItemFromEntity(entityId, item.id);
        }
    }
}

describe('coal generator — inert organ over the per-turn channel', () => {
    let warnSpy;

    afterEach(() => {
        warnSpy?.mockRestore();
        warnSpy = undefined;
    });

    it('auto-installs (recipe compatibility) but seeds no energy stat at spawn', () => {
        const { world, entityId, bodyId } = buildWorld();
        const body = world.stateEntityController
            .getEntity(entityId)
            .components.find(c => c.type === 'm1CentralBody');

        expect(world.internalComponentController.getInternalComponents(entityId, body.id).some(i => i.type === 'coalGenerator')).toBe(true);
        expect(coalUnits(world, entityId)).toBe(10); // world.json loadout intact
        expect(energyOf(world, bodyId), 'no energy stat (grant removed from the data)').toBeUndefined();
    });

    it('the old cadence rounds are no-ops: coal untouched, no energy stat, no exhaustion log', () => {
        const { world, entityId, bodyId } = buildWorld();
        expect(coalUnits(world, entityId)).toBe(10);
        expect(energyOf(world, bodyId)).toBeUndefined();

        // Round-0 gate closed (as before) and, with no effect to fire,
        // rounds 0–15 are structurally no-ops.
        for (let round = 0; round <= 15; round++) {
            driveIC(world, round);
            expect(coalUnits(world, entityId), `coal unchanged at round ${round}`).toBe(10);
            expect(energyOf(world, bodyId), `no energy stat at round ${round}`).toBeUndefined();
        }

        // Even an empty tank never triggers the old dry-transition log —
        // there is no effect to go dry.
        const exhaustionWarn = (arg) =>
            typeof arg === 'string' && arg.includes('exhausted on');
        warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        drainCoal(world, entityId);
        for (const round of [5, 10, 15]) driveIC(world, round);
        expect(coalUnits(world, entityId)).toBe(0);
        expect(energyOf(world, bodyId)).toBeUndefined();
        expect(warnSpy.mock.calls.filter(c => exhaustionWarn(c[0])), 'no dry transition can occur without an effect').toEqual([]);
    });

    it('a manually-set energy stat is untouched: nothing charges, clamps, or drains it', () => {
        const { world, entityId, bodyId } = buildWorld();

        // Old test pinned: 95 + one burn lands exactly on 100. Now 95 simply
        // stays 95 — the IC channel has no business with energy at all.
        world.componentController.updateComponentStat(bodyId, 'Physical', 'energy', 95);
        driveIC(world, 5);
        expect(energyOf(world, bodyId), 'not charged (no effect to fire)').toBe(95);
        expect(coalUnits(world, entityId)).toBe(10);

        world.componentController.updateComponentStat(bodyId, 'Physical', 'energy', 100);
        driveIC(world, 10);
        expect(energyOf(world, bodyId)).toBe(100);

        // The organ's capacity clamp (100) was the old organ-owned bound; with
        // the effect gone the stat is an ordinary, uncapped number.
        world.componentController.updateComponentStat(bodyId, 'Physical', 'energy', 150);
        driveIC(world, 15);
        expect(energyOf(world, bodyId), 'no capacity clamp remains').toBe(150);
    });

    it('the fuel-exhaustion marker map never receives a key (nothing can go dry)', () => {
        const { world, entityId, bodyId } = buildWorld();
        const ic = world.internalComponentController;

        for (const round of [5, 10, 15]) driveIC(world, round);
        expect([
            ...ic._fuelExhaustionLogged.keys()
        ], 'no IC effect can log a dry transition; the marker stays empty').toEqual([]);
        expect(energyOf(world, bodyId)).toBeUndefined();
    });
});

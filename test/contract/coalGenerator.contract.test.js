/**
 * CONTRACT TEST — the M1 coal generator (overTime: consumeFuelGenerateStat).
 *
 * Verifies the NEW effect type on the unified tick channel, driven WITHOUT
 * real timers: build the world via buildWorldState(tickSystem) (tick not
 * started), set tickSystem.currentTick = N, then invoke the registered
 * 'internal-components' job callback directly — the same code path the
 * running loop uses (UniversalTickSystem._executeTick → job.callback()).
 *
 * Covers the effect's documented priority order (spec §5.2):
 *   - cadence: nothing happens off-interval ticks; a burn fires on every
 *     multiple of intervalTicks (5) — 1 coal → +10 Physical.energy;
 *   - full battery: charge ≥ energyCapacity skips the interval without
 *     burning fuel (coal is never burned for a full tank);
 *   - clamping: the last partial charge clamps at the capacity margin
 *     (95 + one burn of 10 lands exactly on 100, fuel still consumed);
 *   - graceful runout: with fewer than fuelConsumedPerInterval units of
 *     coal aboard, nothing is consumed and nothing is charged, and the
 *     exhaustion is logged exactly ONCE on the dry transition — a droid
 *     sitting at zero fuel must not spam the log every interval.
 *
 * All balance numbers (interval 5, 1 coal, +10 energy, capacity 100) come
 * from data/internalComponents.json — the test pins them as the contract.
 *
 * @module test/contract/coalGenerator
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

const IC_JOB_ID = 'internal-components';

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

/** Drives the unified IC tick job at an absolute tick (no real timers). */
function driveIC(tick, targetTick) {
    const job = tick.jobs.find(j => j.id === IC_JOB_ID);
    expect(job, `the '${IC_JOB_ID}' tick job must be registered`).toBeTruthy();
    tick.currentTick = targetTick;
    job.callback();
}

/** Energy charge currently on the M1 body (the coal generator's host). */
function energyOf(world, bodyId) {
    return world.getComponentStats(bodyId)?.Physical?.energy ?? 0;
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

describe('coal generator — consumeFuelGenerateStat over the unified tick channel', () => {
    let warnSpy;

    afterEach(() => {
        warnSpy?.mockRestore();
        warnSpy = undefined;
    });

    it('burns 1 coal per interval (every 5 ticks) and charges +10 energy; off-interval ticks do nothing', () => {
        const { world, tick, entityId, bodyId } = buildWorld();
        expect(coalUnits(world, entityId)).toBe(10); // world.json loadout
        expect(energyOf(world, bodyId)).toBe(0);     // organ grant seeds 0

        driveIC(tick, 4); // 4 % 5 !== 0 → cadence gate holds
        expect(coalUnits(world, entityId)).toBe(10);
        expect(energyOf(world, bodyId)).toBe(0);

        driveIC(tick, 5);
        expect(coalUnits(world, entityId)).toBe(9);
        expect(energyOf(world, bodyId)).toBe(10);

        driveIC(tick, 10);
        expect(coalUnits(world, entityId)).toBe(8);
        expect(energyOf(world, bodyId)).toBe(20);
    });

    it('a full battery skips the interval without burning fuel', () => {
        const { world, tick, entityId, bodyId } = buildWorld();
        world.componentController.updateComponentStat(bodyId, 'Physical', 'energy', 100);
        expect(energyOf(world, bodyId)).toBe(100);

        driveIC(tick, 5);
        expect(coalUnits(world, entityId)).toBe(10); // no coal burned
        expect(energyOf(world, bodyId)).toBe(100);
    });

    it('clamps the charge at the capacity margin (95 + one burn lands exactly on 100, fuel still consumed)', () => {
        const { world, tick, entityId, bodyId } = buildWorld();
        world.componentController.updateComponentStat(bodyId, 'Physical', 'energy', 95);

        driveIC(tick, 5);
        expect(coalUnits(world, entityId)).toBe(9); // fuel consumed
        expect(energyOf(world, bodyId)).toBe(100); // +5, not +10

        // Now full: the next interval must skip (rule 1 takes priority).
        driveIC(tick, 10);
        expect(coalUnits(world, entityId)).toBe(9);
        expect(energyOf(world, bodyId)).toBe(100);
    });

    it('runs out gracefully: nothing consumed, nothing charged, exhaustion logged once and only once', () => {
        const { world, tick, entityId, bodyId } = buildWorld();
        drainCoal(world, entityId);
        expect(coalUnits(world, entityId)).toBe(0);
        expect(energyOf(world, bodyId)).toBe(0);

        const exhaustionWarn = (arg) =>
            typeof arg === 'string' && arg.includes('exhausted on');
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        driveIC(tick, 5);
        expect(energyOf(world, bodyId)).toBe(0); // not charged
        const dryLogsAfterFirst = warnSpy.mock.calls.filter(c => exhaustionWarn(c[0])).length;
        expect(dryLogsAfterFirst).toBe(1); // logged on the transition into the dry state

        driveIC(tick, 10);
        driveIC(tick, 15);
        const dryLogsAfterMore = warnSpy.mock.calls.filter(c => exhaustionWarn(c[0])).length;
        expect(dryLogsAfterMore).toBe(1); // no spam on subsequent dry intervals
    });

    it('sweeps the dry-transition marker on despawn so a respawned droid re-logs its first exhaustion', () => {
        const { world, tick, entityId, bodyId, startRoomId } = buildWorld();
        const ic = world.internalComponentController;
        const exhaustionWarn = (arg) =>
            typeof arg === 'string' && arg.includes('exhausted on');
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // 1. Drain the tank and drive a dry tick: exactly ONE exhaustion log.
        drainCoal(world, entityId);
        expect(coalUnits(world, entityId)).toBe(0);
        expect(energyOf(world, bodyId)).toBe(0);

        driveIC(tick, 5);
        expect(energyOf(world, bodyId)).toBe(0); // not charged
        expect(warnSpy.mock.calls.filter(c => exhaustionWarn(c[0])).length).toBe(1);

        // 2. Despawn (reaches InternalComponentController.cleanupEntity):
        //    leak guard — no dry-transition marker may survive for the removed
        //    entity id. Observed through the fixture's controller handle, the
        //    same surface the M1 contract test already uses.
        expect([...ic._fuelExhaustionLogged.keys()].some(k => k.startsWith(`${entityId}:`))).toBe(true);
        expect(world.despawnEntity(entityId)).toBe(true);
        expect([...ic._fuelExhaustionLogged.keys()].filter(k => k.startsWith(`${entityId}:`))).toEqual([]);

        // 3. Respawn the M1 (new entity id, fresh 10-coal kit from world.json)
        //    and drive another dry tick: a SECOND exhaustion log must appear —
        //    proof the despawn sweep reset the marker — and energy stays 0.
        const newEntityId = world.stateEntityController.spawnEntity('m1Droid', startRoomId);
        expect(newEntityId).not.toBe(entityId);
        const newEntity = world.stateEntityController.getEntity(newEntityId);
        const newBodyId = newEntity.components.find(c => c.type === 'm1CentralBody').id;
        expect(coalUnits(world, newEntityId)).toBe(10); // fresh loadout on respawn

        drainCoal(world, newEntityId);
        expect(coalUnits(world, newEntityId)).toBe(0);

        driveIC(tick, 10);
        expect(energyOf(world, newBodyId)).toBe(0); // not charged
        expect(warnSpy.mock.calls.filter(c => exhaustionWarn(c[0])).length).toBe(2);
    });
});

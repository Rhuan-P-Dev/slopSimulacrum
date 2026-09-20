/**
 * CONTRACT TEST — the M1 coal generator organ: the whole-entity energy-life loop.
 *
 * The coal generator is a FUEL BURNER (data/internalComponents.json) that
 * charges the HOST ENTITY's energy attribute — a WHOLE-ENTITY stat seeded at
 * spawn from data/entity_attributes.json (100 units, max 100, drained 1/turn),
 * not a per-component stat. This contract pins the full loop against the REAL
 * per-turn channel, driven WITHOUT real timers (the same house pattern the old
 * coal contract used): build the world via buildWorldState(tickSystem) (tick
 * not started), spawn the m1Droid, and call the per-turn methods directly
 * (internalComponentController.processTurnEffects, entityEnergyController
 * .processEnergyTurn) — the same methods the round-start hook calls.
 *
 * Pins:
 *   - spawn state: the organ is still auto-installed (recipe compatibility),
 *     10 coal aboard from the world.json loadout, the entity seeds a 100-unit
 *     energy attribute (with its declaration), and the body COMPONENT carries
 *     no `Physical.energy` stat (energy is owned by the entity, not a component);
 *   - full-battery skip: at energy == capacity the cadence round burns no coal;
 *   - charge: below capacity, the cadence round (every 5 rounds) burns exactly
 *     one coal and charges the entity, clamped at the capacity margin;
 *   - exhaustion: with coal drained and energy below full, the dry transition is
 *     logged ONCE per cadence (not spammed) and nothing is consumed;
 *   - death: when the entity's energy hits 0 (drained past the last coal), the
 *     entity is eliminated — despawned and its carried contents spilled to the
 *     floor.
 *
 * @module test/contract/coalGenerator
 */

import { describe, it, expect, vi } from 'vitest';
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

/**
 * Drives the full per-turn energy channel at a round, in the same order the
 * round-start hook uses: IC fuel burn → entity drain + death check.
 * @param {WorldStateController} world
 * @param {number} round
 */
function driveRound(world, round) {
    world.internalComponentController.processTurnEffects(round);
    world.entityEnergyController.processEnergyTurn(round);
}

/** The entity's whole-entity energy attribute (null when absent). */
function energyOf(world, entityId) {
    return world.getEntityAttribute(entityId, 'Physical', 'energy');
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

describe('coal generator — whole-entity energy-life loop', () => {
    it('auto-installs the organ; the entity seeds a 100-unit energy attribute + 10 coal', () => {
        const { world, entityId, bodyId } = buildWorld();
        const ic = world.internalComponentController.getInternalComponents(entityId, bodyId);

        expect(ic.some(i => i.type === 'coalGenerator'), 'organ still auto-installed').toBe(true);
        expect(coalUnits(world, entityId), 'world.json coal loadout intact').toBe(10);
        expect(energyOf(world, entityId), 'entity seeds its energy attribute').toBe(100);
        expect(world.getEntityAttributeConfig(entityId, 'Physical', 'energy')).toEqual({
            value: 100, max: 100, drainPerTurn: 1,
        });
        // Energy is a WHOLE-ENTITY attribute: the body component carries no stat.
        expect(world.getComponentStats(bodyId).Physical?.energy, 'component carries no energy stat').toBeUndefined();
    });

    it('full battery skips the burn: no coal is consumed while energy is at capacity', () => {
        const { world, entityId } = buildWorld();
        expect(energyOf(world, entityId)).toBe(100);

        // Cadence round (5) at full capacity: the generator must NOT burn.
        world.internalComponentController.processTurnEffects(5);
        expect(coalUnits(world, entityId), 'no burn at full battery').toBe(10);
        expect(energyOf(world, entityId), 'energy stays at capacity').toBe(100);
    });

    it('below capacity, the cadence round burns 1 coal and charges the entity (clamped at capacity)', () => {
        const { world, entityId } = buildWorld();

        // Drop energy below capacity so the cadence round actually burns.
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -5); // 100 -> 95
        expect(energyOf(world, entityId)).toBe(95);

        world.internalComponentController.processTurnEffects(5);
        expect(coalUnits(world, entityId), 'burned exactly 1 coal').toBe(9);
        expect(energyOf(world, entityId), '95 + 10 clamped at capacity 100').toBe(100);
    });

    it('partial burn wastes the margin: a near-full tank charges to capacity, not beyond', () => {
        const { world, entityId } = buildWorld();

        // 98 + 10 would be 108; the burn is clamped to the 2-unit margin.
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -2); // 100 -> 98
        world.internalComponentController.processTurnEffects(10);
        expect(coalUnits(world, entityId), 'still burned 1 coal').toBe(9);
        expect(energyOf(world, entityId), 'clamped at 100 (2 wasted)').toBe(100);
    });

    it('exhaustion: with coal drained and energy below full, the dry transition is logged once per cadence', () => {
        const { world, entityId } = buildWorld();
        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            drainCoal(world, entityId);
            world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -20); // 100 -> 80

            // First cadence round: dry transition logged once.
            world.internalComponentController.processTurnEffects(5);
            // Second cadence round: marker already set — NOT logged again.
            world.internalComponentController.processTurnEffects(10);

            const exhaustionWarns = warnSpy.mock.calls
                .filter(c => typeof c[0] === 'string' && c[0].includes('exhausted on'));
            expect(exhaustionWarns, 'dry transition logged exactly once').toHaveLength(1);
            expect(coalUnits(world, entityId)).toBe(0);
            expect(energyOf(world, entityId), 'nothing was charged').toBe(80);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('the per-turn drain lowers energy each round and a full turn-step drains it one unit', () => {
        const { world, entityId } = buildWorld();
        // Drain all coal so the cadence rounds cannot recharge (exhaustion no-op).
        drainCoal(world, entityId);
        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            // Round 1: no cadence (1 % 5 != 0), drain 1 -> 99.
            world.entityEnergyController.processEnergyTurn(1);
            expect(energyOf(world, entityId)).toBe(99);
            // Round 5: cadence is an exhaustion no-op (no coal), drain 1 -> 98.
            world.entityEnergyController.processEnergyTurn(5);
            expect(energyOf(world, entityId)).toBe(98);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('round 0 is a bootstrap no-op: no drain and no coal burn (aligned with the IC round-0 gate)', () => {
        const { world, entityId } = buildWorld();
        expect(energyOf(world, entityId)).toBe(100);
        expect(coalUnits(world, entityId)).toBe(10);

        // Round 0 must neither drain the entity energy nor burn coal: the IC
        // charge step skips `r <= 0`, and the energy drain now mirrors that so
        // the first real drain lands on round 1 (not a lone drain ahead of any
        // charge on the world's first hook).
        driveRound(world, 0);

        expect(energyOf(world, entityId), 'round 0 drains nothing').toBe(100);
        expect(coalUnits(world, entityId), 'round 0 burns no coal').toBe(10);
    });

    it('death: when energy hits 0 the entity is eliminated and its contents spill to the floor (in the entity room)', () => {
        const { world, entityId, startRoomId } = buildWorld();
        const droppedBefore = Object.keys(world.getDroppedItems() || {}).length;

        // Drain all coal (no recharge); the entity still carries its other gear.
        drainCoal(world, entityId);
        const carriedAtDeath = Object.values(world.getEntityItems(entityId)).reduce((n, list) => n + list.length, 0);
        expect(carriedAtDeath, 'entity still carries non-coal items at death').toBeGreaterThan(0);

        // Drop energy to 1 and run a drain turn: 1 - 1 = 0 -> the entity dies.
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -99); // 100 -> 1
        world.entityEnergyController.processEnergyTurn(7);

        expect(world.stateEntityController.getEntity(entityId), 'despawned').toBeNull();
        // Its carried contents spilled to the floor 1:1 (one drop per item).
        const droppedAfter = Object.keys(world.getDroppedItems() || {}).length;
        expect(droppedAfter - droppedBefore, 'carried contents spilled 1:1').toBe(carriedAtDeath);
        // A carried item type (knife) is present among the drops.
        const dropTypes = Object.values(world.getDroppedItems()).map(d => d.itemType);
        expect(dropTypes, 'a carried item type spilled').toContain('knife');

        // Regression pin (P1): the entity carries its room as a STRING
        // `location` and its 2D coords as `spatial`. The old code read a
        // nonexistent `entity.locationId` (-> null) and a string `location` as a
        // position, so `writeDroppedItem` defaulted roomId to 'unassigned' and the
        // client's room filter (item.roomId === currentRoom) lost every death
        // spill. These assertions would have failed against that bug.
        const dropped = Object.values(world.getDroppedItems());
        expect(dropped.length, 'items were spilled').toBe(droppedAfter - droppedBefore);
        expect(
            dropped.every(item => item.roomId === startRoomId),
            'all drops land in the entity room (never "unassigned")'
        ).toBe(true);
        expect(
            dropped.every(item => Number.isFinite(item.x) && Number.isFinite(item.y)),
            'spilled at finite, sampled coords'
        ).toBe(true);
    });

    it('double-elimination is safe: the second kill of an absent entity is a no-op', () => {
        const { world, entityId } = buildWorld();
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -100); // 100 -> 0
        expect(world.eliminateEntityByEnergy(entityId), 'first kill succeeds').toBe(true);
        expect(world.eliminateEntityByEnergy(entityId), 'second kill is a no-op').toBe(false);
    });
});

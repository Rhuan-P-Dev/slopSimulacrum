/**
 * Feature 2 — Material chunk drop on cut and shootT1: CONTRACT test (BUG-136).
 *
 * Companion to test/contract/materialChunkDrop.contract.test.js (punch). Builds a
 * real world (buildWorldState, tick system NOT started) and asserts, with full
 * action round-trips, that the two actions whose consequence lists were missing
 * the dropMaterialChunk declaration now shed chunks through the same pipeline:
 *
 *   1. CUT ON HIT: an equipped knife cutting an iron head sheds exactly one
 *      `chunk_iron` ground record in the target's room, near the target, with the
 *      D7 volume derived from the applied loss (formula-exact from data files:
 *      the knife's blended material split × the head's resistances × the D7
 *      drop-rate contract — no hard-coded balance numbers).
 *   2. SHOOT T1: firing a T1 (one stored projectile) sheds a chunk, and because
 *      the applied loss is the projectile's volume (tiny), the volume equals the
 *      minChunkVolume floor from data/materialDropRates.json — the D7 floor is
 *      proven to be what is asserted, not an accidental match.
 *   3. DATA GUARD (the BUG-136 root cause itself): each channel-damage action's
 *      consequence list in data/actions.json declares the dropMaterialChunk
 *      consequence AFTER its damage consequence, so silently removing the
 *      declaration from any action is caught here.
 *
 * Expected values are derived from the SAME data files the server reads
 * (materials, materialDamageTypes, materialDropRates, components,
 * inventoryItems) so assertions are formula-exact.
 *
 * @module test/contract/materialChunkDropCutShootT1
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { DEFAULT_TRIGGER_RADIUS } from '../../src/utils/DiskSampler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8'));

const RESISTANCE_SCALE = 100; // mirrors the per-channel formula's base absorption

const actions = readJson('data/actions.json');
const dropRates = readJson('data/materialDropRates.json');
const inventoryItems = readJson('data/inventoryItems.json');

/** A fresh, not-started world (the drop feature's drop-rates registry is on by default). */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    return buildWorldState(tick).worldStateController;
}

const headOf = (world, id) => world.getEntity(id).components.find((c) => c.type === 'droidHead');
const dropped = (world) => Object.values(world.getDroppedItems());
const existence = (world, compId) => world.getComponentStats(compId)?.Physical?.existence ?? 0;

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Spawns an attacker at (0,0) and a victim at (vx,0); returns their ids. */
function spawnPair(world, roomId, vx = 50) {
    const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
    world.stateEntityController.updateEntitySpatial(victimId, { x: vx, y: 0 });
    return { attackerId, victimId };
}

/** D7: expected chunk volume for one material of a target component, given the applied loss. */
function expectedChunkVolume(world, targetCompType, material, appliedLoss) {
    const def = world.componentController.getComponentDefinition(targetCompType);
    const volume = def?.form?.volume ?? def?.volume ?? 0;
    const fraction = world.componentController.getComponentMaterialsByType()[targetCompType]
        .find((m) => m.material === material)?.fraction ?? 0;
    const lost = appliedLoss * fraction * volume;
    return Math.max(dropRates.minChunkVolume, dropRates.materials[material].chunkFraction * lost);
}

describe('Feature 2 — material chunk drop on cut and shootT1 (contract, full round-trip)', () => {
    it('CUT ON HIT: cutting an iron head sheds exactly one chunk_iron with the D7 volume (formula-exact from data)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        // vx=40 keeps the target strictly inside cut's data-driven range (50).
        const { attackerId, victimId } = spawnPair(world, roomId, 40);

        // Equip a knife on the attacker's droidHand (public API; the equip flow
        // seeds the knife's matter-derived sharpness per-instance — BUG-134).
        const hand = world.getEntity(attackerId).components.find((c) => c.type === 'droidHand');
        expect(hand, 'expected a droidHand component on the droid').toBeTruthy();
        const add = world.addItemToEntity(attackerId, 'knife', hand.id);
        expect(add.success, 'the knife should be added to the droidHand').toBe(true);
        const knife = world.getEntityItems(attackerId)[hand.id].find((i) => i.type === 'knife');
        expect(knife, 'expected a knife item on the droidHand').toBeTruthy();
        const equip = world.equipItem(attackerId, knife.id, 'knife', hand.id);
        expect(equip.success, `equipping the knife should succeed: ${JSON.stringify(equip)}`).toBe(true);
        const eqId = world.getEquippedItems(attackerId).find((e) => e.itemId === knife.id)?.eqId;
        expect(eqId, 'the equipped knife should be listed for the entity').toBeTruthy();

        // The cut's raw value is the knife's live sharpness; the attacker's split
        // is the knife's own composition (blade + handle), blended by fraction
        // (spec D4) — the exact value the damage handler publishes as
        // lastChannelLoss.appliedLoss (the drop handler's only input, D5).
        const sharpness = world.equippedItemStats.getStats(eqId)?.Physical?.sharpness;
        expect(sharpness, 'the equipped knife should carry a derived sharpness').toBeGreaterThan(0);
        const head = headOf(world, victimId);
        expect(head).toBeTruthy();
        const res = world.getComponentStats(head.id).Physical;
        const split = world.materialController.getBlendedDamageTypeSplit(inventoryItems.knife.materials, 'cut');
        const appliedLoss =
            (sharpness * (split.impact / 100)) / (RESISTANCE_SCALE + (res.impact_resistance ?? 0)) +
            (sharpness * (split.cut / 100)) / (RESISTANCE_SCALE + (res.cut_resistance ?? 0)) +
            (sharpness * (split.wear / 100)) / (RESISTANCE_SCALE + (res.wear_resistance ?? 0));

        const before = existence(world, head.id);
        const result = world.actionController.executeAction('cut', attackerId, {
            attackerComponentId: eqId,
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `cut should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const appliedLossMeasured = before - existence(world, head.id);
        expect(appliedLossMeasured, 'the cut should inflict a positive applied loss').toBeGreaterThan(0);
        // The split formula and the measured existence delta must agree
        // (the damage step applies one summed delta — spec D3).
        expect(appliedLossMeasured).toBeCloseTo(appliedLoss, 6);

        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        expect(ironChunks.length, 'iron (rate 1.0) should always shed exactly one chunk').toBe(1);
        // The target is 100% iron: no other chunk type can originate from it.
        expect(dropped(world).every((d) => d.itemType === 'chunk_iron'),
            'only chunk_iron can drop from a 100%-iron target').toBe(true);

        const chunk = ironChunks[0];
        // Room: the target's room. Position: a disk sample around the target entity.
        expect(chunk.roomId).toBe(roomId);
        expect(dist(chunk.x, chunk.y, 40, 0)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS + 1e-9);

        // D7 volume: max(min, chunkFraction × (appliedLoss × ironFraction(1.0) × headVolume)) —
        // every input read from the same data files the server uses.
        const expected = expectedChunkVolume(world, 'droidHead', 'iron', appliedLoss);
        expect(chunk.volume).toBeCloseTo(expected, 6);
    });

    it('SHOOT T1: firing the T1 sheds a chunk at the minChunkVolume floor (a projectile-volume loss is tiny — the floor is what is asserted)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const { attackerId, victimId } = spawnPair(world, roomId);

        // The T1 is a heavy iron item: the strength-to-mass equip gate
        // (data/holdingCost.json) is too strong for a droidHand, so the host is
        // a droidRollingBall (its strengthCore carries the burden).
        const wheel = world.getEntity(attackerId).components.find((c) => c.type === 'droidRollingBall');
        expect(wheel, 'expected a droidRollingBall component on the droid').toBeTruthy();
        const add = world.addItemToEntity(attackerId, 't1', wheel.id);
        expect(add.success, 'the T1 should be added to the droidRollingBall').toBe(true);
        const t1 = world.getEntityItems(attackerId)[wheel.id].find((i) => i.type === 't1');
        expect(t1, 'expected a t1 item on the droidRollingBall').toBeTruthy();
        const equip = world.equipItem(attackerId, t1.id, 't1', wheel.id);
        expect(equip.success, `equipping the T1 should succeed: ${JSON.stringify(equip)}`).toBe(true);
        const eqId = world.getEquippedItems(attackerId).find((e) => e.itemId === t1.id)?.eqId;
        expect(eqId, 'the equipped T1 should be listed for the entity').toBeTruthy();

        // Load one projectile: the consumed item's volume is the raw damage (data).
        const nest = world.addItemToContainer(attackerId, t1.id, 'knife');
        expect(nest.success, `a projectile should load into the T1: ${JSON.stringify(nest)}`).toBe(true);
        const projectileVolume = inventoryItems.knife.form.volume;

        const head = headOf(world, victimId);
        expect(head).toBeTruthy();
        const before = existence(world, head.id);
        const result = world.actionController.executeAction('shootT1', attackerId, {
            attackerComponentId: eqId,
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `shootT1 should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // The projectile was consumed from the T1's internal inventory
        // (an emptied container key is simply absent from the items map).
        const remaining = world.getEntityItems(attackerId)[t1.id] ?? [];
        expect(remaining, 'the fired projectile should be gone from the T1').toHaveLength(0);

        const appliedLoss = before - existence(world, head.id);
        expect(appliedLoss, 'the shot should inflict a positive applied loss').toBeGreaterThan(0);
        // The applied loss is the projectile's volume resisted by the head's
        // impact resistance (the T1 is 100% iron → 100% of the value is impact).
        const res = world.getComponentStats(head.id).Physical;
        expect(appliedLoss).toBeCloseTo((projectileVolume * 100 / 100) / (RESISTANCE_SCALE + (res.impact_resistance ?? 0)), 6);

        // D7 floor: prove the un-floored chunk volume is BELOW the floor, so the
        // asserted volume is the floor itself (derived from the data file).
        const headDef = world.componentController.getComponentDefinition('droidHead');
        const headVolume = headDef?.form?.volume ?? headDef?.volume ?? 0;
        const ironFraction = world.componentController.getComponentMaterialsByType().droidHead
            .find((m) => m.material === 'iron')?.fraction ?? 0;
        const floor = dropRates.minChunkVolume;
        const unFloored = dropRates.materials.iron.chunkFraction * (appliedLoss * ironFraction * headVolume);
        expect(unFloored, 'the un-floored chunk volume should be below the floor').toBeLessThan(floor);

        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        expect(ironChunks.length, 'iron (rate 1.0) should always shed exactly one chunk').toBe(1);
        const chunk = ironChunks[0];
        expect(chunk.roomId).toBe(roomId);
        expect(dist(chunk.x, chunk.y, 50, 0)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS + 1e-9);
        // The D7 formula and the floor agree: max(floor, unFloored) === floor.
        expect(Math.max(floor, unFloored)).toBeCloseTo(floor, 6);
        expect(chunk.volume).toBeCloseTo(floor, 6);
    });

    it('DATA GUARD (BUG-136 root cause): each channel-damage action declares dropMaterialChunk AFTER its damage consequence in data/actions.json', () => {
        const cases = [
            ['droid punch', 'damageComponent'],
            ['cut', 'damageComponent'],
            ['shootT1', 'consumeItemAndDamage']
        ];
        for (const [actionName, damageType] of cases) {
            const cons = actions[actionName]?.consequences;
            expect(cons, `${actionName} should declare consequences in data/actions.json`).toBeTruthy();
            const types = cons.map((c) => c.type);
            const damageIdx = types.indexOf(damageType);
            const dropIdx = types.indexOf('dropMaterialChunk');
            expect(damageIdx, `${actionName} should declare its ${damageType} damage consequence`).toBeGreaterThanOrEqual(0);
            expect(
                dropIdx,
                `${actionName} must declare the dropMaterialChunk consequence (BUG-136 root cause: a missing declaration means no chunks ever drop)`
            ).toBeGreaterThanOrEqual(0);
            expect(
                dropIdx,
                `${actionName}'s dropMaterialChunk must be positioned AFTER its damage consequence (the drop consumes the loss the damage step publishes — order matters)`
            ).toBeGreaterThan(damageIdx);
            expect(cons[dropIdx].target, 'the drop consequence targets the target (chunks originate from the target\'s matter)').toBe('target');
        }
    });
});

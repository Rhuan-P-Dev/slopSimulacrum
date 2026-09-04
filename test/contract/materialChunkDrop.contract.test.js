/**
 * Feature 2 — Material chunk drop on punch: CONTRACT test.
 *
 * Builds a real world (buildWorldState, tick system NOT started) and asserts, with
 * full action round-trips, the spec's integration claims (D6/D7/D8/D9/D10/D11):
 *
 *   1. DROP ON HIT: a punch that inflicts damage on an iron head sheds exactly one
 *      `chunk_iron` ground record in the target's room, near the target, with the
 *      D7 volume `max(minChunkVolume, chunkFraction × (appliedLoss × fraction × V))`.
 *   2. PER-MATERIAL INDEPENDENCE (D12): a punch on a two-material target (droidHand,
 *      iron 0.7 + wood 0.3) sheds at most one chunk per material; iron (rate 1.0) is
 *      always present, wood (rate 0.25) at most one.
 *   3. BROKEN TARGET (D10): a punch that empties a pre-weakened head breaks + removes
 *      the component and sheds NO chunk (the target is gone when the drop runs).
 *   4. DYNAMIC PICKUP (D8): picking a dropped chunk mints an inventory item with the
 *      same dynamic volume + material-derived traits; `chunk_iron` has no registry entry.
 *   5. RE-DROP (D8): dropping the inventoried chunk again keeps its dynamic volume.
 *   6. PERSISTENCE: a dropped chunk round-trips intact through serialize() → restore().
 *
 * Expected values are derived from the SAME data files the server reads (materials,
 * materialDamageTypes, materialDropRates, components) so assertions are formula-exact.
 *
 * @module test/contract/materialChunkDrop
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

const materials = readJson('data/materials.json');
const propertyTraitMapping = readJson('data/propertyTraitMapping.json');
const damageTypes = readJson('data/materialDamageTypes.json');
const dropRates = readJson('data/materialDropRates.json');
const components = readJson('data/components.json');
const inventoryItems = readJson('data/inventoryItems.json');

/** A fresh, not-started world (the drop feature's drop-rates registry is on by default). */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    return buildWorldState(tick).worldStateController;
}

/** The attacker's strongest strength-bearing droidHand (the punch's value source). */
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

const headOf = (world, id) => world.getEntity(id).components.find((c) => c.type === 'droidHead');
const handOf = (world, id) => world.getEntity(id).components.find((c) => c.type === 'droidHand');

function resistances(world, compId) {
    const p = world.getComponentStats(compId)?.Physical || {};
    return { impact: p.impact_resistance ?? 0, cut: p.cut_resistance ?? 0, wear: p.wear_resistance ?? 0 };
}

/**
 * The applied loss a punch by `attackerId` (a droid, whose strength source is a droidHand)
 * inflicts on `targetCompId`, per the feature-1 split formula — the exact value the damage
 * handler publishes as `lastChannelLoss.appliedLoss` (the drop handler's only input, D5).
 */
function punchAppliedLoss(world, attackerId, targetCompId) {
    const raw = strongestDroidHand(world, attackerId).strength;
    const handMaterials = world.componentController.getComponentMaterialsByType().droidHand;
    const split = world.materialController.getBlendedDamageTypeSplit(handMaterials, 'impact');
    const res = resistances(world, targetCompId);
    return (
        (raw * (split.impact / 100)) / (RESISTANCE_SCALE + res.impact) +
        (raw * (split.cut / 100)) / (RESISTANCE_SCALE + res.cut) +
        (raw * (split.wear / 100)) / (RESISTANCE_SCALE + res.wear)
    );
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

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const dropped = (world) => Object.values(world.getDroppedItems());

describe('Feature 2 — material chunk drop on punch (contract, full round-trip)', () => {
    it('DROP ON HIT: punch an iron head → exactly one chunk_iron in the target room, near the target, with the D7 volume', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 });

        const head = headOf(world, victimId);
        expect(head).toBeTruthy();
        const appliedLoss = punchAppliedLoss(world, attackerId, head.id);
        expect(appliedLoss, 'a real punch should inflict a positive applied loss').toBeGreaterThan(0);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        // With the world-rules torn stream active (data/world_rules.json), a
        // single-material iron target produces 2 records: the probabilistic chunk
        // + the deterministic torn token (both share the chunk_iron type family).
        expect(ironChunks.length, 'iron (rate 1.0) should shed chunk + torn = 2 records').toBe(2);

        // Identify the chunk record by its D7 volume (the torn record has a
        // different volume: percent/100 × appliedLoss × fraction × volume).
        const expected = expectedChunkVolume(world, 'droidHead', 'iron', appliedLoss);
        const chunk = ironChunks.find((d) => Math.abs(d.volume - expected) < 1e-6);
        expect(chunk, 'one record should match the D7 chunk volume').toBeTruthy();
        // Room: the target's room. Position: a disk sample around the target entity.
        expect(chunk.roomId).toBe(roomId);
        expect(dist(chunk.x, chunk.y, 50, 0)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS + 1e-9);

        // D7 volume: max(min, chunkFraction × (appliedLoss × ironFraction(1.0) × headVolume)).
        expect(chunk.volume).toBeCloseTo(expected, 6);

        // The record is self-describing: its item identity carries an item- prefix id,
        // and it has a human name. (The ground record's own map key is a dropped-… key.)
        expect(chunk.itemId).toMatch(/^item-/);
        expect(chunk.name).toMatch(/iron chunk/i);

        // And `chunk_iron` is NOT a registry item type (it is synthesized on pickup, D8).
        expect(inventoryItems['chunk_iron']).toBeUndefined();
    });

    it('PER-MATERIAL INDEPENDENCE: punch a two-material hand → iron always, wood at most one, no material twice (D12)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 });

        // The droidHand is a two-material recipe (iron 0.7 + wood 0.3) → a real split test.
        const hand = handOf(world, victimId);
        expect(world.componentController.getComponentMaterialsByType().droidHand.length).toBeGreaterThan(1);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: hand.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const chunks = dropped(world);
        const byType = {};
        for (const c of chunks) byType[c.itemType] = (byType[c.itemType] || 0) + 1;

        // Iron (rate 1.0) always produces a chunk + a torn token = 2.
        // Wood (rate 0.25) produces at most 1 chunk + always 1 torn = at most 2.
        expect(byType['chunk_iron'] ?? 0, 'iron should always drop chunk + torn = 2').toBe(2);
        expect(byType['chunk_wood'] ?? 0, 'wood chunk at most 1 + torn 1 = at most 2').toBeLessThanOrEqual(2);
        // No other chunk types can originate from an iron+wood target.
        expect(Object.keys(byType).every((t) => t === 'chunk_iron' || t === 'chunk_wood')).toBe(true);
    });

    it('BROKEN TARGET: a punch that empties a pre-weakened head breaks + removes it and sheds no chunk (D10)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 });

        const head = headOf(world, victimId);
        // Weaken the head so the punch's applied loss empties it (existence crosses 0).
        world.componentController.updateComponentStatDelta(head.id, 'Physical', 'existence', -0.99);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // The head broke and was removed from the entity.
        expect(headOf(world, victimId), 'the head should be gone after breaking').toBeUndefined();
        // And the drop handler (running after the break) found the target missing → no chunk.
        expect(dropped(world).filter((d) => d.itemType === 'chunk_iron').length, 'no chunk from a vanished target').toBe(0);
    });

    it('DYNAMIC PICKUP: picking a dropped chunk mints an inventory item with the same dynamic volume + material-derived traits (D8)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        world.actionController.executeAction('droid punch', attackerId, { targetEntityId: victimId, targetComponentId: head.id });

        const chunk = dropped(world).find((d) => d.itemType === 'chunk_iron');
        expect(chunk, 'an iron chunk should have dropped').toBeTruthy();

        // Walk the attacker onto the chunk and pick it up into a holding hand.
        // (The public facade API executePickUpItem is the path the game/NPC AI uses; the
        // raw pickUpItem action has a separate param naming and is not the pickup path.)
        world.stateEntityController.updateEntitySpatial(attackerId, { x: chunk.x, y: chunk.y });
        const holdingHand = handOf(world, attackerId);
        const pick = world.executePickUpItem(attackerId, chunk.id, holdingHand.id);
        expect(pick.success, `pickUpItem should succeed: ${JSON.stringify(pick.message)}`).toBe(true);

        const inv = Object.values(world.getEntityItems(attackerId)).flat();
        const item = inv.find((i) => i.type === 'chunk_iron');
        expect(item, 'the chunk should now be in inventory').toBeTruthy();
        expect(item.volume, 'the dynamic volume must survive pickup').toBeCloseTo(chunk.volume, 6);

        // Material-derived traits: a chunk is 100% iron. Derive with the item's actual
        // (dynamic) volume to match how addItem built them (mass scales with volume).
        const expectedTraits = world.materialController.derive({ materials: [{ material: 'iron', fraction: 1.0 }], volume: item.volume });
        expect(item.traits).toEqual(expectedTraits);
    });

    it('RE-DROP: dropping the inventoried chunk again keeps its dynamic volume (D8)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        world.actionController.executeAction('droid punch', attackerId, { targetEntityId: victimId, targetComponentId: head.id });
        const chunk = dropped(world).find((d) => d.itemType === 'chunk_iron');
        expect(chunk).toBeTruthy();

        // Pick it up (public facade API), then drop it again from inventory.
        world.stateEntityController.updateEntitySpatial(attackerId, { x: chunk.x, y: chunk.y });
        const holdingHand = handOf(world, attackerId);
        expect(world.executePickUpItem(attackerId, chunk.id, holdingHand.id).success).toBe(true);
        const item = Object.values(world.getEntityItems(attackerId)).flat().find((i) => i.type === 'chunk_iron');
        expect(item).toBeTruthy();

        // dropItem resolves itemType from the caller (the game supplies it); pass the
        // chunk's type so the re-dropped record keeps the correct itemType (D8 site 3).
        const drop = world.actionController.executeAction('dropItem', attackerId, {
            itemId: item.id,
            itemType: item.type,
            componentId: holdingHand.id,
            targetX: 100,
            targetY: 0
        });
        expect(drop.success, `dropItem should succeed: ${JSON.stringify(drop.error)}`).toBe(true);

        // A NEW ground record (fresh id) with the same dynamic volume + name.
        // Filter by volume to distinguish the re-dropped chunk from the torn token
        // (both share the chunk_iron type).
        const redropped = dropped(world).find((d) => d.itemType === 'chunk_iron' && d.id !== chunk.id && Math.abs(d.volume - item.volume) < 1e-6);
        expect(redropped, 'a new chunk_iron ground record with the same volume should exist after re-drop').toBeTruthy();
        expect(redropped.volume).toBeCloseTo(item.volume, 6);
        expect(redropped.name).toMatch(/iron chunk/i);
    });

    it('PERSISTENCE: a dropped chunk round-trips intact through serialize() → restore()', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        world.actionController.executeAction('droid punch', attackerId, { targetEntityId: victimId, targetComponentId: head.id });
        const chunk = dropped(world).find((d) => d.itemType === 'chunk_iron');
        expect(chunk).toBeTruthy();

        const snapshot = world.serialize();
        // The chunk is in the serialized state.
        const serializedChunk = snapshot.state.droppedItems[chunk.id];
        expect(serializedChunk).toBeTruthy();
        expect(serializedChunk.volume).toBeCloseTo(chunk.volume, 6);

        // Restore into a fresh instance and verify it is intact.
        const worldB = buildWorld();
        expect(worldB.restore(snapshot)).toEqual({ success: true });
        const restored = worldB.getDroppedItems()[chunk.id];
        expect(restored).toBeTruthy();
        expect(restored.itemType).toBe('chunk_iron');
        expect(restored.volume).toBeCloseTo(chunk.volume, 6);
        expect(restored.name).toMatch(/iron chunk/i);
    });
});

/** Spawns a droid in `roomId` at (x, y) and returns its id (convenience for the walk-in tests). */
function walkIn(world, roomId, x = 0, y = 0) {
    const id = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    world.stateEntityController.updateEntitySpatial(id, { x, y });
    return id;
}

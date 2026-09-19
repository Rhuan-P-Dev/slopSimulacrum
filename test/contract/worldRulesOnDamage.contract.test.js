/**
 * World Rules — onDamage event rule: CONTRACT test.
 *
 * Full round-trip with the shipped 5% `onDamage` rule (real facade via
 * buildWorldState, real data files). The Bernoulli seam
 * `world.onDamageDropListener._randomFn` is pinned per test:
 *   - `() => 0.01`  → the 5% trial succeeds (0.01 < 0.05),
 *   - `() => 1`     → the trial fails.
 * The legacy chunk/torn streams use their own Math.random and are untouched by
 * the seam — iron's dropRate is 1.0 (always) so its chunk is deterministic,
 * wood's 0.25 roll is only ever asserted in a bounded range (the same
 * discipline the torn suite uses).
 *
 * Covers the §7.5 behavior table:
 *   1. Roll success: non-lethal punch on a 100%-iron droidHead → the legacy
 *      chunk (D7), the torn token, AND the onDamage token (counts by volume).
 *   2. Roll failure: exactly the legacy records, no third record.
 *   3. Independence: all three streams present simultaneously; legacy volumes
 *      remain formula-exact (the onDamage stream did not perturb them).
 *   4. Largest-fraction selection on the two-material droidHand: the token is
 *      chunk_iron at the 0.7-fraction D7 volume — never wood.
 *   5. Non-channel source: a direct stat delta (no punch) drops a floor token.
 *   6. IC-turn source: a corrosiveGland corrosion turn drops a token with no
 *      punch/cut/shoot in between. The turn resolves the canonical flat
 *      `spatial.{x,y}` position straight from the entity store — no seeding.
 *   7. Lethal punch: the hook is silent on the total-loss hit (D10 mirror).
 *   8. Torn-rule regression: with the onDamage rule active the torn volume is
 *      still (10/100) × L × fraction × V and the chunk stream still rolls per
 *      materialDropRates.json.
 *   9. File degradation (missing): the file is really moved away (rename-based
 *      swap; the suite runs test FILES serially) → the world builds,
 *      getOnDamageRules() → [], and a punch is bit-identical to legacy.
 *  10. File degradation (malformed entry): a bogus entry is skipped (warn)
 *      while the torn rule stays active at 10%.
 *
 * @module test/contract/worldRulesOnDamage
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { DEFAULT_TRIGGER_RADIUS } from '../../src/utils/DiskSampler.js';
import { getDefinitionVolume } from '../../src/utils/definitionVolume.js';
import { channelLossFromResistance } from '../../src/utils/channelLoss.js';
import { computeChunkVolume } from '../../src/utils/materialChunkToken.js';
import { TRAIT_GROUPS, STAT_NAMES } from '../../shared/StatVocabulary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(projectRoot, rel), 'utf-8'));

const RESISTANCE_SCALE = 100;

const dropRates = readJson('data/materialDropRates.json');
const worldRules = readJson('data/world_rules.json');
const tornPercent = worldRules.rules.damageTornMaterial.percent;
const onDamagePercentage = worldRules.rules.onDamage[0].percentage;

const WORLD_RULES_PATH = path.join(projectRoot, 'data/world_rules.json');

/** A fresh, not-started world. NO seam pin here — the onDamage roll is the
 *  subject under test and each test pins `world.onDamageDropListener._randomFn`
 *  itself (the legacy streams' Math.random is untouched either way). */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    return { world, tick, turns: subControllers.turnSystemController };
}

/** The attacker's strongest strength-bearing droidHand. */
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

/** The expected applied existence loss of one (single-fist) punch, from the data. */
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

/** Expected torn volume for one material: (percent/100) × appliedLoss × fraction × V. */
function expectedTornVolume(world, targetCompType, material, appliedLoss) {
    const def = world.componentController.getComponentDefinition(targetCompType);
    const volume = getDefinitionVolume(def);
    const fraction = world.componentController.getComponentMaterialsByType()[targetCompType]
        .find((m) => m.material === material)?.fraction ?? 0;
    return (tornPercent / 100) * appliedLoss * fraction * volume;
}

/** Expected D7 chunk volume for one material (the shared helper, formula-exact). */
function expectedD7Volume(world, targetCompType, material, appliedLoss) {
    const def = world.componentController.getComponentDefinition(targetCompType);
    const volume = getDefinitionVolume(def);
    const fraction = world.componentController.getComponentMaterialsByType()[targetCompType]
        .find((m) => m.material === material)?.fraction ?? 0;
    return computeChunkVolume(
        world.materialController.getDropRate(material),
        appliedLoss,
        fraction,
        volume,
        world.materialController.getMinChunkVolume()
    );
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const dropped = (world) => Object.values(world.getDroppedItems());
const chunkRecords = (world) => dropped(world).filter((d) => d.itemType?.startsWith('chunk_'));

function walkIn(world, roomId, x = 0, y = 0) {
    const id = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    world.stateEntityController.updateEntitySpatial(id, { x, y });
    return id;
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
function closeRound(turns) {
    const state = turns.getRoundState();
    for (const pendingId of state.barrier.pendingEntityIds) {
        turns.signalPlanComplete(pendingId, 'player');
    }
    expect(turns.getRoundState().phase).toBe('resolution');
}

// =========================================================================
// File manipulation helpers (rename-based swaps; copied discipline from the
// torn-material suite — the file is re-read on every buildWorldState() call).
// =========================================================================
function hideWorldRulesFile() {
    if (fs.existsSync(WORLD_RULES_PATH + '.bak')) {
        throw new Error('data/world_rules.json.bak already exists — restore it before swapping the file');
    }
    fs.renameSync(WORLD_RULES_PATH, WORLD_RULES_PATH + '.bak');
}

function writeWorldRulesFile(content) {
    hideWorldRulesFile();
    fs.writeFileSync(WORLD_RULES_PATH + '.tmp', content);
    fs.renameSync(WORLD_RULES_PATH + '.tmp', WORLD_RULES_PATH);
}

function restoreWorldRulesFile() {
    // Idempotent: safe from the test's finally (primary), afterEach (net) and
    // afterAll (final guarantee).
    if (!fs.existsSync(WORLD_RULES_PATH + '.bak')) return;
    if (!fs.existsSync(WORLD_RULES_PATH)) {
        fs.renameSync(WORLD_RULES_PATH + '.bak', WORLD_RULES_PATH);
    } else {
        fs.copyFileSync(WORLD_RULES_PATH + '.bak', WORLD_RULES_PATH);
        fs.unlinkSync(WORLD_RULES_PATH + '.bak');
    }
}

// =========================================================================
// Tests
// =========================================================================
describe('World Rules — onDamage event rule (contract, full round-trip)', () => {
    beforeAll(() => { restoreWorldRulesFile(); });
    afterEach(() => { restoreWorldRulesFile(); });
    afterAll(() => { restoreWorldRulesFile(); });

    it('1. Roll success: punch a 100%-iron droidHead → legacy chunk (D7) + torn token + onDamage token (by counts)', () => {
        const { world } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01; // 0.01 < 0.05 → the trial succeeds

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        const L = punchAppliedLoss(world, attackerId, head.id);
        expect(L, 'a real punch should inflict a positive applied loss').toBeGreaterThan(0);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // The droidHead is 100% iron (single material, fraction 1.0):
        const d7 = expectedD7Volume(world, 'droidHead', 'iron', L);
        const torn = expectedTornVolume(world, 'droidHead', 'iron', L);
        const minChunk = dropRates.minChunkVolume;
        expect(torn, 'test data precondition: the torn token clears the gate').toBeGreaterThanOrEqual(minChunk);
        expect(d7, 'D7 volume and torn volume are distinct on this data').not.toBeCloseTo(torn, 9);

        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        const atD7 = ironChunks.filter((r) => Math.abs(r.volume - d7) < 1e-6);
        const atTorn = ironChunks.filter((r) => Math.abs(r.volume - torn) < 1e-6);
        // Exactly 3: the legacy chunk (rate 1.0 = always) + the torn token + the onDamage token.
        expect(ironChunks.length, 'chunk + torn + onDamage token').toBe(3);
        expect(atD7.length, 'the legacy chunk AND the onDamage token share the D7 volume').toBe(2);
        expect(atTorn.length, 'the torn token').toBe(1);

        // All three land in the victim's room, within its trigger disk.
        for (const r of ironChunks) {
            expect(r.roomId).toBe(roomId);
            expect(dist(r.x, r.y, 50, 0)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS + 1e-9);
        }
    });

    it('2. Roll failure: exactly the legacy records (chunk + torn), no third record', () => {
        const { world } = buildWorld();
        world.onDamageDropListener._randomFn = () => 1; // the trial always fails

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        const L = punchAppliedLoss(world, attackerId, head.id);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        // The pre-onDamage world shape: exactly the chunk (D7) + the torn token.
        expect(ironChunks.length, 'legacy only: chunk + torn').toBe(2);
        expect(ironChunks.filter((r) => Math.abs(r.volume - expectedD7Volume(world, 'droidHead', 'iron', L)) < 1e-6).length).toBe(1);
        expect(ironChunks.filter((r) => Math.abs(r.volume - expectedTornVolume(world, 'droidHead', 'iron', L)) < 1e-6).length).toBe(1);
    });

    it('3. Independence from the legacy drop: all three streams present; legacy volumes remain formula-exact', () => {
        const { world } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01;

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        const L = punchAppliedLoss(world, attackerId, head.id);
        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // Iron dropRate is 1.0 → the legacy chunk is always present, and its
        // volume is the D7 formula computed from the SAME applied loss the
        // onDamage stream saw — the new stream did not perturb the loss math.
        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        const d7 = expectedD7Volume(world, 'droidHead', 'iron', L);
        const torn = expectedTornVolume(world, 'droidHead', 'iron', L);
        expect(ironChunks.length, 'all three streams present simultaneously').toBe(3);
        expect(ironChunks.filter((r) => Math.abs(r.volume - d7) < 1e-6).length, 'two records at the formula-exact D7 volume').toBe(2);
        expect(ironChunks.filter((r) => Math.abs(r.volume - torn) < 1e-6).length, 'one record at the formula-exact torn volume').toBe(1);
    });

    it('4. Largest-fraction selection: punch the two-material droidHand → the token is chunk_iron at the 0.7-fraction volume, never wood', () => {
        const { world } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01;

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const hand = handOf(world, victimId);
        const handMats = world.componentController.getComponentMaterialsByType().droidHand;
        expect(handMats.length, 'the droidHand is a two-material composition').toBeGreaterThan(1);
        const primary = world.materialController.getPrimaryMaterial(handMats);
        expect(primary.material, 'the primary is the largest-fraction material (iron 0.7)').toBe('iron');

        const L = punchAppliedLoss(world, attackerId, hand.id);
        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: hand.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const minChunk = dropRates.minChunkVolume;
        // The onDamage token volume: max(minChunk, chunkFraction × L × 0.7 × V) —
        // identical to the legacy iron chunk volume (same formula, same fraction).
        const d7Iron = expectedD7Volume(world, 'droidHand', 'iron', L);

        const allDropped = dropped(world);
        const ironRecords = allDropped.filter((d) => d.itemType === 'chunk_iron');
        const woodRecords = allDropped.filter((d) => d.itemType === 'chunk_wood');

        // Exactly two chunk_iron at the D7 volume: the legacy chunk (rate 1.0)
        // + the onDamage token. The torn iron token (if above the gate) carries
        // a different volume and cannot be confused with either.
        expect(
            ironRecords.filter((r) => Math.abs(r.volume - d7Iron) < 1e-6).length,
            'legacy iron chunk + onDamage token, both at the 0.7-fraction D7 volume'
        ).toBe(2);
        // The onDamage token is never wood: any chunk_wood at the iron D7
        // volume would be impossible (different fraction), and the wood D7
        // volume (chunkFraction 0.5 × L × 0.3 × V) is a distinct value — the
        // wood records can only be the torn token (gate-gated) and/or the 0.25
        // roll chunk, never the onDamage token.
        const d7Wood = expectedD7Volume(world, 'droidHand', 'wood', L);
        expect(
            woodRecords.filter((r) => Math.abs(r.volume - d7Wood) < 1e-6).length,
            'wood: at most the 0.25-roll chunk (never the onDamage token)'
        ).toBeLessThanOrEqual(1);
        // Torn gate parity: torn wood is present exactly when it clears the gate.
        const tornWood = expectedTornVolume(world, 'droidHand', 'wood', L);
        expect(
            woodRecords.filter((r) => Math.abs(r.volume - tornWood) < 1e-6).length,
            'torn wood token follows the gate'
        ).toBe(tornWood >= minChunk ? 1 : 0);
    });

    it('5. Non-channel source (direct stat delta, no punch): a floor-volume token appears', () => {
        const { world } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01;

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = walkIn(world, roomId, 0, 0);
        const hand = handOf(world, entityId);
        const before = dropped(world).length;

        // No punch, no cut, no shoot: a plain stat weakening through the
        // public component API (the IC/holding-cost/stat-effect shape).
        const strengthBefore = world.getComponentStats(hand.id).Physical.strength;
        world.componentController.updateComponentStatDelta(hand.id, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH, -5);
        expect(world.getComponentStats(hand.id).Physical.strength).toBe(strengthBefore - 5);

        const newRecords = dropped(world).slice(before);
        expect(newRecords.length, 'exactly one floor token from the direct stat delta').toBe(1);
        const rec = newRecords[0];
        expect(rec.itemType, 'the token is the host primary material (iron, fraction 0.7)').toBe('chunk_iron');
        expect(rec.volume, 'a non-existence drop carries the nominal floor volume').toBeCloseTo(dropRates.minChunkVolume, 12);
        const entity = world.getEntity(entityId);
        expect(rec.roomId).toBe(roomId);
        expect(dist(rec.x, rec.y, entity.spatial.x, entity.spatial.y)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS + 1e-9);
    });

    it('6. IC-turn source: a corrosiveGland corrosion turn drops a token with no punch/cut/shoot in between', () => {
        const { world, tick, turns } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01;

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const hostId = walkIn(world, roomId, 0, 0);
        const victimId = walkIn(world, roomId, 10, 0);
        // Isolate: despawn every data-driven NPC so the ONLY other entity in
        // the gland's range is the victim (deterministic single damage event).
        const npcs = Object.values(world.stateEntityController.entities).filter((e) => e.isNPC === true);
        for (const npc of npcs) world.despawnEntity(npc.id);

        const hostEnt = world.stateEntityController.getEntity(hostId);
        const victimEnt = world.stateEntityController.getEntity(victimId);
        // The entity store keeps the canonical flat shape; the IC range check must
        // resolve it WITHOUT any phantom spatial.position field (regression guard
        // for the shape mismatch — see bugfixWiki BUG-137).
        expect(hostEnt.spatial.position, 'no phantom spatial.position on a stored entity').toBeUndefined();
        expect(victimEnt.spatial.position, 'no phantom spatial.position on a stored entity').toBeUndefined();

        // Install the real organ through the public install API.
        const hostComp = hostEnt.components[0];
        const installed = world.addInternalComponent(hostId, hostComp.id, 'corrosiveGland');
        expect(installed, 'the corrosiveGland must install').toBeTruthy();

        // The IC targets the victim's FIRST component through the corrosion
        // channel: expected loss = channelLossFromResistance(1, corrosion_resistance).
        const targetComp = victimEnt.components[0];
        const res = world.getComponentStats(targetComp.id)?.Physical?.corrosion_resistance ?? 0;
        const expectedLoss = channelLossFromResistance(1, res);
        expect(expectedLoss, 'the corrosion tick is a small non-lethal loss').toBeGreaterThan(0);
        expect(expectedLoss).toBeLessThan(1);

        const existenceBefore = world.getComponentStats(targetComp.id).Physical.existence;
        const before = dropped(world).length;

        // Round-0 start: gate closed, no corrosion, no drops.
        stepTo(world, tick, turns, 0);
        expect(world.getComponentStats(targetComp.id).Physical.existence).toBe(existenceBefore);
        expect(dropped(world).length).toBe(before);
        closeRound(turns, world, hostId);

        // Rounds 1–9: off-cadence (10 % interval), no corrosion, no drops.
        for (let round = 1; round <= 9; round++) {
            stepTo(world, tick, turns, round);
            expect(world.getComponentStats(targetComp.id).Physical.existence).toBe(existenceBefore);
            expect(dropped(world).length).toBe(before);
            closeRound(turns, world, hostId);
        }

        // Round-10 start: the corrosiveGland's intervalTurns cadence fires.
        stepTo(world, tick, turns, 10);

        const existenceAfter = world.getComponentStats(targetComp.id).Physical.existence;
        expect(existenceAfter, 'the corrosion tick dealt damage to the victim').toBeCloseTo(existenceBefore - expectedLoss, 12);

        const newRecords = dropped(world).slice(before);
        expect(newRecords.length, 'exactly one onDamage token — no punch/cut/shoot was involved').toBe(1);
        const rec = newRecords[0];
        const targetMats = world.componentController.getComponentMaterialsByType()[targetComp.type];
        const primary = world.materialController.getPrimaryMaterial(targetMats);
        expect(rec.itemType).toBe(`chunk_${primary.material}`);
        const def = world.componentController.getComponentDefinition(targetComp.type);
        const V = getDefinitionVolume(def);
        const expectedVolume = computeChunkVolume(
            world.materialController.getDropRate(primary.material),
            expectedLoss,
            primary.fraction,
            V,
            world.materialController.getMinChunkVolume()
        );
        expect(rec.volume).toBeCloseTo(expectedVolume, 9);
        expect(dist(rec.x, rec.y, 10, 0)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS + 1e-9);
    });

    it('6b. IC-turn range is room-bound: a victim in another room takes no corrosion damage', () => {
        const { world, tick, turns } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01;
        const startRoom = world.roomsController.getUidByLogicalId('start_room');
        const otherRoom = world.roomsController.getUidByLogicalId('right_room');
        const hostId = walkIn(world, startRoom, 0, 0);
        const victimId = walkIn(world, otherRoom, 0, 0); // local (0,0) — "adjacent" in local coords, different room
        const npcs = Object.values(world.stateEntityController.entities).filter((e) => e.isNPC === true);
        for (const npc of npcs) world.despawnEntity(npc.id);
        world.addInternalComponent(hostId, world.stateEntityController.getEntity(hostId).components[0].id, 'corrosiveGland');
        const victimEnt = world.stateEntityController.getEntity(victimId);
        const targetComp = victimEnt.components[0];
        const existenceBefore = world.getComponentStats(targetComp.id).Physical.existence;

        // Drive 11 real round starts (rounds 0–10) through the round-10 start:
        // the other-room victim is undamaged and sheds nothing.
        stepTo(world, tick, turns, 0);
        closeRound(turns, world, hostId);
        for (let round = 1; round <= 10; round++) {
            stepTo(world, tick, turns, round);
            closeRound(turns, world, hostId);
        }

        expect(world.getComponentStats(targetComp.id).Physical.existence, 'the other-room victim is undamaged at the round-10 start').toBe(existenceBefore);
        expect(dropped(world).length).toBe(0);
    });

    it('7. Lethal punch: the hook is silent on the total-loss hit (D10 mirror)', () => {
        const { world } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01;

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        // Weaken the head to a hair above death: this delta itself is a damage
        // event (non-lethal) → exactly one onDamage token, no legacy streams
        // (no punch yet).
        world.componentController.updateComponentStatDelta(head.id, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, -0.99);
        const afterWeaken = chunkRecords(world);
        expect(afterWeaken.length, 'the weakening delta drops one onDamage token').toBe(1);

        // The finishing punch drives existence <= 0: the break/removal cascade
        // owns the total loss → NO chunk, NO torn, NO onDamage token from the hit.
        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success).toBe(true);
        expect(headOf(world, victimId), 'the head should be gone after breaking').toBeUndefined();

        const afterPunch = chunkRecords(world);
        expect(afterPunch.length, 'the lethal hit adds zero chunk records (all three streams silent on total loss)')
            .toBe(afterWeaken.length);
    });

    it('8. Torn-rule regression: with the onDamage rule active, torn is still (10/100) × L × fraction × V and the chunk stream still rolls per rate', () => {
        const { world } = buildWorld();
        world.onDamageDropListener._randomFn = () => 0.01;

        // The rule file is the shipped one: torn active at 10, onDamage active.
        expect(world.worldRulesController.getDamageTornMaterialPercent()).toBe(tornPercent);
        expect(world.worldRulesController.getOnDamageRules()).toEqual(
            [{ drop: 'host_material', percentage: onDamagePercentage }]
        );

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        const L = punchAppliedLoss(world, attackerId, head.id);
        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        const torn = expectedTornVolume(world, 'droidHead', 'iron', L);
        const d7 = expectedD7Volume(world, 'droidHead', 'iron', L);
        // Torn volume is untouched by the new layer:
        expect(ironChunks.filter((r) => Math.abs(r.volume - torn) < 1e-6).length, 'the torn token is still formula-exact').toBe(1);
        // The chunk stream still rolls per materialDropRates.json (iron 1.0 →
        // always present, at its D7 volume):
        expect(ironChunks.filter((r) => Math.abs(r.volume - d7) < 1e-6).length, 'the rate-1.0 chunk is still present at D7').toBe(2);
    });

    it('9. File degradation (missing): world builds, getOnDamageRules() → [], punch bit-identical to legacy', () => {
        try {
            hideWorldRulesFile();
            const { world } = buildWorld();

            // The pipeline really saw the missing file.
            expect(world.worldRulesController.getOnDamageRules()).toEqual([]);
            expect(world.worldRulesController.getDamageTornMaterialPercent()).toBe(0);
            expect(world.getWorldRules()).toEqual({});

            const roomId = world.roomsController.getUidByLogicalId('start_room');
            const attackerId = walkIn(world, roomId, 0);
            const victimId = walkIn(world, roomId, 50);

            const head = headOf(world, victimId);
            const L = punchAppliedLoss(world, attackerId, head.id);
            const result = world.actionController.executeAction('droid punch', attackerId, {
                targetEntityId: victimId,
                targetComponentId: head.id
            });
            expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

            // Bit-identical to the pre-feature world: ONLY the legacy chunk
            // stream (iron rate 1.0) — no torn (rule off), no onDamage token.
            const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
            expect(ironChunks.length, 'legacy only: exactly one chunk_iron at the D7 volume').toBe(1);
            expect(ironChunks[0].volume).toBeCloseTo(expectedD7Volume(world, 'droidHead', 'iron', L), 6);
        } finally {
            restoreWorldRulesFile();
        }
    });

    it('10. File degradation (malformed entry): the bogus onDamage entry is skipped; the torn rule stays active at 10%', () => {
        const malformed = JSON.stringify({
            rules: {
                damageTornMaterial: { percent: tornPercent, enabled: true },
                onDamage: [{ drop: 'bogus', percentage: 4 }]
            }
        });
        try {
            writeWorldRulesFile(malformed);
            const { world } = buildWorld();

            // Per-entry tolerance: the entry is rejected (warn + skip), the
            // event is empty, and the torn rule is untouched.
            expect(world.worldRulesController.getOnDamageRules()).toEqual([]);
            expect(world.worldRulesController.getDamageTornMaterialPercent()).toBe(tornPercent);

            const roomId = world.roomsController.getUidByLogicalId('start_room');
            const attackerId = walkIn(world, roomId, 0);
            const victimId = walkIn(world, roomId, 50);

            const head = headOf(world, victimId);
            const L = punchAppliedLoss(world, attackerId, head.id);
            const result = world.actionController.executeAction('droid punch', attackerId, {
                targetEntityId: victimId,
                targetComponentId: head.id
            });
            expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

            // Exactly the torn-layer world: chunk (D7) + torn (10%) — the
            // malformed entry adds nothing.
            const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
            expect(ironChunks.length, 'chunk + torn only').toBe(2);
            expect(ironChunks.filter((r) => Math.abs(r.volume - expectedD7Volume(world, 'droidHead', 'iron', L)) < 1e-6).length).toBe(1);
            expect(ironChunks.filter((r) => Math.abs(r.volume - expectedTornVolume(world, 'droidHead', 'iron', L)) < 1e-6).length).toBe(1);
        } finally {
            restoreWorldRulesFile();
        }
    });
});

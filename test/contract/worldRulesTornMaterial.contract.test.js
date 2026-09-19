/**
 * World Rules — torn-material drop: CONTRACT test.
 *
 * Builds a real world (buildWorldState, tick system NOT started) and asserts, with
 * full action round-trips, the spec's integration claims (WR-2/WR-5):
 *
 *   1. Rule ON, deterministic drop: punch a single-material iron target non-lethally
 *      → exactly two `chunk_iron` ground records (the chunk + the torn at
 *      (10/100) × appliedLoss × 1.0 × V).
 *   2. Multi-material target: torn token set matches the formula AND the gate
 *      per material; chunk stream is exactly as before the layer existed.
 *   3. Missing file → legacy: zero torn records; chunk-drop behavior bit-identical.
 *   4. Empty file → legacy: same assertions as missing.
 *   5. Gate edge: torn volume below minChunkVolume → no torn records; chunk still appears.
 *   6. Broken target: lethal punch → no chunk AND no torn (D10 for both streams).
 *   7. Multi-attacker: two-fist punch → torn tokens per fist, each from its own loss.
 *   8. Determinism: identical hit in two fresh worlds → identical torn volumes.
 *   9. Persistence: torn ground record round-trips through serialize() → restore().
 *
 * Expected values are derived from the SAME data files the server reads (materials,
 * components, materialDropRates, world_rules) so assertions are formula-exact.
 *
 * @module test/contract/worldRulesTornMaterial
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { DEFAULT_TRIGGER_RADIUS } from '../../src/utils/DiskSampler.js';
import { getDefinitionVolume } from '../../src/utils/definitionVolume.js';
import { channelLossFromResistance } from '../../src/utils/channelLoss.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(projectRoot, rel), 'utf-8'));

const RESISTANCE_SCALE = 100;

const dropRates = readJson('data/materialDropRates.json');
const worldRules = readJson('data/world_rules.json');
const tornPercent = worldRules.rules.damageTornMaterial.percent;

const WORLD_RULES_PATH = path.join(projectRoot, 'data/world_rules.json');

/** A fresh, not-started world. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick).worldStateController;
    // Pin the onDamage Bernoulli stream (design §7.4): this suite asserts exact
    // torn/chunk ground-record counts, and the shipped 5% onDamage rule would
    // otherwise add a real probabilistic stream to the same worlds. Always-fail →
    // the world is identical to the pre-feature world; no assertion is modified.
    // (Tests that hide/empty the world_rules file are unaffected: the rule is off
    // there anyway, and the pin is harmless.)
    world.onDamageDropListener._randomFn = () => 1;
    return world;
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

/** All droidHand components on an entity (the multi-attacker path needs > 1). */
function droidHands(world, entityId) {
    const entity = world.getEntity(entityId);
    return (entity.components || []).filter((c) => c.type === 'droidHand');
}

const headOf = (world, id) => world.getEntity(id).components.find((c) => c.type === 'droidHead');
const handOf = (world, id) => world.getEntity(id).components.find((c) => c.type === 'droidHand');

function resistances(world, compId) {
    const p = world.getComponentStats(compId)?.Physical || {};
    return { impact: p.impact_resistance ?? 0, cut: p.cut_resistance ?? 0, wear: p.wear_resistance ?? 0 };
}

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
    // The handler's own volume source (getDefinitionVolume), for parity.
    const volume = getDefinitionVolume(def);
    const fraction = world.componentController.getComponentMaterialsByType()[targetCompType]
        .find((m) => m.material === material)?.fraction ?? 0;
    return (tornPercent / 100) * appliedLoss * fraction * volume;
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const dropped = (world) => Object.values(world.getDroppedItems());

function walkIn(world, roomId, x = 0, y = 0) {
    const id = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    world.stateEntityController.updateEntitySpatial(id, { x, y });
    return id;
}

// =========================================================================
// File manipulation helpers for the missing/empty file tests (spec §7.3/§7.4)
// =========================================================================
// Rename-based swaps (fs.renameSync is atomic on the same filesystem): the
// file is either present or it is not — no half-written intermediate state,
// and a byte-exact restore comes from the .bak itself.
function hideWorldRulesFile() {
    // Fail loud rather than corrupt: a pending .bak means a restore is already
    // outstanding (crashed prior run) — overwriting it would lose the original.
    if (fs.existsSync(WORLD_RULES_PATH + '.bak')) {
        throw new Error('data/world_rules.json.bak already exists — restore it before swapping the file');
    }
    fs.renameSync(WORLD_RULES_PATH, WORLD_RULES_PATH + '.bak');
}

function writeEmptyWorldRulesFile() {
    hideWorldRulesFile();
    // Write to .tmp then rename into place: the visible file is always either
    // the original (away in .bak) or a complete empty registry — never partial.
    fs.writeFileSync(WORLD_RULES_PATH + '.tmp', '{}');
    fs.renameSync(WORLD_RULES_PATH + '.tmp', WORLD_RULES_PATH);
}

function restoreWorldRulesFile() {
    // Idempotent: safe to call from the test's finally (primary), afterEach
    // (safety net), and afterAll (final guarantee) alike.
    if (!fs.existsSync(WORLD_RULES_PATH + '.bak')) return;
    if (!fs.existsSync(WORLD_RULES_PATH)) {
        fs.renameSync(WORLD_RULES_PATH + '.bak', WORLD_RULES_PATH);
    } else {
        fs.copyFileSync(WORLD_RULES_PATH + '.bak', WORLD_RULES_PATH);
        fs.unlinkSync(WORLD_RULES_PATH + '.bak');
    }
}

/**
 * Runs one degradation scenario end-to-end (spec §7.3/§7.4): swap the file
 * via `swapFile()`, build a fresh world (the composition root re-reads the
 * file on every buildWorldState() call — the loader has no cache), punch the
 * iron head, and assert the legacy chunk contract holds with the torn stream
 * entirely absent. The finally-restore is primary; the describe-level
 * afterEach/afterAll restores are idempotent safety nets.
 * @param {() => void} swapFile - hideWorldRulesFile or writeEmptyWorldRulesFile.
 */
function runLegacyFileScenario(swapFile) {
    try {
        swapFile();
        const world = buildWorld();

        // The pipeline really saw the swapped file: no active rules on the
        // controller, and the facade's getter degrades to the total empty
        // rule set (pins F1's aggregation shape).
        expect(world.worldRulesController.getDamageTornMaterialPercent()).toBe(0);
        expect(world.getWorldRules()).toEqual({});

        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        const appliedLoss = punchAppliedLoss(world, attackerId, head.id);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // Legacy chunk contract, bit-identical to the pre-feature behavior:
        // the droidHead is 100% iron and iron's dropRate is 1.0 (both from the
        // data files), so exactly one chunk_iron at the D7 volume — the torn
        // stream is absent, so there is nothing to confuse it with.
        const headMats = world.componentController.getComponentMaterialsByType().droidHead;
        const iron = headMats.find((m) => m.material === 'iron');
        const headVolume = getDefinitionVolume(world.componentController.getComponentDefinition('droidHead'));
        const expectedChunkVolume = Math.max(
            dropRates.minChunkVolume,
            dropRates.materials.iron.chunkFraction * appliedLoss * iron.fraction * headVolume
        );
        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        expect(ironChunks.length, 'legacy: exactly one chunk_iron (iron dropRate 1.0, torn stream absent)').toBe(1);
        expect(ironChunks[0].volume).toBeCloseTo(expectedChunkVolume, 6);
    } finally {
        restoreWorldRulesFile();
    }
}

// =========================================================================
// Tests
// =========================================================================
describe('World Rules — torn-material drop (contract, full round-trip)', () => {
    // File-swap teardown ordering (spec §7.3/§7.4): swap at test start →
    // assertions → finally-restore inside the test (primary) → afterEach
    // restore (idempotent net) → afterAll restore (final guarantee). The swap
    // is rename-based (see the helpers above), and the suite runs test FILES
    // serially (fileParallelism: false in vitest.config.js) because this file
    // is re-read on every buildWorldState() call (no loader cache) — no other
    // file may boot a world while it is away.
    beforeAll(() => {
        // A .bak left by a crashed prior run is a pending restore, not garbage:
        // clear it by restoring (never by deleting — the original file may only
        // exist in the .bak), so hideWorldRulesFile() can run and no test starts
        // on a half-swapped file.
        restoreWorldRulesFile();
    });
    afterEach(() => {
        restoreWorldRulesFile();
    });
    afterAll(() => {
        restoreWorldRulesFile();
    });

    it('1. Rule ON, deterministic drop: punch iron head → exactly two chunk_iron records (chunk + torn)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        expect(head).toBeTruthy();
        const appliedLoss = punchAppliedLoss(world, attackerId, head.id);
        expect(appliedLoss, 'a real punch should inflict a positive applied loss').toBeGreaterThan(0);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // The droidHead is 100% iron (single material, fraction 1.0).
        const ironChunks = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        // Exactly 2: one from the chunk stream (probabilistic, rate 1.0 = always) + one torn.
        expect(ironChunks.length, 'iron should produce exactly 2 chunk_iron records (chunk + torn)').toBe(2);

        // The torn record has the expected volume: (10/100) × appliedLoss × 1.0 × headVolume.
        const def = world.componentController.getComponentDefinition('droidHead');
        const headVolume = def?.form?.volume ?? def?.volume ?? 0;
        const expectedTorn = (tornPercent / 100) * appliedLoss * 1.0 * headVolume;

        // One of the two should match the torn volume (the other is the chunk volume).
        const tornRecord = ironChunks.find((c) => Math.abs(c.volume - expectedTorn) < 1e-6);
        expect(tornRecord, 'one chunk_iron should have the torn volume').toBeTruthy();
        expect(tornRecord.roomId).toBe(roomId);
        expect(dist(tornRecord.x, tornRecord.y, 50, 0)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS + 1e-9);
        expect(tornRecord.name).toMatch(/iron chunk/i);
        expect(tornRecord.itemId).toMatch(/^item-/);
    });

    it('2. Multi-material target: torn tokens per material (formula + gate); chunk stream unchanged', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        // droidHand is two-material: iron 0.7 + wood 0.3 (from the data file).
        const hand = handOf(world, victimId);
        const handMats = world.componentController.getComponentMaterialsByType().droidHand;
        expect(handMats.length).toBeGreaterThan(1);

        // One applied loss for the whole test, computed once from the data
        // files before the punch; V is the handler's own volume source
        // (getDefinitionVolume, shared with the chunk/torn pipeline).
        const L = punchAppliedLoss(world, attackerId, hand.id);
        expect(L, 'a real punch should inflict a positive applied loss').toBeGreaterThan(0);
        const V = getDefinitionVolume(world.componentController.getComponentDefinition('droidHand'));
        const minChunk = dropRates.minChunkVolume;

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: hand.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const allDropped = dropped(world);

        // Torn stream, per material (WR-2): the volume is formula-exact and the
        // gate (torn < minChunkVolume → nothing drops) decides presence per
        // material. Identifying a torn record by its formula volume is sound on
        // this data: the same material's chunk volume (max(minChunk,
        // 0.3·L·f·V)) can never coincide with its torn volume (0.1·L·f·V) at
        // the 1e-6 tolerance.
        for (const mat of handMats) {
            const tornI = expectedTornVolume(world, 'droidHand', mat.material, L);
            const records = allDropped.filter((d) => d.itemType === `chunk_${mat.material}`);
            const tornMatches = records.filter((r) => Math.abs(r.volume - tornI) < 1e-6);
            if (tornI >= minChunk) {
                expect(tornMatches.length, `torn ${mat.material} (above the gate) should appear exactly once at the formula volume`).toBe(1);
                expect(tornMatches[0].volume).toBeCloseTo(tornI, 6);
            } else {
                expect(tornMatches.length, `torn ${mat.material} (below the gate) should not appear`).toBe(0);
            }
        }

        // Chunk-stream independence: exactly as before the layer existed. Iron's
        // dropRate is 1.0 → its chunk is always present at its D7 volume.
        const ironFraction = handMats.find((m) => m.material === 'iron').fraction;
        const expectedIronChunk = Math.max(minChunk, dropRates.materials.iron.chunkFraction * L * ironFraction * V);
        const byType = {
            chunk_iron: allDropped.filter((d) => d.itemType === 'chunk_iron'),
            chunk_wood: allDropped.filter((d) => d.itemType === 'chunk_wood')
        };
        expect(byType.chunk_iron.some((r) => Math.abs(r.volume - expectedIronChunk) < 1e-6),
            'the iron chunk (rate 1.0) should be present at its D7 volume').toBe(true);
        expect(byType.chunk_iron.length, 'iron: exactly the chunk + the torn token').toBe(2);
        expect(byType.chunk_wood.length, 'wood: the torn token ± a 0.25-roll chunk').toBeGreaterThanOrEqual(1);
        expect(byType.chunk_wood.length).toBeLessThanOrEqual(2);
    });

    it('3. Missing file → legacy: zero torn records, chunk behavior bit-identical', () => {
        // Spec §7.3, end-to-end: the file is really moved away (rename-based
        // swap; serial file execution — see the describe comment) so the
        // composition root reads the missing file at this world's boot and the
        // world degrades to bit-identical legacy behavior.
        runLegacyFileScenario(hideWorldRulesFile);
    });

    it('4. Empty file → legacy: zero torn records', () => {
        // Spec §7.4: a present-but-empty registry degrades exactly like a
        // missing file — the same end-to-end scenario, the same assertions.
        runLegacyFileScenario(writeEmptyWorldRulesFile);
    });

    it('5. Gate edge: torn volume below minChunkVolume → no torn; chunk still appears', () => {
        // Deterministic sub-gate (no Math.random mocking, no break, no drain):
        // scale the attacker's fists down to the action's OWN strength floor
        // (the 'droid punch' requirement, read from data/actions.json) and punch
        // the victim's two-material droidHand (iron 0.7 + wood 0.3, from the data
        // files). At the floor, the applied loss is small enough that BOTH
        // materials' torn volumes fall below the shared minChunkVolume floor,
        // while the iron chunk stream (dropRate 1.0 — a separate lever) still
        // clears its own floor and drops. The head is NOT a usable target here:
        // on this data the floor-strength loss keeps the head's torn volume
        // (single material, f·V = 8) above the gate, so only the smaller f·V
        // composition can cross it.
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const hand = handOf(world, victimId);
        const minChunk = dropRates.minChunkVolume;
        const handMats = world.componentController.getComponentMaterialsByType().droidHand;
        const V = getDefinitionVolume(world.componentController.getComponentDefinition('droidHand'));

        // Non-vacuity: at full strength the iron torn volume clears the gate, so
        // crossing it is the scaling's effect, not a data accident.
        const L_base = punchAppliedLoss(world, attackerId, hand.id);
        const ironFraction = handMats.find((m) => m.material === 'iron').fraction;
        expect((tornPercent / 100) * L_base * ironFraction * V,
            'the full-strength iron torn volume should clear the gate').toBeGreaterThanOrEqual(minChunk);

        // The action's strength floor (data/actions.json) — the weakest legal punch.
        const strengthFloor = readJson('data/actions.json')['droid punch'].requirements
            .find((r) => r.trait === 'Physical' && r.stat === 'strength').minValue;
        const fists = droidHands(world, attackerId);
        expect(fists.length, 'the blueprint provides two droidHands').toBe(2);
        for (const fist of fists) {
            const strength = world.getComponentStats(fist.id)?.Physical?.strength;
            expect(strength, 'the fists start above the floor').toBeGreaterThan(strengthFloor);
            world.componentController.updateComponentStatDelta(fist.id, 'Physical', 'strength', strengthFloor - strength);
        }

        // The scaled loss: still a legal punch (the floor satisfies the
        // requirement), and — the sub-gate precondition, exact from the data —
        // every material's torn volume is below the shared floor.
        const L = punchAppliedLoss(world, attackerId, hand.id);
        expect(L, 'the scaled punch should inflict a positive applied loss').toBeGreaterThan(0);
        const subGate = handMats.map((m) => ({
            material: m.material,
            torn: (tornPercent / 100) * L * m.fraction * V
        }));
        for (const { material, torn } of subGate) {
            expect(torn, `torn ${material} at the floor-strength loss should be below the gate`).toBeLessThan(minChunk);
        }

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: hand.id
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);
        expect(world.getComponentStats(hand.id).Physical.existence, 'the floor-strength punch is non-lethal').toBeGreaterThan(0);

        // Torn stream: gated out per material — no record at any sub-gate torn
        // volume.
        const allDropped = dropped(world);
        for (const { material, torn } of subGate) {
            const records = allDropped.filter((d) => d.itemType === `chunk_${material}`);
            expect(records.filter((r) => Math.abs(r.volume - torn) < 1e-6).length,
                `no torn record for ${material} (below the gate)`).toBe(0);
        }

        // Chunk stream (independent lever): iron's dropRate is 1.0 → its chunk is
        // always present, at its D7 volume; wood's is a 0.25 roll → present at
        // its D7 volume or absent, never a torn.
        const d7 = (m) => {
            const cfg = dropRates.materials[m.material];
            return Math.max(minChunk, cfg.chunkFraction * L * m.fraction * V);
        };
        const ironRecords = allDropped.filter((d) => d.itemType === 'chunk_iron');
        expect(ironRecords.length, 'the iron chunk (rate 1.0) is present — exactly one record').toBe(1);
        expect(ironRecords[0].volume).toBeCloseTo(d7(handMats.find((m) => m.material === 'iron')), 6);
        const woodRecords = allDropped.filter((d) => d.itemType === 'chunk_wood');
        expect(woodRecords.length, 'wood: a 0.25-roll chunk, never a torn').toBeLessThanOrEqual(1);
        for (const r of woodRecords) {
            expect(r.volume).toBeCloseTo(d7(handMats.find((m) => m.material === 'wood')), 6);
        }
    });

    it('6. Broken target: lethal punch → no chunk AND no torn', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        world.componentController.updateComponentStatDelta(head.id, 'Physical', 'existence', -0.99);

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });
        expect(result.success).toBe(true);

        expect(headOf(world, victimId), 'the head should be gone after breaking').toBeUndefined();
        // No chunks AND no torn from a vanished target.
        expect(dropped(world).filter((d) => d.itemType === 'chunk_iron').length, 'no records from a vanished target').toBe(0);
    });

    it('7. Multi-attacker: two-fist punch → per-fist torn tokens, each from its own loss (D11)', () => {
        // The multi-attacker path only fires with two source droidHands (role
        // 'source' in componentIds). Each fist's drop step reads the loss its own
        // damage step published (per-attacker isolated context, spec D11): the
        // torn stream must mirror the chunk stream — one torn token per fist,
        // formula-exact from its own loss, never the aggregate. The per-fist loss
        // math replicates the damage handler's (synergy-scaled raw, sliced by the
        // fist's material blend, each slice through the per-channel loss ratio) —
        // the same reference the doublePunch channel-damage contract uses.
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const fists = droidHands(world, attackerId);
        expect(fists.length, 'the multi-attacker path needs two droidHands').toBe(2);

        // Differentiate the fists so their per-fist losses (and torn volumes) are
        // distinguishable — the proof that each torn token derives from its own
        // fist's loss, not a combined one.
        world.componentController.updateComponentStatDelta(fists[1].id, 'Physical', 'strength', 10);
        const strengths = fists.map((f) => world.getComponentStats(f.id)?.Physical?.strength);
        expect(Math.abs(strengths[0] - strengths[1]), 'the fists must have different strengths').toBeGreaterThan(0);

        const head = headOf(world, victimId);
        const res = resistances(world, head.id);
        const blend = world.materialController.getBlendedDamageTypeSplit(
            world.componentController.getComponentMaterialsByType().droidHand, 'impact');

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id,
            componentIds: fists.map((f) => ({ componentId: f.id, role: 'source' }))
        });
        expect(result.success, `two-fist punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        // Synergy: two same-type source components (minCount 2) → multiplier > 1,
        // applied to each fist's raw before the channel slicing.
        const synergyMult = result.synergy?.synergyMultiplier ?? 1.0;
        expect(synergyMult, 'two cooperating fists should yield a synergy multiplier above 1').toBeGreaterThan(1.0);

        const lossPerFist = strengths.map((s) =>
            channelLossFromResistance(s * synergyMult * (blend.impact / RESISTANCE_SCALE), res.impact) +
            channelLossFromResistance(s * synergyMult * (blend.cut / RESISTANCE_SCALE), res.cut) +
            channelLossFromResistance(s * synergyMult * (blend.wear / RESISTANCE_SCALE), res.wear)
        );

        // The head is a single-material recipe (100% iron, from the data file);
        // the per-fist torn volumes must clear the gate or the assertions below
        // would be vacuous.
        const V = getDefinitionVolume(world.componentController.getComponentDefinition('droidHead'));
        const ironFraction = world.componentController.getComponentMaterialsByType().droidHead
            .find((m) => m.material === 'iron').fraction;
        const tornPerFist = lossPerFist.map((l) => (tornPercent / 100) * l * ironFraction * V);
        for (const t of tornPerFist) {
            expect(t, 'each fist\'s torn volume should clear the gate').toBeGreaterThanOrEqual(dropRates.minChunkVolume);
        }
        expect(Math.abs(tornPerFist[0] - tornPerFist[1]), 'the per-fist torn volumes should differ').toBeGreaterThan(1e-9);

        // One drop step per attacker; each fist's torn stream is formula-exact.
        const dropResults = result.results.filter((r) => r.type === 'dropMaterialChunk');
        expect(dropResults.length, 'one dropMaterialChunk result should run per attacker').toBe(2);
        for (let i = 0; i < 2; i++) {
            expect(dropResults[i].success, `fist ${i + 1}'s drop step should succeed`).toBe(true);
            expect(dropResults[i].data.tornDropped, `fist ${i + 1} should drop exactly one torn token`).toBe(1);
            expect(dropResults[i].data.tornVolumes?.['chunk_iron'], `fist ${i + 1}'s torn volume should be formula-exact`)
                .toBeCloseTo(tornPerFist[i], 6);
        }

        // Ground: one chunk + one torn per fist = four; each torn volume appears
        // exactly once, and no record may carry the aggregate (combined-fists)
        // torn volume — the torn stream is per-fist, never merged.
        const iron = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        expect(iron.length, 'one chunk + one torn per fist — four total').toBe(4);
        for (let i = 0; i < 2; i++) {
            expect(iron.filter((r) => Math.abs(r.volume - tornPerFist[i]) < 1e-6).length,
                `fist ${i + 1}'s torn volume should appear exactly once on the ground`).toBe(1);
        }
        const aggregateTorn = (tornPercent / 100) * (lossPerFist[0] + lossPerFist[1]) * ironFraction * V;
        for (const r of iron) {
            expect(Math.abs(r.volume - aggregateTorn), 'no torn record may carry the aggregate volume').toBeGreaterThan(1e-6);
        }
    });

    it('8. Determinism: identical hit in two fresh worlds → identical torn volumes', () => {
        const worldA = buildWorld();
        const roomA = worldA.roomsController.getUidByLogicalId('start_room');
        const attackerA = walkIn(worldA, roomA, 0);
        const victimA = walkIn(worldA, roomA, 50);
        const headA = headOf(worldA, victimA);
        worldA.actionController.executeAction('droid punch', attackerA, {
            targetEntityId: victimA,
            targetComponentId: headA.id
        });
        const tornA = dropped(worldA)
            .filter((d) => d.itemType === 'chunk_iron')
            .map((d) => d.volume)
            .sort((a, b) => a - b);

        const worldB = buildWorld();
        const roomB = worldB.roomsController.getUidByLogicalId('start_room');
        const attackerB = walkIn(worldB, roomB, 0);
        const victimB = walkIn(worldB, roomB, 50);
        const headB = headOf(worldB, victimB);
        worldB.actionController.executeAction('droid punch', attackerB, {
            targetEntityId: victimB,
            targetComponentId: headB.id
        });
        const tornB = dropped(worldB)
            .filter((d) => d.itemType === 'chunk_iron')
            .map((d) => d.volume)
            .sort((a, b) => a - b);

        // The torn volumes must be identical (deterministic). Note: the chunk volumes
        // may differ (probabilistic), but the torn volumes (always present, same formula)
        // must match. We compare the sorted lists — the torn record is the one whose
        // volume matches the formula exactly.
        // Since both worlds produce the same appliedLoss (same data, same blueprint),
        // the torn volumes are identical. The chunk volumes may differ (random roll),
        // but the torn volume is deterministic. We verify the torn volumes match by
        // checking that at least one volume in both lists matches the expected formula.
        const def = worldA.componentController.getComponentDefinition('droidHead');
        const headVolume = def?.form?.volume ?? def?.volume ?? 0;
        const appliedLossA = punchAppliedLoss(worldA, attackerA, headA.id);
        const expectedTorn = (tornPercent / 100) * appliedLossA * 1.0 * headVolume;

        const tornInA = tornA.find((v) => Math.abs(v - expectedTorn) < 1e-6);
        const tornInB = tornB.find((v) => Math.abs(v - expectedTorn) < 1e-6);
        expect(tornInA, 'world A should have a torn record at the expected volume').toBeTruthy();
        expect(tornInB, 'world B should have a torn record at the same volume').toBeTruthy();
        expect(tornInB).toBeCloseTo(tornInA, 10);
    });

    it('9. Persistence: a torn ground record round-trips through serialize() → restore()', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = walkIn(world, roomId, 0);
        const victimId = walkIn(world, roomId, 50);

        const head = headOf(world, victimId);
        world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: head.id
        });

        const allIron = dropped(world).filter((d) => d.itemType === 'chunk_iron');
        expect(allIron.length, 'should have at least one chunk_iron record').toBeGreaterThan(0);

        // Pick one record to verify persistence.
        const target = allIron[0];
        const snapshot = world.serialize();
        const serializedRec = snapshot.state.droppedItems[target.id];
        expect(serializedRec, 'the record should be in the serialized state').toBeTruthy();
        expect(serializedRec.volume).toBeCloseTo(target.volume, 6);

        const worldB = buildWorld();
        expect(worldB.restore(snapshot)).toEqual({ success: true });
        const restored = worldB.getDroppedItems()[target.id];
        expect(restored).toBeTruthy();
        expect(restored.itemType).toBe('chunk_iron');
        expect(restored.volume).toBeCloseTo(target.volume, 6);
        expect(restored.name).toMatch(/iron chunk/i);
    });
});

/**
 * BUG-133 / BUG-134 — Two-fist droid punch: channel damage + per-fist chunk drops: CONTRACT test.
 *
 * The two-fist case is the ONLY combat path routed through the multi-attacker
 * consequence builder (executeMultiAttacker). BUG-133 fixed that path's damage
 * (the builder had been written for the legacy stat-delta model, dropping the
 * `channel` field and sign-flipping the value, which zeroed the damage). BUG-134
 * completed the feature: each fist now drops its OWN chunks from its OWN applied
 * loss (spec D11, revised) — two independent rolls, never one aggregate — while
 * the path's no-propagation rule for every other handler-modified param is
 * preserved.
 *
 * This test builds a real world, spawns a droid with two droidHand fists, and
 * executes 'droid punch' with BOTH fist componentIds (role 'source') + a
 * targetComponentId — the exact routing condition that triggers
 * executeMultiAttacker (attackerComponentIds.length > 1 && targetComponentId).
 *
 * The expected values are derived from the SAME data files the server reads
 * (materials, materialDamageTypes, materialDropRates, components) so the
 * assertions are formula-exact rather than guessed. The synergy multiplier is
 * read from the action result itself (not hardcoded). Drop rolls are forced
 * deterministically the same way the spec's test plan prescribes: drop rates of
 * 1.0 (always) from the data file, and a stubbed Math.random sequence for the
 * per-roll independence case (the established unit-test pattern).
 *
 * @module test/contract/doublePunchChannelDamage
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { RESISTANCE_SCALE, channelLossFromResistance } from '../../src/utils/channelLoss.js';
import { getDefinitionVolume } from '../../src/utils/definitionVolume.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8'));

const dropRates = readJson('data/materialDropRates.json');

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

/** The victim's first finger component — a single-material (wood) chunk target. */
function victimFinger(world, entityId) {
    return world.getEntity(entityId).components.find((c) => c.type === 'humanoidDroidFinger');
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

/** Spawns attacker + victim droids in the start room and returns their ids. */
function spawnPunchers(world) {
    const roomId = world.roomsController.getUidByLogicalId('start_room');
    const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
    world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 }); // well within punch range (100)
    return { attackerId, victimId, roomId };
}

/** Executes the two-fist punch through the public action API. */
function punchTwoFists(world, attackerId, victimId, fists, targetComponentId) {
    return world.actionController.executeAction('droid punch', attackerId, {
        targetEntityId: victimId,
        targetComponentId,
        componentIds: fists.map(f => ({ componentId: f.id, role: 'source' }))
    });
}

/** The per-fist applied loss formula — identical to the damage handler's math (test 1). */
function expectedLossPerAttacker(world, strength, synergyMult, blend, res) {
    return (
        channelLossFromResistance(strength * synergyMult * (blend.impact / RESISTANCE_SCALE), res.impact) +
        channelLossFromResistance(strength * synergyMult * (blend.cut / RESISTANCE_SCALE), res.cut) +
        channelLossFromResistance(strength * synergyMult * (blend.wear / RESISTANCE_SCALE), res.wear)
    );
}

/** D7 chunk volume for one material, given an applied loss and the target recipe. */
function expectedChunkVolume(world, targetType, material, appliedLoss) {
    const def = world.componentController.getComponentDefinition(targetType);
    const volume = getDefinitionVolume(def);
    const fraction = world.componentController.getComponentMaterialsByType()[targetType]
        .find((m) => m.material === material)?.fraction ?? 0;
    const lost = appliedLoss * fraction * volume;
    const config = dropRates.materials[material];
    return Math.max(dropRates.minChunkVolume, config.chunkFraction * lost);
}

const dropped = (world) => Object.values(world.getDroppedItems());

afterEach(() => {
    vi.restoreAllMocks();
});

describe('BUG-133 — two-fist punch channel damage (contract, full round-trip)', () => {
    it('two-fist punch: both fists deal synergy-scaled channel damage (formula-exact)', () => {
        const world = buildWorld();
        const { attackerId, victimId } = spawnPunchers(world);

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
        const result = punchTwoFists(world, attackerId, victimId, fists, head.id);

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
        const totalExpectedLoss = expectedLossPerAttacker(world, strengths[0], synergyMult, blend, res)
            + expectedLossPerAttacker(world, strengths[1], synergyMult, blend, res);

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
});

describe('BUG-134 — two-fist punch per-fist chunk drops (spec D11, revised)', () => {
    it('each fist drops its own chunks from its own loss — never the aggregate (per-fist volumes are formula-exact)', () => {
        const world = buildWorld();
        const { attackerId, victimId } = spawnPunchers(world);

        const fists = droidHands(world, attackerId);
        expect(fists.length, 'attacker must have two droidHands for the multi-attacker path').toBe(2);

        // Differentiate the fists so their per-fist losses (and thus chunk volumes)
        // are distinguishable — the proof that each chunk derives from its own fist's
        // loss, not a combined one. Strength is a stored stat here (the tick system is
        // not started, so the manual delta sticks for the duration of the test).
        world.componentController.updateComponentStatDelta(fists[1].id, 'Physical', 'strength', 10);
        const strengths = fists.map(f => world.getComponentStats(f.id)?.Physical?.strength);
        expect(Math.abs(strengths[0] - strengths[1]), 'the fists must have different strengths for this test').toBeGreaterThan(0);

        const head = victimHead(world, victimId);
        const res = channelResistances(world, head.id);
        const blend = droidHandBlend(world);

        const result = punchTwoFists(world, attackerId, victimId, fists, head.id);
        expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const synergyMult = result.synergy?.synergyMultiplier ?? 1.0;
        const lossPerFist = strengths.map(s => expectedLossPerAttacker(world, s, synergyMult, blend, res));

        // The head is 100% iron and iron's drop rate is 1.0 (always drops, from the
        // data file — the same deterministic pattern as the single-attacker test), so
        // BOTH fists drop exactly one chunk each: two independent rolls, two chunks.
        const ironConfig = dropRates.materials.iron;
        expect(ironConfig.dropRate, 'iron should be an always-drop material for deterministic tests').toBe(1.0);

        const dropResults = result.results.filter(r => r.type === 'dropMaterialChunk');
        expect(dropResults.length, 'one dropMaterialChunk result should run per attacker').toBe(2);
        for (let i = 0; i < 2; i++) {
            expect(dropResults[i].success, `fist ${i + 1}'s drop should succeed`).toBe(true);
            expect(dropResults[i].data.droppedChunks, `fist ${i + 1} should drop exactly one chunk`).toBe(1);
            expect(dropResults[i].data.chunkVolumes['chunk_iron'], `fist ${i + 1}'s chunk volume should be formula-exact`)
                .toBeCloseTo(expectedChunkVolume(world, 'droidHead', 'iron', lossPerFist[i]), 6);
        }

        // Exactly two ground items, one per fist (no combined/aggregate chunk).
        const ironChunks = dropped(world).filter(d => d.itemType === 'chunk_iron');
        expect(ironChunks.length, 'exactly one chunk per fist — two total').toBe(2);

        // The two volumes differ (the fists had different strengths), and neither
        // equals what an AGGREGATE loss (lossA + lossB) would have produced.
        const expectedVolumes = lossPerFist.map(l => expectedChunkVolume(world, 'droidHead', 'iron', l));
        const actualVolumes = ironChunks.map(c => c.volume).sort((a, b) => a - b);
        const sortedExpected = [...expectedVolumes].sort((a, b) => a - b);
        for (let i = 0; i < 2; i++) {
            expect(actualVolumes[i], `ground chunk ${i + 1} should match a per-fist volume`).toBeCloseTo(sortedExpected[i], 6);
        }
        expect(Math.abs(expectedVolumes[0] - expectedVolumes[1]), 'the two per-fist volumes should differ').toBeGreaterThan(1e-9);
        const aggregateVolume = expectedChunkVolume(world, 'droidHead', 'iron', lossPerFist[0] + lossPerFist[1]);
        for (const v of actualVolumes) {
            expect(Math.abs(v - aggregateVolume), 'no chunk may carry the aggregate (combined-fists) volume').toBeGreaterThan(1e-6);
        }
    });

    it('per-roll independence: fist A\'s roll succeeds, fist B\'s fails → exactly one chunk (forced roll outcomes)', () => {
        const world = buildWorld();
        const { attackerId, victimId } = spawnPunchers(world);

        const fists = droidHands(world, attackerId);
        expect(fists.length, 'attacker must have two droidHands for the multi-attacker path').toBe(2);

        // A single-material (100% wood) target: wood's drop rate (0.25, from the data
        // file) is < 1, so per-roll outcomes can be forced. Each fist's drop step
        // performs exactly one roll (one material) plus — only if that roll succeeds —
        // two disk-sample draws for the chunk's ground position. Forcing fist A's roll
        // to succeed and fist B's to fail therefore consumes exactly four draws:
        // [A roll, A angle, A radius, B roll].
        const finger = victimFinger(world, victimId);
        expect(finger, 'victim must have a wood finger as the chunk target').toBeTruthy();
        expect(world.componentController.getComponentMaterialsByType().humanoidDroidFinger)
            .toEqual([{ material: 'wood', fraction: 1.0 }]);

        const res = channelResistances(world, finger.id);
        const blend = droidHandBlend(world);
        const strengthA = world.getComponentStats(fists[0].id)?.Physical?.strength;

        const queue = [0.1, 0.5, 0.5, 0.9]; // A: 0.1 < 0.25 (success), B: 0.9 ≥ 0.25 (fail)
        const realRandom = Math.random;
        vi.spyOn(Math, 'random').mockImplementation(() => (queue.length ? queue.shift() : realRandom()));

        try {
            const result = punchTwoFists(world, attackerId, victimId, fists, finger.id);
            expect(result.success, `punch should succeed: ${JSON.stringify(result.error)}`).toBe(true);
            expect(queue.length, 'all four forced draws must be consumed (one success path, one fail path)').toBe(0);

            const dropResults = result.results.filter(r => r.type === 'dropMaterialChunk');
            expect(dropResults.length, 'one dropMaterialChunk result should run per attacker').toBe(2);
            expect(dropResults[0].data.droppedChunks, 'fist A\'s forced-success roll should drop one chunk').toBe(1);
            expect(dropResults[1].data.droppedChunks, 'fist B\'s forced-fail roll should drop nothing').toBe(0);

            // Exactly ONE chunk in the world — from fist A's own loss only.
            const woodChunks = dropped(world).filter(d => d.itemType === 'chunk_wood');
            expect(woodChunks.length, 'exactly one chunk total: A succeeds, B fails').toBe(1);

            const synergyMult = result.synergy?.synergyMultiplier ?? 1.0;
            const lossA = expectedLossPerAttacker(world, strengthA, synergyMult, blend, res);
            expect(woodChunks[0].volume, 'the lone chunk\'s volume derives from fist A\'s loss only')
                .toBeCloseTo(expectedChunkVolume(world, 'humanoidDroidFinger', 'wood', lossA), 6);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('feature off (empty drop-rates file): two-fist punch still deals damage but drops no chunks, no crash', () => {
        const world = buildWorld();
        const { attackerId, victimId } = spawnPunchers(world);

        // Simulate the empty/absent data/materialDropRates.json: the MaterialController's
        // feature-off behavior (verified in the unit tests) is exactly that these two
        // public accessors report null/0. Stubbing them on the built world reproduces
        // that degradation without touching the real data file.
        vi.spyOn(world.materialController, 'getDropRate').mockReturnValue(null);
        vi.spyOn(world.materialController, 'getMinChunkVolume').mockReturnValue(0);

        try {
            const fists = droidHands(world, attackerId);
            expect(fists.length, 'attacker must have two droidHands for the multi-attacker path').toBe(2);

            const head = victimHead(world, victimId);
            const beforeGroundCount = Object.keys(world.getDroppedItems()).length;
            const beforeExistence = world.getComponentStats(head.id).Physical.existence;

            const result = punchTwoFists(world, attackerId, victimId, fists, head.id);
            expect(result.success, `punch should succeed with the drop feature off`).toBe(true);

            // Damage is a separate feature (materialDamageTypes) and must be untouched:
            // the head's existence still drops.
            expect(world.getComponentStats(head.id).Physical.existence, 'damage must still apply with drops disabled')
                .toBeLessThan(beforeExistence);

            // And no chunks anywhere: each per-fist drop sees no drop-rates entry.
            const dropResults = result.results.filter(r => r.type === 'dropMaterialChunk');
            expect(dropResults.length, 'one dropMaterialChunk result should still run per attacker').toBe(2);
            for (const r of dropResults) {
                expect(r.success, 'the drop step must still succeed (graceful degradation)').toBe(true);
                expect(r.data.droppedChunks, 'no chunks when the drop-rates feature is off').toBe(0);
            }
            expect(Object.keys(world.getDroppedItems()).length, 'no new ground items with the feature off')
                .toBe(beforeGroundCount);
        } finally {
            vi.restoreAllMocks();
        }
    });
});

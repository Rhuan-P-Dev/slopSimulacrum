/**
 * Energy Flow — CONTRACT tests (OFF by shipped data).
 *
 * Status of the system: the energy mechanic was REMOVED from the shipped
 * data:
 *   - `data/world_rules.json` no longer carries the `energyFlow` rule, so the
 *     flow step is fully off by configuration (per the degradation contract:
 *     missing key → the step no-ops — no entity enumeration, no stat writes,
 *     no broadcast, no per-turn log);
 *   - the `coalGenerator` organ no longer charges `Physical.energy` (inert
 *     `overTime` + empty `grants` in `data/internalComponents.json`, pinned by
 *     coalGenerator.contract.test.js).
 *
 * These tests therefore pin the OFF state against the REAL shipped data the
 * old version pinned the ON state: build the real world (m1Droid + the real
 * data files), drive the real per-turn steps WITHOUT real timers, and assert
 * that even manually-seeded energy never circulates. The flow CODE path is
 * intact and re-activatable by data (see scenario e); only its shipped
 * configuration is now "off".
 *
 * Driven the same way the old contract drove the flow:
 * build the world via `buildWorldState(tickSystem)` (tick not started) and
 * invoke `world.energyFlowController.processFlowTurn(round)` and
 * `world.internalComponentController.processTurnEffects(round)` directly —
 * the same per-turn methods the turn system's round-start hook calls (hook,
 * IC step, then flow step).
 *
 * What is pinned HERE (shipped-scale contract) vs elsewhere:
 *   - HERE: rule-absent-by-data boot + no cross-rule bleed, seeded energy
 *     staying static across many rounds (zero stat writes), zero-energy
 *     spawn silence, serialize/restore round-trip with schema v3 unchanged,
 *     and one-line re-activation (adding the rule back to the data turns the
 *     whole mechanic back on, with the old exact equal-split math).
 *   - UNIT level (test/unit/energyFlowController.test.js): what the controller
 *     does for an *active* rule, including math pins the shipped data can no
 *     longer express.
 *
 * @module test/contract/energyFlow
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { TRAIT_GROUPS, STAT_NAMES } from '../../shared/StatVocabulary.js';
import WorldStateController from '../../src/controllers/WorldStateController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORLD_RULES_PATH = path.resolve(__dirname, '../../data/world_rules.json');

// Shipped value pinned from the data file — the key's ABSENCE is now the
// contract. A data edit that re-adds `energyFlow` intentionally breaks (a).
const worldRulesData = JSON.parse(fs.readFileSync(WORLD_RULES_PATH, 'utf8'));

/** The M1 droid's component count (shipped blueprint). */
const N_COMPONENTS = 23;
/** Pump fraction used by the re-activation scenario (e). */
const SHARE = 0.1;
/** Rounds driven in the static-distribution scenario. */
const STATIC_TURNS = 15;

const PHYSICAL = TRAIT_GROUPS.PHYSICAL;
const ENERGY = STAT_NAMES.ENERGY;

// =========================================================================
// Helpers (same as the old contract — the drive surface is unchanged)
// =========================================================================

/**
 * Builds a fresh world (composition root, tick not started) and spawns one
 * M1 droid in the start room. Returns the facade, the tick system, and the
 * spawned entity (live reference — components are mutated in place by the
 * world, so reads stay current).
 */
function buildWorld() {
    const tick = new UniversalTickSystem(1);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('m1Droid', startRoomId);
    const entity = world.stateEntityController.getAll()[entityId];
    expect(entity, 'the spawned M1 must be live in the entity store').toBeTruthy();
    expect(entity.components.length).toBe(N_COMPONENTS);
    return { tick, world, entityId, entity, turns: subControllers.turnSystemController };
}

/** Drives the energy-flow turn step at a given round (no real timers). */
function driveFlow(world, round) {
    world.energyFlowController.processFlowTurn(round);
}

/** Drives the IC per-turn channel at a given round (no real timers). */
function driveIC(world, round) {
    world.internalComponentController.processTurnEffects(round);
}

/** Reads a component's Physical.energy through the facade's public reader. */
function energy(world, componentId) {
    const stats = world.getComponentStats(componentId);
    return stats && stats[PHYSICAL] ? stats[PHYSICAL][ENERGY] : 0;
}

/** Sets a component's Physical.energy through the controller's public SET. */
function setEnergy(world, componentId, value) {
    world.componentController.updateComponentStat(componentId, PHYSICAL, ENERGY, value);
}

/** The body component (the coalGenerator host — m1CentralBody). */
function bodyOf(entity) {
    const body = entity.components.find((c) => c.type === 'm1CentralBody');
    expect(body, 'the M1 body (m1CentralBody) must be present').toBeTruthy();
    return body;
}

/** Seeds the canonical skewed distribution: body at 100, all others at 0. */
function seedSkewed(world, entity) {
    const body = bodyOf(entity);
    for (const c of entity.components) setEnergy(world, c.id, 0);
    setEnergy(world, body.id, 100);
}

/**
 * Runs `fn` with data/world_rules.json swapped for `contents`, then restores
 * the original file in a finally — the rename-based file-swap idiom: the
 * degradation/re-activation contract is tested against the REAL file path the
 * DataLoader reads.
 */
function withWorldRulesFile(contents, fn) {
    const original = fs.readFileSync(WORLD_RULES_PATH, 'utf8');
    try {
        if (contents === null) {
            fs.unlinkSync(WORLD_RULES_PATH);
        } else {
            fs.writeFileSync(WORLD_RULES_PATH, contents);
        }
        return fn();
    } finally {
        fs.writeFileSync(WORLD_RULES_PATH, original);
    }
}

// =========================================================================
// (a) Off by shipped data — and the other rules are untouched
// =========================================================================

describe('energy flow — (a) off by shipped data', () => {
    it('data/world_rules.json carries no energyFlow key, yet the world builds and the M1 spawns', () => {
        expect(worldRulesData.rules.energyFlow, 'the shipped data must not carry the rule').toBeUndefined();

        const { world, entity } = buildWorld();
        expect(entity.components.length).toBe(N_COMPONENTS);

        // No cross-rule bleed: the damage-law keys still load and remain active
        // while the energy rule is absent (the old "missing key" degradation pin).
        expect(world.worldRulesController.getRule('energyFlow'), 'getRule on the absent key').toBeNull();
        // No cross-rule bleed: the damage-law keys still load and remain active
        // while the energy rule is absent (the old "missing key" degradation pin).
        const active = world.worldRulesController.getActiveRules();
        expect(Object.keys(active).sort()).toEqual(['damageTornMaterial']);
        expect(world.worldRulesController.getDamageTornMaterialPercent()).toBe(10);
        expect(world.worldRulesController.getOnDamageRules()).toEqual([{ drop: 'host_material', percentage: 0.05 }]);
    });
});

// =========================================================================
// (b) Seeded energy stays static across rounds (zero writes)
// =========================================================================

describe('energy flow — (b) no circulation when the rule is off', () => {
    it('a manually-seeded skewed distribution does not move across 15 rounds, with zero stat writes', () => {
        const { world, entityId, entity } = buildWorld();
        seedSkewed(world, entity);

        const spy = vi.spyOn(world.componentController, 'updateComponentStat');

        for (let t = 1; t <= STATIC_TURNS; t++) {
            // A real round start: the hook order (IC step, then flow step) —
            // both of which must be silent here.
            driveIC(world, t);
            driveFlow(world, t);
        }

        expect(spy).not.toHaveBeenCalled(); // flow off + inert IC channel → zero writes
        expect(energy(world, bodyOf(entity).id)).toBe(100); // body kept all its energy
        for (const c of entity.components) {
            if (c.id === bodyOf(entity).id) continue;
            expect(energy(world, c.id), `component ${c.type} received no inflow`).toBe(0);
        }
        // The world is otherwise fully alive.
        expect(world.stateEntityController.getAll()[entityId].components.length).toBe(N_COMPONENTS);
    });
});

// =========================================================================
// (c) Fresh spawn: zero-energy entity is a total no-op
// =========================================================================

describe('energy flow — (c) zero-energy spawn', () => {
    it('a freshly spawned M1 (no organ grant anymore — no energy stat at all): zero stat writes', () => {
        const { world, entity } = buildWorld();
        // Nothing seeds energy now: the body itself carries no stat (the old
        // seed-at-0 grant is gone) — and the same is true of every other
        // component. The flow's zero-total skip applies with room to spare.
        for (const c of entity.components) {
            expect(world.getComponentStats(c.id).Physical?.energy, `no component carries an energy stat`).toBeUndefined();
        }

        const spy = vi.spyOn(world.componentController, 'updateComponentStat');
        driveFlow(world, 1);

        expect(spy).not.toHaveBeenCalled();
    });
});

// =========================================================================
// (d) A seeded energy stat still persists through serialize/restore (v3)
// =========================================================================

describe('energy flow — (d) persistence round-trip', () => {
    it('serialize() → restore() keeps a manually-set Physical.energy bit-identical and the schema version stays 3', () => {
        const { world, entity } = buildWorld();
        const body = bodyOf(entity);
        setEnergy(world, body.id, 50);
        expect(energy(world, body.id)).toBe(50);

        const snapshot = world.serialize();

        // The flow adds no snapshot section: the schema version is unchanged.
        expect(snapshot.schemaVersion).toBe(WorldStateController.PERSISTENCE_SCHEMA_VERSION);
        expect(WorldStateController.PERSISTENCE_SCHEMA_VERSION).toBe(3);

        expect(world.restore(snapshot)).toEqual({ success: true });

        // JSON round-trips preserve JS doubles exactly — bit-identical.
        expect(energy(world, body.id)).toBe(50);
    });
});

// =========================================================================
// (e) The mechanic is reactive to data — adding the rule back re-activates it
// =========================================================================

describe('energy flow — (e) re-activation by data edit', () => {
    it('with the energyFlow rule added back to the data, one flow turn does the exact old equal split', () => {
        const modified = JSON.parse(JSON.stringify(worldRulesData));
        modified.rules.energyFlow = {
            sharePerTick: SHARE,
            defaultEnergyCapacity: 100
        };
        withWorldRulesFile(JSON.stringify(modified), () => {
            const { world, entity } = buildWorld();
            seedSkewed(world, entity);

            driveFlow(world, 1);

            const bodyId = bodyOf(entity).id;
            // Body send: share × 100; receives nothing (all 22 others started at 0).
            expect(energy(world, bodyId), `body ${world.getComponentStats(bodyId).Physical.energy} !== 100 − share·100`).toBe(100 - SHARE * 100);
            for (const c of entity.components) {
                if (c.id === bodyId) continue;
                expect(energy(world, c.id), `component ${c.type} received a different share`).toBe((SHARE * 100) / (N_COMPONENTS - 1));
            }
        });
    });
});

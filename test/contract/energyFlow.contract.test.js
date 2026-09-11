/**
 * Energy Flow — CONTRACT tests (spec wiki/energy_flow_spec.md §10.1).
 *
 * These are NOT unit tests of internal logic. They drive the real registered
 * `energy-flow` tick job against the real shipped data files (m1Droid from
 * data/blueprints.json + data/components.json, the energyFlow rule from
 * data/world_rules.json, the coalGenerator organ from
 * data/internalComponents.json), with no real timers: build the world via
 * buildWorldState(tickSystem) (tick not started), set tickSystem.currentTick =
 * N, then invoke the registered job callback directly — the same code path
 * the running loop uses (UniversalTickSystem._executeTick → job.callback()).
 *
 * Why the M1 is the reference: it is the heaviest shipped entity (23
 * components) and the only one with a generator organ, so it exercises the
 * full dynamic — network scale, charge-then-flow ordering, capacity bound,
 * convergence, degradation. The exact equal-split math below is pinned to the
 * SHIPPED numbers (sharePerTick from data/world_rules.json), so a data edit
 * that moves the balance breaks these tests on purpose.
 *
 * What is pinned HERE vs at unit level (test/unit/energyFlowController.test.js):
 *   - HERE (shipped-scale invariants): exact equal split from a skewed seed,
 *     capacity-never-exceeded + total-non-increasing across 50 ticks, 30-tick
 *     convergence to the uniform mean with the total conserved, charge-then-
 *     flow ordering with the real coal generator, serialize/restore round-trip
 *     (schema v3 unchanged), graceful degradation (missing file / missing key
 *     / malformed key), zero-energy skip, steady-state silence, and the
 *     on-damage suppression (flow drains shed no chunks).
 *   - UNIT level (what shipped data cannot express): N=1 no-op, heterogeneous-
 *     capacity hard clamp with EXACT loss (a contractive 23-component network
 *     at share 0.1 never overshoots a uniform cap, so the exact discarded
 *     amount is not observable at shipped scale), energyCapacity: 0, the
 *     skip-damage flag, and disabled/zero-energy no-ops.
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
import Logger from '../../src/utils/Logger.js';
import WorldStateController from '../../src/controllers/WorldStateController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORLD_RULES_PATH = path.resolve(__dirname, '../../data/world_rules.json');
const WORLD_RULES_BACKUP_PATH = `${WORLD_RULES_PATH}.energyFlowTest.bak`;

// =========================================================================
// Shipped values — pinned from the data files (a data edit breaks these
// tests on purpose).
// =========================================================================
const worldRulesData = JSON.parse(fs.readFileSync(WORLD_RULES_PATH, 'utf8'));
const SHARE = worldRulesData.rules.energyFlow.sharePerTick;
const DEFAULT_CAPACITY = worldRulesData.rules.energyFlow.defaultEnergyCapacity;

/** The M1 droid's component count (shipped blueprint; also pinned by m1SharedContract.test.js). */
const N_COMPONENTS = 23;
/** The other components when one (the body) is seeded high. */
const N_OTHERS = N_COMPONENTS - 1;
/** The uniform mean of a 100-unit pool spread over the M1. */
const MEAN = 100 / N_COMPONENTS;
/** Ticks driven for the convergence scenario (spec: ~30). */
const CONVERGENCE_TICKS = 30;
/** Per-component closeness to the mean asserted after convergence (0–100 scale). */
const CONVERGENCE_TOLERANCE = 5;
/** FP tolerance for the "total conserved" assertion (no clamp engages). */
const TOTAL_CONSERVATION_TOLERANCE = 1e-6;
/** Ticks driven for the macro-invariant scenario. */
const INVARIANT_TICKS = 50;

const PHYSICAL = TRAIT_GROUPS.PHYSICAL;
const ENERGY = STAT_NAMES.ENERGY;

// =========================================================================
// Helpers
// =========================================================================

/**
 * Builds a fresh world (composition root, tick not started) and spawns one
 * M1 droid in the start room. Returns the facade, the tick system, and the
 * spawned entity (live reference — components are mutated in place by the
 * world, so reads stay current).
 */
function buildWorld() {
    const tick = new UniversalTickSystem(1);
    const { worldStateController: world } = buildWorldState(tick);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('m1Droid', startRoomId);
    const entity = world.stateEntityController.getAll()[entityId];
    expect(entity, 'the spawned M1 must be live in the entity store').toBeTruthy();
    expect(entity.components.length).toBe(N_COMPONENTS);
    return { tick, world, entityId, entity };
}

/**
 * Finds a registered tick job by its stable id (tick.jobs is an array of
 * TickJobs; the id is the documented cross-suite pin point).
 */
function getJob(tick, jobId) {
    const job = tick.jobs.find((j) => j.id === jobId);
    expect(job, `the '${jobId}' tick job must be registered`).toBeTruthy();
    return job;
}

/** Drives the registered energy-flow job at an absolute tick (no real timers). */
function driveFlow(tick, targetTick) {
    const job = getJob(tick, 'energy-flow');
    tick.currentTick = targetTick;
    job.callback();
}

/** Drives the registered internal-components job at an absolute tick. */
function driveIC(tick, targetTick) {
    const job = getJob(tick, 'internal-components');
    tick.currentTick = targetTick;
    job.callback();
}

/** Reads a component's Physical.energy through the facade's public reader. */
function energy(world, componentId) {
    const stats = world.getComponentStats(componentId);
    return stats && stats[PHYSICAL] ? stats[PHYSICAL][ENERGY] : 0;
}

/** Sets a component's Physical.energy through the controller's public SET (the coal test's own seeding idiom). */
function setEnergy(world, componentId, value) {
    world.componentController.updateComponentStat(componentId, PHYSICAL, ENERGY, value);
}

/** The body component (the coalGenerator host — m1CentralBody). */
function bodyOf(entity) {
    const body = entity.components.find((c) => c.type === 'm1CentralBody');
    expect(body, 'the M1 body (m1CentralBody) must be present').toBeTruthy();
    return body;
}

/**
 * The M1's carried coal units (world.json loadout: 10). Mirrors the coal
 * generator contract test's own counter: items are discrete objects keyed by
 * host component (there is no `count` field — one object per unit).
 */
function coalUnits(world, entityId) {
    const items = world.getEntityItems(entityId);
    let count = 0;
    for (const list of Object.values(items)) {
        for (const item of list) if (item?.type === 'coal') count++;
    }
    return count;
}

/** Seeds the canonical skewed distribution: body at 100, all others at 0. */
function seedSkewed(world, entity) {
    const body = bodyOf(entity);
    for (const c of entity.components) setEnergy(world, c.id, 0);
    setEnergy(world, body.id, 100);
}

/**
 * Runs `fn` with data/world_rules.json swapped for `contents` (or removed
 * when contents === null), then restores the original file in a finally —
 * the rename-based file-swap idiom (spec §10.1(f)): the degradation contract
 * is tested against the REAL file path the DataLoader reads.
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
// (a) Basic equal split — exact values, tick-start reads only
// =========================================================================

describe('energy flow — (a) basic equal split', () => {
    it('one flow tick from a skewed seed: body lands exactly at 100 − share·100, each of the 22 others exactly at share·100/22 (tick-start reads only)', () => {
        const { tick, world, entity } = buildWorld();
        const body = bodyOf(entity);
        seedSkewed(world, entity);

        driveFlow(tick, 1);

        // The body's SEND is share × its tick-start 100; it receives nothing
        // (all 22 others started at 0). Expected: 100 − share·100 — computed
        // with the same FP ops as the controller, so the assertion is exact.
        expect(energy(world, body.id)).toBe(100 - SHARE * 100);
        // Each other receives the body's send divided equally: a single term,
        // share·100/22. Exact — a sequential (non-simultaneous) step would
        // cascade the body's decrease into the others' sends and land
        // different values.
        for (const c of entity.components) {
            if (c.id === body.id) continue;
            expect(energy(world, c.id)).toBe((SHARE * 100) / N_OTHERS);
        }
    });
});

// =========================================================================
// (b) Capacity + non-increasing-total invariants (shipped scale)
// =========================================================================

describe('energy flow — (b) capacity + total invariants', () => {
    it('no component ever exceeds its capacity and the entity total never increases across 50 skewed ticks', () => {
        const { tick, world, entity } = buildWorld();
        seedSkewed(world, entity);
        let prevTotal = 100;

        for (let t = 1; t <= INVARIANT_TICKS; t++) {
            driveFlow(tick, t);
            const values = entity.components.map((c) => energy(world, c.id));
            for (const v of values) {
                expect(v, `tick ${t}: energy ${v} violates the capacity bound`).toBeLessThanOrEqual(DEFAULT_CAPACITY + 1e-12);
                expect(v, `tick ${t}: energy ${v} is negative`).toBeGreaterThanOrEqual(0);
            }
            const total = values.reduce((a, b) => a + b, 0);
            expect(total, `tick ${t}: total ${total} > previous ${prevTotal}`).toBeLessThanOrEqual(prevTotal + 1e-9);
            prevTotal = total;
        }
    });
});

// =========================================================================
// (c) 30-tick convergence to the uniform mean, total conserved
// =========================================================================

describe('energy flow — (c) convergence', () => {
    it('30 flow-only ticks from a skewed seed: spread shrinks strictly, total conserved, every component within tolerance of 100/23', () => {
        const { tick, world, entity } = buildWorld();
        seedSkewed(world, entity);
        let prevSpread = Infinity;

        for (let t = 1; t <= CONVERGENCE_TICKS; t++) {
            driveFlow(tick, t);
            const values = entity.components.map((c) => energy(world, c.id));
            const total = values.reduce((a, b) => a + b, 0);
            // No clamp engages below the capacity bound, so the pool is
            // conserved up to FP noise (the per-pair share terms round).
            expect(Math.abs(total - 100), `tick ${t}: total drift ${total}`).toBeLessThanOrEqual(TOTAL_CONSERVATION_TOLERANCE);
            const spread = Math.max(...values) - Math.min(...values);
            expect(spread, `tick ${t}: spread ${spread} did not shrink from ${prevSpread}`).toBeLessThan(prevSpread);
            prevSpread = spread;
        }

        const final = entity.components.map((c) => energy(world, c.id));
        for (const v of final) {
            expect(Math.abs(v - MEAN), `final value ${v} is not within tolerance of the mean ${MEAN}`).toBeLessThanOrEqual(CONVERGENCE_TOLERANCE);
        }
    });
});

// =========================================================================
// (d) Charge-then-flow ordering with the real coal generator
// =========================================================================

describe('energy flow — (d) charge-then-flow ordering', () => {
    it('at tick 5 the IC burn (order 0) lands before the flow (order 2): the flow tick-start read sees the charged value', () => {
        const { tick, world, entityId, entity } = buildWorld();
        const body = bodyOf(entity);
        // Fresh M1: the coalGenerator organ seeded the body's energy at 0 and
        // the world.json loadout gives it 10 coal.
        expect(coalUnits(world, entityId)).toBe(10);
        expect(energy(world, body.id)).toBe(0);

        // Tick 5: first generator interval (interval 5). Burn 1 coal, +10.
        driveIC(tick, 5);
        expect(coalUnits(world, entityId)).toBe(9);
        expect(energy(world, body.id)).toBe(10);

        // Same tick, AFTER the IC job: the flow job runs. Its tick-start read
        // must include the just-charged 10 — body ends at 10 − share·10, each
        // of the 22 others at share·10/22 (the body's send, divided equally).
        driveFlow(tick, 5);
        expect(energy(world, body.id)).toBe(10 - SHARE * 10);
        for (const c of entity.components) {
            if (c.id === body.id) continue;
            expect(energy(world, c.id)).toBe((SHARE * 10) / N_OTHERS);
        }
    });
});

// =========================================================================
// (e) serialize/restore round-trip — schema v3 unchanged
// =========================================================================

describe('energy flow — (e) persistence round-trip', () => {
    it('after flow ticks, serialize() → restore() keeps every Physical.energy bit-identical and the schema version stays 3', () => {
        const { tick, world, entity } = buildWorld();
        seedSkewed(world, entity);
        driveFlow(tick, 1);
        driveFlow(tick, 2);

        const before = new Map(entity.components.map((c) => [c.id, energy(world, c.id)]));
        const snapshot = world.serialize();

        // The flow adds no snapshot section: the schema version is unchanged.
        expect(snapshot.schemaVersion).toBe(WorldStateController.PERSISTENCE_SCHEMA_VERSION);
        expect(WorldStateController.PERSISTENCE_SCHEMA_VERSION).toBe(3);

        expect(world.restore(snapshot)).toEqual({ success: true });

        // JSON round-trips preserve JS doubles exactly — bit-identical.
        for (const [id, value] of before) {
            expect(energy(world, id)).toBe(value);
        }
    });
});

// =========================================================================
// (f) Graceful degradation — rename-based file swap
// =========================================================================

describe('energy flow — (f) graceful degradation', () => {
    it('missing world_rules.json: world boots, the flow writes nothing across 3 driven ticks, no crash', () => {
        withWorldRulesFile(null, () => {
            const { tick, world, entityId, entity } = buildWorld();
            const body = bodyOf(entity);
            seedSkewed(world, entity);
            const spy = vi.spyOn(world.componentController, 'updateComponentStat');

            expect(() => {
                for (let t = 1; t <= 3; t++) driveFlow(tick, t);
            }).not.toThrow();

            expect(spy).not.toHaveBeenCalled();
            // The world is otherwise fully alive.
            expect(world.stateEntityController.getAll()[entityId].components.length).toBe(N_COMPONENTS);
            expect(energy(world, body.id)).toBe(100);
        });
    });

    it('file without the energyFlow key: flow off (zero writes), the other rules untouched (torn percent still active)', () => {
        const modified = JSON.parse(JSON.stringify(worldRulesData));
        delete modified.rules.energyFlow;
        withWorldRulesFile(JSON.stringify(modified), () => {
            const { tick, world, entity } = buildWorld();
            const body = bodyOf(entity);
            seedSkewed(world, entity);
            const spy = vi.spyOn(world.componentController, 'updateComponentStat');

            expect(() => {
                for (let t = 1; t <= 3; t++) driveFlow(tick, t);
            }).not.toThrow();

            expect(spy).not.toHaveBeenCalled();
            // The other rule is untouched and still active.
            expect(world.worldRulesController.getDamageTornMaterialPercent()).toBe(10);
            expect(energy(world, body.id)).toBe(100);
        });
    });

    it('malformed energyFlow key (sharePerTick: "ten"): flow off with a SINGLE boot-time warn, other rules untouched', () => {
        const modified = JSON.parse(JSON.stringify(worldRulesData));
        modified.rules.energyFlow = { sharePerTick: 'ten', defaultEnergyCapacity: 100 };
        const warnSpy = vi.spyOn(Logger, 'warn');
        try {
            withWorldRulesFile(JSON.stringify(modified), () => {
                // Reset BEFORE buildWorld(): the single warn is a BOOT-time event
                // (WorldRulesController validation), so the boot phase must be counted.
                warnSpy.mockReset();
                warnSpy.mockImplementation(() => {});
                const { tick, world, entity } = buildWorld();
                // Exactly one boot warn names the energyFlow rule.
                const bootWarns = warnSpy.mock.calls.filter((args) => String(args[0]).includes('energyFlow'));
                expect(bootWarns).toHaveLength(1);
                warnSpy.mockReset(); // only count the stat-drive phase from here on

                const body = bodyOf(entity);
                seedSkewed(world, entity);
                const statSpy = vi.spyOn(world.componentController, 'updateComponentStat');

                expect(() => {
                    for (let t = 1; t <= 3; t++) driveFlow(tick, t);
                }).not.toThrow();

                expect(statSpy).not.toHaveBeenCalled();
                expect(world.worldRulesController.getDamageTornMaterialPercent()).toBe(10);
                expect(energy(world, body.id)).toBe(100);
            });
        } finally {
            warnSpy.mockRestore();
        }
    });
});

// =========================================================================
// (h) Zero-energy skip
// =========================================================================

describe('energy flow — (h) zero-energy skip', () => {
    it('a freshly spawned M1 (body seeded at 0 by the organ grant, no other stat): zero stat writes', () => {
        const { tick, world, entityId, entity } = buildWorld();
        // The coalGenerator organ seeded the body at 0 at spawn; nothing else
        // carries the energy stat. Sum of tick-start energies is 0 → skip.
        expect(energy(world, bodyOf(entity).id)).toBe(0);
        const spy = vi.spyOn(world.componentController, 'updateComponentStat');

        driveFlow(tick, 1);

        expect(spy).not.toHaveBeenCalled();
    });
});

// =========================================================================
// (i) Steady-state silence (epsilon guard)
// =========================================================================

describe('energy flow — (i) steady-state silence', () => {
    it('all 23 components at exactly 100 (uniform point): one flow tick performs zero stat writes and therefore zero broadcasts', () => {
        const { tick, world, entity } = buildWorld();
        for (const c of entity.components) setEnergy(world, c.id, 100);
        const spy = vi.spyOn(world.componentController, 'updateComponentStat');

        driveFlow(tick, 1);

        // Without the FLOW_NOOP_EPSILON guard, the per-pair share terms would
        // re-compute to ulp-different values and write — and broadcast — every
        // tick. The epsilon makes the uniform point a fixed point: zero writes.
        expect(spy).not.toHaveBeenCalled();
    });
});

// =========================================================================
// (j) Flow drains are not damage — no chunk shedding
// =========================================================================

describe('energy flow — (j) drains are not damage', () => {
    it('22 draining components per tick under a FORCED-SUCCEEDING onDamage roll shed zero chunks (the skip-damage seam)', () => {
        const { tick, world, entityId, entity } = buildWorld();
        const body = bodyOf(entity);
        // Force the Bernoulli draw to success (the documented _randomFn seam):
        // any damage event would drop a chunk. 0 < 0.05 → always succeeds.
        world.onDamageDropListener._randomFn = () => 0;
        // Skew so ~22 components DRAIN every tick: the other 22 start at 100,
        // the body at 0 (it absorbs; every one of the 22 strictly decreases).
        for (const c of entity.components) {
            setEnergy(world, c.id, c.id === body.id ? 0 : 100);
        }

        for (let t = 1; t <= 5; t++) driveFlow(tick, t);

        // The drains really happened (body absorbed energy over the ticks).
        expect(energy(world, body.id)).toBeGreaterThan(0);
        // ...and the forced-succeeding onDamage rule dropped NOTHING: the flow's
        // skip-damage suppression kept the physiological drains out of the
        // damage pipeline entirely.
        expect(Object.keys(world.getDroppedItems())).toHaveLength(0);
    });
});

// =========================================================================
// (k) Broadcast contract — decision 9: exactly one full-state broadcast per
// write-producing tick, zero per no-write tick, per-write broadcasts suppressed
// by the flow-scope gate (WorldStateController stat-change listener).
// =========================================================================

describe('energy flow — (k) broadcast contract (decision 9)', () => {
    it('a write-producing flow tick emits exactly ONE broadcast despite N_COMPONENTS stat writes (per-write gate suppression)', () => {
        const { tick, world, entity } = buildWorld();
        seedSkewed(world, entity); // seeding runs with no broadcast service wired → silent
        const stub = { broadcast: vi.fn() };
        world.setBroadcastService(stub);
        stub.broadcast.mockClear();
        const writesSpy = vi.spyOn(world.componentController, 'updateComponentStat');

        driveFlow(tick, 1);

        // All 23 components changed (body 100→90, each other 0→share·100/22).
        expect(writesSpy).toHaveBeenCalledTimes(N_COMPONENTS);
        // ...but the per-write gate (flow scope open) suppressed N−1 of them,
        // and endEnergyFlowTick(true) closed the scope with exactly one.
        // If the _energyFlowScopeCount conjunct were dropped: N_COMPONENTS calls.
        // If the broadcast() call were dropped: 0 calls.
        expect(stub.broadcast).toHaveBeenCalledTimes(1);
    });

    it('a no-write flow tick (steady state at the uniform point) emits zero broadcasts (end(true→false) path)', () => {
        const { tick, world, entity } = buildWorld();
        for (const c of entity.components) setEnergy(world, c.id, 100); // uniform point
        const stub = { broadcast: vi.fn() };
        world.setBroadcastService(stub);
        stub.broadcast.mockClear();

        driveFlow(tick, 1);

        // Epsilon guard → zero writes → endEnergyFlowTick(false) → silence.
        expect(stub.broadcast).toHaveBeenCalledTimes(0);
    });
});

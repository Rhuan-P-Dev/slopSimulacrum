/**
 * EnergyFlowController — unit tests (spec wiki/energy_flow_spec.md §10.2).
 *
 * Stub-based: a hand-built stub facade (entity store + stat reader + a
 * recording `componentController.updateComponentStat` + the begin/end flow
 * scope pair), a stub rule controller (returns a chosen rule or null), and
 * Logger mocked (house unit pattern). The flow registers no tick job: its
 * per-turn step is processFlowTurn(round), driven directly here. These tests
 * pin exactly what the shipped data files CANNOT
 * express:
 *
 *   - N = 1 no-op (a one-component entity cannot circulate: no writes, no
 *     division error — the smallest network the shipped blueprint can't make,
 *     because m1Droid is the only generator entity and it has 23 components).
 *   - Heterogeneous-capacity hard clamp with the EXACT discarded amount
 *     (a contractive 23-component network at the shipped share never
 *     overshoots a uniform cap, so the exact loss is unobservable at shipped
 *     scale — here it is pinned to the bit).
 *   - `energyCapacity: 0` (a component that holds no energy: clamped to 0 on
 *     the first tick, exact loss — no shipped recipe declares it).
 *   - The skip-damage flag (every flow write suppresses the damage event).
 *   - No-op suppression at unit scale (the FLOW_NOOP_EPSILON: a uniform
 *     entity whose per-pair recompute is ulp-off performs zero writes).
 *   - Disabled at boot (stub rule controller returns null: the turn step
 *     does not touch the facade at all).
 *   - Zero-energy skip (all stats absent: zero writes, no scope broadcast).
 *
 * @module test/unit/energyFlowController
 */

import { describe, it, expect, vi } from 'vitest';
import EnergyFlowController from '../../src/controllers/core/EnergyFlowController.js';
import Logger from '../../src/utils/Logger.js';

// House unit pattern: silence the Logger.
vi.mock('../../src/utils/Logger.js', () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

// =========================================================================
// Stubs
// =========================================================================

/**
 * Builds a stub facade: records every write, counts begin/end scope calls,
 * serves stats from a plain map, and enumerates the given entities.
 * `statsByComp`: { [componentId]: { Physical: { energy } } | undefined }
 * `entities`: { [entityId]: { components: [{ id, type }] } }
 */
function makeFacade(entities, statsByComp) {
    const writes = [];
    const scope = { begin: 0, end: 0, endArgs: [] };
    return {
        writes,
        scope,
        stateEntityController: {
            getAll: vi.fn(() => entities)
        },
        getComponentStats: (id) => {
            const s = statsByComp[id];
            return s ? JSON.parse(JSON.stringify(s)) : {};
        },
        componentController: {
            updateComponentStat: (componentId, traitId, statName, value, skipDamageEvent) => {
                writes.push({ componentId, traitId, statName, value, skipDamageEvent });
                // Mirror the real SET: commit the value into the stat store so
                // a second tick sees it (the stub is a tiny state owner).
                if (!statsByComp[componentId]) statsByComp[componentId] = {};
                if (!statsByComp[componentId][traitId]) statsByComp[componentId][traitId] = {};
                statsByComp[componentId][traitId][statName] = value;
                return true;
            }
        },
        beginEnergyFlowTurn: () => { scope.begin++; },
        endEnergyFlowTurn: (shouldBroadcast) => { scope.end++; scope.endArgs.push(shouldBroadcast); }
    };
}

/**
 * Builds the controller under test with the given recipe registry and a stub
 * rule controller. Wires the stub facade post-construction (the composition
 * root's wiring step). The flow registers no tick job: its per-turn step is
 * processFlowTurn(round), driven directly by tickOnce below.
 */
function makeController(facade, registry, rule) {
    const rulesStub = { getRule: (key) => (key === 'energyFlow' ? rule : null) };
    const controller = new EnergyFlowController(registry, rulesStub);
    controller.initialize();
    controller.setWorldStateController(facade);
    return controller;
}

/** The shipped rule shape (a defensive copy of the validated config). */
function rule(overrides = {}) {
    return { sharePerTick: 0.1, defaultEnergyCapacity: 100, enabled: true, ...overrides };
}

/** Drives one flow turn directly (the round-start hook's path). */
function tickOnce(controller) {
    controller.processFlowTurn(1);
}

// =========================================================================
// N = 1 no-op
// =========================================================================

describe('EnergyFlowController — N=1 no-op', () => {
    it('a one-component entity: no writes, no division error, scope opened and closed', () => {
        const stats = { c1: { Physical: { energy: 50 } } };
        const entities = { e1: { components: [{ id: 'c1', type: 'a' }] } };
        const facade = makeFacade(entities, stats);
        const controller = makeController(facade, { a: {} }, rule());

        expect(() => tickOnce(controller)).not.toThrow();

        expect(facade.writes).toHaveLength(0);
        expect(facade.scope.begin).toBe(1);
        expect(facade.scope.end).toBe(1);
        expect(facade.scope.endArgs).toEqual([false]);
    });
});

// =========================================================================
// Heterogeneous-capacity hard clamp — exact loss
// =========================================================================

describe('EnergyFlowController — heterogeneous-capacity hard clamp', () => {
    it('a=10 (cap 10) and b=0.5 (cap 1): a written at the exact unclamped value, b clamped to 1, total drops by exactly the discarded amount', () => {
        const stats = {
            a: { Physical: { energy: 10 } },
            b: { Physical: { energy: 0.5 } }
        };
        const entities = { e1: { components: [{ id: 'a', type: 'a' }, { id: 'b', type: 'b' }] } };
        const facade = makeFacade(entities, stats);
        // Heterogeneous capacities: the shipped data has none (no recipe
        // declares energyCapacity at launch), so this case is unit-level only.
        // b starts BELOW its cap so the clamp engages on an actual write
        // (a start at cap would clamp to its unchanged value → silent no-op).
        const controller = makeController(
            facade,
            { a: { energyCapacity: 10 }, b: { energyCapacity: 1 } },
            rule()
        );

        tickOnce(controller);

        const writeOf = (id) => facade.writes.find((w) => w.componentId === id);
        expect(facade.writes).toHaveLength(2);

        // Component a: start 10, inflow = send(b)/(N−1) = (0.1×0.5)/1, send = 1.0.
        // The exact unclamped value (same FP ops as the controller):
        expect(writeOf('a').value).toBe(10 + 0.05 - 1);

        // Component b: start 0.5, inflow = send(a)/(N−1) = 1.0, send = 0.05 →
        // raw = 0.5 + 1 − 0.05 ≈ 1.45, clamped to its capacity of 1. Exact.
        expect(writeOf('b').value).toBe(1);

        // The total drops by exactly the amount that overflowed b's capacity.
        const rawB = 0.5 + 1 - 0.05;
        const discarded = rawB - 1;
        const totalNew = writeOf('a').value + writeOf('b').value;
        expect(10.5 - totalNew).toBeCloseTo(discarded, 12);
    });
});

// =========================================================================
// energyCapacity: 0 — absorbs nothing
// =========================================================================

describe('EnergyFlowController — energyCapacity: 0', () => {
    it('a zero-capacity component holding energy (data edit) is clamped to 0 on the first tick with the exact loss', () => {
        const stats = {
            a: { Physical: { energy: 50 } },
            b: { Physical: { energy: 5 } }
        };
        const entities = { e1: { components: [{ id: 'a', type: 'a' }, { id: 'b', type: 'b' }] } };
        const facade = makeFacade(entities, stats);
        const controller = makeController(
            facade,
            { a: {}, b: { energyCapacity: 0 } },
            rule()
        );

        tickOnce(controller);

        const writeOf = (id) => facade.writes.find((w) => w.componentId === id);
        // b: start 5, inflow = 5 (a's send, N−1=1), send = 0.5 → raw 9.5,
        // clamped to its zero capacity. Absorbed nothing; all 9.5 lost.
        expect(writeOf('b').value).toBe(0);
        // a: start 50, inflow = 0.5, send = 5 → the exact unclamped 45.5.
        expect(writeOf('a').value).toBe(50 + 0.5 - 5);
    });
});

// =========================================================================
// The skip-damage flag
// =========================================================================

describe('EnergyFlowController — skip-damage flag', () => {
    it('every recorded write passes skipDamageEvent = true (a drain is not damage)', () => {
        const stats = {
            a: { Physical: { energy: 10 } },
            b: { Physical: { energy: 1 } }
        };
        const entities = { e1: { components: [{ id: 'a', type: 'a' }, { id: 'b', type: 'b' }] } };
        const facade = makeFacade(entities, stats);
        const controller = makeController(facade, { a: {}, b: {} }, rule());

        tickOnce(controller);

        expect(facade.writes.length).toBeGreaterThan(0);
        for (const w of facade.writes) {
            expect(w.traitId).toBe('Physical');
            expect(w.statName).toBe('energy');
            expect(w.skipDamageEvent).toBe(true);
        }
    });
});

// =========================================================================
// No-op suppression (epsilon at unit scale)
// =========================================================================

describe('EnergyFlowController — no-op suppression', () => {
    it('a uniform entity whose per-pair recompute is ulp-off performs zero writes (the epsilon guards it)', () => {
        // N=2, both at 0.01: the per-pair share terms recompute to a value
        // DIFFERENT from the start by ~1.7e-18 (verified below with the same
        // formula the controller uses) — nonzero, but far below the
        // FLOW_NOOP_EPSILON of 1e-9, so the step is silent. Without the
        // epsilon, the entity would write (and broadcast) every tick forever.
        const x = 0.01;
        const sends = [x, x].map((s) => 0.1 * s);
        let inflow = 0;
        // Mirror the controller exactly: the component's OWN send is excluded
        // from its own inflow (simultaneous read-all/compute).
        sends.forEach((s, i) => { if (i === 0) return; inflow += s / (2 - 1); });
        const recomputed = x + inflow - sends[0];
        expect(recomputed - x).not.toBe(0); // the recompute is ulp-off
        expect(Math.abs(recomputed - x)).toBeLessThan(1e-9); // ...but below epsilon

        const stats = { a: { Physical: { energy: x } }, b: { Physical: { energy: x } } };
        const entities = { e1: { components: [{ id: 'a', type: 'a' }, { id: 'b', type: 'b' }] } };
        const facade = makeFacade(entities, stats);
        const controller = makeController(facade, { a: {}, b: {} }, rule());

        tickOnce(controller);

        expect(facade.writes).toHaveLength(0);
        expect(facade.scope.endArgs).toEqual([false]);
    });
});

// =========================================================================
// Disabled at boot
// =========================================================================

describe('EnergyFlowController — disabled at boot', () => {
    it('stub rule controller returns null: the tick callback does not touch the facade at all', () => {
        const stats = { c1: { Physical: { energy: 50 } }, c2: { Physical: { energy: 50 } } };
        const entities = { e1: { components: [{ id: 'c1', type: 'a' }, { id: 'c2', type: 'b' }] } };
        const facade = makeFacade(entities, stats);
        const controller = makeController(facade, { a: {}, b: {} }, null); // rule OFF

        tickOnce(controller);

        // No enumeration, no reads, no writes, no scope activity at all.
        expect(facade.stateEntityController.getAll).not.toHaveBeenCalled();
        expect(facade.writes).toHaveLength(0);
        expect(facade.scope.begin).toBe(0);
        expect(facade.scope.end).toBe(0);
    });
});

// =========================================================================
// Zero-energy skip
// =========================================================================

describe('EnergyFlowController — zero-energy skip', () => {
    it('all stats absent: zero writes, no scope broadcast requested', () => {
        const stats = {}; // no component carries the energy stat
        const entities = { e1: { components: [{ id: 'c1', type: 'a' }, { id: 'c2', type: 'b' }] } };
        const facade = makeFacade(entities, stats);
        const controller = makeController(facade, { a: {}, b: {} }, rule());

        tickOnce(controller);

        expect(facade.writes).toHaveLength(0);
        // The scope still opened and closed (the step ran, found no energy):
        // closed with shouldBroadcast=false → no broadcast.
        expect(facade.scope.begin).toBe(1);
        expect(facade.scope.end).toBe(1);
        expect(facade.scope.endArgs).toEqual([false]);
    });
});

// =========================================================================
// Recipe-capacity validation is gated on the rule being active (spec §3 degradation table)
// =========================================================================

describe('EnergyFlowController — recipe validation gated on the rule', () => {
    it('rule inactive: malformed recipe energyCapacity fields are not validated or warned about', () => {
        Logger.warn.mockReset();
        const facade = makeFacade({}, {});
        makeController(facade, { a: { energyCapacity: 'oops' }, b: { energyCapacity: -1 } }, null);
        expect(Logger.warn).not.toHaveBeenCalled();
    });

    it('rule active: each recipe with a malformed energyCapacity warns exactly once at init (validator side of the gate)', () => {
        Logger.warn.mockReset();
        const facade = makeFacade({}, {});
        makeController(facade, { a: { energyCapacity: 'oops' }, b: { energyCapacity: -1 }, c: { energyCapacity: 42 } }, rule());
        expect(Logger.warn).toHaveBeenCalledTimes(2);
        expect(String(Logger.warn.mock.calls[0][0])).toContain('a');
        expect(String(Logger.warn.mock.calls[1][0])).toContain('b');
    });
});

// =========================================================================
// Broadcast scope positive path (spec §12 decision 9: one broadcast only when something moved)
// =========================================================================

describe('EnergyFlowController — broadcast scope positive path', () => {
    it('a write-producing tick closes the scope with shouldBroadcast=true (the zero-side-only gap is closed)', () => {
        const stats = { a: { Physical: { energy: 10 } }, b: { Physical: { energy: 1 } } };
        const entities = { e1: { components: [{ id: 'a', type: 'a' }, { id: 'b', type: 'b' }] } };
        const facade = makeFacade(entities, stats);
        const controller = makeController(facade, { a: {}, b: {} }, rule());

        tickOnce(controller);

        // a: 10 + 0.1 - 1 ≠ 10 and b: 1 + 1 - 0.1 ≠ 1 → two real writes.
        expect(facade.writes.length).toBe(2);
        expect(facade.scope.begin).toBe(1);
        expect(facade.scope.end).toBe(1);
        expect(facade.scope.endArgs).toEqual([true]);
    });
});

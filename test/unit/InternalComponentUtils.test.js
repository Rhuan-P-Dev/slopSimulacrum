/**
 * UNIT TEST — InternalComponentUtils: programmatic internal-component
 * descriptions.
 *
 * Pins the renderer contract: `generateDescription` is purely data-driven
 * (no hardcoded prose per organ type), so shipping a new organ JSON entry
 * yields a correct description with zero code changes. Every expected string
 * is byte-accurate — derived by running the real util over the shipped
 * `data/internalComponents.json` plus hand-crafted fixtures, then pinned here
 * so any wording or data regression fails loudly.
 *
 * Scope:
 *   - `generateDescription`: `grants` / `grantsFlags` / `overTime` rendering
 *     plus edge cases (unknown/undefined definition, empty organ, malformed
 *     or unrecognized effects, single-turn cadence, missing numeric fields,
 *     first-clause capitalization).
 *   - `enrichWithDescriptions`: the in-place mutation contract (returns the
 *     same array reference for chaining), per-instance resolution through the
 *     shared registry, and graceful skips for non-instances / unknown types
 *     / a missing registry.
 *
 * @module test/unit/InternalComponentUtils
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import InternalComponentUtils from '../../src/utils/InternalComponentUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const util = InternalComponentUtils;

/**
 * The shipped organ registry (top-level `_comment` marker filtered out —
 * it is documentation, not an organ type).
 */
const REGISTRY = (() => {
    const raw = JSON.parse(
        readFileSync(path.join(__dirname, '..', '..', 'data', 'internalComponents.json'), 'utf8')
    );
    const registry = {};
    for (const [key, def] of Object.entries(raw)) {
        if (typeof def === 'object' && def !== null && !key.startsWith('_')) registry[key] = def;
    }
    return registry;
})();

// ---------------------------------------------------------------------------
// generateDescription — shipped organ data (data-driven contract)
// ---------------------------------------------------------------------------
describe('generateDescription — shipped organ data', () => {
    it('renders the four passive function organs (single "maintains" clause)', () => {
        expect(util.generateDescription(REGISTRY.strengthCore))
            .toBe("Maintains the host's Physical strength at 50.");
        expect(util.generateDescription(REGISTRY.moveCore))
            .toBe("Maintains the host's Movement move at 20.");
        expect(util.generateDescription(REGISTRY.precisionCore))
            .toBe("Maintains the host's Manipulation fine_controls at 50.");
        expect(util.generateDescription(REGISTRY.thinkCore))
            .toBe("Maintains the host's Mind think_level at 10.");
    });

    it('renders periodic-only organs (cadence + action)', () => {
        expect(util.generateDescription(REGISTRY.repairSphere))
            .toBe('Every 5 turns, restores 0.02 existence to the host.');
        expect(util.generateDescription(REGISTRY.corrosiveGland))
            .toBe('Marks the host as corrosive. Every 10 turns, emits 1 corrosion damage to components within 50.');
    });

    it('renders coalGenerator (burns coal to charge the host entity\'s energy)', () => {
        // The energy mechanic is data-driven (data/entity_attributes.json):
        // the organ stays installable and describes its fuel -> energy overTime
        // effect. It charges the HOST ENTITY's energy attribute (a whole-entity
        // stat), not a per-component stat, so no grant clause is declared.
        expect(util.generateDescription(REGISTRY.coalGenerator))
            .toBe('Every 5 turns, burns 1 coal to charge the host 10 Physical energy (capacity 100).');
    });
});

// ---------------------------------------------------------------------------
// generateDescription — branch coverage (hand-crafted fixtures)
// ---------------------------------------------------------------------------
describe('generateDescription — branch coverage', () => {
    it('returns the unknown-string for undefined / null / non-object definitions', () => {
        expect(util.generateDescription(undefined)).toBe('Unknown internal component.');
        expect(util.generateDescription(null)).toBe('Unknown internal component.');
        expect(util.generateDescription('nope')).toBe('Unknown internal component.');
        expect(util.generateDescription(42)).toBe('Unknown internal component.');
    });

    it('keeps only numeric grant values (skips non-numeric entries)', () => {
        expect(util.generateDescription({ grants: { 'Physical.strength': 'high', 'Physical.move': 7 } }))
            .toBe("Maintains the host's Physical move at 7.");
    });

    it('keeps only non-empty string flags (skips blank / non-string entries)', () => {
        expect(util.generateDescription({ grantsFlags: ['corrosive', '   ', 42, 'wet'] }))
            .toBe('Marks the host as corrosive. Marks the host as wet.');
    });

    it('renders a single-turn cadence without the plural "s"', () => {
        expect(util.generateDescription({
            overTime: [{ type: 'restoreExistence', intervalTurns: 1, existenceGainPerInterval: 0.05 }],
        }))
            .toBe('Every 1 turn, restores 0.05 existence to the host.');
    });

    it('drops the cadence prefix (and re-capitalizes) when intervalTurns is absent', () => {
        expect(util.generateDescription({ overTime: [{ type: 'restoreExistence', existenceGainPerInterval: 0.05 }] }))
            .toBe('Restores 0.05 existence to the host.');
    });

    it('skips unrecognized overTime effect types (no generic filler sentence)', () => {
        expect(util.generateDescription({ overTime: [{ type: 'mysteryEffect', intervalTurns: 5 }] }))
            .toBe('No measurable effects declared.');
    });

    it('returns the no-effects string when nothing renders', () => {
        expect(util.generateDescription({})).toBe('No measurable effects declared.');
        expect(util.generateDescription({ grants: {}, grantsFlags: [], overTime: [null, undefined, 'x'] }))
            .toBe('No measurable effects declared.');
    });

    it('defaults missing numeric fields to zero / safe fallbacks (never NaN / "undefined")', () => {
        expect(util.generateDescription({ overTime: [{ type: 'emitChannelDamage' }] }))
            .toBe('Emits 0 channel damage to components within 0.');
        expect(util.generateDescription({ overTime: [{ type: 'emitChannelDamage', damagePerInterval: 2 }] }))
            .toBe('Emits 2 channel damage to components within 0.');
        expect(util.generateDescription({ overTime: [{ type: 'consumeFuelGenerateStat', fuelConsumedPerInterval: 1 }] }))
            .toBe('Burns 1 fuel to charge the host 0 a stat (capacity 0).');
        expect(util.generateDescription({ overTime: [{ type: 'consumeFuelGenerateStat', fuelConsumedPerInterval: 0.5 }] }))
            .toBe('Burns 0 fuel to charge the host 0 a stat (capacity 0).');
    });

    it('formats every "Group.stat" key to a space-separated label (multi-level keys too)', () => {
        expect(util.generateDescription({ grants: { 'Physical.durability.sharp': 3 } }))
            .toBe("Maintains the host's Physical durability sharp at 3.");
    });

    it('capitalizes only the first clause and period-joins the remainder', () => {
        expect(util.generateDescription({ grants: { 'Physical.strength': 50, 'Mind.think_level': 10 } }))
            .toBe("Maintains the host's Physical strength at 50. Maintains the host's Mind think_level at 10.");
    });

    it('renders the coalGenerator shape (grant + consumeFuelGenerateStat) byte-for-byte', () => {
        expect(util.generateDescription({
            grants: { 'Physical.energy': 0 },
            overTime: [{
                type: 'consumeFuelGenerateStat',
                intervalTurns: 5,
                fuelItem: 'coal',
                fuelConsumedPerInterval: 1,
                targetStat: 'Physical.energy',
                energyGainPerInterval: 10,
                energyCapacity: 100,
            }],
        }))
            .toBe("Maintains the host's Physical energy at 0. Every 5 turns, burns 1 coal to charge the host 10 Physical energy (capacity 100).");
    });
});

// ---------------------------------------------------------------------------
// generateDescription — effective per-instance grants (runtime value)
// ---------------------------------------------------------------------------
describe('generateDescription — effective per-instance grants', () => {
    it('shows the per-instance effective grant (not the type default)', () => {
        // strengthCore default is 50; a rolling-ball instance grants 120.
        expect(util.generateDescription(REGISTRY.strengthCore))
            .toBe("Maintains the host's Physical strength at 50.");
        expect(util.generateDescription(REGISTRY.strengthCore, { 'Physical.strength': 120 }))
            .toBe("Maintains the host's Physical strength at 120.");
    });

    it('keeps overTime from the type def even when a grant is overridden', () => {
        // No shipped organ carries both grants and overTime (coalGenerator was
        // made inert off-by-data), so pin the contract with a fixture.
        const def = {
            grants: { 'Physical.energy': 0 },
            overTime: [{ type: 'restoreExistence', intervalTurns: 5, existenceGainPerInterval: 0.02 }],
        };
        expect(util.generateDescription(def, { 'Physical.energy': 7 }))
            .toBe("Maintains the host's Physical energy at 7. Every 5 turns, restores 0.02 existence to the host.");
    });

    it('keeps type grant keys that are not in the per-instance override', () => {
        const def = { grants: { 'Physical.strength': 50, 'Mind.think_level': 10 } };
        expect(util.generateDescription(def, { 'Physical.strength': 120 }))
            .toBe("Maintains the host's Physical strength at 120. Maintains the host's Mind think_level at 10.");
    });

    it('an empty per-instance grants object renders no grant clause (typeless-grant organs)', () => {
        expect(util.generateDescription(REGISTRY.repairSphere, {}))
            .toBe('Every 5 turns, restores 0.02 existence to the host.');
    });

    it('a non-object / array / non-numeric effectiveGrants falls back to the type default', () => {
        expect(util.generateDescription(REGISTRY.strengthCore, 'nope'))
            .toBe("Maintains the host's Physical strength at 50.");
        expect(util.generateDescription(REGISTRY.strengthCore, ['a']))
            .toBe("Maintains the host's Physical strength at 50.");
        expect(util.generateDescription(REGISTRY.strengthCore, { 'Physical.strength': 'x' }))
            .toBe("Maintains the host's Physical strength at 50.");
    });

    it('unknown-type def returns the unknown-string even with effective grants', () => {
        expect(util.generateDescription(null, { 'Physical.strength': 120 })).toBe('Unknown internal component.');
        expect(util.generateDescription(undefined, { 'Physical.strength': 120 })).toBe('Unknown internal component.');
    });
});

// ---------------------------------------------------------------------------
// enrichWithDescriptions — the wire-enrichment contract
// ---------------------------------------------------------------------------
describe('enrichWithDescriptions', () => {
    it('mutates in place and returns the same array reference (chainable)', () => {
        const instances = [{ type: 'strengthCore' }];
        const returned = util.enrichWithDescriptions(instances, REGISTRY);
        expect(returned).toBe(instances);
        expect(instances[0].description).toBe("Maintains the host's Physical strength at 50.");
    });

    it('resolves each instance through the shared registry (per-type text)', () => {
        const instances = [
            { type: 'strengthCore' },
            { type: 'coalGenerator' },
            { type: 'corrosiveGland' },
        ];
        util.enrichWithDescriptions(instances, REGISTRY);
        expect(instances.map(i => i.description)).toStrictEqual([
            "Maintains the host's Physical strength at 50.",
            'Every 5 turns, burns 1 coal to charge the host 10 Physical energy (capacity 100).', // coalGenerator: fuel -> host entity energy
            'Marks the host as corrosive. Every 10 turns, emits 1 corrosion damage to components within 50.',
        ]);
    });

    it('shows the per-instance effective grant when an instance carries one', () => {
        const instances = [
            { type: 'strengthCore', grants: { 'Physical.strength': 120 } }, // rolling-ball override
            { type: 'strengthCore' },                                        // default
        ];
        util.enrichWithDescriptions(instances, REGISTRY);
        expect(instances.map(i => i.description)).toStrictEqual([
            "Maintains the host's Physical strength at 120.",
            "Maintains the host's Physical strength at 50.",
        ]);
    });

    it("uses the instance's grants for an organ whose type def declares no grants", () => {
        const instances = [{ type: 'coalGenerator', grants: { 'Physical.energy': 7 } }];
        util.enrichWithDescriptions(instances, REGISTRY);
        // The instance grant overrides the (empty) type-level grant for the
        // grant clause; the type's overTime fuel -> energy effect still renders.
        expect(instances[0].description).toBe("Maintains the host's Physical energy at 7. Every 5 turns, burns 1 coal to charge the host 10 Physical energy (capacity 100).");
    });

    it('renders the unknown-string for types not present in the registry', () => {
        const instances = [{ type: 'neverShipped' }];
        util.enrichWithDescriptions(instances, REGISTRY);
        expect(instances[0].description).toBe('Unknown internal component.');
    });

    it('renders the unknown-string when the registry itself is missing', () => {
        const instances = [{ type: 'strengthCore' }];
        const returned = util.enrichWithDescriptions(instances, undefined);
        expect(returned).toBe(instances);
        expect(instances[0].description).toBe('Unknown internal component.');
    });

    it('skips non-object and typeless instances (leaves them untouched)', () => {
        const instances = [
            { type: 'strengthCore' },
            null,
            'not-an-object',
            {},          // plain object without a `type`
            42,
        ];
        util.enrichWithDescriptions(instances, REGISTRY);
        expect(instances[0].description).toBe("Maintains the host's Physical strength at 50.");
        expect(instances[1]).toBe(null);            // non-object left untouched
        expect(instances[3].description).toBeUndefined(); // typeless left without a description
        expect(instances[4]).toBe(42);
    });

    it('is a no-op (returns the same reference) for non-array input', () => {
        const o = {};
        const s = 'x';
        const n = null;
        expect(util.enrichWithDescriptions(o, REGISTRY)).toBe(o);
        expect(util.enrichWithDescriptions(s, REGISTRY)).toBe(s);
        expect(util.enrichWithDescriptions(n, REGISTRY)).toBe(n);
    });
});

/**
 * itemBaseStats unit tests — the two rules the module owns: the numeric-leaf
 * rule of a declared `traits` map, and the "what stats does this RECIPE carry
 * before any instance exists" precedence (explicit traits > matter derivation >
 * nothing). Both the equip flow (HoldingCostController / EquippedItemStats-
 * Controller) and the read-only Knowledge codex resolve through these, so a
 * drift between them is the failure class these tests pin.
 *
 * @module test/unit/itemBaseStats
 */

import { describe, it, expect } from 'vitest';
import {
    buildStatsFromTraits,
    hasSeedableTraitValues,
    resolveRecipeBaseStats,
    EXISTENCE_BASELINE,
} from '../../src/utils/itemBaseStats.js';

describe('buildStatsFromTraits (the numeric-leaf rule)', () => {
    it('keeps numeric leaves keyed by trait and drops the rest', () => {
        expect(buildStatsFromTraits({
            Physical: { sharpness: 50, existence: 30, label: 'edge', worn: true },
            Mind: { think_level: 3 },
        })).toEqual({ Physical: { sharpness: 50, existence: 30 }, Mind: { think_level: 3 } });
    });

    it('drops a trait with no numeric leaf (and a whole empty map)', () => {
        expect(buildStatsFromTraits({ Physical: { note: 'x' }, Mind: {} })).toEqual({});
        expect(buildStatsFromTraits({})).toEqual({});
    });

    it('returns {} for missing, null, non-object and array input', () => {
        expect(buildStatsFromTraits(undefined)).toEqual({});
        expect(buildStatsFromTraits(null)).toEqual({});
        expect(buildStatsFromTraits('sharp')).toEqual({});
        expect(buildStatsFromTraits([1, 2])).toEqual({});
    });

    it('skips non-object trait groups instead of throwing', () => {
        expect(buildStatsFromTraits({ Physical: 5, Mind: [1], Soul: null, Body: { mass: 2 } }))
            .toEqual({ Body: { mass: 2 } });
    });
});

describe('hasSeedableTraitValues (when explicit traits are authoritative)', () => {
    it('is true exactly when at least one numeric leaf would seed', () => {
        expect(hasSeedableTraitValues({ Physical: { sharpness: 50 } })).toBe(true);
        expect(hasSeedableTraitValues(undefined)).toBe(false);
        expect(hasSeedableTraitValues({})).toBe(false);
        // A map of annotations alone seeds nothing — and must NOT suppress the
        // matter derivation (the BUG-134 symptom class).
        expect(hasSeedableTraitValues({ Physical: { note: 'no value' } })).toBe(false);
    });
});

describe('resolveRecipeBaseStats (explicit traits > matter derivation > nothing)', () => {
    const deriveStats = () => ({ Physical: { mass: 7.8, sharpness: 82.5 } });

    it('takes explicit recipe traits (form.traits, then legacy traits) over derivation', () => {
        expect(resolveRecipeBaseStats(
            { form: { traits: { Physical: { sharpness: 59.5 } } }, materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats },
        )).toEqual({ Physical: { sharpness: 59.5, existence: EXISTENCE_BASELINE } });
        expect(resolveRecipeBaseStats(
            { traits: { Physical: { sharpness: 40 } }, materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats },
        )).toEqual({ Physical: { sharpness: 40, existence: EXISTENCE_BASELINE } });
    });

    it('falls back to matter derivation when the recipe declares no usable traits', () => {
        const derived = resolveRecipeBaseStats(
            { form: { volume: 1 }, materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats },
        );
        expect(derived.Physical.sharpness).toBe(82.5);
    });

    it('keeps an existence baseline when the derivation omits one', () => {
        const derived = resolveRecipeBaseStats(
            { materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats: () => ({ Physical: { mass: 3 } }) },
        );
        expect(derived.Physical.existence).toBe(EXISTENCE_BASELINE);
    });

    it('seeds the same baseline over explicit traits, so reader and equip agree', () => {
        // The equip flow seeds existence on EVERY path (EquippedItemStatsController
        // .initializeStats). An explicit recipe that declares no existence must not
        // read to the codex as "no existence", or an existence-gated action is
        // withheld from the reader while the world offers it.
        expect(resolveRecipeBaseStats(
            { form: { traits: { Physical: { sharpness: 50 } } } },
            { deriveStats },
        )).toEqual({ Physical: { sharpness: 50, existence: EXISTENCE_BASELINE } });
        // A declared existence outranks the baseline: the seed is a fallback.
        expect(resolveRecipeBaseStats(
            { form: { traits: { Physical: { sharpness: 50, existence: 30 } } } },
            { deriveStats },
        )).toEqual({ Physical: { sharpness: 50, existence: 30 } });
    });

    it('carries no stats when there is nothing to derive from', () => {
        expect(resolveRecipeBaseStats({ name: 'Bare' }, { deriveStats })).toEqual({});
        expect(resolveRecipeBaseStats({ materials: [] }, { deriveStats })).toEqual({});
        expect(resolveRecipeBaseStats({ materials: [{ material: 'iron', fraction: 1 }] })).toEqual({});
    });

    it('degrades to no stats when the derivation throws or yields nothing usable', () => {
        expect(resolveRecipeBaseStats(
            { materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats: () => { throw new Error('bad composition'); } },
        )).toEqual({});
        expect(resolveRecipeBaseStats(
            { materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats: () => [] },
        )).toEqual({});
    });

    it('returns {} for missing, null, non-object and array definitions', () => {
        expect(resolveRecipeBaseStats(undefined, { deriveStats })).toEqual({});
        expect(resolveRecipeBaseStats(null, { deriveStats })).toEqual({});
        expect(resolveRecipeBaseStats('knife', { deriveStats })).toEqual({});
        expect(resolveRecipeBaseStats([], { deriveStats })).toEqual({});
    });

    it('hands the caller a copy — mutating it never touches the derivation result', () => {
        const stats = resolveRecipeBaseStats(
            { materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats: () => ({ Physical: { sharpness: 82.5 } }) },
        );
        stats.Physical.sharpness = 0;
        const again = resolveRecipeBaseStats(
            { materials: [{ material: 'iron', fraction: 1 }] },
            { deriveStats: () => ({ Physical: { sharpness: 82.5 } }) },
        );
        expect(again.Physical.sharpness).toBe(82.5);
    });
});

/**
 * Unit tests for the shared getDefinitionVolume() helper (src/utils/definitionVolume.js).
 *
 * This helper is the single, deduplicated reader of a definition's physical volume,
 * shared by InventoryManager and MaterialChunkDropHandler (L1). It pins every
 * resolution branch, in precedence order, plus the absent/undefined/null fallbacks.
 *
 * @module test/unit/definitionVolume
 */

import { describe, it, expect } from 'vitest';
import { getDefinitionVolume } from '../../src/utils/definitionVolume.js';

describe('getDefinitionVolume()', () => {
    it('reads form.volume (the recipe→derivation model location) with top priority', () => {
        // form.volume wins even when the legacy fallbacks are also present.
        const def = { form: { volume: 3 }, volume: 99, traits: { Physical: { volume: 77 } } };
        expect(getDefinitionVolume(def)).toBe(3);
    });

    it('falls back to the legacy top-level volume when form.volume is absent', () => {
        const def = { volume: 12, traits: { Physical: { volume: 77 } } };
        expect(getDefinitionVolume(def)).toBe(12);
    });

    it('falls back to traits.Physical.volume when neither form.volume nor volume is present', () => {
        const def = { traits: { Physical: { volume: 5 } } };
        expect(getDefinitionVolume(def)).toBe(5);
    });

    it('returns 0 when no volume is declared anywhere', () => {
        expect(getDefinitionVolume({ name: 'Thing' })).toBe(0);
        expect(getDefinitionVolume({})).toBe(0);
    });

    it('returns 0 for null / undefined / non-object inputs', () => {
        expect(getDefinitionVolume(null)).toBe(0);
        expect(getDefinitionVolume(undefined)).toBe(0);
        expect(getDefinitionVolume('not-an-object')).toBe(0);
    });

    it('ignores non-numeric volume values and continues down the fallback chain', () => {
        // form.volume is a string → not a number, so it falls through to top-level volume.
        const def = { form: { volume: '10' }, volume: 4 };
        expect(getDefinitionVolume(def)).toBe(4);
    });
});

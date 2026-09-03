/**
 * Unit tests for the shared volume helpers (src/utils/definitionVolume.js).
 *
 * getDefinitionVolume() is the single, deduplicated reader of a definition's
 * physical volume, shared by InventoryManager and MaterialChunkDropHandler (L1).
 * It pins every resolution branch, in precedence order, plus the
 * absent/undefined/null fallbacks.
 *
 * getDefinitionFootprint() is the single source of the host-footprint
 * chain (external footprint, else full volume), shared by the initial-spawn
 * slot gating (WorldStateController) and the item-addition capacity check
 * (InventoryManager.addItem). These tests pin that chain: precedence between
 * the external-footprint locations, the fallback to the full declared volume,
 * and the graceful absent/undefined/null behavior.
 *
 * @module test/unit/definitionVolume
 */

import { describe, it, expect } from 'vitest';
import { getDefinitionVolume, getDefinitionFootprint } from '../../src/utils/definitionVolume.js';

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

describe('getDefinitionFootprint()', () => {
    // The footprint is the volume an item occupies on its host. Precedence:
    // form.externalVolume (migrated) → legacy top-level externalVolume → the full
    // volume (getDefinitionVolume, which itself is form.volume → volume → traits.Physical.volume).

    it('reads form.externalVolume (the migrated location) with top priority', () => {
        // t1: a small external footprint even though its internal capacity is 10.
        const def = { form: { volume: 10, externalVolume: 1 } };
        expect(getDefinitionFootprint(def)).toBe(1);
    });

    it('lets form.externalVolume win over the legacy top-level externalVolume', () => {
        const def = { form: { externalVolume: 1 }, externalVolume: 5 };
        expect(getDefinitionFootprint(def)).toBe(1);
    });

    it('falls back to the legacy top-level externalVolume when form.externalVolume is absent', () => {
        const def = { externalVolume: 5, form: { volume: 10 } };
        expect(getDefinitionFootprint(def)).toBe(5);
    });

    it('falls back to the migrated form volume (metalBox: form.volume = 10, no external volume)', () => {
        const def = { form: { volume: 10 } };
        expect(getDefinitionFootprint(def)).toBe(10);
    });

    it('falls back to the legacy top-level volume', () => {
        const def = { volume: 7 };
        expect(getDefinitionFootprint(def)).toBe(7);
    });

    it('falls back to traits.Physical.volume when neither external nor volume is present', () => {
        const def = { traits: { Physical: { volume: 3 } } };
        expect(getDefinitionFootprint(def)).toBe(3);
    });

    it('ignores non-numeric external volumes and continues down the fallback chain', () => {
        // form.externalVolume is a string → not a number; externalVolume is a string → not a
        // number; falls through to the full volume (form.volume = 4).
        const def = { form: { externalVolume: 'nope', volume: 4 }, externalVolume: 'also-no' };
        expect(getDefinitionFootprint(def)).toBe(4);
    });

    it('returns 0 for null / undefined / non-object inputs', () => {
        expect(getDefinitionFootprint(null)).toBe(0);
        expect(getDefinitionFootprint(undefined)).toBe(0);
        expect(getDefinitionFootprint('not-an-object')).toBe(0);
        expect(getDefinitionFootprint({})).toBe(0);
    });
});

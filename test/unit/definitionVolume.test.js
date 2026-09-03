/**
 * Unit tests for the shared volume helpers (src/utils/definitionVolume.js).
 *
 * getDefinitionVolume() is the single, deduplicated reader of a definition's
 * physical volume, shared by InventoryManager and MaterialChunkDropHandler (L1).
 * It pins every resolution branch, in precedence order, plus the
 * absent/undefined/null fallbacks.
 *
 * getDefinitionHostFootprint() is the single source of the host-footprint
 * chain (external footprint, else full volume), shared by the initial-spawn
 * slot gating (WorldStateController) and the item-addition capacity check
 * (InventoryManager.addItem). These tests pin that chain: precedence between
 * the external-footprint locations, the fallback to the full declared volume,
 * and the graceful absent/undefined/null behavior.
 *
 * @module test/unit/definitionVolume
 */

import { describe, it, expect } from 'vitest';
import { getDefinitionVolume, getDefinitionHostFootprint } from '../../src/utils/definitionVolume.js';

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

describe('getDefinitionHostFootprint()', () => {
    it('reads form.externalVolume with top priority (recipe→derivation location)', () => {
        // form.externalVolume wins even when the legacy top-level externalVolume
        // and the full-volume fallbacks are also present.
        const def = {
            form: { externalVolume: 2, volume: 12 },
            externalVolume: 99,
            volume: 77,
        };
        expect(getDefinitionHostFootprint(def)).toBe(2);
    });

    it('falls back to the legacy top-level externalVolume when form.externalVolume is absent', () => {
        const def = { form: { volume: 12 }, externalVolume: 3, volume: 77 };
        expect(getDefinitionHostFootprint(def)).toBe(3);
    });

    it('falls back to the full declared volume (getDefinitionVolume) when no external footprint is declared', () => {
        // No externalVolume anywhere → the full volume applies (form.volume wins inside the fallback).
        const def = { form: { volume: 5 }, volume: 99, traits: { Physical: { volume: 77 } } };
        expect(getDefinitionHostFootprint(def)).toBe(5);
    });

    it('returns 0 for null / undefined / non-object definitions (graceful, per getDefinitionVolume conventions)', () => {
        expect(getDefinitionHostFootprint(null)).toBe(0);
        expect(getDefinitionHostFootprint(undefined)).toBe(0);
        expect(getDefinitionHostFootprint('not-an-object')).toBe(0);
        expect(getDefinitionHostFootprint({})).toBe(0);
    });
});

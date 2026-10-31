/**
 * UNIT TEST — M1 shared contract (client/server shared modules + data wiring).
 *
 * Pins the two SHARED (browser-importable) contracts the M1 feature relies on:
 *   - the client's default player blueprint IS the male humanoid droid
 *     (shared/Defaults.js — the spawn point for every new client), and
 *   - the new organ-seeded resource stat `Physical.energy` exists in the
 *     shared stat vocabulary (shared/StatVocabulary.js) under its wire name.
 *
 * Plus a data-presence check that the M1 feature is fully data-driven:
 * the blueprint, the coal material/item/drop-rate entries, and the
 * coalGenerator organ all exist in the data files the controllers load.
 *
 * @module test/unit/m1SharedContract
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_PLAYER_BLUEPRINT } from '../../shared/Defaults.js';
import { STAT_NAMES, TRAIT_GROUPS } from '../../shared/StatVocabulary.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

// The data is read by KIND through the seam, exactly as the server reads it. A
// test that named the file would have to be updated every time a registry moves
// (and it did move: the world data now lives in the official mod packages).

describe('M1 shared contract', () => {
    it('the client default player blueprint is the male humanoid droid', () => {
        expect(DEFAULT_PLAYER_BLUEPRINT).toBe('maleDroid');
        // ...and that blueprint actually exists in the data the server loads.
        const blueprints = DataLoader.loadRegistry(REGISTRY_KINDS.BLUEPRINTS);
        expect(blueprints['maleDroid']).toBeDefined();
        expect(blueprints['maleDroid'][0]).toBe('maleCentralBody');
    });

    it('the energy stat is part of the shared stat vocabulary', () => {
        expect(STAT_NAMES.ENERGY).toBe('energy');
        // The stat lives in the Physical group (where the other matter/form
        // stats live) — the coal generator's targetStat is "Physical.energy".
        expect(TRAIT_GROUPS.PHYSICAL).toBe('Physical');
    });

    it('the M1 feature is fully data-driven (coal + coalGenerator present in the data files)', () => {
        const materials = DataLoader.loadRegistry(REGISTRY_KINDS.MATERIALS);
        expect(materials['coal']).toBeDefined();

        const items = DataLoader.loadRegistry(REGISTRY_KINDS.INVENTORY_ITEMS);
        expect(items['coal']).toBeDefined();
        expect(items['coal'].form.volume).toBe(1);

        const dropRates = DataLoader.loadRegistry(REGISTRY_KINDS.MATERIAL_DROP_RATES);
        expect(dropRates.materials['coal']).toBeDefined();

        const icRegistry = DataLoader.loadRegistry(REGISTRY_KINDS.INTERNAL_COMPONENTS);
        expect(icRegistry['coalGenerator']).toBeDefined();
        // Energy mechanic is data-driven: coalGenerator is a fuel burner that
        // charges the HOST ENTITY's energy attribute (a whole-entity stat, not a
        // per-component stat — so it carries no grants of its own).
        expect(icRegistry['coalGenerator'].grants).toEqual({});
        const effect = icRegistry['coalGenerator'].overTime[0];
        expect(effect).toBeDefined();
        expect(effect.type).toBe('consumeFuelGenerateStat');
        expect(effect.fuelItem).toBe('coal');
        expect(effect.targetStat).toBe('Physical.energy');

        // And the M1 droid actually carries the whole-entity energy attribute it
        // is being charged by (the entityAttributes registry), with the same cap
        // as the generator's energyCapacity (a single value in the data, not a
        // magic number in a controller).
        const entityAttrs = DataLoader.loadRegistry(REGISTRY_KINDS.ENTITY_ATTRIBUTES);
        const energyAttr = entityAttrs.attributes['m1Droid']['Physical.energy'];
        expect(energyAttr).toBeDefined();
        expect(energyAttr.value).toBeGreaterThan(0);
        expect(energyAttr.max).toBe(effect.energyCapacity);
        expect(energyAttr.drainPerTurn).toBeGreaterThan(0);
    });
});

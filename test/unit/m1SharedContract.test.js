/**
 * UNIT TEST — M1 shared contract (client/server shared modules + data wiring).
 *
 * Pins the two SHARED (browser-importable) contracts the M1 feature relies on:
 *   - the client's default player blueprint IS the M1 droid
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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_PLAYER_BLUEPRINT } from '../../shared/Defaults.js';
import { STAT_NAMES, TRAIT_GROUPS } from '../../shared/StatVocabulary.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const readData = (file) => JSON.parse(readFileSync(join(dataDir, file), 'utf8'));

describe('M1 shared contract', () => {
    it('the client default player blueprint is m1Droid', () => {
        expect(DEFAULT_PLAYER_BLUEPRINT).toBe('m1Droid');
        // ...and that blueprint actually exists in the data the server loads.
        const blueprints = readData('blueprints.json');
        expect(blueprints['m1Droid']).toBeDefined();
        expect(blueprints['m1Droid'][0]).toBe('m1CentralBody');
    });

    it('the energy stat is part of the shared stat vocabulary', () => {
        expect(STAT_NAMES.ENERGY).toBe('energy');
        // The stat lives in the Physical group (where the other matter/form
        // stats live) — the coal generator's targetStat is "Physical.energy".
        expect(TRAIT_GROUPS.PHYSICAL).toBe('Physical');
    });

    it('the M1 feature is fully data-driven (coal + coalGenerator present in the data files)', () => {
        const materials = readData('materials.json');
        expect(materials['coal']).toBeDefined();

        const items = readData('inventoryItems.json');
        expect(items['coal']).toBeDefined();
        expect(items['coal'].form.volume).toBe(1);

        const dropRates = readData('materialDropRates.json');
        expect(dropRates.materials['coal']).toBeDefined();

        const icRegistry = readData('internalComponents.json');
        expect(icRegistry['coalGenerator']).toBeDefined();
        // Energy mechanic removed from the data: coalGenerator is inert —
        // no overTime effect (consumes nothing, charges nothing) and no
        // grants. The type is retained so recipes that still install it
        // (m1CentralBody) remain valid.
        expect(icRegistry['coalGenerator'].overTime).toEqual([]);
        expect(icRegistry['coalGenerator'].grants).toEqual({});
    });
});

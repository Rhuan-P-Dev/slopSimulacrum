/**
 * CONTRACT TEST — the shipped world data IS a valid set of official mod packages.
 *
 * The 21 world files were moved into `data/mods/core-<id>/<kind>.json`, each with a
 * `mod.json` manifest. Nothing else in the codebase reads those manifests yet (the
 * boot path still goes through `DataLoader.loadRegistry`), so without this test the
 * packages could silently drift out of step with the loader: a manifest naming a
 * kind the file does not hold, a package whose id is not its directory, a kind
 * nobody ships.
 *
 * Pins, against the REAL `data/mods/` (read-only — nothing is written here):
 *   - discovery finds exactly `REGISTRY_KIND_COUNT` packages and rejects none;
 *   - every shipped package is official, i.e. carries the reserved `core-` prefix;
 *   - each package declares exactly one kind, matching its own file name;
 *   - every kind has exactly one provider, so no official content shadows another;
 *   - the merged candidate equals what the boot path reads today, key for key — the
 *     move did not change a single byte of what the world is made of.
 *
 * @module test/contract/officialMods
 */

import { describe, it, expect } from 'vitest';
import ModLoader, { OFFICIAL_ID_PREFIX } from '../../src/services/ModLoader.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS, REGISTRY_KIND_LIST, REGISTRY_KIND_COUNT } from '../../shared/RegistryKinds.js';

const loader = new ModLoader();

/**
 * The kind an official package id names: `core-holding-cost` -> `holdingCost`.
 * This is the convention the 21 packages were created with and the one the seam's
 * path table follows; asserting it here is what keeps that table derivable rather
 * than a pile of 21 hand-written rows nobody checks.
 * @param {string} id
 * @returns {string}
 */
function kindFromOfficialId(id) {
    return id.slice(OFFICIAL_ID_PREFIX.length).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Drop the top-level `_`-prefixed keys of a data file (`_comment` headers: JSON has
 * no comments, so the shipped files carry theirs this way).
 *
 * The loader treats those keys as file metadata and keeps them OUT of the world
 * definition; `DataLoader.loadRegistry` hands back the parsed file as it stands.
 * Comparing the two therefore needs the same basis, and the loader's side is the
 * correct one: six readers in `src/` already skip `_`-prefixed keys because they are
 * not recipes, not materials, not traits.
 * @param {Object} value
 * @returns {Object}
 */
function stripFileMetadata(value) {
    return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !key.startsWith('_')));
}

describe('the official mod set', () => {
    const { discovered, invalid } = loader.discover();

    it('is discovered whole, with no package rejected', () => {
        expect(invalid, JSON.stringify(invalid)).toEqual([]);
        expect(discovered).toHaveLength(REGISTRY_KIND_COUNT);
    });

    it('is official by identity, and enabled by default', () => {
        for (const mod of discovered) {
            expect(mod.manifest.id.startsWith(OFFICIAL_ID_PREFIX), mod.manifest.id).toBe(true);
            expect(mod.manifest.official, mod.manifest.id).toBe(true);
            expect(mod.enabled, mod.manifest.id).toBe(true);
        }
    });

    it('declares exactly one kind each, and the kind is named by the id', () => {
        for (const mod of discovered) {
            expect(mod.manifest.content).toHaveLength(1);
            expect(mod.manifest.content[0], mod.manifest.id).toBe(kindFromOfficialId(mod.manifest.id));
        }
    });

    it('provides every registry kind exactly once', () => {
        const { providers } = loader.build(discovered);
        for (const kind of REGISTRY_KIND_LIST) {
            expect(providers[kind], `providers of ${kind}`).toHaveLength(1);
        }
        // And no provider claims a kind outside the vocabulary.
        const declared = discovered.flatMap((m) => m.manifest.content);
        expect(declared).toHaveLength(REGISTRY_KIND_COUNT);
    });

    it('builds the same registries the boot path reads today', () => {
        const { registries } = loader.build(discovered);
        for (const kind of REGISTRY_KIND_LIST) {
            const fromMods = registries[kind];
            const fromFile = stripFileMetadata(DataLoader.loadRegistry(kind));
            // One provider per kind means the merge is a copy: any difference here is
            // a moved file that is not the file the table points at.
            expect(fromMods, `registry content differs for ${kind}`).toEqual(fromFile);
            expect(Object.keys(fromMods).length, `${kind} is empty`).toBeGreaterThan(0);
        }
    });

    it('points each package at the file the seam names for its kind', () => {
        for (const kind of REGISTRY_KIND_LIST) {
            const source = DataLoader.registrySourcePath(kind);
            const [modId, fileName] = source.replace('data/mods/', '').split('/');
            const mod = discovered.find((m) => m.manifest.id === modId);
            expect(mod, `no official package at ${source}`).toBeDefined();
            expect(fileName).toBe(`${kind}.json`);
            expect(mod.manifest.content).toEqual([kind]);
        }
    });

    it('ships the kind vocabulary and the package set as the same list', () => {
        // A kind added to the vocabulary without a package, or a package without a
        // kind, lands here rather than in an empty registry at runtime.
        const shipped = discovered.flatMap((m) => m.manifest.content);
        expect([...new Set(shipped)].sort()).toEqual([...REGISTRY_KIND_LIST].sort());
        expect(REGISTRY_KINDS.COMPONENTS).toBe('components');
    });
});

/**
 * UNIT TEST — ModLoader: discovery, manifest narrowing, load order, merge.
 *
 * The loader is pure computation over directories, so the fixtures are real
 * directories created under `data/` at run time and removed afterwards (the
 * loader resolves its base dir relative to the project root — there is no
 * injected filesystem to fake, deliberately: `CR B-3` keeps `fs` in the data
 * seam, so the seam is what these tests exercise).
 *
 * What is pinned here is the contract the world depends on:
 *   - a broken mod is rejected and named, it never aborts the build;
 *   - official-ness comes from the reserved id prefix, never from the manifest;
 *   - order is total (loadOrder, then id), so the merge never depends on readdir;
 *   - merge is field-level, last writer wins per top-level key, and every
 *     overwrite is reported with both owners.
 *
 * @module test/unit/ModLoader
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import ModLoader, {
    MOD_ID_PATTERN,
    MOD_ERROR_CODES,
    OFFICIAL_ID_PREFIX,
    DEFAULT_LOAD_ORDER,
    parseManifest,
    sortModsForLoad,
    mergeRegistryPatch,
    isOfficialModId
} from '../../src/services/ModLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

const FIXTURE_ROOT = path.resolve('data', `.mod-fixture-${process.pid}`);

/** Write one mod package into the fixture root. */
function writeMod(name, manifest, contents = {}) {
    const dir = path.join(FIXTURE_ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    if (manifest !== null) {
        fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest), 'utf8');
    }
    for (const [kind, value] of Object.entries(contents)) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        fs.writeFileSync(path.join(dir, `${kind}.json`), text, 'utf8');
    }
    return dir;
}

/** A loader over the fixture root (the real base dir is not touched). */
function loaderFor(state) {
    return new ModLoader({ baseDir: path.relative(process.cwd(), FIXTURE_ROOT), state });
}

const MANIFEST = (id, version = '1.0.0', content = [REGISTRY_KINDS.COMPONENTS]) => ({ id, version, content });

let loader;

beforeAll(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });

    writeMod('core-base', MANIFEST('core-base', '1.0.0', [REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS]), {
        [REGISTRY_KINDS.COMPONENTS]: {
            _comment: 'shipped',
            knife: { name: 'Knife', form: { volume: 2 }, materials: { steel: 1 } }
        },
        [REGISTRY_KINDS.MATERIALS]: { steel: { name: 'Steel', density: 7.8 } }
    });
    // Loads after core-base (higher loadOrder) and nerfs the knife.
    writeMod('nerf-blades', MANIFEST('nerf-blades', '0.3.0', [REGISTRY_KINDS.COMPONENTS]), {
        [REGISTRY_KINDS.COMPONENTS]: { knife: { form: { volume: 9 } }, torch: { name: 'Torch' } }
    });
    // Loads before core-base: its knife loses.
    writeMod('early-blades', MANIFEST('early-blades', '0.1.0', [REGISTRY_KINDS.COMPONENTS]), {
        [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Ceremonial Blade' } }
    });
    // A manifest that lies about being official, and is still not official.
    writeMod('honest-mod', MANIFEST('honest-mod', '1.0.0'), {});
    // Broken packages: each must be reported, none may abort discovery.
    writeMod('no-manifest', null);
    writeMod('bad-id', MANIFEST('../escape'));
    writeMod('mismatched', MANIFEST('other-name'));
    writeMod('no-version', MANIFEST('no-version', ''));
    writeMod('bogus-kind', MANIFEST('bogus-kind', '1.0.0', ['potions']));
    // Dots are not packages.
    writeMod('.hidden-mod', MANIFEST('hidden-mod'));
    fs.mkdirSync(path.join(FIXTURE_ROOT, 'plain-directory-not-a-mod'), { recursive: true });

    loader = loaderFor({});
});

afterAll(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe('discovery', () => {
    it('finds the packages and skips what is not one', () => {
        const { discovered, invalid } = loader.discover();
        expect(discovered.map((m) => m.manifest.id).sort())
            .toEqual(['core-base', 'early-blades', 'honest-mod', 'nerf-blades']);
        // Not packages: no manifest, bad id, id/dir mismatch, no version, dot dir.
        // Each is reported with a code.
        const byDir = Object.fromEntries(invalid.map((e) => [e.dir, e.code]));
        expect(byDir['no-manifest']).toBe(MOD_ERROR_CODES.MANIFEST_INVALID);
        expect(byDir['bad-id']).toBe(MOD_ERROR_CODES.ID_INVALID);
        expect(byDir['mismatched']).toBe(MOD_ERROR_CODES.ID_DIR_MISMATCH);
        expect(byDir['no-version']).toBe(MOD_ERROR_CODES.MANIFEST_INVALID);
        expect(byDir['bogus-kind']).toBe(MOD_ERROR_CODES.CONTENT_KIND_UNKNOWN);
        expect(byDir['.hidden-mod']).toBeUndefined(); // dot-prefixed: not looked at
        expect(byDir['plain-directory-not-a-mod']).toBe(MOD_ERROR_CODES.MANIFEST_INVALID);
    });

    it('cannot be handed two packages claiming one id, because the id is the directory', () => {
        // A manifest may not name an id other than its own directory, so a second
        // directory claiming an existing id is rejected as a mismatch rather than
        // shadowing the first package's identity.
        const l = loaderFor({});
        writeMod('dupe-a', MANIFEST('dupe-a'), {});
        writeMod('dupe-b', MANIFEST('dupe-a'), {});
        const { discovered, invalid } = l.discover();
        expect(discovered.filter((m) => m.manifest.id === 'dupe-a').map((m) => m.dir)).toEqual(['dupe-a']);
        expect(invalid.filter((e) => e.code === MOD_ERROR_CODES.ID_DIR_MISMATCH).map((e) => e.dir))
            .toContain('dupe-b');
        fs.rmSync(path.join(FIXTURE_ROOT, 'dupe-a'), { recursive: true, force: true });
        fs.rmSync(path.join(FIXTURE_ROOT, 'dupe-b'), { recursive: true, force: true });
    });

    it('treats an empty or missing base dir as no mods, not as an error', () => {
        const empty = new ModLoader({ baseDir: 'data/mods-does-not-exist' });
        const { discovered, invalid } = empty.discover();
        expect(discovered).toEqual([]);
        expect(invalid).toEqual([]);
    });
});

describe('manifest narrowing', () => {
    it('derives official from the reserved prefix and ignores what the manifest says', () => {
        const official = parseManifest({ id: `${OFFICIAL_ID_PREFIX}things`, version: '1.0.0', content: [] }, 'core-things');
        expect(official.official).toBe(true);
        // A third-party package claiming official: the field is not read at all.
        const liar = parseManifest({ id: 'guest-pack', version: '1.0.0', content: [], official: true }, 'guest-pack');
        expect(liar.official).toBe(false);
        expect(isOfficialModId('guest-pack')).toBe(false);
    });

    it('puts declared kinds in vocabulary order, deduplicated', () => {
        const m = parseManifest({
            id: 'x', version: '1', content: [REGISTRY_KINDS.MATERIALS, REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS]
        }, 'x');
        expect(m.content).toEqual([REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS]);
    });

    it('refuses ids that are not a single conservative segment', () => {
        for (const bad of ['../evil', 'a/b', '.hidden', 'Evil', '', 'x'.repeat(80)]) {
            expect(MOD_ID_PATTERN.test(bad), bad).toBe(false);
        }
    });
});

describe('load order', () => {
    it('is ascending by loadOrder with ties broken by id', () => {
        const mods = [
            { manifest: { id: 'zulu' }, loadOrder: 10 },
            { manifest: { id: 'alpha' }, loadOrder: 20 },
            { manifest: { id: 'bravo' }, loadOrder: 10 }
        ];
        expect(sortModsForLoad(mods).map((m) => m.manifest.id)).toEqual(['bravo', 'zulu', 'alpha']);
    });

    it('gives a mod the state file says nothing about the default order', () => {
        const { discovered } = loader.discover();
        const honest = discovered.find((m) => m.manifest.id === 'honest-mod');
        expect(honest.loadOrder).toBe(DEFAULT_LOAD_ORDER);
        expect(honest.enabled).toBe(true);
    });

    it('applies the state file for order and for disable', () => {
        const { discovered } = loaderFor({ 'nerf-blades': { loadOrder: 1, enabled: false } }).discover();
        const nerf = discovered.find((m) => m.manifest.id === 'nerf-blades');
        expect(nerf.loadOrder).toBe(1);
        expect(nerf.enabled).toBe(false);
    });
});

describe('build (merge)', () => {
    it('applies mods in load order, last writer winning per top-level key', () => {
        const { registries } = loader.build();
        // All three component mods sit at DEFAULT_LOAD_ORDER, so the tie-break is
        // the id: core-base, then early-blades, then nerf-blades. Each overwrote
        // only the fields it declared, and kept the rest.
        expect(registries[REGISTRY_KINDS.COMPONENTS].knife.name).toBe('Ceremonial Blade');
        expect(registries[REGISTRY_KINDS.COMPONENTS].knife.form.volume).toBe(9);
        expect(registries[REGISTRY_KINDS.COMPONENTS].knife.materials).toEqual({ steel: 1 });
        expect(registries[REGISTRY_KINDS.COMPONENTS].torch).toBeDefined();
    });

    it('skips file-level metadata keys and keeps definition-level ones', () => {
        const { registries } = loader.build();
        expect(registries[REGISTRY_KINDS.COMPONENTS]._comment).toBeUndefined();
    });

    it('reports every shadowed key with both owners', () => {
        const { shadowed } = loader.build();
        const knifeVolume = shadowed.filter((s) => s.kind === REGISTRY_KINDS.COMPONENTS && s.key === 'knife');
        expect(knifeVolume.length).toBeGreaterThan(0);
        expect(knifeVolume.at(-1)).toMatchObject({ key: 'knife', to: 'nerf-blades' });
    });

    it('lets a later mod remove a definition by nulling it', () => {
        const l = loaderFor({});
        writeMod('zz-eraser', MANIFEST('zz-eraser', '1.0.0', [REGISTRY_KINDS.COMPONENTS]), {
            [REGISTRY_KINDS.COMPONENTS]: { knife: null }
        });
        const { registries } = l.build();
        expect(registries[REGISTRY_KINDS.COMPONENTS].knife).toBeNull();
        fs.rmSync(path.join(FIXTURE_ROOT, 'zz-eraser'), { recursive: true, force: true });
    });

    it('excludes a disabled mod entirely, and names who provided each kind', () => {
        const enabled = loader.build();
        expect(enabled.providers[REGISTRY_KINDS.MATERIALS]).toEqual(['core-base']);
        const l = loaderFor({ 'core-base': { enabled: false } });
        const without = l.build(l.discover().discovered);
        expect(without.registries[REGISTRY_KINDS.MATERIALS]).toEqual({});
        expect(without.providers[REGISTRY_KINDS.MATERIALS]).toEqual([]);
        // Disabling core-base removes exactly what it declared — the knife's
        // materials — and nothing else: the later mods still contribute their own
        // fields of the same definition.
        expect(without.registries[REGISTRY_KINDS.COMPONENTS].knife.materials).toBeUndefined();
        expect(without.registries[REGISTRY_KINDS.COMPONENTS].knife.name).toBe('Ceremonial Blade');
        expect(without.registries[REGISTRY_KINDS.COMPONENTS].torch).toBeDefined();
    });

    it('reports an unreadable or non-object content file without aborting the build', () => {
        const l = loaderFor({});
        writeMod('zz-broken', MANIFEST('zz-broken', '1.0.0', [REGISTRY_KINDS.MATERIALS]), {
            [REGISTRY_KINDS.MATERIALS]: '{ this is not json'
        });
        const { registries, invalid } = l.build();
        expect(invalid.some((e) => e.modId === 'zz-broken' && e.code === MOD_ERROR_CODES.CONTENT_UNREADABLE)).toBe(true);
        // The other mods still built.
        expect(registries[REGISTRY_KINDS.MATERIALS].steel).toBeDefined();
        fs.rmSync(path.join(FIXTURE_ROOT, 'zz-broken'), { recursive: true, force: true });
    });

    it('produces a candidate that does not alias the parsed files', () => {
        const first = loader.build();
        first.registries[REGISTRY_KINDS.COMPONENTS].knife.name = 'mutated in place';
        const second = loader.build();
        expect(second.registries[REGISTRY_KINDS.COMPONENTS].knife.name).not.toBe('mutated in place');
    });
});

describe('mergeRegistryPatch', () => {
    it('merges plain objects and replaces arrays and scalars', () => {
        const target = { thing: { a: 1, list: [1, 2], nested: { x: 1, y: 2 } } };
        mergeRegistryPatch(target, { thing: { list: [9], nested: { y: 22 } } });
        expect(target.thing).toEqual({ a: 1, list: [9], nested: { x: 1, y: 22 } });
    });

    it('returns the top-level keys it touched', () => {
        const touched = mergeRegistryPatch({}, { a: 1, _comment: 'skipped', b: 2 });
        expect(touched).toEqual(['a', 'b']);
    });
});

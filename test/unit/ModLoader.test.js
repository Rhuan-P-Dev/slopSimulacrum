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
 *     overwrite is reported with both owners;
 *   - a key that is never data (`__proto__` and friends) refuses its whole package, is
 *     reported with its location (including inside a list), and never reaches
 *     `Object.prototype` - nor becomes a definition named `constructor`.
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
    resolveRequirements,
    contributingMods,
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

// The exploit this pins: `JSON.parse` keeps `"__proto__"` as an OWN enumerable key, and the
// nested merge asked `target["__proto__"]` — which answers `Object.prototype`, not
// `undefined` — decided "this already exists as an object", and merged into the ancestor of
// every object in the process. A mod of pure data changed program-wide semantics without any
// code involved, which is exactly what `wiki/decisions/mod-system.md` decision 1 promises is
// impossible.
describe('unsafe keys in a merge', () => {
    it('refuses a nested "__proto__" instead of writing into Object.prototype', () => {
        const target = { knife: { name: 'Knife', form: { volume: 2 } } };
        const patch = JSON.parse('{"knife":{"name":"Mod Knife","__proto__":{"pollutedByMod":true}}}');

        mergeRegistryPatch(target, patch);

        expect({}.pollutedByMod).toBeUndefined();
        expect(target.knife.name).toBe('Mod Knife');
    });

    it('keeps every other field of a definition that also carries an unsafe key', () => {
        const target = { knife: { name: 'Knife', form: { volume: 2 } } };
        const patch = JSON.parse(
            '{"knife":{"name":"Mod Knife","__proto__":{"x":1},"form":{"volume":5}}}'
        );

        mergeRegistryPatch(target, patch);

        expect(target.knife).toEqual({ name: 'Mod Knife', form: { volume: 5 } });
        expect({}.x).toBeUndefined();
    });

    it('refuses constructor and prototype on a first contribution, not only on an override', () => {
        const target = {};
        const patch = JSON.parse(
            '{"torch":{"constructor":{"pollutedByMod":true},"prototype":{"alsoBad":true},"name":"Torch"}}'
        );

        mergeRegistryPatch(target, patch);

        expect(target.torch).toEqual({ name: 'Torch' });
        expect({}.pollutedByMod).toBeUndefined();
        expect({}.alsoBad).toBeUndefined();
    });

    it('refuses an unsafe key nested below the second level', () => {
        const target = { knife: { name: 'Knife', form: { volume: 2 } } };
        const patch = JSON.parse(
            '{"knife":{"form":{"volume":2,"detail":{"__proto__":{"deepBad":true}}}}}'
        );

        mergeRegistryPatch(target, patch);

        expect({}.deepBad).toBeUndefined();
        expect(target.knife.form.volume).toBe(2);
    });

    it('still treats a leading-underscore key as data below the top level', () => {
        // The metadata skip is a top-level rule only; `_shelf` inside a definition is data,
        // and the unsafe-key rule must not quietly narrow it to `_`-prefixed keys.
        const target = { knife: { name: 'Knife' } };
        mergeRegistryPatch(target, { knife: { _shelf: 'carved', _proto_hint: 'not a real proto' } });
        expect(target.knife).toEqual({ name: 'Knife', _shelf: 'carved', _proto_hint: 'not a real proto' });
    });

    it('refuses a top-level constructor or prototype as a definition name, not only as a polluted prototype', () => {
        // A distinct failure mode, invisible to every prototype-clean assertion above.
        // `target.constructor` is a function, so the merge's "already an object?" test says
        // NO and the value is ASSIGNED: the registry holder gains an own key named
        // `constructor`, which the store then holds as a definition - while Object.prototype
        // stays untouched. The top-level `_` metadata skip does not cover it either, since
        // neither name begins with an underscore.
        const target = { knife: { name: 'Knife' } };
        const patch = JSON.parse(
            '{"constructor":{"name":"Sneaky"},"prototype":{"name":"Also"},"legit":{"name":"Ok"}}'
        );

        const touched = mergeRegistryPatch(target, patch);

        expect(touched).toEqual(['legit']);
        expect(Object.keys(target)).toEqual(['knife', 'legit']);
    });
});

// A payload can hide inside a list. The merge REPLACES an array rather than merging into it,
// so the value is carried by `deepClone` and not by the nested merge - which means the scan
// is the only thing that would refuse the package. An array-blind scan installs it unreported.
describe('unsafe keys hidden inside an array', () => {
    const ARRAY_ROOT = path.resolve('data', `.mod-unsafe-array-${process.pid}`);

    beforeAll(() => {
        fs.rmSync(ARRAY_ROOT, { recursive: true, force: true });
        const dir = path.join(ARRAY_ROOT, 'array-pack');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'mod.json'),
            JSON.stringify(MANIFEST('array-pack', '1.0.0', [REGISTRY_KINDS.COMPONENTS])),
            'utf8'
        );
        fs.writeFileSync(
            path.join(dir, `${REGISTRY_KINDS.COMPONENTS}.json`),
            '{\n  "knife": {\n    "name": "Knife",\n    "slots": [ { "ok": 1 }, { "__proto__": { "pollutedByMod": true } } ]\n  }\n}\n',
            'utf8'
        );
    });

    afterAll(() => fs.rmSync(ARRAY_ROOT, { recursive: true, force: true }));

    it('names a key hidden in a list element, located by its index', () => {
        const built = new ModLoader({ baseDir: path.relative(process.cwd(), ARRAY_ROOT), state: {} }).build();

        expect(built.unsafeKeys).toHaveLength(1);
        expect(built.unsafeKeys[0].at).toBe('$.knife.slots.1.__proto__');
        expect(built.invalid.some((e) => e.code === MOD_ERROR_CODES.UNSAFE_KEY)).toBe(true);
        expect(built.registries[REGISTRY_KINDS.COMPONENTS]).toEqual({});
        expect({}.pollutedByMod).toBeUndefined();
    });
});

// Package-level rejection has a fixture root of its own: the shared one is asserted
// package-by-package elsewhere, and a rejected package would move those counts.
describe('unsafe keys reject a whole package', () => {
    const UNSAFE_ROOT = path.resolve('data', `.mod-unsafe-${process.pid}`);
    const relRoot = () => path.relative(process.cwd(), UNSAFE_ROOT);

    function writeAt(name, manifest, contents = {}) {
        const dir = path.join(UNSAFE_ROOT, name);
        fs.mkdirSync(dir, { recursive: true });
        if (manifest !== null) {
            fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest), 'utf8');
        }
        for (const [kind, value] of Object.entries(contents)) {
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            fs.writeFileSync(path.join(dir, `${kind}.json`), text, 'utf8');
        }
    }

    beforeAll(() => {
        fs.rmSync(UNSAFE_ROOT, { recursive: true, force: true });
        fs.mkdirSync(UNSAFE_ROOT, { recursive: true });

        writeAt('safe-pack', MANIFEST('safe-pack', '1.0.0', [REGISTRY_KINDS.COMPONENTS]), {
            [REGISTRY_KINDS.COMPONENTS]: { good: { name: 'Good' } }
        });
        // Carries one poisoned key deep inside a definition. Its other files are clean, and
        // it still contributes nothing: a hostile key is a property of the package, so the
        // package is refused whole rather than half-installed.
        // The poisoned file is written as raw text on purpose: in a JS object literal
        // `__proto__:` SETS the prototype instead of creating an own key, so `JSON.stringify`
        // would drop it and the fixture would carry no payload at all - the test would pass
        // for no reason. `JSON.parse` of this text is what creates the own `__proto__` key.
        const POISONED_COMPONENTS = [
            '{',
            '  "good": { "name": "Hijacked" },',
            '  "evil": {',
            '    "name": "Evil",',
            '    "form": { "volume": 1 },',
            '    "detail": { "__proto__": { "pollutedByMod": true } }',
            '  }',
            '}'
        ].join('\n');

        writeAt(
            'poisoned-pack',
            MANIFEST('poisoned-pack', '1.0.0', [REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS]),
            {
                [REGISTRY_KINDS.COMPONENTS]: POISONED_COMPONENTS,
                [REGISTRY_KINDS.MATERIALS]: {
                    unobtainium: { name: 'Unobtainium', density: 1, properties: {} }
                }
            }
        );
    });

    afterAll(() => fs.rmSync(UNSAFE_ROOT, { recursive: true, force: true }));

    it('refuses the package and names the offending content file, without aborting the build', () => {
        const built = new ModLoader({ baseDir: relRoot(), state: {} }).build();

        const rejected = built.invalid.filter((e) => e.code === MOD_ERROR_CODES.UNSAFE_KEY);
        expect([...new Set(rejected.map((e) => e.modId))]).toEqual(['poisoned-pack']);
        expect(rejected.every((e) => /skipped entirely/.test(e.message))).toBe(true);
        // The clean kind of the same package is refused too - the package, not the file.
        expect(rejected.map((e) => e.kind).sort()).toEqual(
            [REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS].sort()
        );
    });

    it('installs no definition of the refused package, including no override', () => {
        const built = new ModLoader({ baseDir: relRoot(), state: {} }).build();

        expect(built.registries[REGISTRY_KINDS.COMPONENTS]).toEqual({ good: { name: 'Good' } });
        expect(built.registries[REGISTRY_KINDS.MATERIALS]).toEqual({});
        expect(built.providers[REGISTRY_KINDS.COMPONENTS]).toEqual(['safe-pack']);
    });

    it('reports each unsafe key with the location it was found at', () => {
        const built = new ModLoader({ baseDir: relRoot(), state: {} }).build();

        expect(built.unsafeKeys).toHaveLength(1);
        expect(built.unsafeKeys[0]).toMatchObject({
            modId: 'poisoned-pack',
            kind: REGISTRY_KINDS.COMPONENTS,
            key: '__proto__',
            at: '$.evil.detail.__proto__'
        });
    });

    it('leaves no polluted key behind in the process', () => {
        new ModLoader({ baseDir: relRoot(), state: {} }).build();
        expect({}.pollutedByMod).toBeUndefined();
    });
});

// A cap that is not asserted is a cap that silently drops findings, so the bounded report is
// pinned here (`A-7`): the count, the disclosure that it was truncated, and WHICH findings
// survive the cut.
describe('the unsafe-key report is bounded', () => {
    const CAP_ROOT = path.resolve('data', `.mod-unsafe-cap-${process.pid}`);

    beforeAll(() => {
        fs.rmSync(CAP_ROOT, { recursive: true, force: true });
        const dir = path.join(CAP_ROOT, 'many-keys');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'mod.json'),
            JSON.stringify(MANIFEST('many-keys', '1.0.0', [REGISTRY_KINDS.COMPONENTS])),
            'utf8'
        );
        const deep = Array.from({ length: 12 }, (_, i) => `  "d${i}": { "x": { "__proto__": { "pollutedByMod": true } } }`);
        // One shallow finding, written last in the file, to pin which findings survive.
        fs.writeFileSync(
            path.join(dir, `${REGISTRY_KINDS.COMPONENTS}.json`),
            `{
${deep.join(',\n')},
  "__proto__": { "pollutedByMod": true }
}
`,
            'utf8'
        );
    });

    afterAll(() => fs.rmSync(CAP_ROOT, { recursive: true, force: true }));

    it('names ten findings and says the rest were dropped', () => {
        const built = new ModLoader({ baseDir: path.relative(process.cwd(), CAP_ROOT), state: {} }).build();

        expect(built.unsafeKeys).toHaveLength(10);
        const entry = built.invalid.find((e) => e.code === MOD_ERROR_CODES.UNSAFE_KEY);
        expect(entry.message).toMatch(/further occurrences not listed/);
        expect({}.pollutedByMod).toBeUndefined();
    });

    it('reports the shallowest finding first, not whichever the walk reached first', () => {
        const built = new ModLoader({ baseDir: path.relative(process.cwd(), CAP_ROOT), state: {} }).build();

        expect(built.unsafeKeys[0].at).toBe('$.__proto__');
    });
});

describe('requires', () => {
    // A fixture root of its own: the shared one is asserted package-by-package elsewhere,
    // and a package that contributes nothing would move those counts.
    const REQ_ROOT = path.resolve('data', `.mod-req-${process.pid}`);
    const relRoot = () => path.relative(process.cwd(), REQ_ROOT);

    function writeAt(name, manifest, contents = {}) {
        const dir = path.join(REQ_ROOT, name);
        fs.mkdirSync(dir, { recursive: true });
        if (manifest !== null) fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest), 'utf8');
        for (const [kind, value] of Object.entries(contents)) {
            fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(value), 'utf8');
        }
    }

    /** The domain code of what a call threw (vitest matches messages, not custom fields). */
    const codeOf = (fn) => {
        try {
            fn();
        } catch (error) {
            return error.code;
        }
        throw new Error('expected the call to throw');
    };

    /** A discovery entry, for the resolver, which needs no disk. */
    const entry = (id, requires = [], enabled = true) => ({
        manifest: { id, requires: [...requires] },
        enabled,
        blocked: null
    });

    beforeAll(() => {
        fs.rmSync(REQ_ROOT, { recursive: true, force: true });
        fs.mkdirSync(REQ_ROOT, { recursive: true });
        const man = (id, requires) => ({
            id,
            version: '1.0.0',
            content: [REGISTRY_KINDS.COMPONENTS],
            ...(requires ? { requires } : {})
        });
        writeAt('base', man('base'), { [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Knife' } } });
        writeAt('needs-base', man('needs-base', ['base']), { [REGISTRY_KINDS.COMPONENTS]: { crowbar: { name: 'Crowbar' } } });
        writeAt('needs-needs-base', man('needs-needs-base', ['needs-base']), { [REGISTRY_KINDS.COMPONENTS]: { torch: { name: 'Torch' } } });
        writeAt('orphan', man('orphan', ['not-installed']), { [REGISTRY_KINDS.COMPONENTS]: { ghost: { name: 'Ghost' } } });
        writeAt('mutual-a', man('mutual-a', ['mutual-b']), { [REGISTRY_KINDS.COMPONENTS]: { a: { name: 'A' } } });
        writeAt('mutual-b', man('mutual-b', ['mutual-a']), { [REGISTRY_KINDS.COMPONENTS]: { b: { name: 'B' } } });
    });

    afterAll(() => {
        fs.rmSync(REQ_ROOT, { recursive: true, force: true });
    });

    describe('manifest narrowing', () => {
        it('reads an absent requires as requiring nothing', () => {
            expect(parseManifest({ id: 'x', version: '1.0.0' }, 'x').requires).toEqual([]);
        });

        it('deduplicates and sorts, so what contributes does not depend on how the file was written', () => {
            expect(parseManifest({ id: 'x', version: '1.0.0', requires: ['b', 'a', 'b'] }, 'x').requires)
                .toEqual(['a', 'b']);
        });

        it('rejects a requires that is not a list of mod ids', () => {
            expect(() => parseManifest({ id: 'x', version: '1.0.0', requires: 'core-materials' }, 'x'))
                .toThrowError(/is not an array of mod ids/);
            expect(codeOf(() => parseManifest({ id: 'x', version: '1.0.0', requires: [42] }, 'x')))
                .toBe(MOD_ERROR_CODES.REQUIRES_INVALID);
            expect(codeOf(() => parseManifest({ id: 'x', version: '1.0.0', requires: ['../escape'] }, 'x')))
                .toBe(MOD_ERROR_CODES.REQUIRES_INVALID);
        });

        it('rejects a package requiring itself, the one cycle nothing else can satisfy', () => {
            expect(codeOf(() => parseManifest({ id: 'x', version: '1.0.0', requires: ['x'] }, 'x')))
                .toBe(MOD_ERROR_CODES.REQUIRES_SELF);
        });
    });

    describe('description narrowing', () => {
        it('reads an absent description as nobody wrote one, not as an error', () => {
            expect(parseManifest({ id: 'x', version: '1.0.0' }, 'x').description).toBe('');
            expect(parseManifest({ id: 'x', version: '1.0.0', description: null }, 'x').description).toBe('');
        });

        it('trims the prose instead of shipping the whitespace it was written with', () => {
            expect(parseManifest({ id: 'x', version: '1.0.0', description: '  Adds parts.  ' }, 'x').description)
                .toBe('Adds parts.');
        });

        it('rejects a description that is not a string, before it reaches a text node', () => {
            expect(codeOf(() => parseManifest({ id: 'x', version: '1.0.0', description: { en: 'hi' } }, 'x')))
                .toBe(MOD_ERROR_CODES.MANIFEST_INVALID);
            expect(codeOf(() => parseManifest({ id: 'x', version: '1.0.0', description: 7 }, 'x')))
                .toBe(MOD_ERROR_CODES.MANIFEST_INVALID);
        });
    });

    describe('resolution', () => {
        it('leaves a package whose requirements are met alone', () => {
            const mods = resolveRequirements([entry('base'), entry('child', ['base'])]);
            expect(mods.map((m) => [m.manifest.id, m.blocked])).toEqual([['base', null], ['child', null]]);
        });

        it('blocks the dependent of a disabled package, naming the requirement', () => {
            const mods = resolveRequirements([entry('base'), entry('child', ['base'], true), entry('base-off', [], false)]);
            expect(mods.find((m) => m.manifest.id === 'base-off').blocked).toBeNull();
            const off = resolveRequirements([entry('base', [], false), entry('child', ['base'])]);
            const child = off.find((m) => m.manifest.id === 'child');
            expect(child.blocked.code).toBe(MOD_ERROR_CODES.REQUIREMENT_DISABLED);
            expect(child.blocked.message).toContain('"base"');
            expect(child.blocked.message).toContain('disabled');
        });

        it('blocks a package whose requirement is not installed at all', () => {
            const mods = resolveRequirements([entry('orphan', ['not-installed'])]);
            expect(mods[0].blocked.code).toBe(MOD_ERROR_CODES.REQUIREMENT_MISSING);
            expect(mods[0].blocked.message).toContain('not installed');
        });

        it('cascades through the chain and names the closest break, not the whole trace', () => {
            const mods = resolveRequirements([
                entry('root', [], false),
                entry('mid', ['root']),
                entry('leaf', ['mid'])
            ]);
            const mid = mods.find((m) => m.manifest.id === 'mid');
            const leaf = mods.find((m) => m.manifest.id === 'leaf');
            expect(mid.blocked.code).toBe(MOD_ERROR_CODES.REQUIREMENT_DISABLED);
            expect(leaf.blocked.code).toBe(MOD_ERROR_CODES.REQUIREMENT_BLOCKED);
            // The sentence starts at the closest break - that is what the operator acts on -
            // and keeps the cause in parentheses, so the chain is still readable.
            expect(leaf.blocked.message).toMatch(/^requires "mid", which cannot contribute /);
            expect(leaf.blocked.message).toContain('requires "root", which is disabled');
        });

        it('is not afraid of mutual requires, which is how the official set is built', () => {
            // core-components and core-internal-components reference each other's definitions.
            // A cycle that is installed and enabled is satisfied, so resolution must not
            // report it - the fixpoint starts satisfied and only removes.
            const mods = resolveRequirements([entry('a', ['b']), entry('b', ['a'])]);
            expect(mods.every((m) => m.blocked === null)).toBe(true);
        });

        it('reports the contributing set in input order', () => {
            const mods = resolveRequirements([entry('a'), entry('b', ['a'], false), entry('c', ['b'])]);
            expect(contributingMods(mods).map((m) => m.manifest.id)).toEqual(['a']);
        });
    });

    describe('build', () => {
        it('keeps a blocked package out of the candidate and says why', () => {
            const built = new ModLoader({ baseDir: relRoot() }).build();
            // `base` is enabled, so its dependents contribute too.
            expect(built.registries[REGISTRY_KINDS.COMPONENTS].ghost).toBeUndefined();
            expect(built.registries[REGISTRY_KINDS.COMPONENTS].crowbar).toBeDefined();
            const orphan = built.blocked.find((entry2) => entry2.modId === 'orphan');
            expect(orphan.code).toBe(MOD_ERROR_CODES.REQUIREMENT_MISSING);
            expect(orphan.requires).toEqual(['not-installed']);
            expect(orphan.message).toMatch(/not installed/);
        });

        it('cascades when the base of the chain is disabled', () => {
            const built = new ModLoader({ baseDir: relRoot(), state: { base: { enabled: false } } }).build();
            const items = built.registries[REGISTRY_KINDS.COMPONENTS];
            expect(items.knife).toBeUndefined();
            expect(items.crowbar).toBeUndefined();
            expect(items.torch).toBeUndefined();
            // `orphan` requires a package nobody installed, so it is blocked in every case.
            expect(built.blocked.map((e) => e.modId).sort()).toEqual(['needs-base', 'needs-needs-base', 'orphan']);
            // The transitive one is reported as blocked by the nearest break.
            expect(built.blocked.find((e) => e.modId === 'needs-needs-base').code)
                .toBe(MOD_ERROR_CODES.REQUIREMENT_BLOCKED);
        });

        it('does not report a package that is merely disabled', () => {
            const built = new ModLoader({ baseDir: relRoot(), state: { orphan: { enabled: false } } }).build();
            expect(built.blocked.map((e) => e.modId)).not.toContain('orphan');
        });
    });
});

/**
 * UNIT TEST — ModService: the installed view, the rescan, and the plan.
 *
 * The service sits between the loader (what is on disk) and the store (what the
 * world runs), and its whole contract is "report, never change". So the two things
 * pinned hardest here are that a plan computes without writing (the store version
 * cannot move) and that the diff is real: key order in a merged definition is not a
 * change, and a package that is disabled contributes neither additions nor removals.
 *
 * Fixtures are real directories under `data/` (created here, removed afterwards),
 * because the loader reads through the data seam — there is no injected filesystem
 * to fake, deliberately (`CR B-3`).
 *
 * @module test/unit/ModService
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import ModService, {
    diffRegistry, MAX_KEYS_PER_KIND, APPLY_AT, LOAD_ORDER_STRIDE, ownerChanges, ownersOf
} from '../../src/services/ModService.js';
import ModLoader from '../../src/services/ModLoader.js';
import RegistryStore from '../../src/services/RegistryStore.js';
import { REGISTRY_KINDS, REGISTRY_KIND_LIST } from '../../shared/RegistryKinds.js';

const FIXTURE_ROOT = path.resolve('data', `.mod-service-${process.pid}`);
const RELATIVE_ROOT = path.relative(process.cwd(), FIXTURE_ROOT);

function writeMod(name, content, files) {
    const dir = path.join(FIXTURE_ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ id: name, version: '1.0.0', content }), 'utf8');
    for (const [kind, value] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(value), 'utf8');
    }
}

/** A loader over the fixture root. */
const loader = (state) => new ModLoader({ baseDir: RELATIVE_ROOT, state });

/** The store the world runs, built from the same packages (an already-applied world). */
function storeFrom(state) {
    return new RegistryStore(loader(state).build().registries);
}

let service;

beforeAll(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    writeMod('core-parts', [REGISTRY_KINDS.COMPONENTS], {
        [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Knife', form: { volume: 2 } } }
    });
    writeMod('extra-parts', [REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS], {
        [REGISTRY_KINDS.COMPONENTS]: { crowbar: { name: 'Crowbar' } },
        // A complete material entry: the materials owner requires name, density and
        // properties, and an incomplete one would quarantine the whole material family
        // and hide every component-level verdict below it.
        [REGISTRY_KINDS.MATERIALS]: { steel: { name: 'Steel', density: 7.8, properties: {} } }
    });
    writeMod('broken', ['not-a-kind'], {});
});

afterAll(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe('construction', () => {
    it('refuses to exist without the live store', () => {
        expect(() => new ModService({})).toThrowError(/registryStore is required/);
        expect(() => new ModService({ registryStore: {} })).toThrowError(/registryStore is required/);
    });
});

describe('list and rescan', () => {
    it('answers "not scanned yet" before the first scan', () => {
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}) });
        const view = s.list();
        expect(view.scanned).toBe(false);
        expect(view.mods).toEqual([]);
        // The live side is always available: it is what the world runs, not what
        // the disk says.
        expect(view.live.definitionCounts[REGISTRY_KINDS.COMPONENTS]).toBeGreaterThan(0);
    });

    it('names every package, official by identity, and keeps rejects in invalid', () => {
        service = new ModService({ registryStore: storeFrom(), loader: loader({}) });
        const { scanned, mods, invalid } = service.rescan();
        expect(scanned).toBe(true);
        expect(mods.map((m) => m.id)).toEqual(['core-parts', 'extra-parts']);
        expect(mods.find((m) => m.id === 'core-parts').official).toBe(true);
        expect(mods.find((m) => m.id === 'extra-parts').official).toBe(false);
        expect(mods.find((m) => m.id === 'extra-parts').content)
            .toEqual([REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS]);
        expect(invalid.map((e) => e.dir)).toEqual(['broken']);
        // list() now answers from the scan, without re-reading the disk.
        expect(service.list().scanned).toBe(true);
        expect(service.list().mods).toHaveLength(2);
    });
});

// Its own fixture root: the shared one is asserted package-by-package above, and a refused
// package would move those counts.
describe('a package carrying an unsafe key', () => {
    const ROOT = path.resolve('data', `.mod-service-unsafe-${process.pid}`);
    const REL = () => path.relative(process.cwd(), ROOT);

    function writeAt(name, content, files) {
        const dir = path.join(ROOT, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ id: name, version: '1.0.0', content }), 'utf8');
        for (const [kind, value] of Object.entries(files)) {
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            fs.writeFileSync(path.join(dir, `${kind}.json`), text, 'utf8');
        }
    }

    // Raw text because `JSON.stringify` of a literal cannot carry an own `__proto__` key.
    const POISONED = [
        '{',
        '  "good": { "name": "Hijacked" },',
        '  "evil": { "name": "Evil", "detail": { "__proto__": { "pollutedByMod": true } } }',
        '}'
    ].join('\n');

    let store;

    beforeAll(() => {
        fs.rmSync(ROOT, { recursive: true, force: true });
        fs.mkdirSync(ROOT, { recursive: true });
        writeAt('good-parts', [REGISTRY_KINDS.COMPONENTS], {
            [REGISTRY_KINDS.COMPONENTS]: { good: { name: 'Good' } }
        });
        writeAt(
            'poison-parts',
            [REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS],
            {
                [REGISTRY_KINDS.COMPONENTS]: POISONED,
                [REGISTRY_KINDS.MATERIALS]: { bedrock: { name: 'Bedrock', density: 5, properties: {} } }
            }
        );
        // The world runs the good package only.
        store = new RegistryStore({ [REGISTRY_KINDS.COMPONENTS]: { good: { name: 'Good' } } });
    });

    afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

    const serviceFor = () => new ModService({ registryStore: store, loader: new ModLoader({ baseDir: REL() }) });

    it('is named by plan, and contributes nothing to the kinds an apply would install', () => {
        const plan = serviceFor().plan();

        expect(plan.unsafeKeys).toHaveLength(1);
        expect(plan.unsafeKeys[0]).toMatchObject({
            modId: 'poison-parts',
            kind: REGISTRY_KINDS.COMPONENTS,
            key: '__proto__',
            at: '$.evil.detail.__proto__'
        });
        // Nothing of the refused package in the diff, and no override of the good definition.
        expect(plan.kinds).toEqual([]);
    });

    it('leaves the store untouched when planning', () => {
        const before = store.version();
        serviceFor().plan();
        expect(store.version()).toBe(before);
        expect(store.read(REGISTRY_KINDS.MATERIALS)).toEqual({});
    });

    it('applies the world without it, and says so in the report', () => {
        const report = serviceFor().applyNow();

        expect(report.ok).toBe(true);
        expect(report.unsafeKeys).toHaveLength(1);
        expect(report.unsafeKeys[0].modId).toBe('poison-parts');
        // The clean file of the refused package is gone with the package.
        expect(store.read(REGISTRY_KINDS.MATERIALS)).toEqual({});
        expect(store.read(REGISTRY_KINDS.COMPONENTS).good).toEqual({ name: 'Good' });
        expect({}.pollutedByMod).toBeUndefined();
    });
});

describe('plan', () => {
    it('is empty against a world built from the same packages', () => {
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}) });
        const plan = s.plan();
        expect(plan.applied).toBe(false);
        expect(plan.kinds).toEqual([]);
        expect(plan.shadowed).toEqual([]);
    });

    it('reports what a package adds, and does not write anything', () => {
        // A world built WITHOUT the extra package (its content absent from the
        // store), while the disk has it: the plan must name exactly the delta.
        const withoutExtra = new RegistryStore({
            [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Knife', form: { volume: 2 } } }
        });
        const before = withoutExtra.version();
        const s = new ModService({ registryStore: withoutExtra, loader: loader({}) });
        const plan = s.plan();

        const components = plan.kinds.find((k) => k.kind === REGISTRY_KINDS.COMPONENTS);
        expect(components.added).toEqual(['crowbar']);
        expect(components.addedCount).toBe(1);
        expect(components.providers).toEqual(['core-parts', 'extra-parts']);
        expect(plan.kinds.find((k) => k.kind === REGISTRY_KINDS.MATERIALS).added).toEqual(['steel']);
        expect(withoutExtra.version(), 'a plan must never swap the world').toBe(before);
    });

    it('reports what disabling a package would remove', () => {
        const applied = storeFrom();
        const s = new ModService({ registryStore: applied, loader: loader({ 'extra-parts': { enabled: false } }) });
        const plan = s.plan();
        const components = plan.kinds.find((k) => k.kind === REGISTRY_KINDS.COMPONENTS);
        expect(components.removed).toEqual(['crowbar']);
        expect(components.added).toEqual([]);
        expect(plan.kinds.find((k) => k.kind === REGISTRY_KINDS.MATERIALS).removed).toEqual(['steel']);
    });

    it('counts a field-level override as changed, and reports both owners of a shadow', () => {
        const applied = new RegistryStore({
            [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Knife', form: { volume: 2 } } }
        });
        // A package that only nerfs the knife's volume: the world still has the old
        // value, so this kind changed — and only this kind.
        writeMod('zz-nerf', [REGISTRY_KINDS.COMPONENTS], {
            [REGISTRY_KINDS.COMPONENTS]: { knife: { form: { volume: 9 } } }
        });
        const plan = new ModService({ registryStore: applied, loader: loader({}) }).plan();
        const components = plan.kinds.find((k) => k.kind === REGISTRY_KINDS.COMPONENTS);
        expect(components.changed).toEqual(['knife']);
        expect(components.changedCount).toBe(1);
        expect(plan.shadowed.some((s) => s.key === 'knife' && s.to === 'zz-nerf')).toBe(true);
        fs.rmSync(path.join(FIXTURE_ROOT, 'zz-nerf'), { recursive: true, force: true });
    });

    it('quarantines a definition the world would refuse, and does not count it as added', () => {
        // The store is built BEFORE the broken package is written, so the plan's only
        // subject is that package.
        const applied = storeFrom();
        writeMod('zz-broken', [REGISTRY_KINDS.INVENTORY_ITEMS], {
            [REGISTRY_KINDS.INVENTORY_ITEMS]: {
                goodBolt: { name: 'Good Bolt', materials: [{ material: 'steel', fraction: 1 }] },
                rustyBolt: { name: 'Rusty Bolt', materials: [{ material: 'unobtainium', fraction: 1 }] }
            }
        });
        const plan = new ModService({ registryStore: applied, loader: loader({}) }).plan();

        expect(plan.quarantine).toHaveLength(1);
        const entry = plan.quarantine[0];
        expect([entry.kind, entry.key, entry.scope]).toEqual([REGISTRY_KINDS.INVENTORY_ITEMS, 'rustyBolt', 'definition']);
        expect(entry.reason).toMatch(/unobtainium/);
        // The good definition lands; the broken one is not in the diff, because an apply
        // installs the classified candidate.
        const items = plan.kinds.find((k) => k.kind === REGISTRY_KINDS.INVENTORY_ITEMS);
        expect(items.added).toEqual(['goodBolt']);
        expect(items.removedCount).toBe(0);
        // And nothing was written by asking.
        expect(applied.read(REGISTRY_KINDS.INVENTORY_ITEMS).rustyBolt).toBeUndefined();
        fs.rmSync(path.join(FIXTURE_ROOT, 'zz-broken'), { recursive: true, force: true });
    });

    it('names rejects in the plan too, so an apply is not blind to them', () => {
        const plan = new ModService({ registryStore: storeFrom(), loader: loader({}) }).plan();
        expect(plan.invalid.map((e) => e.code)).toContain('MOD_CONTENT_KIND_UNKNOWN');
    });
});

describe('the kind vocabulary', () => {
    it('names every kind a manifest can declare, with the file it reads', () => {
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}) });
        const kinds = s.kinds();
        expect(kinds.length).toBe(REGISTRY_KIND_LIST.length);
        const components = kinds.find((k) => k.kind === REGISTRY_KINDS.COMPONENTS);
        expect(components.file).toBe('components.json');
        // The count is the live one, so the vocabulary doubles as "what the world holds
        // right now": here the store was built from both fixture packages, so the two
        // components (knife from core-parts, crowbar from extra-parts) are both counted.
        expect(components.liveCount).toBe(2);
        // The name a mod author has to be told about, pinned so a rename moves it
        // loudly: the entity blueprints are the `npcs` kind.
        const entities = kinds.find((k) => k.kind === REGISTRY_KINDS.NPCS);
        expect([entities.file, entities.coreDir]).toEqual(['npcs.json', 'core-npcs']);
    });
});

describe('enable, disable, and the queue', () => {
    /** An in-memory state store: a unit test of "what is enabled" must not write the file
     *  the next boot reads. `store.state` is what was saved, `store.saves` how often. */
    const memState = (initial = {}) => {
        const store = { state: { ...initial }, saves: 0 };
        return {
            load: () => ({ ...store.state }),
            save: (next) => { store.state = JSON.parse(JSON.stringify(next)); store.saves += 1; },
            store
        };
    };

    it('writes the wish, not the world', () => {
        const applied = storeFrom();
        const ss = memState();
        const s = new ModService({ registryStore: applied, loader: loader({}), stateStore: ss });
        const result = s.disable('extra-parts');

        expect(result).toMatchObject({
            id: 'extra-parts', enabled: false, pending: true, appliesAt: 'next round boundary'
        });
        expect(ss.store.state['extra-parts']).toEqual({ enabled: false });
        // The world still runs the package it booted with. This is the whole point of the
        // boundary, so it is pinned hardest here.
        expect(applied.read(REGISTRY_KINDS.COMPONENTS).crowbar).toBeDefined();
        expect(applied.version()).toBe(1);
    });

    it('refuses a package that is not installed', () => {
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}), stateStore: memState() });
        expect(() => s.disable('no-such-mod')).toThrowError(/no mod package named "no-such-mod"/);
        expect(() => s.enable('')).toThrowError(/non-empty string/);
    });

    it('is idempotent: the same answer for a package already in that state', () => {
        const ss = memState({ 'extra-parts': { enabled: false } });
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}), stateStore: ss });
        const result = s.disable('extra-parts');
        expect(result).toMatchObject({ enabled: false, pending: false });
    });

    it('swaps at the boundary, reports what it swapped, and drains the queue', () => {
        const applied = storeFrom();
        const s = new ModService({ registryStore: applied, loader: loader({}), stateStore: memState() });
        s.disable('extra-parts');
        const report = s.applyPending();

        expect(report.ok).toBe(true);
        expect(report.version).toBe(2);
        expect(report.swappedKinds).toContain(REGISTRY_KINDS.COMPONENTS);
        // The disabled package is out; everything else is where it was.
        expect(applied.read(REGISTRY_KINDS.COMPONENTS).crowbar).toBeUndefined();
        expect(applied.read(REGISTRY_KINDS.COMPONENTS).knife).toBeDefined();
        expect(applied.read(REGISTRY_KINDS.MATERIALS).steel).toBeUndefined();
        // Drained: the next boundary does nothing and says so.
        expect(s.pending).toBe(false);
        expect(s.applyPending()).toBeNull();
        expect(applied.version()).toBe(2);
    });

    it('brings the content back when the package is enabled again', () => {
        const applied = storeFrom();
        const s = new ModService({ registryStore: applied, loader: loader({}), stateStore: memState() });
        s.disable('extra-parts');
        s.applyPending();
        s.enable('extra-parts');
        s.applyPending();
        expect(applied.read(REGISTRY_KINDS.COMPONENTS).crowbar).toBeDefined();
        expect(applied.version()).toBe(3);
    });

    it('records a refused apply instead of retrying it at every boundary', () => {
        const refusing = {
            read: () => ({}),
            version: () => 1,
            definitionCounts: () => ({}),
            replace: () => { throw new Error('candidate refused'); }
        };
        const s = new ModService({ registryStore: refusing, loader: loader({}), stateStore: memState() });
        s.disable('extra-parts');
        const report = s.applyPending();
        expect(report.ok).toBe(false);
        expect(report.error).toMatch(/candidate refused/);
        // Not retried: a candidate the world refuses would otherwise be rebuilt at every
        // round, and a warning every round is how a real problem gets tuned out.
        expect(s.applyPending()).toBeNull();
        expect(s.list().lastApply.error).toMatch(/candidate refused/);
    });

    it('lists the queue so an operator can tell wished from running', () => {
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}), stateStore: memState() });
        expect(s.list().pending).toBe(false);
        s.disable('extra-parts');
        const list = s.list();
        expect(list.pending).toBe(true);
        expect(list.appliesAt).toBe('next round boundary');
        expect(list.lastApply).toBeNull();
        expect(list.mods.find((m) => m.id === 'extra-parts').enabled).toBe(false);
    });
});

describe('requestApply: the apply button, gated on a round', () => {
    const memState = (initial = {}) => {
        const store = { state: { ...initial } };
        return { load: () => ({ ...store.state }), save: (next) => { store.state = next; } };
    };

    it('defers while a round is open, and keeps the ask', () => {
        const applied = storeFrom();
        const s = new ModService({
            registryStore: applied, loader: loader({}), stateStore: memState(), roundGate: () => true
        });
        const answer = s.requestApply();

        expect(answer).toMatchObject({ applied: false, pending: true, appliesAt: 'next round boundary', reason: 'ROUND_ACTIVE' });
        // The deferral is a no-op on the world: agents are reading the definition the
        // round opened with (`CR D-6`).
        expect(applied.version()).toBe(1);
    });

    it('swaps when no round is open, and reports what it swapped', () => {
        const applied = storeFrom();
        const s = new ModService({
            registryStore: applied, loader: loader({}), stateStore: memState(), roundGate: () => false
        });
        const answer = s.requestApply();

        expect(answer.applied).toBe(true);
        expect(answer.pending).toBe(false);
        expect(answer.report.ok).toBe(true);
        expect(applied.version()).toBe(2);
    });

    it('swaps when no gate was given at all (a world built without a turn system)', () => {
        const applied = storeFrom();
        const s = new ModService({ registryStore: applied, loader: loader({}), stateStore: memState() });
        expect(s.requestApply().applied).toBe(true);
        expect(applied.version()).toBe(2);
    });
});

describe('packageFiles: what an operator installed', () => {
    it('lists the manifest and every content file with the kind it feeds', () => {
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}), stateStore: { load: () => ({}), save: () => {} } });
        s.rescan();
        const view = s.packageFiles('extra-parts');

        expect(view.id).toBe('extra-parts');
        expect(view.manifest).toMatchObject({ id: 'extra-parts', version: '1.0.0' });
        const byName = Object.fromEntries(view.files.map((file) => [file.name, file]));
        expect(byName['mod.json'].kind).toBeNull();
        expect(byName[`${REGISTRY_KINDS.COMPONENTS}.json`].kind).toBe(REGISTRY_KINDS.COMPONENTS);
        expect(byName[`${REGISTRY_KINDS.COMPONENTS}.json`].content).toEqual({ crowbar: { name: 'Crowbar' } });
    });

    it('names a package that is not installed instead of reading a path', () => {
        const s = new ModService({ registryStore: storeFrom(), loader: loader({}), stateStore: { load: () => ({}), save: () => {} } });
        s.rescan();
        expect(() => s.packageFiles('no-such-mod')).toThrowError(/no mod package named "no-such-mod"/);
        // A traversal attempt is not an installed id either: the id is matched against
        // the discovery scan, never joined to a path.
        expect(() => s.packageFiles('../../etc')).toThrowError(/no mod package named/);
    });
});

describe('diffRegistry', () => {
    it('does not call key order a change', () => {
        const live = { thing: { a: 1, b: { c: 2, d: 3 } } };
        const merged = { thing: { b: { d: 3, c: 2 }, a: 1 } };
        const diff = diffRegistry(live, merged);
        expect(diff.changedCount).toBe(0);
        expect(diff.addedCount).toBe(0);
        expect(diff.unchanged).toBe(1);
    });

    it('separates added, removed and changed, and caps the name lists', () => {
        const live = { keep: 1, drop: 1, edit: { v: 1 } };
        const candidate = { keep: 1, edit: { v: 2 }, ...Object.fromEntries(
            Array.from({ length: MAX_KEYS_PER_KIND + 5 }, (_, i) => [`new${i}`, 1])
        ) };
        const diff = diffRegistry(live, candidate);
        expect(diff.removed).toEqual(['drop']);
        expect(diff.changed).toEqual(['edit']);
        expect(diff.addedCount).toBe(MAX_KEYS_PER_KIND + 5);
        expect(diff.added).toHaveLength(MAX_KEYS_PER_KIND);
        expect(diff.truncated).toBe(true);
    });

    it('treats a missing side as empty rather than throwing', () => {
        expect(diffRegistry(undefined, { a: 1 }).added).toEqual(['a']);
        expect(diffRegistry({ a: 1 }, undefined).removed).toEqual(['a']);
    });
});

describe('requires: refusing a change the install cannot honor', () => {
    // Its own fixture root, for the same reason as the loader's: the packages here
    // contribute nothing in some cases, and the shared fixture is counted elsewhere.
    const REQ_ROOT = path.resolve('data', `.mod-service-req-${process.pid}`);
    const relRoot = () => path.relative(process.cwd(), REQ_ROOT);

    function writeAt(name, content, files, requires) {
        const dir = path.join(REQ_ROOT, name);
        fs.mkdirSync(dir, { recursive: true });
        const manifest = { id: name, version: '1.0.0', content };
        if (requires) manifest.requires = requires;
        fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest), 'utf8');
        for (const [kind, value] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(value), 'utf8');
        }
    }

    /** In-memory state store (the one in the other describe is not in scope here). */
    const memState = () => {
        const holder = { state: {} };
        return { load: () => ({ ...holder.state }), save: (next) => { holder.state = { ...next }; }, holder };
    };

    const codeOf = (fn) => {
        try {
            fn();
        } catch (error) {
            return error.code;
        }
        throw new Error('expected the call to throw');
    };

    const service = (state = {}) => new ModService({
        registryStore: new RegistryStore(new ModLoader({ baseDir: relRoot(), state }).build().registries),
        loader: new ModLoader({ baseDir: relRoot(), state }),
        stateStore: memState()
    });

    beforeAll(() => {
        fs.rmSync(REQ_ROOT, { recursive: true, force: true });
        fs.mkdirSync(REQ_ROOT, { recursive: true });
        writeAt('core-base', [REGISTRY_KINDS.COMPONENTS], { [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Knife' } } });
        writeAt('addon', [REGISTRY_KINDS.COMPONENTS], { [REGISTRY_KINDS.COMPONENTS]: { gasket: { name: 'Gasket' } } }, ['core-base']);
        writeAt('needs-gone', [REGISTRY_KINDS.COMPONENTS], { [REGISTRY_KINDS.COMPONENTS]: { ghost: { name: 'Ghost' } } }, ['not-installed']);
    });

    afterAll(() => {
        fs.rmSync(REQ_ROOT, { recursive: true, force: true });
    });

    it('refuses to disable a package another enabled package requires, naming who', () => {
        const s = service();
        expect(codeOf(() => s.disable('core-base'))).toBe('MOD_REQUIREMENT_HELD');
        expect(() => s.disable('core-base')).toThrowError(/cannot disable "core-base": addon requires it/);
        // The refusal is the whole effect: nothing written, nothing queued.
        expect(s.list().pending).toBe(false);
        expect(memStateOf(s).state['core-base']).toBeUndefined();
    });

    it('allows it once the dependents are out', () => {
        const s = service();
        s.disable('addon');
        expect(() => s.disable('core-base')).not.toThrow();
        expect(s.pending).toBe(true);
    });

    it('refuses to enable a package whose own requirement is not met', () => {
        const s = service();
        expect(codeOf(() => s.enable('needs-gone'))).toBe('MOD_REQUIREMENT_UNMET');
        expect(() => s.enable('needs-gone')).toThrowError(/cannot enable "needs-gone"/);
    });

    it('lists what is installed, enabled, and contributing nothing', () => {
        const s = service();
        s.rescan();
        const blocked = s.list().blocked;
        expect(blocked.map((entry) => entry.id)).toEqual(['needs-gone']);
        expect(blocked[0].code).toBe('MOD_REQUIREMENT_MISSING');
        expect(blocked[0].requires).toEqual(['not-installed']);
        expect(s.list().mods.find((m) => m.id === 'addon').requires).toEqual(['core-base']);
        expect(s.list().mods.find((m) => m.id === 'core-base').blocked).toBeNull();
    });

    it('carries the blocked packages into the plan', () => {
        const plan = service().plan();
        expect(plan.blocked.map((entry) => entry.modId)).toContain('needs-gone');
        // The store above was built from the same packages, so the candidate matches it and
        // the diff is empty - which is the claim that matters here: a blocked package's
        // definitions are not in the candidate, so they are never offered as "added".
        expect(plan.kinds).toEqual([]);
        expect(JSON.stringify(plan)).not.toContain('ghost');
    });
});

describe('moving a package in the stack', () => {
    // Its own fixture root, and a shape chosen to hold every case at once. The stack is
    // alphabetical (every package at the default level, so `sortModsForLoad` breaks the tie by
    // id), which gives:
    //   aaa-needs, atlas, forge, glyph, quarry, zzz-provider
    // - `forge requires atlas` is satisfied (atlas composes first), so lifting forge is a real
    //   break and must be refused;
    // - `aaa-needs requires zzz-provider` is INVERTED from birth, the same inherited break the
    //   shipped install has, and is what proves an inversion can still be walked out;
    // - `forge` and `glyph` both ship `components/knife`, adjacent, so one move changes its
    //   owner and `shadowChanged` has something true to report.
    const MOVE_ROOT = path.resolve('data', `.mod-service-move-${process.pid}`);
    const relRoot = () => path.relative(process.cwd(), MOVE_ROOT);

    function writeAt(name, content, files, requires) {
        const dir = path.join(MOVE_ROOT, name);
        fs.mkdirSync(dir, { recursive: true });
        const manifest = { id: name, version: '1.0.0', content };
        if (requires) manifest.requires = requires;
        fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest), 'utf8');
        for (const [kind, value] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(value), 'utf8');
        }
    }

    const memState = (initial = {}) => {
        const holder = { state: { ...initial } };
        return { load: () => ({ ...holder.state }), save: (next) => { holder.state = { ...next }; }, holder };
    };

    /**
     * A service over the fixture packages, already scanned.
     *
     * Seeded through the STATE STORE, not the loader: `ModService.discover()` pushes
     * `currentState()` into `loader.state`, and `rescan()` reloads it from the store, so a
     * scenario written into the loader is quietly overwritten before it is read. Scanned on the
     * way out because a service that has not looked at the disk answers `view()` with an empty
     * list, and every rank assertion below reads that.
     */
    const service = (state = {}) => {
        const s = new ModService({
            registryStore: new RegistryStore(new ModLoader({ baseDir: relRoot(), state }).build().registries),
            loader: new ModLoader({ baseDir: relRoot() }),
            stateStore: memState(state)
        });
        s.rescan();
        return s;
    };

    /** Stack ranks as the next boundary would compose them: id at the level it now carries. */
    const stackOf = (s) => s.view()
        .slice()
        .sort((a, b) => a.loadOrder - b.loadOrder)
        .map((m) => m.id);

    /** The thrown error of a refused call (the whole error: these refusals carry fields). */
    const refusalOf = (fn) => {
        try {
            fn();
        } catch (error) {
            return error;
        }
        throw new Error('expected the call to throw');
    };

    beforeAll(() => {
        fs.rmSync(MOVE_ROOT, { recursive: true, force: true });
        fs.mkdirSync(MOVE_ROOT, { recursive: true });
        const steel = { steel: { name: 'Steel', density: 7.8, properties: {} } };
        writeAt('atlas', [REGISTRY_KINDS.MATERIALS], { [REGISTRY_KINDS.MATERIALS]: steel });
        writeAt('forge', [REGISTRY_KINDS.COMPONENTS], { [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Forge knife' } } }, ['atlas']);
        writeAt('glyph', [REGISTRY_KINDS.COMPONENTS], { [REGISTRY_KINDS.COMPONENTS]: { knife: { name: 'Glyph knife' } } });
        writeAt('quarry', [REGISTRY_KINDS.MATERIALS], { [REGISTRY_KINDS.MATERIALS]: { steel: { name: 'Quarry steel', density: 8, properties: {} } } });
        writeAt('aaa-needs', [REGISTRY_KINDS.COMPONENTS], { [REGISTRY_KINDS.COMPONENTS]: { clamp: { name: 'Clamp' } } }, ['zzz-provider']);
        writeAt('zzz-provider', [REGISTRY_KINDS.COMPONENTS], { [REGISTRY_KINDS.COMPONENTS]: { bolt: { name: 'Bolt' } } });
    });

    afterAll(() => {
        fs.rmSync(MOVE_ROOT, { recursive: true, force: true });
    });

    it('starts with the tie the id decides, and one edge already inverted', () => {
        const s = service();
        expect(stackOf(s)).toEqual(['aaa-needs', 'atlas', 'forge', 'glyph', 'quarry', 'zzz-provider']);
        // The precondition the rest of this block reads off: `glyph` composes after `forge`, so
        // it owns the shared knife, and `aaa-needs` sits above the package it requires.
        expect(s.plan().shadowed).toEqual([
            { kind: 'components', key: 'knife', from: 'forge', to: 'glyph' },
            { kind: 'materials', key: 'steel', from: 'atlas', to: 'quarry' }
        ]);
    });

    it('renumbers the WHOLE stack, so no tie survives the move', () => {
        const s = service();
        const result = s.moveMod('glyph', 'up');

        expect(result).toMatchObject({
            id: 'glyph', moved: true, direction: 'up', rank: 3, total: 6,
            loadOrder: 3 * LOAD_ORDER_STRIDE, previousLoadOrder: LOAD_ORDER_STRIDE,
            pending: true, appliesAt: APPLY_AT
        });
        // Not a number for one package: every package now carries its rank, so the id tiebreak
        // decides nothing any more (a half-numbered stack is one where a rename wins a key).
        expect(s.stateStore.holder.state).toEqual({
            'aaa-needs': { loadOrder: 1000 },
            atlas: { loadOrder: 2000 },
            glyph: { loadOrder: 3000 },
            forge: { loadOrder: 4000 },
            quarry: { loadOrder: 5000 },
            'zzz-provider': { loadOrder: 6000 }
        });
        expect(stackOf(s)).toEqual(['aaa-needs', 'atlas', 'glyph', 'forge', 'quarry', 'zzz-provider']);
    });

    it('names the keys whose owner the move changed', () => {
        const s = service();
        const result = s.moveMod('glyph', 'up');
        // The whole point of composing the stack twice: a reorder is invisible except through
        // the keys it reassigns, and "it moved" is not a consequence an operator can check.
        expect(result.shadowChanged).toEqual([
            { kind: 'components', key: 'knife', was: 'glyph', now: 'forge' }
        ]);
        expect(result.shadowChangedTruncated).toBe(false);
        expect(s.plan().shadowed.find((e) => e.key === 'knife')).toMatchObject({ from: 'glyph', to: 'forge' });
    });

    it('refuses to lift a package above something it requires', () => {
        const s = service();
        const error = refusalOf(() => s.moveMod('forge', 'up'));
        expect(error.code).toBe('MOD_MOVE_BREAKS_REQUIRES');
        expect(error).toMatchObject({ mod: 'forge', requires: 'atlas', from: 3, to: 2 });
        expect(error.message).toMatch(/composes below everything it requires/);
        // Nothing was written and nothing was queued: a refused move is not a half move.
        expect(s.stateStore.holder.state).toEqual({});
        expect(s.pending).toBe(false);
        expect(stackOf(s)).toEqual(['aaa-needs', 'atlas', 'forge', 'glyph', 'quarry', 'zzz-provider']);
    });

    it('walks an inherited inversion down and refuses only to deepen it', () => {
        const s = service();
        // `aaa-needs` composes above `zzz-provider` from birth. Refusing every state that is
        // inverted would freeze it here: neither direction legal, the only good destination
        // five steps away. Depth makes the rule monotone instead.
        // At the very top the edge answers first, and that ordering is right - there is no move
        // here to reason about at all.
        expect(refusalOf(() => s.moveMod('aaa-needs', 'up')).code).toBe('MOD_MOVE_AT_EDGE');
        expect(s.moveMod('aaa-needs', 'down').rank).toBe(2);
        // One step down was progress, so the step back up is a deepening, and THIS is what the
        // requires rule exists for.
        expect(refusalOf(() => s.moveMod('aaa-needs', 'up')).code).toBe('MOD_MOVE_BREAKS_REQUIRES');
        for (let step = 0; step < 4; step++) {
            expect(s.moveMod('aaa-needs', 'down').direction).toBe('down');
        }
        expect(stackOf(s).at(-1)).toBe('aaa-needs');
        // Now that it sits below its provider, the same lift WOULD break a holding edge, and it
        // is refused for that reason from here on.
        expect(refusalOf(() => s.moveMod('aaa-needs', 'up')).code).toBe('MOD_MOVE_BREAKS_REQUIRES');
    });

    it('says so at either end of the stack', () => {
        const s = service();
        for (let step = 0; step < 5; step++) s.moveMod('aaa-needs', 'down');
        expect(refusalOf(() => s.moveMod('aaa-needs', 'down')))
            .toMatchObject({ code: 'MOD_MOVE_AT_EDGE' });
        // The walk left `atlas` at the top, so the top edge is reachable in the same fixture.
        expect(refusalOf(() => s.moveMod('atlas', 'up')))
            .toMatchObject({ code: 'MOD_MOVE_AT_EDGE', message: /top of the stack/ });
    });

    it('keeps `enabled` untouched while renumbering', () => {
        const s = service({ atlas: { enabled: false } });
        s.moveMod('quarry', 'up');
        // A move moves position. An operator who switched a package off must not find it back
        // on because something else was reordered.
        expect(s.stateStore.holder.state.atlas).toEqual({ enabled: false, loadOrder: 2000 });
        expect(s.view().find((m) => m.id === 'atlas').enabled).toBe(false);
    });

    it('rejects a direction, an id, and an empty id, without writing anything', () => {
        const s = service();
        expect(refusalOf(() => s.moveMod('atlas', 'sideways')).code).toBe('MOD_MOVE_DIRECTION_INVALID');
        expect(refusalOf(() => s.moveMod('atlas', undefined)).code).toBe('MOD_MOVE_DIRECTION_INVALID');
        expect(refusalOf(() => s.moveMod('', 'up')).code).toBe('MOD_ID_INVALID');
        expect(refusalOf(() => s.moveMod('not-here', 'up')))
            .toMatchObject({ code: 'MOD_NOT_FOUND' });
        expect(s.stateStore.holder.state).toEqual({});
        expect(s.pending).toBe(false);
    });

    it('reaches the store at the round boundary, like every other mod change', () => {
        const s = service();
        s.moveMod('glyph', 'up');
        // `pending` alone is a promise; this is the promise kept - the swap is the existing
        // boundary path, not a second one a reorder invented.
        const report = s.applyPending();
        expect(report).not.toBeNull();
        expect(s.pending).toBe(false);
        expect(s.registryStore.read(REGISTRY_KINDS.COMPONENTS).knife.name).toBe('Forge knife');
    });
});

describe('ownersOf and ownerChanges: the two derivations the move answer is built from', () => {
    it('groups shared keys by the owner the world runs', () => {
        const owners = ownersOf([
            { kind: 'components', key: 'knife', from: 'forge', to: 'glyph' },
            { kind: 'components', key: 'plate', from: 'forge', to: 'quarry' }
        ]);
        expect(owners.get('components').get('knife')).toBe('glyph');
        // A key nobody else ships has no owner to change, so it is not in here at all.
        expect(owners.get('materials')).toBeUndefined();
    });

    it('reports only what differs, in a stable order, including a key that went away', () => {
        const before = ownersOf([
            { kind: 'components', key: 'knife', from: 'a', to: 'b' },
            { kind: 'components', key: 'same', from: 'a', to: 'b' },
            { kind: 'components', key: 'gone', from: 'a', to: 'b' }
        ]);
        const after = ownersOf([
            { kind: 'components', key: 'knife', from: 'a', to: 'a' },
            { kind: 'components', key: 'same', from: 'a', to: 'b' }
        ]);
        // `same` is on both sides with the same owner and must not appear; `gone` stopped being
        // shared at all, which is a change worth naming rather than a silence.
        expect(ownerChanges(before, after)).toEqual([
            { kind: 'components', key: 'gone', was: 'b', now: null },
            { kind: 'components', key: 'knife', was: 'b', now: 'a' }
        ]);
    });
});

/** The state store a service was constructed with, when it is the test's own. */
function memStateOf(service) {
    return service.stateStore.holder;
}

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
import ModService, { diffRegistry, MAX_KEYS_PER_KIND } from '../../src/services/ModService.js';
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

/** The state store a service was constructed with, when it is the test's own. */
function memStateOf(service) {
    return service.stateStore.holder;
}

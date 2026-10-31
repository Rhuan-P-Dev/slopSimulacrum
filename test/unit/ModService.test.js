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

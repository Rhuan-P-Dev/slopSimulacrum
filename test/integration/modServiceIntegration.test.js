/**
 * INTEGRATION TEST — ModService against a real world.
 *
 * The unit layer (test/unit/ModService.test.js) drives the service over fixture
 * packages. Here the world is the real thing: `buildWorldState` (which now builds its
 * definition through the ModLoader, from the committed `core-*` packages) and the real
 * loader over `data/mods/`. What that buys, pinned:
 *
 *   - the shipped content IS the official set: `REGISTRY_KIND_LIST.length` official
 *     packages, none of the official ones rejected;
 *
 * The scope is the OFFICIAL set, not the install directory (same scoping as
 * `test/contract/officialMods.contract.test.js`, same reason, now written down in
 * `wiki/decisions/contract-test-scope.md`): `data/mods/` can hold a third-party package on
 * the machine running this, and that package is neither part of the shipped content nor a
 * defect in it. Order, by contrast, IS asserted over everything installed: a total order is
 * a property of the merge, whoever the participants are - and the order asserted is the
 * loader's (`loadOrder`, then id), NOT the alphabet. The two diverge as soon as a package
 * sits at a loadOrder that does not sort with its id, and substituting one for the other is
 * what made this file fail on a machine that merely had a mod installed.
 *   - every registry kind the world reads has a non-zero definition count live, so the
 *     service cannot report an empty world as a healthy one;
 *   - a plan against the world it was built from is empty — disk and world agree, and
 *     the diff is not inventing changes out of key order or metadata;
 *   - and the delta IS visible when the world moves: replace one kind in the store and
 *     the plan names exactly that removal, without the store changing again.
 *
 * @module test/integration/modServiceIntegration
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import ModService from '../../src/services/ModService.js';
import ModLoader, { OFFICIAL_ID_PREFIX, sortModsForLoad } from '../../src/services/ModLoader.js';
import { REGISTRY_KIND_LIST } from '../../shared/RegistryKinds.js';
import { GameError } from '../../src/utils/CustomErrors.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

/** A real world (tick system not started) and the mod view over its store. */
function worldWithModService() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick);
    return { world, service: new ModService({ registryStore: world.registryStore }) };
}

describe('the mod view of a real world', () => {
    it('sees the shipped content as the official package set', () => {
        const { service } = worldWithModService();
        const { mods, invalid } = service.rescan();
        const official = mods.filter((mod) => mod.official);

        expect(invalid.filter((entry) => String(entry.dir).startsWith(OFFICIAL_ID_PREFIX)),
            JSON.stringify(invalid)).toEqual([]);
        expect(official).toHaveLength(REGISTRY_KIND_LIST.length);
        expect(official.every((mod) => mod.id.startsWith(OFFICIAL_ID_PREFIX))).toBe(true);
        // Order is total and deterministic over EVERYTHING installed, overlays included:
        // the world's merge cannot depend on a readdir. What the loader guarantees is
        // `loadOrder` ascending with ties broken by id (`sortModsForLoad`) - NOT the
        // alphabet, and the two are different promises. They diverge as soon as a package
        // sits at a loadOrder that does not sort with its id, which is the ordinary case:
        // an overlay absent from `loadorder.json` takes `DEFAULT_LOAD_ORDER` (1000) and
        // ties with `core-actions`, so it loads SECOND, while a string sort buries it
        // last. Asserting the alphabet here failed on a machine that merely had a mod
        // installed (`wiki/decisions/contract-test-scope.md`, second finding).
        const loadOrder = sortModsForLoad(service.discover().discovered)
            .map((mod) => mod.manifest.id);
        expect(mods.map((mod) => mod.id)).toEqual(loadOrder);
        // The two orders are NOT the same promise, and that is pinned where it can be
        // pinned deterministically - with a fabricated package whose loadOrder makes them
        // disagree - in test/contract/officialPackageScope.contract.test.js. Asserting it
        // here would depend on what this particular machine happens to have installed.
    });

    it('reports a live definition count for every kind it reads', () => {
        const { service } = worldWithModService();
        const { live } = service.list();
        for (const kind of REGISTRY_KIND_LIST) {
            expect(live.definitionCounts[kind], `live definitions of ${kind}`).toBeGreaterThan(0);
        }
    });

    it('offers a vocabulary a manifest can be written against', () => {
        const { service } = worldWithModService();
        const kinds = service.kinds();
        expect(kinds).toHaveLength(REGISTRY_KIND_LIST.length);
        for (const kind of kinds) {
            expect(kind.file, `file of ${kind.kind}`).toMatch(/\.json$/);
            expect(kind.coreDir, `core dir of ${kind.kind}`).toMatch(/^core-/);
            expect(kind.liveCount, `live count of ${kind.kind}`).toBeGreaterThan(0);
        }
        // The name a mod author has to be told about, pinned so a rename moves it
        // loudly: the entity blueprints are the `npcs` kind, not an `entities` kind.
        expect(kinds.find((k) => k.kind === 'npcs'))
            .toMatchObject({ file: 'npcs.json', coreDir: 'core-npcs' });
    });

    it('plans no change against the world it was built from', () => {
        const { world, service } = worldWithModService();
        const plan = service.plan();
        expect(plan.applied).toBe(false);
        expect(plan.fromVersion).toBe(world.registryStore.version());
        expect(plan.kinds, JSON.stringify(plan.kinds.map((k) => k.kind))).toEqual([]);
        // Shadowing is not a pending change. An overlay installed on this machine
        // overwrites official keys at boot too, so the plan that agrees with the world
        // still lists those overwrites, and it must list the loader's report verbatim,
        // not a second opinion computed on the way to the endpoint.
        expect(plan.shadowed).toEqual(new ModLoader().build().shadowed);
        // The shipped content survives the composition rules the plan applies: if this
        // ever fires on an official definition, the classifier is wrong or the data is.
        expect(plan.quarantine, JSON.stringify(plan.quarantine)).toEqual([]);
    });

    it('names what the world has that the packages do not, without swapping anything', () => {
        const { world, service } = worldWithModService();
        // Simulate a world carrying a definition no package ships: an item granted at
        // runtime, or a mod that was removed after being applied.
        const items = world.registryStore.read('inventoryItems');
        items.looseScrew = { name: 'Loose Screw', form: { volume: 1 } };
        const before = world.registryStore.version();

        const plan = service.plan();
        const itemsPlan = plan.kinds.find((k) => k.kind === 'inventoryItems');
        expect(itemsPlan.removed).toEqual(['looseScrew']);
        expect(itemsPlan.added).toEqual([]);
        expect(world.registryStore.version(), 'a plan must not swap the world').toBe(before);
        expect(world.registryStore.read('inventoryItems').looseScrew).toBeDefined();
    });
});

/**
 * Fixture for the line tests: a temp install with four packages, three of which
 * contribute. `central-ball` is shared by all four (the disabled one is never
 * counted); `core-wheel` only alpha, `side-arm` only beta.
 * Stack order (loadOrder, then id): alpha-mod #1000, delta-mod #1000 (disabled),
 * beta-mod #1200, gamma-mod #1300.
 */
function lineWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick);
    const tmp = `${process.cwd()}/.tmp-mods-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });

    const state = {};
    const writePackage = (id, defsByKind, order = undefined, enabled = true) => {
        mkdirSync(`${tmp}/${id}`, { recursive: true });
        writeFileSync(
            `${tmp}/${id}/mod.json`,
            JSON.stringify({
                id: id,
                version: '1.0.0',
                content: Object.keys(defsByKind),
                requires: [],
                description: 'fixture for the mod line viewer tests'
            })
        );
        for (const kind of Object.keys(defsByKind)) {
            writeFileSync(`${tmp}/${id}/${kind}.json`, JSON.stringify(defsByKind[kind]));
        }
        if (!enabled || order !== undefined) {
            const entry = {};
            if (enabled === false) entry.enabled = false;
            if (order !== undefined) entry.loadOrder = order;
            state[id] = entry;
        }
    };

    writePackage('alpha-mod', {
        components: { 'central-ball': { volume: 1 }, 'core-wheel': { volume: 2 } }
    });
    writePackage('beta-mod', {
        components: { 'central-ball': { volume: 9 }, 'side-arm': { volume: 3 } }
    }, 1200);
    writePackage('gamma-mod', { components: { 'central-ball': { volume: 99 } } }, 1300);
    writePackage('delta-mod', { components: { 'central-ball': { volume: 5 } } }, undefined, false);

    return {
        service: new ModService({
            registryStore: world.registryStore,
            loader: new ModLoader({ baseDir: tmp }),
            stateStore: { load: () => ({ ...state }), save: () => {} }
        }),
        dir: tmp
    };
}

describe('the mod line for a package', () => {
    it('reports, for a package, who shadows it, whom it does not, and which copy wins', () => {
        const { service, dir } = lineWorld();
        try {
            const lines = service.linesForMod('alpha-mod');
            expect(lines).toMatchObject({
                id: 'alpha-mod',
                enabled: true,
                loadOrder: 1000,
                blocked: null,
                contributes: true
            });
            expect(Object.keys(lines.lines)).toEqual(['components']);
            const central = lines.lines.components.find((row) => row.key === 'central-ball');
            expect(central).toEqual({
                key: 'central-ball',
                overriddenBy: [
                    { modId: 'beta-mod', loadOrder: 1200 },
                    { modId: 'gamma-mod', loadOrder: 1300 }
                ],
                overrides: [],
                winner: { modId: 'gamma-mod', loadOrder: 1300 }
            });
            const wheel = lines.lines.components.find((row) => row.key === 'core-wheel');
            expect(wheel).toEqual({
                key: 'core-wheel',
                overriddenBy: [],
                overrides: [],
                winner: { modId: 'alpha-mod', loadOrder: 1000 }
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports the shadowing direction both ways, and the self-winner', () => {
        const { service, dir } = lineWorld();
        try {
            const beta = service.linesForMod('beta-mod');
            expect(
                beta.lines.components.find((row) => row.key === 'central-ball')
            ).toEqual({
                key: 'central-ball',
                overriddenBy: [{ modId: 'gamma-mod', loadOrder: 1300 }],
                overrides: [{ modId: 'alpha-mod', loadOrder: 1000 }],
                winner: { modId: 'gamma-mod', loadOrder: 1300 }
            });
            expect(
                beta.lines.components.find((row) => row.key === 'side-arm')
            ).toEqual({
                key: 'side-arm',
                overriddenBy: [],
                overrides: [],
                winner: { modId: 'beta-mod', loadOrder: 1200 }
            });

            const gamma = service.linesForMod('gamma-mod');
            expect(
                gamma.lines.components.find((row) => row.key === 'central-ball')
            ).toEqual({
                key: 'central-ball',
                overriddenBy: [],
                overrides: [
                    { modId: 'alpha-mod', loadOrder: 1000 },
                    { modId: 'beta-mod', loadOrder: 1200 }
                ],
                winner: { modId: 'gamma-mod', loadOrder: 1300 }
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not count a disabled package as contributing, but still shows its lines as shadowed', () => {
        const { service, dir } = lineWorld();
        try {
            const delta = service.linesForMod('delta-mod');
            expect(delta).toMatchObject({ id: 'delta-mod', enabled: false, contributes: false });
            expect(
                delta.lines.components.find((row) => row.key === 'central-ball')
            ).toEqual({
                key: 'central-ball',
                overriddenBy: [
                    { modId: 'beta-mod', loadOrder: 1200 },
                    { modId: 'gamma-mod', loadOrder: 1300 }
                ],
                overrides: [{ modId: 'alpha-mod', loadOrder: 1000 }],
                winner: { modId: 'gamma-mod', loadOrder: 1300 }
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('throws MOD_NOT_FOUND for a package that is not installed', () => {
        const { service, dir } = lineWorld();
        try {
            let thrown = null;
            try {
                service.linesForMod('not-installed');
            } catch (error) {
                thrown = error;
            }
            expect(thrown, 'an uninstalled package must be refused, not answered').toBeInstanceOf(GameError);
            expect(thrown.code).toBe('MOD_NOT_FOUND');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

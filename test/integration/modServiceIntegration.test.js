/**
 * INTEGRATION TEST — ModService against a real world.
 *
 * The unit layer (test/unit/ModService.test.js) drives the service over fixture
 * packages. Here the world is the real thing: `buildWorldState` (which now builds its
 * definition through the ModLoader, from the committed `core-*` packages) and the real
 * loader over `data/mods/`. What that buys, pinned:
 *
 *   - the installed set IS the official set: 21 packages, every one official, none
 *     rejected;
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
import { REGISTRY_KIND_LIST } from '../../shared/RegistryKinds.js';

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

        expect(invalid, JSON.stringify(invalid)).toEqual([]);
        expect(mods).toHaveLength(REGISTRY_KIND_LIST.length);
        expect(mods.every((mod) => mod.official)).toBe(true);
        // Order is total and deterministic (loadOrder, then id): the world's merge
        // cannot depend on a readdir.
        expect(mods.map((mod) => mod.id)).toEqual([...mods.map((mod) => mod.id)].sort());
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
        expect(plan.shadowed).toEqual([]);
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

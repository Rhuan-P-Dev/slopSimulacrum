/**
 * RegistryStore unit tests.
 *
 * The contract being pinned is the one the mod system stands on: a reader that
 * captured `store.read(KIND)` at construction time sees a swap, because the
 * holder identity never changes and `replace()` writes into it in one step.
 * Everything else here is the boundary behaviour (`T-1`/`T-2`): unknown kinds
 * and non-object content fail loudly, absent or null content means "empty part
 * of the world", and a rejected candidate leaves the world untouched.
 */

import RegistryStore from '../../src/services/RegistryStore.js';
import {
    REGISTRY_KINDS,
    REGISTRY_KIND_LIST,
    REGISTRY_KIND_COUNT,
    isRegistryKind
} from '../../shared/RegistryKinds.js';
import buildWorldState from '../../src/composition/WorldComposition.js';
import SensitivePartConsequenceHandler from '../../src/controllers/consequences/SensitivePartConsequenceHandler.js';
import { describe, it, expect } from 'vitest';

describe('RegistryStore construction', () => {
    it('every registry kind exists and starts empty when no content is given', () => {
        const store = new RegistryStore();

        expect(REGISTRY_KIND_LIST).toHaveLength(REGISTRY_KIND_COUNT);
        for (const kind of REGISTRY_KIND_LIST) {
            expect(store.read(kind)).toEqual({});
        }
    });

    it('holds the content handed over for each kind', () => {
        const store = new RegistryStore({
            [REGISTRY_KINDS.MATERIALS]: { wood: { density: 1 } }
        });

        expect(store.read(REGISTRY_KINDS.MATERIALS)).toEqual({ wood: { density: 1 } });
    });

    it('an absent content is an empty part of the world, not a crash', () => {
        const store = new RegistryStore({ [REGISTRY_KINDS.NPCS]: null });

        expect(store.read(REGISTRY_KINDS.NPCS)).toEqual({});
        expect(store.has(REGISTRY_KINDS.NPCS)).toBe(false);
    });

    it('rejects content that is not a plain object, naming the kind', () => {
        expect(() => new RegistryStore({ [REGISTRY_KINDS.ROOMS]: ['aRoom'] }))
            .toThrow(/content for kind "rooms" must be a plain object/);
        expect(() => new RegistryStore({ [REGISTRY_KINDS.ROOMS]: 'aRoom' }))
            .toThrow(/REGISTRY_CONTENT_INVALID|plain object/);
    });

    it('rejects an unknown kind rather than silently holding it', () => {
        expect(() => new RegistryStore({ potions: { vial: {} } })).toThrow(/unknown registry kind "potions"/);
    });
});

describe('RegistryStore.read', () => {
    it('fails with REGISTRY_KIND_UNKNOWN for a kind nobody can read', () => {
        const store = new RegistryStore();

        try {
            store.read('potions');
            expect.unreachable('read() should have thrown');
        } catch (error) {
            expect(error.code).toBe('REGISTRY_KIND_UNKNOWN');
            expect(error.message).toContain('potions');
        }
    });

    it('returns the same holder object on every read', () => {
        const store = new RegistryStore();

        expect(store.read(REGISTRY_KINDS.ACTIONS)).toBe(store.read(REGISTRY_KINDS.ACTIONS));
    });
});

describe('RegistryStore.replace', () => {
    it('a reader that captured the holder sees the swapped content', () => {
        const store = new RegistryStore({ [REGISTRY_KINDS.ACTIONS]: { move: {} } });
        const capturedByAController = store.read(REGISTRY_KINDS.ACTIONS);

        store.replace({ [REGISTRY_KINDS.ACTIONS]: { fly: {} } });

        expect(capturedByAController).toBe(store.read(REGISTRY_KINDS.ACTIONS));
        expect(Object.keys(capturedByAController)).toEqual(['fly']);
        expect(capturedByAController.move).toBeUndefined();
    });

    it('one accepted swap is one version, and it names the kinds it wrote', () => {
        const store = new RegistryStore({ [REGISTRY_KINDS.TRAITS]: { flags: {} } });
        const before = store.version();

        const swapped = store.replace({ [REGISTRY_KINDS.TRAITS]: { conditions: {} } });
        expect(swapped.swappedKinds).toEqual(['traits']);
        expect(swapped.version).toBe(before + 1);

        // An empty candidate swaps nothing and does not move the counter.
        const nothing = store.replace({});
        expect(nothing.swappedKinds).toEqual([]);
        expect(nothing.version).toBe(before + 1);
    });

    it('leaves every registry untouched when the candidate is invalid', () => {
        const store = new RegistryStore({
            [REGISTRY_KINDS.MATERIALS]: { wood: {} },
            [REGISTRY_KINDS.ACTIONS]: { move: {} }
        });
        const versionBefore = store.version();

        // The first kind is fine, the second is not: nothing may be written.
        expect(() => store.replace({
            [REGISTRY_KINDS.MATERIALS]: { unobtainium: {} },
            [REGISTRY_KINDS.ACTIONS]: ['move']
        })).toThrow(/plain object/);

        expect(store.read(REGISTRY_KINDS.MATERIALS)).toEqual({ wood: {} });
        expect(store.read(REGISTRY_KINDS.ACTIONS)).toEqual({ move: {} });
        expect(store.version()).toBe(versionBefore);
    });

    it('leaves every registry untouched when the candidate carries an unknown kind', () => {
        const store = new RegistryStore({ [REGISTRY_KINDS.MATERIALS]: { wood: {} } });

        expect(() => store.replace({ potions: { vial: {} } })).toThrow(/unknown registry kind "potions"/);
        expect(store.read(REGISTRY_KINDS.MATERIALS)).toEqual({ wood: {} });
        expect(store.version()).toBe(1);
    });

    it('a kind absent from the candidate keeps its content', () => {
        const store = new RegistryStore({
            [REGISTRY_KINDS.MATERIALS]: { wood: {} },
            [REGISTRY_KINDS.ACTIONS]: { move: {} }
        });

        store.replace({ [REGISTRY_KINDS.ACTIONS]: { dash: {} } });

        expect(store.read(REGISTRY_KINDS.MATERIALS)).toEqual({ wood: {} });
    });

    it('null content empties a registry, which is what disabling looks like', () => {
        const store = new RegistryStore({ [REGISTRY_KINDS.NPCS]: { killerLlmDrone: {} } });
        const holder = store.read(REGISTRY_KINDS.NPCS);

        store.replace({ [REGISTRY_KINDS.NPCS]: null });

        expect(holder).toEqual({});
        expect(store.read(REGISTRY_KINDS.NPCS)).toBe(holder);
    });

    it('rejects a candidate that is not an object at all', () => {
        const store = new RegistryStore();

        expect(() => store.replace(['components'])).toThrow(/must be a plain object/);
    });
});

describe('RegistryStore.definitionCounts', () => {
    it('counts definitions per kind across the whole vocabulary', () => {
        const store = new RegistryStore({
            [REGISTRY_KINDS.COMPONENTS]: { knife: {}, torch: {} },
            [REGISTRY_KINDS.ACTIONS]: { move: {} }
        });

        const counts = store.definitionCounts();

        expect(Object.keys(counts)).toHaveLength(REGISTRY_KIND_COUNT);
        expect(counts[REGISTRY_KINDS.COMPONENTS]).toBe(2);
        expect(counts[REGISTRY_KINDS.ACTIONS]).toBe(1);
        expect(counts[REGISTRY_KINDS.ROOMS]).toBe(0);
    });
});

describe('shared RegistryKinds vocabulary', () => {
    it('accepts a known kind and rejects everything else', () => {
        expect(isRegistryKind(REGISTRY_KINDS.WORLD_RULES)).toBe(true);
        expect(isRegistryKind('potions')).toBe(false);
        expect(isRegistryKind(undefined)).toBe(false);
        expect(isRegistryKind(7)).toBe(false);
    });

    it('the kind vocabulary is frozen against runtime edits', () => {
        expect(Object.isFrozen(REGISTRY_KINDS)).toBe(true);
        expect(Object.isFrozen(REGISTRY_KIND_LIST)).toBe(true);
    });
});

describe('a swap reaches the readers (the reason the store exists)', () => {
    it('keeps the facade on the same holder, and a swap lands there', () => {
        const { worldStateController, registryStore } = buildWorldState();
        const liveItems = registryStore.read(REGISTRY_KINDS.INVENTORY_ITEMS);

        // The facade does not keep its own parse: it reads the store's holder.
        expect(worldStateController.getRegistry(REGISTRY_KINDS.COMPONENTS))
            .toBe(registryStore.read(REGISTRY_KINDS.COMPONENTS));

        const before = registryStore.version();
        registryStore.replace({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: { ...liveItems, probe_torch: { name: 'Torch', volume: 2 } }
        });

        expect(registryStore.version()).toBe(before + 1);
        // Call-time readers see the new world...
        expect(worldStateController.getRegistry(REGISTRY_KINDS.INVENTORY_ITEMS).probe_torch?.name)
            .toBe('Torch');
        // ...and so does a controller that captured its registry at construction,
        // because the holder identity never changed (no re-injection, no restart).
        expect(worldStateController.getItemRegistry().probe_torch).toBeDefined();
    });

    it('empties a registry when the mod providing it is disabled', () => {
        const { worldStateController, registryStore } = buildWorldState();
        // Disabling a mod means its kind has no content: the world loses those
        // definitions, it does not fall back to the file on disk
        // (wiki/decisions/mod-system.md, decision 6).
        registryStore.replace({ [REGISTRY_KINDS.SENSITIVE_PARTS]: {} });
        expect(worldStateController.getRegistry(REGISTRY_KINDS.SENSITIVE_PARTS)).toEqual({});
    });

    it('re-derives a cached view when the definition changes', () => {
        const { worldStateController, registryStore } = buildWorldState();
        const handler = new SensitivePartConsequenceHandler({ worldStateController });
        const known = Object.keys(registryStore.read(REGISTRY_KINDS.SENSITIVE_PARTS))
            .filter((k) => k !== '_comment')[0];

        expect(handler._sensitivityTable()[known]).toBe(
            registryStore.read(REGISTRY_KINDS.SENSITIVE_PARTS)[known]
        );

        registryStore.replace({
            [REGISTRY_KINDS.SENSITIVE_PARTS]: { ...registryStore.read(REGISTRY_KINDS.SENSITIVE_PARTS), [known]: 99 }
        });
        // The cache is keyed on the store version, so the retuned value is live.
        expect(handler._sensitivityTable()[known]).toBe(99);
    });
});

/**
 * Unit tests for the pure logic extracted from public/js/CraftingPanel.js
 * (crafting design spec §2.5/§4.7, architect decision 6):
 * pending-pool add/dedupe/remove/clear/prune, live-item flattening
 * (getLiveItemIds), strip-component resolution (resolveCraftingComponent),
 * pooled-set keys (pooledIdsKey), HTML escaping (escapeHtml), and
 * per-recipe requirement satisfaction computation.
 *
 * Per the client-testing convention (pattern: test/unit/RoomChatController.client.test.js),
 * these tests exercise ONLY the extracted pure functions — no raw DOM is
 * tested; the panel class (DOM/event wiring) stays out of scope here.
 *
 * Standing rule: every server-fetched map is defensive — guard group
 * values with Array.isArray before iteration.
 *
 * The pool's invariants are owned by the two pure pruners (liveness:
 * prunePool; component membership: prunePoolToComponent); any future pool
 * feature must extend them, not mutate the pool ad-hoc.
 */
import { describe, it, expect } from 'vitest';
import {
    addToPendingPool,
    removeFromPendingPool,
    clearPendingPool,
    getPoolItemIds,
    getLiveItemIds,
    resolveCraftingComponent,
    prunePool,
    prunePoolToComponent,
    pooledIdsKey,
    escapeHtml,
    computeRecipeSatisfaction,
    selectCraftItemIds
} from '../../public/js/CraftingPanel.js';

// ---- Fixtures ----------------------------------------------------------------

const KNIFE_TO_T1 = {
    id: 'knife_to_t1',
    name: 'T1 Assembly',
    description: 'Fuse two knives into one T1 container weapon.',
    inputs: [{ type: 'knife', quantity: 2 }],
    outputs: [{ type: 't1', quantity: 1 }]
};

const DUAL_RECIPE = {
    id: 'dual',
    name: 'Dual',
    description: '',
    inputs: [
        { type: 'a', quantity: 1 },
        { type: 'b', quantity: 2 }
    ],
    outputs: [{ type: 'c', quantity: 1 }]
};

const DUP_TYPE_RECIPE = {
    id: 'dup',
    name: 'Dup',
    description: '',
    inputs: [
        { type: 'a', quantity: 1 },
        { type: 'a', quantity: 1 }
    ],
    outputs: [{ type: 'c', quantity: 1 }]
};

describe('addToPendingPool', () => {
    it('adds an item to the target recipe/type and returns a new object', () => {
        const pool = {};
        const next = addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-1');

        expect(next).not.toBe(pool);
        expect(next).toEqual({ knife_to_t1: { knife: ['item-1'] } });
    });

    it('does not mutate the original pool (immutability)', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        const next = addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-2');

        expect(pool).toEqual({ knife_to_t1: { knife: ['item-1'] } });
        expect(next).toEqual({ knife_to_t1: { knife: ['item-1', 'item-2'] } });
    });

    it('dedupes by item ID: adding the same item twice is a no-op (same reference)', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        const next = addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-1');

        expect(next).toBe(pool);
    });

    it('dedupes by item ID across recipes: an item pooled in one recipe cannot be re-dropped into another', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        const next = addToPendingPool(pool, 'other_recipe', 'knife', 'item-1');

        expect(next).toBe(pool);
        expect(next).toEqual({ knife_to_t1: { knife: ['item-1'] } });
    });

    it('keeps existing entries when adding to a recipe that already has other types', () => {
        const pool = { dual: { a: ['item-1'] } };
        const next = addToPendingPool(pool, 'dual', 'b', 'item-2');

        expect(next).toEqual({ dual: { a: ['item-1'], b: ['item-2'] } });
    });

    it('is a no-op (same reference) for empty/invalid arguments', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };

        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', '')).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', null)).toBe(pool);
        expect(addToPendingPool(pool, '', 'knife', 'item-2')).toBe(pool);
        expect(addToPendingPool(pool, null, 'knife', 'item-2')).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', '', 'item-2')).toBe(pool);
    });
});

describe('removeFromPendingPool', () => {
    it('removes the recipe entry and preserves other recipes', () => {
        const pool = {
            knife_to_t1: { knife: ['item-1', 'item-2'] },
            other: { a: ['item-3'] }
        };
        const next = removeFromPendingPool(pool, 'knife_to_t1');

        expect(next).toEqual({ other: { a: ['item-3'] } });
        expect(next).not.toBe(pool);
    });

    it('is a no-op (same reference) when the recipe has no entries', () => {
        const pool = { other: { a: ['item-3'] } };
        expect(removeFromPendingPool(pool, 'knife_to_t1')).toBe(pool);
    });

    it('is a no-op (same reference) for an empty recipeId', () => {
        const pool = { other: { a: ['item-3'] } };
        expect(removeFromPendingPool(pool, '')).toBe(pool);
    });
});

describe('clearPendingPool', () => {
    it('returns a fresh empty pool', () => {
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2'] } };
        expect(clearPendingPool(pool)).toEqual({});
        expect(clearPendingPool(pool)).not.toBe(pool);
    });
});

describe('getPoolItemIds', () => {
    it('flattens all item IDs in insertion order', () => {
        const pool = {
            knife_to_t1: { knife: ['item-1', 'item-2'] },
            dual: { a: ['item-3'], b: ['item-4'] }
        };
        expect(getPoolItemIds(pool)).toEqual(['item-1', 'item-2', 'item-3', 'item-4']);
    });

    it('returns [] for an empty pool', () => {
        expect(getPoolItemIds({})).toEqual([]);
        expect(getPoolItemIds(undefined)).toEqual([]);
    });
});

describe('prunePool', () => {
    it('drops pooled items that are no longer live and keeps the rest', () => {
        const pool = {
            knife_to_t1: { knife: ['item-1', 'item-2'] },
            dual: { a: ['item-3'] }
        };
        const next = prunePool(pool, new Set(['item-1', 'item-3']));

        expect(next).toEqual({
            knife_to_t1: { knife: ['item-1'] },
            dual: { a: ['item-3'] }
        });
        expect(next).not.toBe(pool);
    });

    it('removes types/recipes that become empty after pruning', () => {
        const pool = {
            knife_to_t1: { knife: ['item-1'] },
            dual: { a: ['item-2'] }
        };
        const next = prunePool(pool, new Set(['item-2']));

        expect(next).toEqual({ dual: { a: ['item-2'] } });
    });

    it('returns the same reference when nothing changed', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        expect(prunePool(pool, new Set(['item-1']))).toBe(pool);
    });

    it('treats an empty live set as "everything stale"', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        expect(prunePool(pool, new Set())).toEqual({});
    });
});

describe('getLiveItemIds', () => {
    it('flattens the server items map ({componentId: [item, ...]}) into live item IDs', () => {
        // The exact regression input: group keys can be host component IDs,
        // container item IDs (nested items), or '__unassigned__'.
        const itemsByComponent = {
            'comp-a': [{ id: 'item-1' }, { id: 'item-2' }],
            'item-container': [{ id: 'item-3' }],
            '__unassigned__': [{ id: 'item-4' }]
        };
        expect(getLiveItemIds(itemsByComponent)).toEqual(['item-1', 'item-2', 'item-3', 'item-4']);
    });

    it('returns [] for an empty map', () => {
        expect(getLiveItemIds({})).toEqual([]);
    });

    it('returns [] for null/undefined', () => {
        expect(getLiveItemIds(undefined)).toEqual([]);
        expect(getLiveItemIds(null)).toEqual([]);
    });

    it('skips non-array group values (defensive against malformed shapes)', () => {
        const itemsByComponent = {
            'comp-a': [{ id: 'item-1' }],
            broken: { id: 'item-should-not-appear' },
            'comp-b': 'not-an-array'
        };
        expect(getLiveItemIds(itemsByComponent)).toEqual(['item-1']);
    });

    it('skips entries without a string id', () => {
        const itemsByComponent = {
            'comp-a': [null, {}, { id: 42 }, { id: 'item-1' }]
        };
        expect(getLiveItemIds(itemsByComponent)).toEqual(['item-1']);
    });
});

describe('prunePool × getLiveItemIds composition', () => {
    it('keeps pooled items present in the items map and drops the absent ones', () => {
        // item-2 was consumed elsewhere; the map no longer lists it.
        const items = {
            'comp-a': [{ id: 'item-1', type: 'knife' }]
        };
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2'] } };

        const next = prunePool(pool, getLiveItemIds(items));
        expect(next).toEqual({ knife_to_t1: { knife: ['item-1'] } });
        expect(next).not.toBe(pool);
    });

    it('survives nested (container-grouped) items and __unassigned__ groups', () => {
        const items = {
            'comp-a': [{ id: 'item-1', type: 'knife' }],
            'item-container': [{ id: 'item-2', type: 'knife' }],
            '__unassigned__': [{ id: 'item-3', type: 'knife' }]
        };
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2', 'item-3'] } };

        expect(prunePool(pool, getLiveItemIds(items))).toBe(pool);
    });

    it('returns the same pool reference when nothing changed', () => {
        const items = { 'comp-a': [{ id: 'item-1' }] };
        const pool = { knife_to_t1: { knife: ['item-1'] } };

        expect(prunePool(pool, getLiveItemIds(items))).toBe(pool);
    });
});

describe('resolveCraftingComponent', () => {
    it('branch 1: the selected component wins even when another component holds a recipe-input type earlier', () => {
        const result = resolveCraftingComponent({
            selectedId: 'comp-b',
            entityComponentIds: ['comp-a', 'comp-b'],
            itemsByComponent: { 'comp-a': [{ id: 'i1', type: 'knife' }] },
            recipeInputTypes: ['knife']
        });
        expect(result).toBe('comp-b');
    });

    it('M4 regression: never returns an items-map group key (container item ID)', () => {
        // The items map groups a nested item under a CONTAINER ITEM ID that
        // is not an entity component; only comp-head/comp-arm are. The
        // container group sorts first in object order — it must not win.
        const itemsByComponent = {
            'item-container': [{ id: 'x', type: 'knife' }],
            'comp-arm': [{ id: 'y', type: 't1' }],
            'comp-head': [{ id: 'z', type: 'knife' }]
        };
        const result = resolveCraftingComponent({
            selectedId: null,
            entityComponentIds: ['comp-head', 'comp-arm'],
            itemsByComponent,
            recipeInputTypes: ['knife']
        });
        expect(result).toBe('comp-head');
    });

    it('never returns the __unassigned__ group (falls through to branch 4)', () => {
        const result = resolveCraftingComponent({
            selectedId: null,
            entityComponentIds: ['comp-a'],
            itemsByComponent: { '__unassigned__': [{ id: 'x', type: 'knife' }] },
            recipeInputTypes: ['knife']
        });
        expect(result).toBe('comp-a');
    });

    it('dead-end config: a selected container-item ID falls through to a real component', () => {
        const itemsByComponent = {
            'item-container': [{ id: 'x', type: 'knife' }],
            'comp-head': [{ id: 'z', type: 'knife' }]
        };
        const result = resolveCraftingComponent({
            selectedId: 'item-container',
            entityComponentIds: ['comp-head', 'comp-arm'],
            itemsByComponent,
            recipeInputTypes: ['knife']
        });
        expect(result).toBe('comp-head');
    });

    it('no items anywhere → the first entity component', () => {
        const result = resolveCraftingComponent({
            selectedId: null,
            entityComponentIds: ['comp-head', 'comp-arm'],
            itemsByComponent: {},
            recipeInputTypes: ['knife']
        });
        expect(result).toBe('comp-head');
    });

    it('empty entityComponentIds → null (even with a selected/related group)', () => {
        const result = resolveCraftingComponent({
            selectedId: 'comp-x',
            entityComponentIds: [],
            itemsByComponent: { 'comp-x': [{ id: 'i', type: 'knife' }] },
            recipeInputTypes: ['knife']
        });
        expect(result).toBeNull();
    });
});

describe('prunePoolToComponent', () => {
    const items = {
        'comp-a': [{ id: 'item-1', type: 'knife' }],
        'comp-b': [{ id: 'item-2', type: 'knife' }]
    };

    it('drops entries not hosted on the given component (new reference)', () => {
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2'] } };
        const next = prunePoolToComponent(pool, items, 'comp-a');

        expect(next).toEqual({ knife_to_t1: { knife: ['item-1'] } });
        expect(next).not.toBe(pool);
    });

    it('removes types and recipes that become empty', () => {
        const pool = {
            knife_to_t1: { knife: ['item-2'] },
            other: { b: ['item-2'] }
        };
        expect(prunePoolToComponent(pool, items, 'comp-a')).toEqual({});
    });

    it('drops a pooled ID that is no longer in the items map at all', () => {
        const pool = { knife_to_t1: { knife: ['item-1', 'item-gone'] } };
        expect(prunePoolToComponent(pool, items, 'comp-a'))
            .toEqual({ knife_to_t1: { knife: ['item-1'] } });
    });

    it('returns the same reference when nothing changed', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        expect(prunePoolToComponent(pool, items, 'comp-a')).toBe(pool);
    });

    it('clears everything when the component is null', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        expect(prunePoolToComponent(pool, items, null)).toEqual({});
    });

    it('H3 scenario: cross-component pooled knives collapse to the strip component before the POST', () => {
        const itemsMap = {
            droidHead: [{ id: 'kA', type: 'knife' }],
            droidArm: [{ id: 'kB', type: 'knife' }]
        };
        const pool = { knife_to_t1: { knife: ['kA', 'kB'] } };

        const next = prunePoolToComponent(pool, itemsMap, 'droidArm');
        expect(next).toEqual({ knife_to_t1: { knife: ['kB'] } });

        // 1-of-2 → unsatisfied → no auto-craft → the 400 loop is
        // structurally impossible (selectCraftItemIds returns null, the
        // signal that a craft must never fire).
        expect(selectCraftItemIds(KNIFE_TO_T1, next)).toBeNull();
        expect(computeRecipeSatisfaction(KNIFE_TO_T1, next).satisfied).toBe(false);
    });
});

describe('pooledIdsKey', () => {
    it('same pooled set → same key (order-insensitive)', () => {
        const poolA = { knife_to_t1: { knife: ['item-1', 'item-2'] } };
        const poolB = { knife_to_t1: { knife: ['item-2', 'item-1'] } };

        expect(pooledIdsKey(KNIFE_TO_T1, poolA)).toBe(pooledIdsKey(KNIFE_TO_T1, poolB));
    });

    it('different set → different key', () => {
        const poolA = { knife_to_t1: { knife: ['item-1'] } };
        const poolB = { knife_to_t1: { knife: ['item-1', 'item-2'] } };

        expect(pooledIdsKey(KNIFE_TO_T1, poolA)).not.toBe(pooledIdsKey(KNIFE_TO_T1, poolB));
    });

    it('empty pool → stable empty key', () => {
        expect(pooledIdsKey(KNIFE_TO_T1, {})).toBe('');
        expect(pooledIdsKey(KNIFE_TO_T1, undefined)).toBe('');
        expect(pooledIdsKey(KNIFE_TO_T1, { other: { a: ['item-1'] } })).toBe('');
    });

    it("spans all of the recipe's types", () => {
        const pool = { dual: { a: ['item-1'], b: ['item-2', 'item-3'] } };

        expect(pooledIdsKey(DUAL_RECIPE, pool)).toBe('item-1\u0000item-2\u0000item-3');
    });
});

describe('escapeHtml', () => {
    it('escapes the five HTML metacharacters', () => {
        // The expected string is written with \u0026 escapes (repo
        // pattern): the tooling HTML-decodes raw entities on write, but
        // \u0026 === '&' at runtime, so the assertion checks the exact
        // entity form.
        expect(escapeHtml('a"b<c>&d\'e')).toBe('a\u0026quot;b\u0026lt;c\u0026gt;\u0026amp;d\u0026#39;e');
    });

    it('coerces non-string values via String()', () => {
        expect(escapeHtml(42)).toBe('42');
    });

    it('null → "null"', () => {
        expect(escapeHtml(null)).toBe('null');
    });
});

describe('computeRecipeSatisfaction', () => {
    it('empty pool: knife recipe is unsatisfied with the knife entry missing', () => {
        const { satisfied, entries, missing } = computeRecipeSatisfaction(KNIFE_TO_T1, {});

        expect(satisfied).toBe(false);
        expect(entries).toEqual([{ type: 'knife', have: 0, need: 2, isMet: false }]);
        expect(missing).toHaveLength(1);
        expect(missing[0].type).toBe('knife');
    });

    it('partially filled pool: not satisfied, correct have/need counts', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        const { satisfied, entries, missing } = computeRecipeSatisfaction(KNIFE_TO_T1, pool);

        expect(satisfied).toBe(false);
        expect(entries[0]).toEqual({ type: 'knife', have: 1, need: 2, isMet: false });
        expect(missing).toEqual(entries);
    });

    it('exact fill: satisfied, no missing entries', () => {
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2'] } };
        const { satisfied, missing } = computeRecipeSatisfaction(KNIFE_TO_T1, pool);

        expect(satisfied).toBe(true);
        expect(missing).toEqual([]);
    });

    it('overfilled pool still counts as satisfied (have may exceed need)', () => {
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2', 'item-3'] } };
        const { satisfied, entries } = computeRecipeSatisfaction(KNIFE_TO_T1, pool);

        expect(satisfied).toBe(true);
        expect(entries[0].have).toBe(3);
        expect(entries[0].isMet).toBe(true);
    });

    it('a recipe with multiple input types requires ALL of them', () => {
        // Only 'a' present — 'b' still missing
        const pool1 = { dual: { a: ['item-1'] } };
        expect(computeRecipeSatisfaction(DUAL_RECIPE, pool1).satisfied).toBe(false);

        // Both present at quantity
        const pool2 = { dual: { a: ['item-1'], b: ['item-2', 'item-3'] } };
        const result = computeRecipeSatisfaction(DUAL_RECIPE, pool2);
        expect(result.satisfied).toBe(true);
        expect(result.missing).toEqual([]);
    });

    it('ignores item types that are not recipe inputs (they never count)', () => {
        const pool = { knife_to_t1: { t1: ['item-1'] } };
        const { satisfied, entries } = computeRecipeSatisfaction(KNIFE_TO_T1, pool);

        expect(satisfied).toBe(false);
        expect(entries[0].have).toBe(0);
    });

    it('treats a malformed/absent recipe as never satisfied (never auto-crafts)', () => {
        expect(computeRecipeSatisfaction(null, {}).satisfied).toBe(false);
        expect(computeRecipeSatisfaction(undefined, {}).satisfied).toBe(false);
        expect(computeRecipeSatisfaction({ id: 'x', inputs: [] }, {}).satisfied).toBe(false);
    });
});

describe('selectCraftItemIds', () => {
    it('returns the pooled item IDs in drop order for a satisfied recipe', () => {
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2'] } };
        expect(selectCraftItemIds(KNIFE_TO_T1, pool)).toEqual(['item-1', 'item-2']);
    });

    it('takes exactly the required amount when the pool has extras (first-in-drop-order)', () => {
        const pool = { knife_to_t1: { knife: ['item-1', 'item-2', 'item-3', 'item-4'] } };
        expect(selectCraftItemIds(KNIFE_TO_T1, pool)).toEqual(['item-1', 'item-2']);
    });

    it('returns null when the pool cannot satisfy the recipe', () => {
        const pool = { knife_to_t1: { knife: ['item-1'] } };
        expect(selectCraftItemIds(KNIFE_TO_T1, pool)).toBeNull();
        expect(selectCraftItemIds(KNIFE_TO_T1, {})).toBeNull();
    });

    it('concatenates multiple input types in recipe input order', () => {
        const pool = {
            dual: {
                a: ['item-a1'],
                b: ['item-b1', 'item-b2']
            }
        };
        expect(selectCraftItemIds(DUAL_RECIPE, pool)).toEqual(['item-a1', 'item-b1', 'item-b2']);
    });

    it('sums quantities when a type appears in multiple input entries', () => {
        const pool = {
            dup: {
                a: ['item-a1', 'item-a2']
            }
        };
        expect(selectCraftItemIds(DUP_TYPE_RECIPE, pool)).toEqual(['item-a1', 'item-a2']);

        // Only one of the two required 'a' items → unsatisfiable
        const partial = { dup: { a: ['item-a1'] } };
        expect(selectCraftItemIds(DUP_TYPE_RECIPE, partial)).toBeNull();
    });

    it('returns null for a malformed/absent recipe', () => {
        expect(selectCraftItemIds(null, {})).toBeNull();
        expect(selectCraftItemIds({ id: 'x', inputs: [] }, {})).toBeNull();
    });
});

/**
 * Unit tests for the pure logic extracted from public/js/CraftingPanel.js
 * (crafting design spec §2.5/§4.7, docs/crafting_design_spec.md):
 * per-component item grouping (groupItemsByComponent), readable component
 * name resolution (formatTypeName, resolveComponentLabel), the pending pool
 * with per-item hosts (addToPendingPool / removeFromPendingPool /
 * clearPendingPool / getPoolItemIds), broadcast pruning incl. host changes
 * (prunePool over the fresh items map), live-item flattening
 * (getLiveItemIds), the shared-host auto-craft rule (getCraftableHost),
 * pooled-set keys (pooledIdsKey), HTML escaping (escapeHtml), and
 * per-recipe satisfaction / exact-ID selection (computeRecipeSatisfaction,
 * selectCraftItemIds).
 *
 * Per the client-testing convention (pattern:
 * test/unit/RoomChatController.client.test.js), these tests exercise ONLY
 * the extracted pure functions — no raw DOM is tested; the panel class
 * (DOM/event wiring) stays out of scope here.
 *
 * Standing rule: every server-fetched map is defensive — guard group
 * values with Array.isArray before iteration.
 *
 * The pool's invariants are owned by the pure pruner (prunePool: liveness
 * AND host-change reconciliation against the fresh items map); any future
 * pool feature must extend it, not mutate the pool ad-hoc.
 */
import {
    groupItemsByComponent,
    formatTypeName,
    resolveComponentLabel,
    addToPendingPool,
    removeFromPendingPool,
    clearPendingPool,
    getPoolItemIds,
    getLiveItemIds,
    prunePool,
    pooledIdsKey,
    escapeHtml,
    computeRecipeSatisfaction,
    selectCraftItemIds,
    getCraftableHost
} from '../../public/js/CraftingPanel.js';

// --- Fixtures ------------------------------------------------------------------

/** A simple two-knife → one-t1 recipe (mirrors a real data/crafting.json entry) */
const KNIFE_TO_T1 = {
    id: 'knife_to_t1',
    name: 'T1 Assembly',
    description: 'Fuse two knives into one T1 container weapon.',
    inputs: [{ type: 'knife', quantity: 2 }],
    outputs: [{ type: 't1', quantity: 1 }]
};

/** A recipe with two DIFFERENT input types */
const DUAL_RECIPE = {
    id: 'dual_recipe',
    name: 'Dual',
    description: '',
    inputs: [
        { type: 'a', quantity: 1 },
        { type: 'b', quantity: 2 }
    ],
    outputs: [{ type: 'c', quantity: 1 }]
};

/** A recipe whose inputs list repeats the same type in two entries */
const DUP_TYPE_RECIPE = {
    id: 'dup_recipe',
    name: 'Dup',
    description: '',
    inputs: [
        { type: 'a', quantity: 1 },
        { type: 'a', quantity: 1 }
    ],
    outputs: [{ type: 'a', quantity: 2 }]
};

/**
 * Pending-pool entry factory: every pooled entry records the item instance
 * AND the component that hosted it when it was dropped.
 */
const entry = (id, host) => ({ id, host });

/** Entity-component groups (comp-… keys) plus the two excluded group kinds */
const ITEMS_BY_COMPONENT = {
    'comp-a': [
        { id: 'item-1', type: 'knife' },
        { id: 'item-2', type: 'knife' }
    ],
    'comp-b': [
        { id: 'item-3', type: 't1' }
    ],
    'item-container': [
        { id: 'nested-1', type: 'knife' }   // nested in a container item — excluded
    ],
    '__unassigned__': [
        { id: 'loose-1', type: 'knife' }    // no host — excluded
    ]
};

const ENTITY_COMP_IDS = ['comp-a', 'comp-b', 'comp-c'];

// --- groupItemsByComponent -------------------------------------------------------

describe('groupItemsByComponent', () => {
    it('returns one group per NON-EMPTY entity component, in entity order', () => {
        const groups = groupItemsByComponent(ITEMS_BY_COMPONENT, ENTITY_COMP_IDS);
        expect(groups).toEqual([
            { componentId: 'comp-a', items: [
                { id: 'item-1', type: 'knife' },
                { id: 'item-2', type: 'knife' }
            ] },
            { componentId: 'comp-b', items: [{ id: 'item-3', type: 't1' }] }
        ]);
    });

    it('follows the entity component order, not the items-map insertion order', () => {
        const items = {
            'comp-a': [{ id: 'i-a' }],
            'comp-b': [{ id: 'i-b' }]
        };
        const groups = groupItemsByComponent(items, ['comp-b', 'comp-a']);
        expect(groups.map((g) => g.componentId)).toEqual(['comp-b', 'comp-a']);
    });

    it('excludes container-item groups and __unassigned__ (they are not entity components)', () => {
        const groups = groupItemsByComponent(ITEMS_BY_COMPONENT, ENTITY_COMP_IDS);
        const keys = groups.map((g) => g.componentId);
        expect(keys).not.toContain('item-container');
        expect(keys).not.toContain('__unassigned__');
    });

    it('skips entity components that have an empty or missing group', () => {
        const items = {
            'comp-a': [],
            'comp-b': [{ id: 'i-b' }]
        };
        const groups = groupItemsByComponent(items, ['comp-a', 'comp-b', 'comp-c']);
        expect(groups.map((g) => g.componentId)).toEqual(['comp-b']);
    });

    it('excludes a group whose entries are all malformed (defensive)', () => {
        const items = {
            'comp-a': [null, {}, { id: 42 }],
            'comp-b': [{ id: 'i-b' }]
        };
        const groups = groupItemsByComponent(items, ['comp-a', 'comp-b']);
        expect(groups.map((g) => g.componentId)).toEqual(['comp-b']);
    });

    it('filters malformed entries out of a partially-valid group (keeps order)', () => {
        const items = { 'comp-a': [null, { id: 'i-1' }, {}, { id: 'i-2' }] };
        const groups = groupItemsByComponent(items, ['comp-a']);
        expect(groups).toEqual([{ componentId: 'comp-a', items: [{ id: 'i-1' }, { id: 'i-2' }] }]);
    });

    it('skips non-array group values (defensive against a malformed map)', () => {
        const items = { 'comp-a': 'not-an-array', 'comp-b': [{ id: 'i-b' }] };
        const groups = groupItemsByComponent(items, ['comp-a', 'comp-b']);
        expect(groups.map((g) => g.componentId)).toEqual(['comp-b']);
    });

    it('skips non-string / empty entity component ids (defensive)', () => {
        const items = { 'comp-a': [{ id: 'i-a' }] };
        const groups = groupItemsByComponent(items, [null, '', 'comp-a']);
        expect(groups.map((g) => g.componentId)).toEqual(['comp-a']);
    });

    it('returns [] for null/undefined maps or an empty/null entity component list', () => {
        expect(groupItemsByComponent(undefined, ['comp-a'])).toEqual([]);
        expect(groupItemsByComponent(null, ['comp-a'])).toEqual([]);
        expect(groupItemsByComponent({ 'comp-a': [{ id: 'i' }] }, [])).toEqual([]);
        expect(groupItemsByComponent({ 'comp-a': [{ id: 'i' }] }, null)).toEqual([]);
    });
});

// --- formatTypeName / resolveComponentLabel ---------------------------------------

describe('formatTypeName', () => {
    it('splits camelCase boundaries ("droidHead" → "Droid Head")', () => {
        expect(formatTypeName('droidHead')).toBe('Droid Head');
    });

    it('splits snake_case and kebab-case separators', () => {
        expect(formatTypeName('cutting_arm')).toBe('Cutting Arm');
        expect(formatTypeName('droid-hand')).toBe('Droid Hand');
    });

    it('title-cases simple ids ("t1" → "T1", "knife" → "Knife")', () => {
        expect(formatTypeName('t1')).toBe('T1');
        expect(formatTypeName('knife')).toBe('Knife');
    });

    it('coerces non-string values and tolerates empty input', () => {
        expect(formatTypeName(42)).toBe('42');
        expect(formatTypeName('')).toBe('');
    });
});

describe('resolveComponentLabel', () => {
    it('prefers the type on the entity\'s own component reference', () => {
        const droidComponents = [{ id: 'comp-a', type: 'droidHead' }, { id: 'comp-b', type: 'droidArm' }];
        expect(resolveComponentLabel('comp-b', droidComponents, {})).toBe('Droid Arm');
    });

    it('falls back to the component stats instance type when the reference has none', () => {
        const droidComponents = ['comp-a', { id: 'comp-b' }];
        const instances = { 'comp-b': { id: 'comp-b', type: 'droidArm' } };
        expect(resolveComponentLabel('comp-b', droidComponents, instances)).toBe('Droid Arm');
    });

    it('uses the instance entityComponentType as the last typed source', () => {
        const instances = { 'comp-a': { entityComponentType: 'droidHead' } };
        expect(resolveComponentLabel('comp-a', [], instances)).toBe('Droid Head');
    });

    it('a known reference type wins over a stale instance type', () => {
        const droidComponents = [{ id: 'comp-a', type: 'droidHead' }];
        const instances = { 'comp-a': { type: 'merchantCore' } };
        expect(resolveComponentLabel('comp-a', droidComponents, instances)).toBe('Droid Head');
    });

    it('NEVER returns a raw comp- ID: unknown sources fall back to "Unknown"', () => {
        expect(resolveComponentLabel('comp-5a46c5f2', [], {})).toBe('Unknown');
        expect(resolveComponentLabel('comp-5a46c5f2', null, null)).toBe('Unknown');
        expect(resolveComponentLabel('comp-x', [{ id: 'comp-x' }], {})).toBe('Unknown');
    });

    it('ignores an instance type that is itself the sentinel "unknown"', () => {
        const instances = { 'comp-a': { type: 'unknown' } };
        expect(resolveComponentLabel('comp-a', [], instances)).toBe('Unknown');
    });
});

// --- Pool ops (per-item host) ------------------------------------------------------

describe('addToPendingPool', () => {
    it('adds a hosted entry to the target recipe/type and returns a new object', () => {
        const pool = {};
        const next = addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-1', 'comp-a');
        expect(next).not.toBe(pool);
        expect(next).toEqual({ knife_to_t1: { knife: [entry('item-1', 'comp-a')] } });
    });

    it('does not mutate the original pool (immutability)', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        const next = addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-2', 'comp-b');
        expect(pool).toEqual({ knife_to_t1: { knife: [entry('item-1', 'comp-a')] } });
        expect(next).toEqual({ knife_to_t1: { knife: [entry('item-1', 'comp-a'), entry('item-2', 'comp-b')] } });
    });

    it('dedupes by item ID: adding the same item twice is a no-op (same reference)', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-1', 'comp-a')).toBe(pool);
    });

    it('dedupes by item ID across recipes (one physical instance → one proposal)', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        const next = addToPendingPool(pool, 'other_recipe', 'knife', 'item-1', 'comp-b');
        expect(next).toBe(pool);
    });

    it('keeps existing entries when adding to a recipe that already has other types', () => {
        const pool = { dual: { a: [entry('item-1', 'comp-a')] } };
        const next = addToPendingPool(pool, 'dual', 'b', 'item-2', 'comp-b');
        expect(next).toEqual({ dual: { a: [entry('item-1', 'comp-a')], b: [entry('item-2', 'comp-b')] } });
    });

    it('is a no-op (same reference) for empty/invalid arguments (incl. missing host)', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', '', 'comp-a')).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', null, 'comp-a')).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', undefined, 'comp-a')).toBe(pool);
        expect(addToPendingPool(pool, '', 'knife', 'item-2', 'comp-a')).toBe(pool);
        expect(addToPendingPool(pool, null, 'knife', 'item-2', 'comp-a')).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', '', 'item-2', 'comp-a')).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-2', '')).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-2', null)).toBe(pool);
        expect(addToPendingPool(pool, 'knife_to_t1', 'knife', 'item-2')).toBe(pool);
    });
});

describe('removeFromPendingPool', () => {
    it('removes the recipe and keeps the others', () => {
        const pool = { r1: { a: [entry('i1', 'comp-a')] }, r2: { b: [entry('i2', 'comp-b')] } };
        const next = removeFromPendingPool(pool, 'r1');
        expect(next).not.toBe(pool);
        expect(next).toEqual({ r2: { b: [entry('i2', 'comp-b')] } });
    });

    it('does not mutate the original pool', () => {
        const pool = { r1: { a: [entry('i1', 'comp-a')] } };
        removeFromPendingPool(pool, 'r1');
        expect(pool).toEqual({ r1: { a: [entry('i1', 'comp-a')] } });
    });

    it('is a no-op (same reference) when the recipe has no pooled entries', () => {
        const pool = { r1: { a: [entry('i1', 'comp-a')] } };
        expect(removeFromPendingPool(pool, 'r99')).toBe(pool);
    });
});

describe('clearPendingPool', () => {
    it('returns a fresh empty pool and does not touch the original', () => {
        const pool = { r1: { a: [entry('i1', 'comp-a')] } };
        const next = clearPendingPool(pool);
        expect(next).toEqual({});
        expect(next).not.toBe(pool);
        expect(pool).toEqual({ r1: { a: [entry('i1', 'comp-a')] } });
    });
});

describe('getPoolItemIds', () => {
    it('flattens all pooled item ids across recipes/types (entry objects)', () => {
        const pool = {
            r1: { a: [entry('i1', 'comp-a')], b: [entry('i2', 'comp-b')] },
            r2: { a: [entry('i3', 'comp-c')] }
        };
        expect(getPoolItemIds(pool)).toEqual(['i1', 'i2', 'i3']);
    });

    it('returns [] for an empty/absent pool', () => {
        expect(getPoolItemIds({})).toEqual([]);
        expect(getPoolItemIds(null)).toEqual([]);
        expect(getPoolItemIds(undefined)).toEqual([]);
    });
});

// --- Pruning (liveness + host change) ----------------------------------------------

describe('prunePool', () => {
    const items = {
        'comp-a': [{ id: 'item-1', type: 'knife' }],
        'comp-b': [{ id: 'item-2', type: 'knife' }]
    };

    it('drops pooled items that are no longer live and keeps the rest', () => {
        const pool = {
            knife_to_t1: { knife: [entry('item-1', 'comp-a'), entry('item-gone', 'comp-a')] },
            dual: { a: [entry('item-2', 'comp-b')] }
        };
        const next = prunePool(pool, items);
        expect(next).not.toBe(pool);
        expect(next).toEqual({
            knife_to_t1: { knife: [entry('item-1', 'comp-a')] },
            dual: { a: [entry('item-2', 'comp-b')] }
        });
    });

    it('drops an entry whose item MOVED to a different component (host changed)', () => {
        const fresh = {
            'comp-a': [],
            'comp-b': [{ id: 'item-1', type: 'knife' }]
        };
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        expect(prunePool(pool, fresh)).toEqual({});
    });

    it('keeps entries whose recorded host still matches (incl. nested and __unassigned__ hosts)', () => {
        const fresh = {
            'comp-a': [{ id: 'item-1', type: 'knife' }],
            'item-container': [{ id: 'item-2', type: 'knife' }],
            '__unassigned__': [{ id: 'item-3', type: 'knife' }]
        };
        const pool = {
            knife_to_t1: {
                knife: [
                    entry('item-1', 'comp-a'),
                    entry('item-2', 'item-container'),
                    entry('item-3', '__unassigned__')
                ]
            }
        };
        expect(prunePool(pool, fresh)).toBe(pool);
    });

    it('returns the same reference when nothing changed', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        expect(prunePool(pool, items)).toBe(pool);
    });

    it('treats a null map as "everything stale"', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        expect(prunePool(pool, null)).toEqual({});
    });

    it('removes types/recipes that become empty after pruning', () => {
        const pool = {
            knife_to_t1: { knife: [entry('item-1', 'comp-a')] },
            dual: { a: [entry('item-1', 'comp-a')] }
        };
        expect(prunePool(pool, {})).toEqual({});
    });

    it('prunes with the fresh map supplying BOTH facts (liveness and host) in one pass', () => {
        // item-2 moved comp-a → comp-b; item-3 vanished; item-1 still on comp-a.
        const fresh = {
            'comp-a': [{ id: 'item-1', type: 'knife' }],
            'comp-b': [{ id: 'item-2', type: 'knife' }]
        };
        const pool = {
            knife_to_t1: {
                knife: [
                    entry('item-1', 'comp-a'),
                    entry('item-2', 'comp-a'),
                    entry('item-3', 'comp-a')
                ]
            }
        };
        expect(prunePool(pool, fresh)).toEqual({
            knife_to_t1: { knife: [entry('item-1', 'comp-a')] }
        });
    });
});

// --- getLiveItemIds ------------------------------------------------------------------

describe('getLiveItemIds', () => {
    it('flattens all item ids across groups', () => {
        expect(getLiveItemIds(ITEMS_BY_COMPONENT)).toEqual([
            'item-1', 'item-2', 'item-3', 'nested-1', 'loose-1'
        ]);
    });

    it('returns [] for empty/null/undefined maps', () => {
        expect(getLiveItemIds({})).toEqual([]);
        expect(getLiveItemIds(null)).toEqual([]);
        expect(getLiveItemIds(undefined)).toEqual([]);
    });

    it('skips non-array group values (defensive)', () => {
        expect(getLiveItemIds({ 'comp-a': 'oops', 'comp-b': [{ id: 'item-9' }] }))
            .toEqual(['item-9']);
    });

    it('skips non-object / id-less entries', () => {
        expect(getLiveItemIds({ 'comp-a': [null, { type: 'knife' }, { id: 'item-7' }] }))
            .toEqual(['item-7']);
    });

    it('keeps duplicates if an item is listed under multiple groups', () => {
        expect(getLiveItemIds({ 'comp-a': [{ id: 'dup' }], 'comp-b': [{ id: 'dup' }] }))
            .toEqual(['dup', 'dup']);
    });
});

// --- getCraftableHost (same-host auto-craft rule) --------------------------------------

describe('getCraftableHost', () => {
    it('returns the single shared host when the recipe is satisfied and all inputs share it', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a'), entry('item-2', 'comp-a')] } };
        expect(getCraftableHost(KNIFE_TO_T1, pool)).toBe('comp-a');
    });

    it('returns null when the inputs are satisfied but SPLIT across hosts (must not auto-fire)', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a'), entry('item-2', 'comp-b')] } };
        expect(getCraftableHost(KNIFE_TO_T1, pool)).toBeNull();
    });

    it('returns null when the pool cannot satisfy the recipe (short or empty)', () => {
        const sameHost = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        expect(getCraftableHost(KNIFE_TO_T1, sameHost)).toBeNull();
        expect(getCraftableHost(KNIFE_TO_T1, {})).toBeNull();
    });

    it('resolves a shared host across multiple input types', () => {
        const pool = {
            dual_recipe: {
                a: [entry('item-a1', 'comp-x')],
                b: [entry('item-b1', 'comp-x'), entry('item-b2', 'comp-x')]
            }
        };
        expect(getCraftableHost(DUAL_RECIPE, pool)).toBe('comp-x');
    });

    it('counts extra pooled items of the same type toward the host check (overfill)', () => {
        // 3 knives on comp-a for a 2-knife recipe → all share the host → may fire
        // (selectCraftItemIds takes exactly two).
        const pool = {
            knife_to_t1: {
                knife: [
                    entry('item-1', 'comp-a'),
                    entry('item-2', 'comp-a'),
                    entry('item-3', 'comp-a')
                ]
            }
        };
        expect(getCraftableHost(KNIFE_TO_T1, pool)).toBe('comp-a');

        // The same overfill split across hosts must NOT fire.
        const split = {
            knife_to_t1: {
                knife: [
                    entry('item-1', 'comp-a'),
                    entry('item-2', 'comp-a'),
                    entry('item-3', 'comp-b')
                ]
            }
        };
        expect(getCraftableHost(KNIFE_TO_T1, split)).toBeNull();
    });

    it('returns null when a pooled entry carries no usable host, even if satisfied', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a'), { id: 'item-2', host: '' }] } };
        expect(getCraftableHost(KNIFE_TO_T1, pool)).toBeNull();
    });

    it('returns null for a malformed/absent recipe', () => {
        expect(getCraftableHost(null, {})).toBeNull();
        expect(getCraftableHost({ id: 'x', inputs: [] }, {})).toBeNull();
    });
});

// --- pooledIdsKey (re-arm guard) ---------------------------------------------------------

describe('pooledIdsKey', () => {
    it('same pooled set → same key (order-insensitive)', () => {
        const poolA = { knife_to_t1: { knife: [entry('item-1', 'comp-a'), entry('item-2', 'comp-b')] } };
        const poolB = { knife_to_t1: { knife: [entry('item-2', 'comp-b'), entry('item-1', 'comp-a')] } };
        expect(pooledIdsKey(KNIFE_TO_T1, poolA)).toBe(pooledIdsKey(KNIFE_TO_T1, poolB));
    });

    it('different sets → different keys', () => {
        const poolA = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        const poolB = { knife_to_t1: { knife: [entry('item-2', 'comp-a')] } };
        expect(pooledIdsKey(KNIFE_TO_T1, poolA)).not.toBe(pooledIdsKey(KNIFE_TO_T1, poolB));
    });

    it('a host change alone does NOT change the key (the re-arm guard is ID-set based)', () => {
        const poolA = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        const poolB = { knife_to_t1: { knife: [entry('item-1', 'comp-b')] } };
        expect(pooledIdsKey(KNIFE_TO_T1, poolA)).toBe(pooledIdsKey(KNIFE_TO_T1, poolB));
    });

    it('empty pool → empty string key', () => {
        expect(pooledIdsKey(KNIFE_TO_T1, {})).toBe('');
        expect(pooledIdsKey(KNIFE_TO_T1, null)).toBe('');
    });
});

// --- escapeHtml ---------------------------------------------------------------------------

describe('escapeHtml', () => {
    it('escapes the five HTML metacharacters', () => {
        // The expected string is written with \u0026 escapes (repo
        // pattern): the tooling HTML-decodes raw entities on write, but
        // \u0026 === '&' at runtime, so the assertion checks the exact
        // entity form.
        expect(escapeHtml('a"b<c>&d\'e')).toBe('a\u0026quot;b\u0026lt;c\u0026gt;\u0026amp;d\u0026#39;e');
    });

    it('escapes backticks and equals as well', () => {
        expect(escapeHtml('`x=y`')).toBe('\u0026#96;x\u0026#61;y\u0026#96;');
    });

    it('does not double-escape already-escaped input', () => {
        expect(escapeHtml('\u0026amp;')).toBe('\u0026amp;amp;');
    });

    it('coerces non-string values via String()', () => {
        expect(escapeHtml(42)).toBe('42');
    });

    it('null → "null"', () => {
        expect(escapeHtml(null)).toBe('null');
    });
});

// --- computeRecipeSatisfaction (pinned semantics) --------------------------------------------

describe('computeRecipeSatisfaction', () => {
    it('satisfied when the pool holds the exact required count', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a'), entry('item-2', 'comp-b')] } };
        const { satisfied, entries, missing } = computeRecipeSatisfaction(KNIFE_TO_T1, pool);
        expect(satisfied).toBe(true);
        expect(entries).toEqual([{ type: 'knife', have: 2, need: 2, isMet: true }]);
        expect(missing).toEqual([]);
    });

    it('unsatisfied when an input type is short (exact multiset, not total count)', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        const { satisfied, entries, missing } = computeRecipeSatisfaction(KNIFE_TO_T1, pool);
        expect(satisfied).toBe(false);
        expect(entries[0]).toEqual({ type: 'knife', have: 1, need: 2, isMet: false });
        expect(missing).toEqual(entries);
    });

    it('item types that are not recipe inputs are ignored (never count toward satisfaction)', () => {
        const pool = { knife_to_t1: { t1: [entry('item-1', 'comp-a'), entry('item-2', 'comp-b')] } };
        const { satisfied, missing } = computeRecipeSatisfaction(KNIFE_TO_T1, pool);
        expect(satisfied).toBe(false);
        expect(missing).toHaveLength(1);
    });

    it('a recipe with no inputs is NEVER satisfied (defensive)', () => {
        const { satisfied } = computeRecipeSatisfaction({ id: 'r', inputs: [] }, {});
        expect(satisfied).toBe(false);
    });

    it('an input with quantity <= 0 is NEVER met (mirrors the server rule)', () => {
        const { satisfied } = computeRecipeSatisfaction(
            { id: 'r', inputs: [{ type: 'a', quantity: 0 }] },
            { r: { a: [entry('i', 'comp-a')] } }
        );
        expect(satisfied).toBe(false);
    });

    it('repeated input entries of the same type each demand their own quantity', () => {
        const pool = {
            dup_recipe: {
                a: [entry('item-1', 'comp-a'), entry('item-2', 'comp-b')]
            }
        };
        const { satisfied, entries } = computeRecipeSatisfaction(DUP_TYPE_RECIPE, pool);
        expect(satisfied).toBe(true);
        expect(entries.map((e) => e.need)).toEqual([1, 1]);
        expect(entries.every((e) => e.isMet)).toBe(true);
    });

    it('a null recipe is unsatisfied (defensive)', () => {
        const { satisfied } = computeRecipeSatisfaction(null, {});
        expect(satisfied).toBe(false);
    });
});

// --- selectCraftItemIds (exact multiset, drop order) ---------------------------------------------

describe('selectCraftItemIds', () => {
    it('returns the exact required item IDs in drop order', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a'), entry('item-2', 'comp-b')] } };
        expect(selectCraftItemIds(KNIFE_TO_T1, pool)).toEqual(['item-1', 'item-2']);
    });

    it('returns null when the pool is short (never sends extra, never pads)', () => {
        const pool = { knife_to_t1: { knife: [entry('item-1', 'comp-a')] } };
        expect(selectCraftItemIds(KNIFE_TO_T1, pool)).toBeNull();
    });

    it('returns null for a recipe with no inputs (defensive)', () => {
        expect(selectCraftItemIds({ id: 'r', inputs: [] }, {})).toBeNull();
    });

    it('returns null for a null recipe (defensive)', () => {
        expect(selectCraftItemIds(null, {})).toBeNull();
    });

    it('takes exactly the required amount when over-filled (first-in-drop-order)', () => {
        const pool = {
            knife_to_t1: {
                knife: [entry('item-1', 'comp-a'), entry('item-2', 'comp-a'), entry('item-3', 'comp-b')]
            }
        };
        expect(selectCraftItemIds(KNIFE_TO_T1, pool)).toEqual(['item-1', 'item-2']);
    });

    it('handles repeated input entries of the same type against the shared per-type pool', () => {
        const pool = {
            dup_recipe: {
                a: [entry('item-1', 'comp-a'), entry('item-2', 'comp-a')]
            }
        };
        expect(selectCraftItemIds(DUP_TYPE_RECIPE, pool)).toEqual(['item-1', 'item-2']);
    });
});

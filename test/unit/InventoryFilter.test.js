/**
 * InventoryFilter — unit tests for the client inventory view filter.
 *
 * Covers the pure filter module (`public/utils/InventoryFilter.js`) across the
 * 14 spec cases, plus one stubbed-DOM panel integration test that drives
 * `InventoryManager._renderInventory()` to confirm the filter hooks into the
 * render path (visible/hidden slots + the `inventory-name-match` highlight).
 *
 * The pure functions are exercised directly (no DOM, no fetch). The integration
 * test follows the harness pattern of `InventoryManager.client.test.js`: a bare
 * instance with a stubbed `_content` and a fixture `getState()`.
 *
 * @module test/unit/InventoryFilter
 */

import { describe, it, expect } from 'vitest';
import {
    SEARCH_MATCH_OPTIONS,
    matchesQuery,
    hasDirectItems,
    collectSubtreeItemIds,
    filterInventoryView,
} from '../../public/utils/InventoryFilter.js';
import { InventoryManager } from '../../public/js/InventoryManager.js';

/**
 * Shared fixture: three volume components (comp-a/b/c) and a container item
 * (item-box) nested inside comp-b, holding a grandchild (item-cell). The flat
 * `itemsByHost` map mirrors the server's host → items shape; item display names
 * are chosen to be mutually non-overlapping so each query hits exactly one
 * target.
 */
const ITEMS_BY_HOST = {
    'comp-a': [
        { id: 'item-a', name: 'Alloy Rod', type: 'alloyRod', hostComponentId: 'comp-a' },
    ],
    'comp-b': [
        { id: 'item-box', name: 'Metal Box', type: 'metalBox', hostComponentId: 'comp-b' },
    ],
    'item-box': [
        { id: 'item-cell', name: 'Power Cell', type: 'powerCell', hostComponentId: 'item-box' },
    ],
    'comp-c': [],
};

const COMPONENTS = [
    { id: 'comp-a', name: 'Arm' },
    { id: 'comp-b', name: 'Torso' },
    { id: 'comp-c', name: 'Head' },
];

const ids = (result) => result.components.map((c) => c.id);

describe('InventoryFilter — filterInventoryView', () => {
    it('case 1: empty query + toggle OFF is inert (all components, input order)', () => {
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST });
        expect(ids(result)).toEqual(['comp-a', 'comp-b', 'comp-c']);
        expect(result.matchedComponentIds.size).toBe(0);
        expect(result.matchedItemIds.size).toBe(0);
    });

    it('case 2: partial mid-name fragment on a component name', () => {
        // "ors" is a mid-name fragment of "Torso" (comp-b) only.
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST, query: 'ors' });
        expect(ids(result)).toEqual(['comp-b']);
        expect(result.matchedComponentIds.has('comp-b')).toBe(true);
    });

    it('case 3: match is case-insensitive (query casing differs from stored name)', () => {
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST, query: 'tORSO' });
        expect(ids(result)).toEqual(['comp-b']);
    });

    it('case 4: a component-name match keeps a zero-item component (toggle OFF)', () => {
        // comp-c has no items but its name "Head" matches.
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST, query: 'head' });
        expect(ids(result)).toEqual(['comp-c']);
    });

    it('case 5: a direct item-name match keeps its host component visible', () => {
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST, query: 'Alloy' });
        expect(ids(result)).toEqual(['comp-a']);
        expect(result.matchedItemIds.has('item-a')).toBe(true);
    });

    it('case 6: a grandchild match (item inside item-box inside comp-b) keeps comp-b visible', () => {
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST, query: 'Cell' });
        expect(ids(result)).toEqual(['comp-b']);
        expect(result.matchedItemIds.has('item-cell')).toBe(true);
    });

    it('case 7: toggle ON hides components with no direct items, keeps those with >= 1', () => {
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST, containsItemOnly: true });
        // comp-a (item-a) and comp-b (item-box) have direct items; comp-c has none.
        expect(ids(result)).toEqual(['comp-a', 'comp-b']);
    });

    it('case 8: toggle ON keeps a component whose only content is an empty container', () => {
        // The container item is itself a direct item, so the component qualifies
        // even though the container holds no children.
        const host = {
            'comp-x': [{ id: 'item-emptybox', name: 'Empty Crate', type: 'emptyCrate', hostComponentId: 'comp-x' }],
        };
        const result = filterInventoryView({
            components: [{ id: 'comp-x', name: 'Leg' }],
            itemsByHost: host,
            containsItemOnly: true,
        });
        expect(ids(result)).toEqual(['comp-x']);
    });

    it('case 9: both filters active combine as AND', () => {
        const host = {
            'comp-a': [{ id: 'item-a', name: 'Alloy Rod', type: 'alloyRod', hostComponentId: 'comp-a' }],
            'comp-d': [{ id: 'item-d', name: 'Widget', type: 'widget', hostComponentId: 'comp-d' }],
            'comp-e': [],
        };
        const comps = [
            { id: 'comp-a', name: 'Arm' },
            { id: 'comp-d', name: 'Core' },
            { id: 'comp-e', name: 'Empty' },
        ];

        // (a) direct items AND a matching item -> kept.
        const kept = filterInventoryView({ components: comps, itemsByHost: host, containsItemOnly: true, query: 'Alloy' });
        expect(ids(kept)).toEqual(['comp-a']);

        // (b) direct items but no name match -> hidden.
        const noMatch = filterInventoryView({ components: comps, itemsByHost: host, containsItemOnly: true, query: 'zzz' });
        expect(ids(noMatch)).toEqual([]);

        // (c) no direct items -> hidden. A "deep match without a direct item" is
        // impossible in this forest model (any descendant has a topmost ancestor
        // held directly), so the toggle governs: comp-e is excluded regardless.
        const emptyHidden = filterInventoryView({ components: comps, itemsByHost: host, containsItemOnly: true, query: 'Alloy' });
        expect(emptyHidden.components.map((c) => c.id)).not.toContain('comp-e');
    });

    it('case 10: zero matches -> empty component list', () => {
        const result = filterInventoryView({ components: COMPONENTS, itemsByHost: ITEMS_BY_HOST, query: 'zzzzzz' });
        expect(result.components).toEqual([]);
        expect(result.matchedComponentIds.size).toBe(0);
        expect(result.matchedItemIds.size).toBe(0);
    });

    it('case 10b: an item with a present-but-empty name is matched via its type (display-alignment rule)', () => {
        const host = {
            'comp-a': [{ id: 'item-x', name: '', type: 'coalChunk', hostComponentId: 'comp-a' }],
        };
        const result = filterInventoryView({
            components: [{ id: 'comp-a', name: 'Arm' }],
            itemsByHost: host,
            query: 'coal',
        });
        expect(ids(result)).toEqual(['comp-a']);
        expect(result.matchedItemIds.has('item-x')).toBe(true);
    });

    it('case 16: malformed entry-level input degrades gracefully (no throw, guarded empty view)', () => {
        // No argument at all / null fields -> empty view, no throw
        expect(() => filterInventoryView()).not.toThrow();
        const empty = filterInventoryView({
            components: null, itemsByHost: null, containsItemOnly: null, query: null,
        });
        expect(empty.components).toEqual([]);
        expect(empty.matchedComponentIds.size).toBe(0);
        expect(empty.matchedItemIds.size).toBe(0);

        // null / non-string-id component entries are skipped; valid entries still filter
        const result = filterInventoryView({
            components: [null, { name: 'NoId' }, { id: 42 }, { id: 'comp-a', name: 'Arm' }],
            itemsByHost: { 'comp-a': [{ id: 'item-a', name: 'Alloy Rod', hostComponentId: 'comp-a' }] },
            containsItemOnly: true,
            query: 'Alloy',
        });
        expect(ids(result)).toEqual(['comp-a']);
        expect(result.matchedItemIds.has('item-a')).toBe(true);
    });
});

describe('InventoryFilter — predicate contracts', () => {
    it('case 11a: hasDirectItems treats missing key / non-array / [] as false, non-empty as true', () => {
        expect(hasDirectItems({ x: [] }, 'x')).toBe(false);
        expect(hasDirectItems({}, 'x')).toBe(false);
        expect(hasDirectItems({ x: 'notarray' }, 'x')).toBe(false);
        expect(hasDirectItems({ x: [{ id: 'a' }] }, 'x')).toBe(true);
        expect(hasDirectItems(null, 'x')).toBe(false);
        expect(hasDirectItems({ x: [] }, null)).toBe(false);
    });

    it('case 11b: matchesQuery — empty/whitespace query and non-string name are no-match; default options are trimmed + case-insensitive', () => {
        // The match policy is a named, frozen constant.
        expect(SEARCH_MATCH_OPTIONS).toEqual({ caseSensitive: false, wholeWord: false });

        // Empty / whitespace-only query -> no match.
        expect(matchesQuery('Name', '')).toBe(false);
        expect(matchesQuery('Name', '   ')).toBe(false);

        // null / undefined / non-string name -> no match.
        expect(matchesQuery(null, 'name')).toBe(false);
        expect(matchesQuery(undefined, 'name')).toBe(false);
        expect(matchesQuery(123, '123')).toBe(false);

        // Trimmed + case-insensitive substring under the default options.
        expect(matchesQuery('  Hello World ', 'hello')).toBe(true);
        expect(matchesQuery('Hello World', '  WORLD  ')).toBe(true);
        expect(matchesQuery('Hello World', 'Goodbye')).toBe(false);
    });

    it('case 11c: wholeWord policy aligns matches to word boundaries and treats regex metacharacters literally', () => {
        // Whole-word, not substring.
        expect(matchesQuery('Copper Plate', 'copper', { wholeWord: true })).toBe(true);
        expect(matchesQuery('Copper Plate', 'copp', { wholeWord: true })).toBe(false);
        // Regex metacharacters in the query are escaped: '.' must be literal,
        // never a wildcard.
        expect(matchesQuery('a.b test', 'a.b', { wholeWord: true })).toBe(true);
        expect(matchesQuery('axb test', 'a.b', { wholeWord: true })).toBe(false);
    });
});

describe('InventoryFilter — collectSubtreeItemIds', () => {
    it('case 12a: a two-level chain returns every id at every depth', () => {
        const host = {
            'comp-a': [{ id: 'item-box', hostComponentId: 'comp-a' }],
            'item-box': [{ id: 'item-cell', hostComponentId: 'item-box' }],
        };
        expect(collectSubtreeItemIds(host, 'comp-a').sort()).toEqual(['item-box', 'item-cell']);
        expect(collectSubtreeItemIds(host, 'item-box')).toEqual(['item-cell']);
    });

    it('case 12b: a crafted cycle (A inside B, B inside A) terminates via the visited guard', () => {
        const cycle = {
            a: [{ id: 'b', hostComponentId: 'a' }],
            b: [{ id: 'a', hostComponentId: 'b' }],
        };
        expect(collectSubtreeItemIds(cycle, 'a').sort()).toEqual(['a', 'b']);
    });

    it('case 12c: a missing root (or non-object map) yields an empty array', () => {
        expect(collectSubtreeItemIds({}, 'nope')).toEqual([]);
        expect(collectSubtreeItemIds(null, 'a')).toEqual([]);
        expect(collectSubtreeItemIds({ a: [] }, 'a')).toEqual([]);
    });
});

describe('InventoryFilter — matched-id scoping', () => {
    it('case 13: matched ids are scoped to visible subtrees; both sets empty when the query is inactive', () => {
        const host = {
            'comp-a': [{ id: 'item-a', name: 'Alloy Rod', type: 'alloyRod', hostComponentId: 'comp-a' }],
            'comp-c': [],
        };
        const comps = [
            { id: 'comp-a', name: 'Arm' },
            { id: 'comp-c', name: 'Head' },
        ];

        // comp-c is hidden by the toggle (no direct items) and therefore
        // contributes no ids; comp-a is visible and its matching item is scoped in.
        // (A "matching item under a hidden component" is impossible in this forest
        // model — a hidden component has no matching items by construction — so the
        // scoping holds and the observable consequence is what is asserted here.)
        const active = filterInventoryView({ components: comps, itemsByHost: host, containsItemOnly: true, query: 'Alloy' });
        expect(ids(active)).toEqual(['comp-a']);
        expect(active.matchedItemIds.has('item-a')).toBe(true);
        expect(active.matchedItemIds.size).toBe(1);
        expect(active.matchedComponentIds.size).toBe(0); // no component name matched "Alloy"

        // Inactive query -> both sets empty.
        const inactive = filterInventoryView({ components: comps, itemsByHost: host, containsItemOnly: true, query: '' });
        expect(inactive.matchedComponentIds.size).toBe(0);
        expect(inactive.matchedItemIds.size).toBe(0);
    });
});

describe('InventoryFilter — panel integration (stubbed DOM)', () => {
    const STATE = {
        entities: {
            'ent-1': {
                components: [
                    { id: 'comp-a', type: 'arm' },
                    { id: 'comp-b', type: 'torso' },
                ],
            },
        },
        components: {
            instances: {
                'comp-a': { id: 'comp-a', type: 'arm', Physical: { volume: 10 } },
                'comp-b': { id: 'comp-b', type: 'torso', Physical: { volume: 20 } },
            },
        },
    };

    const INTEGRATION_ITEMS = {
        'comp-a': [
            { id: 'item-a', name: 'Alloy Rod', type: 'alloyRod', hostComponentId: 'comp-a', volume: 1, externalVolume: 1 },
        ],
        'comp-b': [],
    };

    /** Bare client instance wired for `_renderInventory()` with a stubbed DOM. */
    function makeIntegrationManager({ itemsByHost, filters }) {
        const manager = new InventoryManager({ getState: () => STATE }, {}, {});
        manager._currentEntityId = 'ent-1';
        manager._overlay = { style: { display: 'block' } };
        manager._content = { innerHTML: '', querySelectorAll: () => [] };
        manager._currentItems = itemsByHost;
        manager._itemRegistry = {};
        manager._holdingCostRegistry = {};
        manager._equippedItems = {};
        manager._containerExpanded = {};
        manager._draggingItemId = null;
        manager._filters = filters;
        manager._matchedComponentIds = null;
        manager._matchedItemIds = null;
        return manager;
    }

    it('case 14: _renderInventory renders the visible slot, omits the hidden slot, and highlights the match', () => {
        const manager = makeIntegrationManager({
            itemsByHost: INTEGRATION_ITEMS,
            filters: { containsItemOnly: false, query: 'Alloy' },
        });
        manager._renderInventory();
        const html = manager._content.innerHTML;

        // The matching component slot is present...
        expect(html).toContain('data-comp-id="comp-a"');
        expect(html).toContain('Alloy Rod');
        // ...the hidden slot (no direct item, no name match) is omitted...
        expect(html).not.toContain('data-comp-id="comp-b"');
        // ...and the matched item name span carries the highlight class.
        expect(html).toContain('inventory-item-name inventory-name-match');
    });

    it('case 15: a filter that hides every existing component renders the dedicated filter empty state', () => {
        const manager = makeIntegrationManager({
            itemsByHost: INTEGRATION_ITEMS,
            filters: { containsItemOnly: false, query: 'zzzzzz' },
        });
        manager._renderInventory();
        const html = manager._content.innerHTML;
        // Exact spec-pinned label
        expect(html).toContain('No components match the current filter');
        // No component slot survives
        expect(html).not.toContain('data-comp-id');
        // The overlay stays visible
        expect(manager._overlay.style.display).toBe('block');

        // Toggle + query combined (AND) hits the same empty state
        const manager2 = makeIntegrationManager({
            itemsByHost: INTEGRATION_ITEMS,
            filters: { containsItemOnly: true, query: 'zzzzzz' },
        });
        manager2._renderInventory();
        expect(manager2._content.innerHTML).toContain('No components match the current filter');
    });
});

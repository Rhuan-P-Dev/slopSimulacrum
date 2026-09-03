/**
 * ComponentViewer (CLIENT) read-only item rendering — unit tests.
 *
 * Per the client-testing convention (pattern:
 * test/unit/KnowledgePanel.test.js, test/unit/CraftingPanel.test.js),
 * these tests exercise ONLY the exported pure functions of
 * public/js/ComponentViewer.js and public/utils/ItemTree.js — no raw DOM, no fetch.
 *
 * Covers the client-side fix that makes a spawned droid's carried items visible
 * (read-only) in the per-entity component-viewer panel:
 *
 *   1. directChildrenOf — the flat-model child-grouping primitive shared with
 *       InventoryManager: returns only the flat items whose hostComponentId
 *       equals the host, and degrades to [] for a missing host or non-array input
 *       without mutating the input.
 *   2. escapeHtml — the five HTML special characters are escaped so server-
 *       derived item names can be interpolated safely.
 *   3. getEquippedItemIds — collects the equipped item IDs into a Set, skipping
 *       malformed entries; empty/missing `equipped` yields an empty Set.
 *   4. renderHostedItemsHtml — the read-only render contract:
 *        - host grouping: only items hosted on the requested component render
 *          (items on other components do NOT leak in);
 *        - equipped marker: an equipped item gets the cv-item-equipped class + ⚔️;
 *        - nested contents: a container item renders its children in a
 *          .cv-item-children block;
 *        - empty inventory (no items on the host) returns '';
 *        - missing/unknown item fields never throw;
 *        - non-array input returns '';
 *        - cyclic host data terminates at the nesting depth cap (no hang, no throw);
 *        - malformed rows (null elements, items without an id) are skipped;
 *        - a nested equipped item carries BOTH cv-item-equipped and cv-item-nested;
 *        - non-array/non-Set equippedItemIds (e.g. null) degrades to "nothing equipped".
 *        - inputs are NEVER mutated (the shared world-state items array is intact).
 *
 * @module test/unit/ComponentViewer.client
 */
import { describe, it, expect } from 'vitest';
import {
    getEquippedItemIds,
    renderHostedItemsHtml,
} from '../../public/js/ComponentViewer.js';
import {
    directChildrenOf,
    escapeHtml,
} from '../../public/utils/ItemTree.js';

// --- Fixtures ------------------------------------------------------------------

/** Builds a flat item record mirroring the entity.items shape. */
function makeItem(id, name, type, hostComponentId) {
    return { id, name, type, hostComponentId };
}

/**
 * A loadout that mirrors the killerLlmDrone NPC: a T1 weapon + spare knife
 * carried on comp-arm (both equipped), the T1 holding nested knives, and an
 * unrelated item on comp-leg to prove host-scoping.
 */
function makeLoadout() {
    const items = [
        makeItem('item-t1', 'T1 Weapon', 'weapon', 'comp-arm'),
        makeItem('item-knife1', 'Knife', 'knife', 'comp-arm'),
        // Nested contents of the T1 weapon (hostComponentId -> container item id).
        makeItem('k1', 'Knife', 'knife', 'item-t1'),
        makeItem('k2', 'Knife', 'knife', 'item-t1'),
        // An item hosted on a DIFFERENT component (must not leak into comp-arm).
        makeItem('item-boot', 'Boot', 'boot', 'comp-leg'),
    ];
    const equipped = [
        { itemId: 'item-t1' },
        { itemId: 'item-knife1' },
    ];
    return { items, equipped };
}

// --- directChildrenOf ----------------------------------------------------------

describe('ItemTree.directChildrenOf', () => {
    it('returns only the flat items hosted on the given component id', () => {
        const { items } = makeLoadout();
        const children = directChildrenOf('comp-arm', items);
        expect(children.map((i) => i.id)).toEqual(['item-t1', 'item-knife1']);
    });

    it('resolves nested children by a container item id', () => {
        const { items } = makeLoadout();
        const children = directChildrenOf('item-t1', items);
        expect(children.map((i) => i.id)).toEqual(['k1', 'k2']);
    });

    it('returns an empty array for a host that carries nothing', () => {
        const { items } = makeLoadout();
        expect(directChildrenOf('comp-thigh', items)).toEqual([]);
    });

    it('returns an empty array for a falsy host or non-array input', () => {
        const { items } = makeLoadout();
        expect(directChildrenOf(null, items)).toEqual([]);
        expect(directChildrenOf('comp-arm', undefined)).toEqual([]);
        expect(directChildrenOf('comp-arm', 'not-an-array')).toEqual([]);
    });

    it('does not mutate the input array', () => {
        const { items } = makeLoadout();
        const before = JSON.stringify(items);
        directChildrenOf('comp-arm', items);
        directChildrenOf('item-t1', items);
        expect(JSON.stringify(items)).toBe(before);
    });
});

// --- escapeHtml ----------------------------------------------------------------

describe('ItemTree.escapeHtml', () => {
    it('escapes the five HTML special characters', () => {
        const input = "a & b < c > d \" e ' f";
        // Build the expected entities from code points (not literal entities) so
        // the source is immune to entity decoding; mirrors ItemTree's ESCAPE_MAP.
        const amp = String.fromCodePoint(38); // the & character
        const expected =
            'a ' + amp + 'amp; b ' + amp + 'lt; c ' + amp + 'gt; d ' +
            amp + 'quot; e ' + amp + '#39; f';
        expect(escapeHtml(input)).toBe(expected);
    });

    it('returns an empty string for null / undefined', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

// --- getEquippedItemIds --------------------------------------------------------

describe('ComponentViewer.getEquippedItemIds', () => {
    it('collects the equipped item ids into a Set', () => {
        const { equipped } = makeLoadout();
        const ids = getEquippedItemIds({ equipped });
        expect(ids).toBeInstanceOf(Set);
        expect([...ids].sort()).toEqual(['item-knife1', 'item-t1']);
    });

    it('skips malformed entries and those without an itemId', () => {
        const ids = getEquippedItemIds({
            equipped: [null, { itemId: 'a' }, {}, { slot: 'no-id-here' }, { itemId: 'b' }],
        });
        expect([...ids].sort()).toEqual(['a', 'b']);
    });

    it('returns an empty Set for a missing entity or equipped array', () => {
        expect(getEquippedItemIds(null).size).toBe(0);
        expect(getEquippedItemIds({}).size).toBe(0);
        expect(getEquippedItemIds({ equipped: null }).size).toBe(0);
    });
});

// --- renderHostedItemsHtml -----------------------------------------------------

describe('ComponentViewer.renderHostedItemsHtml', () => {
    it('renders only the items hosted on the requested component (host grouping)', () => {
        const { items, equipped } = makeLoadout();
        const equippedIds = getEquippedItemIds({ equipped });
        const html = renderHostedItemsHtml(items, 'comp-arm', equippedIds);

        // The two comp-arm items render...
        expect(html).toContain('data-cv-item="item-t1"');
        expect(html).toContain('data-cv-item="item-knife1"');
        // ...and the item hosted on a different component does NOT leak in.
        expect(html).not.toContain('data-cv-item="item-boot"');
        // Nested children (hosted on the item, not the component) render too.
        expect(html).toContain('data-cv-item="k1"');
        expect(html).toContain('data-cv-item="k2"');
    });

    it('scopes a different component to only that component\'s items', () => {
        const { items, equipped } = makeLoadout();
        const equippedIds = getEquippedItemIds({ equipped });
        const html = renderHostedItemsHtml(items, 'comp-leg', equippedIds);

        expect(html).toContain('data-cv-item="item-boot"');
        expect(html).not.toContain('data-cv-item="item-t1"');
    });

    it('marks equipped items with the equipped class and sword prefix', () => {
        const { items, equipped } = makeLoadout();
        const equippedIds = getEquippedItemIds({ equipped });
        const html = renderHostedItemsHtml(items, 'comp-arm', equippedIds);

        expect(html).toMatch(/class="cv-item cv-item-equipped"/);
        expect(html).toContain('⚔️ ');
    });

    it('renders nested container contents in a children block', () => {
        const { items, equipped } = makeLoadout();
        const equippedIds = getEquippedItemIds({ equipped });
        const html = renderHostedItemsHtml(items, 'comp-arm', equippedIds);

        expect(html).toContain('class="cv-item-children"');
        // Nested rows carry the nested marker and are not marked equipped.
        expect(html).toMatch(/cv-item-nested/);
    });

    it('accepts equipped ids as a plain array (not just a Set)', () => {
        const { items } = makeLoadout();
        const html = renderHostedItemsHtml(items, 'comp-arm', ['item-t1']);
        expect(html).toMatch(/class="cv-item cv-item-equipped"/);
    });

    it('returns an empty string when the host carries no items', () => {
        const { items } = makeLoadout();
        expect(renderHostedItemsHtml(items, 'comp-thigh', new Set())).toBe('');
    });

    it('returns an empty string for a non-array items input', () => {
        expect(renderHostedItemsHtml(null, 'comp-arm', new Set())).toBe('');
        expect(renderHostedItemsHtml(undefined, 'comp-arm', new Set())).toBe('');
    });

    it('renders "unknown" for items with no name/type and never throws', () => {
        const items = [makeItem('mystery', undefined, undefined, 'comp-arm')];
        const html = renderHostedItemsHtml(items, 'comp-arm', new Set());
        expect(html).toContain('data-cv-item="mystery"');
        expect(html).toContain('unknown');
    });

    it('escapes HTML special characters in item names', () => {
        const items = [makeItem('xss', '<img src=x onerror=alert(1)>', 'gadget', 'comp-arm')];
        const html = renderHostedItemsHtml(items, 'comp-arm', new Set());
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
        expect(html).toContain(escapeHtml('<img src=x onerror=alert(1)>'));
    });

    it('never mutates the shared items array or item instances', () => {
        const { items, equipped } = makeLoadout();
        const before = JSON.stringify(items);
        const equippedIds = getEquippedItemIds({ equipped });
        // Render every host, including a nested container, to exercise the full path.
        renderHostedItemsHtml(items, 'comp-arm', equippedIds);
        renderHostedItemsHtml(items, 'comp-leg', equippedIds);
        expect(JSON.stringify(items)).toBe(before);
        // The flat model must not gain a synthetic `children` property.
        for (const item of items) {
            expect(item).not.toHaveProperty('children');
        }
    });

    it('terminates on cyclic host data (bounded by the nesting depth cap) without throwing', () => {
        // Pathological data: the flat items form a host cycle (a -> b -> a)
        // reachable from the component; only the depth cap bounds the render.
        const items = [
            makeItem('a', 'A', 'gadget', 'comp-arm'),
            makeItem('b', 'B', 'gadget', 'a'),
            makeItem('a', 'A-again', 'gadget', 'b'), // duplicate id closes the cycle
        ];
        const html = renderHostedItemsHtml(items, 'comp-arm', new Set());
        expect(typeof html).toBe('string');
        expect(html).toContain('data-cv-item="a"');
        expect(html).toContain('data-cv-item="b"');
        expect(html.length).toBeLessThan(10000); // bounded output, not runaway recursion
    });

    it('skips null elements and items without an id and never throws', () => {
        const items = [
            null,
            { name: 'no-id', hostComponentId: 'comp-arm' },
            makeItem('ok', 'OK', 'gadget', 'comp-arm'),
        ];
        const html = renderHostedItemsHtml(items, 'comp-arm', new Set());
        expect(html).toContain('data-cv-item="ok"');
        expect(html).not.toContain('no-id');
        // A host whose only rows are malformed yields an empty list container.
        expect(renderHostedItemsHtml([null, { name: 'no-id', hostComponentId: 'comp-x' }], 'comp-x', new Set()))
            .toBe('<div class="cv-items"></div>');
    });

    it('marks an equipped nested item with both the equipped and nested classes', () => {
        const items = [
            makeItem('t1', 'T1', 'weapon', 'comp-arm'),
            makeItem('k1', 'Knife', 'knife', 't1'),
        ];
        const html = renderHostedItemsHtml(items, 'comp-arm', new Set(['k1']));
        expect(html).toMatch(/class="cv-item cv-item-equipped cv-item-nested"/);
    });

    it('accepts a non-array/non-Set equippedItemIds (e.g. null) without throwing', () => {
        const { items } = makeLoadout();
        const html = renderHostedItemsHtml(items, 'comp-arm', null);
        expect(html).toContain('data-cv-item="item-t1"');
        expect(html).not.toContain('cv-item-equipped');
    });
});

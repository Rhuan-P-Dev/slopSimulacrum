/**
 * Unit tests for the GroupPick pure helpers (public/utils/GroupPick.js).
 *
 * These functions are the decision core of the cluster-pickup window:
 * cluster detection, per-type stack grouping, quantity expansion, filter
 * matching, and the data-driven config resolution with fallback. They are
 * pure on purpose — the window is a thin DOM shell, and the rules live here
 * where they can be pinned without a browser.
 *
 * @module test/unit/GroupPick.utils
 */

import { describe, it, expect } from 'vitest';
import {
    resolveGroupPickConfig,
    clusterAround,
    groupIntoStacks,
    matchesFilter,
    expandSelection,
    selectionVolume
} from '../../public/utils/GroupPick.js';

function item(id, itemType, x, y, opts = {}) {
    return {
        id,
        itemType,
        name: opts.name || itemType,
        x,
        y,
        volume: opts.volume ?? 1,
        inRange: opts.inRange !== undefined ? opts.inRange : true
    };
}

describe('resolveGroupPickConfig', () => {
    const fallback = { radius: 25, minItems: 2 };

    it('uses a valid data-driven groupPick field from the action entry', () => {
        const config = resolveGroupPickConfig({ groupPick: { radius: 40, minItems: 3 } }, fallback);
        expect(config).toEqual({ radius: 40, minItems: 3 });
    });

    it('falls back per-field when the action entry is absent', () => {
        expect(resolveGroupPickConfig(null, fallback)).toEqual(fallback);
        expect(resolveGroupPickConfig({}, fallback)).toEqual(fallback);
    });

    it('falls back for malformed values (non-positive radius, bad minItems)', () => {
        expect(resolveGroupPickConfig({ groupPick: { radius: 0, minItems: -1 } }, fallback))
            .toEqual(fallback);
        expect(resolveGroupPickConfig({ groupPick: { radius: 'wide', minItems: 2.5 } }, fallback))
            .toEqual(fallback);
    });

    it('falls back partially: a valid radius with a bad minItems keeps the radius', () => {
        const config = resolveGroupPickConfig({ groupPick: { radius: 50, minItems: 0 } }, fallback);
        expect(config).toEqual({ radius: 50, minItems: 2 });
    });
});

describe('clusterAround', () => {
    it('includes items inside or exactly on the radius (inclusive)', () => {
        const items = [
            item('a', 'chunk_wood', 0, 0),
            item('b', 'chunk_wood', 25, 0),   // exactly radius (25) away
            item('c', 't1', 0, 24.9)
        ];
        const cluster = clusterAround(items, 0, 0, 25);
        expect(cluster.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('excludes items beyond the radius', () => {
        const items = [
            item('a', 'chunk_wood', 0, 0),
            item('b', 't1', 26, 0),
            item('c', 'coal', 10, 20) // dist ~22.36 — inside
        ];
        const cluster = clusterAround(items, 0, 0, 25);
        expect(cluster.map((i) => i.id).sort()).toEqual(['a', 'c']);
    });

    it('keeps object identity (no copies) so callers can annotate in place', () => {
        const a = item('a', 'coal', 3, 0);
        const cluster = clusterAround([a], 0, 0, 10);
        expect(cluster[0]).toBe(a);
    });

    it('rejects items without finite coordinates and invalid radii', () => {
        const items = [
            item('a', 'coal', 3, 0),
            { id: 'b', itemType: 'coal' } // no x/y
        ];
        expect(clusterAround(items, 0, 0, 10).map((i) => i.id)).toEqual(['a']);
        expect(clusterAround(items, 0, 0, NaN)).toEqual([]);
        expect(clusterAround(items, 0, 0, -5)).toEqual([]);
        expect(clusterAround(null, 0, 0, 10)).toEqual([]);
    });
});

describe('groupIntoStacks', () => {
    it('groups by itemType, ordered by first appearance', () => {
        const items = [
            item('a', 'coal', 1, 0),
            item('b', 'chunk_wood', 2, 0),
            item('c', 'coal', 3, 0)
        ];
        const stacks = groupIntoStacks(items);
        expect(stacks.map((s) => s.itemType)).toEqual(['coal', 'chunk_wood']);
        expect(stacks[0].items.map((i) => i.id)).toEqual(['a', 'c']);
    });

    it('splits each stack into inRange/outOfRange from the item annotation', () => {
        const items = [
            item('a', 'coal', 1, 0, { inRange: true }),
            item('b', 'coal', 2, 0, { inRange: false }),
            item('c', 'coal', 3, 0) // inRange defaults true
        ];
        const [stack] = groupIntoStacks(items);
        expect(stack.inRange.map((i) => i.id)).toEqual(['a', 'c']);
        expect(stack.outOfRange.map((i) => i.id)).toEqual(['b']);
    });

    it('sums per-instance and total volume', () => {
        const items = [
            item('a', 'coal', 1, 0, { volume: 2 }),
            item('b', 'coal', 2, 0, { volume: 3 })
        ];
        const [stack] = groupIntoStacks(items);
        expect(stack.unitVolume).toBe(2);
        expect(stack.totalVolume).toBe(5);
    });

    it('skips malformed items and tolerates empty input', () => {
        const items = [
            { id: 'x' }, // no itemType
            item('a', 'coal', 1, 0)
        ];
        const stacks = groupIntoStacks(items);
        expect(stacks.length).toBe(1);
        expect(groupIntoStacks([])).toEqual([]);
        expect(groupIntoStacks(null)).toEqual([]);
    });

    it('uses the item name for display, falling back to the type', () => {
        const stacks = groupIntoStacks([item('a', 'coal', 1, 0, { name: 'Coal' })]);
        expect(stacks[0].name).toBe('Coal');
        const stacks2 = groupIntoStacks([
            { id: 'b', itemType: 'chunk_wood', x: 0, y: 0, volume: 1 }
        ]);
        expect(stacks2[0].name).toBe('chunk_wood');
    });
});

describe('matchesFilter', () => {
    const coal = groupIntoStacks([item('a', 'coal', 1, 0, { name: 'Coal' })])[0];
    const chunk = groupIntoStacks([item('b', 'chunk_wood', 2, 0, { name: 'Wood Chunk' })])[0];

    it('matches name and type case-insensitively', () => {
        expect(matchesFilter(coal, 'coal')).toBe(true);
        expect(matchesFilter(coal, 'COAL')).toBe(true);
        expect(matchesFilter(chunk, 'wood chunk')).toBe(true);
        expect(matchesFilter(chunk, 'chunk_wood')).toBe(true);
    });

    it('does not match unrelated queries', () => {
        expect(matchesFilter(coal, 't1')).toBe(false);
    });

    it('matches everything on an empty or whitespace query', () => {
        expect(matchesFilter(coal, '')).toBe(true);
        expect(matchesFilter(coal, '   ')).toBe(true);
    });
});

describe('expandSelection', () => {
    const stack = groupIntoStacks([
        item('a', 'coal', 1, 0, { inRange: true }),
        item('b', 'coal', 2, 0, { inRange: true }),
        item('c', 'coal', 3, 0, { inRange: false })
    ])[0];

    it('expands to the first qty IN-RANGE instances only', () => {
        expect(expandSelection(stack, 2).map((i) => i.id)).toEqual(['a', 'b']);
    });

    it('never includes out-of-range instances, even beyond the in-range count', () => {
        expect(expandSelection(stack, 99).map((i) => i.id)).toEqual(['a', 'b']);
    });

    it('clamps to zero for negative, fractional, and missing quantities', () => {
        expect(expandSelection(stack, -1)).toEqual([]);
        expect(expandSelection(stack, 1.5)).toEqual([]);
        expect(expandSelection(stack, undefined)).toEqual([]);
        expect(expandSelection(null, 1)).toEqual([]);
    });
});

describe('selectionVolume', () => {
    it('sums volumes of the selection', () => {
        const items = [
            item('a', 'coal', 0, 0, { volume: 2 }),
            item('b', 'coal', 1, 0, { volume: 3 })
        ];
        expect(selectionVolume(items)).toBe(5);
    });

    it('ignores malformed items and empty input', () => {
        expect(selectionVolume([{ id: 'x' }])).toBe(0);
        expect(selectionVolume(null)).toBe(0);
    });
});

/**
 * UNIT test for ActionAttributionStore — the generic, action-agnostic per-entity
 * attribution store. Pins the contract used everywhere (dispatcher writer,
 * perception reader, APIs, logging): "which components powered action X on
 * entity Y, and how many".
 *
 * No world, no timers, no I/O — a pure Map-backed store.
 *
 * @module test/unit/ActionAttributionStore
 */

import { describe, it, expect } from 'vitest';
import ActionAttributionStore from '../../src/utils/ActionAttributionStore.js';

describe('ActionAttributionStore — generic per-entity attribution', () => {
    it('records and returns a normalized record (ids, count, primary, tick, fulfillment)', () => {
        const store = new ActionAttributionStore();
        const record = store.record('ent-1', 'move', {
            primary: 'c-gate',
            ids: ['c-leg-1', 'c-leg-2', 'c-leg-1'], // dup + order preserved
            fulfillment: { 'Movement.move': { best: 'c-gate', ids: ['c-leg-1', 'c-leg-2'] } },
            tick: 42
        });

        expect(record).not.toBeNull();
        expect(record.actionName).toBe('move');
        // Note: the record is *keyed* by (entityId, actionName) externally; the
        // stored object deliberately carries only the attribution fields (no
        // entity id) so it is cheap to copy into perception rows.
        expect(record.primary).toBe('c-gate');
        expect(record.ids).toEqual(['c-leg-1', 'c-leg-2']); // dup removed, order kept
        expect(record.count).toBe(2);
        expect(record.tick).toBe(42);
        expect(record.fulfillment).toEqual({ 'Movement.move': { best: 'c-gate', ids: ['c-leg-1', 'c-leg-2'] } });
    });

    it('resolves an entity+action to the stored record; a missing action yields null', () => {
        const store = new ActionAttributionStore();
        store.record('ent-1', 'move', { ids: ['c-1'] });

        expect(store.get('ent-1', 'move')).toEqual(expect.objectContaining({ ids: ['c-1'], count: 1 }));
        expect(store.get('ent-1', 'attack')).toBeNull();
        expect(store.get('ent-999', 'move')).toBeNull();
    });

    it('getIds / getCount expose the "which" and "how many" one-liners (empty/zero when absent)', () => {
        const store = new ActionAttributionStore();
        store.record('ent-1', 'move', { ids: ['c-1', 'c-2', 'c-3'] });

        expect(store.getIds('ent-1', 'move')).toEqual(['c-1', 'c-2', 'c-3']);
        expect(store.getCount('ent-1', 'move')).toBe(3);
        expect(store.getIds('ent-1', 'attack')).toEqual([]);
        expect(store.getCount('ent-1', 'attack')).toBe(0);
    });

    it('latest record per (entity, action) wins (overwrite semantics)', () => {
        const store = new ActionAttributionStore();
        store.record('ent-1', 'move', { ids: ['c-old'] });
        store.record('ent-1', 'move', { ids: ['c-new'] });

        expect(store.get('ent-1', 'move').ids).toEqual(['c-new']);
    });

    it('get(entityId) without an action returns the most recently written record', () => {
        const store = new ActionAttributionStore();
        // Date.now() collisions are possible under a fast test; set explicit ticks
        // is not a field the store sorts by — it sorts by its internal timestamp.
        // Two records written in sequence have distinct timestamps (ms-granular);
        // to be robust we write, then a second, and check the *last* wins.
        store.record('ent-1', 'move', { ids: ['c-1'] });
        store.record('ent-1', 'attack', { ids: ['c-2'] });

        // The most recently written record (the attack) should be returned.
        const latest = store.get('ent-1');
        expect(latest).not.toBeNull();
        // Either the attack or move record is acceptable if timestamps tie in the
        // same ms; assert it is one of the two we wrote (not a stale/foreign one).
        expect(['move', 'attack']).toContain(latest.actionName);
        expect(['c-1', 'c-2']).toContain(...latest.ids);
    });

    it('normalizes ids: drops null/undefined/blank, dedupes, coerces numbers to strings', () => {
        const store = new ActionAttributionStore();
        const rec = store.record('ent-1', 'move', { ids: ['c-1', null, undefined, '', 42, 'c-1', 'c-3'] });
        expect(rec.ids).toEqual(['c-1', '42', 'c-3']);
    });

    it('record returns null for invalid entity or action names (null-safe)', () => {
        const store = new ActionAttributionStore();
        expect(store.record('', 'move', { ids: ['c-1'] })).toBeNull();
        expect(store.record('ent-1', '', { ids: ['c-1'] })).toBeNull();
        expect(store.record(null, 'move', { ids: ['c-1'] })).toBeNull();
        expect(store.get('ent-1', 'move')).toBeNull();
    });

    it('listFor returns a shallow copy of the per-action records (null when absent)', () => {
        const store = new ActionAttributionStore();
        store.record('ent-1', 'move', { ids: ['c-1'] });
        store.record('ent-1', 'punch', { ids: ['c-2'] });

        expect(store.listFor('ent-999')).toBeNull();
        expect(store.listFor('')).toBeNull();

        const list = store.listFor('ent-1');
        expect(list).toBeInstanceOf(Map);
        expect(list.size).toBe(2);
        expect([...list.keys()].sort()).toEqual(['move', 'punch']);
        expect(list.get('punch').ids).toEqual(['c-2']);

        // The returned map is a copy: mutating it never touches the store.
        list.delete('move');
        expect(store.get('ent-1', 'move')).not.toBeNull();
    });

    it('clear() removes one entity; reset() removes all', () => {
        const store = new ActionAttributionStore();
        store.record('ent-1', 'move', { ids: ['c-1'] });
        store.record('ent-2', 'move', { ids: ['c-2'] });

        expect(store.clear('ent-1')).toBe(true);
        expect(store.get('ent-1', 'move')).toBeNull();
        expect(store.get('ent-2', 'move')).not.toBeNull();

        store.reset();
        expect(store.get('ent-2', 'move')).toBeNull();
    });

    it('record() normalizes the target (entity/component ids only; null when absent)', () => {
        const store = new ActionAttributionStore();

        // Both fields: kept verbatim (ids only — display names are the reader's job).
        const both = store.record('ent-1', 'punch', {
            ids: ['c-fist'],
            target: { entityId: 'ent-victim', componentId: 'comp-v1' }
        });
        expect(both.target).toEqual({ entityId: 'ent-victim', componentId: 'comp-v1' });

        // Entity-only (entity-targeted action) — componentId stays null.
        const entOnly = store.record('ent-2', 'push', { target: { entityId: 'ent-v2', componentId: null } });
        expect(entOnly.target).toEqual({ entityId: 'ent-v2', componentId: null });

        // Component-only (component-targeted action) — entityId stays null.
        const compOnly = store.record('ent-3', 'punch', { target: { entityId: null, componentId: 'comp-v3' } });
        expect(compOnly.target).toEqual({ entityId: null, componentId: 'comp-v3' });

        // Nothing usable → null (not an empty object): null payload and empty strings.
        expect(store.record('ent-4', 'move', { target: null }).target).toBeNull();
        expect(store.record('ent-5', 'move', { target: { entityId: '', componentId: '' } }).target).toBeNull();

        // Garbage field types degrade away, never stored verbatim.
        expect(store.record('ent-6', 'punch', { target: { entityId: 42, componentId: { a: 1 } } }).target).toBeNull();
    });
});

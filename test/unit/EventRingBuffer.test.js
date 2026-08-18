/**
 * EventRingBuffer unit tests (Feature B, spec §4.1 / §9).
 *
 * Covers: capacity/eviction (oldest dropped beyond the cap), getRecent
 * ordering (oldest → newest), defensive copies on read, clear, and
 * serialize/restore round-trip including over-capacity restore.
 *
 * @module test/unit/EventRingBuffer
 */

import { describe, it, expect } from 'vitest';
import EventRingBuffer from '../../src/utils/EventRingBuffer.js';

function makeEntry(i) {
    return { tick: i, action: 'test', targetId: null, message: `event ${i}`, level: 'info', ts: i };
}

describe('EventRingBuffer', () => {
    it('validates capacity in the constructor', () => {
        expect(() => new EventRingBuffer(0)).toThrow(TypeError);
        expect(() => new EventRingBuffer(-1)).toThrow(TypeError);
        expect(() => new EventRingBuffer(1.5)).toThrow(TypeError);
        expect(new EventRingBuffer()._capacity).toBe(50); // default applied
        expect(new EventRingBuffer(5)._capacity).toBe(5);
    });

    it('defaults to capacity 50 and starts empty', () => {
        const buffer = new EventRingBuffer();
        expect(buffer.getAll()).toEqual([]);
        expect(buffer.getRecent(20)).toEqual([]);
    });

    it('stores entries in push order (oldest → newest)', () => {
        const buffer = new EventRingBuffer(10);
        buffer.push(makeEntry(1));
        buffer.push(makeEntry(2));
        buffer.push(makeEntry(3));
        expect(buffer.getAll().map(e => e.tick)).toEqual([1, 2, 3]);
    });

    it('evicts the oldest entry beyond the capacity', () => {
        const buffer = new EventRingBuffer(50);
        for (let i = 1; i <= 60; i++) buffer.push(makeEntry(i));
        const all = buffer.getAll();
        expect(all).toHaveLength(50);
        expect(all[0].tick).toBe(11);   // oldest evicted: 1..10
        expect(all[49].tick).toBe(60);  // newest kept
    });

    it('keeps exactly the newest 50 after 100 pushes', () => {
        const buffer = new EventRingBuffer(50);
        for (let i = 1; i <= 100; i++) buffer.push(makeEntry(i));
        const ticks = buffer.getAll().map(e => e.tick);
        expect(ticks).toEqual(Array.from({ length: 50 }, (_, i) => i + 51));
    });

    it('getRecent returns the last N entries, oldest → newest', () => {
        const buffer = new EventRingBuffer(10);
        for (let i = 1; i <= 5; i++) buffer.push(makeEntry(i));
        expect(buffer.getRecent(2).map(e => e.tick)).toEqual([4, 5]);
        expect(buffer.getRecent(0)).toEqual([]);
        // limit larger than the buffer → everything
        expect(buffer.getRecent(99).map(e => e.tick)).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns defensive copies — mutating a read result never touches the buffer', () => {
        const buffer = new EventRingBuffer(5);
        buffer.push(makeEntry(1));
        const read = buffer.getAll();
        read[0].message = 'MUTATED';
        read[0].injected = true;
        expect(buffer.getAll()[0].message).toBe('event 1');
        expect(buffer.getAll()[0].injected).toBeUndefined();
    });

    it('rejects non-object entries and invalid limits', () => {
        const buffer = new EventRingBuffer(5);
        expect(() => buffer.push(null)).toThrow(TypeError);
        expect(() => buffer.push('string')).toThrow(TypeError);
        expect(() => buffer.getRecent(-1)).toThrow(TypeError);
    });

    it('clear() removes all entries', () => {
        const buffer = new EventRingBuffer(5);
        buffer.push(makeEntry(1));
        buffer.push(makeEntry(2));
        buffer.clear();
        expect(buffer.getAll()).toEqual([]);
        buffer.push(makeEntry(3));
        expect(buffer.getAll().map(e => e.tick)).toEqual([3]);
    });

    it('serialize/restore round-trips entries', () => {
        const buffer = new EventRingBuffer(10);
        buffer.push(makeEntry(1));
        buffer.push(makeEntry(2));
        const serialized = buffer.serialize();
        expect(serialized).toEqual([makeEntry(1), makeEntry(2)]);

        const other = new EventRingBuffer(10);
        other.restore(serialized);
        expect(other.getAll()).toEqual([makeEntry(1), makeEntry(2)]);

        // restore is defensive: mutating the serialized input later is a no-op
        serialized[0].message = 'MUTATED';
        expect(other.getAll()[0].message).toBe('event 1');
    });

    it('restore keeps only the newest `capacity` entries and tolerates garbage', () => {
        const buffer = new EventRingBuffer(3);
        buffer.restore([makeEntry(1), makeEntry(2), makeEntry(3), makeEntry(4), makeEntry(5)]);
        expect(buffer.getAll().map(e => e.tick)).toEqual([3, 4, 5]);
        buffer.restore(null);
        expect(buffer.getAll()).toEqual([]);
    });
});

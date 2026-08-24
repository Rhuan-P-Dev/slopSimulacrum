/**
 * DropItemHandler — unit tests for writeDroppedItem defensive gaps (B3#7).
 *
 * Tests the three fixes:
 *  A. Falsy itemType guard → Logger.warn + no dropped-item entry
 *  B. roomId nullish default → 'unassigned'
 *  C. volume nullish semantics → preserves 0
 *  D. Happy-path normal write
 *
 * @module test/unit/DropItemHandler
 */

import { describe, it, expect, vi } from 'vitest';
import { writeDroppedItem } from '../../src/controllers/consequences/DropItemHandler.js';
import Logger from '../../src/utils/Logger.js';

// =========================================================================
// Helpers
// =========================================================================

/**
 * Build a minimal narrow-deps stub matching the JSDoc contract:
 *   getDroppedItems() → object (the map)
 *   setDroppedItems(items) → merges via Object.assign into the internal map
 */
function buildNarrowDeps() {
    const map = {};
    const deps = {
        getDroppedItems: () => map,
        setDroppedItems: (items) => { Object.assign(map, items); }
    };
    return { deps, map };
}

const VALID_ITEM_TYPE = 'knife'; // from data/inventoryItems.json convention
const ITEM_DEF = { name: 'Knife', description: 'A sharp knife.', volume: 2 };

// =========================================================================
// Test A — falsy itemType guard
// =========================================================================

describe('writeDroppedItem — B3#7 falsy itemType guard', () => {
    it('calls Logger.warn and adds NO entry when itemType is undefined', () => {
        const spy = vi.spyOn(Logger, 'warn');
        const { deps, map } = buildNarrowDeps();

        writeDroppedItem(deps, undefined, 10, 20, 'room-1', 'entity-1', ITEM_DEF);

        expect(spy).toHaveBeenCalledWith(
            expect.stringContaining('[DropItemHandler] writeDroppedItem called with falsy itemType')
        );
        expect(Object.keys(map)).toHaveLength(0);
        spy.mockRestore();
    });

    it('calls Logger.warn and adds NO entry when itemType is null', () => {
        const spy = vi.spyOn(Logger, 'warn');
        const { deps, map } = buildNarrowDeps();

        writeDroppedItem(deps, null, 10, 20, 'room-1', 'entity-2', ITEM_DEF);

        expect(spy).toHaveBeenCalled();
        expect(Object.keys(map)).toHaveLength(0);
        spy.mockRestore();
    });

    it('calls Logger.warn and adds NO entry when itemType is empty string', () => {
        const spy = vi.spyOn(Logger, 'warn');
        const { deps, map } = buildNarrowDeps();

        writeDroppedItem(deps, '', 10, 20, 'room-1', 'entity-3', ITEM_DEF);

        expect(spy).toHaveBeenCalled();
        expect(Object.keys(map)).toHaveLength(0);
        spy.mockRestore();
    });
});

// =========================================================================
// Test B — roomId nullish default ('unassigned')
// =========================================================================

describe('writeDroppedItem — B3#7 roomId nullish default', () => {
    it('uses "unassigned" when roomId is null', () => {
        const { deps, map } = buildNarrowDeps();

        writeDroppedItem(deps, VALID_ITEM_TYPE, 5, 5, null, 'entity-b', ITEM_DEF);

        const entries = Object.values(map);
        expect(entries).toHaveLength(1);
        expect(entries[0].roomId).toBe('unassigned');
    });

    it('uses "unassigned" when roomId is undefined', () => {
        const { deps, map } = buildNarrowDeps();

        writeDroppedItem(deps, VALID_ITEM_TYPE, 5, 5, undefined, 'entity-b2', ITEM_DEF);

        const entries = Object.values(map);
        expect(entries).toHaveLength(1);
        expect(entries[0].roomId).toBe('unassigned');
    });

    it('keeps the provided roomId when it is a non-nullish string', () => {
        const { deps, map } = buildNarrowDeps();

        writeDroppedItem(deps, VALID_ITEM_TYPE, 5, 5, 'room-42', 'entity-b3', ITEM_DEF);

        const entries = Object.values(map);
        expect(entries).toHaveLength(1);
        expect(entries[0].roomId).toBe('room-42');
    });
});

// =========================================================================
// Test C — volume nullish semantics (preserves 0)
// =========================================================================

describe('writeDroppedItem — B3#7 volume nullish semantics', () => {
    it('keeps volume: 0 when def.volume is explicitly zero', () => {
        const { deps, map } = buildNarrowDeps();
        const defZeroVolume = { name: 'Feather', description: 'Light.', volume: 0 };

        writeDroppedItem(deps, VALID_ITEM_TYPE, 5, 5, 'room-1', 'entity-c', defZeroVolume);

        const entries = Object.values(map);
        expect(entries).toHaveLength(1);
        expect(entries[0].volume).toBe(0);
    });

    it('falls back to 1 when def.volume is null', () => {
        const { deps, map } = buildNarrowDeps();
        const defNullVolume = { name: 'Box', description: 'A box.', volume: null };

        writeDroppedItem(deps, VALID_ITEM_TYPE, 5, 5, 'room-1', 'entity-c2', defNullVolume);

        const entries = Object.values(map);
        expect(entries).toHaveLength(1);
        expect(entries[0].volume).toBe(1);
    });

    it('uses the defined volume when def.volume is a positive number', () => {
        const { deps, map } = buildNarrowDeps();
        const defVolume5 = { name: 'Crate', description: 'A crate.', volume: 5 };

        writeDroppedItem(deps, VALID_ITEM_TYPE, 5, 5, 'room-1', 'entity-c3', defVolume5);

        const entries = Object.values(map);
        expect(entries).toHaveLength(1);
        expect(entries[0].volume).toBe(5);
    });
});

// =========================================================================
// Test D — happy-path normal write
// =========================================================================

describe('writeDroppedItem — happy path', () => {
    it('writes an item with all expected fields when all params are valid', () => {
        const { deps, map } = buildNarrowDeps();
        const x = 12;
        const y = 34;
        const roomId = 'room-happy';
        const ownerId = 'entity-happy';

        const result = writeDroppedItem(deps, VALID_ITEM_TYPE, x, y, roomId, ownerId, ITEM_DEF);

        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('droppedItemId');

        const entries = Object.values(map);
        expect(entries).toHaveLength(1);
        const item = entries[0];

        expect(item.itemType).toBe(VALID_ITEM_TYPE);
        expect(item.x).toBe(x);
        expect(item.y).toBe(y);
        expect(item.roomId).toBe(roomId);
        expect(item.ownerId).toBe(ownerId);
        expect(item.name).toBe(ITEM_DEF.name);
        expect(item.description).toBe(ITEM_DEF.description);
        expect(item.volume).toBe(ITEM_DEF.volume);
        expect(Array.isArray(item.nestedItems)).toBe(true);
        expect(item.nestedItems).toHaveLength(0);
    });
});

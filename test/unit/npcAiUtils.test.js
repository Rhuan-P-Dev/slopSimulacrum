/**
 * npcAiUtils unit tests — edge cases for `hasDeterministicBrain` and the
 * craft_loop configuration constants / `findNearestDroppedItem` helper.
 *
 * Mirrors the existing M3 edge-case set from test/unit/NpcAIController.test.js
 * so the predicate behaves identically when called directly from the util.
 *
 * @module test/unit/npcAiUtils
 */

import { describe, it, expect } from 'vitest';
import DataLoader from '../../src/utils/DataLoader.js';
import {
    hasDeterministicBrain,
    findNearestDroppedItem,
    PICK_RANGE,
    RECIPE_ID,
    TARGET_ITEM_TYPE,
    CRAFT_OUTPUT_TYPE
} from '../../src/utils/npcAiUtils.js';

describe('hasDeterministicBrain (npcAiUtils)', () => {
    it('true — entity with valid ai.behavior string', () => {
        const entity = { npcConfig: { ai: { behavior: 'chase_attack' } } };
        expect(hasDeterministicBrain(entity)).toBe(true);
    });

    it('false — behavior is empty string', () => {
        const entity = { npcConfig: { ai: { behavior: '' } } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — ai is null', () => {
        const entity = { npcConfig: { ai: null } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — npcConfig is empty object (no ai)', () => {
        const entity = { npcConfig: {} };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — entity is undefined', () => {
        expect(hasDeterministicBrain(undefined)).toBe(false);
    });

    it('false — entity is empty object', () => {
        expect(hasDeterministicBrain({})).toBe(false);
    });

    it('false — behavior is a number (not a string)', () => {
        const entity = { npcConfig: { ai: { behavior: 123 } } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — behavior is null', () => {
        const entity = { npcConfig: { ai: { behavior: null } } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — npcConfig is undefined', () => {
        const entity = { other: 'data' };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('true — behavior is non-empty string with special characters', () => {
        const entity = { npcConfig: { ai: { behavior: 'chase_attack_v2' } } };
        expect(hasDeterministicBrain(entity)).toBe(true);
    });
});

describe('craft_loop configuration constants (npcAiUtils)', () => {
    it('exposes the pickup range, recipe id, and item types used by the behavior', () => {
        // Keep-in-sync contract (PICK_RANGE JSDoc / spec R9): PICK_RANGE must
        // equal the dropItem range in the shared data file — the value
        // PickUpItemHandler.maxRange mirrors. Asserting against the data
        // source (not a literal) makes drift fail here, not in the wild.
        const actions = DataLoader.loadJsonSafe('data/actions.json', {});
        expect(PICK_RANGE).toBe(actions.dropItem?.range);
        expect(RECIPE_ID).toBe('single_knife_to_t1');
        expect(TARGET_ITEM_TYPE).toBe('knife');
        expect(CRAFT_OUTPUT_TYPE).toBe('t1');
    });
});

describe('findNearestDroppedItem (npcAiUtils)', () => {
    const ROOM_A = 'room-a';
    const ROOM_B = 'room-b';

    it('returns the nearest in-room item and reports its distance', () => {
        const items = [
            { id: 'far', itemType: 'knife', roomId: ROOM_A, x: 150, y: 0 },
            { id: 'near', itemType: 'knife', roomId: ROOM_A, x: 30, y: 40 } // dist 50
        ];
        const result = findNearestDroppedItem(items, ROOM_A, 0, 0);
        expect(result).not.toBeNull();
        expect(result.item.id).toBe('near');
        expect(result.distance).toBeCloseTo(50, 5);
    });

    it('returns the nearer of two items (distance 100 vs 101) and reports the distance', () => {
        const items = [
            { id: 'at100', itemType: 'knife', roomId: ROOM_A, x: 100, y: 0 },
            { id: 'beyond', itemType: 'knife', roomId: ROOM_A, x: 0, y: 101 }
        ];
        const result = findNearestDroppedItem(items, ROOM_A, 0, 0);
        expect(result).not.toBeNull();
        expect(result.item.id).toBe('at100');
        expect(result.distance).toBeCloseTo(100, 5);
    });

    it('ignores items from other rooms', () => {
        const items = [
            { id: 'other-room', itemType: 'knife', roomId: ROOM_B, x: 1, y: 0 },
            { id: 'this-room', itemType: 'knife', roomId: ROOM_A, x: 50, y: 0 }
        ];
        const result = findNearestDroppedItem(items, ROOM_A, 0, 0);
        expect(result).not.toBeNull();
        expect(result.item.id).toBe('this-room');
    });

    it('breaks distance ties deterministically by ascending id', () => {
        const items = [
            { id: 'b-tie', itemType: 'knife', roomId: ROOM_A, x: -30, y: 40 }, // dist 50
            { id: 'a-tie', itemType: 'knife', roomId: ROOM_A, x: 30, y: 40 }   // dist 50
        ];
        const result = findNearestDroppedItem(items, ROOM_A, 0, 0);
        expect(result).not.toBeNull();
        expect(result.item.id).toBe('a-tie');
    });

    it('skips entries with non-finite coordinates', () => {
        const items = [
            { id: 'bad-x', itemType: 'knife', roomId: ROOM_A, x: NaN, y: 0 },
            { id: 'bad-y', itemType: 'knife', roomId: ROOM_A, x: 10, y: undefined },
            { id: 'good', itemType: 'knife', roomId: ROOM_A, x: 20, y: 0 }
        ];
        const result = findNearestDroppedItem(items, ROOM_A, 0, 0);
        expect(result).not.toBeNull();
        expect(result.item.id).toBe('good');
    });

    it('returns null for empty / null / non-array input', () => {
        expect(findNearestDroppedItem([], ROOM_A, 0, 0)).toBeNull();
        expect(findNearestDroppedItem(null, ROOM_A, 0, 0)).toBeNull();
        expect(findNearestDroppedItem(undefined, ROOM_A, 0, 0)).toBeNull();
        expect(findNearestDroppedItem('nope', ROOM_A, 0, 0)).toBeNull();
    });

    it('returns null when the searcher has non-finite coordinates', () => {
        const items = [{ id: 'near', itemType: 'knife', roomId: ROOM_A, x: 5, y: 0 }];
        expect(findNearestDroppedItem(items, ROOM_A, NaN, 0)).toBeNull();
        expect(findNearestDroppedItem(items, ROOM_A, 0, Infinity)).toBeNull();
    });

    it('returns the nearest item even far away (no range limit in the helper)', () => {
        const items = [{ id: 'far', itemType: 'knife', roomId: ROOM_A, x: 5000, y: 0 }];
        const result = findNearestDroppedItem(items, ROOM_A, 0, 0);
        expect(result).not.toBeNull();
        expect(result.item.id).toBe('far');
    });
});

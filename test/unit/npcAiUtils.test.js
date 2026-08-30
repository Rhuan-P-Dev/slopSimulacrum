/**
 * npcAiUtils unit tests — edge cases for `hasDeterministicBrain`, the
 * craft_loop configuration constants, the data-driven `resolvePickUpRange`
 * (the brain/handler single source of truth for the pickup range), and the
 * `findNearestDroppedItem` helper.
 *
 * Mirrors the existing M3 edge-case set from test/unit/NpcAIController.test.js
 * so the predicate behaves identically when called directly from the util.
 *
 * @module test/unit/npcAiUtils
 */

import { describe, it, expect } from 'vitest';
import DataLoader from '../../src/utils/DataLoader.js';
import { PICK_UP_RANGE_FALLBACK } from '../../src/utils/Constants.js';
import {
    hasDeterministicBrain,
    findNearestDroppedItem,
    resolvePickUpRange,
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
    it('exposes the recipe id and item types used by the behavior', () => {
        expect(RECIPE_ID).toBe('single_knife_to_t1');
        expect(TARGET_ITEM_TYPE).toBe('knife');
        expect(CRAFT_OUTPUT_TYPE).toBe('t1');
    });
});

describe('resolvePickUpRange (npcAiUtils) — single source of truth shared with the handler', () => {
    // The pickup range has exactly one definition: the pickUpItem action in
    // data/actions.json, resolved through the shared RangeResolver with the
    // shared PICK_UP_RANGE_FALLBACK for missing data. The brain and the
    // PickUpItemHandler both resolve through this path, so any drift fails
    // here, not in the wild.
    const actions = DataLoader.loadJsonSafe('data/actions.json', {});
    const ENTITY = { id: 'ent-rng-0001' };

    it('resolves the pickUpItem range from the live action registry (numeric pass-through)', () => {
        const facade = { getActionRegistry: () => actions };
        const resolved = resolvePickUpRange(facade, ENTITY);
        // Same value the PickUpItemHandler validates against.
        expect(resolved).toBe(actions.pickUpItem.range);
        // Data file and shared fallback are in sync today.
        expect(resolved).toBe(PICK_UP_RANGE_FALLBACK);
    });

    it('falls back to PICK_UP_RANGE_FALLBACK when the registry is unavailable or lacks the action/range', () => {
        expect(resolvePickUpRange(null, ENTITY)).toBe(PICK_UP_RANGE_FALLBACK);
        expect(resolvePickUpRange({}, ENTITY)).toBe(PICK_UP_RANGE_FALLBACK);
        expect(resolvePickUpRange({ getActionRegistry: () => ({}) }, ENTITY)).toBe(PICK_UP_RANGE_FALLBACK);
        expect(resolvePickUpRange({ getActionRegistry: () => ({ pickUpItem: {} }) }, ENTITY)).toBe(PICK_UP_RANGE_FALLBACK);
        expect(resolvePickUpRange({ getActionRegistry: () => ({ pickUpItem: { range: '' } }) }, ENTITY)).toBe(PICK_UP_RANGE_FALLBACK);
    });

    it('resolves string expressions through the injected requirement resolver (same path as the handler)', () => {
        const facade = {
            getActionRegistry: () => ({ pickUpItem: { range: ':Physical.strength*2+3' } }),
            actionController: {
                requirementResolver: {
                    resolveEntityRequirementValues: (id) =>
                        (id === ENTITY.id ? { 'Physical.strength': 10 } : {})
                }
            }
        };
        expect(resolvePickUpRange(facade, ENTITY)).toBe(23); // 10*2+3
    });

    it('falls back to PICK_UP_RANGE_FALLBACK when a string expression is unresolvable', () => {
        const facade = {
            getActionRegistry: () => ({ pickUpItem: { range: ':Unknown.stat' } }),
            actionController: {
                requirementResolver: { resolveEntityRequirementValues: () => ({}) }
            }
        };
        expect(resolvePickUpRange(facade, ENTITY)).toBe(PICK_UP_RANGE_FALLBACK);
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

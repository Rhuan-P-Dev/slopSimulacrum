/**
 * Unit tests for src/controllers/logic/ItemStatsLogic.js (extracted from
 * WorldStateController.getItemStats in FASE 7 — plans/FIX-PLAN-2026-09.md T9).
 *
 * The module takes explicit dependencies (no facade), so these tests stub
 * exactly the four objects it reads: stateEntityController, inventoryManager,
 * holdingCostController, equippedItemStats. No world boot.
 *
 * @module test/unit/itemStats.logic
 */

import { describe, it, expect } from 'vitest';
import { resolveItemStats } from '../../src/controllers/logic/ItemStatsLogic.js';

const ENTITY_ID = 'ent-1';

function makeDeps({ entity, item, isEquipped = false, eqMap = null, eqStats = null, holdingCostDef = null }) {
    return {
        stateEntityController: {
            getEntity: (id) => (id === ENTITY_ID ? entity : null)
        },
        inventoryManager: {
            getItem: (ent, itemId) => (ent && itemId === 'item-1' ? item : null)
        },
        holdingCostController: {
            isItemEquipped: () => isEquipped,
            getHoldingCostDefinition: () => holdingCostDef,
            getEquippedItemsByEntity: () => eqMap
        },
        equippedItemStats: eqStats
    };
}

function call(deps, itemId = 'item-1') {
    return resolveItemStats(
        deps.stateEntityController,
        deps.inventoryManager,
        deps.holdingCostController,
        deps.equippedItemStats,
        ENTITY_ID,
        itemId
    );
}

describe('resolveItemStats — lookup guards', () => {
    it('returns null when the entity is not found', () => {
        const deps = makeDeps({ entity: null, item: { id: 'item-1' } });
        expect(call(deps)).toBeNull();
    });

    it('returns null when the item is not in the entity inventory', () => {
        const deps = makeDeps({ entity: {}, item: null });
        expect(call(deps)).toBeNull();
    });
});

describe('resolveItemStats — base stats', () => {
    const item = {
        id: 'item-1',
        type: 'knife',
        name: 'Knife',
        volume: 1,
        traits: {
            Physical: { mass: 4.92, 'max-durability': 100, note: 'ignored non-number' },
            'not-a-category': [1, 2, 3],
            nullish: null
        }
    };

    it('collects numeric trait values from object categories and records the categories', () => {
        const stats = call(makeDeps({ entity: {}, item }));
        expect(stats._itemId).toBe('item-1');
        expect(stats._type).toBe('knife');
        expect(stats._name).toBe('Knife');
        expect(stats._volume).toBe(1);
        expect(stats._isEquipped).toBe(false);
        expect(stats._baseStats).toEqual({ mass: 4.92, 'max-durability': 100 });
        expect(stats._traitCategories).toEqual({ Physical: true });
        // Non-numeric values, array categories and null categories are ignored.
        expect(stats.note).toBeUndefined();
    });

    it('falls back to the type for the name when the item has no name', () => {
        const unnamed = { ...item, name: undefined };
        const stats = call(makeDeps({ entity: {}, item: unnamed }));
        expect(stats._name).toBe('knife');
    });
});

describe('resolveItemStats — equipped dynamics', () => {
    const item = {
        id: 'item-1',
        type: 'knife',
        name: 'Knife',
        volume: 1,
        traits: { Physical: { mass: 4.92 } }
    };
    const eqMap = {
        [ENTITY_ID]: {
            'eq-1': { itemId: 'other', eqId: 'eq-other' },
            'eq-2': { itemId: 'item-1', eqId: 'eq-item-1' }
        }
    };

    it('merges dynamic stats from the equipped entry that matches by itemId', () => {
        const deps = makeDeps({
            entity: {},
            item,
            isEquipped: true,
            eqMap,
            eqStats: { getStats: (eqId) => (eqId === 'eq-item-1' ? { Physical: { sharpness: 0.9 } } : null) }
        });
        const stats = call(deps);
        expect(stats._isEquipped).toBe(true);
        expect(stats._dynamicStats).toEqual({ sharpness: 0.9 });
        expect(stats._dynamicStatCategories).toEqual({ Physical: true });
        // Display merge: base + dynamic flattened onto the result.
        expect(stats.mass).toBe(4.92);
        expect(stats.sharpness).toBe(0.9);
    });

    it('still reports holding-cost requirements when equippedItemStats is absent', () => {
        const deps = makeDeps({
            entity: {},
            item,
            isEquipped: true,
            eqMap,
            eqStats: null,
            holdingCostDef: { holdingCost: [{ trait: 'Physical', stat: 'strength', value: 2 }] }
        });
        const stats = call(deps);
        expect(stats._dynamicStats).toBeUndefined();
        expect(stats._holdingCostRequirements).toEqual([
            { trait: 'Physical', stat: 'strength', value: 2 }
        ]);
    });

    it('does not add dynamic stats or requirements when the item is not equipped', () => {
        const deps = makeDeps({
            entity: {},
            item,
            isEquipped: false,
            eqMap,
            eqStats: { getStats: () => ({ Physical: { sharpness: 0.9 } }) },
            holdingCostDef: { holdingCost: [{ trait: 'Physical', stat: 'strength', value: 2 }] }
        });
        const stats = call(deps);
        expect(stats._isEquipped).toBe(false);
        expect(stats._dynamicStats).toBeUndefined();
        expect(stats._holdingCostRequirements).toBeUndefined();
        expect(stats.sharpness).toBeUndefined();
    });
});

/**
 * InventoryManager (CLIENT) — unit tests for the massBurden equip gate.
 *
 * Covers the client-side half of the "knife cannot be equipped" fix:
 *   1. The Equip/Unequip button is rendered ONLY for items declared in the
 *      holding-cost model's `equipableItems` list (the new massBurden shape),
 *      and NOT for items outside that list.
 *   2. `_formatHoldingCost` renders a data-driven string from the model's
 *      `equipGate` / `carryingCost` (not the removed per-item `holdingCost`).
 *   3. The equipped-items map is keyed by the typed `eqId` (the field the
 *      server sends), so entries do not collapse under the key "undefined".
 *
 * `_renderTreeItems` and `_formatHoldingCost` are pure prototype methods (no
 * DOM, no fetch), so they are exercised with a bare instance. The keying test
 * drives `_loadEquippedItems` with a stubbed `fetch`.
 *
 * @module test/unit/InventoryManager.client
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InventoryManager } from '../../public/js/InventoryManager.js';
import ClientLogger from '../../public/utils/ClientLogger.js';

// Mirrors the shape of data/holdingCost.json (the single massBurden model, not
// the removed per-item map).
const HOLDING_COST_MODEL = {
    model: 'massBurden',
    burdenedStats: [
        { stat: 'move', trait: 'Movement' },
        { stat: 'fine_controls', trait: 'Manipulation' },
    ],
    carryingCost: {
        type: 'linearReduction',
        freeMassAllowance: 10,
        reductionPerUnitMass: 0.03,
        floor: 0.25,
    },
    equipGate: {
        type: 'strengthToMassRatio',
        requiredStrengthPerUnitMass: 1.5,
        allOrNothing: true,
        description: 'The host strength must bear the item mass.',
    },
    equipableItems: ['knife', 't1'],
};

/** A minimal item instance for `_renderTreeItems` (volume below the container cap). */
function item(type, id) {
    return { id, type, name: type, volume: 1, externalVolume: 1 };
}

/** Bare client instance with the massBurden model loaded (no DOM needed). */
function makeManager() {
    const manager = new InventoryManager({}, {}, {});
    manager._holdingCostRegistry = HOLDING_COST_MODEL;
    manager._itemRegistry = {};
    manager._equippedItems = {};
    manager._containerExpanded = {};
    return manager;
}

describe('InventoryManager — massBurden equip-button gate', () => {
    it('renders an Equip button for an item listed in equipableItems', () => {
        const manager = makeManager();
        const html = manager._renderTreeItems('comp-x', [item('knife', 'item-knife')], 0);
        expect(html).toContain('⚔️ Equip');
        expect(html).toContain('data-is-equipped="false"');
    });

    it('does NOT render an Equip button for an item outside equipableItems', () => {
        const manager = makeManager();
        const html = manager._renderTreeItems('comp-x', [item('powerCell', 'item-power')], 0);
        expect(html).not.toContain('⚔️ Equip');
        expect(html).not.toContain('🔓 Unequip');
        expect(html).not.toContain('data-is-equipped');
    });

    it('renders an Unequip button for an equipped equipable item', () => {
        const manager = makeManager();
        manager._equippedItems = {
            'eq-1': { eqId: 'eq-1', itemId: 'item-knife', itemType: 'knife', componentId: 'comp-x' },
        };
        const html = manager._renderTreeItems('comp-x', [item('knife', 'item-knife')], 0);
        expect(html).toContain('🔓 Unequip');
        expect(html).toContain('data-is-equipped="true"');
    });
});

describe('InventoryManager — _formatHoldingCost (massBurden model)', () => {
    it('renders the gate description (single source of display copy) + carrying cost', () => {
        const manager = makeManager();
        const text = manager._formatHoldingCost();
        // The gate's own description is the single source of display copy.
        expect(text).toContain(HOLDING_COST_MODEL.equipGate.description);
        // The burdened stat names come from the model's carrying cost.
        expect(text).toContain('move');
        expect(text).toContain('fine_controls');
    });

    it('falls back to a synthesized gate string when the gate has no description', () => {
        const manager = makeManager();
        manager._holdingCostRegistry = {
            ...HOLDING_COST_MODEL,
            equipGate: {
                type: 'strengthToMassRatio',
                requiredStrengthPerUnitMass: 1.5,
                allOrNothing: true,
            },
        };
        const text = manager._formatHoldingCost();
        // Synthesized from the ratio, stat label from the shared vocabulary.
        expect(text).toContain('strength');
        expect(text).toContain('1.5');
    });

    it('returns an empty string when the registry is absent or malformed', () => {
        const manager = makeManager();
        const withoutRegistry = new InventoryManager({}, {}, {});
        withoutRegistry._holdingCostRegistry = null;
        expect(withoutRegistry._formatHoldingCost()).toBe('');

        manager._holdingCostRegistry = {};
        expect(manager._formatHoldingCost()).toBe('');
    });
});

describe('InventoryManager — equipped-list keying', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        } else {
            delete globalThis.fetch;
        }
        vi.restoreAllMocks();
    });

    it('keys equipped items by their typed eqId (not the bare id)', async () => {
        const manager = new InventoryManager({}, {}, {});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                equipped: [
                    { eqId: 'eq-aaa', itemId: 'item-1', itemType: 'knife', componentId: 'comp-1' },
                    { eqId: 'eq-bbb', itemId: 'item-2', itemType: 't1', componentId: 'comp-2' },
                ],
            }),
        })));

        await manager._loadEquippedItems('ent-1');

        // Each entry is keyed by its own typed eqId; nothing collapses under "undefined".
        expect(Object.keys(manager._equippedItems).sort()).toEqual(['eq-aaa', 'eq-bbb']);
        expect(Object.keys(manager._equippedItems)).not.toContain('undefined');
        expect(manager._equippedItems['eq-aaa'].itemId).toBe('item-1');
        expect(manager._equippedItems['eq-bbb'].itemType).toBe('t1');
    });

    it('skips malformed equipped entries lacking eqId (warn + no collapse)', async () => {
        const manager = new InventoryManager({}, {}, {});
        const warnSpy = vi.spyOn(ClientLogger, 'warn');
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                equipped: [
                    { eqId: 'eq-valid', itemId: 'item-1', itemType: 'knife', componentId: 'comp-1' },
                    { itemId: 'item-2', itemType: 't1', componentId: 'comp-2' }, // malformed: no eqId
                ],
            }),
        })));

        await manager._loadEquippedItems('ent-1');

        // Only the valid entry is kept (exact match); the malformed one is skipped, not collapsed.
        expect(Object.keys(manager._equippedItems)).toEqual(['eq-valid']);
        expect(manager._equippedItems['eq-valid'].itemId).toBe('item-1');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toBe('InventoryManager');
        expect(warnSpy.mock.calls[0][1]).toContain('no eqId');
        warnSpy.mockRestore();
    });
});

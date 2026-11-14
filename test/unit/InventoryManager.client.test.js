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

// Mirrors the shape of data/mods/core-holding-cost/holdingCost.json (the single massBurden model, not
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

// ---- The Eat button (consumable items) ----------------------------------------
// The button is rendered from the item DEFINITION's `consume` block, never from a
// hard-coded list of edible types — the same data-driven rule the server eats by
// (src/services/ConsumableRules.js). What is pinned here is the panel's half of the
// meal: which items get the button, and what the panel does with the world's answer
// (a refusal is a 200, and the toast has to say why nothing was eaten).
describe('InventoryManager — the Eat button follows the item definition', () => {
    /** The registry the panel would have fetched, with one food and one not. */
    function withRegistry(manager, definitions) {
        manager._itemRegistry = definitions;
        return manager;
    }

    it('renders Eat for an item whose definition declares a consume block', () => {
        const manager = withRegistry(makeManager(), {
            apple: { name: 'Apple', consume: { targetStat: 'Physical.energy', energyGain: 15 } },
        });
        const html = manager._renderTreeItems('comp-x', [item('apple', 'item-apple')], 0);
        expect(html).toContain('class="equip-btn eat"');
        expect(html).toContain('data-item-id="item-apple"');
    });

    it('does NOT render Eat for an item that declares nothing (coal is fuel, not food)', () => {
        const manager = withRegistry(makeManager(), { coal: { name: 'Coal' } });
        const html = manager._renderTreeItems('comp-x', [item('coal', 'item-coal')], 0);
        expect(html).not.toContain('equip-btn eat');
    });

    it('does NOT render Eat when the registry does not know the item', () => {
        // A type from a mod the panel never fetched is not food by default: the button
        // appears only when a definition says so.
        const manager = makeManager();
        const html = manager._renderTreeItems('comp-x', [item('mysteryFruit', 'item-x')], 0);
        expect(html).not.toContain('equip-btn eat');
    });

    /** Stubs the panel surface _onEatClick touches, and records what it was told. */
    function wireClick(manager, { handler, toasts = [] } = {}) {
        manager._currentEntityId = 'ent-1';
        manager._eatHandler = handler ?? null;
        manager._showToast = (message, type) => toasts.push({ message, type });
        const reloaded = [];
        manager._loadEntityItems = async (id) => { reloaded.push(id); };
        manager._renderIfVisible = () => { reloaded.push('render'); };
        return { toasts, reloaded };
    }

    it('runs the handler with the item id, toasts the meal, and reloads the panel', async () => {
        const manager = makeManager();
        const seen = [];
        const { toasts, reloaded } = wireClick(manager, {
            handler: async (itemId) => {
                seen.push(itemId);
                return { success: true, message: 'Ate Apple (+15 Physical.energy).' };
            },
        });
        await manager._onEatClick({ stopPropagation() {}, preventDefault() {} }, { dataset: { itemId: 'item-apple' } });
        expect(seen).toEqual(['item-apple']);
        expect(toasts).toEqual([{ message: 'Ate Apple (+15 Physical.energy).', type: 'success' }]);
        expect(reloaded).toEqual(['ent-1', 'render']);
    });

    it('says the meal is SCHEDULED when the round took it (the Turn-mode default)', async () => {
        // The path every click is on unless the player switches to real-time:
        // ActionManager sends `queueForRound: true`, the route answers with an ACK and no
        // consequence has run. Reading that ack as a failed eat is the message that looked
        // like a bug ("The world ran the eat action without eating anything") while the
        // world had merely taken the order — so the panel speaks of a schedule, in the
        // neutral voice, and names the item from the registry rather than the instance id.
        const manager = withRegistry(makeManager(), {
            apple: { name: 'Apple', consume: { targetStat: 'Physical.energy', energyGain: 15 } },
        });
        const { toasts, reloaded } = wireClick(manager, {
            handler: async () => ({ success: false, queued: true, message: null, refused: false }),
        });
        await manager._onEatClick(
            { stopPropagation() {}, preventDefault() {} },
            { dataset: { itemId: 'item-apple', itemType: 'apple' } }
        );
        expect(toasts).toEqual([{ message: 'Your action to eat Apple will run when the round resolves.', type: 'info' }]);
        expect(reloaded).toEqual(['ent-1', 'render']);
    });

    it('toasts the refusal as information, not as an error, and still reloads', async () => {
        // A full body keeps the apple. The world answered 200 with a reason: nothing
        // broke and nothing was spent, so painting it red tells the player a rule of the
        // world is a bug on their side. Red is kept for what never reached the world.
        const manager = makeManager();
        const { toasts, reloaded } = wireClick(manager, {
            handler: async () => ({ success: false, queued: false, message: 'Already at full Physical.energy (100/100).', refused: true }),
        });
        await manager._onEatClick({ stopPropagation() {}, preventDefault() {} }, { dataset: { itemId: 'item-apple' } });
        expect(toasts).toEqual([{ message: 'Already at full Physical.energy (100/100).', type: 'info' }]);
        expect(reloaded).toEqual(['ent-1', 'render']);
    });

    it('keeps red for a request that never reached the world', async () => {
        // The one case that IS a failure: the transport or the route answered nothing
        // usable — no world verdict to explain, so the panel says it did not happen.
        const manager = makeManager();
        const { toasts } = wireClick(manager, {
            handler: async () => ({ success: false, queued: false, message: 'Eating did not happen.', refused: false }),
        });
        await manager._onEatClick({ stopPropagation() {}, preventDefault() {} }, { dataset: { itemId: 'item-apple' } });
        expect(toasts).toEqual([{ message: 'Eating did not happen.', type: 'error' }]);
    });

    it('says the action is unavailable when nothing is wired', async () => {
        const manager = makeManager();
        const { toasts, reloaded } = wireClick(manager);
        await manager._onEatClick({ stopPropagation() {}, preventDefault() {} }, { dataset: { itemId: 'item-apple' } });
        expect(toasts[0].type).toBe('error');
        expect(toasts[0].message).toMatch(/not available/);
        expect(reloaded).toEqual([]);
    });

    it('survives a handler that throws, and still repaints from the server', async () => {
        const manager = makeManager();
        const { reloaded } = wireClick(manager, {
            handler: async () => { throw new Error('network down'); },
        });
        await manager._onEatClick({ stopPropagation() {}, preventDefault() {} }, { dataset: { itemId: 'item-apple' } });
        expect(reloaded).toEqual(['ent-1', 'render']);
    });

    it('ignores a card with no item id', async () => {
        const manager = makeManager();
        let calls = 0;
        const { reloaded } = wireClick(manager, { handler: async () => { calls += 1; return { success: true }; } });
        await manager._onEatClick({ stopPropagation() {}, preventDefault() {} }, { dataset: {} });
        expect(calls).toBe(0);
        expect(reloaded).toEqual([]);
    });
});

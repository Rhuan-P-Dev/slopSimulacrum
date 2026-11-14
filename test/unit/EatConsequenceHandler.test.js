/**
 * EatConsequenceHandler — unit tests for the `eatItem` consequence.
 *
 * The facade is a hand-built stub exposing only what the handler reads
 * (`getEntityItems`, `getItemDefinition`, `getEntityAttributeConfig`,
 * `getEntityAttribute`, `removeItemFromEntity`, `setEntityAttributeDelta`) — the same
 * idiom as test/unit/DoorTraversalHandler.test.js — so what is under test is the
 * contract the bite keeps with the world, not the world itself (that is
 * test/contract/consumables.contract.test.js).
 *
 * The four rules this pins, in the order they cost the actor something:
 *  1. WHICH item: an instance id wins; a type spends the first carried item of that
 *     type (the agent's Inventory line shows types, not ids, so this is the agent's
 *     only path — and it must stay working).
 *  2. IS IT FOOD: the item definition's `consume` block answers; nothing here knows
 *     the word "apple".
 *  3. FULL IS A REFUSAL, NOT A WASTE: the ceiling is the attribute's own `max`, and a
 *     meal at full energy spends NOTHING (the item survives the attempt).
 *  4. SPEND THEN CHARGE: the item is removed first and the charge only happens on a
 *     spent item, so a failed removal can never produce a free meal — and a partial
 *     charge reports the amount actually gained, not the amount the item declared.
 *
 * @module test/unit/EatConsequenceHandler
 */

import { describe, it, expect } from 'vitest';
import { handleEatItem } from '../../src/controllers/consequences/EatConsequenceHandler.js';

const ENTITY_ID = 'ent-droid-0001';
const HOST = 'comp-body-0001';

/** The food under test: the shipped apple's shape (15 energy onto Physical.energy). */
const APPLE_DEF = { name: 'Apple', consume: { targetStat: 'Physical.energy', energyGain: 15 } };

/**
 * Builds the facade stub.
 * @param {Object} [options]
 * @param {Object|null} [options.entity] - Pass null for an unknown entity.
 * @param {Array} [options.items] - Carried item instances (flat; one host component).
 * @param {Object} [options.definitions] - The `inventoryItems` registry.
 * @param {number} [options.energy] - Current Physical.energy (null: no attribute).
 * @param {number|null} [options.max] - Declared ceiling (null: no declaration).
 * @param {boolean} [options.removeSucceeds] - Flip removeItemFromEntity's answer.
 * @returns {{ deps: Object, calls: Object, state: Object }}
 */
function makeDeps({
    withEntity = true,
    items = [{ id: 'item-apple-1', type: 'apple', name: 'Apple' }],
    definitions = { apple: APPLE_DEF },
    energy = 40,
    max = 100,
    removeSucceeds = true
} = {}) {
    const calls = { removed: [], deltas: [], configReads: 0 };
    const worldStateController = {
        getEntityItems: (entityId) => (entityId === ENTITY_ID && withEntity
            ? { [HOST]: items.map((i) => ({ ...i })) }
            : {}),
        getItemDefinition: (type) => definitions[type] ?? null,
        getEntityAttributeConfig: (entityId, traitId, statName) => {
            calls.configReads += 1;
            if (max === null || !withEntity) return null;
            if (traitId !== 'Physical' || statName !== 'energy') return null;
            return { value: energy, max, drainPerTurn: 1 };
        },
        getEntityAttribute: (entityId, traitId, statName) => (
            withEntity && traitId === 'Physical' && statName === 'energy' ? energy : null
        ),
        removeItemFromEntity: (entityId, itemId) => {
            calls.removed.push({ entityId, itemId });
            return removeSucceeds
                ? { success: true }
                : { success: false, message: 'item is worn' };
        },
        setEntityAttributeDelta: (entityId, traitId, statName, delta, broadcast) => {
            calls.deltas.push({ entityId, traitId, statName, delta, broadcast });
            energy += delta;
            return true;
        }
    };
    return { deps: { worldStateController }, calls, state: { get energy() { return energy; } } };
}

const context = (actionParams = {}) => ({ actionParams: { entityId: ENTITY_ID, ...actionParams } });

describe('eating a carried consumable', () => {
    it('spends the item named by itemId and charges the energy it declares', () => {
        const { deps, calls, state } = makeDeps();
        const result = handleEatItem(deps, null, { itemId: 'item-apple-1' }, context());

        expect(result.success).toBe(true);
        expect(calls.removed).toEqual([{ entityId: ENTITY_ID, itemId: 'item-apple-1' }]);
        expect(calls.deltas).toHaveLength(1);
        expect(calls.deltas[0]).toMatchObject({ traitId: 'Physical', statName: 'energy', delta: 15 });
        expect(state.energy).toBe(55);
        expect(result.data).toMatchObject({
            itemId: 'item-apple-1', itemType: 'apple', targetStat: 'Physical.energy',
            energyGain: 15, energy: 55, capacity: 100
        });
    });

    it('writes the charge without a broadcast of its own', () => {
        // POST /execute-action broadcasts the settled world; a second emit per bite is
        // noise (and the handler's header records why this is pinned).
        const { deps, calls } = makeDeps();
        handleEatItem(deps, null, { itemId: 'item-apple-1' }, context());
        expect(calls.deltas[0].broadcast).toBe(false);
    });

    it('reads the intent from the action params when the consequence params are empty', () => {
        // `:itemId` in the action data resolves to nothing at all when the actor did
        // not pass it; the actionParams bag is the source of truth and carries it.
        const { deps, calls } = makeDeps();
        const result = handleEatItem(deps, null, {}, context({ itemId: 'item-apple-1' }));
        expect(result.success).toBe(true);
        expect(calls.removed[0].itemId).toBe('item-apple-1');
    });

    it('treats an unresolved placeholder as absent instead of as an item type', () => {
        // A consequence param that could not resolve arrives as the ":itemId" string.
        // Read literally it would look for an item of type ":itemId" — a nonsense type
        // nobody authored — and the refusal would name a phantom.
        const { deps, calls } = makeDeps();
        const result = handleEatItem(deps, null, { itemId: ':itemId', itemType: ':itemType' }, context());
        expect(result.success).toBe(false);
        expect(result.message).not.toMatch(/:item/);
        expect(calls.removed).toEqual([]);
    });

    it('eats the first carried item of the requested type when no id is given', () => {
        // This is the LLM agent's path: its Inventory line lists types and counts, not
        // instance ids, so `eat` with itemType has to work.
        const { deps, calls } = makeDeps({
            items: [
                { id: 'item-knife-1', type: 'knife' },
                { id: 'item-apple-1', type: 'apple' },
                { id: 'item-apple-2', type: 'apple' }
            ],
            definitions: { apple: APPLE_DEF, knife: { name: 'Knife' } }
        });
        const result = handleEatItem(deps, null, { itemType: 'apple' }, context());
        expect(result.success).toBe(true);
        expect(calls.removed).toEqual([{ entityId: ENTITY_ID, itemId: 'item-apple-1' }]);
    });

    it('prefers the explicit instance id over the type', () => {
        const { deps, calls } = makeDeps({
            items: [{ id: 'item-apple-1', type: 'apple' }, { id: 'item-apple-2', type: 'apple' }]
        });
        handleEatItem(deps, null, { itemId: 'item-apple-2', itemType: 'apple' }, context());
        expect(calls.removed[0].itemId).toBe('item-apple-2');
    });

    it('reaches a consumable inside a container, not just one loose in a slot', () => {
        // getEntityItems answers a map of host component to items; the handler searches
        // every host, exactly as the coal burner searches for fuel.
        const worldStateController = makeDeps().deps.worldStateController;
        worldStateController.getEntityItems = () => ({
            [HOST]: [],
            'comp-bag-0001': [{ id: 'item-apple-9', type: 'apple' }]
        });
        const result = handleEatItem({ worldStateController }, null, { itemType: 'apple' }, context());
        expect(result.success).toBe(true);
    });
});

describe('a meal that does not happen', () => {
    it('refuses an item the actor is not carrying, and charges nothing', () => {
        const { deps, calls } = makeDeps();
        const result = handleEatItem(deps, null, { itemId: 'item-not-there' }, context());
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Not carrying an item with id item-not-there/);
        expect(calls.removed).toEqual([]);
        expect(calls.deltas).toEqual([]);
    });

    it('refuses a type the actor has none of', () => {
        const { deps, calls } = makeDeps();
        const result = handleEatItem(deps, null, { itemType: 'goldenApple' }, context());
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Not carrying any "goldenApple"/);
        expect(calls.removed).toEqual([]);
    });

    it('asks which item when neither id nor type is given', () => {
        const { deps, calls } = makeDeps();
        const result = handleEatItem(deps, null, {}, context());
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/itemId/);
        expect(calls.removed).toEqual([]);
    });

    it('refuses an item whose definition declares no consume block', () => {
        // "Is it food" is the definition's answer, so a knife fails here without this
        // file ever naming a knife (or an apple).
        const { deps, calls } = makeDeps({
            items: [{ id: 'item-knife-1', type: 'knife' }],
            definitions: { knife: { name: 'Knife' } }
        });
        const result = handleEatItem(deps, null, { itemType: 'knife' }, context());
        expect(result.success).toBe(false);
        expect(result.message).toBe('Knife is not something you can eat.');
        expect(calls.removed).toEqual([]);
        expect(calls.deltas).toEqual([]);
    });

    it('refuses when the actor is at full energy — and keeps the item', () => {
        // THE anti-waste rule: a golden apple eaten at 100/100 is a golden apple thrown
        // away. The refusal happens before the removal, so nothing is spent.
        const { deps, calls, state } = makeDeps({ energy: 100 });
        const result = handleEatItem(deps, null, { itemId: 'item-apple-1' }, context());
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Already at full Physical\.energy \(100\/100\)/);
        expect(calls.removed).toEqual([]);
        expect(calls.deltas).toEqual([]);
        expect(state.energy).toBe(100);
    });

    it('refuses a body that has no meter to charge', () => {
        // The pre-feature state: a blueprint with no Physical.energy seed. The actor
        // is told the body has nothing to charge, instead of being told it ate.
        const { deps, calls } = makeDeps({ max: null });
        const result = handleEatItem(deps, null, { itemId: 'item-apple-1' }, context());
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/no Physical\.energy to charge/);
        expect(calls.removed).toEqual([]);
    });

    it('refuses an unknown entity instead of eating into the void', () => {
        const { deps, calls } = makeDeps({ withEntity: false });
        const result = handleEatItem(deps, null, { itemType: 'apple' }, context());
        expect(result.success).toBe(false);
        expect(calls.removed).toEqual([]);
    });

    it('refuses when the action carries no actor', () => {
        const { deps } = makeDeps();
        const result = handleEatItem(deps, null, { itemType: 'apple' }, { actionParams: {} });
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Missing entityId/);
    });

    it('charges nothing when the item could not be removed', () => {
        // No free meal: the charge is the SECOND step, and a removal that failed (the
        // item is worn, the host vanished) must leave the meter untouched.
        const { deps, calls, state } = makeDeps({ removeSucceeds: false });
        const result = handleEatItem(deps, null, { itemId: 'item-apple-1' }, context());
        expect(result.success).toBe(false);
        expect(calls.removed).toHaveLength(1);
        expect(calls.deltas).toEqual([]);
        expect(state.energy).toBe(40);
    });

    it('survives a facade without a world state controller', () => {
        expect(handleEatItem({}, null, { itemType: 'apple' }, context()).success).toBe(false);
    });
});

describe('the charge is clamped to the declared ceiling', () => {
    it('gives only what fits and reports the amount actually gained', () => {
        // The item declares 15; the body has 5 of room. The reported gain is 5 — the
        // actor is told what happened, not what the item promised. The ceiling is the
        // attribute's `max`, never a number on the item.
        const { deps, calls, state } = makeDeps({ energy: 95 });
        const result = handleEatItem(deps, null, { itemId: 'item-apple-1' }, context());
        expect(result.success).toBe(true);
        expect(calls.deltas[0].delta).toBe(5);
        expect(state.energy).toBe(100);
        expect(result.data.energyGain).toBe(5);
        expect(result.data.energy).toBe(100);
        expect(result.message).toMatch(/\+5 Physical\.energy/);
    });

    it('reads the ceiling from the attribute declaration, not from a constant', () => {
        // A mod that lowers the body's cap to 30 must not be overfilled by an apple
        // that declares 15 at 20/30... it fills to 30, and the gain reported is 10.
        const { deps, calls, state } = makeDeps({ energy: 20, max: 30 });
        const result = handleEatItem(deps, null, { itemId: 'item-apple-1' }, context());
        expect(calls.deltas[0].delta).toBe(10);
        expect(state.energy).toBe(30);
        expect(result.data.capacity).toBe(30);
    });
});

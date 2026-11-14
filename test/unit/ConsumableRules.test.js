/**
 * ConsumableRules — unit tests for the shape of an edible item.
 *
 * The block under test is the WHOLE of the consumable mechanic
 * (`{ targetStat, energyGain }` on an `inventoryItems` definition); these tests pin
 * the boundary the mechanic depends on: what counts as a declaration, and which
 * attributes a bite may charge.
 *
 * Pinned deliberately:
 *  - A closed target set (the whole-entity resources of `shared/StatVocabulary.js`),
 *    NOT an open "Group.stat" pattern. A block naming `Physical.strength` or
 *    `Physical.existence` would be a silent rewrite of what food does — eating would
 *    heal, or buff — and nobody chose that (`wiki/decisions/consumable-items.md`).
 *  - A positive finite amount only. A zero or negative `energyGain` is data that
 *    looks like food and does nothing (or damages), which is a trap for the author
 *    and for the actor.
 *  - The two readers of ONE rule: `parseConsumeBlock` throws (the edge: a malformed
 *    definition is quarantined, never shipped as dead data), `resolveConsumable`
 *    answers null (the running world: "not food", never an exception at a player).
 *
 * @module test/unit/ConsumableRules
 */

import { describe, it, expect } from 'vitest';
import {
    CONSUME_KEY,
    CONSUMABLE_TARGET_STATS,
    parseConsumeBlock,
    resolveConsumable
} from '../../src/services/ConsumableRules.js';

const item = (consume) => ({ name: 'Test item', consume });

describe('the block key', () => {
    it('is the key the data files use', () => {
        // A rename in code without the data, or in data without code, is a silent
        // no-op: the item spawns, the Eat button never appears, nothing fails. So the
        // key itself is pinned here (and the shipped items are pinned in
        // test/contract/consumables.contract.test.js).
        expect(CONSUME_KEY).toBe('consume');
    });
});

describe('an item that declares nothing', () => {
    it('is not a consumable', () => {
        expect(parseConsumeBlock({ name: 'Coal' })).toBeNull();
        expect(parseConsumeBlock(item(undefined))).toBeNull();
        expect(resolveConsumable({ name: 'Coal' })).toBeNull();
    });

    it('tolerates a missing definition instead of throwing', () => {
        // The handler reads a type the registry may not know (an item authored by a
        // mod that was later disabled). "Not food" is the answer, not a crash.
        expect(parseConsumeBlock(null)).toBeNull();
        expect(parseConsumeBlock(undefined)).toBeNull();
        expect(parseConsumeBlock('apple')).toBeNull();
    });
});

describe('a well-formed block', () => {
    it('normalizes to the trait, the stat and the amount', () => {
        expect(parseConsumeBlock(item({ targetStat: 'Physical.energy', energyGain: 15 })))
            .toEqual({ traitId: 'Physical', statName: 'energy', targetStat: 'Physical.energy', energyGain: 15 });
    });

    it('accepts surrounding whitespace in the target key', () => {
        expect(parseConsumeBlock(item({ targetStat: '  Physical.energy  ', energyGain: 1 })).targetStat)
            .toBe('Physical.energy');
    });

    it('allows every whole-entity resource in the closed set', () => {
        // The set itself is pinned: energy (the life pool) and pleasure (a state,
        // never a death). Pleasure is not shipped as food today, but it IS a legal
        // target — a mod authoring a stimulant must not be refused by a rule that was
        // written around one apple.
        expect([...CONSUMABLE_TARGET_STATS]).toEqual(['Physical.energy', 'Pleasure.pleasure']);
        for (const targetStat of CONSUMABLE_TARGET_STATS) {
            expect(parseConsumeBlock(item({ targetStat, energyGain: 1 })).targetStat).toBe(targetStat);
        }
    });
});

describe('a malformed block', () => {
    // Each row: what the author wrote, and the rule the message has to name. The
    // message is the author's only feedback (a quarantined definition does not ship),
    // so "invalid" is not enough.
    const cases = [
        [{ consume: null }, 'must be an object'],
        [{ consume: [] }, 'must be an object'],
        [{ consume: 'Physical.energy' }, 'must be an object'],
        [{ consume: {} }, 'must be a "Group.stat" key'],
        [{ consume: { targetStat: 'energy', energyGain: 5 } }, 'must be a "Group.stat" key'],
        [{ consume: { targetStat: 'Physical', energyGain: 5 } }, 'must be a "Group.stat" key'],
        [{ consume: { targetStat: 'Physical strength', energyGain: 5 } }, 'must be a "Group.stat" key'],
        [{ consume: { targetStat: 'Physical.strength', energyGain: 5 } }, 'whole-entity resource'],
        [{ consume: { targetStat: 'Physical.existence', energyGain: 5 } }, 'whole-entity resource'],
        [{ consume: { targetStat: 'Physical.energy' } }, 'energyGain" must be a positive finite number'],
        [{ consume: { targetStat: 'Physical.energy', energyGain: 0 } }, 'positive finite number'],
        [{ consume: { targetStat: 'Physical.energy', energyGain: -20 } }, 'positive finite number'],
        [{ consume: { targetStat: 'Physical.energy', energyGain: '15' } }, 'positive finite number'],
        [{ consume: { targetStat: 'Physical.energy', energyGain: NaN } }, 'positive finite number'],
        [{ consume: { targetStat: 'Physical.energy', energyGain: Infinity } }, 'positive finite number']
    ];

    for (const [def, expected] of cases) {
        it(`is refused with the rule named: ${JSON.stringify(def)}`, () => {
            expect(() => parseConsumeBlock(item(def.consume), 'Item "apple"')).toThrow(TypeError);
            expect(() => parseConsumeBlock(item(def.consume), 'Item "apple"')).toThrow(expected);
        });
    }

    it('names whose data is wrong', () => {
        // The classifier passes the item key; a reason that does not say which item
        // is a report nobody can act on.
        expect(() => parseConsumeBlock(item({ targetStat: 'Physical.strength', energyGain: 5 }), 'Item "apple"'))
            .toThrow(/^Item "apple":/);
    });

    it('degrades to "not food" on the hot path instead of throwing', () => {
        // The pair of readers is the contract: the edge throws, the running world
        // answers. A bad block that reached runtime (written before this rule existed)
        // must not take an actor's turn down with it.
        expect(resolveConsumable(item({ targetStat: 'Physical.strength', energyGain: 5 }))).toBeNull();
        expect(resolveConsumable(item({ consume: 'nope' }))).toBeNull();
    });
});

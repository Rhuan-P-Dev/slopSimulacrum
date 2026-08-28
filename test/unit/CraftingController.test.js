/**
 * CraftingController unit tests.
 *
 * Pattern: raw registries passed to the constructor (the composition root
 * loads them via DataLoader.loadJsonSafe), with src/utils/Logger mocked.
 * Covers: _validateRecipeDefinitions() throw matrix, acceptance of a valid
 * registry, defensive-copy behavior of getRecipes()/getRecipe(), unknown-ID
 * lookup, and the pure checkRequirements()/multiset semantics.
 *
 * @module test/unit/CraftingController
 */

import { describe, it, expect, vi } from 'vitest';
import CraftingController from '../../src/controllers/crafting/CraftingController.js';

vi.mock('../../src/utils/Logger.js', () => ({
    default: {
        info: () => {},
        warn: () => {},
        error: () => {}
    }
}));

// Minimal item registry: the two types referenced by the test recipes.
const ITEM_REGISTRY = {
    knife: { name: 'Knife', volume: 1 },
    t1: { name: 'T1', volume: 10, externalVolume: 1 },
    powerCell: { name: 'Power Cell', volume: 2 }
};

// A valid registry in the data/crafting.json shape: keyed by recipe ID.
const VALID_REGISTRY = {
    knife_to_t1: {
        id: 'knife_to_t1',
        name: 'T1 Assembly',
        description: 'Fuse two knives into one T1 container weapon.',
        inputs: [{ type: 'knife', quantity: 2 }],
        outputs: [{ type: 't1', quantity: 1 }]
    }
};

function build(registry, itemRegistry = ITEM_REGISTRY) {
    return new CraftingController(registry, itemRegistry);
}

describe('CraftingController', () => {
    describe('_validateRecipeDefinitions', () => {
        it('throws TypeError on a non-object registry (array/string)', () => {
            // null/undefined are normalized to {} by the constructor (same
            // tolerance as MaterialController: the composition root's
            // loadJsonSafe fallback is {} and never null).
            expect(() => build([])).toThrow(TypeError);
            expect(() => build('nope')).toThrow(TypeError);
            expect(() => build(null)).not.toThrow();
            expect(() => build(undefined)).not.toThrow();
        });

        it('throws TypeError when a recipe entry is not an object', () => {
            const registry = { bad: 'not-an-object' };
            expect(() => build(registry)).toThrow(TypeError);
            expect(() => build({ bad: null })).toThrow(TypeError);
            expect(() => build({ bad: [] })).toThrow(TypeError);
        });

        it('throws TypeError when the key does not match the id field', () => {
            const registry = {
                key_a: {
                    id: 'key_b',
                    name: 'X',
                    inputs: [{ type: 'knife', quantity: 1 }],
                    outputs: [{ type: 't1', quantity: 1 }]
                }
            };
            expect(() => build(registry)).toThrow(/does not match its id/);
        });

        it('throws TypeError on missing or empty id', () => {
            const noId = { r1: { name: 'X', inputs: [{ type: 'knife', quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(noId)).toThrow(TypeError);
            const emptyId = { r1: { id: '', name: 'X', inputs: [{ type: 'knife', quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(emptyId)).toThrow(TypeError);
        });

        it('throws TypeError on missing, empty, or non-string name', () => {
            const noName = { r1: { id: 'r1', inputs: [{ type: 'knife', quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(noName)).toThrow(TypeError);
            const emptyName = { r1: { id: 'r1', name: '', inputs: [{ type: 'knife', quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(emptyName)).toThrow(TypeError);
            const numName = { r1: { id: 'r1', name: 42, inputs: [{ type: 'knife', quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(numName)).toThrow(TypeError);
        });

        it('throws TypeError on non-string description', () => {
            const registry = {
                r1: { id: 'r1', name: 'X', description: 5, inputs: [{ type: 'knife', quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] }
            };
            expect(() => build(registry)).toThrow(TypeError);
        });

        it('throws TypeError on empty or non-array inputs/outputs', () => {
            const noInputs = { r1: { id: 'r1', name: 'X', inputs: [], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(noInputs)).toThrow(/inputs/);
            const noOutputs = { r1: { id: 'r1', name: 'X', inputs: [{ type: 'knife', quantity: 1 }], outputs: [] } };
            expect(() => build(noOutputs)).toThrow(/outputs/);
            const notArray = { r1: { id: 'r1', name: 'X', inputs: 'knife', outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(notArray)).toThrow(TypeError);
            const missing = { r1: { id: 'r1', name: 'X' } };
            expect(() => build(missing)).toThrow(TypeError);
        });

        it('throws TypeError on malformed entry shapes (non-object entry, missing/non-string type)', () => {
            const badEntry = { r1: { id: 'r1', name: 'X', inputs: ['knife'], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(badEntry)).toThrow(TypeError);
            const noType = { r1: { id: 'r1', name: 'X', inputs: [{ quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(noType)).toThrow(/type/);
            const badType = { r1: { id: 'r1', name: 'X', inputs: [{ type: 7, quantity: 1 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(badType)).toThrow(TypeError);
        });

        it('throws TypeError on zero, negative, or non-integer quantity', () => {
            const zero = { r1: { id: 'r1', name: 'X', inputs: [{ type: 'knife', quantity: 0 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(zero)).toThrow(/quantity/);
            const negative = { r1: { id: 'r1', name: 'X', inputs: [{ type: 'knife', quantity: -2 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(negative)).toThrow(/quantity/);
            const fraction = { r1: { id: 'r1', name: 'X', inputs: [{ type: 'knife', quantity: 1.5 }], outputs: [{ type: 't1', quantity: 1 }] } };
            expect(() => build(fraction)).toThrow(/quantity/);
            const outputsToo = { r1: { id: 'r1', name: 'X', inputs: [{ type: 'knife', quantity: 1 }], outputs: [{ type: 't1', quantity: 0 }] } };
            expect(() => build(outputsToo)).toThrow(/quantity/);
        });

        it('throws TypeError when an input/output type is missing from the item registry', () => {
            const registry = {
                r1: {
                    id: 'r1',
                    name: 'X',
                    inputs: [{ type: 'ghostItem', quantity: 1 }],
                    outputs: [{ type: 't1', quantity: 1 }]
                }
            };
            expect(() => build(registry)).toThrow(/unknown item type "ghostItem"/);

            const badOutput = {
                r1: {
                    id: 'r1',
                    name: 'X',
                    inputs: [{ type: 'knife', quantity: 1 }],
                    outputs: [{ type: 'ghostItem', quantity: 1 }]
                }
            };
            expect(() => build(badOutput)).toThrow(/unknown item type "ghostItem"/);
        });

        it('accepts a valid registry (2× knife → 1× t1)', () => {
            const controller = build(structuredClone(VALID_REGISTRY));
            expect(controller.hasRecipe('knife_to_t1')).toBe(true);
        });

        it('accepts an empty registry object (missing file fallback)', () => {
            const controller = build({});
            expect(controller.getRecipes()).toEqual([]);
        });
    });

    describe('getRecipes / getRecipe (defensive copies)', () => {
        it('getRecipes returns a deep copy — mutating the result does not affect the controller', () => {
            const controller = build(structuredClone(VALID_REGISTRY));

            const first = controller.getRecipes();
            expect(first).toHaveLength(1);
            expect(first[0].id).toBe('knife_to_t1');

            // Mutate the returned array AND the nested entry structures.
            first.push({ id: 'injected', name: 'X' });
            first[0].name = 'TAMPERED';
            first[0].inputs.push({ type: 't1', quantity: 99 });
            first[0].inputs[0].quantity = 55;

            const second = controller.getRecipes();
            expect(second).toHaveLength(1);
            expect(second[0].name).toBe('T1 Assembly');
            expect(second[0].inputs).toEqual([{ type: 'knife', quantity: 2 }]);
            expect(second[0].outputs).toEqual([{ type: 't1', quantity: 1 }]);
        });

        it('getRecipe returns a deep copy of one recipe', () => {
            const controller = build(structuredClone(VALID_REGISTRY));
            const recipe = controller.getRecipe('knife_to_t1');
            expect(recipe).toEqual(VALID_REGISTRY.knife_to_t1);
            recipe.name = 'TAMPERED';
            recipe.inputs[0].quantity = 99;

            const again = controller.getRecipe('knife_to_t1');
            expect(again.name).toBe('T1 Assembly');
            expect(again.inputs[0].quantity).toBe(2);
        });

        it('getRecipe returns null for an unknown ID', () => {
            const controller = build(structuredClone(VALID_REGISTRY));
            expect(controller.getRecipe('nope')).toBeNull();
            expect(controller.hasRecipe('nope')).toBe(false);
        });
    });

    describe('checkRequirements (pure multiset logic)', () => {
        const recipe = VALID_REGISTRY.knife_to_t1;

        it('is satisfied by exactly the required inputs', () => {
            const items = [{ type: 'knife' }, { type: 'knife' }];
            expect(build({}).checkRequirements(items, recipe)).toEqual({ satisfied: true, missing: [] });
        });

        it('is satisfied when the component holds extra (non-input) items', () => {
            const items = [{ type: 'knife' }, { type: 'knife' }, { type: 'powerCell' }];
            expect(build({}).checkRequirements(items, recipe)).toEqual({ satisfied: true, missing: [] });
        });

        it('reports the exact missing entry when partially satisfied', () => {
            const items = [{ type: 'knife' }];
            expect(build({}).checkRequirements(items, recipe)).toEqual({
                satisfied: false,
                missing: [{ type: 'knife', have: 1, need: 2 }]
            });
        });

        it('reports have=0 for zero items', () => {
            expect(build({}).checkRequirements([], recipe)).toEqual({
                satisfied: false,
                missing: [{ type: 'knife', have: 0, need: 2 }]
            });
        });

        it('reports multiple missing types for multi-input recipes', () => {
            const multi = {
                id: 'multi',
                name: 'Multi',
                inputs: [
                    { type: 'knife', quantity: 2 },
                    { type: 'powerCell', quantity: 1 }
                ],
                outputs: [{ type: 't1', quantity: 1 }]
            };
            const controller = build({ multi });
            const result = controller.checkRequirements([{ type: 'knife' }], multi);
            expect(result.satisfied).toBe(false);
            expect(result.missing).toEqual([
                { type: 'knife', have: 1, need: 2 },
                { type: 'powerCell', have: 0, need: 1 }
            ]);
        });
    });
});

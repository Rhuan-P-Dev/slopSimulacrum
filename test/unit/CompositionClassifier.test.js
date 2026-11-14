/**
 * UNIT TEST — CompositionClassifier: the same rules as boot, collected instead of thrown.
 *
 * Everything here is a real candidate over the real owners: the failures are produced by
 * `MaterialController`, `CraftingController` and `MachineRegistryController` themselves,
 * never by a copy of their rules. Which is also why the fixtures below look like the real
 * data files and not like sketches — `materials` is an ARRAY of `{ material, fraction }`,
 * a recipe's inputs and outputs are ITEM types with integer quantities, and a machine
 * binds blueprint, item and recipe. A fixture that got the shape wrong would "pass" by
 * tripping a different error than the one it claims to test.
 *
 * What is pinned: one entry per bad definition, with a reason, and the good definitions
 * still in `valid`; the material family reported once as unusable rather than blamed
 * across every component; and the dependency chain, which is the only reason this is not
 * four try/catch blocks in a row.
 *
 * @module test/unit/CompositionClassifier
 */

import { describe, it, expect } from 'vitest';
import classifyComposition, { QUARANTINE_SCOPE } from '../../src/services/CompositionClassifier.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

const wood = { wood: { name: 'Wood', density: 0.6, properties: {} } };
const nailItem = { nail: { name: 'Nail', form: { volume: 1 }, materials: [{ material: 'wood', fraction: 1 }] } };

/** A candidate where every checked kind defaults to a minimal valid registry. */
const candidate = (over = {}) => ({
    [REGISTRY_KINDS.MATERIALS]: wood,
    [REGISTRY_KINDS.COMPONENTS]: { _comment: 'docs', bowl: { name: 'Bowl', materials: [{ material: 'wood', fraction: 1 }] } },
    [REGISTRY_KINDS.INVENTORY_ITEMS]: { ...nailItem },
    [REGISTRY_KINDS.CRAFTING]: {},
    [REGISTRY_KINDS.MACHINES]: {},
    ...over
});

const recipe = (id, outputs) => ({
    id,
    name: `Recipe ${id}`,
    description: 'test recipe',
    inputs: [{ type: 'nail', quantity: 1 }],
    outputs
});

describe('a well-formed candidate', () => {
    it('passes everything through and quarantines nothing', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.CRAFTING]: { make_two_nails: recipe('make_two_nails', [{ type: 'nail', quantity: 2 }]) },
            [REGISTRY_KINDS.BLUEPRINTS]: { press: ['pressBody'] },
            [REGISTRY_KINDS.MACHINES]: { pressMachine: { name: 'Press', blueprint: 'press', itemKey: 'nail', recipeId: 'make_two_nails' } }
        }));
        expect(result.quarantined).toEqual([]);
        expect(result.valid[REGISTRY_KINDS.COMPONENTS].bowl).toBeDefined();
        expect(result.valid[REGISTRY_KINDS.MACHINES].pressMachine).toBeDefined();
    });

    it('keeps documentation keys where the owner treats them as metadata', () => {
        // components.json carries a `_comment`; the component checks skip it, exactly as
        // the boot checks do.
        const result = classifyComposition(candidate());
        expect(result.quarantined).toEqual([]);
        expect(result.valid[REGISTRY_KINDS.COMPONENTS]._comment).toBe('docs');
    });

    it('reports a documentation key where the owner does not skip them', () => {
        // The materials owner rejects a `_comment` entry outright, and today that fails
        // the boot. The classifier reproduces that, rather than quietly stripping the key
        // and promising a plan the boot would refuse (plan and boot must disagree about
        // nothing).
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.MATERIALS]: { _comment: 'a very long comment', ...wood }
        }));
        expect(result.quarantined.map((q) => [q.kind, q.scope])).toEqual([[REGISTRY_KINDS.MATERIALS, QUARANTINE_SCOPE.REGISTRY]]);
    });

    it('does not touch the candidate it was given', () => {
        const input = candidate({
            [REGISTRY_KINDS.COMPONENTS]: { _comment: 'x', bowl: { name: 'Bowl', materials: [{ material: 'unobtainium', fraction: 1 }] } }
        });
        const before = JSON.stringify(input);
        classifyComposition(input);
        expect(JSON.stringify(input)).toBe(before);
    });
});

describe('a defect in one definition', () => {
    it('quarantines that definition, names it, and keeps its neighbours', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.COMPONENTS]: {
                _comment: 'docs',
                bowl: { name: 'Bowl', materials: [{ material: 'wood', fraction: 1 }] },
                // The owner's own rule: fractions may not exceed one.
                heavy: { name: 'Heavy', materials: [{ material: 'wood', fraction: 1.5 }] },
                // And: every material must exist in the materials registry.
                alien: { name: 'Alien', materials: [{ material: 'unobtainium', fraction: 1 }] },
                // And: the composition must be the array the owner reads.
                legacy: { name: 'Legacy', materials: { wood: 1 } }
            }
        }));
        const keys = result.quarantined.map((q) => q.key).sort();
        expect(keys).toEqual(['alien', 'heavy', 'legacy']);
        expect(result.quarantined.every((q) => q.scope === QUARANTINE_SCOPE.DEFINITION)).toBe(true);
        expect(result.quarantined.every((q) => q.kind === REGISTRY_KINDS.COMPONENTS)).toBe(true);
        expect(result.quarantined.every((q) => typeof q.reason === 'string' && q.reason.length > 0)).toBe(true);
        expect(Object.keys(result.valid[REGISTRY_KINDS.COMPONENTS])).toEqual(['_comment', 'bowl']);
    });

    it('carries the message from the owner itself, so the report says what is wrong', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: { cup: { name: 'Cup', materials: [{ material: 'wood', fraction: 3 }] } }
        }));
        expect(result.quarantined[0].reason).toMatch(/sum to 3/i);
        expect(result.quarantined[0].kind).toBe(REGISTRY_KINDS.INVENTORY_ITEMS);
    });
});

describe('the dependency chain', () => {
    it('takes a machine down when its recipe is quarantined', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.BLUEPRINTS]: { press: ['pressBody'] },
            [REGISTRY_KINDS.CRAFTING]: {
                make_nails: recipe('make_nails', [{ type: 'nail', quantity: 2 }]),
                // Outputs an item that does not exist: this recipe is quarantined.
                make_ghost: recipe('make_ghost', [{ type: 'ghost', quantity: 1 }])
            },
            [REGISTRY_KINDS.MACHINES]: {
                pressMachine: { name: 'Press', blueprint: 'press', itemKey: 'nail', recipeId: 'make_nails' },
                // Bound to the recipe that is about to be quarantined.
                ghostMachine: { name: 'Ghost press', blueprint: 'press', itemKey: 'nail', recipeId: 'make_ghost' }
            }
        }));
        const byKind = (kind) => result.quarantined.filter((q) => q.kind === kind).map((q) => q.key);
        expect(byKind(REGISTRY_KINDS.CRAFTING)).toEqual(['make_ghost']);
        expect(byKind(REGISTRY_KINDS.MACHINES)).toEqual(['ghostMachine']);
        expect(result.valid[REGISTRY_KINDS.MACHINES].pressMachine).toBeDefined();
    });

    it('names a machine whose blueprint is simply missing', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.BLUEPRINTS]: {},
            [REGISTRY_KINDS.MACHINES]: { pressMachine: { name: 'Press', blueprint: 'press', itemKey: 'nail', recipeId: 'nope' } }
        }));
        expect(result.quarantined.some((q) => q.kind === REGISTRY_KINDS.MACHINES && q.key === 'pressMachine')).toBe(true);
    });

    it('drops a machine whose item definition was quarantined upstream', () => {
        // The item is defined, the recipe is valid, the machine is bound to both — and the
        // item's material does not exist. Everything downstream of a quarantined
        // definition has to follow, with a reason that names what it lost.
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: { nail: { name: 'Nail', materials: [{ material: 'unobtainium', fraction: 1 }] } },
            [REGISTRY_KINDS.BLUEPRINTS]: { press: ['pressBody'] },
            [REGISTRY_KINDS.CRAFTING]: { press_nails: recipe('press_nails', [{ type: 'nail', quantity: 1 }]) },
            [REGISTRY_KINDS.MACHINES]: { pressMachine: { name: 'Press', blueprint: 'press', itemKey: 'nail', recipeId: 'press_nails' } }
        }));
        const byKind = (kind) => result.quarantined.filter((q) => q.kind === kind).map((q) => q.key);
        expect(byKind(REGISTRY_KINDS.INVENTORY_ITEMS)).toEqual(['nail']);
        expect(byKind(REGISTRY_KINDS.CRAFTING)).toEqual(['press_nails']);
        const machine = result.quarantined.find((q) => q.kind === REGISTRY_KINDS.MACHINES);
        expect(machine.key).toBe('pressMachine');
        expect(machine.reason).toMatch(/nail/);
    });
});

describe('a material registry that cannot be used', () => {
    it('reports the family once, instead of blaming every component', () => {
        const result = classifyComposition(candidate({
            // A damage-type table for a material that does not exist: the owner refuses
            // the whole unit, so no component-level verdict is trustworthy.
            [REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES]: { _comment: 'x', glass: { impact: 1 } }
        }));
        expect(result.quarantined).toHaveLength(1);
        const entry = result.quarantined[0];
        expect(entry.scope).toBe(QUARANTINE_SCOPE.REGISTRY);
        expect(entry.kind).toBe(REGISTRY_KINDS.MATERIALS);
        // Which files were part of the unit that failed, named in the message.
        expect(entry.reason).toMatch(/materialDamageTypes/);
        // The bowl was NOT quarantined: with no trustworthy base, no component verdict is
        // reported at all — silence here is honest, mass quarantine is not.
        expect(result.valid[REGISTRY_KINDS.COMPONENTS].bowl).toBeDefined();
    });
});

describe("an item's own appearance (a garment's look)", () => {
    it('quarantines the definition whose visual block does not read, and nothing else', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: {
                ...nailItem,
                // A shipped-shaped garment: a look authored beside its matter, both valid.
                shirt: { name: 'Shirt', form: { volume: 2 }, materials: [{ material: 'wood', fraction: 1 }], visual: { hue: 0, saturation: 70, lightness: 46 } },
                cap: { name: 'Cap', form: { volume: 1 }, materials: [{ material: 'wood', fraction: 1 }], visual: { shimmer: 40 } }
            }
        }));
        expect(result.valid[REGISTRY_KINDS.INVENTORY_ITEMS].shirt, 'a well-formed look stays in the world')
            .toBeDefined();
        expect(result.quarantined).toHaveLength(1);
        const entry = result.quarantined[0];
        expect([entry.kind, entry.key, entry.scope]).toEqual([REGISTRY_KINDS.INVENTORY_ITEMS, 'cap', QUARANTINE_SCOPE.DEFINITION]);
        expect(entry.reason).toMatch(/unknown visual key "shimmer"/);
    });

    it('is checked even when there is no material base to check the item against', () => {
        // A garment's look is authored on the item, not derived from matter, so the
        // clothing check does not hide behind the material section: a mod that adds
        // only a shirt with a broken look is still caught, not shipped as dead data.
        const result = classifyComposition({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: { cap: { name: 'Cap', visual: { hue: 900 } } }
        });
        const entry = result.quarantined.find((q) => q.kind === REGISTRY_KINDS.INVENTORY_ITEMS);
        expect([entry.key, entry.scope]).toEqual(['cap', QUARANTINE_SCOPE.DEFINITION]);
        expect(entry.reason).toMatch(/visual "hue" must be a number in \[0, 360\]/);
    });
});

describe('kinds with no composition rule today', () => {
    it('pass through untouched, including kinds the classifier has never heard of', () => {
        const result = classifyComposition({
            [REGISTRY_KINDS.WORLD_RULES]: { rules: { anything: true } },
            someFutureKind: { a: 1 }
        });
        expect(result.quarantined).toEqual([]);
        expect(result.valid[REGISTRY_KINDS.WORLD_RULES]).toEqual({ rules: { anything: true } });
        expect(result.valid.someFutureKind).toEqual({ a: 1 });
    });
});

describe('the map and its props (rooms, worldObjects)', () => {
    /** A room the spatial model can be built from. */
    const room = (over = {}) => ({ name: 'Annex', connections: {}, x: 0, y: 0, width: 100, height: 100, ...over });

    it('passes a room and a prop whose references resolve', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.BLUEPRINTS]: { tree: { name: 'Tree' } },
            [REGISTRY_KINDS.ROOMS]: {
                start_room: room(),
                annex: room({ connections: { back: { target: 'start_room' } } })
            },
            [REGISTRY_KINDS.WORLD_OBJECTS]: { bench: { name: 'Bench', blueprint: 'tree', room: 'annex', position: { x: 0, y: -40 } } }
        }));

        expect(result.quarantined).toEqual([]);
        expect(result.valid[REGISTRY_KINDS.ROOMS].annex).toBeDefined();
    });

    it('quarantines the room the map cannot be built from, and keeps the good one', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.ROOMS]: { good: room(), broken: { name: 'Broken' } }
        }));

        expect(result.valid[REGISTRY_KINDS.ROOMS].good).toBeDefined();
        expect(result.valid[REGISTRY_KINDS.ROOMS].broken).toBeUndefined();
        const entry = result.quarantined.find((e) => e.key === 'broken');
        expect(entry).toMatchObject({ kind: REGISTRY_KINDS.ROOMS, scope: QUARANTINE_SCOPE.DEFINITION });
        // The sentence is boot's, not a second opinion on it (`CR T-2`).
        expect(entry.reason).toContain("Room 'broken' must have numeric width, height");
    });

    it('takes a prop down with the room it pointed at', () => {
        // The dependency chain again, in the other direction from the machines: a prop is
        // placed in a room, so a room that did not survive takes its props with it, named.
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.BLUEPRINTS]: { tree: { name: 'Tree' } },
            [REGISTRY_KINDS.ROOMS]: { good: room(), broken: { name: 'Broken' } },
            [REGISTRY_KINDS.WORLD_OBJECTS]: {
                inGood: { blueprint: 'tree', room: 'good' },
                inBroken: { blueprint: 'tree', room: 'broken' }
            }
        }));

        expect(result.valid[REGISTRY_KINDS.WORLD_OBJECTS].inGood).toBeDefined();
        expect(result.valid[REGISTRY_KINDS.WORLD_OBJECTS].inBroken).toBeUndefined();
        expect(result.quarantined.map((e) => e.key)).toEqual(expect.arrayContaining(['broken', 'inBroken']));
    });

    it('quarantines a prop whose blueprint the candidate does not hold', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.BLUEPRINTS]: { tree: { name: 'Tree' } },
            [REGISTRY_KINDS.ROOMS]: { start_room: room() },
            [REGISTRY_KINDS.WORLD_OBJECTS]: { bench: { blueprint: 'unobtainium', room: 'start_room' } }
        }));

        expect(result.quarantined[0]).toMatchObject({ kind: REGISTRY_KINDS.WORLD_OBJECTS, key: 'bench' });
        expect(result.quarantined[0].reason).toContain("unknown blueprint 'unobtainium'");
    });

    it('keeps documentation keys where the owners treat them as metadata', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.ROOMS]: { _comment: 'the map', start_room: room() },
            [REGISTRY_KINDS.WORLD_OBJECTS]: { _comment: 'the props' }
        }));

        expect(result.quarantined).toEqual([]);
    });
});

// ---- A consumable's `consume` block -------------------------------------------
// What makes an item edible is one small block, and the classifier is the only place
// that decides whether a mod's food ships. The rule text lives in
// src/services/ConsumableRules.js — the same reader the eat consequence uses — so a
// plan cannot promise a bite the running world would refuse. What is pinned here is
// the treatment: bad food is dropped by name, good food survives, and the rest of the
// candidate is untouched.
describe('an inventory item that declares a consume block', () => {
    /** An item carrying `consume` exactly as the data files write it. */
    const food = (consume) => ({
        apple: {
            name: 'Apple',
            form: { volume: 1 },
            materials: [{ material: 'wood', fraction: 1 }],
            ...(consume === undefined ? {} : { consume })
        }
    });

    it('keeps food whose block names a whole-entity resource and an amount', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: {
                ...nailItem,
                ...food({ targetStat: 'Physical.energy', energyGain: 15 })
            }
        }));
        expect(result.quarantined).toEqual([]);
        expect(result.valid[REGISTRY_KINDS.INVENTORY_ITEMS].apple.consume)
            .toEqual({ targetStat: 'Physical.energy', energyGain: 15 });
    });

    it('keeps an item that declares no block at all (most items are not food)', () => {
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: { ...nailItem, ...food(undefined) }
        }));
        expect(result.quarantined).toEqual([]);
        expect(result.valid[REGISTRY_KINDS.INVENTORY_ITEMS].apple).toBeDefined();
    });

    it('quarantines food that charges a stat outside the closed vocabulary', () => {
        // The dangerous case, because it boots cleanly: `Physical.strength` is a real
        // stat, and a bite that buffs strength (or heals, or spends `existence`) is a
        // rewrite of what food does. Dropped by name, like a bad `visual` block.
        const result = classifyComposition(candidate({
            [REGISTRY_KINDS.INVENTORY_ITEMS]: { ...nailItem, ...food({ targetStat: 'Physical.strength', energyGain: 5 }) }
        }));
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0]).toMatchObject({
            kind: REGISTRY_KINDS.INVENTORY_ITEMS,
            key: 'apple',
            scope: QUARANTINE_SCOPE.DEFINITION
        });
        expect(result.quarantined[0].reason).toContain('whole-entity resource');
        expect(result.valid[REGISTRY_KINDS.INVENTORY_ITEMS].apple, 'the bad definition is dropped').toBeUndefined();
        expect(result.valid[REGISTRY_KINDS.INVENTORY_ITEMS].nail, 'the rest of the registry survives').toBeDefined();
    });

    it('quarantines food with no amount to charge', () => {
        // A block that declares nothing would ship as a dead Eat button: the item is
        // spent, the meter does not move. An author wrote food and got a trap.
        for (const energyGain of [undefined, 0, -20, '15']) {
            const result = classifyComposition(candidate({
                [REGISTRY_KINDS.INVENTORY_ITEMS]: { ...nailItem, ...food({ targetStat: 'Physical.energy', energyGain }) }
            }));
            expect(result.quarantined.map((q) => q.key), `energyGain=${JSON.stringify(energyGain)}`).toEqual(['apple']);
        }
    });

    it('quarantines a block that is not a block', () => {
        // `consume: true` reads like a flag an author meant to fill in later; it is
        // still a definition that cannot charge anything.
        for (const consume of [true, 'Physical.energy', [], 'yes']) {
            const result = classifyComposition(candidate({
                [REGISTRY_KINDS.INVENTORY_ITEMS]: { ...nailItem, ...food(consume) }
            }));
            expect(result.quarantined.map((q) => q.key), `consume=${JSON.stringify(consume)}`).toEqual(['apple']);
            expect(result.quarantined[0].reason).toContain('must be an object');
        }
    });
});

/**
 * KnowledgeController unit tests (wiki/subMDs/frontend/knowledge_viewer.md).
 *
 * Covers:
 *   - Validation (fail-fast): the 7 TypeError cases (7.1.1–7.1.7).
 *   - Construction with all-empty fallback registries → empty-shape payload
 *     (7.1.8).
 *   - The getKnowledge() contract on realistic data:
 *       * sort orders (mappings by statKey; materials by type; recipes by id;
 *         items by type)
 *       * mapping-row normalization: single-filled rows pass through unchanged
 *         (7.1.9); a both-filled row is emitted as a formula row with its
 *         sources dropped (formula wins — the §3.2 wire contract; new test)
 *       * recipe item-name resolution + raw-type fallback (7.1.10)
 *       * item nullability/fallbacks + defensive-copy of traits (7.1.11)
 *       * the defensive-copy invariant (a returned payload is never internal
 *         state) (7.1.12)
 *
 * The fixtures mirror the real data/*.json shapes so the assertions are
 * meaningful against actual project data.
 *
 * @module test/unit/KnowledgeController
 */

import { describe, it, expect } from 'vitest';
import KnowledgeController from '../../src/controllers/knowledge/KnowledgeController.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';
import {
    TRAIT_GROUPS,
    STAT_NAMES,
    EXISTENCE_GONE_AT,
    EXISTENCE_USABLE_MIN,
    TRAIT_STAT_KEY_PATTERN,
} from '../../shared/StatVocabulary.js';

// ---------------------------------------------------------------------------
// Fixtures — mirror the real data/*.json shapes (see data/ for the source of
// truth). Kept intentionally small but representative.
// ---------------------------------------------------------------------------

/** @type {Object} data/traits.json */
const TRAITS = {
    Physical: {
        existence: 100, mass: 10, volume: 1, temperature: 20,
        strength: 10, sharpness: 10, flammability: 0,
    },
    Mind: { think_level: 10 },
    Spatial: { x: 0, y: 0 },
    Movement: {},
    Manipulation: { fine_controls: 10 },
};

/** @type {Object} data/propertyTraitMapping.json (flat "Group.stat" keys) */
const PROPERTY_TRAIT_MAPPING = {
    'Physical.mass': { formula: 'densityVolume' },
    'Physical.existence': {
        sources: { wearResistance: 0.5, impactResistance: 0.3, cutResistance: 0.2 },
    },
    'Physical.flammability': { sources: { flammability: 1.0 } },
};

/** @type {Object} data/materials.json */
const MATERIALS = {
    wood: {
        name: 'Wood', density: 0.6,
        properties: {
            flammability: 80, electricalConduction: 5, moistureRetention: 60,
            cutResistance: 20, impactResistance: 70, wearResistance: 30, heatConduction: 15,
        },
    },
    iron: {
        name: 'Iron', density: 7.8,
        properties: {
            flammability: 5, electricalConduction: 90, moistureRetention: 0,
            cutResistance: 85, impactResistance: 45, wearResistance: 80, heatConduction: 85,
        },
    },
};

/** @type {Object} data/crafting.json */
const CRAFTING = {
    single_knife_to_t1: {
        id: 'single_knife_to_t1',
        name: 'T1 Field Assembly',
        description: 'Forge a single knife into a T1 container weapon.',
        inputs: [{ type: 'knife', quantity: 1 }],
        outputs: [{ type: 't1', quantity: 1 }],
    },
    knife_to_t1: {
        id: 'knife_to_t1',
        name: 'T1 Assembly',
        description: 'Fuse two knives into one T1 container weapon.',
        inputs: [{ type: 'knife', quantity: 2 }],
        outputs: [{ type: 't1', quantity: 1 }],
    },
};

/** @type {Object} data/inventoryItems.json (subset, representative) */
const INVENTORY_ITEMS = {
    knife: {
        name: 'Knife',
        description: 'A sharp blade capable of cutting.',
        volume: 1,
        materials: [
            { material: 'iron', fraction: 0.6, role: 'blade' },
            { material: 'wood', fraction: 0.4, role: 'handle' },
        ],
        traits: { Physical: { existence: 30, sharpness: 50 } },
    },
    t1: {
        name: 'T1',
        description: 'A container weapon that fires stored items.',
        volume: 10,
        externalVolume: 1,
        traits: { Physical: { existence: 60 } },
    },
    powerCell: {
        name: 'Power Cell',
        description: 'Compact power source for droid systems.',
        volume: 2,
        traits: { Physical: { mass: 1, existence: 50 } },
    },
};

/**
 * Constructs a KnowledgeController from the full fixtures, allowing per-field
 * overrides so validation tests can corrupt a single registry in isolation.
 * @param {Object} [overrides]
 * @returns {KnowledgeController}
 */
function build(overrides = {}) {
    const {
        traits = TRAITS,
        materials = MATERIALS,
        propertyTraitMapping = PROPERTY_TRAIT_MAPPING,
        recipes = CRAFTING,
        items = INVENTORY_ITEMS,
    } = overrides;
    return new KnowledgeController({ traits, materials, propertyTraitMapping, recipes, items });
}

// ---------------------------------------------------------------------------
// VALIDATION — fail-fast at boot (wiki/subMDs/frontend/knowledge_viewer.md)
// ---------------------------------------------------------------------------

describe('KnowledgeController — validation (fail-fast)', () => {
    it('7.1.1 rejects a non-object registry (array and null) for each of the five inputs', () => {
        for (const input of ['traits', 'materials', 'propertyTraitMapping', 'recipes', 'items']) {
            expect(() => build({ [input]: null }), `${input} = null`).toThrow(TypeError);
            expect(() => build({ [input]: [] }), `${input} = []`).toThrow(TypeError);
        }
    });

    it('7.1.2 rejects a mapping key that does not match the flat Group.stat pattern', () => {
        // no dot
        expect(() => build({ propertyTraitMapping: { OnlyOneSegment: { formula: 'x' } } })).toThrow(TypeError);
        // two dots
        expect(() => build({ propertyTraitMapping: { 'A.b.c': { formula: 'x' } } })).toThrow(TypeError);
        // digits in the group segment
        expect(() => build({ propertyTraitMapping: { '123.mass': { formula: 'x' } } })).toThrow(TypeError);
        // a space inside the stat segment
        expect(() => build({ propertyTraitMapping: { 'Physical.dur ability': { formula: 'x' } } })).toThrow(TypeError);
        // a hyphen (not in the allowed character set) in the stat segment
        expect(() => build({ propertyTraitMapping: { 'Physical.dur-ability': { formula: 'x' } } })).toThrow(TypeError);
    });

    it('7.1.3 rejects a mapping entry with neither a non-empty formula nor a non-empty sources object', () => {
        expect(() => build({ propertyTraitMapping: { 'Physical.mass': {} } })).toThrow(TypeError);
        expect(() => build({ propertyTraitMapping: { 'Physical.mass': { formula: '' } } })).toThrow(TypeError);
        expect(() => build({ propertyTraitMapping: { 'Physical.mass': { sources: {} } } })).toThrow(TypeError);
    });

    it('7.1.4 rejects a recipe that references an item type absent from the item registry (cross-check)', () => {
        const recipes = {
            bad: {
                id: 'bad',
                name: 'Bad',
                inputs: [{ type: 'knife', quantity: 1 }],
                outputs: [{ type: 'ghost', quantity: 1 }],
            },
        };
        // knife exists, ghost does not → cross-check throws.
        expect(() => build({ recipes, items: { knife: { name: 'Knife' } } })).toThrow(TypeError);
    });

    it('7.1.5 rejects a recipe with an empty inputs array', () => {
        const recipes = {
            bad: {
                id: 'bad',
                name: 'Bad',
                inputs: [],
                outputs: [{ type: 'knife', quantity: 1 }],
            },
        };
        expect(() => build({ recipes, items: { knife: { name: 'Knife' } } })).toThrow(TypeError);
    });

    it('7.1.6 rejects a material entry with a non-object properties', () => {
        expect(() => build({ materials: { wood: { name: 'Wood', density: 0.6, properties: 'nope' } } })).toThrow(TypeError);
        expect(() => build({ materials: { wood: { name: 'Wood', density: 0.6, properties: null } } })).toThrow(TypeError);
    });

    it('7.1.7 rejects an item entry with a non-numeric volume', () => {
        expect(() => build({ items: { knife: { name: 'Knife', volume: 'big' } } })).toThrow(TypeError);
    });

    it('the shared TRAIT_STAT_KEY_PATTERN source is byte-identical to the former local literal (spec §2 R3)', () => {
        expect(TRAIT_STAT_KEY_PATTERN.source).toBe('^[A-Za-z]+\\.[A-Za-z_]+$');
    });
});

// ---------------------------------------------------------------------------
// CONSTRUCTION — empty / fallback registries (wiki/subMDs/frontend/knowledge_viewer.md)
// ---------------------------------------------------------------------------

describe('KnowledgeController — empty fallback construction', () => {
    it('7.1.8 all-empty fallback registries (five {}) construct fine; getKnowledge() returns the full envelope shape with all three sections present and empty (vocabulary populated)', () => {
        const kc = new KnowledgeController({
            traits: {},
            materials: {},
            propertyTraitMapping: {},
            recipes: {},
            items: {},
        });

        const k = kc.getKnowledge();
        expect(k).toEqual({
            traitStats: {
                groups: {},
                mappings: [],
                materials: [],
                vocabulary: {
                    traitGroups: Object.values(TRAIT_GROUPS),
                    stats: Object.values(STAT_NAMES),
                    existence: { goneAt: EXISTENCE_GONE_AT, usableMin: EXISTENCE_USABLE_MIN },
                },
            },
            recipes: [],
            items: [],
        });
    });
});

// ---------------------------------------------------------------------------
// getKnowledge() CONTRACT (wiki/subMDs/frontend/knowledge_viewer.md)
// ---------------------------------------------------------------------------

describe('KnowledgeController — getKnowledge() contract', () => {
    it('sorts materials by type, recipes by id, and items by type', () => {
        const k = build().getKnowledge();

        const mTypes = k.traitStats.materials.map((m) => m.type);
        expect(mTypes).toEqual([...mTypes].sort());
        expect(mTypes).toEqual(['iron', 'wood']);

        const rIds = k.recipes.map((r) => r.id);
        expect(rIds).toEqual([...rIds].sort());
        expect(rIds).toEqual(['knife_to_t1', 'single_knife_to_t1']);

        const iTypes = k.items.map((i) => i.type);
        expect(iTypes).toEqual([...iTypes].sort());
        expect(iTypes).toEqual(['knife', 'powerCell', 't1']);
    });

    it('7.1.9 mappings: sorted by statKey; formula rows → sources []; source rows → formula null; sources sorted by property', () => {
        const mappings = build().getKnowledge().traitStats.mappings;

        // sorted by statKey
        const keys = mappings.map((m) => m.statKey);
        expect(keys).toEqual(['Physical.existence', 'Physical.flammability', 'Physical.mass']);

        // formula row: sources must be the empty array
        const mass = mappings.find((m) => m.statKey === 'Physical.mass');
        expect(mass.trait).toBe('Physical');
        expect(mass.stat).toBe('mass');
        expect(mass.formula).toBe('densityVolume');
        expect(mass.sources).toEqual([]);

        // source row: formula must be null; sources expanded + sorted by property
        const existence = mappings.find((m) => m.statKey === 'Physical.existence');
        expect(existence.formula).toBe(null);
        expect(existence.sources).toEqual([
            { property: 'cutResistance', weight: 0.2 },
            { property: 'impactResistance', weight: 0.3 },
            { property: 'wearResistance', weight: 0.5 },
        ]);

        const flammability = mappings.find((m) => m.statKey === 'Physical.flammability');
        expect(flammability.formula).toBe(null);
        expect(flammability.sources).toEqual([{ property: 'flammability', weight: 1.0 }]);
    });

    it('a both-filled mapping entry passes boot validation and is emitted as a formula row (sources dropped — §3.2 wire contract)', () => {
        const kc = build({
            propertyTraitMapping: {
                'A.f': { formula: 'densityVolume', sources: { lightness: 1 } },
                'B.s': { formula: null, sources: { grip: 0.5 } },
            },
        });
        const mappings = kc.getKnowledge().traitStats.mappings;
        const aRow = mappings.find((m) => m.statKey === 'A.f');
        expect(aRow.formula).toBe('densityVolume');
        expect(aRow.sources).toEqual([]);
        const bRow = mappings.find((m) => m.statKey === 'B.s');
        expect(bRow.formula).toBe(null);
        expect(bRow.sources).toEqual([{ property: 'grip', weight: 0.5 }]);
    });

    it('7.1.10 recipe input/output name equals the item registry name; an unresolvable type falls back to the raw type string', () => {
        // Resolved names from the item registry (real data)
        const k = build().getKnowledge();
        const knifeToT1 = k.recipes.find((r) => r.id === 'knife_to_t1');
        expect(knifeToT1.name).toBe('T1 Assembly');
        expect(knifeToT1.description).toBe('Fuse two knives into one T1 container weapon.');
        expect(knifeToT1.inputs).toEqual([{ type: 'knife', quantity: 2, name: 'Knife' }]);
        expect(knifeToT1.outputs).toEqual([{ type: 't1', quantity: 1, name: 'T1' }]);

        // Defensive fallback: the type exists in the registry but has no name
        // (name is validated elsewhere at boot), so the display name falls back
        // to the raw type string — never an ID-shaped label.
        const kb = new KnowledgeController({
            traits: {},
            materials: {},
            propertyTraitMapping: {},
            recipes: {
                r: {
                    id: 'r',
                    name: 'R',
                    inputs: [{ type: 'ghost', quantity: 1 }],
                    outputs: [{ type: 'ghost', quantity: 1 }],
                },
            },
            items: { ghost: { volume: 1 } },
        });
        const row = kb.getKnowledge().recipes[0];
        expect(row.inputs).toEqual([{ type: 'ghost', quantity: 1, name: 'ghost' }]);
        expect(row.outputs).toEqual([{ type: 'ghost', quantity: 1, name: 'ghost' }]);
    });

    it('7.1.11 item rows: missing externalVolume/description/materials → null; missing volume → DEFAULT_ITEM_VOLUME (0); traits is a deep copy', () => {
        const k = build().getKnowledge();

        // powerCell: no externalVolume, no materials → null; description present
        const powerCell = k.items.find((i) => i.type === 'powerCell');
        expect(powerCell.externalVolume).toBe(null);
        expect(powerCell.materials).toBe(null);
        expect(powerCell.description).toBe('Compact power source for droid systems.');
        expect(powerCell.volume).toBe(2);

        // t1: has externalVolume, no materials → null
        const t1 = k.items.find((i) => i.type === 't1');
        expect(t1.externalVolume).toBe(1);
        expect(t1.materials).toBe(null);

        // bare item: missing volume → DEFAULT_ITEM_VOLUME (0), description →
        // null, materials → null, traits → {}
        const kb = new KnowledgeController({
            traits: {},
            materials: {},
            propertyTraitMapping: {},
            recipes: {},
            items: { bare: { name: 'Bare' } },
        });
        const bare = kb.getKnowledge().items.find((i) => i.type === 'bare');
        expect(bare.volume).toBe(DEFAULT_ITEM_VOLUME); // 0
        expect(bare.description).toBe(null);
        expect(bare.externalVolume).toBe(null);
        expect(bare.materials).toBe(null);
        expect(bare.traits).toEqual({});

        // defensive-copy of traits: mutating the returned copy must not change
        // a second call's result
        const first = kb.getKnowledge();
        first.items.find((i) => i.type === 'bare').traits.Physical = { existence: 9999 };
        const second = kb.getKnowledge();
        expect(second.items.find((i) => i.type === 'bare').traits).toEqual({});
    });

    it('7.1.12 a returned payload is a defensive copy — mutating a nested value does not change a second call', () => {
        const kc = build();
        const a = kc.getKnowledge();

        // Mutate deeply nested values across all three sections.
        a.traitStats.materials.find((m) => m.type === 'wood').properties.flammability = -1;
        a.traitStats.groups.Physical.existence = 0;
        a.recipes.find((r) => r.id === 'knife_to_t1').name = 'HACKED';
        a.items.find((i) => i.type === 'knife').materials[0].fraction = 99;

        const b = kc.getKnowledge();
        expect(b.traitStats.materials.find((m) => m.type === 'wood').properties.flammability).toBe(80);
        expect(b.traitStats.groups.Physical.existence).toBe(100);
        expect(b.recipes.find((r) => r.id === 'knife_to_t1').name).toBe('T1 Assembly');
        expect(b.items.find((i) => i.type === 'knife').materials[0].fraction).toBe(0.6);
    });

    it('groups is a deep copy of the traits registry (group order preserved) and vocabulary is pinned from the shared module', () => {
        const k = build().getKnowledge();

        // Deep-copied verbatim, group order preserved (insertion order of the
        // data file).
        expect(k.traitStats.groups).toEqual(TRAITS);
        expect(Object.keys(k.traitStats.groups)).toEqual(Object.keys(TRAITS));

        // Mutating the returned groups must not corrupt the source registry.
        k.traitStats.groups.Physical.existence = 0;
        expect(TRAITS.Physical.existence).toBe(100);

        // Vocabulary pinned from shared/StatVocabulary.js (not a data file).
        expect(k.traitStats.vocabulary.existence).toEqual({
            goneAt: EXISTENCE_GONE_AT,
            usableMin: EXISTENCE_USABLE_MIN,
        });
        expect(k.traitStats.vocabulary.traitGroups).toEqual(Object.values(TRAIT_GROUPS));
        expect(k.traitStats.vocabulary.stats).toEqual(Object.values(STAT_NAMES));
    });
});

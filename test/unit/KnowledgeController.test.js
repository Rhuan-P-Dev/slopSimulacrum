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
 *   - Item capabilities (the server-derived `capabilities` block): equip state
 *     from the holdingCost list, capacity/footprint, the actions the item's base
 *     stats satisfy, matter derivation when the recipe declares no traits, and the
 *     graceful degradation when the capability inputs are absent.
 *   - The `actions` section: every action as a row (name, description, its stat
 *     gate normalized, the full raw definition), sorted, with the same fail-fast
 *     validation and defensive-copy rules as the other sections.
 *   - The `definitions` section (knowledge_viewer.md Sec. 12): one row per
 *     top-level entry of every registry the codex does not show on its own tab,
 *     with the references a reader would otherwise have to look up resolved
 *     server-side, the entry kept verbatim, and the same fail-fast rules.
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

/** @type {Object} data/mods/core-traits/traits.json */
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

/** @type {Object} data/mods/core-property-trait-mapping/propertyTraitMapping.json (flat "Group.stat" keys) */
const PROPERTY_TRAIT_MAPPING = {
    'Physical.mass': { formula: 'densityVolume' },
    'Physical.existence': {
        sources: { wearResistance: 0.5, impactResistance: 0.3, cutResistance: 0.2 },
    },
    'Physical.flammability': { sources: { flammability: 1.0 } },
};

/** @type {Object} data/mods/core-materials/materials.json */
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

/** @type {Object} data/mods/core-crafting/crafting.json */
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

/** @type {Object} data/mods/core-inventory-items/inventoryItems.json (subset, representative) */
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
 * data/mods/core-actions/actions.json (subset, representative): requirements
 * gate on STATS only — no action names an item type, which is exactly why the
 * codex has to derive the item's stats to answer "what can it do".
 * @type {Object}
 */
const ACTIONS = {
    _comment: 'metadata key — must never surface as an action',
    cut: {
        description: 'Slice the target with an equipped knife.',
        requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: 20 }],
    },
    punch: {
        description: 'Strike with raw strength.',
        requirements: [{ trait: 'Physical', stat: 'strength', minValue: 15 }],
    },
    shootT1: {
        description: 'Fire your T1 weapon.',
        requirements: [{ trait: 'Physical', stat: 'existence', minValue: 0.01 }],
    },
    // A universal action: it declares no requirements at all.
    touch: { description: 'Touch it.' },
};

/**
 * data/mods/core-holding-cost/holdingCost.json (the massBurden model): its
 * `equipableItems` list is the ONLY per-item equip data the world declares.
 * @type {Object}
 */
const HOLDING_COST = { model: 'massBurden', equipableItems: ['knife', 't1'] };

/**
 * The Entities registries (knowledge_viewer.md Sec. 12) — one slice of every
 * shape data/mods/core-* actually uses: a keyed map of objects, an id mapped to
 * an array of `[part, slot]` rows (the engine's own blueprint form), a bare
 * number per key, a metadata key, null and empty entries, and rows that
 * reference the three lookup tables (materials, items, recipes).
 * @type {Object<string, *>}
 */
const DEFINITIONS = {
    components: {
        _comment: 'metadata key — must never surface as a row',
        head: {
            name: 'Head',
            form: { volume: 3 },
            materials: [{ material: 'iron', fraction: 1 }],
            internalComponents: ['sensor'],
        },
        // A legacy top-level volume, the precedence the item rows already mirror.
        leg: { name: 'Leg', volume: 5, materials: [{ material: 'wood', fraction: 1 }] },
        // The other label field the registries use, and a legacy top-level volume.
        tail: { displayName: 'Tail Unit', volume: 2 },
    },
    internalComponents: { sensor: { name: 'Proximity Sensor', form: { volume: 1 } } },
    blueprints: {
        walker: ['head', ['leg', 'left'], { type: 'leg', slot: 'right' }],
        authoredNothing: [],
        nullEntry: null,
    },
    sensitiveParts: { sensitivityOfZero: 0, sensitivityOfNinety: 90 },
    rooms: {
        cave: { name: 'The Cave' },
        start: { name: 'Start Room', connections: { north: { target: 'cave' }, secret: 'unresolved_key' } },
    },
    worldObjects: { statue: { name: 'Statue', room: 'start', blueprint: 'walker' } },
    npcs: { guard: { name: 'Guard', room: 'cave', initialItems: [{ item: 'knife', count: 2 }] } },
    machines: { forge: { name: 'Forge', blueprint: 'walker', itemKey: 'knife', recipeId: 'single_knife_to_t1' } },
    effects: { burning: { name: 'Burning', durationRounds: 3 } },
    outfits: { m1: [{ item: 'knife', component: 'hand' }] },
    entityAttributes: { attributes: { m1Droid: { Pleasure: { pleasure: 0 } } } },
};

/**
 * The matter→stats authority, stubbed: the codex receives it as a function, so a
 * test can hand it any derivation without a MaterialController.
 * @param {Object} itemDef
 * @returns {Object}
 */
function deriveStats(itemDef) {
    return { Physical: { mass: (itemDef.form?.volume ?? itemDef.volume ?? 1) * 7.8, existence: 1, sharpness: 70 } };
}

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
        actions = ACTIONS,
        holdingCost = HOLDING_COST,
        deriveStatsFn = deriveStats,
        definitions = DEFINITIONS,
    } = overrides;
    return new KnowledgeController({
        traits,
        materials,
        propertyTraitMapping,
        recipes,
        items,
        actions,
        holdingCost,
        deriveStats: deriveStatsFn,
        definitions,
    });
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
    it('7.1.8 all-empty fallback registries construct fine; getKnowledge() returns the full envelope shape with every section present and empty (vocabulary populated)', () => {
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
            actions: [],
            // An absent `definitions` injection is a degraded section, not a missing
            // key: the envelope keeps its shape so the client needs no special case.
            definitions: [],
            // The tab map, spelled out rather than computed by the code under test.
            // A kind earns its tab from the vocabulary, not from rows existing, so
            // the bar survives a degraded set of registries
            // (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12).
            // The bar the payload carries: each family its codex view tabs and its
            // kind tabs (`sections` / `kinds`).
            definitionGroups: [
                {
                    id: 'parts',
                    label: 'Parts',
                    sections: ['traitStats', 'materials', 'items'],
                    kinds: ['components', 'internalComponents', 'sensitiveParts'],
                },
                { id: 'blueprints', label: 'Blueprints', sections: ['recipes'], kinds: ['blueprints', 'machines'] },
                { id: 'world', label: 'World', sections: [], kinds: ['world', 'rooms', 'worldObjects'] },
                { id: 'characters', label: 'Characters', sections: [], kinds: ['npcs', 'outfits', 'entityAttributes'] },
                {
                    id: 'data',
                    label: 'Data',
                    sections: ['actions'],
                    kinds: ['holdingCost', 'worldRules', 'effects', 'synergy', 'materialDamageTypes', 'materialDropRates'],
                },
            ],
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

// ---------------------------------------------------------------------------
// ITEM CAPABILITIES — derived at assembly, never authored in data
// ---------------------------------------------------------------------------

describe('KnowledgeController — item capabilities (derived from the registries)', () => {
    // A custom item registry must not carry the default recipes along: the boot
    // cross-check rejects a recipe naming an item type the registry lacks.
    const rows = (overrides = {}) => {
        const input = overrides.items !== undefined && overrides.recipes === undefined
            ? { ...overrides, recipes: {} }
            : overrides;
        const byType = {};
        for (const row of build(input).getKnowledge().items) byType[row.type] = row;
        return byType;
    };

    it('an equipable item lists every action its base stats satisfy, sorted', () => {
        // knife declares sharpness 50 + existence 30: cut, shootT1 and the
        // requirement-free touch all pass; punch (strength 15) does not.
        expect(rows().knife.capabilities.actions.map((a) => a.name)).toEqual(['cut', 'shootT1', 'touch']);
        expect(rows().knife.capabilities.actions[0].description).toBe('Slice the target with an equipped knife.');
        // t1 declares existence only — no sharpness, so no cut (the requirement
        // gate is ALL-present-and-met, exactly as the capability scan applies it).
        expect(rows().t1.capabilities.actions.map((a) => a.name)).toEqual(['shootT1', 'touch']);
    });

    it('a non-equipable item enables nothing, however capable its stats look', () => {
        const cell = rows().powerCell.capabilities;
        expect(cell.equipable).toBe(false);
        expect(cell.actions).toEqual([]);
    });

    it('capacity is the item volume and footprint the declared external volume', () => {
        const cap = rows();
        // Storing is the generic inventory rule (any item holds up to its own
        // volume), so capacity is the volume; the footprint is what it takes on
        // the host — the T1 holds 10 while occupying 1.
        expect(cap.knife.capabilities.capacity).toBe(1);
        expect(cap.knife.capabilities.footprint).toBe(1);
        expect(cap.t1.capabilities.capacity).toBe(10);
        expect(cap.t1.capabilities.footprint).toBe(1);
    });

    it('derives base stats from matter when the recipe declares no traits', () => {
        const crate = rows({ items: { crate: { name: 'Crate', form: { volume: 4 }, materials: [{ material: 'iron', fraction: 1 }] } } }).crate;
        expect(crate.capabilities.baseStats).toEqual({ Physical: { mass: 31.2, existence: 1, sharpness: 70 } });
        expect(crate.capabilities.actions).toEqual([]); // not equipable
    });

    it('explicit recipe traits outrank matter derivation', () => {
        // The knife fixture declares sharpness 50; the deriveStats stub would say
        // 70. The recipe wins, mirroring the equip flow (BUG-134 seeding guard).
        expect(rows().knife.capabilities.baseStats).toEqual({ Physical: { existence: 30, sharpness: 50 } });
    });

    it('a gate with no minValue bounds nothing: the stat only has to be present', () => {
        // The engine's offer rule (componentCapabilityController
        // ._checkRequirementsForHostComponent) reads `value < undefined` as false,
        // so an unbounded requirement asks only that the stat exist. A NEGATIVE stat
        // is where "no bound" and "a bound of 0" part company - the case that used to
        // make the codex hide an action the world still offered.
        const wire = rows({
            deriveStatsFn: () => ({ Physical: { sharpness: -5, existence: 1 } }),
            items: { wire: { name: 'Wire', form: { volume: 1 }, materials: [{ material: 'iron', fraction: 1 }] } },
            holdingCost: { model: 'massBurden', equipableItems: ['wire'] },
            actions: {
                unbounded: { description: 'Needs a sharpness, any sharpness.', requirements: [{ trait: 'Physical', stat: 'sharpness' }] },
                absent: { description: 'Needs a stat this item does not carry.', requirements: [{ trait: 'Movement', stat: 'move' }] },
            },
        }).wire;
        expect(wire.capabilities.baseStats.Physical.sharpness).toBe(-5);
        expect(wire.capabilities.actions.map((a) => a.name)).toEqual(['unbounded']);
    });

    it('keeps the existence baseline when matter derivation omits it', () => {
        const made = rows({
            deriveStatsFn: () => ({ Physical: { mass: 5 } }),
            items: { wire: { name: 'Wire', form: { volume: 1 }, materials: [{ material: 'iron', fraction: 1 }] } },
        }).wire;
        expect(made.capabilities.baseStats.Physical.existence).toBe(1);
    });

    it('an item with no materials and no traits carries no stats', () => {
        const bare = rows({ items: { bare: { name: 'Bare' } } }).bare;
        expect(bare.capabilities.baseStats).toEqual({});
        expect(bare.capabilities.actions).toEqual([]);
    });

    it('externalVolume reads form.externalVolume first (the engine footprint rule)', () => {
        const row = rows({ items: { t1form: { name: 'T1 Form', form: { volume: 10, externalVolume: 1 } } } }).t1form;
        expect(row.externalVolume).toBe(1);
        expect(row.capabilities.footprint).toBe(1);
    });

    it('degrades without the capability inputs: no actions, no crash, not equipable', () => {
        const kb = new KnowledgeController({
            traits: TRAITS,
            materials: MATERIALS,
            propertyTraitMapping: PROPERTY_TRAIT_MAPPING,
            recipes: CRAFTING,
            items: INVENTORY_ITEMS,
        });
        const knife = kb.getKnowledge().items.find((i) => i.type === 'knife');
        expect(knife.capabilities.equipable).toBe(false);
        expect(knife.capabilities.actions).toEqual([]);
        expect(knife.capabilities.baseStats).toEqual({ Physical: { existence: 30, sharpness: 50 } });
    });

    it('rejects a malformed actions / holdingCost registry and a non-function deriveStats', () => {
        expect(() => build({ actions: null })).toThrow(TypeError);
        expect(() => build({ actions: [] })).toThrow(TypeError);
        expect(() => build({ holdingCost: 'nope' })).toThrow(TypeError);
        expect(() => build({ deriveStatsFn: 'nope' })).toThrow(TypeError);
    });

    it('capabilities survive the defensive copy (never internal state)', () => {
        const kb = build();
        const first = kb.getKnowledge();
        first.items.find((i) => i.type === 'knife').capabilities.actions.push({ name: 'invented' });
        const second = kb.getKnowledge();
        expect(second.items.find((i) => i.type === 'knife').capabilities.actions.map((a) => a.name))
            .toEqual(['cut', 'shootT1', 'touch']);
    });
});

// ---------------------------------------------------------------------------
// ACTIONS SECTION — every action with its stat gate
// ---------------------------------------------------------------------------

describe('KnowledgeController — actions section', () => {
    it('lists every action sorted by name, skipping metadata and non-object entries', () => {
        const actions = build().getKnowledge().actions;
        expect(actions.map((a) => a.name)).toEqual(['cut', 'punch', 'shootT1', 'touch']);
    });

    it('spells out the requirement gate and carries the full raw definition', () => {
        const [cut] = build().getKnowledge().actions.filter((a) => a.name === 'cut');
        expect(cut.description).toBe('Slice the target with an equipped knife.');
        expect(cut.requirements).toEqual([{ trait: 'Physical', stat: 'sharpness', minValue: 20 }]);
        expect(cut.definition.requirements[0].minValue).toBe(20);
    });

    it('an action that declares no gate is universal (requirements [])', () => {
        const [touch] = build().getKnowledge().actions.filter((a) => a.name === 'touch');
        expect(touch.requirements).toEqual([]);
    });

    it('reads a lone requirement object as a one-row gate', () => {
        const actions = build({
            items: {},
            recipes: {},
            actions: { solo: { description: 'x', requirements: { trait: 'Movement', stat: 'move', minValue: 3 } } },
        }).getKnowledge().actions;
        expect(actions[0].requirements).toEqual([{ trait: 'Movement', stat: 'move', minValue: 3 }]);
    });

    it('explains what an action does in its summary, in the engine\'s own words', () => {
        const actions = build({
            items: {},
            recipes: {},
            actions: {
                cut: {
                    description: 'Slice the target.',
                    targetingType: 'component',
                    range: 50,
                    prose: { verbPhrase: 'cut something', instrumental: { verb: 'cut' } },
                    requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: 20 }],
                    consequences: [{ type: 'damageComponent', target: 'target', params: { channel: 'cut', value: ':Physical.sharpness' } }],
                    failureConsequences: [{ type: 'log', target: 'entity', level: 'warn', message: 'too dull' }],
                },
            },
        }).getKnowledge().actions;
        const summary = actions[0].summary;
        expect(summary.targeting).toBe('targets a component');
        expect(summary.targetingDeclared).toBe(true);
        expect(summary.range).toBe(50);
        expect(summary.narration).toBe('cut something (instrumental: cut)');
        expect(summary.effects[0].text).toBe('deals cut damage, scaled by Physical.sharpness (resolved at run time)');
        expect(summary.effects[0].on).toBe('the target');
        expect(summary.failureEffects[0].text).toBe('records a warn entry: too dull');
    });

    it('carries an unrecognized targeting type through the payload, raw and flagged', () => {
        const actions = build({ items: {}, recipes: {}, actions: { whisper: { targetingType: 'psychic' } } })
            .getKnowledge().actions;
        expect(actions[0].summary.targeting).toBe('psychic');
        expect(actions[0].summary.targetingDeclared).toBe(false);
        // The raw value is also still in the definition, as always.
        expect(actions[0].definition.targetingType).toBe('psychic');
    });

    it('summarizes a consequence-free action as empty lists, not a missing key', () => {
        const actions = build({ items: {}, recipes: {}, actions: { plain: { description: 'x' } } })
            .getKnowledge().actions;
        expect(actions[0].summary.effects).toEqual([]);
        expect(actions[0].summary.failureEffects).toEqual([]);
        expect(actions[0].summary.targeting).toBeNull();
        expect(actions[0].summary.narration).toBeNull();
    });

    it('nulls a missing requirement field and skips malformed gate entries', () => {
        const actions = build({
            items: {},
            recipes: {},
            actions: {
                odd: { requirements: [{ stat: 'strength' }, { trait: 'Physical' }, null, 7, 'nope'] },
                naked: {},
            },
        }).getKnowledge().actions;
        expect(actions.find((a) => a.name === 'odd').requirements).toEqual([
            { trait: null, stat: 'strength', minValue: null },
            { trait: 'Physical', stat: null, minValue: null },
        ]);
        expect(actions.find((a) => a.name === 'naked').requirements).toEqual([]);
        expect(actions.find((a) => a.name === 'naked').description).toBeNull();
    });

    it('degrades to an empty section when the action registry was not injected', () => {
        const kb = new KnowledgeController({ traits: TRAITS, materials: MATERIALS, propertyTraitMapping: PROPERTY_TRAIT_MAPPING, recipes: CRAFTING, items: INVENTORY_ITEMS });
        expect(kb.getKnowledge().actions).toEqual([]);
    });

    it('rejects an action entry that is not an object and a gate that is a scalar', () => {
        expect(() => build({ actions: { bad: 'nope' } })).toThrow(TypeError);
        expect(() => build({ actions: { bad: [] } })).toThrow(TypeError);
        expect(() => build({ actions: { bad: { requirements: 5 } } })).toThrow(TypeError);
    });

    it('rejects a gate minValue that is neither absent nor a finite number', () => {
        // `value < '20'` coerces by luck and `NaN` never passes: neither has a
        // reading the engine could give, so the codex refuses the registry at boot.
        expect(() => build({
            items: {}, recipes: {},
            actions: { bad: { requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: '20' }] } },
        })).toThrow(TypeError);
        expect(() => build({
            items: {}, recipes: {},
            actions: { bad: { requirements: { trait: 'Physical', stat: 'sharpness', minValue: NaN } } },
        })).toThrow(TypeError);
        // Absent or null is legal: it means "no bound", not "a broken bound".
        expect(() => build({
            items: {}, recipes: {},
            actions: { ok: { requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: null }] } },
        })).not.toThrow();
    });

    it('the actions section survives the defensive copy', () => {
        const kb = build();
        const first = kb.getKnowledge();
        first.actions.push({ name: 'invented' });
        first.actions[0].requirements.push({ trait: 'X', stat: 'y', minValue: 0 });
        const second = kb.getKnowledge();
        expect(second.actions.map((a) => a.name)).toEqual(['cut', 'punch', 'shootT1', 'touch']);
        expect(second.actions[0].requirements).toEqual([{ trait: 'Physical', stat: 'sharpness', minValue: 20 }]);
    });
});

// ---------------------------------------------------------------------------
// ENTITIES — every registry the codex does not show on its own tab
// (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12)
// ---------------------------------------------------------------------------

describe('KnowledgeController — definitions section (Sec. 12)', () => {
    /** All rows of one kind, in payload order. @returns {Array<Object>} */
    const rowsOf = (kb, kind) => kb.getKnowledge().definitions.filter((r) => r.kind === kind);
    /** One facet's value by label, or null when the row does not carry it. @returns {string|null} */
    const facet = (row, label) => row.facets.find((f) => f.label === label)?.value ?? null;

    it('one row per top-level entry; metadata keys and null entries are not entries', () => {
        const kb = build();
        expect(rowsOf(kb, 'components').map((r) => r.id)).toEqual(['head', 'leg', 'tail']);
        // Ids sort inside a kind (code-unit order, like every other section).
        expect(rowsOf(kb, 'sensitiveParts').map((r) => r.id))
            .toEqual(['sensitivityOfNinety', 'sensitivityOfZero']);
        // A null entry has nothing to show; an empty blueprint IS an entry (the
        // author wrote it, and "this blueprint has no parts" is a fact to display).
        expect(rowsOf(kb, 'blueprints').map((r) => r.id)).toEqual(['authoredNothing', 'walker']);
    });

    it('groups by kind in the shared vocabulary order, and never repeats an owned kind', () => {
        const rows = build().getKnowledge().definitions;
        const kinds = [...new Set(rows.map((r) => r.kind))];
        expect(kinds.indexOf('components')).toBeLessThan(kinds.indexOf('blueprints'));
        expect(kinds.indexOf('blueprints')).toBeLessThan(kinds.indexOf('rooms'));
        expect(kinds.indexOf('rooms')).toBeLessThan(kinds.indexOf('worldObjects'));
        // The kinds with a tab of their own are lookup tables here, never rows.
        for (const owned of ['traits', 'propertyTraitMapping', 'materials', 'crafting', 'inventoryItems', 'actions']) {
            expect(kinds).not.toContain(owned);
        }
    });

    it('resolves the references a reader would otherwise have to look up', () => {
        const kb = build();
        const head = rowsOf(kb, 'components').find((r) => r.id === 'head');
        expect(facet(head, 'volume')).toBe('3');
        expect(facet(head, 'composition')).toBe('Iron x1');
        expect(facet(head, 'organs')).toBe('Proximity Sensor');
        // The legacy top-level volume is read with the runtime's own precedence.
        expect(facet(rowsOf(kb, 'components').find((r) => r.id === 'leg'), 'volume')).toBe('5');
        // A blueprint's children, with the slot a mounted part hangs on.
        const walker = rowsOf(kb, 'blueprints').find((r) => r.id === 'walker');
        expect(facet(walker, 'parts')).toBe('Head, Leg [left], Leg [right]');
        // A room's doors, the far room named; a door with no readable target keeps
        // its own key rather than inventing a destination.
        expect(facet(rowsOf(kb, 'rooms').find((r) => r.id === 'start'), 'exits'))
            .toBe('north -> The Cave, secret');
        const statue = rowsOf(kb, 'worldObjects')[0];
        expect(facet(statue, 'room')).toBe('Start Room');
        expect(facet(statue, 'blueprint')).toBe('walker');
        const forge = rowsOf(kb, 'machines')[0];
        expect(facet(forge, 'item')).toBe('Knife');
        expect(facet(forge, 'recipe')).toBe('T1 Field Assembly');
        expect(facet(rowsOf(kb, 'npcs')[0], 'carries')).toBe('Knife x2');
        expect(facet(rowsOf(kb, 'outfits')[0], 'wears')).toBe('Knife on hand');
    });

    it('gives a bare scalar entry a facet, so its only datum is not hidden', () => {
        const rows = rowsOf(build(), 'sensitiveParts');
        expect(facet(rows[0], 'value')).toBe('90');
        expect(facet(rows[1], 'value')).toBe('0');
    });

    it('names a row only from what the entry declares (name, else displayName)', () => {
        const kb = build();
        expect(rowsOf(kb, 'components').find((r) => r.id === 'head').name).toBe('Head');
        expect(rowsOf(kb, 'components').find((r) => r.id === 'tail').name).toBe('Tail Unit');
        // An array entry declares no name: the card titles itself with the id.
        expect(rowsOf(kb, 'blueprints')[0].name).toBeNull();
        expect(rowsOf(kb, 'components').find((r) => r.id === 'head').description).toBeNull();
    });

    it('carries the entry verbatim, and survives the defensive copy', () => {
        const kb = build();
        const head = rowsOf(kb, 'components').find((r) => r.id === 'head');
        expect(head.definition).toEqual(DEFINITIONS.components.head);
        expect(rowsOf(kb, 'blueprints').find((r) => r.id === 'walker').definition)
            .toEqual(DEFINITIONS.blueprints.walker);
        const first = kb.getKnowledge();
        const length = first.definitions.length;
        first.definitions[0].definition.name = 'MUTATED';
        first.definitions[0].facets.push({ label: 'invented', value: 'x' });
        first.definitions.push({ kind: 'invented', id: 'x' });
        const second = kb.getKnowledge();
        expect(second.definitions).toHaveLength(length);
        expect(second.definitions[0].definition.name).not.toBe('MUTATED');
        expect(second.definitions[0].facets.find((f) => f.label === 'invented')).toBeUndefined();
    });

    it('degrades to an empty Entities section when no registries are injected', () => {
        // Built without `definitions` at all: a degraded codex, warned at boot,
        // never a boot failure (the same rule the capability inputs follow).
        const kb = new KnowledgeController({
            traits: TRAITS, materials: MATERIALS, propertyTraitMapping: PROPERTY_TRAIT_MAPPING,
            recipes: CRAFTING, items: INVENTORY_ITEMS,
        });
        expect(kb.getKnowledge().definitions).toEqual([]);
    });

    it('fail-fast: rejects an input it cannot enumerate, and a kind it has no tab for', () => {
        expect(() => build({ definitions: [] })).toThrow(TypeError);
        expect(() => build({ definitions: 'components' })).toThrow(TypeError);
        // A kind the codex already shows on its own tab is not an Entities kind:
        // it would surface the same data twice, in two different shapes.
        for (const owned of ['traits', 'propertyTraitMapping', 'materials', 'crafting', 'inventoryItems', 'actions']) {
            expect(() => build({ definitions: { [owned]: {} } }), owned).toThrow(TypeError);
        }
        // A mistyped kind would drop a whole group in silence, so it is refused too.
        expect(() => build({ definitions: { compnents: {} } })).toThrow(TypeError);
        // An entry that is neither absent nor enumerable is refused, while the
        // shapes the data really uses (map, array) pass.
        expect(() => build({ definitions: { components: 7 } })).toThrow(TypeError);
        expect(() => build({ definitions: { components: {}, blueprints: ['head'] } })).not.toThrow();
        expect(() => build({ definitions: {} })).not.toThrow();
    });
});

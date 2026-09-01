/**
 * KnowledgePanel (CLIENT) unit tests — knowledge_viewer_spec.md §7.3.
 *
 * Per the client-testing convention (pattern:
 * test/unit/CraftingPanel.test.js, test/unit/EventLogPanel.client.test.js),
 * these tests exercise ONLY the exported pure functions of
 * public/js/KnowledgePanel.js — no raw DOM, no fetch:
 *
 *   16. unwrapKnowledgeEnvelope — `{ knowledge: {...} }` -> payload; a bare
 *       object without the key / a non-object body / null -> the provided
 *       empty-shape fallback (default: EMPTY_KNOWLEDGE); a null fallback
 *       reports "malformed" (the panel routes that to the error state).
 *   17. escapeHtml — the five HTML special characters (& < > " ') are
 *       escaped in every server-derived string that gets interpolated.
 *   18. The pure section shapers (shapeMappings / shapeMaterials /
 *       shapeRecipes / shapeItems / shapeVocabulary) — nullability rules
 *       (spec §3), deterministic output for shuffled-equivalent input
 *       (sorted order), and malformed rows (non-object entries, non-array
 *       lists) are skipped rather than throwing.
 *   19. The label contract — the exported label constants equal the exact
 *       spec §6 English strings, character for character.
 *   20. Default tab — the default active section is the traits section
 *       (the first tab).
 *
 * @module test/unit/KnowledgePanel
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    unwrapKnowledgeEnvelope,
    escapeHtml,
    shapeMappings,
    shapeMaterials,
    shapeRecipes,
    shapeItems,
    shapeVocabulary,
    KNOWLEDGE_LABELS,
    SECTION_IDS,
    DEFAULT_SECTION,
    EMPTY_KNOWLEDGE,
    KnowledgePanel,
} from '../../public/js/KnowledgePanel.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';
import {
    TRAIT_GROUPS,
    STAT_NAMES,
    EXISTENCE_GONE_AT,
    EXISTENCE_USABLE_MIN,
} from '../../shared/StatVocabulary.js';

// --- Fixtures ------------------------------------------------------------------

/** A well-formed knowledge payload (mirrors the GET /knowledge §3 shape). */
const VALID_PAYLOAD = {
    traitStats: {
        groups: {
            Physical: { existence: 10, strength: 4 },
            Movement: { speed: 2 },
        },
        mappings: [
            {
                statKey: 'Physical.existence',
                trait: 'Physical',
                stat: 'existence',
                formula: 'densityVolume',
                sources: [],
            },
            {
                statKey: 'Movement.speed',
                trait: 'Movement',
                stat: 'speed',
                formula: null,
                sources: [
                    { property: 'lightness', weight: 1 },
                    { property: 'smoothness', weight: 0.5 },
                ],
            },
        ],
        materials: [
            { type: 'wood', name: 'Wood', density: 12, properties: { lightness: 8 } },
            { type: 'iron', name: 'Iron', density: 78, properties: { lightness: 1 } },
        ],
        vocabulary: {
            traitGroups: ['Physical', 'Movement', 'Manipulation'],
            stats: ['existence', 'strength', 'sharpness', 'volume'],
            existence: { goneAt: 0, usableMin: 1 },
        },
    },
    recipes: [
        {
            id: 'knife_to_t1',
            name: 'T1 Assembly',
            description: 'Fuse two knives into one T1 container weapon.',
            inputs: [{ type: 'knife', quantity: 2, name: 'Knife' }],
            outputs: [{ type: 't1', quantity: 1, name: 'T1 Container' }],
        },
        {
            id: 'dual_recipe',
            name: 'Dual',
            description: null,
            inputs: [{ type: 'a', quantity: 1, name: 'A' }],
            outputs: [{ type: 'c', quantity: 1, name: 'C' }],
        },
    ],
    items: [
        {
            type: 'knife',
            name: 'Knife',
            description: 'A sharp tool.',
            volume: 2,
            externalVolume: null,
            materials: [{ material: 'iron', fraction: 1, role: null }],
            traits: { Physical: { sharpness: 5 } },
        },
        {
            type: 't1',
            name: 'T1 Container',
            description: null,
            volume: 10,
            externalVolume: 14,
            materials: null,
            traits: {},
        },
    ],
};

// --- 16. unwrapKnowledgeEnvelope -------------------------------------------------

describe('unwrapKnowledgeEnvelope', () => {
    it('unwraps a well-formed { knowledge: {...} } envelope to the payload', () => {
        const unwrapped = unwrapKnowledgeEnvelope({ knowledge: VALID_PAYLOAD });
        expect(unwrapped).toBe(VALID_PAYLOAD);
    });

    it('returns the default empty-shape fallback for a bare object without the key', () => {
        expect(unwrapKnowledgeEnvelope({ other: 1 })).toBe(EMPTY_KNOWLEDGE);
    });

    it('returns the default fallback for non-object bodies (null, string, number, array)', () => {
        expect(unwrapKnowledgeEnvelope(null)).toBe(EMPTY_KNOWLEDGE);
        expect(unwrapKnowledgeEnvelope('nope')).toBe(EMPTY_KNOWLEDGE);
        expect(unwrapKnowledgeEnvelope(42)).toBe(EMPTY_KNOWLEDGE);
        expect(unwrapKnowledgeEnvelope([1, 2])).toBe(EMPTY_KNOWLEDGE);
    });

    it('returns the default fallback when knowledge is null or an array', () => {
        expect(unwrapKnowledgeEnvelope({ knowledge: null })).toBe(EMPTY_KNOWLEDGE);
        expect(unwrapKnowledgeEnvelope({ knowledge: [] })).toBe(EMPTY_KNOWLEDGE);
    });

    it('honors a provided fallback, including null (the panel "malformed" sentinel)', () => {
        const custom = { sentinel: true };
        expect(unwrapKnowledgeEnvelope('bad', custom)).toBe(custom);
        expect(unwrapKnowledgeEnvelope(null, null)).toBeNull();
    });
});

// --- 17. escapeHtml ----------------------------------------------------------------
// NOTE: every entity literal below is built by concatenation so the source
// text never contains a raw entity (write-time tooling that HTML-decodes
// file content would otherwise corrupt both the inputs and the expected
// values — same technique as public/js/CraftingPanel.js's escapeHtml).

describe('escapeHtml', () => {
    const AMP = '&' + 'amp;';
    const LT = '&' + 'lt;';
    const GT = '&' + 'gt;';
    const QUOT = '&' + 'quot;';
    const APOS = '&' + '#39;';

    it('escapes the five HTML special characters (& < > " \')', () => {
        expect(escapeHtml('&')).toBe(AMP);
        expect(escapeHtml('<')).toBe(LT);
        expect(escapeHtml('>')).toBe(GT);
        expect(escapeHtml('"')).toBe(QUOT);
        expect(escapeHtml("'")).toBe(APOS);
    });

    it('escapes a mixed payload with & replaced FIRST', () => {
        expect(escapeHtml('<b>&"\'')).toBe(LT + 'b' + GT + AMP + QUOT + APOS);
    });

    it('re-escapes an input that already contains entity text (the entity ampersands are escaped, the literal characters are not)', () => {
        // Input: the literal text "<already>" (two ampersands, no angle
        // brackets). Only the ampersands are escaped; "lt;" / "gt;" are plain
        // characters and stay untouched.
        const input = LT + 'already' + GT;
        expect(escapeHtml(input)).toBe(AMP + 'lt;already' + AMP + 'gt;');
    });

    it('passes safe strings through unchanged and stringifies non-strings', () => {
        expect(escapeHtml('plain text 123')).toBe('plain text 123');
        expect(escapeHtml(7)).toBe('7');
        expect(escapeHtml(null)).toBe('null');
    });

    it('also escapes the backtick and equals-sign (the documented superset beyond the five HTML chars)', () => {
        expect(escapeHtml('`')).toBe('&#' + '96;');
        expect(escapeHtml('=')).toBe('&#' + '61;');
    });
});

// --- 18a. shapeMappings --------------------------------------------------------------

describe('shapeMappings', () => {
    it('returns rows sorted by statKey for shuffled-equivalent input (deterministic)', () => {
        const shuffled = [
            { statKey: 'B.stat2', formula: null, sources: [{ property: 'zeta', weight: 2 }] },
            { statKey: 'A.stat1', formula: 'densityVolume', sources: [] },
            { statKey: 'C.stat3', formula: null, sources: [{ property: 'alpha', weight: 1 }] },
        ];
        const rows = shapeMappings(shuffled);
        expect(rows.map((r) => r.statKey)).toEqual(['A.stat1', 'B.stat2', 'C.stat3']);
    });

    it('splits the flat statKey into trait and stat', () => {
        const rows = shapeMappings([{ statKey: 'Physical.existence', formula: 'densityVolume', sources: [] }]);
        expect(rows[0].trait).toBe('Physical');
        expect(rows[0].stat).toBe('existence');
    });

    it('keeps exactly one of formula / sources populated (the other defaults)', () => {
        const [formulaRow, sourcesRow] = shapeMappings([
            { statKey: 'A.f', formula: 'densityVolume', sources: [{ property: 'p', weight: 1 }] },
            { statKey: 'B.s', formula: null, sources: [{ property: 'p', weight: 1 }] },
        ]);
        expect(formulaRow.formula).toBe('densityVolume');
        expect(sourcesRow.formula).toBeNull();
        expect(sourcesRow.sources).toEqual([{ property: 'p', weight: 1 }]);
        expect(formulaRow.sources).toEqual([]);
    });

    it('sorts sources by property and normalizes non-numeric weights to 0', () => {
        const [row] = shapeMappings([
            { statKey: 'A.f', formula: null, sources: [{ property: 'zz', weight: 3 }, { property: 'aa', weight: 'bad' }] },
        ]);
        expect(row.sources).toEqual([
            { property: 'aa', weight: 0 },
            { property: 'zz', weight: 3 },
        ]);
    });

    it('skips non-object entries and rows without a statKey; non-array input yields []', () => {
        const rows = shapeMappings([
            'garbage',
            null,
            { formula: 'x' },
            { statKey: '', formula: 'x' },
            { statKey: 'A.f', formula: 'x', sources: [] },
        ]);
        expect(rows.map((r) => r.statKey)).toEqual(['A.f']);
        expect(shapeMappings(undefined)).toEqual([]);
        expect(shapeMappings({ statKey: 'A.f' })).toEqual([]);
    });
});

// --- 18b. shapeMaterials -------------------------------------------------------------

describe('shapeMaterials', () => {
    it('returns rows sorted by type (deterministic for shuffled input)', () => {
        const rows = shapeMaterials([
            { type: 'iron', name: 'Iron', density: 78, properties: {} },
            { type: 'wood', name: 'Wood', density: 12, properties: {} },
        ]);
        expect(rows.map((r) => r.type)).toEqual(['iron', 'wood']);
    });

    it('applies the nullability fallbacks: name -> type, density -> 0, properties filtered to numeric values', () => {
        const [row] = shapeMaterials([
            { type: 'wood', density: 'n/a', properties: { lightness: 8, junk: 'x' } },
        ]);
        expect(row.name).toBe('wood');
        expect(row.density).toBe(0);
        expect(row.properties).toEqual({ lightness: 8 });
    });

    it('skips non-object entries and rows without a type; non-array input yields []', () => {
        const rows = shapeMaterials([null, { name: 'NoType' }, { type: 'wood', name: 'Wood', density: 1, properties: {} }]);
        expect(rows.map((r) => r.type)).toEqual(['wood']);
        expect(shapeMaterials('nope')).toEqual([]);
    });
});

// --- 18c. shapeRecipes ----------------------------------------------------------------

describe('shapeRecipes', () => {
    it('returns rows sorted by id (deterministic for shuffled input)', () => {
        const rows = shapeRecipes([
            { id: 'zeta', name: 'Z', inputs: [], outputs: [] },
            { id: 'alpha', name: 'A', inputs: [], outputs: [] },
        ]);
        expect(rows.map((r) => r.id)).toEqual(['alpha', 'zeta']);
    });

    it('normalizes description to a string or null (missing and non-string both -> null)', () => {
        const rows = shapeRecipes([
            { id: 'a', name: 'A', description: 'desc' },
            { id: 'b', name: 'B' },
            { id: 'c', name: 'C', description: 42 },
        ]);
        expect(rows[0].description).toBe('desc');
        expect(rows[1].description).toBeNull();
        expect(rows[2].description).toBeNull();
    });

    it('falls back the recipe name to its id, and the item-ref name to the raw type (never an ID-shaped label)', () => {
        const [row] = shapeRecipes([
            {
                id: 'r1',
                name: '',
                inputs: [{ type: 'knife', quantity: 2 }, { quantity: 1 }],
                outputs: [{ type: 't1', quantity: 1, name: 'T1' }],
            },
        ]);
        expect(row.name).toBe('r1');
        expect(row.inputs).toEqual([{ type: 'knife', quantity: 2, name: 'knife' }]);
        expect(row.outputs).toEqual([{ type: 't1', quantity: 1, name: 'T1' }]);
    });

    it('falls back an invalid quantity to 1 and skips refs without a type', () => {
        const [row] = shapeRecipes([
            { id: 'r1', name: 'R', inputs: [{ type: 'a', quantity: -3 }, { type: 'b' }], outputs: [] },
        ]);
        expect(row.inputs.map((r) => r.quantity)).toEqual([1, 1]);
    });

    it('collapses non-array inputs/outputs to [] and skips non-object rows without an id', () => {
        const rows = shapeRecipes([
            { name: 'NoId', inputs: 'nope' },
            { id: 'r1', name: 'R', inputs: null, outputs: 'nope' },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].inputs).toEqual([]);
        expect(rows[0].outputs).toEqual([]);
        expect(shapeRecipes(null)).toEqual([]);
    });
});

// --- 18d. shapeItems ------------------------------------------------------------------

describe('shapeItems', () => {
    it('returns rows sorted by type (deterministic for shuffled input)', () => {
        const rows = shapeItems([
            { type: 't1', name: 'T1' },
            { type: 'knife', name: 'Knife' },
        ]);
        expect(rows.map((r) => r.type)).toEqual(['knife', 't1']);
    });

    it('applies the §3.4 nullability rules for a sparse item', () => {
        const [row] = shapeItems([{ type: 'knife', name: 'Knife' }]);
        expect(row.description).toBeNull();
        expect(row.volume).toBe(DEFAULT_ITEM_VOLUME);
        expect(row.externalVolume).toBeNull();
        expect(row.materials).toBeNull();
        expect(row.traits).toEqual({});
    });

    it('normalizes materials rows (role -> null when absent) and keeps numeric traits per group', () => {
        const [row] = shapeItems([
            {
                type: 'knife',
                name: 'Knife',
                volume: 2,
                externalVolume: 4,
                materials: [{ material: 'iron', fraction: 1 }, { fraction: 1 }],
                traits: { Physical: { sharpness: 5, junk: 'x' }, Movement: { } },
            },
        ]);
        expect(row.materials).toEqual([{ material: 'iron', fraction: 1, role: null }]);
        expect(row.traits).toEqual({ Physical: { sharpness: 5 } });
    });

    it('falls back the item name to the type and skips non-object rows without a type', () => {
        const rows = shapeItems([null, { name: 'NoType' }, { type: 'wood' }]);
        expect(rows.map((r) => r.name)).toEqual(['wood']);
        expect(shapeItems(undefined)).toEqual([]);
    });
});

// --- 18e. shapeVocabulary --------------------------------------------------------------

describe('shapeVocabulary', () => {
    it('passes a well-formed vocabulary through (including the two existence boundaries)', () => {
        const vocab = shapeVocabulary({
            traitGroups: ['Physical'],
            stats: ['existence'],
            existence: { goneAt: 0, usableMin: 1 },
        });
        expect(vocab.traitGroups).toEqual(['Physical']);
        expect(vocab.stats).toEqual(['existence']);
        expect(vocab.existence).toEqual({ goneAt: 0, usableMin: 1 });
    });

    it('falls back to the shared-module constants for malformed input', () => {
        const vocab = shapeVocabulary(null);
        expect(vocab.traitGroups).toEqual([]);
        expect(vocab.stats).toEqual([]);
        expect(vocab.existence).toEqual({
            goneAt: EXISTENCE_GONE_AT,
            usableMin: EXISTENCE_USABLE_MIN,
        });
        const partial = shapeVocabulary({ traitGroups: ['Physical', '', 42], existence: {} });
        expect(partial.traitGroups).toEqual(['Physical']);
        expect(partial.existence).toEqual({
            goneAt: EXISTENCE_GONE_AT,
            usableMin: EXISTENCE_USABLE_MIN,
        });
    });
});

// --- 19. Label contract (spec §6, character for character) ------------------------------

describe('KNOWLEDGE_LABELS (spec §6 contract)', () => {
    it('matches the exact spec strings', () => {
        expect(KNOWLEDGE_LABELS.BUTTON_TITLE).toBe('Knowledge');
        expect(KNOWLEDGE_LABELS.BUTTON_GLYPH).toBe('📚');
        expect(KNOWLEDGE_LABELS.PANEL_HEADER).toBe('🧠 Knowledge');
        expect(KNOWLEDGE_LABELS.TAB_TRAITS).toBe('Traits & Stats');
        expect(KNOWLEDGE_LABELS.TAB_CRAFTING).toBe('Crafting & Items');
        expect(KNOWLEDGE_LABELS.TAB_ITEMS).toBe('Items');
        expect(KNOWLEDGE_LABELS.ERROR_MESSAGE).toBe('Could not load the knowledge reference');
        expect(KNOWLEDGE_LABELS.ERROR_RETRY).toBe('Retry');
        expect(KNOWLEDGE_LABELS.EMPTY_TRAITS).toBe('No trait mappings defined');
        expect(KNOWLEDGE_LABELS.EMPTY_RECIPE).toBe('No recipes defined');
        expect(KNOWLEDGE_LABELS.EMPTY_ITEMS).toBe('No items defined');
    });

    it('the static index.html button and header carry the pinned §6 strings', () => {
        const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
        const btn = html.match(/<button[^>]*id="btn-knowledge"[^>]*>([\s\S]*?)<\/button>/);
        expect(btn).not.toBeNull();
        expect(btn[0]).toContain('title="Knowledge"');
        expect(btn[1]).toBe('📚');
        const overlay = html.match(/<div[^>]*id="knowledge-overlay"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/);
        expect(overlay).not.toBeNull();
        expect(overlay[1].trim()).toBe('🧠 Knowledge');
    });
});

// --- 20. Default tab behavior + empty-shape total ---------------------------------------

describe('default section and empty shape', () => {
    it('the default active section is the traits section (the first tab)', () => {
        expect(DEFAULT_SECTION).toBe(SECTION_IDS.TRAITS);
        const panel = new KnowledgePanel();
        expect(panel.activeSection).toBe('traitStats');
    });

    it('SECTION_IDS exposes exactly the three payload sections', () => {
        expect(Object.values(SECTION_IDS).sort()).toEqual(['items', 'recipes', 'traitStats']);
    });

    it('EMPTY_KNOWLEDGE has the total payload shape (all §3 keys present)', () => {
        expect(EMPTY_KNOWLEDGE).toEqual({
            traitStats: {
                groups: {},
                mappings: [],
                materials: [],
                vocabulary: {
                    traitGroups: Object.values(TRAIT_GROUPS),
                    stats: Object.values(STAT_NAMES),
                    existence: {
                        goneAt: EXISTENCE_GONE_AT,
                        usableMin: EXISTENCE_USABLE_MIN,
                    },
                },
            },
            recipes: [],
            items: [],
        });
    });

    it('the empty-shape payload yields per-section empty states, not an error (shapers yield [])', () => {
        expect(shapeMappings(EMPTY_KNOWLEDGE.traitStats.mappings)).toEqual([]);
        expect(shapeRecipes(EMPTY_KNOWLEDGE.recipes)).toEqual([]);
        expect(shapeItems(EMPTY_KNOWLEDGE.items)).toEqual([]);
    });
});

describe('shared/StatVocabulary pin (spec §5.2 / §3.2 canonical values)', () => {
    it('pins the exact trait group names, stat names, and existence boundaries', () => {
        expect(Object.values(TRAIT_GROUPS)).toEqual(['Physical', 'Movement', 'Manipulation', 'Mind']);
        expect(Object.values(STAT_NAMES)).toEqual([
            'existence', 'cut_resistance', 'impact_resistance', 'wear_resistance',
            'heat_resistance', 'electricity_resistance', 'corrosion_resistance',
            'mass', 'sharpness', 'volume', 'strength', 'move', 'fine_controls', 'think_level',
        ]);
        expect(EXISTENCE_GONE_AT).toBe(0);
        expect(EXISTENCE_USABLE_MIN).toBe(0);
    });
});

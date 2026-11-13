/**
 * KnowledgePanel (CLIENT) unit tests — wiki/subMDs/frontend/knowledge_viewer.md
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
 *       shapeRecipes / shapeItems / shapeVocabulary) and renderDefinitionListing
 *       (the full-field key: value listing) and renderRecipeRefs (clickable
 *       recipe item-ref chips; data-item = the raw item type) — nullability rules
 *       (spec §3), deterministic output for shuffled-equivalent input
 *       (sorted order), and malformed rows (non-object entries, non-array
 *       lists) are skipped rather than throwing.
 *   19. The label contract — the exported label constants equal the exact
 *       spec §6 English strings, character for character.
 *   20. Default tab — the default active section is the traits section
 *       (the first tab).
 *   21. shapeItems capabilities passthrough + renderItemCapabilities — the item
 *       card's "Capabilities" block (equip state, capacity vs footprint, the
 *       action chips, the derived base stats). The values are server-derived; the
 *       client normalizes defensively and computes nothing.
 *   22. shapeActions + renderActionCard — the Actions tab: every action with its
 *       stat gate spelled out (or the universal note), the server's reading of what
 *       it does (targeting, narration, one line per consequence with the party it
 *       lands on), the full field listing kept as a collapsed appendix, and raw red
 *       cells for anything the interpreter cannot read.
 *   23. The search state machine -- switching tabs drops the narrowing typed in
 *       the sub bar (it belonged to the tab being left), and the no-match state
 *       echoes whichever bar actually emptied the section.
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
    shapeActions,
    shapeVocabulary,
    renderDefinitionListing,
    renderRecipeRefs,
    renderItemCapabilities,
    renderActionCard,
    KNOWLEDGE_LABELS,
    SECTION_IDS,
    DEFAULT_SECTION,
    EMPTY_KNOWLEDGE,
    KnowledgePanel,
} from '../../public/js/KnowledgePanel.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';
import { filterKnowledge } from '../../public/js/KnowledgeSearch.js';
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

    it('carries the renderer visual block through (null when the material declares none)', () => {
        const [row] = shapeMaterials([{ type: 'tshirt', name: 'Tshirt', density: 1, properties: {}, visual: { hue: 32 } }]);
        expect(row.visual).toEqual({ hue: 32 });
        const [plain] = shapeMaterials([{ type: 'x', name: 'X', density: 1, properties: {} }]);
        expect(plain.visual).toBeNull();
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

    it('carries the full raw definition through as a `definition` field (null when the server omits it)', () => {
        const row = shapeItems([{
            type: 'knife',
            name: 'Knife',
            definition: { form: { volume: 1 }, visual: { hue: 32 }, internalComponents: ['a'] },
        }])[0];
        expect(row.definition).toEqual({ form: { volume: 1 }, visual: { hue: 32 }, internalComponents: ['a'] });
        expect(shapeItems([{ type: 'k', name: 'K' }])[0].definition).toBeNull();
    });

    it('shapes the server-derived capabilities block (equip state, capacity, actions, base stats)', () => {
        const [row] = shapeItems([{
            type: 'knife',
            name: 'Knife',
            capabilities: {
                equipable: true,
                capacity: 1,
                footprint: 1,
                baseStats: { Physical: { sharpness: 59.5, existence: 1, note: 'x' }, Movement: {} },
                actions: [{ name: 'shootT1', description: 'Fire.' }, { name: 'cut' }, null, { name: '' }],
            },
        }]);
        expect(row.capabilities.equipable).toBe(true);
        expect(row.capabilities.capacity).toBe(1);
        expect(row.capabilities.footprint).toBe(1);
        expect(row.capabilities.baseStats).toEqual({ Physical: { sharpness: 59.5, existence: 1 } });
        // rows without a usable name are dropped; the rest sort by name;
        // a missing description normalizes to null.
        expect(row.capabilities.actions).toEqual([
            { name: 'cut', description: null },
            { name: 'shootT1', description: 'Fire.' },
        ]);
    });

    it('caps capabilities to null when absent or malformed (never an empty shell)', () => {
        expect(shapeItems([{ type: 'k', name: 'K' }])[0].capabilities).toBeNull();
        expect(shapeItems([{ type: 'k', name: 'K', capabilities: 'nope' }])[0].capabilities).toBeNull();
        expect(shapeItems([{ type: 'k', name: 'K', capabilities: [] }])[0].capabilities).toBeNull();
        // A well-formed block with junk inside still normalizes (capacity -> null,
        // actions -> [], baseStats -> {}).
        expect(shapeItems([{ type: 'k', name: 'K', capabilities: { equipable: 'yes', capacity: 'big', actions: 'nope', baseStats: 5 } }])[0].capabilities)
            .toEqual({ equipable: false, capacity: null, footprint: null, baseStats: {}, actions: [] });
    });
});

// --- 21. renderItemCapabilities (the item card's capability row) ---------------

describe('renderItemCapabilities', () => {
    it('renders the equip state, the capacity/footprint pair, the action chips and the derived stats', () => {
        const html = renderItemCapabilities({
            equipable: true,
            capacity: 10,
            footprint: 1,
            baseStats: { Physical: { sharpness: 82.5, mass: 78 } },
            actions: [{ name: 'cut', description: 'Slice the target.' }, { name: 'shootT1', description: null }],
        });
        expect(html).toContain('knowledge-item-capabilities');
        expect(html).toContain('Capabilities');
        expect(html).toContain('Equipable');
        expect(html).toContain('Capacity 10');
        expect(html).toContain('occupies 1');
        // The equip state is a bordered flag of its own (green); the capacity is
        // plain text after it, not a second flag wearing the same class.
        expect(html).toContain('<span class="knowledge-capability-flag knowledge-capability-flag--equipable">Equipable</span>');
        // Each action is a cross-link button carrying the raw action name.
        expect(html).toContain('<button type="button" class="knowledge-capability-chip" data-action="cut" title="Slice the target.">');
        expect(html).toContain('data-action="shootT1"');
        expect(html).toContain('>shootT1<');
        expect(html).toContain('sharpness 82.5');
        expect(html).toContain('mass 78');
    });

    it('omits the footprint when it equals the capacity, and says "Not equipable"', () => {
        const html = renderItemCapabilities({
            equipable: false, capacity: 10, footprint: 10, baseStats: {}, actions: [],
        });
        expect(html).toContain('Not equipable');
        expect(html).toContain('Capacity 10');
        expect(html).not.toContain('occupies');
        expect(html).not.toContain('knowledge-capability-chip');
        // The other half of the flag: red, and never the green modifier.
        expect(html).toContain('<span class="knowledge-capability-flag knowledge-capability-flag--not-equipable">Not equipable</span>');
        expect(html).not.toContain('knowledge-capability-flag--equipable');
    });

    it('does not let the equip flag and the capacity read as one label', () => {
        // The reported symptom: the equip state and the capacity were two spans of
        // one unstyled class six pixels apart, so the card read "Equipable
        // Capacity 10". The flag is its own bordered element now and the shared
        // plain class is gone from the renderer - this pins both halves.
        const html = renderItemCapabilities({ equipable: true, capacity: 10, footprint: 1, baseStats: {}, actions: [] });
        expect(html).not.toContain('knowledge-capability-state');
        const flag = html.indexOf('knowledge-capability-flag');
        const capacity = html.indexOf('Capacity 10');
        expect(flag).toBeGreaterThan(-1);
        expect(capacity).toBeGreaterThan(flag);
        // One flag per card, whatever the state it reports.
        expect(html.match(/knowledge-capability-flag--/g) || []).toHaveLength(1);
    });

    it('escapes the action name inside the chip\'s data-action attribute', () => {
        const html = renderItemCapabilities({
            equipable: true, capacity: 1, footprint: 1, baseStats: {},
            actions: [{ name: 'a" onclick="bad()', description: null }],
        });
        expect(html).not.toContain('onclick="bad');
        expect(html).toContain('&' + 'quot;');
    });

    it('leaves volume to the card\'s own volume line', () => {
        const html = renderItemCapabilities({
            equipable: true, capacity: 1, footprint: 1, baseStats: { Physical: { volume: 1, sharpness: 5 } }, actions: [],
        });
        expect(html).not.toContain('volume 1');
        expect(html).toContain('sharpness 5');
    });

    it('escapes names, descriptions and stat labels', () => {
        const html = renderItemCapabilities({
            equipable: true,
            capacity: null,
            footprint: null,
            baseStats: { Physical: { 'a<img>': 1 } },
            actions: [{ name: 'x" onload=alert(1)', description: 'a <b> tag' }],
        });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<b>');
        expect(html).toContain('&' + 'quot;');
        expect(html).toContain('&' + 'lt;');
    });

    it('returns the empty string for missing, null and non-object input', () => {
        expect(renderItemCapabilities(undefined)).toBe('');
        expect(renderItemCapabilities(null)).toBe('');
        expect(renderItemCapabilities('nope')).toBe('');
        expect(renderItemCapabilities([])).toBe('');
    });
});

// --- 22. shapeActions / renderActionCard (the Actions tab) --------------------

describe('shapeActions', () => {
    it('sorts by name and keeps the §3 nullability rules', () => {
        const rows = shapeActions([
            { name: 'shootT1', requirements: [{ trait: 'Physical', stat: 'existence', minValue: 0.01 }] },
            { name: 'cut', description: 'Slice the target.', requirements: [] },
        ]);
        expect(rows.map((r) => r.name)).toEqual(['cut', 'shootT1']);
        expect(rows[0].description).toBe('Slice the target.');
        expect(rows[0].requirements).toEqual([]);
        expect(rows[0].definition).toBeNull();
        expect(rows[1].description).toBeNull();
        expect(rows[1].requirements).toEqual([{ trait: 'Physical', stat: 'existence', minValue: 0.01 }]);
    });

    it('nulls a missing requirement field instead of inventing one', () => {
        const [row] = shapeActions([{ name: 'x', requirements: [{ stat: 'strength' }, { trait: 'Physical' }] }]);
        expect(row.requirements).toEqual([
            { trait: null, stat: 'strength', minValue: null },
            { trait: 'Physical', stat: null, minValue: null },
        ]);
    });

    it('reads an absent or non-array gate as universal ([]), and skips malformed rows', () => {
        expect(shapeActions([{ name: 'touch' }])[0].requirements).toEqual([]);
        expect(shapeActions([{ name: 'x', requirements: 'nope' }])[0].requirements).toEqual([]);
        expect(shapeActions([{ name: 'x', requirements: [null, 5, { stat: 'move', minValue: 5 }] }])[0].requirements)
            .toEqual([{ trait: null, stat: 'move', minValue: 5 }]);
        expect(shapeActions([null, { description: 'no name' }, { name: 'ok' }]).map((r) => r.name)).toEqual(['ok']);
        expect(shapeActions(undefined)).toEqual([]);
    });

    it('shapes the summary defensively, keeping what the row declares', () => {
        const [row] = shapeActions([{
            name: 'a',
            summary: {
                targeting: 'targets a component', range: 5, narration: 7,
                effects: [{ type: 'log', text: 'x' }, { text: 'no type' }, null, 'nope'],
                failureEffects: 'nope',
            },
        }]);
        expect(row.summary.targeting).toBe('targets a component');
        expect(row.summary.range).toBe(5);
        expect(row.summary.narration).toBeNull();
        expect(row.summary.effects).toEqual([{ type: 'log', on: null, text: 'x', described: true }]);
        expect(row.summary.failureEffects).toEqual([]);
        const [bare] = shapeActions([{ name: 'b' }]);
        expect(bare.summary).toEqual({
            targeting: null, targetingDeclared: true, range: null, narration: null, effects: [], failureEffects: [],
        });
    });
});

describe('renderActionCard', () => {
    it('renders the name, description, the requirement gate and the full field listing', () => {
        const html = renderActionCard({
            name: 'cut',
            description: 'Slice the target with an equipped knife.',
            requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: 20 }],
            definition: { range: 50, targetingType: 'component', consequences: [{ type: 'damageComponent' }] },
        });
        expect(html).toContain('knowledge-action-card');
        expect(html).toContain('data-action="cut"');
        expect(html).toContain('Slice the target with an equipped knife.');
        expect(html).toContain('Requires');
        expect(html).toContain('Physical.sharpness');
        expect(html).toContain('&ge; 20');
        expect(html).toContain('range');
        expect(html).toContain('component');
        expect(html).toContain('damageComponent');
        // The dump survives, but as an appendix the reader opens, not as the card.
        expect(html).toContain('<details');
    });

    it('renders the server\'s reading: how it aims, what happens, on whom', () => {
        const html = renderActionCard({
            name: 'cut',
            requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: 20 }],
            definition: { range: 50 },
            summary: {
                targeting: 'targets a component',
                range: 50,
                narration: 'cut something (instrumental: cut)',
                effects: [
                    { type: 'damageComponent', on: 'the target', text: 'deals cut damage, scaled by Physical.sharpness', described: true },
                    { type: 'updateComponentStatDelta', on: 'the acting component', text: 'lowers Physical.sharpness by 1', described: true },
                ],
                failureEffects: [
                    { type: 'log', on: 'the acting entity', text: 'records a warn entry: too dull', described: true },
                ],
            },
        });
        expect(html).toContain('knowledge-action-how');
        expect(html).toContain('targets a component');
        expect(html).toContain('within 50');
        expect(html).toContain('cut something (instrumental: cut)');
        expect(html).toContain('On success');
        expect(html).toContain('deals cut damage, scaled by Physical.sharpness');
        expect(html).toContain('\u2192 the target');
        expect(html).toContain('lowers Physical.sharpness by 1');
        expect(html).toContain('If it fails');
        expect(html).toContain('records a warn entry: too dull');
        expect(html).toContain('knowledge-action-effects--failure');
    });

    it('shows an unrecognized targeting type raw and marked, not omitted', () => {
        const html = renderActionCard({
            name: 'whisper',
            requirements: [],
            definition: { targetingType: 'psychic' },
            summary: { targeting: 'psychic', targetingDeclared: false },
        });
        expect(html).toContain('knowledge-action-how-cell--undeclared');
        expect(html).toContain('>psychic<');
        expect(html).toContain('targeting type outside the known vocabulary');
        // A read type carries no such class.
        const known = renderActionCard({
            name: 'cut', requirements: [], definition: {},
            summary: { targeting: 'targets a component', targetingDeclared: true },
        });
        expect(known).toContain('>targets a component<');
        expect(known).not.toContain('--undeclared');
    });

    it('marks a consequence the interpreter does not know instead of hiding it', () => {
        const html = renderActionCard({
            name: 'odd',
            requirements: [],
            definition: { consequences: [{ type: 'meltIntoSunlight' }] },
            summary: {
                effects: [{ type: 'meltIntoSunlight', on: 'the target', text: 'runs the undeclared behavior "meltIntoSunlight"', described: false }],
                failureEffects: [],
            },
        });
        expect(html).toContain('knowledge-action-effect--undeclared');
        expect(html).toContain('undeclared behavior');
        // No failure rows means no failure block at all (not an empty heading).
        expect(html).not.toContain('If it fails');
    });

    it('still renders gate and raw listing when the summary is absent', () => {
        const html = renderActionCard({
            name: 'plain', requirements: [], definition: { range: 1 }, summary: null,
        });
        expect(html).not.toContain('knowledge-action-how');
        expect(html).not.toContain('knowledge-action-effects');
        expect(html).toContain('Raw definition');
        expect(html).toContain('range');
    });

    it('drops an effect row with no sentence, and escapes the sentence it keeps', () => {
        const html = renderActionCard({
            name: 'x',
            requirements: [],
            definition: {},
            summary: {
                effects: [
                    { type: 'log', on: null, text: '' },
                    { type: 'log', on: 'the <i>actor</i>', text: 'writes <b>notes</b>' },
                ],
            },
        });
        expect(html).toContain('writes &lt;b&gt;notes&lt;/b&gt;');
        expect(html).not.toContain('<b>notes</b>');
        expect(html).toContain('&gt;actor&lt;');
    });

    it('marks an action with no gate as universal', () => {
        const html = renderActionCard({ name: 'touch', description: null, requirements: [], definition: null });
        expect(html).toContain('knowledge-action-req--universal');
        expect(html).toContain('no requirements');
        expect(html).not.toContain('knowledge-item-fields');
    });

    it('shows a half-declared requirement as declared, never completed', () => {
        const html = renderActionCard({ name: 'x', requirements: [{ trait: null, stat: 'move', minValue: null }], definition: {} });
        expect(html).toContain('>move<');
        expect(html).not.toContain('&ge;');
    });

    it('escapes the name and the requirement key', () => {
        const html = renderActionCard({
            name: 'a<img>', requirements: [{ trait: 'A', stat: 'b<script>', minValue: 1 }], definition: {},
        });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script');
        expect(html).toContain('A.b' + '&' + 'lt;script&' + 'gt;');
    });

    it('returns the empty string for missing, null, non-object and unnamed rows', () => {
        expect(renderActionCard(undefined)).toBe('');
        expect(renderActionCard(null)).toBe('');
        expect(renderActionCard('cut')).toBe('');
        expect(renderActionCard({ description: 'nameless' })).toBe('');
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

// --- 18f. renderDefinitionListing (full-field key: value listing) -------------------

describe('renderDefinitionListing', () => {
    it('lists every field of the definition (skipping name/description and _-prefixed keys), nesting objects', () => {
        const html = renderDefinitionListing({
            name: 'Knife',
            description: 'A sharp tool.',
            _comment: 'x',
            form: { volume: 2 },
            traits: { Physical: { sharpness: 5 } },
        }, {});
        expect(html).toContain('form');
        expect(html).toContain('volume');
        expect(html).toContain('2');
        expect(html).toContain('traits');
        expect(html).toContain('Physical');
        expect(html).toContain('sharpness');
        // name / description / _comment are not rendered as their own rows.
        expect(html).not.toContain('A sharp tool.');
        expect(html).not.toContain('_comment');
    });

    it('renders known materials as clickable cross-links (display name + data-material = raw type), unknown as plain text', () => {
        const html = renderDefinitionListing({
            form: { volume: 1 },
            materials: [
                { material: 'iron', fraction: 1, role: 'blade' },
                { material: 'ghost', fraction: 1 },
            ],
        }, { iron: 'Iron' });
        expect(html).toContain('knowledge-material-link');
        expect(html).toContain('data-material="iron"');
        expect(html).toContain('Iron');
        expect(html).toContain('blade');
        // ghost (not in the registry) -> plain text, no navigation target.
        expect(html).not.toContain('data-material="ghost"');
        expect(html).toContain('ghost');
    });

    it('returns an empty string for absent, non-object, or empty definitions', () => {
        expect(renderDefinitionListing({}, {})).toBe('');
        expect(renderDefinitionListing(null)).toBe('');
        expect(renderDefinitionListing(undefined)).toBe('');
        expect(renderDefinitionListing('nope')).toBe('');
        expect(renderDefinitionListing([1, 2])).toBe('');
    });

    it('renders nested objects and scalars (used for the material visual block)', () => {
        const html = renderDefinitionListing({ hue: 32, saturation: 66, inner: { a: 1 } }, {});
        expect(html).toContain('hue');
        expect(html).toContain('32');
        expect(html).toContain('inner');
        expect(html).toContain('a');
        expect(html).toContain('1');
    });
});

// --- 18g. renderRecipeRefs (clickable recipe item-ref chips) -------------------------

describe('renderRecipeRefs', () => {
    it('renders each ref as a chip whose item name is a clickable button (data-item = raw type)', () => {
        const html = renderRecipeRefs([{ type: 'iron', quantity: 2, name: 'Iron' }, { type: 'wood', quantity: 1, name: 'Wood' }]);
        expect(html).toContain('knowledge-ref-item');
        expect(html).toContain('knowledge-recipe-ref');
        expect(html).toContain('data-item="iron"');
        expect(html).toContain('Iron');
        expect(html).toContain('data-item="wood"');
        expect(html).toContain('Wood');
        expect(html).toContain('2');
        expect(html).toContain('1');
    });

    it('falls back the ref name to the raw type', () => {
        const html = renderRecipeRefs([{ type: 'ghost', quantity: 3 }]);
        expect(html).toContain('data-item="ghost"');
        expect(html).toContain('ghost');
        expect(html).toContain('3');
    });

    it('returns "" for non-arrays and skips refs without a usable type', () => {
        expect(renderRecipeRefs(null)).toBe('');
        expect(renderRecipeRefs('nope')).toBe('');
        expect(renderRecipeRefs([{ quantity: 1, name: 'NoType' }, { name: 'Other' }])).toBe('');
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
        expect(KNOWLEDGE_LABELS.TAB_MATERIALS).toBe('Materials');
        expect(KNOWLEDGE_LABELS.EMPTY_MATERIALS).toBe('No materials defined');
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

    it('keeps material cross-links when the search narrowed the Materials tab', () => {
        // The regression this pins: filtering traitStats.materials also emptied
        // the name map the Items cards use for their cross-links, turning links
        // into plain text. Reference data must not be filtered with the display.
        const payload = {
            items: [{ type: 'knife', name: 'Knife', definition: { materials: [{ material: 'iron', quantity: 1 }] } }],
            recipes: [],
            actions: [],
            traitStats: { groups: {}, mappings: [], materials: [{ type: 'iron', name: 'Iron' }] },
        };
        const panel = new KnowledgePanel();
        panel._payload = payload;
        panel._activeSection = 'items';
        const filtered = filterKnowledge(payload, { query: 'knife', activeSection: 'items' });
        expect(Object.keys(filtered.payload.traitStats.materials)).toEqual([]);
        const html = panel._renderSection(filtered.payload, filtered.display, true, payload);
        expect(html).toContain('knowledge-material-link');
        expect(html).toContain('Iron');
        // The session-payload fallback keeps the same result when no reference is
        // passed (the render path always passes one; the fallback is for callers
        // that have only the cached payload).
        expect(panel._renderSection(filtered.payload, filtered.display, true)).toContain('knowledge-material-link');
    });

    it('answers a search with the search empty state, not the data empty state', () => {
        const payload = {
            items: [{ type: 'knife', name: 'Knife', definition: {} }],
            recipes: [],
            actions: [],
            traitStats: { groups: {}, mappings: [], materials: [] },
        };
        const panel = new KnowledgePanel();
        panel._payload = payload;
        panel._activeSection = 'items';
        const filtered = filterKnowledge(payload, { query: 'zzz-not-a-thing', activeSection: 'items' });
        const html = panel._renderSection(filtered.payload, filtered.display, true);
        expect(html).toContain('knowledge-search-empty');
        expect(html).not.toContain(KNOWLEDGE_LABELS.EMPTY_ITEMS);
        // Without a search, the same empty list is the DATA's empty state again.
        expect(panel._renderSection(payload, {}, false)).not.toContain('knowledge-search-empty');
    });

    /**
     * A panel instance with a payload and no DOM: every search method below is a
     * pure state-or-HTML step, and `_render()` early-returns without a content
     * node, so the state transitions are checkable without a browser.
     * @param {Object} payload
     * @returns {KnowledgePanel}
     */
    // waiver: TST-1 -- these tests drive the panel's private search state and render
    // steps (_query, _refine, _focusRole, _onSearchInput, _bindTabs, _render) because
    // the client has no DOM harness: with no document, the public surface (init plus
    // real clicks and keystrokes) cannot be reached at all. Removal condition: the
    // client gains a DOM harness, and these become clicks and keystrokes instead.
    const searchPanel = (payload) => {
        const panel = new KnowledgePanel();
        panel._payload = { traitStats: { groups: {}, mappings: [], materials: [] }, ...payload };
        return panel;
    };

    it('renders the global bar with the term, its clear button and the total count', () => {
        const panel = searchPanel({ items: [{ type: 'iron', name: 'Iron thing', definition: {} }], recipes: [], actions: [] });
        panel._query = 'iron';
        const html = panel._renderSearchBar(filterKnowledge(panel._payload, { query: 'iron' }));
        expect(html).toContain('knowledge-search-input');
        expect(html).toContain('value="iron"');
        expect(html).toContain('knowledge-search-clear');
        expect(html).toContain('1 match');
    });

    it('omits the clear button while a bar is empty, and pluralizes above one', () => {
        const panel = searchPanel({ items: [{ type: 'a' }, { type: 'b' }], recipes: [], actions: [] });
        const html = panel._renderSearchBar(filterKnowledge(panel._payload, {}));
        expect(html).not.toContain('knowledge-search-clear');
        expect(html).toContain('value=""');
        expect(panel._formatCount(0)).toBe('0 matches');
        expect(panel._formatCount(2)).toBe('2 matches');
    });

    it('the sub bar names the tab it narrows and counts what that tab shows', () => {
        const panel = searchPanel({ items: [{ type: 'iron' }, { type: 'coal' }], recipes: [], actions: [] });
        panel._activeSection = 'items';
        panel._query = 'iron';
        panel._refine = 'zzz';
        const filtered = filterKnowledge(panel._payload, { query: 'iron', refine: 'zzz', activeSection: 'items' });
        const html = panel._renderRefineBar(filtered);
        expect(html).toContain('knowledge-refine-input');
        expect(html).toContain('Items');
        expect(html).toContain('knowledge-refine-clear');
        expect(html).toContain('0 matches');
    });

    it('clearing the global bar also clears the narrowing; clearing the sub bar does not', () => {
        const panel = searchPanel({ items: [], recipes: [], actions: [] });
        panel._query = 'iron';
        panel._refine = 'dull';
        panel._clearSearch(true);
        expect(panel._refine).toBe('');
        expect(panel._query).toBe('iron');
        panel._clearSearch(false);
        expect(panel._query).toBe('');
    });

    it('switching tabs drops the narrowing that belonged to the tab being left', () => {
        // Stubbed tab buttons and content node; the REAL click handler and the REAL
        // render, so what is asserted is what the reader gets.
        const panel = searchPanel({ items: [{ type: 'iron', name: 'Iron thing', definition: {} }], recipes: [], actions: [] });
        const clicks = {};
        const tabs = ['items', 'recipes'].map((section) => ({
            dataset: { section },
            addEventListener: (_event, handler) => { clicks[section] = handler; },
        }));
        panel._content = {
            innerHTML: '',
            querySelectorAll: (selector) => (selector === '.knowledge-tab' ? tabs : []),
            querySelector: () => null,
        };
        panel._activeSection = 'recipes';
        panel._refine = 'zzz';
        panel._focusRole = 'refine';
        panel._bindTabs();
        clicks.items();
        expect(panel._activeSection).toBe('items');
        expect(panel._refine).toBe('');
        expect(panel._focusRole).toBeNull();
        // The rendered tab proves the drop: 'zzz' carried over would have filtered
        // this single item away and shown the no-match state instead.
        expect(panel._content.innerHTML).toContain('iron');
        // A click on the tab already on screen is not a switch: nothing resets.
        panel._refine = 'kept';
        clicks.items();
        expect(panel._refine).toBe('kept');
    });

    it('the no-match state echoes the bar that emptied the section', () => {
        const panel = searchPanel({ items: [], recipes: [], actions: [] });
        // A narrowing alone: the global bar is empty, so the sub bar is the echo.
        panel._query = '';
        panel._refine = 'dull';
        expect(panel._renderNoMatch()).toContain('dull');
        // With both terms, the reader's main term is the one to show.
        panel._query = 'iron';
        const html = panel._renderNoMatch();
        expect(html).toContain('iron');
        expect(html).not.toContain('dull');
        // Neither: the message stands alone (an empty term span, not a stray word).
        panel._query = '';
        panel._refine = '';
        expect(panel._renderNoMatch()).toContain('knowledge-search-empty-term');
    });

    it('_isClearTarget recognizes the two clear buttons and nothing else', () => {
        const panel = searchPanel({ items: [], recipes: [], actions: [] });
        const target = (cls) => ({ classList: { contains: (c) => c === cls } });
        expect(panel._isClearTarget(target('knowledge-search-clear'))).toBe(true);
        expect(panel._isClearTarget(target('knowledge-refine-clear'))).toBe(true);
        expect(panel._isClearTarget(target('knowledge-tab'))).toBe(false);
        expect(panel._isClearTarget(null)).toBe(false);
    });

    it('a keystroke in either bar updates that bar only and remembers where to refocus', () => {
        const panel = searchPanel({ items: [], recipes: [], actions: [] });
        panel._onSearchInput({
            target: { classList: { contains: (c) => c === 'knowledge-search-input' }, value: 'iron', selectionStart: 2 },
        });
        expect(panel._query).toBe('iron');
        expect(panel._focusRole).toBe('query');
        expect(panel._caret).toBe(2);
        panel._onSearchInput({
            target: { classList: { contains: (c) => c === 'knowledge-refine-input' }, value: 'dull', selectionStart: 1 },
        });
        expect(panel._refine).toBe('dull');
        expect(panel._query).toBe('iron');
        expect(panel._focusRole).toBe('refine');
        // Any other input is not the search's business.
        panel._onSearchInput({ target: { classList: { contains: () => false }, value: 'x' } });
        expect(panel._refine).toBe('dull');
    });

    it('restores focus and caret after the re-render, and survives an input without a range', () => {
        // The keystroke replaces the whole DOM, so this is the only thing keeping
        // the bar focused while a word is typed. Stubbed content node, real method.
        const calls = [];
        const panel = searchPanel({ items: [], recipes: [], actions: [] });
        const input = {
            value: 'iron',
            focus: () => calls.push('focus'),
            setSelectionRange: (a, b) => calls.push(`range:${a},${b}`),
        };
        panel._content = { querySelector: (sel) => (sel === '.knowledge-search-input' ? input : null) };
        panel._focusRole = 'query';
        panel._caret = 3;
        panel._restoreSearchFocus();
        expect(calls).toEqual(['focus', 'range:3,3']);
        // A caret past the text clamps to its end (the term was cleared from elsewhere).
        panel._caret = 99;
        panel._restoreSearchFocus();
        expect(calls[calls.length - 1]).toBe('range:4,4');
        // An input without setSelectionRange: focus, and no throw.
        panel._content = { querySelector: () => ({ value: 'x', focus: () => calls.push('focus-no-range') }) };
        expect(() => panel._restoreSearchFocus()).not.toThrow();
        expect(calls).toContain('focus-no-range');
        // No role, no probe.
        panel._focusRole = null;
        panel._content = { querySelector: () => { throw new Error('must not be asked'); } };
        expect(() => panel._restoreSearchFocus()).not.toThrow();
    });

    it('SECTION_IDS exposes exactly the five payload sections', () => {
        expect(Object.values(SECTION_IDS).sort()).toEqual(['actions', 'items', 'materials', 'recipes', 'traitStats']);
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
            actions: [],
        });
    });

    it('the empty-shape payload yields per-section empty states, not an error (shapers yield [])', () => {
        expect(shapeMappings(EMPTY_KNOWLEDGE.traitStats.mappings)).toEqual([]);
        expect(shapeRecipes(EMPTY_KNOWLEDGE.recipes)).toEqual([]);
        expect(shapeItems(EMPTY_KNOWLEDGE.items)).toEqual([]);
        expect(shapeActions(EMPTY_KNOWLEDGE.actions)).toEqual([]);
    });
});

describe('shared/StatVocabulary pin (spec §5.2 / §3.2 canonical values)', () => {
    it('pins the exact trait group names, stat names, and existence boundaries', () => {
        // Pleasure: the whole-entity pleasure meter (seeded for the human
        // droids; see data/mods/core-entity-attributes/entityAttributes.json).
        expect(Object.values(TRAIT_GROUPS)).toEqual(['Physical', 'Movement', 'Manipulation', 'Mind', 'Pleasure']);
        expect(Object.values(STAT_NAMES)).toEqual([
            'existence', 'cut_resistance', 'impact_resistance', 'wear_resistance',
            'heat_resistance', 'electricity_resistance', 'corrosion_resistance',
            'mass', 'sharpness', 'volume', 'strength', 'move', 'fine_controls', 'think_level',
            'energy', 'pleasure',
        ]);
        expect(EXISTENCE_GONE_AT).toBe(0);
        expect(EXISTENCE_USABLE_MIN).toBe(0);
    });
});

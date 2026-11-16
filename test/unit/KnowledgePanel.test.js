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
 *   24. The Entities rows (knowledge_viewer.md Sec. 12) -- shapeDefinitions keeps
 *       the rows it can name and drops the rest, kindGroupLabel pluralizes a
 *       registry kind into a heading, renderDefinitionBody prints every shape the
 *       registries use (object, array, scalar), and the tab groups one card per
 *       definition under its kind.
 *   25. The family bands (knowledge_viewer.md Sec. 12) -- the bar is drawn from
 *       the server's `definitionGroups`, and a family's row holds BOTH the codex
 *       view tabs it names in `sections` and one tab per kind; the view tab ids
 *       are exactly the panel's own `SECTION_IDS`, so a family can place a view
 *       but cannot invent one.
 *   26. The facet links of a definition card -- a facet part naming an entry of
 *       another registry (the matter a component is made of, the organ it carries)
 *       renders as a button carrying that target's kind and id, and the jump lands
 *       on the tab that kind lives on: `referenceTabIdOf` returns the codex view a
 *       kind belongs to, or the kind's own `def:<kind>` tab, or null when this
 *       payload has no such tab. The map from kind to view is pinned against the
 *       server's `CODEX_TAB_OWNED_KINDS` -- the list the server uses to EXCLUDE
 *       those kinds from the definition tabs -- so a kind cannot lose its
 *       destination on one side of the wire.
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
    shapeDefinitions,
    kindGroupLabel,
    renderDefinitionBody,
    renderFacetValue,
    referenceTabIdOf,
    VIEW_TAB_OF_REFERENCE_KIND,
    KNOWLEDGE_LABELS,
    SECTION_IDS,
    DEFAULT_SECTION,
    EMPTY_KNOWLEDGE,
    KnowledgePanel,
} from '../../public/js/KnowledgePanel.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import { filterKnowledge } from '../../public/js/KnowledgeSearch.js';
// The server's band vocabulary, pinned against the panel's own tab ids below; and
// the kinds the server keeps OUT of the definition tabs, pinned against the tab
// this panel sends a facet link to.
import {
    CODEX_TAB_SECTION_IDS,
    CODEX_TAB_OWNED_KINDS,
} from '../../src/controllers/knowledge/definitionSemantics.js';
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

    it('SECTION_IDS exposes the codex\'s own tabs (the kind tabs are not in it)', () => {
        // `definitions` is a payload section and the search's unit, but no longer a
        // tab id: the tab ids for it are `def:<kind>`, built from the payload, and
        // a client that named them here would be naming registries (Sec. 12).
        expect(Object.values(SECTION_IDS).sort())
            .toEqual(['actions', 'items', 'materials', 'recipes', 'traitStats']);
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
            definitions: [],
            definitionGroups: [],
        });
    });

    it('the empty-shape payload yields per-section empty states, not an error (shapers yield [])', () => {
        expect(shapeMappings(EMPTY_KNOWLEDGE.traitStats.mappings)).toEqual([]);
        expect(shapeRecipes(EMPTY_KNOWLEDGE.recipes)).toEqual([]);
        expect(shapeItems(EMPTY_KNOWLEDGE.items)).toEqual([]);
        expect(shapeActions(EMPTY_KNOWLEDGE.actions)).toEqual([]);
    });
});

// --- 24. The Entities rows (knowledge_viewer.md Sec. 12) --------------------------------

describe('Entities rows: shapeDefinitions / kindGroupLabel / renderDefinitionBody', () => {
    const ROW = {
        kind: 'components', id: 'centralBall', name: 'Central Ball', description: 'The torso.',
        facets: [{ label: 'volume', value: '10' }], definition: { form: { volume: 10 } },
    };

    it('keeps the rows it can name and drops the rest', () => {
        expect(shapeDefinitions(null)).toEqual([]);
        expect(shapeDefinitions('components')).toEqual([]);
        expect(shapeDefinitions([null, 7, [], ROW])).toHaveLength(1);
        // A row with no kind has no group to join; a row with no id has no title.
        expect(shapeDefinitions([{ ...ROW, kind: '' }])).toEqual([]);
        expect(shapeDefinitions([{ ...ROW, id: 42 }])).toEqual([]);
    });

    it('keeps the payload order and normalizes only what is not a string', () => {
        const rows = shapeDefinitions([ROW, { ...ROW, id: 'tree', name: null, description: '', facets: null }]);
        expect(rows.map((r) => r.id)).toEqual(['centralBall', 'tree']);
        // `parts` is null here because this facet names nothing -- a facet of the
        // real payload carries the sentence as parts, and the next tests pin those.
        expect(rows[0].facets).toEqual([{ label: 'volume', value: '10', parts: null }]);
        expect(rows[1].name).toBeNull();
        expect(rows[1].description).toBeNull();
        expect(rows[1].facets).toEqual([]);
    });

    it('treats a definition of 0 or "" as the entry, not as an absent one', () => {
        expect(shapeDefinitions([{ kind: 'sensitiveParts', id: 'x', definition: 0 }])[0].definition).toBe(0);
        expect(shapeDefinitions([{ kind: 'sensitiveParts', id: 'x', definition: '' }])[0].definition).toBe('');
        expect(shapeDefinitions([{ kind: 'sensitiveParts', id: 'x' }])[0].definition).toBeNull();
    });

    it('keeps a facet pair only when both halves are printable', () => {
        const [row] = shapeDefinitions([{
            kind: 'effects', id: 'burning',
            facets: [
                { label: 'lasts', value: '3 rounds' }, { label: '', value: 'x' },
                { label: 'empty', value: '' }, { label: 'number', value: 3 }, null, ['a'],
            ],
        }]);
        expect(row.facets).toEqual([{ label: 'lasts', value: '3 rounds', parts: null }]);
    });

    it('keeps the parts a facet carries, and calls only a whole part a target', () => {
        const [row] = shapeDefinitions([{
            kind: 'components', id: 'head',
            facets: [{
                label: 'organs', value: 'Strength Core, burner',
                parts: [
                    { text: 'Strength Core', kind: 'internalComponents', id: 'strengthCore' },
                    { text: ', burner' },
                    // Half a target is not a destination: no text, no kind, no id.
                    { text: '', kind: 'materials', id: 'iron' },
                    { kind: 'materials', id: 'iron' },
                    { text: 'wood', kind: 'materials' },
                    { text: 'wood', id: 'wood' },
                    'not a part', null,
                ],
            }],
        }]);
        expect(row.facets[0].parts).toEqual([
            { text: 'Strength Core', kind: 'internalComponents', id: 'strengthCore' },
            { text: ', burner' },
            { text: 'wood' },
            { text: 'wood' },
        ]);
    });

    it('kindGroupLabel turns a registry kind into a heading, pluralized', () => {
        expect(kindGroupLabel('components')).toBe('Components');
        expect(kindGroupLabel('materialDamageTypes')).toBe('Material Damage Types');
        expect(kindGroupLabel('sensitiveParts')).toBe('Sensitive Parts');
        // The acronym the camelCase split cannot get right is spelled out.
        expect(kindGroupLabel('npcs')).toBe('NPCs');
        // The `world` registry is one entry (the world's own settings: a name, a
        // tick rate), so the plural this rule forms -- "Worlds" -- names a thing
        // this server has exactly one of (knowledge_viewer.md Sec. 12).
        expect(kindGroupLabel('world')).toBe('World');
        // Already plural in the data: the heading says the data's word, not "Ruleses".
        expect(kindGroupLabel('worldRules')).toBe('World Rules');
        expect(kindGroupLabel('synergy')).toBe('Synergies');
        expect(kindGroupLabel('box')).toBe('Boxes');
        expect(kindGroupLabel('')).toBe('');
    });

    it('renderDefinitionBody prints every shape a registry entry can have', () => {
        expect(renderDefinitionBody(null)).toBe('');
        expect(renderDefinitionBody(undefined)).toBe('');
        // An object body is the key: value listing the other tabs already use.
        expect(renderDefinitionBody({ volume: 10 })).toContain('knowledge-data-key');
        expect(renderDefinitionBody({ volume: 10 })).toContain('volume');
        // A blueprint is an array of ids; a tuple is a part and the slot it hangs on.
        expect(renderDefinitionBody(['centralBall'])).toContain('centralBall');
        expect(renderDefinitionBody([['crafterArm', 'left']])).toContain('crafterArm');
        expect(renderDefinitionBody([['crafterArm', 'left']])).toContain('left');
        // A sensitive part is a bare number: the number IS the entry, 0 included.
        expect(renderDefinitionBody(100)).toContain('100');
        expect(renderDefinitionBody(0)).toContain('0');
    });

    it('escapes the wire: a definition cannot close the card it is printed in', () => {
        const html = renderDefinitionBody({ label: '<script>x</script>' });
        expect(html).not.toContain('<script>');
        const [row] = shapeDefinitions([
            { kind: 'a<b', id: 'c">d', name: '<img src=x>', description: null, facets: [], definition: { d: '"><b>' } },
        ]);
        const card = new KnowledgePanel()._renderDefinitionCard(row);
        expect(card).not.toContain('<img');
        expect(card).not.toContain('<b>');
        // escapeHtml covers `=` too, so the attribute form cannot survive either.
        expect(card).toContain('&lt;img src&#61;x&gt;');
    });
});

// --- 26. The facet links of a definition card ---------------------------------

describe('renderFacetValue: a facet sentence with the names in it kept as links', () => {
    it('renders a part-less facet as its plain text, escaped', () => {
        expect(renderFacetValue({ value: 'Iron x0.7' })).toBe('Iron x0.7');
        expect(renderFacetValue({ value: '<b>x</b> & "y"' })).not.toContain('<b>');
        expect(renderFacetValue({ value: '<b>x</b>' })).toBe('&lt;b&gt;x&lt;/b&gt;');
        expect(renderFacetValue(null)).toBe('');
        expect(renderFacetValue({})).toBe('');
    });

    it('renders each named target as a button carrying the target, in order', () => {
        const html = renderFacetValue({
            value: 'Iron x0.7, Wood x0.3',
            parts: [
                { text: 'Iron', kind: 'materials', id: 'iron' },
                { text: ' x0.7, ' },
                { text: 'Wood', kind: 'materials', id: 'wood' },
                { text: ' x0.3' },
            ],
        });
        expect(html).toBe(
            '<button type="button" class="knowledge-facet-link" data-ref-kind="materials" ' +
            'data-ref-id="iron">Iron</button> x0.7, ' +
            '<button type="button" class="knowledge-facet-link" data-ref-kind="materials" ' +
            'data-ref-id="wood">Wood</button> x0.3'
        );
    });

    it('leaves a half-target as plain text, and escapes every part', () => {
        expect(renderFacetValue({ value: 'x', parts: [{ text: 'wood', kind: 'materials' }] })).toBe('wood');
        expect(renderFacetValue({ value: 'x', parts: [{ text: 'wood', id: 'wood' }] })).toBe('wood');
        const html = renderFacetValue({
            value: 'x',
            parts: [{ text: '<img src=x>', kind: 'a"b', id: 'c"d' }],
        });
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src&#61;x&gt;');
        expect(html).not.toContain('data-ref-id="c"d"');
    });
});

describe('referenceTabIdOf: the target decides the tab, and only a tab that exists', () => {
    /** A payload holding only these definition rows (no `definitionGroups`). */
    const payloadOf = (definitions) => ({ ...EMPTY_KNOWLEDGE, definitions });

    it('sends a kind to the codex view that renders it', () => {
        const payload = payloadOf([{ kind: 'components', id: 'head' }]);
        // Matter lives on the Materials tab, objects on Items, verbs on Crafting,
        // the two trait tables on Traits & Stats -- the views the server owns.
        expect(referenceTabIdOf(payload, 'materials')).toBe(SECTION_IDS.MATERIALS);
        expect(referenceTabIdOf(payload, 'inventoryItems')).toBe(SECTION_IDS.ITEMS);
        expect(referenceTabIdOf(payload, 'crafting')).toBe(SECTION_IDS.RECIPES);
        expect(referenceTabIdOf(payload, 'actions')).toBe(SECTION_IDS.ACTIONS);
        expect(referenceTabIdOf(payload, 'traits')).toBe(SECTION_IDS.TRAITS);
        expect(referenceTabIdOf(payload, 'propertyTraitMapping')).toBe(SECTION_IDS.TRAITS);
    });

    it('sends any other kind to that kind\'s own definition tab', () => {
        const payload = payloadOf([
            { kind: 'internalComponents', id: 'strengthCore' },
            { kind: 'rooms', id: 'start' },
        ]);
        expect(referenceTabIdOf(payload, 'internalComponents')).toBe('def:internalComponents');
        expect(referenceTabIdOf(payload, 'rooms')).toBe('def:rooms');
    });

    it('answers null for a kind this payload has no tab for', () => {
        // A kind with no rows and no group has no card to land on, so a facet link
        // naming it must not switch the reader to a screen with nothing on it.
        const payload = payloadOf([{ kind: 'components', id: 'head' }]);
        expect(referenceTabIdOf(payload, 'machines')).toBeNull();
        expect(referenceTabIdOf(payload, 'no_such_kind')).toBeNull();
        expect(referenceTabIdOf(payload, '')).toBeNull();
        expect(referenceTabIdOf(payload, null)).toBeNull();
        expect(referenceTabIdOf(null, 'materials')).toBeNull();
    });

    it('is the mirror of the server exclusion map, key for key and tab for tab', () => {
        // The server keeps these kinds OUT of the definition tabs because it renders
        // them on a codex view of their own, and names that view per kind
        // (`CODEX_TAB_OWNED_KINDS`). This map is what sends a facet link to it. If
        // the two drift, a link lands on a tab the server has already removed.
        const kinds = Object.keys(CODEX_TAB_OWNED_KINDS);
        expect(Object.keys(VIEW_TAB_OF_REFERENCE_KIND).sort()).toEqual(kinds.slice().sort());
        const payload = payloadOf([]);
        for (const kind of kinds) {
            expect(referenceTabIdOf(payload, kind)).toBe(CODEX_TAB_OWNED_KINDS[kind]);
        }
        // And the map sends nothing to a tab outside the panel's own view ids.
        const sections = Object.values(SECTION_IDS);
        for (const sectionId of Object.values(VIEW_TAB_OF_REFERENCE_KIND)) {
            expect(sections).toContain(sectionId);
        }
    });
});

describe('A facet link click: the jump, the search it keeps, the card it lights', () => {
    /** A payload whose definition rows are exactly these (tabs derive from rows). */
    const payloadOf = (definitions) => ({ ...EMPTY_KNOWLEDGE, definitions });

    /** A card that records the flash class and the scroll, without a DOM. */
    function fakeCard(id) {
        const classes = new Set();
        return {
            dataset: { definition: id },
            classes,
            scrolls: 0,
            classList: {
                add: (name) => classes.add(name),
                remove: (name) => classes.delete(name),
                contains: (name) => classes.has(name),
            },
            scrollIntoView() { this.scrolls += 1; },
        };
    }

    /** A panel wired to a fake content node and a render that only counts. */
    function wiredPanel(payload, cards) {
        const panel = new KnowledgePanel();
        panel._payload = payload;
        panel._content = { querySelectorAll: () => cards };
        panel.renders = 0;
        panel._render = () => { panel.renders += 1; };
        return panel;
    }

    it('reads the target off the button, or off anything wrapped in it', () => {
        const panel = new KnowledgePanel();
        const button = {
            dataset: { refKind: 'materials', refId: 'iron' },
            closest: (sel) => (sel === '.knowledge-facet-link' ? button : null),
        };
        expect(panel._facetReferenceForTarget(button)).toEqual({ kind: 'materials', id: 'iron' });
        // A nested node inside the button resolves through `closest`, like a real click.
        expect(panel._facetReferenceForTarget({ dataset: {}, closest: button.closest }))
            .toEqual({ kind: 'materials', id: 'iron' });
        expect(panel._facetReferenceForTarget({ dataset: {}, closest: () => null })).toBeNull();
        expect(panel._facetReferenceForTarget(null)).toBeNull();
        // A link that names no kind or no id is not a target.
        expect(panel._facetReferenceForTarget({ dataset: {}, closest: (s) => (s ? { dataset: {} } : null) }))
            .toBeNull();
    });

    it('opens the tab the kind lives on and lights only the card it named', () => {
        const organ = fakeCard('strengthCore');
        const other = fakeCard('burner');
        const panel = wiredPanel(
            payloadOf([
                { kind: 'internalComponents', id: 'strengthCore', name: 'Strength Core' },
                { kind: 'internalComponents', id: 'burner' },
            ]),
            [organ, other],
        );
        panel._jumpToDefinitionReference('internalComponents', 'strengthCore');
        expect(panel._activeSection).toBe('def:internalComponents');
        expect(panel.renders).toBe(1);
        expect(organ.classes.has('knowledge-entity-highlight')).toBe(true);
        expect(organ.scrolls).toBe(1);
        // The organ the facet did NOT name stays dark: the jump keys on the card's
        // `data-definition`, not on every card mentioning the target.
        expect(other.classes.size).toBe(0);
    });

    it('is a no-op when the payload has no tab for the kind', () => {
        const panel = wiredPanel(payloadOf([{ kind: 'components', id: 'head' }]), []);
        const before = panel._activeSection;
        panel._jumpToDefinitionReference('machines', 'forge');
        expect(panel._activeSection).toBe(before);
        expect(panel.renders).toBe(0);
    });

    it('hands a material, an item or an action to the jump that owns that card', () => {
        const panel = wiredPanel(payloadOf([{ kind: 'components', id: 'head' }]), []);
        const delegated = [];
        for (const method of ['_jumpToMaterial', '_jumpToItem', '_jumpToAction']) {
            panel[method] = (value) => { delegated.push(`${method}:${value}`); };
        }
        // Those three codex views flash their own card families, and their jumps
        // predate the definition tabs. A facet naming a material, an object or a
        // verb goes through the door the chip click uses, so the two ways of
        // reaching one card cannot drift apart -- and no definition card lights up.
        panel._jumpToDefinitionReference('materials', 'iron');
        panel._jumpToDefinitionReference('inventoryItems', 'trenchCoat');
        panel._jumpToDefinitionReference('actions', 'cut');
        expect(delegated).toEqual([
            '_jumpToMaterial:iron', '_jumpToItem:trenchCoat', '_jumpToAction:cut',
        ]);
    });

    it('flashes a recipe card when the target is a craft', () => {
        const recipe = fakeCard('circuit-board');
        recipe.dataset = { recipe: 'circuit-board' };
        // The owned kinds are never in the definition tabs, so no `def:blueprints`
        // tab exists to land on (the payload a real client holds looks like this).
        const panel = wiredPanel(payloadOf([]), [recipe]);
        // A blueprint is rendered by the Crafting & Items view, whose cards are
        // recipe cards rather than definition cards, so the flash looks there.
        panel._jumpToDefinitionReference('crafting', 'circuit-board');
        expect(panel._activeSection).toBe(SECTION_IDS.RECIPES);
        expect(recipe.classes.has('knowledge-recipe-highlight')).toBe(true);
        expect(recipe.scrolls).toBe(1);
    });

    it('names a blueprint the tab that lists blueprints, not the crafting view', () => {
        const panel = wiredPanel(payloadOf([{ kind: 'blueprints', id: 'circuit-board' }]), []);
        // The recipes view shows how things are MADE; a blueprint named by an entry
        // is a definition of one craft, and the kind tab that lists them is where
        // its own entry lives (the same distinction the tab bar draws).
        expect(referenceTabIdOf(panel._payload, 'blueprints')).toBe('def:blueprints');
        expect(referenceTabIdOf(panel._payload, REGISTRY_KINDS.CRAFTING)).toBe(SECTION_IDS.RECIPES);
    });

    it('claims no target the other cross-link readers already own', () => {
        // One delegated listener asks several readers the same click (Sec. 10), so
        // a facet link must not answer to the material, item or action reader and
        // vice versa -- two jumps for one click would open a tab and then another.
        const panel = new KnowledgePanel();
        const facet = {
            dataset: { refKind: 'materials', refId: 'iron' },
            closest: (sel) => (sel === '.knowledge-facet-link' ? facet : null),
        };
        const material = {
            dataset: { material: 'iron' },
            closest: (sel) => (sel === '.knowledge-material-link' ? material : null),
        };
        expect(panel._facetReferenceForTarget(facet)).toEqual({ kind: 'materials', id: 'iron' });
        expect(panel._materialLinkTypeForTarget(facet)).toBeFalsy();
        expect(panel._recipeRefTypeForTarget(facet)).toBeFalsy();
        expect(panel._actionRefNameForTarget(facet)).toBeFalsy();
        // And the material chip is not a facet link: it names no registry kind.
        expect(panel._facetReferenceForTarget(material)).toBeNull();
        expect(panel._materialLinkTypeForTarget(material)).toBe('iron');
    });

    it('keeps the reader\'s global term when the target survives it, and drops it when not', () => {
        const payload = payloadOf([{ kind: 'internalComponents', id: 'strengthCore', name: 'Strength Core' }]);
        const keep = wiredPanel(payload, [fakeCard('strengthCore')]);
        keep._query = 'Strength Core';
        keep._refine = 'organ only';
        keep._jumpToDefinitionReference('internalComponents', 'strengthCore');
        expect(keep._query).toBe('Strength Core');
        // The sub bar narrows the tab being left, so it never travels (Sec. 10).
        expect(keep._refine).toBe('');

        const drop = wiredPanel(payload, [fakeCard('strengthCore')]);
        drop._query = 'quartz';
        drop._jumpToDefinitionReference('internalComponents', 'strengthCore');
        // The term would empty the tab the jump opens, so the jump clears it rather
        // than landing the reader on a no-match screen (the rule every jump here obeys).
        expect(drop._query).toBe('');
    });

    it('a material of a component lands on the Materials tab, named by the same term', () => {
        const panel = new KnowledgePanel();
        panel._payload = {
            ...EMPTY_KNOWLEDGE,
            traitStats: { groups: {}, mappings: [], materials: [{ type: 'iron', name: 'Iron' }] },
        };
        panel._content = { querySelectorAll: () => [fakeCard('iron')] };
        panel._render = () => {};
        panel._jumpToDefinitionReference('materials', 'iron');
        // The Materials view is where matter renders, and the jump the panel already
        // had for a material is the one taken (the test above pins the delegation).
        expect(panel._activeSection).toBe(SECTION_IDS.MATERIALS);
    });
});

describe('Definition tab rendering (_renderDefinitions)', () => {
    const ROWS = [
        {
            kind: 'components', id: 'centralBall', name: 'Central Ball', description: null,
            facets: [{ label: 'volume', value: '10' }], definition: { form: { volume: 10 } },
        },
        {
            kind: 'components', id: 'tree', name: null, description: null, facets: [],
            definition: { form: { volume: 20 } },
        },
        {
            kind: 'rooms', id: 'start_room', name: 'The Entrance Hall', description: 'Where it starts.',
            facets: [{ label: 'exits', value: 'right_door -> The Eastern Corridor' }],
            definition: { connections: { right_door: { target: 'right_room' } } },
        },
    ];
    const html = new KnowledgePanel()._renderDefinitions(ROWS);

    it('draws the rows without a family heading: the TAB names the kind', () => {
        // The flat Entities tab needed a heading per family to separate seventeen
        // kinds in one scroll; a kind tab is one kind, so the heading would repeat
        // the tab's own label (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12).
        expect(html).not.toContain('knowledge-entity-group-title');
        expect(html).not.toContain('>Components<');
        expect((html.match(/class="knowledge-entity-group"/g) || [])).toHaveLength(1);
        // The block is stamped with the kind it shows (the payload's first row),
        // the attribute a reader of the DOM can still key on.
        expect(html).toContain('data-kind="components"');
        expect(html).not.toContain('data-kind="rooms"');
    });

    it('shows the id next to a name, and as the title when no name exists', () => {
        expect(html).toContain('Central Ball');
        // Only the nameless card skips the id line: it titles itself with the id.
        expect((html.match(/class="knowledge-entity-id"/g) || [])).toHaveLength(ROWS.length - 1);
        expect(html).toContain('>centralBall<');
        expect(html).toContain('>tree<');
    });

    it('renders the description, the facets, and the raw definition collapsed', () => {
        expect(html).toContain('Where it starts.');
        expect(html).toContain('knowledge-entity-facet-label');
        expect(html).toContain('>volume<');
        expect(html).toContain('right_door -&gt; The Eastern Corridor');
        // Every card keeps the verbatim entry in the collapsed appendix.
        expect((html.match(/<details class="knowledge-entity-raw">/g) || [])).toHaveLength(3);
        expect(html).toContain('right_room');
    });

    it('renders a linked part as a button naming its target, and a plain part as text', () => {
        const linked = new KnowledgePanel()._renderDefinitions([{
            kind: 'components', id: 'head', name: 'Head', description: null,
            facets: [{
                label: 'composition', value: 'Iron x1',
                parts: [{ text: 'Iron ', kind: 'materials', id: 'iron' }, { text: 'x1' }],
            }, { label: 'weightGrams', value: '450' }],
            definition: null,
        }]);
        // The link carries what the server named -- the target's kind and key --
        // which is all the client needs to choose a tab. Nothing here names a tab.
        expect(linked).toContain('data-ref-kind="materials" data-ref-id="iron"');
        expect(linked).toContain('class="knowledge-facet-link"');
        // The text around the link, and a facet that links nothing, stay text.
        expect(linked).toContain('>x1</span>');
        expect(linked).toContain('>450</span>');
        // The card carries its own identity: the attribute a jump flashes by.
        expect(linked).toContain('data-definition="head"');
    });

    it('escapes a link, because a name is data and a quote is not markup', () => {
        const linked = new KnowledgePanel()._renderDefinitions([{
            kind: 'components', id: 'x"<b>', name: null, description: null,
            facets: [{
                label: 'organs', value: 'Iron "<script>"',
                parts: [{ text: 'Iron "<script>"', kind: 'materials', id: 'x"<b>' }],
            }],
            definition: null,
        }]);
        expect(linked).not.toContain('<script>');
        expect(linked).toContain('&quot;&lt;script&gt;');
        expect(linked).toContain('data-ref-id="x&quot;&lt;b&gt;"');
    });

    it('falls back to the tab\'s empty state, never an error, on nothing to show', () => {
        const panel = new KnowledgePanel();
        expect(panel._renderDefinitions([])).toContain(KNOWLEDGE_LABELS.EMPTY_DEFINITION);
        expect(panel._renderDefinitions(null)).toContain(KNOWLEDGE_LABELS.EMPTY_DEFINITION);
        expect(panel._renderDefinitions([null, { id: 'no-kind' }])).toContain(KNOWLEDGE_LABELS.EMPTY_DEFINITION);
    });
});

describe('Definition tabs: one per registry kind, captioned by family (_tabDefs / _renderTabs)', () => {
    const TAB_PAYLOAD = {
        ...EMPTY_KNOWLEDGE,
        definitions: [
            { kind: 'components', id: 'centralBall', name: null, description: null, facets: [], definition: {} },
            { kind: 'sensitiveParts', id: 'brain', name: null, description: null, facets: [], definition: {} },
            { kind: 'rooms', id: 'start_room', name: null, description: null, facets: [], definition: {} },
        ],
        definitionGroups: [
            {
                id: 'parts',
                label: 'Parts',
                sections: [SECTION_IDS.TRAITS, SECTION_IDS.MATERIALS, SECTION_IDS.ITEMS],
                kinds: ['components', 'internalComponents', 'sensitiveParts'],
            },
            { id: 'blueprints', label: 'Blueprints', sections: [SECTION_IDS.RECIPES], kinds: [] },
            { id: 'world', label: 'World', sections: [], kinds: ['world', 'rooms', 'worldObjects'] },
            { id: 'data', label: 'Data', sections: [SECTION_IDS.ACTIONS], kinds: [] },
        ],
    };
    const tabPanel = () => {
        const panel = new KnowledgePanel();
        panel._payload = TAB_PAYLOAD;
        return panel;
    };

    it('is one tab per kind the map names, in the map order, with a def-prefixed id', () => {
        const defs = tabPanel()._definitionTabDefs();
        expect(defs.map((tab) => tab.id)).toEqual([
            'def:components', 'def:internalComponents', 'def:sensitiveParts',
            'def:world', 'def:rooms', 'def:worldObjects',
        ]);
        // The label is the kind's own words, not the family's.
        expect(defs.map((tab) => tab.label)).toEqual([
            'Components', 'Internal Components', 'Sensitive Parts', 'World', 'Rooms', 'World Objects',
        ]);
        expect(defs[0].groupLabel).toBe('Parts');
    });

    it('renders one captioned row per family, its tabs beside the caption', () => {
        const html = tabPanel()._renderTabs({}, false);
        expect((html.match(/class="knowledge-tab-family"/g) || [])).toHaveLength(4);
        for (const family of ['Parts', 'Blueprints', 'World', 'Data']) {
            expect(html).toContain(`class="knowledge-tab-family-label">${family}</span>`);
        }
        // Parts owns its three view tabs and its three kind tabs in one row; only
        // the kind tabs carry the kind modifier, so a view tab keeps its weight.
        const partsRow = html.slice(
            html.indexOf('knowledge-tab-family-label">Parts'),
            html.indexOf('knowledge-tab-family-label">Blueprints')
        );
        expect((partsRow.match(/knowledge-tab--kind/g) || [])).toHaveLength(3);
        expect(partsRow).toContain(`data-section="${SECTION_IDS.TRAITS}"`);
        expect(partsRow).toContain(`data-section="${SECTION_IDS.MATERIALS}"`);
        expect(partsRow).toContain(`data-section="${SECTION_IDS.ITEMS}"`);
        // A kind tab is clickable by its tab id, and keeps the kind-tab styling.
        expect(html).toContain('data-section="def:components"');
        expect(html).toContain('class="knowledge-tab knowledge-tab--kind" data-section="def:rooms"');
    });

    it('opens a tab for a kind the map does not name (no unreachable definition)', () => {
        const panel = new KnowledgePanel();
        panel._payload = {
            ...TAB_PAYLOAD,
            definitionGroups: [{ id: 'parts', label: 'Parts', kinds: ['components'] }],
        };
        const ids = panel._definitionTabDefs().map((tab) => tab.id);
        expect(ids).toContain('def:sensitiveParts');
        expect(ids).toContain('def:rooms');
        // What the map left out is not left off the bar: it joins the last band,
        // the position the server uses for ungrouped entries.
        const html = panel._renderTabs({}, false);
        expect((html.match(/class="knowledge-tab-family"/g) || [])).toHaveLength(1);
        expect(html).toContain('data-section="def:sensitiveParts"');
        expect(html).toContain('data-section="def:rooms"');
        expect(html).toContain(`data-section="${SECTION_IDS.TRAITS}"`);
    });

    it('is one flat list in band order: each family its view tabs, then its kinds', () => {
        // The click guard and the sub-bar label look an id up in this list, so it
        // must hold both kinds of tab (a section id and a `def:` id).
        expect(tabPanel()._tabDefs().map((tab) => tab.id)).toEqual([
            'traitStats', 'materials', 'items',
            'def:components', 'def:internalComponents', 'def:sensitiveParts',
            'recipes',
            'def:world', 'def:rooms', 'def:worldObjects',
            'actions',
        ]);
    });

    it('bands the codex view tabs with the kind tabs of the same family', () => {
        const bands = tabPanel()._familyBands();
        expect(bands.map((band) => [band.key, band.label])).toEqual([
            ['parts', 'Parts'], ['blueprints', 'Blueprints'], ['world', 'World'], ['data', 'Data'],
        ]);
        expect(bands.map((band) => band.tabs.map((tab) => tab.id))).toEqual([
            ['traitStats', 'materials', 'items', 'def:components', 'def:internalComponents', 'def:sensitiveParts'],
            ['recipes'],
            ['def:world', 'def:rooms', 'def:worldObjects'],
            ['actions'],
        ]);
        // A view tab keeps its own label; a kind tab is labelled by the kind.
        expect(bands[0].tabs[0].label).toBe(KNOWLEDGE_LABELS.TAB_TRAITS);
    });

    it('keeps a view tab no family named, in the last band', () => {
        const panel = new KnowledgePanel();
        panel._payload = {
            ...TAB_PAYLOAD,
            definitionGroups: [
                { id: 'parts', label: 'Parts', sections: [SECTION_IDS.ITEMS], kinds: ['components'] },
                { id: 'data', label: 'Data', sections: [], kinds: [] },
            ],
        };
        // Losing a tab would lose the only way to reach that view, so the bar
        // places what the map forgot rather than drawing a shorter bar.
        expect(panel._tabDefs().map((tab) => tab.id)).toEqual([
            'items', 'def:components',
            'traitStats', 'recipes', 'materials', 'actions',
            'def:sensitiveParts', 'def:rooms',
        ]);
    });

    it('skips a family naming a view tab this codex does not render', () => {
        const panel = new KnowledgePanel();
        panel._payload = {
            ...TAB_PAYLOAD,
            definitionGroups: [
                { id: 'parts', label: 'Parts', sections: ['noSuchView', SECTION_IDS.ITEMS], kinds: [] },
            ],
        };
        const ids = panel._tabDefs().map((tab) => tab.id);
        expect(ids).not.toContain('noSuchView');
        expect(ids).toContain('items');
    });

    it('draws one flat row of the codex tabs when the payload names no family', () => {
        const panel = new KnowledgePanel();
        panel._payload = { ...TAB_PAYLOAD, definitionGroups: [] };
        expect(panel._familyBands()).toEqual([]);
        expect(panel._tabDefs().map((tab) => tab.id)).toEqual([
            'traitStats', 'recipes', 'items', 'materials', 'actions',
        ]);
        expect(panel._renderTabs({}, false)).toContain('class="knowledge-tabs"');
    });

    it('agrees with the server on which ids a family may name', () => {
        // The server places the codex's view tabs in a band by id; the panel owns
        // the ids and the views. If the two lists disagree, a family is naming a
        // view that cannot be drawn (or leaving one out of the bar).
        // The same ids on both sides (the order is the panel's bar order, not a
        // contract the server has to keep).
        expect([...CODEX_TAB_SECTION_IDS].sort()).toEqual(Object.values(SECTION_IDS).sort());
        expect(tabPanel()._coreTabDefs().map((tab) => tab.id).sort())
            .toEqual([...CODEX_TAB_SECTION_IDS].sort());
    });

    it('names the sub bar after the open kind', () => {
        const panel = tabPanel();
        panel._activeSection = 'def:rooms';
        expect(panel._activeSectionLabel()).toBe('Rooms');
        panel._activeSection = 'def:sensitiveParts';
        expect(panel._activeSectionLabel()).toBe('Sensitive Parts');
    });

    it('counts a definition tab as a slice of one section, never as extra matches', () => {
        const panel = new KnowledgePanel();
        // The global total is the sections'; the per-tab numbers stay available for
        // the badges (filterKnowledge fills both).
        expect(panel._totalMatches({ actions: 2, items: 3, definitions: 5, 'def:rooms': 2, 'def:world': 1 }))
            .toBe(10);
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

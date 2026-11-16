import { describe, it, expect } from 'vitest';
import {
    searchTextOf,
    termsOf,
    matchesTerms,
    filterKnowledge,
    countMatches,
    isSearchEmpty,
    targetSurvivesQuery,
    definitionTabsOf,
    DEFINITION_TAB_PREFIX,
    SECTION_ID_LIST,
} from '../../public/js/KnowledgeSearch.js';
import { SECTION_IDS } from '../../public/js/KnowledgePanel.js';

/**
 * KnowledgeSearch unit tests.
 *
 * The contract: one filter rule produces the payload the renderers read AND the
 * counts the badges show, so the two cannot disagree. A query walks everything a
 * row carries — the raw definition dump included (the chosen contract), which is
 * why a test below matches on a field the panel never displays.
 *
 * @module test/unit/KnowledgeSearch
 */

const PAYLOAD = {
    items: [
        { type: 'knife', name: 'Knife', description: 'A sharp blade.', definition: { materials: [{ material: 'iron', quantity: 1 }] } },
        { type: 'metalBox', name: 'Metal Box', description: 'A sturdy container.', definition: { form: { volume: 10 } } },
        { type: 'coal', name: 'Coal', description: 'Burns to stay alive.', definition: { fuel: 12 } },
    ],
    recipes: [
        { name: 'Forged knife', inputs: [{ type: 'iron_ingot' }], outputs: [{ type: 'knife' }] },
    ],
    actions: [
        { name: 'cut', definition: { consequences: [{ type: 'damageComponent', params: { channel: 'cut' } }] } },
        { name: 'touch', definition: { consequences: [{ type: 'stimulateSensitivePart' }] } },
    ],
    traitStats: {
        groups: { Physical: { sharpness: 82.5, strength: 15 }, Movement: { move: 5 } },
        mappings: [{ trait: 'Physical', stat: 'sharpness', source: 'material' }],
        // The real payload delivers materials as an ARRAY (shapeMaterials rejects
        // any other shape); the keyed form is exercised separately as the
        // tolerated-shape case.
        materials: [{ type: 'iron', name: 'Iron', density: 7.8 }],
        vocabulary: { stats: ['sharpness'], existence: { goneAt: 0 } },
    },
};

describe('KnowledgeSearch — terms', () => {
    it('splits, lowercases and dedupes; order survives', () => {
        expect(termsOf('  Iron   IRON knife ')).toEqual(['iron', 'knife']);
        expect(termsOf('')).toEqual([]);
        expect(termsOf(undefined)).toEqual([]);
        expect(termsOf(7)).toEqual([]);
    });

    it('every term must appear (AND), and no terms means no filter', () => {
        expect(matchesTerms('iron knife', ['iron', 'knife'])).toBe(true);
        expect(matchesTerms('iron knife', ['iron', 'gold'])).toBe(false);
        expect(matchesTerms('anything', [])).toBe(true);
    });

    it('serialises a row whole, so a hidden raw field is findable', () => {
        // `fuel` appears nowhere on the item card — only in the raw dump.
        expect(searchTextOf(PAYLOAD.items[2])).toContain('"fuel":12');
        expect(filterKnowledge(PAYLOAD, { query: 'fuel' }).display.items).toBe(1);
    });

    it('yields an empty string for a value JSON cannot write, never a throw', () => {
        const cyclic = { name: 'loop' };
        cyclic.self = cyclic;
        expect(searchTextOf(cyclic)).toBe('');
        expect(searchTextOf(undefined)).toBe('');
    });
});

describe('KnowledgeSearch — the definition rows (knowledge_viewer.md Sec. 12)', () => {
    const ROWS = [
        {
            kind: 'components', id: 'centralBall', name: 'Central Ball',
            facets: [{ label: 'composition', value: 'Iron x1' }], definition: { form: { volume: 10 } },
        },
        {
            kind: 'rooms', id: 'start_room', name: 'The Entrance Hall',
            facets: [{ label: 'exits', value: 'right_door -> The Eastern Corridor' }],
            definition: { connections: { right_door: { target: 'right_room' } } },
        },
    ];
    const withEntities = (query) => filterKnowledge({ ...PAYLOAD, definitions: ROWS }, { query });

    it('filters a row by its id, its name, a facet and a raw field no facet reads', () => {
        expect(withEntities('centralball').payload.definitions.map((r) => r.id)).toEqual(['centralBall']);
        expect(withEntities('entrance').payload.definitions.map((r) => r.id)).toEqual(['start_room']);
        expect(withEntities('iron x1').payload.definitions.map((r) => r.id)).toEqual(['centralBall']);
        // Nothing displayed spells out `right_room`: only the collapsed appendix carries it.
        expect(withEntities('right_room').payload.definitions.map((r) => r.id)).toEqual(['start_room']);
        expect(withEntities('hallway').display.definitions).toBe(0);
    });

    it('badges the tab with the same rule the tab renders', () => {
        const filtered = withEntities('hall');
        expect(filtered.display.definitions).toBe(1);
        expect(filtered.counts.definitions).toBe(1);
        expect(filtered.payload.definitions).toHaveLength(1);
    });

    it('narrows the ACTIVE definition tab, and cannot resurrect what the global query dropped', () => {
        const payload = { ...PAYLOAD, definitions: ROWS };
        // The global query 'iron' keeps one definition row (its composition facet)
        // and the knife item; the sub bar then narrows the open kind tab only.
        const narrowed = filterKnowledge(payload, {
            query: 'iron', refine: 'volume', activeSection: `${DEFINITION_TAB_PREFIX}components`,
        });
        expect(narrowed.payload.definitions.map((r) => r.id)).toEqual(['centralBall']);
        expect(narrowed.counts.definitions).toBe(1);
        // A refine term is a second term over what the first found, never a rescue.
        const emptied = filterKnowledge(payload, {
            query: 'iron', refine: 'entrance', activeSection: `${DEFINITION_TAB_PREFIX}components`,
        });
        expect(emptied.payload.definitions).toEqual([]);
        expect(emptied.counts.definitions).toBe(1);
        // The other tabs are the global query's, untouched by this tab's narrowing.
        expect(emptied.payload.items.map((i) => i.type)).toEqual(['knife']);
    });

    it('counts an absent section as zero rather than failing', () => {
        expect(filterKnowledge(PAYLOAD, { query: 'knife' }).display.definitions).toBe(0);
    });

    it('searches the kind a facet link names, not only the sentence it prints', () => {
        // A facet part that links carries the target's kind and id; the row is
        // searched as its dump, so the link is findable text rather than markup the
        // reader can never reach. `value` alone would not contain the kind.
        const linked = {
            ...PAYLOAD,
            definitions: [{
                kind: 'components', id: 'head', name: 'Head',
                facets: [{
                    label: 'organs', value: 'Strength Core',
                    parts: [{ text: 'Strength Core', kind: 'internalComponents', id: 'strengthCore' }],
                }],
                definition: null,
            }],
        };
        expect(filterKnowledge(linked, { query: 'internalcomponents' }).payload.definitions)
            .toHaveLength(1);
        expect(filterKnowledge(linked, { query: 'strengthcore' }).payload.definitions)
            .toHaveLength(1);
    });

    it('scopes the rendered list to the open kind, leaving the badges per kind', () => {
        const payload = { ...PAYLOAD, definitions: ROWS };
        const opened = filterKnowledge(payload, { query: 'a', activeSection: `${DEFINITION_TAB_PREFIX}rooms` });
        // 'a' matches both rows, but the Rooms tab shows only the room.
        expect(opened.payload.definitions.map((r) => r.id)).toEqual(['start_room']);
        expect(opened.counts.definitions).toBe(2);
        // The per-kind numbers the badges read (the flat section count is the
        // list's, not the open tab's).
        expect(opened.counts['def:components']).toBe(1);
        expect(opened.counts['def:rooms']).toBe(1);
        expect(opened.display['def:rooms']).toBe(1);
    });

    it('leaves the whole list in place when the open tab is not a definition tab', () => {
        const payload = { ...PAYLOAD, definitions: ROWS };
        const filtered = filterKnowledge(payload, { query: 'a', activeSection: SECTION_IDS.ITEMS });
        expect(filtered.payload.definitions).toHaveLength(2);
        expect(filtered.counts['def:components']).toBe(1);
    });

    it('gives a badge to a kind the map names even when no row of it survives', () => {
        const payload = {
            ...PAYLOAD,
            definitions: ROWS,
            definitionGroups: [{ id: 'parts', label: 'Parts', kinds: ['components', 'internalComponents'] }],
        };
        const filtered = filterKnowledge(payload, { query: 'entrance' });
        expect(filtered.counts['def:internalComponents']).toBe(0);
        expect(filtered.counts['def:components']).toBe(0);
        expect(filtered.counts['def:rooms']).toBe(1);
    });
});

describe('KnowledgeSearch — definitionTabsOf (the tab bar the payload describes)', () => {
    it('is one tab per kind the map names, in the map order', () => {
        expect(definitionTabsOf({
            definitionGroups: [
                { id: 'parts', label: 'Parts', kinds: ['components', 'sensitiveParts'] },
                { id: 'world', label: 'World', kinds: ['rooms'] },
            ],
        })).toEqual([
            { id: 'def:components', kind: 'components', groupId: 'parts', groupLabel: 'Parts' },
            { id: 'def:sensitiveParts', kind: 'sensitiveParts', groupId: 'parts', groupLabel: 'Parts' },
            { id: 'def:rooms', kind: 'rooms', groupId: 'world', groupLabel: 'World' },
        ]);
    });

    it('opens a tab for a kind the map missed, once, and never repeats one', () => {
        const tabs = definitionTabsOf({
            definitionGroups: [{ id: 'parts', label: 'Parts', kinds: ['components', 'components'] }],
            definitions: [
                { kind: 'components', id: 'a' },
                { kind: 'npcs', id: 'smallBallDroid' },
                { kind: 'npcs', id: 'human' },
                { kind: 7, id: 'no-kind' },
            ],
        });
        expect(tabs.map((tab) => tab.id)).toEqual(['def:components', 'def:npcs']);
        expect(tabs[1]).toEqual({ id: 'def:npcs', kind: 'npcs', groupId: '', groupLabel: '' });
    });

    it('yields no tab for a payload without a map or rows, and survives junk', () => {
        expect(definitionTabsOf(undefined)).toEqual([]);
        expect(definitionTabsOf(null)).toEqual([]);
        expect(definitionTabsOf('nope')).toEqual([]);
        expect(definitionTabsOf([])).toEqual([]);
        expect(definitionTabsOf({ definitionGroups: [null, 7, { kinds: 'nope' }] })).toEqual([]);
    });
});

describe('KnowledgeSearch — the global bar', () => {
    it('filters items, recipes and actions by anything they carry', () => {
        const { display } = filterKnowledge(PAYLOAD, { query: 'knife' });
        expect(display.items).toBe(1);
        expect(display.recipes).toBe(1);
        // No action row carries the word 'knife' in this fixture, so it is 0 —
        // the search finds what the data says, not what a reader infers.
        expect(display.actions).toBe(0);
    });

    it('matches an action through its raw consequence channel', () => {
        expect(filterKnowledge(PAYLOAD, { query: 'damagecomponent' }).display.actions).toBe(1);
        expect(filterKnowledge(PAYLOAD, { query: 'stimulatesensitivepart' }).display.actions).toBe(1);
        expect(filterKnowledge(PAYLOAD, { query: 'shotgun' }).display.actions).toBe(0);
    });

    it('ANDs several terms against the same row', () => {
        expect(filterKnowledge(PAYLOAD, { query: 'metal container' }).display.items).toBe(1);
        expect(filterKnowledge(PAYLOAD, { query: 'metal nonexistent' }).display.items).toBe(0);
    });

    it('returns every section id the tab bar uses, so a tab can never be unsearchable', () => {
        const counts = filterKnowledge(PAYLOAD, { query: 'zzz' }).counts;
        // SECTION_ID_LIST is the search's own unit list: the codex's tabs plus the
        // flat `definitions` section every kind tab windows onto. A payload with
        // definition rows adds one key per kind tab (pinned in the describe above).
        expect(Object.keys(counts).sort()).toEqual([...SECTION_ID_LIST].sort());
    });

    it('counts materials and the traits units (mapping rows plus stat cells)', () => {
        const { counts } = filterKnowledge(PAYLOAD, { query: 'iron' });
        expect(counts.materials).toBe(1);
        // 'iron' hits the material only; the mapping row does not carry it.
        expect(counts.traitStats).toBe(0);
        const groups = filterKnowledge(PAYLOAD, { query: 'sharpness' });
        expect(groups.display.traitStats).toBe(2); // one mapping row + one stat cell
    });

    it('keeps a whole trait group when its NAME matches, and single cells otherwise', () => {
        const byGroup = filterKnowledge(PAYLOAD, { query: 'movement' });
        expect(byGroup.payload.traitStats.groups).toEqual({ Movement: { move: 5 } });
        const byStat = filterKnowledge(PAYLOAD, { query: 'sharpness' });
        expect(byStat.payload.traitStats.groups).toEqual({ Physical: { sharpness: 82.5 } });
    });

    it('drops the pinned vocabulary while searching and keeps it untouched otherwise', () => {
        expect(filterKnowledge(PAYLOAD, { query: 'x' }).payload.traitStats.vocabulary).toBeUndefined();
        expect(filterKnowledge(PAYLOAD, {}).payload.traitStats.vocabulary).toBeDefined();
    });

    it('leaves the unfiltered payload alone', () => {
        const before = JSON.stringify(PAYLOAD);
        filterKnowledge(PAYLOAD, { query: 'knife' });
        expect(JSON.stringify(PAYLOAD)).toBe(before);
    });
});

describe('KnowledgeSearch — the sub bar', () => {
    it('narrows the ACTIVE section only; the badges keep the global counts', () => {
        const { display } = filterKnowledge(PAYLOAD, {
            query: 'knife', refine: 'blade', activeSection: SECTION_IDS.ITEMS,
        });
        expect(display.items).toBe(1);
        const none = filterKnowledge(PAYLOAD, {
            query: 'knife', refine: 'zzz', activeSection: SECTION_IDS.ITEMS,
        });
        expect(none.display.items).toBe(0);
        expect(none.counts.items).toBe(1); // the badge still describes the search
    });

    it('does not touch another tab', () => {
        const { display } = filterKnowledge(PAYLOAD, {
            query: 'knife', refine: 'zzz', activeSection: SECTION_IDS.RECIPES,
        });
        expect(display.items).toBe(1);
        expect(display.recipes).toBe(0);
    });

    it('refines materials and the trait units as well', () => {
        expect(filterKnowledge(PAYLOAD, {
            query: 'iron', refine: '7.8', activeSection: SECTION_IDS.MATERIALS,
        }).display.materials).toBe(1);
        // 'material' survives on the mapping row (source: material) but not on the
        // Physical.sharpness stat cell, so the tab is left with one unit.
        expect(filterKnowledge(PAYLOAD, {
            query: 'sharpness', refine: 'material', activeSection: SECTION_IDS.TRAITS,
        }).display.traitStats).toBe(1);
        expect(filterKnowledge(PAYLOAD, {
            query: 'sharpness', refine: 'zzz', activeSection: SECTION_IDS.TRAITS,
        }).display.traitStats).toBe(0);
    });
});

describe('KnowledgeSearch — counts and empty states', () => {
    it('countMatches is the same rule as the filter, never a second one', () => {
        expect(countMatches(PAYLOAD, 'knife')).toEqual(filterKnowledge(PAYLOAD, { query: 'knife' }).counts);
        expect(countMatches(null, 'knife').items).toBe(0);
    });

    it('distinguishes "no match" from "no data"', () => {
        const empty = filterKnowledge({ items: [] }, { query: 'knife' });
        expect(isSearchEmpty(empty.display, true, SECTION_IDS.ITEMS)).toBe(true);
        // No search at all and an empty section: the renderer's own empty state.
        const idle = filterKnowledge({ items: [] }, {});
        expect(isSearchEmpty(idle.display, false, SECTION_IDS.ITEMS)).toBe(false);
    });
});

describe('KnowledgeSearch — a jump into a filtered result', () => {
    it('keeps the term when the target survives, clears it when it does not', () => {
        expect(targetSurvivesQuery(PAYLOAD, SECTION_IDS.ITEMS, 'knife', 'knife')).toBe(true);
        expect(targetSurvivesQuery(PAYLOAD, SECTION_IDS.ITEMS, 'knife', 'coal')).toBe(false);
    });

    it('reads materials and actions by their own identity', () => {
        expect(targetSurvivesQuery(PAYLOAD, SECTION_IDS.MATERIALS, 'iron', 'iron')).toBe(true);
        expect(targetSurvivesQuery(PAYLOAD, SECTION_IDS.ACTIONS, 'cut', 'cut')).toBe(true);
        expect(targetSurvivesQuery(PAYLOAD, SECTION_IDS.ACTIONS, 'cut', 'touch')).toBe(false);
    });

    it('with no term, everything survives; an unknown target does not clear anything', () => {
        expect(targetSurvivesQuery(PAYLOAD, SECTION_IDS.ITEMS, '', 'anything')).toBe(true);
        // The search gives up its opinion rather than deleting a term on a guess.
        expect(targetSurvivesQuery(PAYLOAD, SECTION_IDS.ITEMS, 'knife', 'not-in-the-world')).toBe(true);
    });

    it('checks a definition tab like any other, because a facet link lands there', () => {
        const withDefs = {
            ...PAYLOAD,
            definitions: [
                { kind: 'internalComponents', id: 'strengthCore', name: 'Strength Core' },
                { kind: 'components', id: 'head', name: 'Head' },
            ],
        };
        const organTab = `${DEFINITION_TAB_PREFIX}internalComponents`;
        expect(targetSurvivesQuery(withDefs, organTab, 'strength', 'strengthCore')).toBe(true);
        // The term would empty the tab the jump opens: it is cleared, not carried
        // onto a no-match screen while the card the reader clicked sits unshown.
        expect(targetSurvivesQuery(withDefs, organTab, 'quartz', 'strengthCore')).toBe(false);
        // Only this tab's kind counts: `head` is a row of the payload and not of
        // this tab, so it cannot vouch for a target the tab does not hold.
        expect(targetSurvivesQuery(withDefs, organTab, 'head', 'strengthCore')).toBe(false);
        expect(targetSurvivesQuery(withDefs, `${DEFINITION_TAB_PREFIX}components`, 'head', 'head')).toBe(true);
        // A kind with no tab and no rows still cannot make a term disappear.
        expect(targetSurvivesQuery(withDefs, `${DEFINITION_TAB_PREFIX}machines`, 'strength', 'forge')).toBe(true);
        expect(targetSurvivesQuery(PAYLOAD, organTab, 'strength', 'strengthCore')).toBe(true);
    });
});

describe('KnowledgeSearch — malformed input cannot break the panel', () => {
    it('survives a missing, null or array payload', () => {
        for (const bad of [undefined, null, 'nope', 42, []]) {
            const result = filterKnowledge(bad, { query: 'knife', refine: 'x', activeSection: 'items' });
            expect(result.display.items).toBe(0);
            expect(result.payload).toBeTypeOf('object');
        }
    });

    it('survives junk rows and a traitStats that is not an object', () => {
        const messy = {
            items: [null, 7, 'x', { type: 'ok', name: 'Ok' }],
            traitStats: 'nope',
        };
        expect(filterKnowledge(messy, { query: 'ok' }).display.items).toBe(1);
        expect(filterKnowledge(messy, { query: 'ok' }).display.materials).toBe(0);
    });

    it('keeps the real materials shape (an array) and tolerates a keyed object', () => {
        const asArray = filterKnowledge(PAYLOAD, { query: 'iron' }).payload.traitStats.materials;
        expect(Array.isArray(asArray)).toBe(true);
        expect(asArray).toHaveLength(1);
        // A keyed object is kept keyed rather than rewritten: the readers that do
        // accept one must keep working, and a filter is not a reshape.
        const keyed = filterKnowledge({ traitStats: { materials: { iron: { name: 'Iron' } } } }, { query: 'iron' });
        expect(Array.isArray(keyed.payload.traitStats.materials)).toBe(false);
        expect(Object.keys(keyed.payload.traitStats.materials)).toEqual(['iron']);
        expect(keyed.counts.materials).toBe(1);
    });
});

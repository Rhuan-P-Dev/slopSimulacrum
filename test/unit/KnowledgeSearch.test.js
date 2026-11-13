import { describe, it, expect } from 'vitest';
import {
    searchTextOf,
    termsOf,
    matchesTerms,
    filterKnowledge,
    countMatches,
    isSearchEmpty,
    targetSurvivesQuery,
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
        expect(Object.keys(counts).sort()).toEqual([...Object.values(SECTION_IDS)].sort());
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

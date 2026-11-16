import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Markup integrity pin for the Knowledge panel.
 *
 * WHY this exists: the client has no DOM harness, so a class name typed wrong in
 * the renderer, or a CSS rule left behind by a renderer that stopped emitting it,
 * is invisible — the panel simply loses a style and nobody notices. This test
 * reads the two artifacts as text and asserts they agree, in both directions.
 *
 * SCOPE (deliberate, and measured before writing it): the `knowledge-` namespace
 * as emitted by the panel and styled in its own sheet. The rest of the client
 * carries 26 unmatched classes across 12 files today (`overlay-content`,
 * `clickable`, `pinned`, ...); pinning those here would mean editing panels this
 * change does not touch, so they stay a named debt rather than a silent pass —
 * widen the scope in a dedicated change.
 *
 * Two escape hatches, both explicit below, neither a wildcard:
 * UNSTYLED_HOOKS (a class that carries meaning and takes its look from a parent
 * selector) and DYNAMIC_CSS_MODIFIERS (a rule for a class assembled at runtime,
 * which a text scan cannot name).
 *
 * @module test/unit/knowledgeMarkupIntegrity
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PANEL_JS = readFileSync(`${ROOT}public/js/KnowledgePanel.js`, 'utf8');
const SEARCH_JS = readFileSync(`${ROOT}public/js/KnowledgeSearch.js`, 'utf8');
const INDEX_HTML = readFileSync(`${ROOT}public/index.html`, 'utf8');
const KNOWLEDGE_CSS = readFileSync(`${ROOT}public/css/knowledge.css`, 'utf8');

/**
 * Classes whose styling arrives from a parent rule (`.knowledge-card-grid`,
 * `.knowledge-capability-row`) — semantic markers, not styled boxes. Each entry
 * is a decision, not a tolerated typo: removing one from this list and keeping
 * the class is exactly the mistake the test below catches.
 * @type {string[]}
 */
const UNSTYLED_HOOKS = [
    'knowledge-actions',
    'knowledge-recipes',
    'knowledge-items',
    'knowledge-capability-actions',
    'knowledge-capability-stats',
];

/**
 * Rules in knowledge.css for classes built at runtime. None today — a rule with
 * no static mention is therefore genuinely dead.
 * @type {string[]}
 */
const DYNAMIC_CSS_MODIFIERS = [];

/**
 * Every class the panel emits: from `class="..."` attributes (template pieces
 * split on `${...}` so interpolated modifiers do not fake a name) and from
 * classList calls, restricted to the `knowledge-` namespace.
 * @param {string} js
 * @returns {Set<string>}
 */
function emittedClasses(js) {
    const out = new Set();
    for (const match of js.matchAll(/class="([^"]*)"/g)) {
        for (const piece of match[1].split(/\$\{[^}]*\}/)) {
            for (const token of piece.split(/\s+/)) {
                if (/^knowledge-[a-z0-9-]+$/.test(token)) out.add(token);
            }
        }
    }
    for (const match of js.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*'(knowledge-[a-z0-9-]*)'/g)) {
        out.add(match[1]);
    }
    return out;
}

/**
 * Every class name a CSS sheet selects (`.foo`, including in compound selectors).
 * @param {string} css
 * @returns {Set<string>}
 */
function styledClasses(css) {
    const out = new Set();
    for (const match of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) out.add(match[1]);
    return out;
}

/** Classes written directly in the HTML shell (the overlay chrome). @returns {Set<string>} */
function htmlClasses() {
    const out = new Set();
    for (const match of INDEX_HTML.matchAll(/class="([^"]*)"/g)) {
        for (const token of match[1].split(/\s+/)) if (token !== '') out.add(token);
    }
    return out;
}

describe('knowledge markup integrity', () => {
    const emitted = emittedClasses(PANEL_JS);
    const styled = styledClasses(KNOWLEDGE_CSS);
    const inHtml = htmlClasses();

    it('finds classes to check (a broken extractor would pass everything)', () => {
        expect(emitted.size).toBeGreaterThan(40);
        expect(styled.size).toBeGreaterThan(40);
        // The extractor must see the newest members of the family, or it has
        // quietly stopped reading the renderer.
        expect(emitted.has('knowledge-search-input')).toBe(true);
        expect(emitted.has('knowledge-refine-input')).toBe(true);
        expect(emitted.has('knowledge-action-effect-text')).toBe(true);
        // The Entities family (Sec. 12) is the newest member of the same pin.
        expect(emitted.has('knowledge-entity-card')).toBe(true);
        expect(emitted.has('knowledge-entity-facet-label')).toBe(true);
        // The family rows of the definition bar (one row of kind tabs under one
        // caption) are newer still.
        expect(emitted.has('knowledge-tab-family')).toBe(true);
        expect(emitted.has('knowledge-tab-family-label')).toBe(true);
        expect(emitted.has('knowledge-tab-family-tabs')).toBe(true);
    });

    it('every class the renderer emits is styled somewhere, or is a declared hook', () => {
        const orphans = [...emitted]
            .filter((cls) => !styled.has(cls) && !inHtml.has(cls))
            .filter((cls) => !UNSTYLED_HOOKS.includes(cls))
            .sort();
        expect(orphans).toEqual([]);
    });

    it('every rule in knowledge.css still matches something (no dead style)', () => {
        const dead = [...styled]
            .filter((cls) => cls.startsWith('knowledge-'))
            .filter((cls) => !PANEL_JS.includes(cls) && !SEARCH_JS.includes(cls) && !INDEX_HTML.includes(cls))
            .filter((cls) => !DYNAMIC_CSS_MODIFIERS.includes(cls))
            .sort();
        expect(dead).toEqual([]);
    });

    it('no hook in the exception list became styled (the list must shrink when it should)', () => {
        const stale = UNSTYLED_HOOKS.filter((cls) => styled.has(cls));
        expect(stale).toEqual([]);
    });

    it('no hook in the exception list is still emitted (dead exceptions get pruned)', () => {
        const gone = UNSTYLED_HOOKS.filter((cls) => !emitted.has(cls) && !INDEX_HTML.includes(cls));
        expect(gone).toEqual([]);
    });

    it('a kind tab reads as a member of a family, not as a section tab', () => {
        // The bar's second row must not compete with the first: the section tabs
        // stretch across it, a kind tab takes its own width at a smaller size, and
        // the family caption holds a column so the rows line up
        // (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12).
        const sectionRule = KNOWLEDGE_CSS.match(/\.knowledge-tab\s*{[^}]*}/)[0];
        const kindRule = KNOWLEDGE_CSS.match(/\.knowledge-tab--kind\s*{[^}]*}/)[0];
        const labelRule = KNOWLEDGE_CSS.match(/\.knowledge-tab-family-label\s*{[^}]*}/)[0];
        expect(sectionRule).toMatch(/flex:\s*1/);
        expect(kindRule).toMatch(/flex:\s*0 0 auto/);
        expect(Number((kindRule.match(/font-size:\s*(\d+)px/) || [0, 99])[1]))
            .toBeLessThan(Number((sectionRule.match(/font-size:\s*([\d.]+)em/) || [0, 99])[1]) * 16);
        expect(labelRule).toMatch(/flex:\s*0 0/);
    });

    it('a facet link reads as a word of the sentence, and the card it lands on lights up', () => {
        // The two classes a facet-link jump needs (knowledge_viewer.md Sec. 12).
        // The name inside a facet is underlined text, not a chip -- a composition
        // line of 24 chips would stop being a sentence -- and the card the jump
        // lands on flashes the same neon the material, item and action cards do.
        expect(emitted.has('knowledge-facet-link')).toBe(true);
        const linkRule = KNOWLEDGE_CSS.match(/\.knowledge-facet-link\s*{[^}]*}/)[0];
        expect(linkRule).toMatch(/cursor:\s*pointer/);
        expect(linkRule).toMatch(/background:\s*none/);
        const flashRule = KNOWLEDGE_CSS
            .match(/\.knowledge-entity-card\.knowledge-entity-highlight\s*{[^}]*}/)[0];
        expect(flashRule).toMatch(/border-color:\s*var\(--neon-green\)/);
        expect(flashRule).toMatch(/box-shadow:\s*var\(--glow\)/);
        // A craft named from a machine's card lands in the Crafting & Items view,
        // whose cards are a different family and so flash with their own rule.
        const recipeFlash = KNOWLEDGE_CSS
            .match(/\.knowledge-recipe-card\.knowledge-recipe-highlight\s*{[^}]*}/)[0];
        expect(recipeFlash).toMatch(/box-shadow:[^;]*var\(--glow-orange\)/);
    });
});

describe('knowledge css parses and blocks render as blocks', () => {
    it('every stylesheet has balanced braces (a stray one kills the rest of the file)', () => {
        for (const file of readdirSync(`${ROOT}public/css`).filter((f) => f.endsWith('.css'))) {
            const css = readFileSync(`${ROOT}public/css/${file}`, 'utf8');
            const open = (css.match(/{/g) || []).length;
            const close = (css.match(/}/g) || []).length;
            expect(`${file}: ${open} open, ${close} close`).toBe(`${file}: ${open} open, ${open} close`);
        }
    });

    it('one consequence is one bounded block (bar + header + sentence)', () => {
        expect(KNOWLEDGE_CSS).toMatch(/\.knowledge-action-effect\s*{[^}]*border-left:/);
        for (const part of ['type', 'text', 'on']) {
            const rule = (KNOWLEDGE_CSS.match(new RegExp(`\\.knowledge-action-effect-${part}\\s*{[^}]*}`)) || [''])[0];
            expect(`knowledge-action-effect-${part}: ${rule}`).toMatch(/grid-column/);
            expect(`knowledge-action-effect-${part}: ${rule}`).toMatch(/grid-row/);
        }
    });

    it('the gap BETWEEN blocks is wider than the gap INSIDE one (the old inversion)', () => {
        const listRule = KNOWLEDGE_CSS.match(/\.knowledge-action-effect-list\s*{[^}]*}/)[0];
        const blockRule = KNOWLEDGE_CSS.match(/\.knowledge-action-effect\s*{[^}]*}/)[0];
        const between = Number((listRule.match(/gap:\s*(\d+)px/) || [0, 0])[1]);
        const inside = Number((blockRule.match(/row-gap:\s*(\d+)px/) || [0, 0])[1]);
        expect(between).toBeGreaterThan(inside);
    });

    it('a facet never overflows its card (label and value shrink, then wrap)', () => {
        // The overlap this pins, measured on the shipped data: the entity-attribute
        // card of `maleDroid` carries the monospace key `Pleasure.pleasure` beside
        // "starts 0, cap 100, drains 1 per turn". A flex item's automatic minimum
        // size is its min-content, and `word-break` does not lower that number --
        // only `overflow-wrap: anywhere` does -- so the pair could not shrink into
        // a 220px card and painted over the neighbour instead.
        const row = (KNOWLEDGE_CSS.match(/\.knowledge-entity-facet\s*{[^}]*}/) || [''])[0];
        const label = (KNOWLEDGE_CSS.match(/\.knowledge-entity-facet-label\s*{[^}]*}/) || [''])[0];
        const value = (KNOWLEDGE_CSS.match(/\.knowledge-entity-facet-value\s*{[^}]*}/) || [''])[0];
        const card = (KNOWLEDGE_CSS.match(/\.knowledge-entity-card\s*{[^}]*}/) || [''])[0];
        const grid = (KNOWLEDGE_CSS.match(/\.knowledge-card-grid\s*{[^}]*}/) || [''])[0];
        expect(`facet row: ${row}`).toMatch(/flex-wrap:\s*wrap/);
        expect(`facet row: ${row}`).toMatch(/min-width:\s*0/);
        expect(`facet label: ${label}`).toMatch(/overflow-wrap:\s*anywhere/);
        expect(`facet value: ${value}`).toMatch(/min-width:\s*0/);
        expect(`facet value: ${value}`).toMatch(/overflow-wrap:\s*anywhere/);
        expect(`entity card: ${card}`).toMatch(/min-width:\s*0/);
        // A column floor may never exceed the panel that holds it.
        expect(`card grid: ${grid}`).toMatch(/minmax\(\s*min\(\s*220px,\s*100%\s*\)\s*,\s*1fr\s*\)/);
    });

    it('an unread declaration is red, and the failure set has its own bar', () => {
        expect(KNOWLEDGE_CSS).toMatch(/\.knowledge-action-effect--undeclared\s*{[^}]*border-left-color:\s*var\(--neon-red\)/);
        expect(KNOWLEDGE_CSS).toMatch(/--failure\s+\.knowledge-action-effect\s*{[^}]*border-left-color/);
        expect(KNOWLEDGE_CSS).toMatch(/\.knowledge-action-how-cell--undeclared\s*{[^}]*color:\s*var\(--neon-red\)/);
    });
});

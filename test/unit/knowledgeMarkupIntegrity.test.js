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
    'knowledge-capability-state',
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

    it('an unread declaration is red, and the failure set has its own bar', () => {
        expect(KNOWLEDGE_CSS).toMatch(/\.knowledge-action-effect--undeclared\s*{[^}]*border-left-color:\s*var\(--neon-red\)/);
        expect(KNOWLEDGE_CSS).toMatch(/--failure\s+\.knowledge-action-effect\s*{[^}]*border-left-color/);
        expect(KNOWLEDGE_CSS).toMatch(/\.knowledge-action-how-cell--undeclared\s*{[^}]*color:\s*var\(--neon-red\)/);
    });
});

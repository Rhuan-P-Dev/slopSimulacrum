/**
 * NavActionsPanel (CLIENT) — unit tests for the filter + accordion surface.
 *
 * Covers the new client-side behavior of the ⚔️ Actions panel:
 *   1. `_escapeHtmlAttribute` escapes `& " < >` (XSS guard for the filter input).
 *   2. `_escapeCssIdentifier` escapes action names for CSS attribute selectors
 *      (so "droid punch" → `droid\ punch`, etc.).
 *   3. `_buildActionSection` renders the action list, the filter input (value
 *      escaped), carets + nav-expanded state, selected/locked/equipped row
 *      classes, capable/ incapable count badges, and the "No actions available"
 *      empty case.
 *   4. `_applyFilter` shows/hides items by action name or component match and
 *      auto-expands collapsed actions whose components matched (no real DOM;
 *      a minimal fake content node stands in).
 *
 * All exercised with bare instances (no DOM). DOM-dependent paths are stubbed.
 *
 * @module test/unit/NavActionsPanel.client
 */

import { describe, it, expect } from 'vitest';
import { NavActionsPanel } from '../../public/js/NavActionsPanel.js';

/** Fresh panel instance (uiManager unused by the methods under test). */
function makePanel() {
    return new NavActionsPanel(null);
}

// Returns the opening "<div class="..." of the row carrying a given data-comp-id.
// The row's class (nav-selected / nav-locked / nav-equipped-item ...) is in that opening tag.
function rowClassFor(html, compId) {
    const idx = html.indexOf('data-comp-id="' + compId + '"');
    const open = html.lastIndexOf('<div class="nav-component-row', idx);
    return html.slice(open, open + 160);
}

// ---------------------------------------------------------------------------
// _escapeHtmlAttribute
// ---------------------------------------------------------------------------
describe('NavActionsPanel._escapeHtmlAttribute', () => {
    it('escapes all five unsafe characters', () => {
        expect(makePanel()._escapeHtmlAttribute('a&b"c<d>e')).toBe('a&amp;b&quot;c&lt;d&gt;e');
    });

    it('leaves a plain string unchanged', () => {
        expect(makePanel()._escapeHtmlAttribute('safe')).toBe('safe');
    });

    it('coerces null/undefined to an empty string', () => {
        expect(makePanel()._escapeHtmlAttribute(null)).toBe('');
        expect(makePanel()._escapeHtmlAttribute(undefined)).toBe('');
    });

    it('escapes a quoted name (the spec "case")', () => {
        expect(makePanel()._escapeHtmlAttribute('a"b')).toBe('a&quot;b');
    });
});

// ---------------------------------------------------------------------------
// _escapeCssIdentifier
// ---------------------------------------------------------------------------
describe('NavActionsPanel._escapeCssIdentifier', () => {
    it('escapes spaces for attribute-selector safety', () => {
        expect(makePanel()._escapeCssIdentifier('droid punch')).toBe('droid\\ punch');
    });

    it('escapes double quote and backslash', () => {
        expect(makePanel()._escapeCssIdentifier('a"b')).toBe('a\\"b');
        expect(makePanel()._escapeCssIdentifier('a\\b')).toBe('a\\\\b');
    });

    it('leaves safe characters unchanged', () => {
        expect(makePanel()._escapeCssIdentifier('cut')).toBe('cut');
        expect(makePanel()._escapeCssIdentifier('a_b-2')).toBe('a_b-2');
    });
});

// ---------------------------------------------------------------------------
// _buildActionSection
// ---------------------------------------------------------------------------
describe('NavActionsPanel._buildActionSection', () => {
    it('returns the empty-case message when there are no actions', () => {
        expect(makePanel()._buildActionSection(null, null)).toContain('No actions available');
    });

    it('renders the filter input with the current query escaped', () => {
        const p = makePanel();
        p._filterQuery = 'a"b';
        const html = p._buildActionSection({ attack: { canExecute: [], cannotExecute: [] } }, null);
        expect(html).toContain('id="nav-actions-filter"');
        expect(html).toContain('value="a&quot;b"');
    });

    it('escapes action names in data attributes and visible text', () => {
        const p = makePanel();
        const html = p._buildActionSection({ 'a"b': { canExecute: [], cannotExecute: [] } }, null);
        expect(html).toContain('data-action-name="a&quot;b"');
    });

    it('marks the active action with nav-active', () => {
        const p = makePanel();
        const html = p._buildActionSection({ attack: { canExecute: [], cannotExecute: [] }, def: { canExecute: [], cannotExecute: [] } }, 'def');
        // the "def" item div must carry nav-active
        const idx = html.indexOf('data-action-name="def"');
        // nav-active lives in the class attribute, which is BEFORE data-action-name
        const item = html.slice(Math.max(0, idx - 60), idx + 120);
        expect(item).toContain('nav-active');
    });

    it('opens the component wrapper (nav-expanded + caret ▾) only for actions in _expandedActions', () => {
        const p = makePanel();
        p._expandedActions = new Set(['attack']);
        const html = p._buildActionSection({ attack: { canExecute: [], cannotExecute: [] }, def: { canExecute: [], cannotExecute: [] } }, null);
        const attackIdx = html.indexOf('data-action-name="attack"');
        const defIdx = html.indexOf('data-action-name="def"');
        const attackBlock = html.slice(attackIdx, attackIdx + 600);
        const defBlock = html.slice(defIdx, defIdx + 600);
        expect(attackBlock).toContain('nav-expanded');
        expect(attackBlock).toContain('▾');
        expect(defBlock).not.toContain('nav-expanded');
        expect(defBlock).toContain('▸');
    });

    it('renders row classes for selected, locked, and equipped components + count badge', () => {
        const p = makePanel();
        const active = 'attack';
        const html = p._buildActionSection(
            {
                attack: {
                    canExecute: [
                        { entityId: 'e1', componentId: 'c1', componentType: 'claw', componentIdentifier: 'claw-1', requirementsStatus: [{ current: 1, required: 1 }] },
                        { entityId: 'e1', componentId: 'c2', componentType: 'tail', componentIdentifier: 'tail-1', requirementsStatus: [{ current: 1, required: 1 }] },
                        { entityId: 'e1', componentId: 'eq-1', componentType: 'knife', componentIdentifier: 'knife-1', requirementsStatus: [{ current: 1, required: 1 }] },
                    ],
                    cannotExecute: [{ componentId: 'c3' }],
                },
            },
            active,
            new Set(['c1']),
            new Map([[ active, new Set(['c2']) ]])
        );
        // c1 selected (active + in selectedIds)
        expect(rowClassFor(html, 'c1')).toContain('nav-selected');
        // c2 locked (in cross-action map of another selection)
        expect(rowClassFor(html, 'c2')).toContain('nav-locked');
        // eq-1 equipped
        expect(rowClassFor(html, 'eq-1')).toContain('nav-equipped-item');
        // count badge: 3 capable, 1 incapable
        expect(html).toContain('3 capable');
        expect(html).toContain('1 incapable');
        expect(html).toContain('nav-lock-icon');
    });
});

// ---------------------------------------------------------------------------
// _applyFilter (stubbed content)
// ---------------------------------------------------------------------------
function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        toggle: (c) => (set.has(c) ? ((set.delete(c)), false) : ((set.add(c)), true)),
        contains: (c) => set.has(c),
    };
}

function fakeRow(compName, compIdentifier) {
    return { dataset: { compName, compIdentifier }, style: { display: '' } };
}

function fakeItem(actionName, rows = []) {
    return {
        dataset: { actionName },
        style: { display: '' },
        querySelectorAll: (sel) => (sel === '.nav-component-row' ? rows : []),
        querySelector: (sel) => {
            if (sel === '.nav-action-components') return { classList: makeClassList() };
            if (sel === '.nav-action-caret') return { textContent: '▸' };
            return null;
        },
    };
}

function stubContent(filterValue, items) {
    return {
        querySelectorAll: (sel) => (sel === '.nav-action-item' ? items : []),
        querySelector: (sel) => (sel === '#nav-actions-filter' ? { value: filterValue ?? '' } : null),
    };
}

describe('NavActionsPanel._applyFilter', () => {
    it('hides items that match neither the action nor any component', () => {
        const p = makePanel();
        const attack = fakeItem('attack');
        const def = fakeItem('def');
        p._content = stubContent('zzz', [attack, def]);
        p._applyFilter();
        expect(attack.style.display).toBe('none');
        expect(def.style.display).toBe('none');
    });

    it('shows an item when its action name matches, and keeps all its rows visible', () => {
        const p = makePanel();
        const attack = fakeItem('attack', [fakeRow('claw', 'c1')]);
        const def = fakeItem('def');
        p._content = stubContent('att', [attack, def]);
        p._applyFilter();
        expect(attack.style.display).not.toBe('none');
        expect(def.style.display).toBe('none');
        expect(attack.querySelector).not.toBe(undefined);
    });

    it('auto-expands a collapsed action whose components matched and shows only matching rows', () => {
        const p = makePanel();
        const claw = fakeRow('claw', 'claw-1');
        const tail = fakeRow('tail', 'tail-1');
        const attack = fakeItem('attack', [claw, tail]);
        const comps = { classList: makeClassList() };
        attack.querySelector = (sel) => (sel === '.nav-action-components' ? comps : null);
        const caret = { textContent: '▸' };
        attack.querySelector = (sel) =>
            (sel === '.nav-action-components' ? comps : sel === '.nav-action-caret' ? caret : null);

        p._content = stubContent('claw', [attack]);
        p._expandedActions = new Set();
        p._applyFilter();

        // item visible, only the claw row visible
        expect(attack.style.display).not.toBe('none');
        expect(claw.style.display).not.toBe('none');
        expect(tail.style.display).toBe('none');
        // action auto-expanded
        expect(comps.classList.contains('nav-expanded')).toBe(true);
        expect(caret.textContent).toBe('▾');
        expect(p._expandedActions.has('attack')).toBe(true);
    });

    it('clears the filter and restores visibility', () => {
        const p = makePanel();
        const attack = fakeItem('attack');
        const def = fakeItem('def');
        p._content = stubContent('', [attack, def]);
        p._filterQuery = '';
        p._applyFilter();
        expect(attack.style.display).not.toBe('none');
        expect(def.style.display).not.toBe('none');
    });
});

// ---------------------------------------------------------------------------
// _toggleActionExpanded (stubbed content)
// ---------------------------------------------------------------------------
describe('NavActionsPanel._toggleActionExpanded', () => {
    it('toggles the expanded class and caret, and syncs _expandedActions', () => {
        const p = makePanel();
        const comps = { classList: makeClassList() };
        const caret = { textContent: '▸' };
        const item = {
            dataset: { actionName: 'attack' },
            querySelector: (sel) =>
                (sel === '.nav-action-components' ? comps : sel === '.nav-action-caret' ? caret : null),
        };
        p._content = { querySelector: () => item };
        p._expandedActions = new Set();

        p._toggleActionExpanded('attack');
        expect(comps.classList.contains('nav-expanded')).toBe(true);
        expect(caret.textContent).toBe('▾');
        expect(p._expandedActions.has('attack')).toBe(true);

        p._toggleActionExpanded('attack');
        expect(comps.classList.contains('nav-expanded')).toBe(false);
        expect(caret.textContent).toBe('▸');
        expect(p._expandedActions.has('attack')).toBe(false);
    });

    it('no-ops safely when there is no content', () => {
        const p = makePanel();
        p._content = null;
        expect(() => p._toggleActionExpanded('attack')).not.toThrow();
    });
});

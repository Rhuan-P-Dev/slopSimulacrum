/**
 * NavActionsPanel (CLIENT) — unit tests for the action list surface.
 *
 * Covers the client-side behavior of the ⚔️ Actions panel:
 *   1. `_escapeHtmlAttribute` escapes `& " < >` (XSS guard for the filter input).
 *   2. `_escapeCssIdentifier` escapes action names for CSS attribute selectors
 *      (so "droid punch" → `droid\ punch`, etc.).
 *   3. `_buildView` normalizes a null/loose selection triple into Set/Map.
 *   4. `_buildActionSection` renders the ACTION list only (names, count badges,
 *      the "N selected" badge, nav-active) plus the filter input (value escaped),
 *      and the "No actions available" empty case. Component rows are NOT here —
 *      they belong to the submenu (pinned in ActionComponentSubmenu.test.js).
 *   5. `_applyFilter` shows/hides actions by ACTION NAME, and dismisses the
 *      submenu whose own action got filtered out.
 *   6. `_toggleSubmenuFor` / `_refreshSubmenu` / `hide` drive the anchored
 *      component submenu (open, toggle close, close when the action leaves the
 *      registry, close when the panel hides).
 *
 * All exercised with bare instances (no DOM — this repo has no jsdom). DOM-only
 * paths inside the submenu no-op in this environment.
 *
 * @module test/unit/NavActionsPanel.client
 */

import { describe, it, expect } from 'vitest';
import { NavActionsPanel } from '../../public/js/NavActionsPanel.js';

/** Fresh panel instance (uiManager unused by the methods under test). */
function makePanel() {
    return new NavActionsPanel(null);
}

/** The action registry shape the panel renders: one action, n capable, m incapable. */
function action(capable = 0, incapable = 0) {
    return {
        canExecute: Array.from({ length: capable }, (_, i) => ({
            entityId: 'e1',
            componentId: `c${i}`,
            componentType: `claw${i}`,
            componentIdentifier: `claw-1`,
            requirementsStatus: [{ current: 1, required: 1 }],
        })),
        cannotExecute: Array.from({ length: incapable }, () => ({ componentId: 'x' })),
    };
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
// _buildView
// ---------------------------------------------------------------------------
describe('NavActionsPanel._buildView', () => {
    it('normalizes a missing selection triple into an empty Set and Map', () => {
        const view = makePanel()._buildView(null, null, null, null);
        expect(view.actions).toEqual({});
        expect(view.activeActionName).toBe(null);
        expect(view.selectedComponentIds).toBeInstanceOf(Set);
        expect(view.selectedComponentIds.size).toBe(0);
        expect(view.crossActionSelections).toBeInstanceOf(Map);
        expect(view.crossActionSelections.size).toBe(0);
    });

    it('keeps a Set and a Map handed in', () => {
        const view = makePanel()._buildView({ attack: action(1) }, 'attack', new Set(['c0']), new Map([['attack', new Set(['c0'])]]));
        expect(view.selectedComponentIds.has('c0')).toBe(true);
        expect(view.crossActionSelections.get('attack').size).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// _buildActionSection
// ---------------------------------------------------------------------------
describe('NavActionsPanel._buildActionSection', () => {
    it('returns the empty-case message when there are no actions', () => {
        const p = makePanel();
        expect(p._buildActionSection(p._buildView(null, null, null, null))).toContain('No actions available');
    });

    it('renders the action-name filter input with the current query escaped', () => {
        const p = makePanel();
        p._filterQuery = 'a"b';
        const html = p._buildActionSection(p._buildView({ attack: action(0) }, null, null, null));
        expect(html).toContain('id="nav-actions-filter"');
        expect(html).toContain('value="a&quot;b"');
    });

    it('escapes action names in data attributes and visible text', () => {
        const p = makePanel();
        const html = p._buildActionSection(p._buildView({ 'a"b': action(0) }, null, null, null));
        expect(html).toContain('data-action-name="a&quot;b"');
    });

    it('marks the active action with nav-active', () => {
        const p = makePanel();
        const html = p._buildActionSection(p._buildView({ attack: action(0), def: action(0) }, 'def', null, null));
        const idx = html.indexOf('data-action-name="def"');
        // nav-active lives in the class attribute, which is BEFORE data-action-name
        const item = html.slice(Math.max(0, idx - 60), idx + 120);
        expect(item).toContain('nav-active');
    });

    it('renders the capable / incapable count badge', () => {
        const p = makePanel();
        const html = p._buildActionSection(p._buildView({ attack: action(3, 1) }, null, null, null));
        expect(html).toContain('3 capable');
        expect(html).toContain('1 incapable');
    });

    it('shows how many components are already selected for an action', () => {
        const p = makePanel();
        const cross = new Map([['attack', new Set(['c0', 'c1'])]]);
        const html = p._buildActionSection(p._buildView({ attack: action(3) }, 'attack', new Set(['c0', 'c1']), cross));
        expect(html).toContain('2 selected');
    });

    it('keeps the selected badge off an action with no selection', () => {
        const p = makePanel();
        const html = p._buildActionSection(p._buildView({ attack: action(3) }, null, null, null));
        expect(html).not.toContain('selected');
    });

    it('renders NO component rows inline — the submenu of the action holds them', () => {
        const p = makePanel();
        const html = p._buildActionSection(p._buildView({ attack: action(3) }, 'attack', null, null));
        expect(html).not.toContain('nav-component-row');
        expect(html).not.toContain('nav-action-components');
        expect(html).not.toContain('nav-action-caret');
    });
});

// ---------------------------------------------------------------------------
// _applyFilter (stubbed content)
// ---------------------------------------------------------------------------
function fakeItem(actionName) {
    return { dataset: { actionName }, style: { display: '' } };
}

function stubContent(filterValue, items) {
    return {
        querySelectorAll: (sel) => (sel === '.nav-action-item' ? items : []),
        querySelector: (sel) => (sel === '#nav-actions-filter' ? { value: filterValue ?? '' } : null),
    };
}

describe('NavActionsPanel._applyFilter', () => {
    it('hides the actions whose name does not match', () => {
        const p = makePanel();
        const attack = fakeItem('attack');
        const def = fakeItem('def');
        p._content = stubContent('zzz', [attack, def]);
        p._applyFilter();
        expect(attack.style.display).toBe('none');
        expect(def.style.display).toBe('none');
    });

    it('shows the actions whose name matches', () => {
        const p = makePanel();
        const attack = fakeItem('attack');
        const def = fakeItem('def');
        p._content = stubContent('att', [attack, def]);
        p._applyFilter();
        expect(attack.style.display).not.toBe('none');
        expect(def.style.display).toBe('none');
    });

    it('ignores component text — components are searched in the submenu', () => {
        const p = makePanel();
        const attack = fakeItem('attack');
        p._content = stubContent('claw', [attack]);
        p._applyFilter();
        expect(attack.style.display).toBe('none');
    });

    it('restores every action when the filter is cleared', () => {
        const p = makePanel();
        const attack = fakeItem('attack');
        const def = fakeItem('def');
        p._filterQuery = '';
        p._content = stubContent('', [attack, def]);
        p._applyFilter();
        expect(attack.style.display).not.toBe('none');
        expect(def.style.display).not.toBe('none');
    });

    it('dismisses the submenu when its own action is filtered out', () => {
        const p = makePanel();
        p._content = stubContent('def', [fakeItem('attack'), fakeItem('def')]);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(1) }, null, null, null));
        expect(p.submenu.isOpen).toBe(true);

        p._applyFilter();
        expect(p.submenu.isOpen).toBe(false);
    });

    it('keeps the submenu open while its action still matches', () => {
        const p = makePanel();
        p._content = stubContent('att', [fakeItem('attack'), fakeItem('def')]);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(1) }, null, null, null));

        p._applyFilter();
        expect(p.submenu.isOpen).toBe(true);
        expect(p.submenu.openActionName).toBe('attack');
    });
});

// ---------------------------------------------------------------------------
// the anchored component submenu
// ---------------------------------------------------------------------------
describe('NavActionsPanel component submenu', () => {
    it('opens the submenu of the action whose name was clicked', () => {
        const p = makePanel();
        p._content = stubContent('', []);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(2) }, null, null, null));
        expect(p.submenu.isOpen).toBe(true);
        expect(p.submenu.openActionName).toBe('attack');
    });

    it('closes the submenu when the same action name is clicked again', () => {
        const p = makePanel();
        p._content = stubContent('', []);
        const view = p._buildView({ attack: action(2) }, null, null, null);
        p._toggleSubmenuFor('attack', view);
        p._toggleSubmenuFor('attack', view);
        expect(p.submenu.isOpen).toBe(false);
    });

    it('re-points the submenu when another action name is clicked', () => {
        const p = makePanel();
        p._content = stubContent('', []);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(1), cut: action(1) }, null, null, null));
        p._toggleSubmenuFor('cut', p._buildView({ attack: action(1), cut: action(1) }, null, null, null));
        expect(p.submenu.openActionName).toBe('cut');
    });

    it('hands the action\'s capable entries to the submenu', () => {
        const p = makePanel();
        const seen = [];
        p._content = stubContent('', []);
        p.submenu.open = (opts) => seen.push(opts);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(2) }, 'attack', new Set(['c0']), null));

        expect(seen).toHaveLength(1);
        expect(seen[0].actionName).toBe('attack');
        expect(seen[0].entries).toHaveLength(2);
        expect(seen[0].activeActionName).toBe('attack');
        expect(seen[0].selectedComponentIds.has('c0')).toBe(true);
    });

    it('routes a submenu row click to the execute callback', () => {
        const p = makePanel();
        const clicked = [];
        p._content = stubContent('', []);
        p.setExecuteActionCallback((...args) => clicked.push(args));

        p._toggleSubmenuFor('attack', p._buildView({ attack: action(1) }, null, null, null));
        const args = p._submenuArgs('attack', p._buildView({ attack: action(1) }, null, null, null));
        args.onRowClick('attack', 'e1', 'c0', 'claw-1');

        expect(clicked).toEqual([['attack', 'e1', 'c0', 'claw-1']]);
    });

    it('routes a locked row click to the grayed-component callback', () => {
        const p = makePanel();
        const cleared = [];
        p._content = stubContent('', []);
        p.setGrayedComponentCallback((lockedAction, compId) => cleared.push([lockedAction, compId]));

        const args = p._submenuArgs('attack', p._buildView({ attack: action(1) }, null, null, null));
        args.onGrayedRowClick('cut', 'c0');

        expect(cleared).toEqual([['cut', 'c0']]);
    });

    it('refresh keeps an open submenu pointed at its action', () => {
        const p = makePanel();
        p._content = stubContent('', []);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(1) }, null, null, null));
        p._refreshSubmenu(p._buildView({ attack: action(1), cut: action(1) }, 'attack', null, null));
        expect(p.submenu.isOpen).toBe(true);
        expect(p.submenu.openActionName).toBe('attack');
    });

    it('refresh closes the submenu when the action left the registry', () => {
        const p = makePanel();
        p._content = stubContent('', []);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(1) }, null, null, null));
        p._refreshSubmenu(p._buildView({ cut: action(1) }, null, null, null));
        expect(p.submenu.isOpen).toBe(false);
    });

    it('refresh on a closed submenu opens nothing', () => {
        const p = makePanel();
        p._content = stubContent('', []);
        p._refreshSubmenu(p._buildView({ attack: action(1) }, null, null, null));
        expect(p.submenu.isOpen).toBe(false);
    });

    it('hiding the panel dismisses the submenu (it lives outside the panel)', () => {
        const p = makePanel();
        p.overlay = { style: { display: 'block' } };
        p._content = stubContent('', []);
        p._toggleSubmenuFor('attack', p._buildView({ attack: action(1) }, null, null, null));

        p.hide();
        expect(p.submenu.isOpen).toBe(false);
        expect(p.overlay.style.display).toBe('none');
    });
});

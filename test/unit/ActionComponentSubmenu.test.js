/**
 * ActionComponentSubmenu (CLIENT) — unit tests for the anchored component picker.
 *
 * Covers the pure surface of the submenu (no jsdom in this repo — see
 * `vitest.config.js`, environment 'node'):
 *   1. `computeSubmenuPosition` — right-side placement, left flip, edge clamps.
 *   2. `filterComponentEntries` — the submenu's own search bar: component type
 *      and identifier, case-insensitive substring; blank query keeps everything.
 *   3. `buildComponentRowsHtml` — the row classes the panel's CSS styles:
 *      nav-selected / nav-locked / nav-equipped-item, the lock tooltip, and
 *      attribute escaping.
 *   4. The class state machine in a DOM-less env: open()/refresh()/close() track
 *      the action they point at, and `document`-only paths no-op instead of throwing.
 *
 * @module test/unit/ActionComponentSubmenu
 */

import { describe, it, expect } from 'vitest';
import {
    ActionComponentSubmenu,
    buildComponentRowsHtml,
    computeSubmenuPosition,
    filterComponentEntries,
} from '../../public/js/ActionComponentSubmenu.js';

/** Opening tag of the row carrying a given data-comp-id (its classes live there). */
function rowTagFor(html, compId) {
    const idx = html.indexOf('data-comp-id="' + compId + '"');
    const open = html.lastIndexOf('<div class="nav-component-row', idx);
    return html.slice(open, open + 200);
}

// ---------------------------------------------------------------------------
// computeSubmenuPosition
// ---------------------------------------------------------------------------
describe('computeSubmenuPosition', () => {
    const anchor = { left: 100, right: 300, top: 40 };

    it('places the submenu on the right of the anchor when the slot fits', () => {
        const pos = computeSubmenuPosition({
            anchorRect: anchor, menuWidth: 200, menuHeight: 120,
            viewportWidth: 1200, viewportHeight: 800,
        });
        // right edge (300) + default gap (8)
        expect(pos.left).toBe(308);
        expect(pos.top).toBe(40);
    });

    it('flips to the left of the anchor when the right side cannot hold it', () => {
        const pos = computeSubmenuPosition({
            // anchor hugs the right edge: 808 + 200 would overflow a 1000px viewport
            anchorRect: { left: 600, right: 800, top: 40 }, menuWidth: 200, menuHeight: 120,
            viewportWidth: 1000, viewportHeight: 800,
        });
        // anchor.left (600) - gap (8) - menuWidth (200)
        expect(pos.left).toBe(392);
    });

    it('clamps away from the right edge when the anchor itself is off-screen', () => {
        const pos = computeSubmenuPosition({
            anchorRect: { left: 500, right: 560, top: 40 }, menuWidth: 200, menuHeight: 120,
            viewportWidth: 400, viewportHeight: 800,
        });
        // 400 - margin (8) - menuWidth (200)
        expect(pos.left).toBe(192);
    });

    it('keeps the left margin when no side can hold the menu', () => {
        const pos = computeSubmenuPosition({
            anchorRect: anchor, menuWidth: 400, menuHeight: 120,
            viewportWidth: 380, viewportHeight: 800,
        });
        expect(pos.left).toBe(8);
    });

    it('pushes the menu up when it would run past the bottom edge', () => {
        const pos = computeSubmenuPosition({
            anchorRect: { left: 10, right: 50, top: 700 }, menuWidth: 100, menuHeight: 200,
            viewportWidth: 1200, viewportHeight: 800,
        });
        // 800 - margin (8) - height (200)
        expect(pos.top).toBe(592);
    });

    it('clamps to the top margin when the menu is taller than the viewport', () => {
        const pos = computeSubmenuPosition({
            anchorRect: { left: 10, right: 50, top: 700 }, menuWidth: 100, menuHeight: 900,
            viewportWidth: 1200, viewportHeight: 800,
        });
        expect(pos.top).toBe(8);
    });
});

// ---------------------------------------------------------------------------
// filterComponentEntries
// ---------------------------------------------------------------------------
describe('filterComponentEntries', () => {
    const entries = [
        { componentId: 'c1', componentType: 'claw', componentIdentifier: 'claw-1' },
        { componentId: 'c2', componentType: 'tail', componentIdentifier: 'tail-9' },
    ];

    it('returns every entry for a blank or whitespace query', () => {
        expect(filterComponentEntries(entries, '')).toHaveLength(2);
        expect(filterComponentEntries(entries, '   ')).toHaveLength(2);
        expect(filterComponentEntries(entries, null)).toHaveLength(2);
        expect(filterComponentEntries(entries, undefined)).toHaveLength(2);
    });

    it('matches the component type case-insensitively', () => {
        expect(filterComponentEntries(entries, 'CLA').map((e) => e.componentId)).toEqual(['c1']);
    });

    it('matches the component identifier', () => {
        expect(filterComponentEntries(entries, '9').map((e) => e.componentId)).toEqual(['c2']);
    });

    it('returns nothing when no component matches', () => {
        expect(filterComponentEntries(entries, 'engine')).toEqual([]);
    });

    it('tolerates a missing list and entries without fields', () => {
        expect(filterComponentEntries(null, 'x')).toEqual([]);
        expect(filterComponentEntries([{}], 'x')).toEqual([]);
        expect(filterComponentEntries([{}], '')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// buildComponentRowsHtml
// ---------------------------------------------------------------------------
describe('buildComponentRowsHtml', () => {
    const ok = { current: 2, required: 1 };
    const c1 = { entityId: 'e1', componentId: 'c1', componentType: 'claw', componentIdentifier: 'claw-1', requirementsStatus: [ok] };
    const c2 = { entityId: 'e1', componentId: 'c2', componentType: 'tail', componentIdentifier: 'tail-1', requirementsStatus: [ok] };
    const eq = { entityId: 'e1', componentId: 'eq-1', componentType: 'knife', componentIdentifier: 'knife-1', requirementsStatus: [ok] };
    const entries = [c1, c2, eq];

    it('marks a component selected for the action the submenu is open for', () => {
        const html = buildComponentRowsHtml({
            actionName: 'attack', entries, activeActionName: 'attack',
            selectedComponentIds: new Set(['c1']), componentToActionMap: new Map(),
        });
        expect(rowTagFor(html, 'c1')).toContain('nav-selected');
        expect(rowTagFor(html, 'c2')).not.toContain('nav-selected');
    });

    it('does not mark a row selected while another action holds the selection', () => {
        const html = buildComponentRowsHtml({
            actionName: 'defend', entries, activeActionName: 'attack',
            selectedComponentIds: new Set(['c1']), componentToActionMap: new Map(),
        });
        expect(html).not.toContain('nav-selected');
    });

    it('marks a component locked to ANOTHER action and names that action in the tooltip', () => {
        const html = buildComponentRowsHtml({
            actionName: 'attack', entries, activeActionName: 'attack',
            selectedComponentIds: new Set(),
            componentToActionMap: new Map([['c2', 'cut']]),
        });
        expect(rowTagFor(html, 'c2')).toContain('nav-locked');
        expect(html).toContain('nav-lock-icon');
        expect(html).toContain("Selected in 'cut'");
    });

    it('never marks a component selected in this same action as locked', () => {
        const html = buildComponentRowsHtml({
            actionName: 'attack', entries, activeActionName: 'attack',
            selectedComponentIds: new Set(['c1']),
            componentToActionMap: new Map([['c1', 'attack']]),
        });
        expect(rowTagFor(html, 'c1')).toContain('nav-selected');
        expect(rowTagFor(html, 'c1')).not.toContain('nav-locked');
    });

    it('marks an equipped item row (eq- id) with the equipped class and icon', () => {
        const html = buildComponentRowsHtml({
            actionName: 'cut', entries, activeActionName: 'cut',
            selectedComponentIds: null, componentToActionMap: null,
        });
        expect(rowTagFor(html, 'eq-1')).toContain('nav-equipped-item');
        expect(html).toContain('nav-equipped-icon');
    });

    it('escapes quotes and angle brackets coming from the world', () => {
        const html = buildComponentRowsHtml({
            actionName: 'a"b',
            entries: [{ entityId: 'e1', componentId: 'c9', componentType: '<x>', componentIdentifier: 'i"1', requirementsStatus: [] }],
            activeActionName: 'a"b',
            selectedComponentIds: null,
            componentToActionMap: new Map([['c9', 'cut"']]),
        });
        expect(html).toContain('data-action="a&quot;b"');
        expect(html).toContain('data-comp-name="&lt;x&gt;"');
        // The tooltip's own quotes are ours; only the world's value is escaped.
        expect(html).toContain("Selected in 'cut&quot;'");
        expect(html).not.toContain('<x>');
    });

    it('renders nothing for an empty or missing entry list', () => {
        const base = { actionName: 'attack', activeActionName: null };
        expect(buildComponentRowsHtml({ ...base, entries: [] })).toBe('');
        expect(buildComponentRowsHtml({ ...base, entries: null })).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Class state machine (no document in the node test env)
// ---------------------------------------------------------------------------
describe('ActionComponentSubmenu state', () => {
    it('starts closed with no element', () => {
        const menu = new ActionComponentSubmenu();
        expect(menu.isOpen).toBe(false);
        expect(menu.openActionName).toBe(null);
        expect(menu.element).toBe(null);
    });

    it('tracks the action it opens, and closes again', () => {
        const menu = new ActionComponentSubmenu();
        menu.open({ actionName: 'attack', entries: [], anchorEl: null });
        expect(menu.isOpen).toBe(true);
        expect(menu.openActionName).toBe('attack');
        menu.close();
        expect(menu.isOpen).toBe(false);
        expect(menu.openActionName).toBe(null);
    });

    it('ignores an open() without an action name', () => {
        const menu = new ActionComponentSubmenu();
        menu.open({ actionName: '', entries: [] });
        expect(menu.isOpen).toBe(false);
    });

    it('refresh() on a closed submenu stays closed', () => {
        const menu = new ActionComponentSubmenu();
        menu.refresh({ actionName: 'attack', entries: [] });
        expect(menu.isOpen).toBe(false);
    });

    it('refresh() keeps the action it was opened for', () => {
        const menu = new ActionComponentSubmenu();
        menu.open({ actionName: 'attack', entries: [] });
        menu.refresh({ actionName: 'defend', entries: [] });
        expect(menu.openActionName).toBe('attack');
    });

    it('close() is safe to call twice', () => {
        const menu = new ActionComponentSubmenu();
        menu.open({ actionName: 'attack', entries: [] });
        menu.close();
        expect(() => menu.close()).not.toThrow();
        expect(menu.isOpen).toBe(false);
    });
});

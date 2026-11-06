/**
 * ActionComponentSubmenu (CLIENT) — the DOM paths of the anchored picker.
 *
 * `vitest.config.js` runs the suite in the `node` environment (this repo has no
 * jsdom), so the pure surface is pinned in `ActionComponentSubmenu.test.js` and
 * the DOM assembly is pinned HERE over a hand-rolled fake node — the same
 * technique `NavActionsPanel.client.test.js` uses with its stub content. The
 * client reads `document` and `window` as globals, so this fake is installed as
 * globals for the duration of each test and removed afterwards.
 *
 * What is pinned: the submenu is created on `document.body` above the active
 * panel; it is titled with its action; its rows carry the panel's selection
 * classes; it searches its own components without rebuilding the search input
 * (that input holds the user's focus and query); row clicks reach the right
 * callback; it anchors beside the action row; Escape closes the submenu WITHOUT
 * closing the panel; `close()` leaves no element and no document listener behind.
 *
 * @module test/unit/ActionComponentSubmenu.dom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActionComponentSubmenu } from '../../public/js/ActionComponentSubmenu.js';
import { NavActionsPanel } from '../../public/js/NavActionsPanel.js';

/** Minimal element node: attributes, children, listeners, and a fixed rect. */
function fakeEl(tag) {
    return {
        tagName: tag,
        children: [],
        attrs: {},
        style: {},
        dataset: {},
        className: '',
        textContent: '',
        innerHTML: '',
        value: '',
        type: '',
        placeholder: '',
        autocomplete: '',
        offsetWidth: 200,
        offsetHeight: 150,
        isConnected: true,
        parentNode: null,
        onclick: null,
        listeners: {},
        setAttribute(key, value) { this.attrs[key] = value; },
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) this.children.splice(i, 1);
            child.parentNode = null;
        },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const list = this.listeners[type] || [];
            const i = list.findIndex((f) => f === fn);
            if (i >= 0) list.splice(i, 1);
        },
        closest() { return null; },
        getBoundingClientRect() { return { left: 100, right: 300, top: 40, bottom: 60 }; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        fire(type, event = {}) {
            (this.listeners[type] || []).forEach((fn) => fn(event));
            if (type === 'click' && typeof this.onclick === 'function') this.onclick(event);
        },
        listenerCount(type) { return (this.listeners[type] || []).length; },
    };
}

/** Installs the fake document/window globals and returns them. */
function installDom() {
    const doc = fakeEl('html');
    doc.body = fakeEl('body');
    doc.createElement = (tag) => fakeEl(tag);
    globalThis.document = doc;

    const win = fakeEl('window');
    win.innerWidth = 1200;
    win.innerHeight = 800;
    globalThis.window = win;

    return { doc, win };
}

/** One capable-component entry of the fixture action. */
function entry(componentId, componentType, identifier) {
    return {
        entityId: 'e1',
        componentId,
        componentType,
        componentIdentifier: identifier,
        requirementsStatus: [{ current: 1, required: 1 }],
    };
}

const ENTRIES = [entry('c0', 'claw', 'claw-1'), entry('c1', 'tail', 'tail-1'), entry('eq-9', 'knife', 'knife-1')];

/** Opens a submenu with the fixture action, selection and lock state. */
function openMenu(overrides = {}) {
    const menu = new ActionComponentSubmenu();
    const clicked = [];
    const cleared = [];
    menu.open({
        actionName: 'attack',
        entries: ENTRIES,
        anchorEl: fakeEl('div'),
        activeActionName: 'attack',
        selectedComponentIds: new Set(['c0']),
        crossActionSelections: new Map([['attack', new Set(['c0'])], ['cut', new Set(['c1'])]]),
        onRowClick: (...args) => clicked.push(args),
        onGrayedRowClick: (...args) => cleared.push(args),
        ...overrides,
    });
    const [header, search, list, hint] = menu.element.children;
    return { menu, el: menu.element, header, search, list, hint, clicked, cleared };
}

/** Clicks a component row inside the submenu's list. */
function clickRow(list, { action, compId, compIdentifier }) {
    const row = fakeEl('div');
    row.dataset = { action, entity: 'e1', compId, compIdentifier };
    list.fire('click', { target: { closest: () => row } });
}

// ---------------------------------------------------------------------------
// submenu DOM
// ---------------------------------------------------------------------------
describe('ActionComponentSubmenu over a fake DOM', () => {
    let doc;
    let win;

    beforeEach(() => {
        ({ doc, win } = installDom());
    });

    afterEach(() => {
        delete globalThis.document;
        delete globalThis.window;
    });

    it('mounts on document.body above the active panel, titled with its action', () => {
        expect(doc.body.children).toHaveLength(0);
        const { menu, el, header } = openMenu();

        expect(doc.body.children).toHaveLength(1);
        expect(el.parentNode).toBe(doc.body);
        expect(el.attrs.role).toBe('dialog');
        // Above the backdrop (99) and the manager's active panel (110).
        expect(Number(el.style.zIndex)).toBeGreaterThan(110);
        expect(header.children[0].textContent).toBe('attack');
        expect(menu.isOpen).toBe(true);
    });

    it('renders the action search bar with a placeholder the panel does not share', () => {
        const { search } = openMenu();
        expect(search.placeholder).toContain('Search components');
        expect(search.autocomplete).toBe('off');
    });

    it('marks the selected row, the row locked to another action, and the equipped row', () => {
        const { list, hint } = openMenu();

        expect(list.innerHTML).toContain('nav-component-row nav-selected');
        expect(list.innerHTML).toContain('nav-locked');
        expect(list.innerHTML).toContain("Selected in 'cut'");
        expect(list.innerHTML).toContain('nav-equipped-item');
        // Selection feedback: one component is chosen for this action.
        expect(hint.textContent).toContain('1 selected');
    });

    it('anchors beside the action row (right edge + gap, at the row top)', () => {
        const { el } = openMenu();
        expect(el.style.left).toBe('308px');
        expect(el.style.top).toBe('40px');
    });

    it('searches its own components without rebuilding the search input', () => {
        const { menu, el, search, list } = openMenu();

        search.value = 'tail';
        search.fire('input');
        expect(list.innerHTML).toContain('tail-1');
        expect(list.innerHTML).not.toContain('claw-1');
        // The SAME input node survives: focus and the typed query must not be lost.
        expect(menu.element).toBe(el);
    });

    it('says so when no component matches the search', () => {
        const { search, list } = openMenu();
        search.value = 'zzz';
        search.fire('input');
        expect(list.textContent).toContain('No component matches "zzz".');
    });

    it('says so when no component can perform the action at all', () => {
        const { list } = openMenu({ entries: [] });
        expect(list.textContent).toContain('No component can perform this action.');
    });

    it('toggles a free component and clears a locked one on click', () => {
        const { list, clicked, cleared } = openMenu();

        clickRow(list, { action: 'attack', compId: 'c0', compIdentifier: 'claw-1' });
        expect(clicked).toEqual([['attack', 'e1', 'c0', 'claw-1']]);

        // c1 is locked to 'cut' — the click resolves the conflict instead.
        clickRow(list, { action: 'attack', compId: 'c1', compIdentifier: 'tail-1' });
        expect(cleared).toEqual([['cut', 'c1']]);
    });

    it('ignores a click that is not on a component row', () => {
        const { list, clicked } = openMenu();
        list.fire('click', { target: { closest: () => null } });
        expect(clicked).toHaveLength(0);
    });

    it('keeps its action across a refresh and re-renders only the list', () => {
        const { menu, list } = openMenu();
        menu.refresh({ actionName: 'cut', entries: [entry('c0', 'claw', 'claw-1')], anchorEl: fakeEl('div'), activeActionName: 'attack', selectedComponentIds: new Set() });

        expect(menu.openActionName).toBe('attack');
        expect(list.innerHTML).toContain('claw-1');
        expect(list.innerHTML).not.toContain('tail-1');
    });

    it('closes on Escape WITHOUT closing the panel with it', () => {
        openMenu();
        let stopped = false;
        expect(doc.listenerCount('keydown')).toBe(1);

        doc.fire('keydown', { key: 'Escape', stopPropagation: () => { stopped = true; } });

        // OverlayManager's document-level Escape (which closes the whole panel)
        // sits in the bubble phase, so stopping propagation here is what keeps
        // the panel open — and the submenu is gone.
        expect(stopped).toBe(true);
        expect(doc.body.children).toHaveLength(0);
    });

    it('does not swallow other keys while the submenu is open', () => {
        openMenu();
        let swallowed = false;
        doc.fire('keydown', { key: 'a', stopPropagation: () => { swallowed = true; } });
        expect(swallowed).toBe(false);
    });

    it('leaves no element and no document listener behind when closed', () => {
        const { menu } = openMenu();
        expect(doc.listenerCount('keydown')).toBe(1);
        expect(win.listenerCount('resize')).toBe(1);

        menu.close();

        expect(menu.isOpen).toBe(false);
        expect(doc.body.children).toHaveLength(0);
        expect(doc.listenerCount('keydown')).toBe(0);
        expect(win.listenerCount('resize')).toBe(0);
    });

    it('keeps exactly one Escape handler when repointed at another action without closing', () => {
        const { menu } = openMenu();
        // The panel re-opens the same instance for a different action row.
        menu.open({ actionName: 'cut', entries: ENTRIES, anchorEl: fakeEl('div') });

        expect(doc.listenerCount('keydown')).toBe(1);
        expect(doc.body.children).toHaveLength(1);
        expect(menu.openActionName).toBe('cut');
        expect(menu.element.children[0].children[0].textContent).toBe('cut');
    });
});

// ---------------------------------------------------------------------------
// panel wiring
// ---------------------------------------------------------------------------
describe('NavActionsPanel opens the submenu from an action row', () => {
    let panel;
    let overlay;
    let content;
    let nameEl;
    let view;

    beforeEach(() => {
        installDom();
        panel = new NavActionsPanel(null);
        overlay = fakeEl('div');
        content = fakeEl('div');
        panel.overlay = overlay;
        panel._content = content;

        view = panel._buildView({ 'droid punch': { canExecute: ENTRIES, cannotExecute: [] } }, null, null, null);
        content.innerHTML = panel._buildActionSection(view);

        // The action-name element the panel would have rendered.
        const item = fakeEl('div');
        item.dataset = { actionName: 'droid punch' };
        nameEl = fakeEl('div');
        nameEl.closest = () => item;
        content.querySelectorAll = (sel) => (sel === '.nav-action-name' ? [nameEl] : []);
        content.querySelector = (sel) => (sel.includes('.nav-action-name') ? nameEl : null);
        panel._attachActionListeners(view);
    });

    afterEach(() => {
        delete globalThis.document;
        delete globalThis.window;
    });

    it('opens the component submenu of the action whose name was clicked', () => {
        nameEl.fire('click');

        expect(panel.submenu.isOpen).toBe(true);
        expect(panel.submenu.openActionName).toBe('droid punch');
        // The capable components are listed in the submenu, not in the panel.
        expect(panel.submenu.element.children[2].innerHTML).toContain('claw-1');
        expect(content.innerHTML).not.toContain('nav-component-row');
    });

    it('closes that submenu when the same action name is clicked again', () => {
        nameEl.fire('click');
        nameEl.fire('click');
        expect(panel.submenu.isOpen).toBe(false);
    });

    it('dismisses the submenu when the panel hides (the submenu is not inside it)', () => {
        nameEl.fire('click');
        expect(panel.submenu.isOpen).toBe(true);

        panel.hide();

        expect(panel.submenu.isOpen).toBe(false);
        expect(overlay.style.display).toBe('none');
    });
});

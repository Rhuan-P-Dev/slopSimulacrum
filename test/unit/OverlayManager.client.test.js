/**
 * OverlayManager (CLIENT) unit tests.
 *
 * The client coordinator is a plain ES module that talks to the DOM, so it is
 * smoke-tested with a minimal DOM stub (the same approach the
 * RoomChatController/TurnController client tests use): no browser, no jsdom —
 * just enough element shape for the manager to init, open a panel, and fire
 * document-level keydown events.
 *
 * Covers the keyboard contract after the numeric panel-opening shortcuts
 * (1-4) were removed on purpose — the manager's only remaining document-level
 * key behavior is Escape dismissal:
 *   - init wires exactly one document-level keydown listener;
 *   - number keys 1-4 open no panel;
 *   - Escape closes an open panel (hide called, backdrop hidden);
 *   - the config-bar button click still opens its panel (the remaining
 *     open path).
 *
 * @module test/unit/OverlayManager.client
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OverlayManager } from '../../public/js/OverlayManager.js';

// =========================================================================
// Minimal DOM stub
// =========================================================================

function makeElement(id = '') {
    return {
        id,
        style: {},
        children: [],
        _listeners: {},
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        querySelector() {
            // No .overlay-header: drag init degrades, which these tests do
            // not exercise.
            return null;
        },
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        },
        removeEventListener() {},
        click() {
            (this._listeners.click || []).forEach((fn) => fn({ target: this }));
        }
    };
}

function makeDocumentStub() {
    const registry = new Map();
    const _listeners = {};
    return {
        _listeners,
        createElement: (tag) => makeElement(tag),
        body: makeElement('body'),
        getElementById(id) {
            if (id === null || id === undefined) return null;
            if (!registry.has(id)) registry.set(id, makeElement(id));
            return registry.get(id);
        },
        addEventListener(type, fn) {
            (_listeners[type] = _listeners[type] || []).push(fn);
        },
        removeEventListener() {},
        fire(type, event) {
            (_listeners[type] || []).forEach((fn) => fn(event));
        }
    };
}

/** Fake panel controller: spy show/hide and a bare overlay element. */
function makePanelController() {
    return {
        show: vi.fn(),
        hide: vi.fn(),
        overlay: makeElement('overlay')
    };
}

function makeManager() {
    const doc = makeDocumentStub();
    globalThis.document = doc;
    const manager = new OverlayManager({});
    return { doc, manager };
}

afterEach(() => {
    delete globalThis.document;
    vi.restoreAllMocks();
});

// =========================================================================
// Tests
// =========================================================================

describe('OverlayManager (client) — keyboard contract (no numeric shortcuts)', () => {
    it('init wires exactly one document-level keydown listener', () => {
        const { doc, manager } = makeManager();
        manager.register('a', makePanelController(), 'btn-a');
        manager.init();

        expect(doc._listeners.keydown).toHaveLength(1);
    });

    it('number keys 1-4 open no panel (shortcuts removed)', () => {
        const { doc, manager } = makeManager();
        const first = makePanelController();
        const fourth = makePanelController();
        manager.register('a', first, 'btn-a');
        manager.register('d', fourth, 'btn-d');
        manager.init();

        for (const key of ['1', '2', '3', '4']) {
            doc.fire('keydown', { key });
        }

        expect(first.show).not.toHaveBeenCalled();
        expect(fourth.show).not.toHaveBeenCalled();
        expect(manager.getActivePanelId()).toBeNull();
    });

    it('Escape closes an open panel (the remaining key behavior)', async () => {
        const { doc, manager } = makeManager();
        const panel = makePanelController();
        manager.register('a', panel, 'btn-a');
        manager.init();

        await manager.open('a', null);
        expect(panel.show).toHaveBeenCalledTimes(1);
        expect(manager.getActivePanelId()).toBe('a');
        expect(doc.body.children.at(-1).style.display).toBe('block'); // backdrop visible

        doc.fire('keydown', { key: 'Escape' });

        expect(panel.hide).toHaveBeenCalledTimes(1);
        expect(manager.getActivePanelId()).toBeNull();
        expect(doc.body.children.at(-1).style.display).toBe('none');
    });

    it('the config-bar button still opens its panel (the remaining open path)', () => {
        const { doc, manager } = makeManager();
        const panel = makePanelController();
        manager.register('a', panel, 'btn-a');
        manager.init();

        doc.getElementById('btn-a').click();

        expect(panel.show).toHaveBeenCalledTimes(1);
        expect(manager.getActivePanelId()).toBe('a');
    });
});

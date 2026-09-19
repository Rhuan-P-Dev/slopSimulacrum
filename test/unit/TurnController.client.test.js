/**
 * TurnController (CLIENT) tests — the Space (␣) plan-complete lock-in
 * keyboard shortcut (two-phase turn system, spec §1.4: signaling plan-complete
 * is identical to the ✅ Lock in button; the key must never steal a typing or
 * widget gesture).
 *
 * Per the client-testing convention (pattern:
 * test/unit/RoomChatController.client.test.js): node environment, minimal DOM
 * stub — no browser, no jsdom. The controller is a plain ES module that talks
 * to the DOM, so the stub provides just enough element shape for init()
 * (the #turn-hud slot + the two buttons the binds look for) and to drive the
 * keydown handler directly.
 *
 * Covers:
 *   - wiring/degradation: missing #turn-hud slot → no throw, no keydown
 *     wiring, update() no-op; slot present → exactly one 'keydown' listener;
 *   - the commit: bare Space while my entity is still pending in the planning
 *     barrier → the injected onReady (the SAME callback the ✅ Lock in button
 *     fires) with my entity id, preventDefault on the committing press (no
 *     page scroll);
 *   - the inert paths (no onReady, no preventDefault): other key codes, any
 *     modifier key, typing targets (input / textarea / content-editable),
 *     focusable widgets (button / select / tabindex / role=button — including
 *     the stat-dialog <select>s, regression of the space-key review P1),
 *     already-signaled, resolution phase, absent barrier, absent turns,
 *     missing local entity id, onReady not wired;
 *   - no local state: the guard re-derives from live worldState on every
 *     press (commit → phase flip → inert → flip back → commit again);
 *   - parity: the ✅ button click and the Space key call the same onReady
 *     with the same id; neither path throws when onReady is not wired.
 *
 * @module test/unit/TurnController.client
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TurnController } from '../../public/js/TurnController.js';
import { TURN_PHASES } from '../../shared/TurnPhases.js';

// =========================================================================
// Minimal DOM stub (node env — no jsdom; see RoomChatController.client.test.js)
// =========================================================================

/**
 * The handler tests `target instanceof HTMLElement`; in node there is no DOM
 * global, so provide one. Every stub element below inherits from it.
 */
class HTMLElementStub {}
globalThis.HTMLElement = HTMLElementStub;

/**
 * A focusable element: tag name + optional role/tabindex/contentEditable.
 * `closest()` implements the subset of the guard's selector list the handler
 * uses ('input, textarea, select, button, [tabindex], [role="button"]'),
 * matching the element itself — for a keydown event the target IS the focused
 * element, which is what the guard inspects first.
 */
class DomEl extends HTMLElementStub {
    constructor(tag, { role, tabIndex, contentEditable = false } = {}) {
        super();
        this.tagName = tag.toUpperCase();
        this._attrs = {};
        if (role !== undefined) this._attrs.role = role;
        if (tabIndex !== undefined) this._attrs.tabindex = tabIndex;
        this.isContentEditable = !!contentEditable;
    }
    closest(selector) {
        const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
        return parts.some((p) => {
            if (p === '[tabindex]') return 'tabindex' in this._attrs;
            if (p === '[role="button"]') return this._attrs.role === 'button';
            return this.tagName === p.toUpperCase();
        }) ? this : null;
    }
}

/** A button-like element: textContent, classList, and captured click listeners. */
function makeButtonStub(id) {
    return {
        id,
        textContent: '',
        style: {},
        title: '',
        disabled: false,
        className: '',
        classList: {
            _set: new Set(),
            add(cls) { this._set.add(cls); },
            remove(cls) { this._set.delete(cls); },
            contains(cls) { return this._set.has(cls); },
        },
        _listeners: {},
        addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
        removeEventListener() {},
        click() { (this._listeners.click ?? []).forEach((fn) => fn()); },
    };
}

/** A #turn-hud slot stub: innerHTML sink + the two buttons the binds look for. */
function makeRootStub() {
    const modeBtn = makeButtonStub('turn-mode-toggle');
    const readyBtn = makeButtonStub('turn-ready-btn');
    return {
        innerHTML: '',
        _buttons: { modeBtn, readyBtn },
        querySelector(sel) {
            if (sel === '#turn-mode-toggle') return modeBtn;
            if (sel === '#turn-ready-btn') return readyBtn;
            return null;
        },
    };
}

/** A document stub that records listeners and serves the optional #turn-hud. */
function makeDocumentStub(root = null) {
    return {
        _listeners: {},
        _root: root,
        body: new DomEl('body'),
        getElementById(id) { return id === 'turn-hud' ? root : null; },
        addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
        removeEventListener() {},
    };
}

// =========================================================================
// Controller factory + key firing
// =========================================================================

const MY_ID = 'ent-test';

/**
 * Builds an initialized controller around a mutable fake world state.
 * Default state: round 1, planning open, my entity still pending in the
 * barrier (i.e. the server state under which the ✅ Lock in button shows).
 */
function makeController({
    turns = { round: 1, phase: TURN_PHASES.PLANNING, barrier: { readyCount: 0, pendingEntityIds: [MY_ID] } },
    onReady = vi.fn(),
    getMyEntityId = () => MY_ID,
    withRoot = true,
} = {}) {
    const state = { turns };
    const doc = makeDocumentStub(withRoot ? makeRootStub() : null);
    globalThis.document = doc;
    const ctrl = new TurnController({
        worldState: () => state,
        getMyEntityId,
        onModeChange: vi.fn(),
        onCancelQueued: vi.fn(),
        onReady,
    });
    ctrl.init();
    return { ctrl, doc, state, onReady };
}

/** Fires a keydown on the document stub; defaults to a bare Space on <body>. */
function fireKey(doc, overrides = {}) {
    const preventDefault = vi.fn();
    const event = {
        code: 'Space',
        key: ' ',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target: new DomEl('body'),
        preventDefault,
        ...overrides,
    };
    (doc._listeners.keydown ?? []).forEach((fn) => fn(event));
    return { event, preventDefault };
}

afterEach(() => {
    delete globalThis.document;
});

// =========================================================================
// Wiring / degradation
// =========================================================================

describe('TurnController — Space (␣) lock-in wiring', () => {
    it('wires exactly one keydown listener when the HUD slot exists', () => {
        const { doc } = makeController();
        expect(doc._listeners.keydown).toHaveLength(1);
    });

    it('missing #turn-hud slot → init degrades: no throw, no keydown wiring, update() no-op', () => {
        const { ctrl, doc } = makeController({ withRoot: false });
        expect(doc._listeners.keydown ?? []).toHaveLength(0);
        expect(() => ctrl.update()).not.toThrow();
    });
});

// =========================================================================
// The commit
// =========================================================================

describe('TurnController — Space (␣) lock-in commit', () => {
    it('bare Space while pending → onReady(myEntityId) + preventDefault (same callback as the ✅ button)', () => {
        const { doc, onReady } = makeController();
        const { preventDefault } = fireKey(doc);
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onReady).toHaveBeenCalledWith(MY_ID);
        expect(preventDefault).toHaveBeenCalledTimes(1); // commit press must not scroll the page
    });

    it('a plain non-widget target (e.g. <li>) also commits while pending', () => {
        const { doc, onReady } = makeController();
        fireKey(doc, { target: new DomEl('li') });
        expect(onReady).toHaveBeenCalledTimes(1);
    });
});

// =========================================================================
// The inert paths — the key must never steal a typing or widget gesture
// =========================================================================

describe('TurnController — Space (␣) lock-in inert paths', () => {
    const inertTargets = [
        ['an <input> (chat)', new DomEl('input')],
        ['a <textarea>', new DomEl('textarea')],
        ['a content-editable element', new DomEl('div', { contentEditable: true })],
        ['a <select> (stat dialog — review P1 regression)', new DomEl('select')],
        ['a <button>', new DomEl('button')],
        ['a tabindex element (crafting card)', new DomEl('div', { tabIndex: 0 })],
        ['a role=button element (crafting card)', new DomEl('div', { role: 'button' })],
    ];

    it.each(inertTargets)('is inert while %s is focused', (_label, target) => {
        const { doc, onReady } = makeController();
        const { preventDefault } = fireKey(doc, { target });
        expect(onReady).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it.each([
        ['ctrl', { ctrlKey: true }],
        ['meta', { metaKey: true }],
        ['alt', { altKey: true }],
        ['shift', { shiftKey: true }],
    ])('is inert with the %s modifier held', (_mod, modifiers) => {
        const { doc, onReady } = makeController();
        const { preventDefault } = fireKey(doc, modifiers);
        expect(onReady).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it.each([
        ['Enter', 'Enter'],
        ['Spacebar (legacy code)', 'Spacebar'],
        ['a non-key press (no code)', undefined],
    ])('is inert for key code %s', (_label, code) => {
        const { doc, onReady } = makeController();
        fireKey(doc, code === undefined ? { code: undefined } : { code });
        expect(onReady).not.toHaveBeenCalled();
    });

    it('is inert when my entity already signaled (no longer pending)', () => {
        const { doc, onReady } = makeController({
            turns: { round: 1, phase: TURN_PHASES.PLANNING, barrier: { readyCount: 1, pendingEntityIds: [] } },
        });
        fireKey(doc);
        expect(onReady).not.toHaveBeenCalled();
    });

    it('is inert in the resolution phase (planning closed)', () => {
        const { doc, onReady } = makeController({
            turns: { round: 1, phase: TURN_PHASES.RESOLUTION, barrier: { readyCount: 1, pendingEntityIds: [MY_ID] } },
        });
        fireKey(doc);
        expect(onReady).not.toHaveBeenCalled();
    });

    it.each([
        ['absent barrier', { round: 1, phase: TURN_PHASES.PLANNING, barrier: null }],
        ['non-object barrier', { round: 1, phase: TURN_PHASES.PLANNING, barrier: 'closed' }],
        ['non-array pendingEntityIds', { round: 1, phase: TURN_PHASES.PLANNING, barrier: { readyCount: 0, pendingEntityIds: 'stale' } }],
    ])('is inert with %s', (_label, turns) => {
        const { doc, onReady } = makeController({ turns });
        expect(() => fireKey(doc)).not.toThrow();
        expect(onReady).not.toHaveBeenCalled();
    });

    it('is inert when there are no turns at all (pre-Feature-A / disconnected)', () => {
        const { doc, onReady } = makeController({ turns: null });
        fireKey(doc);
        expect(onReady).not.toHaveBeenCalled();
    });

    it('is inert when the local entity id is unknown', () => {
        const { doc, onReady } = makeController({ getMyEntityId: () => null });
        fireKey(doc);
        expect(onReady).not.toHaveBeenCalled();
    });

    it('is inert (and does not throw) when onReady is not wired', () => {
        const { doc, onReady } = makeController({ onReady: null });
        expect(onReady).toBeNull();
        expect(() => fireKey(doc)).not.toThrow();
    });
});

// =========================================================================
// No local state + parity with the ✅ button
// =========================================================================

describe('TurnController — Space (␣) lock-in state derivation & parity', () => {
    it('re-derives the guard from live state on every press (no local flag)', () => {
        const { doc, state, onReady } = makeController();
        fireKey(doc); // planning + pending → commit
        expect(onReady).toHaveBeenCalledTimes(1);

        state.turns.phase = TURN_PHASES.RESOLUTION;
        fireKey(doc); // planning closed → inert
        expect(onReady).toHaveBeenCalledTimes(1);

        state.turns.phase = TURN_PHASES.PLANNING;
        fireKey(doc); // planning open again (still pending) → commit
        expect(onReady).toHaveBeenCalledTimes(2);
    });

    it('✅ button click and Space fire the SAME onReady with the same id', () => {
        const { doc, state, onReady } = makeController();
        const { readyBtn } = doc._root._buttons;

        readyBtn.click();
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onReady).toHaveBeenLastCalledWith(MY_ID);

        fireKey(doc);
        expect(onReady).toHaveBeenCalledTimes(2);
        expect(onReady).toHaveBeenLastCalledWith(MY_ID);

        // State is untouched by the controller — the server rebuilds the
        // barrier; both paths merely signal.
        expect(state.turns.barrier.pendingEntityIds).toEqual([MY_ID]);
    });

    it('the ✅ button is inert (no throw) when onReady is not wired', () => {
        const { onReady } = makeController({ onReady: null });
        expect(onReady).toBeNull();
    });
});

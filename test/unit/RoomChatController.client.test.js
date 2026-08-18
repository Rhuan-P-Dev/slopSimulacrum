/**
 * RoomChatController (CLIENT) smoke tests (Feature D, spec §7.4).
 *
 * The client controller is a plain ES module that talks to the DOM and
 * fetch, so it is smoke-tested with a minimal DOM stub (the same approach
 * the TurnController/HUD work used): no browser, no jsdom — just enough
 * element shape for the controller to initialize, focus a room, append
 * rows, and send. The goal is "the module loads, wires, and degrades
 * cleanly", not pixel-perfect rendering.
 *
 * Covers:
 *   - init with/without the overlay element (missing panel never throws);
 *   - show/hide/toggle + isVisible;
 *   - setFocusedRoom: label update, badge reset, history fetch (stubbed
 *     fetch) with the /rooms/<uid>/chat?limit=50 URL;
 *   - onRoomChatMessage: room filtering, open → row appended, closed →
 *     badge increments; dedupe of the REST echo + socket broadcast pair;
 *   - send: Enter key on the input → POST /rooms/<uid>/chat with
 *     { message, speakerName: 'Player' }; 4xx → handleError surfaced;
 *     over-long input rejected client-side without a POST.
 *
 * @module test/unit/RoomChatController.client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomChatController } from '../../public/js/RoomChatController.js';

// =========================================================================
// Minimal DOM stub
// =========================================================================

/** A leaf element (no nested children) — used for close btn / room label. */
function makeLeaf(id = '') {
    return makeElement(id, true);
}

function makeElement(id = '', leaf = false) {
    const el = {
        id,
        style: { display: 'none' },
        className: '',
        textContent: '',
        innerHTML: '',
        value: '',
        children: [],
        _listeners: {},
        classList: {
            _set: new Set(),
            add(cls) { this._set.add(cls); },
            remove(cls) { this._set.delete(cls); },
            contains(cls) { return this._set.has(cls); }
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        querySelector(sel) {
            // The controller only queries .overlay-close-btn inside the overlay.
            if (sel === '.overlay-close-btn') return this._closeBtn || null;
            if (sel === '.room-chat-room-name') return this._roomName || null;
            return null;
        },
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        },
        removeEventListener() {},
        focus() { this._focused = true; },
        click() {
            (this._listeners.click || []).forEach(fn => fn({ target: this }));
        }
    };
    if (!leaf) {
        el._closeBtn = makeLeaf();
        el._roomName = makeLeaf();
    }
    return el;
}

function makeDom() {
    const registry = new Map();
    const documentStub = {
        getElementById(id) {
            if (!registry.has(id)) registry.set(id, makeElement(id));
            return registry.get(id);
        },
        createElement(tag) { return makeElement(tag); },
        addEventListener() {},
        body: makeElement('body')
    };
    return { registry, documentStub };
}

// =========================================================================
// Controller harness
// =========================================================================

function makeController({ getState } = {}) {
    const errors = [];
    const controller = new RoomChatController({
        getState: getState || (() => ({ rooms: { 'room-a': { name: 'Entrance Hall' } } })),
        handleError: (err) => errors.push(err)
    });
    return { controller, errors };
}

let fetchCalls;
let fetchResponses;

function stubFetch(handler) {
    fetchCalls = [];
    fetchResponses = [];
    globalThis.fetch = vi.fn(async (url, options) => {
        fetchCalls.push({ url, options });
        const queued = fetchResponses.shift();
        return (typeof queued === 'function' ? queued(url, options) : queued)
            ?? { ok: true, status: 200, json: async () => ({}) };
    });
}

beforeEach(() => {
    globalThis.document = makeDom().documentStub;
});

afterEach(() => {
    delete globalThis.document;
    vi.restoreAllMocks();
});

// =========================================================================
// Tests
// =========================================================================

describe('RoomChatController (client, Feature D spec §7.4)', () => {
    it('init with the overlay present: wires close button + input Enter', () => {
        const { controller } = makeController();
        controller.init();

        const overlay = globalThis.document.getElementById('room-chat-overlay');
        expect(controller.overlay).toBe(overlay);
        expect(overlay._listeners.keydown).toBeUndefined(); // on the INPUT, not the overlay
        const input = globalThis.document.getElementById('room-chat-input');
        expect(input._listeners.keydown).toHaveLength(1);

        // Close button hides the panel.
        overlay.style.display = 'block';
        overlay._closeBtn.click();
        expect(controller.isVisible()).toBe(false);
    });

    it('init without the overlay element: no-op, never throws, show() is safe', () => {
        const { controller } = makeController();
        // Simulate a missing panel: the registry lookup for the overlay returns null.
        const originalLookup = globalThis.document.getElementById.bind(globalThis.document);
        globalThis.document.getElementById = (id) =>
            id === 'room-chat-overlay' ? null : originalLookup(id);

        expect(() => controller.init()).not.toThrow();
        expect(controller.overlay).toBeNull();
        expect(() => controller.show()).not.toThrow();
        expect(() => controller.hide()).not.toThrow();
        expect(() => controller.onRoomChatMessage({ roomId: 'x', text: 'hi' })).not.toThrow();
        expect(controller.isVisible()).toBe(false);
    });

    it('show/hide/toggle drive visibility; badge resets on show', () => {
        const { controller } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a');

        // Closed room message → badge.
        controller.onRoomChatMessage({ roomId: 'room-a', speakerName: 'Bolt the Merchant', text: 'hi', tick: 1 });
        const badge = globalThis.document.getElementById('room-chat-badge');
        expect(badge.textContent).toBe('1');

        controller.show();
        expect(controller.isVisible()).toBe(true);
        expect(badge.style.display).toBe('none'); // cleared on show
        controller.toggle();
        expect(controller.isVisible()).toBe(false);
        controller.toggle();
        expect(controller.isVisible()).toBe(true);
    });

    it('setFocusedRoom loads history via GET /rooms/<uid>/chat?limit=50 when open', async () => {
        stubFetch();
        fetchResponses.push({ ok: true, status: 200, json: async () => ({ roomId: 'room-a', messages: [] }) });

        const { controller } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a'); // closed: no fetch yet
        controller.show(); // open on the focused room → history fetch

        await new Promise(r => setImmediate(r)); // let the fetch fire

        const historyCalls = fetchCalls.filter(c => c.url.includes('/chat?limit=50'));
        expect(historyCalls.map(c => c.url)).toEqual(['/rooms/room-a/chat?limit=50']);
    });

    it('onRoomChatMessage filters by focused room; open appends a row', async () => {
        stubFetch();
        fetchResponses.push({ ok: true, status: 200, json: async () => ({ messages: [] }) });

        const { controller } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a');
        controller.show();
        await new Promise(r => setImmediate(r));

        const messagesEl = globalThis.document.getElementById('room-chat-messages');
        const before = messagesEl.children.length;

        // Other room → ignored entirely.
        controller.onRoomChatMessage({ roomId: 'room-b', speakerName: 'Player', text: 'other', tick: 2 });
        expect(messagesEl.children.length).toBe(before);

        // Focused room → appended with speaker + text.
        controller.onRoomChatMessage({ roomId: 'room-a', speakerName: 'Bolt the Merchant', speakerEntityId: 'ent-bolt', text: 'Fresh power cells, best in the vault.', tick: 3 });
        expect(messagesEl.children.length).toBe(before + 1);
        const row = messagesEl.children[messagesEl.children.length - 1];
        expect(row.children.map(c => c.textContent)).toContain('Bolt the Merchant');
        expect(row.children.map(c => c.textContent)).toContain('Fresh power cells, best in the vault.');
        // NPC speaker gets the distinct class (speakerEntityId set).
        expect(row.children[0].classList.contains('room-chat-speaker-npc')).toBe(true);
    });

    it('dedupes the REST echo + socket broadcast of the same message', () => {
        const { controller } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a');
        controller.show();

        const msg = { roomId: 'room-a', speakerName: 'Player', text: 'hello', tick: 7 };
        controller.onRoomChatMessage(msg);
        controller.onRoomChatMessage({ ...msg }); // the duplicate (other delivery path)

        const messagesEl = globalThis.document.getElementById('room-chat-messages');
        expect(messagesEl.children.length).toBe(1);
    });

    it('Enter sends POST /rooms/<uid>/chat { message, speakerName: "Player" } and appends the echo', async () => {
        stubFetch();
        fetchResponses.push({ ok: true, status: 200, json: async () => ({ messages: [] }) }); // history GET
        fetchResponses.push({
            ok: true,
            status: 200,
            json: async () => ({ success: true, message: { roomId: 'room-a', speakerName: 'Player', speakerEntityId: null, text: 'hello bolt', tick: 9, ts: 1 } })
        });

        const { controller } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a');
        controller.show();

        const input = globalThis.document.getElementById('room-chat-input');
        input.value = '  hello bolt  ';
        input._listeners.keydown[0]({ key: 'Enter', preventDefault: () => {} });

        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        const post = fetchCalls.find(c => c.options?.method === 'POST');
        expect(post.url).toBe('/rooms/room-a/chat');
        expect(JSON.parse(post.options.body)).toEqual({ message: 'hello bolt', speakerName: 'Player' });
        expect(input.value).toBe('');

        const messagesEl = globalThis.document.getElementById('room-chat-messages');
        expect(messagesEl.children.some(row => row.children.some(c => c.textContent === 'hello bolt'))).toBe(true);
    });

    it('4xx send surfaces the error via handleError; input keeps its text', async () => {
        stubFetch();
        fetchResponses.push({ ok: true, status: 200, json: async () => ({ messages: [] }) }); // history GET
        fetchResponses.push({ ok: false, status: 400, json: async () => ({ error: 'Message too long' }) });

        const { controller, errors } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a');
        controller.show();

        const input = globalThis.document.getElementById('room-chat-input');
        input.value = 'too long';
        input._listeners.keydown[0]({ key: 'Enter', preventDefault: () => {} });
        await new Promise(r => setImmediate(r));

        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('ROOM_CHAT_SEND_FAILED');
        expect(errors[0].message).toBe('Message too long');
        expect(input.value).toBe('too long'); // not cleared on failure
    });

    it('over-long input is rejected client-side: no POST, error surfaced', async () => {
        stubFetch();

        const { controller, errors } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a');
        controller.show();

        const input = globalThis.document.getElementById('room-chat-input');
        input.value = 'x'.repeat(201);
        input._listeners.keydown[0]({ key: 'Enter', preventDefault: () => {} });
        await new Promise(r => setImmediate(r));

        // Opening the panel fetches history — but a SEND never goes out.
        expect(fetchCalls.filter(c => c.options?.method === 'POST')).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('ROOM_CHAT_SEND_FAILED');
    });

    it('empty input does nothing', async () => {
        stubFetch();

        const { controller } = makeController();
        controller.init();
        controller.setFocusedRoom('room-a');
        controller.show();

        const input = globalThis.document.getElementById('room-chat-input');
        input.value = '   ';
        input._listeners.keydown[0]({ key: 'Enter', preventDefault: () => {} });
        await new Promise(r => setImmediate(r));

        // No SEND goes out for blank input.
        expect(fetchCalls.filter(c => c.options?.method === 'POST')).toHaveLength(0);
    });
});

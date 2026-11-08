/**
 * SystemPanel (CLIENT) — what the two clicks actually send.
 *
 * The property this file exists to pin: **the Write mod click posts a session id and
 * nothing else.** The proposal lives server-side, was validated there, and a client that
 * could post its own content would be a door to writing any package on disk (`T-1`). The
 * second pin is the error path: the server's `{ error: { code, message } }` envelope must
 * reach the operator with its code, because "PROPOSAL_INVALID" and "RATE_LIMITED" are
 * different news.
 *
 * No DOM library is needed: the constructor is field-only, every render call guards on its
 * element, and `fetch` / `sessionStorage` are stubbed. The one exception is the proposal
 * card, which is painted through `document.createElement` — a twenty-line element shim
 * covers it, because that paint is where the button's enabled state is decided.
 *
 * @module test/unit/SystemPanel.client
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SystemPanel } from '../../public/js/SystemPanel.js';

/** A panel with the field state a click acts on, and no DOM. */
function panelWith(options = {}) {
    const panel = new SystemPanel();
    panel._initialized = true;
    panel._sessionId = options.sessionId ?? null;
    panel._proposal = options.proposal ?? null;
    panel._input = { value: options.input ?? '' };
    panel._sendButton = { disabled: false };
    panel._newButton = { disabled: false };
    return panel;
}

function jsonResponse(status, payload) {
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/** The parsed body of the nth fetch call. */
function postedBody(fetchSpy, index = 0) {
    const [, init] = fetchSpy.mock.calls[index];
    return JSON.parse(init.body);
}

/**
 * The minimum an element needs to be here: children, text, one listener list, and the
 * `disabled` flag the panel sets. `textContent = ''` clearing the children is the one real
 * DOM behavior `_render` depends on.
 * @param {string} tag
 * @returns {Object}
 */
function makeElement(tag) {
    const node = {
        tag,
        className: '',
        type: '',
        children: [],
        disabled: false,
        style: {},
        scrollTop: 0,
        scrollHeight: 10,
        listeners: {},
        _text: '',
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        append(...kids) {
            this.children.push(...kids);
        },
        addEventListener(name, fn) {
            (this.listeners[name] ??= []).push(fn);
        },
        click() {
            for (const fn of this.listeners.click ?? []) fn();
        }
    };
    Object.defineProperty(node, 'textContent', {
        get() {
            return this.children.length > 0
                ? this.children.map((child) => child.textContent).join('')
                : this._text;
        },
        set(value) {
            this._text = String(value);
            this.children = [];
        }
    });
    return node;
}

/** Depth-first search by class fragment — how the test finds the button it must click. */
function findByClass(node, fragment, found = []) {
    if (typeof node.className === 'string' && node.className.includes(fragment)) found.push(node);
    for (const child of node.children ?? []) findByClass(child, fragment, found);
    return found;
}

/** The Write mod button of the current paint. */
function findButton(transcript) {
    return findByClass(transcript, 'system-btn-primary')[0] ?? null;
}

/** Let the promise the click handler dropped (`void this._write()`) run to the end. */
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A panel that finished a turn carrying a proposal, painted into a shimmed transcript — the
 * exact state the operator has when they reach for the button.
 */
function panelWithPaintedProposal() {
    const stored = {};
    vi.stubGlobal('sessionStorage', {
        getItem: (k) => stored[k] ?? null,
        setItem: (k, v) => { stored[k] = v; },
        removeItem: (k) => { delete stored[k]; }
    });
    vi.stubGlobal('document', { createElement: (tag) => makeElement(tag) });
    const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, {
            sessionId: 'ses-9',
            reply: 'Proposed: system-teleport-move.',
            proposal: {
                packageId: 'system-teleport-move',
                description: 'Adds a teleport action.',
                added: [{ kind: 'actions', key: 'teleport' }],
                overrides: [],
                content: { actions: { teleport: { range: 500 } } }
            },
            toolLog: [],
            meta: { iterations: 10 }
        }))
        .mockResolvedValueOnce(jsonResponse(200, {
            packageId: 'system-teleport-move',
            dir: 'data/mods/system-teleport-move',
            files: ['data/mods/system-teleport-move/mod.json', 'data/mods/system-teleport-move/actions.json'],
            added: [{ kind: 'actions', key: 'teleport' }],
            overrides: []
        }));
    vi.stubGlobal('fetch', fetchSpy);

    const panel = panelWith({ input: 'create a teleport move' });
    panel._transcript = makeElement('div');
    panel._status = { textContent: '', className: '' };
    // `_send` is fire-and-forget here only to reproduce the real order of operations:
    // paint, then clear the busy flag.
    return { panel, fetchSpy, turn: panel._send() };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('SystemPanel.write (what Write mod posts)', () => {
    it('posts the session id only — never the proposal content', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {
            saved: true,
            packageId: 'system-salvage-plate',
            dir: 'data/mods/system-salvage-plate',
            files: ['data/mods/system-salvage-plate/mod.json'],
            added: [{ kind: 'components', key: 'salvagePlate' }],
            overrides: []
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const panel = panelWith({
            sessionId: 'ses-7',
            proposal: { packageId: 'system-salvage-plate', content: { components: { salvagePlate: {} } } }
        });
        await panel._write();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = fetchSpy.mock.calls[0];
        expect(init.method).toBe('POST');
        expect(postedBody(fetchSpy)).toEqual({ sessionId: 'ses-7' });
        expect(JSON.stringify(postedBody(fetchSpy))).not.toContain('salvagePlate');
        expect(panel._written).toBe(true);
        expect(panel._inFlight).toBe(false);
    });

    it('does not write with no proposal on the table, and does not double-write while in flight', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { saved: true }));
        vi.stubGlobal('fetch', fetchSpy);

        const withoutProposal = panelWith({ sessionId: 'ses-7' });
        await withoutProposal._write();
        expect(fetchSpy).not.toHaveBeenCalled();

        const busy = panelWith({ sessionId: 'ses-7', proposal: { packageId: 'p' } });
        busy._inFlight = true;
        await busy._write();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('surfaces the server error code to the operator', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(409, {
            error: { code: 'PROPOSAL_NOT_SET', message: 'Session "ses-7" has no proposal to write' }
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const panel = panelWith({ sessionId: 'ses-7', proposal: { packageId: 'p' } });
        panel._status = { textContent: '', className: '' };
        await panel._write();

        expect(panel._status.textContent).toContain('no proposal to write');
        expect(panel._status.textContent).toContain('PROPOSAL_NOT_SET');
        expect(panel._status.className).toContain('system-status-error');
        expect(panel._written).toBe(false);
    });
});

describe('SystemPanel.send (one turn)', () => {
    it('sends the wish with the session id, keeps the returned id, and holds the proposal', async () => {
        const stored = {};
        vi.stubGlobal('sessionStorage', {
            getItem: (k) => stored[k] ?? null,
            setItem: (k, v) => { stored[k] = v; },
            removeItem: (k) => { delete stored[k]; }
        });
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {
            sessionId: 'ses-42',
            reply: 'I would add a plate.',
            proposal: { packageId: 'system-salvage-plate', added: [], overrides: [], content: {} },
            toolLog: [],
            meta: { iterations: 2 }
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const panel = panelWith({ input: '  add a salvage plate  ' });
        await panel._send();

        expect(postedBody(fetchSpy)).toEqual({ sessionId: null, message: 'add a salvage plate' });
        expect(panel._sessionId).toBe('ses-42');
        expect(stored['system.sessionId']).toBe('ses-42');
        expect(panel._proposal).toMatchObject({ packageId: 'system-salvage-plate' });
        expect(panel._entries.map((e) => e.role)).toEqual(['user', 'system']);
        expect(panel._input.value).toBe('');
        expect(panel._inFlight).toBe(false);
        expect(panel._sendButton.disabled).toBe(false);
    });

    it('sends nothing on an empty composer, and refuses a second turn while one is running', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { sessionId: 's', reply: 'x', toolLog: [] }));
        vi.stubGlobal('fetch', fetchSpy);

        const empty = panelWith({ input: '   ' });
        await empty._send();
        expect(fetchSpy).not.toHaveBeenCalled();

        const busy = panelWith({ input: 'hello' });
        busy._inFlight = true;
        await busy._send();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('turns a rate-limit envelope into a readable error line', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, {
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests. Limit is 10 per 60s.' }
        })));

        const panel = panelWith({ input: 'hello' });
        panel._status = { textContent: '', className: '' };
        await panel._send();

        expect(panel._entries.at(-1)).toMatchObject({ role: 'error' });
        expect(panel._entries.at(-1).text).toContain('RATE_LIMITED');
        expect(panel._inFlight).toBe(false);
    });

    it('leaves the Write mod button clickable once the turn is over', async () => {
        // The bug this pins: `_send` repaints the transcript while `_inFlight` is still
        // true, and the Write button's `disabled` used to be computed once at paint time.
        // The result was a card that says "Write mod" and does nothing — a disabled button
        // fires no event, so there is no error to find in any log.
        const { panel, fetchSpy, turn } = panelWithPaintedProposal();
        await turn;

        const button = findButton(panel._transcript);
        expect(button, 'the proposal card was not painted').toBeTruthy();
        expect(button.textContent).toBe('Write mod');
        expect(button.disabled).toBe(false);

        button.click();
        await settle();

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(postedBody(fetchSpy, 1)).toEqual({ sessionId: 'ses-9' });
        expect(panel._status.textContent).toContain('Wrote system-teleport-move');
        expect(panel._written).toBe(true);
    });

    it('follows the in-flight flag: shut while a request runs, open again after', async () => {
        const { panel, turn } = panelWithPaintedProposal();
        await turn;
        const button = findButton(panel._transcript);
        expect(button.disabled).toBe(false);

        // While a request runs the button is shut — the double click that would write the
        // same package twice. `_setBusy` is what carries the flag onto the painted node.
        panel._inFlight = true;
        panel._setBusy(true);
        expect(button.disabled).toBe(true);

        panel._inFlight = false;
        panel._setBusy(false);
        expect(button.disabled).toBe(false);

        // Written stays written, across a repaint too: it is a fact about the proposal, not
        // about a momentary flag.
        panel._written = true;
        panel._setBusy(false);
        expect(button.disabled).toBe(true);
        panel._render();
        expect(findButton(panel._transcript).disabled).toBe(true);
    });

    it('paints the bounded tool answer under each successful call, and keeps failures as their message', async () => {
        const stored = {};
        vi.stubGlobal('sessionStorage', {
            getItem: (k) => stored[k] ?? null,
            setItem: (k, v) => { stored[k] = v; },
            removeItem: (k) => { delete stored[k]; }
        });
        vi.stubGlobal('document', { createElement: (tag) => makeElement(tag) });

        const listAnswer = JSON.stringify({ kinds: ['materials', 'components'], callsRemaining: 11 });
        const truncatedEnvelope = JSON.stringify({
            truncated: true,
            limitChars: 12_000,
            note: 'too big to send whole',
            head: '{"kind":"components","keys":["a"'
        });
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {
            sessionId: 'ses-43',
            reply: 'The workshop is east, behind the door.',
            proposal: null,
            toolLog: [
                {
                    name: 'list_registries',
                    args: {},
                    ok: true,
                    result: listAnswer,
                    resultChars: listAnswer.length
                },
                {
                    name: 'propose_mod',
                    args: { packageId: 'bad' },
                    ok: false,
                    detail: 'world structure kinds are not yours to rewrite'
                },
                {
                    name: 'read_registry',
                    args: { kind: 'components' },
                    ok: true,
                    result: truncatedEnvelope,
                    resultChars: truncatedEnvelope.length
                }
            ],
            meta: { model: 'gpt-4o-mini', iterations: 4 }
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const panel = panelWith({ input: 'find a door' });
        panel._transcript = makeElement('div');
        panel._status = { textContent: '', className: '' };
        await panel._send();

        expect(panel._entries).toHaveLength(2);
        const log = findByClass(panel._transcript, 'system-tool-log')[0];
        expect(log, 'the tool log should be painted under the system message').toBeTruthy();
        const blocks = findByClass(log, 'system-tool-result');
        // Two results: the two successful calls; the refusal stays its detail line.
        expect(blocks).toHaveLength(2);
        expect(blocks[0].textContent).toContain('materials');
        expect(blocks[0].textContent).toContain('callsRemaining');
        expect(blocks[0].textContent).not.toContain('truncated');
        expect(blocks[1].textContent).toContain('truncated');
    });

    it('New chat drops the session id and the proposal', async () => {
        const stored = { 'system.sessionId': 'ses-1' };
        vi.stubGlobal('sessionStorage', {
            getItem: (k) => stored[k] ?? null,
            setItem: (k, v) => { stored[k] = v; },
            removeItem: (k) => { delete stored[k]; }
        });
        const panel = panelWith({ sessionId: 'ses-1', proposal: { packageId: 'p' } });
        panel._entries = [{ role: 'user', text: 'hi' }];
        panel._status = { textContent: '', className: '' };

        panel._newChat();

        expect(panel._sessionId).toBeNull();
        expect(panel._proposal).toBeNull();
        expect(panel._entries).toEqual([]);
        expect(stored['system.sessionId']).toBeUndefined();
    });
});

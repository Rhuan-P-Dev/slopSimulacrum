/**
 * AppMenu (CLIENT) — the launcher's reading of what the server is doing.
 *
 * The launcher has one job now: say whether a world runs, and offer only the
 * actions that are true in the state on screen. The claims:
 *
 *   1. opening the page ASKS the server (`GET /world-state`) rather than assuming;
 *   2. while no world runs: the status says so, "Enter world" is disabled, "Stop
 *      world" is not offered, and leaving the launcher (Enter, Escape, Close)
 *      does not reveal an empty canvas;
 *   3. while a world runs: the counts come from the answer, "Enter world" works
 *      and "Stop world" is offered;
 *   4. a world restored by `POST /api/world/load` (entities, no rounds) is
 *      enterable - "is it simulating" and "is there something to look at" are
 *      different questions and the launcher answers each with its own;
 *   5. "Stop world" is one POST and then a reload, because every cache the page
 *      holds belongs to the world that just ended;
 *   6. a status read that fails is said out loud, and does not light up a button
 *      whose outcome nobody knows.
 *
 * No jsdom (the suite has none): the page is a handful of element doubles and a
 * `fetch` that answers like `worldRoutes`. Nothing here tests the server - it
 * tests that the client believes what it was told.
 *
 * @module test/unit/AppMenu.client
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AppMenu } from '../../public/js/AppMenu.js';

/** The element ids `AppMenu.init()` looks for. */
const IDS = [
    'launcher-screen', 'create-world-screen', 'mods-screen',
    'menu-brand', 'btn-menu-create-world', 'btn-menu-mods',
    'btn-launcher-create', 'btn-launcher-mods', 'btn-launcher-enter', 'btn-launcher-stop',
    'btn-create-world-close', 'btn-mods-close', 'launcher-status'
];

/** A DOM element small enough to reason about: text, disabled, display, click. */
function makeElement(id) {
    return {
        id,
        style: { display: '' },
        disabled: false,
        textContent: '',
        /** @type {Record<string, Function>} */
        handlers: {},
        addEventListener(event, fn) { this.handlers[event] = fn; },
        click() { if (this.handlers.click) this.handlers.click(); }
    };
}

/** An HTTP response shaped the way the client reads it. */
function jsonResponse(body, status = 200) {
    return { ok: status < 400, status, json: async () => body };
}

/**
 * Install a page: element doubles, a `fetch` that answers `/world-state` and
 * `/world/stop` from the given facts, and a reload counter.
 * @param {Object} [world]
 * @param {boolean} [world.running]
 * @param {Object} [world.entities] - The entity map the state carries.
 * @param {number} [world.round]
 * @param {boolean} [world.stateFails] - Answer 500 to the status read.
 */
function installPage({ running = false, entities = {}, round = 0, stateFails = false } = {}) {
    const els = new Map(IDS.map((id) => [id, makeElement(id)]));
    /** @type {Array<{url: string, method: string}>} */
    const requests = [];
    globalThis.document = {
        getElementById: (id) => els.get(id) || null,
        addEventListener: () => {}
    };
    globalThis.window = {
        location: {
            reloads: 0,
            reload() { this.reloads += 1; }
        }
    };
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, method: options.method || 'GET' });
        if (url === '/world-state') {
            return stateFails
                ? jsonResponse({ error: 'Internal Server Error' }, 500)
                : jsonResponse({ state: { entities, turns: { roundNumber: round } }, running });
        }
        if (url === '/world/stop' && options.method === 'POST') {
            return jsonResponse({ success: true, despawned: Object.keys(entities).length, running: false });
        }
        return jsonResponse({}, 404);
    };
    return { els, requests, window: globalThis.window };
}

/** Let the reads a call started settle (the client never blocks on them). */
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Mount a launcher over a page describing the given world. */
async function mount(world) {
    const page = installPage(world);
    const menu = new AppMenu();
    menu.init();
    await settle();
    return { ...page, menu };
}

beforeEach(() => {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.fetch;
});

describe('the launcher on a page that just loaded', () => {
    it('asks the server what it is running, instead of assuming', async () => {
        const { requests } = await mount({ running: false });

        expect(requests.filter((r) => r.url === '/world-state')).toHaveLength(1);
    });

    it('says the world is not running and offers no way into a blank screen', async () => {
        const { els } = await mount({ running: false });

        expect(els.get('launcher-status').textContent).toMatch(/no world running/i);
        expect(els.get('btn-launcher-enter').disabled).toBe(true);
        expect(els.get('btn-launcher-stop').style.display).toBe('none');
    });

    it('keeps the launcher when leaving it with nothing to look at', async () => {
        const { menu } = await mount({ running: false });

        menu.close();

        expect(menu._openScreen).toBe('launcher');
    });
});

describe('the launcher while a world runs', () => {
    it('reports the counts it was given, enables Enter and offers Stop', async () => {
        const { els, menu } = await mount({
            running: true,
            entities: { 'droid-1': {}, 'droid-2': {} },
            round: 4
        });

        const status = els.get('launcher-status').textContent;
        expect(status).toMatch(/2 entities/);
        expect(status).toMatch(/round 4/);
        expect(els.get('btn-launcher-enter').disabled).toBe(false);
        expect(els.get('btn-launcher-stop').style.display).toBe('');

        menu.close();
        expect(menu._openScreen).toBeNull();
    });

    it('re-asks every time the launcher is opened', async () => {
        const { requests, menu } = await mount({ running: true });

        // From inside the world: the brand is the way back, and the answer on
        // screen must be the server's now, not the page's earlier.
        menu.open('launcher');

        expect(requests.filter((r) => r.url === '/world-state')).toHaveLength(2);
    });
});

describe('a world that exists but is not simulated (POST /api/world/load)', () => {
    it('can be looked at, and says that nothing is running', async () => {
        const { els, menu } = await mount({ running: false, entities: { 'droid-1': {} } });

        expect(els.get('launcher-status').textContent).toMatch(/1 entity/);
        expect(els.get('launcher-status').textContent).toMatch(/nothing is running/i);
        expect(els.get('btn-launcher-enter').disabled).toBe(false);
        // Stopping is offered only to a world that is actually being simulated.
        expect(els.get('btn-launcher-stop').style.display).toBe('none');

        menu.close();
        expect(menu._openScreen).toBeNull();
    });
});

describe('the launcher when the status read fails', () => {
    it('says it could not read the server, and lights up nothing', async () => {
        const { els } = await mount({ stateFails: true });

        expect(els.get('launcher-status').textContent).toMatch(/could not read/i);
        expect(els.get('btn-launcher-enter').disabled).toBe(true);
        expect(els.get('btn-launcher-stop').style.display).toBe('none');
    });
});

describe('Stop world', () => {
    it('is one POST and then a reload', async () => {
        const { els, requests, window } = await mount({
            running: true,
            entities: { 'droid-1': {} }
        });

        els.get('btn-launcher-stop').click();
        await settle();

        expect(requests.filter((r) => r.url === '/world/stop')).toEqual([
            { url: '/world/stop', method: 'POST' }
        ]);
        // The page reloads rather than reconciling: its entity, inventory and chat
        // caches all belong to the world that just ended.
        expect(window.location.reloads).toBe(1);
    });

    it('keeps the button usable when the server refuses', async () => {
        const { els, window } = await mount({ running: true, entities: { 'droid-1': {} } });
        globalThis.fetch = async () => jsonResponse({ error: 'Internal Server Error' }, 500);

        els.get('btn-launcher-stop').click();
        await settle();

        expect(window.location.reloads).toBe(0);
        expect(els.get('btn-launcher-stop').disabled).toBe(false);
        expect(els.get('launcher-status').textContent).toMatch(/could not read/i);
    });
});

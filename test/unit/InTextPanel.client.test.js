/**
 * InTextPanel (CLIENT) unit tests.
 *
 * Covers the pure formatters (no DOM) and the full render pass. The render
 * pass is asserted on the rendered HTML string — the one-way, read-only
 * surface this panel exposes.
 *
 * DOM stub: the project's vitest runs in `node` (no JSDOM); the stub is the
 * same thin shape as the EventLogPanel smoke test, just rich enough for
 * querySelector (id/class), innerHTML and textContent.
 *
 * @module test/unit/InTextPanel.client
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { InTextPanel } from '../../public/js/InTextPanel.js';

vi.mock('../../public/js/Config.js', () => ({
    AppConfig: {
        EVENTS: {
            HISTORY_LIMIT: 100
        },
        ENDPOINTS: {
            WORLD_EVENTS: '/world-events'
        },
        SERVER_HOST: 'localhost'
    }
}));

/**
 * Drain the microtask queue enough to complete the fetch → json → render
 * promise chain that _loadEvents starts.
 */
async function flushMicrotasks(times = 6) {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
    }
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function makeNode(tag = 'div', cls = null, id = null, inner = '') {
    return {
        tag,
        cls,
        id,
        innerHTML: inner,
        children: [],
        textContent: inner,
        appendChild(child) {
            this.children.push(child);
            return child;
        }
    };
}

function patchQuery(node) {
    node.querySelector = (sel) => {
        if (sel.startsWith('#')) {
            const id = sel.slice(1);
            if (!new RegExp('id="' + escRe(id) + '"').test(node.innerHTML)) return null;
            if (!node._stubsById) node._stubsById = new Map();
            let stub = node._stubsById.get(id);
            if (!stub) {
                stub = makeNode('div', null, id, node.innerHTML);
                node._stubsById.set(id, stub);
            }
            return stub;
        }
        if (sel.startsWith('.')) {
            const cls = sel.slice(1);
            return dfs(node.children, (c) => c.cls === cls) || null;
        }
        return null;
    };
}

function dfs(nodes, test) {
    for (const n of nodes) {
        if (n.cls && test(n)) return n;
        if (Array.isArray(n.children)) {
            const hit = dfs(n.children, test);
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * Minimal column: the exact element tree from index.html.
 */
function buildColumn() {
    const container = makeNode('div', null, 'in-text-section');
    const header = makeNode('div', 'in-text-header');
    const title = makeNode('h2', 'in-text-title');
    const tick = makeNode('span', 'in-text-tick');
    const content = makeNode('div', 'in-text-content');
    header.appendChild(title);
    header.appendChild(tick);
    container.children.push(header, content);
    patchQuery(container);
    patchQuery(content);
    patchQuery(tick);
    return { container, content, tick };
}

function buildPanel() {
    const { container, content, tick } = buildColumn();
    global.document = {
        querySelector(sel) {
            if (sel === '#in-text-section') return container;
            return null;
        }
    };
    const panel = new InTextPanel({
        handleError: vi.fn(),
        getEntityId: () => 'e_player_1',
        eventsSelector: '#in-text-events'
    });
    panel.init();
    return { container, content, tick, panel };
}

/**
 * Minimal fixture for the whole mirror. Room ids are UIDs (the server
 * assigns them at boot); the droid's `location` must equal the room key.
 * `entities` is a map keyed by entity id, matching every other client
 * consumer (WorldStateManager / UIManager / ActionManager all index it or
 * use Object.values — never an array).
 */
function makeState() {
    const roomId = 'room_abc123';
    const rooms = {
        [roomId]: {
            id: roomId,
            name: 'The Entrance Hall',
            description: 'A dimly lit hall. To your right, there is an open corridor.',
            connections: { right_door: { target: 'room_corridor' } },
            x: 0,
            y: 0,
            width: 300,
            height: 200
        },
        room_corridor: {
            id: 'room_corridor',
            name: 'The Eastern Corridor',
            connections: {
                left_door: { target: roomId },
                right_door: { target: 'room_missing' }
            },
            x: 400,
            y: 250,
            width: 250,
            height: 150
        }
    };
    const entities = {
        e_player_1: {
            id: 'e_player_1',
            name: 'Player Droid',
            location: roomId,
            spatial: { x: 10, y: 20 },
            components: [
                { id: 'c_arm_1', type: 'arm', identifier: 'arm-1' },
                { id: 'c_sensor_1', type: 'sensor', identifier: 'sensor-1' }
            ]
        },
        e_npc_7: {
            id: 'e_npc_7',
            name: 'Bolt Drifter',
            location: roomId,
            spatial: { x: 120, y: 130 },
            isNPC: true,
            components: [{ id: 'c_leg_7', type: 'leg', identifier: 'leg-7' }]
        },
        e_tree_3: {
            id: 'e_tree_3',
            name: 'Wooden Tree',
            location: roomId,
            spatial: { x: 150, y: 5 },
            isStatic: true,
            components: [{ id: 'c_wood_3', type: 'wood' }]
        },
        e_far_1: {
            id: 'e_far_1',
            name: 'Someone Else',
            location: 'room_corridor',
            spatial: { x: 5, y: 5 },
            components: []
        }
    };
    const componentInstances = {
        c_arm_1: { Physical: { existence: 0.75 } },
        c_sensor_1: { Physical: { existence: 1 } },
        c_leg_7: { Physical: { existence: 0.49 } },
        c_wood_3: { Physical: { existence: 0.2222 } }
    };
    const droppedItems = {
        item_1: { id: 'item_1', itemType: 'woodChunk', name: 'Wood chunk', roomId: roomId, x: 40, y: 15 },
        item_far: { id: 'item_far', itemType: 'metalChunk', name: 'Metal chunk', roomId: 'room_corridor', x: 1, y: 1 }
    };
    return {
        rooms,
        entities,
        droppedItems,
        components: { instances: componentInstances },
        turns: {
            roundNumber: 3,
            phase: 'planning',
            currentTick: 17,
            barrier: { readyCount: 1, pendingEntityIds: ['e_npc_7'] },
            actorOrder: [
                { name: 'Player Droid', initiative: 12, queuedCount: 0 },
                { name: 'Bolt Drifter', initiative: 7, queuedCount: 1 },
                { name: 'Extra', initiative: 1 }
            ]
        }
    };
}

let originalFetch;

beforeAll(() => {
    originalFetch = global.fetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

function noFetch() {
    global.fetch = vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    );
}

describe('InTextPanel — pure formatters', () => {
    it('formatPosition renders (x, y)', () => {
        const p = new InTextPanel();
        expect(p.formatPosition(3, -4)).toBe('(3, -4)');
        expect(p.formatPosition(0, 0)).toBe('(0, 0)');
        expect(p.formatPosition(undefined, 2)).toBe('(?, 2)');
    });

    it('formatExistencePercent treats the 0-1 store as percent (clamped)', () => {
        const p = new InTextPanel();
        expect(p.formatExistencePercent(1)).toBe('100%');
        expect(p.formatExistencePercent(0)).toBe('0%');
        expect(p.formatExistencePercent(0.75)).toBe('75%');
        expect(p.formatExistencePercent(0.49)).toBe('49%');
        expect(p.formatExistencePercent(0.2222)).toBe('22%');
        expect(p.formatExistencePercent(undefined)).toBe('—');
        expect(p.formatExistencePercent('nope')).toBe('—');
        expect(p.formatExistencePercent(1.5)).toBe('100%');
        expect(p.formatExistencePercent(-0.3)).toBe('0%');
    });

    it('formatDoor appends the door coordinate (room-relative exit point; degrades without geometry)', () => {
        const p = new InTextPanel();
        const rooms = {
            r1: { name: 'Entrance', x: 0, y: 0, width: 300, height: 200 },
            r2: { name: 'Corridor', x: 400, y: 250, width: 250, height: 150 }
        };
        const room = {
            name: 'Entrance',
            x: 0,
            y: 0,
            width: 300,
            height: 200,
            connections: { right_door: { target: 'r2' } }
        };
        // 300x200 room at the origin, neighbor at (400, 250): the connection
        // exits the right edge at (300, 190) — same point the map draws from
        expect(p.formatDoor('right_door', { target: 'r2' }, room, rooms)).toBe('right_door (300, 190) → Corridor');
        // Legacy string target resolves the same way, coordinates still apply
        expect(p.formatDoor('door', 'r2', room, rooms)).toBe('door (300, 190) → Corridor');
        // Unknown target → no coordinate, degrades to the raw id
        expect(p.formatDoor('door', 'missing', room, rooms)).toBe('door → missing');
        // Incomplete geometry (source room or target room) → no coordinate
        expect(p.formatDoor('door', { target: 'r2' }, {}, rooms)).toBe('door → Corridor');
        expect(p.formatDoor('door', { target: 'r2' }, { width: 300, height: 200 }, rooms)).toBe('door → Corridor');
        expect(p.formatDoor('door', { target: 'r2' }, room, {})).toBe('door → r2');
    });

    it('formatEntity renders position + name with NPC/YOU tags and component list', () => {
        const p = new InTextPanel();
        const entityMe = {
            id: 'me',
            name: 'Player',
            spatial: { x: 1, y: 2 },
            components: [{ id: 'c1', type: 'arm' }]
        };
        const entityNpc = {
            id: 'npc',
            name: 'Bolt',
            spatial: { x: 3, y: 4 },
            isNPC: true,
            components: [{ id: 'c2', type: 'leg' }]
        };
        const comps = { c1: { Physical: { existence: 0.9 } }, c2: { Physical: { existence: 0.5 } } };
        const me = p.formatEntity(entityMe, comps, 'me');
        expect(me.line).toContain('YOU');
        expect(me.line).toContain('(1, 2) Player');
        expect(me.components).toBe('arm 90%');
        const npc = p.formatEntity(entityNpc, comps, 'me');
        expect(npc.line).toContain('NPC');
        expect(npc.components).toBe('leg 50%');
        expect(p.formatEntity({ id: 'e', name: 'Empty', spatial: { x: 0, y: 0 } }, {}, null).components).toBeNull();
    });

    it('formatTurn renders round, phase, barrier + initiative', () => {
        const p = new InTextPanel();
        const t = makeState().turns;
        const line = p.formatTurn(t);
        expect(line).toContain('Round 3');
        expect(line).toContain('planning');
        expect(line).toContain('ready 1/2');
        expect(line).toContain('#1 Player Droid (12)');
        expect(line).toContain('#2 Bolt Drifter (7)');
        expect(line).toContain('#3 Extra (1)');
        const closedLine = p.formatTurn({
            roundNumber: 2,
            phase: 'resolution',
            barrier: { closed: true, closeReason: 'all_ready', closedAtTick: 42 }
        });
        expect(closedLine).toContain('planning closed (all_ready) @ tick 42');
        expect(closedLine).toContain('resolution');
        expect(closedLine).not.toContain('ready ');
        expect(p.formatTurn()).toBe('—');
        expect(p.formatTurn({ roundNumber: 1, phase: 'planning' })).toContain('Round 1');
    });

    it('formatEventLine renders timestamp · message @ tick', () => {
        const p = new InTextPanel();
        const line = p.formatEventLine({ time: 1700000000000, message: 'X dropped', tick: 5 });
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · X dropped @ tick 5$/);
    });
});

describe('InTextPanel — full render (fake DOM)', () => {
    it('update() renders every section with the correct data', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        state.serverTime = 1750000000000;
        noFetch();
        panel.update(state, state.entities.e_player_1);
        const html = content.innerHTML;
        // Room
        expect(html).toContain('The Entrance Hall');
        expect(html).toContain('(0, 0)');
        expect(html).toContain('300 × 200');
        expect(html).toContain('A dimly lit hall.');
        // Doors — room-relative exit point (300x200 room at origin, neighbor
        // at (400, 250) → right edge at (300, 190))
        expect(html).toContain('right_door (300, 190) → The Eastern Corridor');
        // Droids (room-only — the far-room entity is excluded)
        expect(html).toContain('Player Droid');
        expect(html).toContain('YOU');
        expect(html).toContain('Bolt Drifter');
        expect(html).toContain('NPC');
        expect(html).not.toContain('Someone Else');
        // Components with existence (0-1 store → %)
        expect(html).toContain('arm 75%');
        expect(html).toContain('sensor 100%');
        expect(html).toContain('leg 49%');
        // Objects (static props)
        expect(html).toContain('Wooden Tree');
        expect(html).toContain('wood 22%');
        // Items (room-filtered)
        expect(html).toContain('Wood chunk');
        expect(html).not.toContain('Metal chunk');
        // Turn
        expect(html).toContain('Round 3');
        expect(html).toContain('planning');
        expect(html).toContain('ready 1/2');
        expect(html).toContain('#1 Player Droid (12)');
        expect(html).toContain('#2 Bolt Drifter (7)');
        expect(html).toContain('#3 Extra (1)');
        // Events sub-section (fetch returned an empty list → "no recent events")
        await flushMicrotasks();
        expect(content.innerHTML).toContain('Recent Events');
        // _loadEvents writes into the events div; assert on that node (the
        // fake DOM keeps the div's innerHTML on its own stub object, not in the
        // parent render string).
        expect(content.querySelector('#in-text-events').innerHTML).toContain('no recent events');
    });

    it('update() writes the live tick to the tick badge', () => {
        const { tick, panel } = buildPanel();
        const state = makeState();
        state.serverTime = 1750000000000;
        noFetch();
        panel.update(state, state.entities.e_player_1);
        expect(tick.textContent).toBe('tick 17');
        // No turns → no tick written (empty).
        const emptyState = { entities: {}, rooms: {} };
        panel.update(emptyState, { id: 'x', location: 'room_abc123' });
        expect(tick.textContent).toBe('');
    });

    it('no droid → single "no droid incarnate yet" line', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        noFetch();
        panel.update(state, null);
        await flushMicrotasks();
        expect(content.innerHTML).toContain('No droid incarnate yet.');
    });

    it('user-visible values are HTML-escaped (no raw markup in innerHTML)', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        state.entities = {
            e_player_1: {
                ...state.entities.e_player_1,
                name: '<script>alert("xss")</script>',
                spatial: { x: 1, y: 1 }
            }
        };
        noFetch();
        panel.update(state, state.entities.e_player_1);
        await flushMicrotasks();
        // The rendered string carries the ESCAPED markup, never the raw tag.
        expect(content.innerHTML).toContain('&lt;script&gt;');
        expect(content.innerHTML).not.toContain('<script>alert');
        // State must be untouched by the render (one-way).
        expect(state.entities.e_player_1.name).toBe('<script>alert("xss")</script>');
    });

    it('events sub-section: renders the tail, drops ticks older than 60s', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        const now = 1750000000000;
        state.serverTime = now;
        const freshTick = now - 1000;
        const staleTick = now - 90000000; // 90s old → stale
        global.fetch = vi.fn((url) => {
            expect(url).toContain('/world-events');
            expect(url).toContain('limit=100');
            return Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve([
                        { tick: staleTick, time: staleTick, message: 'OLD — must not show' },
                        { tick: freshTick, time: freshTick, message: 'Fresh event' },
                        { time: now, message: 'No tick (kept)' }
                    ])
            });
        });
        panel.update(state, state.entities.e_player_1);
        await flushMicrotasks();
        const eventsEl = content.querySelector('#in-text-events');
        expect(eventsEl).toBeTruthy();
        const eventsHtml = eventsEl.innerHTML;
        expect(eventsHtml).toContain('Fresh event');
        expect(eventsHtml).toContain('No tick (kept)');
        expect(eventsHtml).not.toContain('OLD — must not show');
    });

    it('failed fetch → error is sunk, mirror unaffected', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        state.serverTime = 1750000000000;
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: false,
                json: () => Promise.reject(new Error('Server Error'))
            })
        );
        panel.update(state, state.entities.e_player_1);
        await flushMicrotasks();
        // The main content still rendered; only the events sub-section
        // is affected by the fetch failure.
        expect(content.innerHTML).toContain('Round 3');
        expect(content.innerHTML).toContain('Recent Events');
    });
});

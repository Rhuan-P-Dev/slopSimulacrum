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
            WORLD_EVENTS: '/world-events',
            // Perception: room-scoped delta stream (Feature G). The In-Text
            // panel appends "/:roomId?limit=N" to this.
            PERCEPTION_ROOM: '/perception'
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
        expect(p.formatPosition(3, -4)).toBe('(3.00, -4.00)');
        expect(p.formatPosition(0, 0)).toBe('(0.00, 0.00)');
        expect(p.formatPosition(undefined, 2)).toBe('(?, 2.00)');
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
        expect(p.formatDoor('right_door', { target: 'r2' }, room, rooms)).toBe('right_door (300.00, 190.00) → Corridor');
        // Legacy string target resolves the same way, coordinates still apply
        expect(p.formatDoor('door', 'r2', room, rooms)).toBe('door (300.00, 190.00) → Corridor');
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
        expect(me.line).toContain('(1.00, 2.00) Player');
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

    it('formatPerceptionEntry: baseline lists initial entities', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'baseline',
            tick: 0,
            summary: 'initial observation of room_abc: 3 entities',
            entities: { appeared: [{ id: 'e1', name: 'Player' }, { id: 'e2', name: 'Bolt' }, { id: 'e3', name: 'Tree' }] }
        }, 1);
        expect(out).toContain('round 1');
        expect(out).toContain('Initial observation');
        expect(out).toContain('+ Player');
        expect(out).toContain('+ Bolt');
        expect(out).toContain('+ Tree');
    });

    it('formatPerceptionEntry: delta names the movers as bullets', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 12,
            summary: '2 droids appeared; 1 despawned',
            entities: {
                appeared: [{ name: 'Player', id: 'a' }, { name: 'Bolt', id: 'b' }],
                despawned: [{ name: 'Tree', id: 'c' }],
                moved: []
            }
        }, 7);
        // Headline uses the caller's round number (state.turns.roundNumber),
        // never the entry's tick.
        expect(out).toContain('round 7');
        expect(out).toContain('Changes');
        expect(out).toContain('+ Player');
        expect(out).toContain('+ Bolt');
        expect(out).toContain('− Tree');
        // entity-only changes (no movers) → summary in the headline; round
        // omitted → headline falls back to the entry's tick ("tick 3") so it
        // is never blank.
        const noMover = p.formatPerceptionEntry({ tick: 3, summary: '1 item dropped (woodChunk)' });
        expect(noMover).toContain('tick 3');
        expect(noMover).toContain('Changes');
        expect(noMover).toContain('1 item dropped (woodChunk)');
    });

    it('formatPerceptionEntry: entry round overrides the viewer round (old history keeps its round)', () => {
        const p = new InTextPanel();
        // An entry stamped with round 3 must render "round 3" even when the
        // viewer is now on round 11 - re-rendering the perception history must
        // never relabel every bullet with the current round.
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 37,
            roundNumber: 3,
            summary: '1 item removed (Coal)',
            items: { removed: [{ itemId: 'i7', type: 'coal', name: 'Coal' }] }
        }, 11);
        expect(out).toContain('round 3');
        expect(out).not.toContain('round 11');

        // Entry without its own round -> falls back to the viewer's current round.
        const current = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 200,
            summary: '1 item added (Coal)',
            items: { added: [{ itemId: 'i8', type: 'coal', name: 'Coal' }] }
        }, 11);
        expect(current).toContain('round 11');

        // Neither entry round nor viewer round -> falls back to the entry's tick.
        expect(p.formatPerceptionEntry({ tick: 99, summary: 'x' })).toContain('tick 99');
    });

    it('formatPerceptionEntry: item/dropped/equipped bullets show name, id, and position (type-key fallback)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 9,
            summary: '1 item added; 1 dropped appeared; 1 equipped in Hall',
            items: {
                added: [{ itemId: 'i1', type: 'knife', name: 'Knife' }],
                removed: [{ itemId: 'i2', type: 'powerCell', name: 'Power Cell' }]
            },
            dropped: {
                added: [{ itemId: 'd1', type: 'woodChunk', name: 'Wood chunk', x: 10, y: 20 }],
                removed: [{ itemId: 'd2', type: 'metalChunk', name: 'Metal chunk', x: 5, y: 10 }],
                moved: [{ itemId: 'd3', type: 'knife', name: 'Knife', fromXY: { x: 1, y: 1 }, toXY: { x: 5, y: 5 } }]
            },
            equipped: {
                added: [{ id: 'e1', itemType: 'toolKit', name: 'Toolkit' }],
                removed: [{ id: 'e2', itemType: 'knife', name: 'Knife' }]
            }
        });
        expect(out).toContain('+ Knife (item) · id i1');
        expect(out).toContain('− Power Cell (item) · id i2');
        expect(out).toContain('+ Wood chunk (dropped) · id d1 (10.00, 20.00)');
        expect(out).toContain('− Metal chunk (dropped) · id d2 (5.00, 10.00)');
        // a moved dropped item shows its *new* position (toXY)
        expect(out).toContain('↔ Knife (dropped) · id d3 (5.00, 5.00)');
        expect(out).toContain('+ Toolkit (equipped) · id e1');
        expect(out).toContain('− Knife (equipped) · id e2');
        // held/equipped items have no floor position (they live in a slot).
        expect(out).not.toContain('(item) · id i1 (');
        expect(out).not.toContain('(equipped) · id e1 (');
        // A client-side row WITHOUT a server-set name falls back to the type
        // key, so it still shows an identifiable name (never "undefined").
        const noName = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 9,
            items: { added: [{ itemId: 'i1', type: 'woodChunk' }] },
            dropped: { removed: [{ itemId: 'd2', type: 'metalChunk' }] },
            equipped: { removed: [{ id: 'e2', itemType: 'powerCell' }] }
        });
        expect(noName).toContain('+ woodChunk (item)');
        expect(noName).toContain('− metalChunk (dropped)');
        expect(noName).toContain('− powerCell (equipped)');
        expect(noName).not.toContain('undefined');
    });

    it('formatPerceptionEntry: item/dropped/equipped bullets show the actor (name + id + position, server-resolved)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 20,
            summary: '1 item added; 1 removed; knife dropped',
            roomName: 'The Entrance Hall',
            items: {
                added: [{ itemId: 'i1', type: 'coal', name: 'Coal', actor: { id: 'e-john', name: 'John', x: -2, y: 3 } }],
                removed: [{ itemId: 'i2', type: 'coal', name: 'Coal', actor: { id: 'e-john', name: 'John', x: -2, y: 3 } }]
            },
            dropped: {
                added: [{ itemId: 'd1', type: 'knife', name: 'Knife', x: -84, y: 0.5, actor: { id: 'e-generator', name: 'Knife Generator', x: -84, y: 0.5 } }],
                removed: [{ itemId: 'd2', type: 'knife', name: 'Knife', actor: { id: 'e-jane', name: 'Jane', x: 5, y: 6 } }],
                moved: [{ itemId: 'd3', type: 'knife', name: 'Knife', fromXY: { x: 1, y: 1 }, toXY: { x: 5, y: 5 }, actor: { id: 'e-jane', name: 'Jane', x: 5, y: 6 } }]
            },
            equipped: {
                added: [{ id: 'e1', itemType: 'toolKit', name: 'Toolkit', actor: { id: 'e-bob', name: 'Bob', x: 10, y: 20 } }],
                // actor with no floor position -> id rendered, no "@"
                removed: [{ id: 'e2', itemType: 'knife', name: 'Knife', actor: { id: 'e-bob', name: 'Bob' } }]
            }
        });
        expect(out).toContain('+ Coal (item) · id i1 · gained by John (id e-john) @ (-2.00, 3.00) in The Entrance Hall');
        expect(out).toContain('− Coal (item) · id i2 removed from John (id e-john) @ (-2.00, 3.00) in The Entrance Hall');
        expect(out).toContain('+ Toolkit (equipped) · id e1 · equipped by Bob (id e-bob) @ (10.00, 20.00) in The Entrance Hall');
        expect(out).toContain('− Knife (equipped) · id e2 · unequipped by Bob (id e-bob) in The Entrance Hall');
        expect(out).toContain('+ Knife (dropped) · id d1 (-84.00, 0.50) · dropped by Knife Generator (id e-generator) @ (-84.00, 0.50) in The Entrance Hall');
        expect(out).toContain('− Knife (dropped) · id d2 · from Jane (id e-jane) @ (5.00, 6.00) in The Entrance Hall');
        expect(out).toContain('↔ Knife (dropped) · id d3 (5.00, 5.00) · owned by Jane (id e-jane) @ (5.00, 6.00) in The Entrance Hall');
        // no actor -> attribution omitted; never renders "by undefined"
        const noActor = p.formatPerceptionEntry({
            tick: 20,
            items: { added: [{ itemId: 'i9', type: 'knife', name: 'Knife' }] },
            dropped: { added: [{ itemId: 'd9', type: 'knife', name: 'Knife' }] },
            equipped: { added: [{ id: 'e9', itemType: 'knife', name: 'Knife' }] }
        });
        expect(noActor).not.toContain('by undefined');
        expect(noActor).not.toContain('from undefined');
        expect(noActor).not.toContain('gained by');
        expect(noActor).not.toContain('dropped by');
        expect(noActor).toContain('+ Knife (item) · id i9');
    });

    it('formatPerceptionEntry: actor with no friendly name (name == id) does not duplicate the id', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 20,
            summary: '1 item removed',
            items: {
                removed: [{ itemId: 'i7', type: 'coal', name: 'Coal', actor: { id: 'ent-abc123', name: 'ent-abc123', x: 0, y: 0 } }]
            }
        });
        // name falls back to the id -> the line reads "removed from
        // ent-abc123" once (no trailing "(id …)"); the item-removal verb also
        // loses the leading "· " separator so it flows as one phrase.
        expect(out).toContain('− Coal (item) · id i7 removed from ent-abc123 @ (0.00, 0.00)');
        expect(out).not.toContain('ent-abc123 (id ent-abc123)');
        expect(out).not.toContain('undefined');
    });

    it('formatPerceptionEntry: baseline skips item/dropped/equipped bullets (lists only initial entities)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'baseline',
            tick: 0,
            summary: 'initial observation of Hall: 1 entity, 3 dropped knives',
            entities: { appeared: [{ id: 'e1', name: 'Player' }] },
            dropped: {
                added: [
                    { itemId: 'd1', type: 'knife', name: 'Knife' },
                    { itemId: 'd2', type: 'knife', name: 'Knife' },
                    { itemId: 'd3', type: 'knife', name: 'Knife' }
                ]
            },
            items: { added: [], removed: [] },
            equipped: { added: [], removed: [] }
        });
        expect(out).toContain('+ Player');
        // Baselines stay entity-only in bullets; the (many) dropped/held/equipped
        // items remain in the "initial observation" summary, not as a bullet list.
        expect(out).not.toContain('Knife (dropped)');
        expect(out).not.toContain('Knife (item)');
        expect(out).not.toContain('(equipped)');
    });

    it('formatPerceptionEntry: moved shows coords, action, and locomotion', () => {
        const p = new InTextPanel();
        // Within-room spatial move (the real case): fromRoom === toRoom, so the
        // bullet shows the coordinate delta — not the (identical) room — and
        // credits the action + locomotion components that caused the move.
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 12,
            entities: {
                moved: [{
                    id: 'e1',
                    name: 'Bolt',
                    fromRoom: 'room1',
                    toRoom: 'room1',
                    fromXY: { x: 0, y: 0 },
                    toXY: { x: 10, y: 5 },
                    action: 'move',
                    // Store credited this action (authoritative attribution).
                    attributionSource: 'store',
                    locomotion: [{ type: 'Locomotion Core', id: 'c-loc' }]
                }]
            }
        });
        expect(out).toContain('Bolt');
        expect(out).toContain('(id e1)');
        expect(out).toContain('(0.00, 0.00) → (10.00, 5.00)');
        expect(out).toContain('· action: move');
        // Store-sourced → authoritative "used to execute" with the COUNT (QUANTOS).
        expect(out).toContain("used to execute the action 'move' (1):");
        expect(out).toContain('Locomotion Core (c-loc)');
        // The within-room move does *not* surface the (identical) room as a change,
        // and a non-matching action must not appear.
        expect(out).not.toContain('· action: punch');

        // Defensive cross-room branch (fromRoom !== toRoom) still renders, and a
        // move with no coordinates falls back to the room change.
        const crossRoom = p.formatPerceptionEntry({
            tick: 4,
            entities: { moved: [{ name: 'Bolt', fromRoom: 'Hall', toRoom: 'Corridor' }] }
        });
        expect(crossRoom).toContain('Bolt');
        expect(crossRoom).toContain('Hall');
        expect(crossRoom).toContain('Corridor');
        // fromRoom absent → still shows the destination, no dangling arrow
        const noFrom = p.formatPerceptionEntry({ tick: 4, entities: { moved: [{ name: 'Bolt', toRoom: 'Corridor' }] } });
        expect(noFrom).toContain('Bolt');
        expect(noFrom).toContain('Corridor');
        expect(noFrom).not.toContain('undefined');
    });

    it('formatPerceptionEntry: renders all locomotion components and is omitted when absent', () => {
        const p = new InTextPanel();
        // The server returns the *full list* of locomotion components that grant
        // the action's movement trait (an array of { type, id }); the client joins
        // them with ", ". Multiple legs → multiple parts.
        const out = p.formatPerceptionEntry({
            tick: 1,
            entities: {
                moved: [{
                    name: 'Rover',
                    id: 'r1',
                    fromXY: { x: 1, y: 1 },
                    toXY: { x: 2, y: 2 },
                    locomotion: [
                        { type: 'm1Leg', id: 'c-leg1' },
                        { type: 'm1Leg', id: 'c-leg2' }
                    ]
                }]
            }
        });
        expect(out).toContain('Rover');
        // No action in the fixture → the fallback `locomotion:` label is used
        // (the `used to execute the action '…'` label appears when an action is
        // present, as in the previous test). All legs are joined.
        expect(out).toContain('· locomotion: m1Leg (c-leg1), m1Leg (c-leg2)');
        // An absent locomotion emits no locomotion segment.
        const none = p.formatPerceptionEntry({
            tick: 1,
            entities: { moved: [{ name: 'Bolt', fromXY: { x: 1, y: 1 }, toXY: { x: 2, y: 2 } }] }
        });
        expect(none).not.toContain('locomotion');
        expect(none).not.toContain("used to execute");
    });

    // ── Provenance: ONLY store-sourced attribution may claim "used to execute".
    it('formatPerceptionEntry: heuristic attribution is labeled `locomotion`, never "used to execute"', () => {
        const p = new InTextPanel();
        // The server did NOT credit the action (no store / fallback) → attributionSource
        // is 'heuristic'. Even though an action name is present, the client must not
        // overclaim "used to execute the action": the parts are a Movement.move guess.
        const out = p.formatPerceptionEntry({
            tick: 1,
            entities: {
                moved: [{
                    id: 'e1',
                    name: 'Bolt',
                    fromXY: { x: 0, y: 0 },
                    toXY: { x: 1, y: 1 },
                    action: 'move',
                    attributionSource: 'heuristic',
                    locomotion: [{ type: 'Locomotion Core', id: 'c-loc' }]
                }]
            }
        });
        expect(out).toContain('· action: move');
        expect(out).toContain('Locomotion Core (c-loc)');
        // Labelled as locomotion (a guess); the authoritative claim is withheld.
        expect(out).toContain('· locomotion:');
        expect(out).not.toContain('used to execute');
        // Explicitly absent attributionSource is treated the same (defensive: the
        // store is the single source of the "used" claim).
        const absent = p.formatPerceptionEntry({
            tick: 1,
            entities: {
                moved: [{
                    id: 'e1',
                    name: 'Bolt',
                    fromXY: { x: 0, y: 0 },
                    toXY: { x: 1, y: 1 },
                    action: 'move',
                    locomotion: [{ type: 'Locomotion Core', id: 'c-loc' }]
                }]
            }
        });
        expect(absent).not.toContain('used to execute');
    });

    // ── Multi-limb (the user's core ask: QUANTOS) — store-sourced count.
    // ── Realistic case: a single-requirement move uses exactly ONE component
    // (its best mover), so the bullet shows count (1) + that one leg. This is the
    // shape the user asked for — NOT 4 legs for a move.
    it('formatPerceptionEntry: a move shows only its used mover (count 1)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            tick: 1,
            entities: {
                moved: [{
                    id: 'ent-m1',
                    name: 'Rover',
                    fromXY: { x: 0, y: 0 },
                    toXY: { x: 25, y: 25 },
                    action: 'move',
                    attributionSource: 'store',
                    locomotion: [{ type: 'm1Leg', id: 'c-leg-fL' }]
                }]
            }
        });
        expect(out).toContain("used to execute the action 'move' (1):");
        expect(out).toContain('m1Leg (c-leg-fL)');
        // Must NOT overclaim: the other three legs are not shown.
        expect(out).not.toContain('c-leg-fR');
        expect(out).not.toContain('c-leg-bL');
        expect(out).not.toContain('c-leg-bR');
    });

    // Genuine multi-component used actions (e.g. a two-actuator attack) still show
    // their real count.
    it('formatPerceptionEntry: a multi-part used action shows its real count', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            tick: 1,
            entities: {
                moved: [{
                    id: 'ent-robot',
                    name: 'Tandem',
                    fromXY: { x: 0, y: 0 },
                    toXY: { x: 5, y: 5 },
                    action: 'wheeledPush',
                    attributionSource: 'store',
                    locomotion: [
                        { type: 'm1Leg', id: 'c-wheel-L' },
                        { type: 'm1Leg', id: 'c-wheel-R' }
                    ]
                }]
            }
        });
        expect(out).toContain("used to execute the action 'wheeledPush' (2):");
        expect(out).toContain('m1Leg (c-wheel-L), m1Leg (c-wheel-R)');
    });

    // ── Performed actions (attribution-store rows): "which action, and ONLY the
    //    components that were used".
    it('formatPerceptionEntry: a performed action lists its used components (only the ones used)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 1,
            actions: {
                performed: [{
                    entity: 'ent-9',
                    name: 'Bolt',
                    action: 'cut',
                    used: [
                        { type: 'knifeBlade', id: 'c-blade-1' },
                        { type: 'arm', id: 'c-arm-L' }
                    ],
                    source: 'store'
                }]
            }
        });
        expect(out).toContain('⚔ Bolt · action: cut');
        expect(out).toContain('used (2):');
        expect(out).toContain('knifeBlade (c-blade-1), arm (c-arm-L)');
        // Only the used components appear — nothing extra.
        expect(out).not.toContain('c-arm-R');
    });

    it('formatPerceptionEntry: a performed action shows WHO was acted upon and WHICH component was hit', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 1,
            actions: {
                performed: [{
                    entity: 'ent-att',
                    name: 'Droid',
                    action: 'droid punch',
                    used: [{ type: 'm1ArticulatedHand', id: 'c-hand-1' }],
                    target: {
                        id: 'ent-tree',
                        name: 'Tree',
                        componentId: 'comp-trunk-1',
                        componentName: 'Tree'
                    },
                    source: 'store'
                }]
            }
        });
        expect(out).toContain('⚔ Droid · action: droid punch');
        expect(out).toContain('used (1): m1ArticulatedHand (c-hand-1)');
        expect(out).toContain('→ Tree (ent-tree)');
        expect(out).toContain('· hit: Tree (comp-trunk-1)');
    });

    it('formatPerceptionEntry: a punch whose target lost its name degrades to the id (never a fabricated name)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 1,
            actions: {
                performed: [{
                    entity: 'ent-att',
                    name: 'Droid',
                    action: 'droid punch',
                    used: [{ type: 'm1ArticulatedHand', id: 'c-hand-1' }],
                    target: { id: 'ent-gone', name: null, componentId: null, componentName: null },
                    source: 'store'
                }]
            }
        });
        expect(out).toContain('→ ent-gone');
        // No hit clause when no component was recorded.
        expect(out).not.toContain('hit:');
    });

    it('formatPerceptionEntry: a performed action without a target (spatial move) shows no target clause', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 1,
            actions: { performed: [{ entity: 'ent-9', name: 'Bolt', action: 'spin', used: [], target: null, source: 'store' }] }
        });
        expect(out).toContain('⚔ Bolt · action: spin');
        expect(out).not.toContain('→');
    });

    it('formatPerceptionEntry: a performed action without recorded components claims none (no overclaim)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 1,
            actions: { performed: [{ entity: 'ent-9', name: 'Bolt', action: 'speak', used: [], source: 'store' }] }
        });
        // The action IS reported; the "used (…):" clause must be absent.
        expect(out).toContain('⚔ Bolt · action: speak');
        expect(out).not.toContain('used (');
    });

    it('formatPerceptionEntry: a performed "move" row is suppressed when the moved bullet already showed it', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 1,
            entities: {
                moved: [{
                    id: 'ent-m2',
                    name: 'Rover',
                    fromXY: { x: 0, y: 0 },
                    toXY: { x: 3, y: 4 },
                    action: 'move',
                    attributionSource: 'store',
                    locomotion: [{ type: 'm1Leg', id: 'c-leg-fL' }]
                }]
            },
            actions: {
                performed: [
                    { entity: 'ent-m2', name: 'Rover', action: 'move', used: [{ type: 'm1Leg', id: 'c-leg-fL' }], source: 'store' },
                    { entity: 'ent-m2', name: 'Rover', action: 'punch', used: [{ type: 'arm', id: 'c-fist' }], source: 'store' }
                ]
            }
        });
        // The move bullet appears once (the performed 'move' twin is deduped)...
        const moveMentions = out.split("action 'move'").length - 1;
        expect(moveMentions).toBe(1);
        expect(out).not.toContain('⚔ Rover · action: move');
        // ...but a different action by the same entity still renders.
        expect(out).toContain('⚔ Rover · action: punch');
    });

    it('formatPerceptionEntry: baseline entries never render performed rows (initial observation, not an action window)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'baseline',
            tick: 1,
            entities: { appeared: [{ id: 'ent-9', name: 'Bolt' }] },
            actions: { performed: [{ entity: 'ent-9', name: 'Bolt', action: 'punch', used: [], source: 'store' }] }
        });
        expect(out).toContain('+ Bolt');
        expect(out).not.toContain('⚔');
    });

    // ── Double-id regression: an unnamed entity shows its id ONCE.
    it('formatPerceptionEntry: unnamed entity renders its id once (no double id)', () => {
        const p = new InTextPanel();
        // name undefined → the id IS the display name, shown once. Previously this
        // produced "↔ <id> (id <id>)" (the id twice).
        const out = p.formatPerceptionEntry({
            tick: 1,
            entities: {
                moved: [{
                    id: 'ent-abc123',
                    fromRoom: 'room1',
                    toRoom: 'room1',
                    fromXY: { x: 0, y: 0 },
                    toXY: { x: 1, y: 1 }
                }]
            }
        });
        expect(out).toContain('↔ ent-abc123');
        // The parenthetical id must NOT appear (the name is the id).
        expect(out).not.toContain('(id ent-abc123)');
    });

    // Friendly name + distinct id still shows both (unchanged behavior).
    it('formatPerceptionEntry: friendly name + distinct id shows both (name (id id))', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            tick: 1,
            entities: {
                moved: [{ id: 'e1', name: 'Rover', fromXY: { x: 0, y: 0 }, toXY: { x: 1, y: 1 } }]
            }
        });
        expect(out).toContain('↔ Rover (id e1)');
    });

    it('formatPerceptionEntry: statChange fallback bullet when no entity movers', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            tick: 5,
            entities: { statChanges: [{ statName: 'energy', from: 0.5, to: 0.2 }, { statName: 'stamina', from: 0.9, to: 0.1 }] }
        });
        expect(out).toContain('stat change');
        expect(out).toContain('energy');
    });

    it('formatPerceptionEntry: null/empty → dash; names HTML-escaped (no raw markup)', () => {
        const p = new InTextPanel();
        expect(p.formatPerceptionEntry(null)).toContain('—');
        expect(p.formatPerceptionEntry(undefined)).toContain('—');
        const out = p.formatPerceptionEntry({ tick: 1, entities: { appeared: [{ name: '<script>alert' }] } });
        expect(out).toContain('&lt;script&gt;');
        expect(out).not.toContain('<script>alert');
    });

    it('formatPerceptionEntry: new chat lines appear as "💬 speaker: "text"" bullets (speaker attribution captured at send time)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 12,
            summary: '1 message in chat (Player: "hi there") in Main Room',
            chat: {
                added: [
                    { id: 'm1', speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'hello there', tick: 12, ts: 200 },
                    { id: 'm2', speakerName: 'Player', speakerEntityId: null, text: 'hi "quoted"', tick: 12, ts: 300 }
                ]
            }
        }, 5);
        expect(out).toContain('round 5');
        expect(out).toContain('Changes');
        // entity speaker: name + id parenthetical (id ≠ name)
        expect(out).toContain('💬 Bolt (ent-npc-0001): "hello there"');
        // player speaker: no id → no parenthetical; quotes in the text escaped
        expect(out).toContain('💬 Player: "hi &quot;quoted&quot;"');
    });

    it('formatPerceptionEntry: an entity speaker with id === name shows the id exactly once (no duplicated "(id)")', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'delta',
            tick: 12,
            summary: '1 message in chat (X: "y")',
            chat: { added: [{ id: 'm1', speakerName: 'e_npc_1', speakerEntityId: 'e_npc_1', text: 'y' }] }
        }, 5);
        expect(out).toContain('💬 e_npc_1: "y"');
        expect(out).not.toContain('e_npc_1 (e_npc_1)');
    });

    it('formatPerceptionEntry: baseline entries never show chat lines (a baseline is a state description, not a transcript window)', () => {
        const p = new InTextPanel();
        const out = p.formatPerceptionEntry({
            kind: 'baseline',
            tick: 0,
            summary: 'initial observation of room_abc: 3 entities',
            entities: { appeared: [{ id: 'e1', name: 'Bolt' }] },
            chat: { added: [{ id: 'm1', speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'hi' }] }
        }, 1);
        expect(out).toContain('round 1');
        expect(out).toContain('Initial observation');
        expect(out).not.toContain('💬');
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
        expect(html).toContain('(0.00, 0.00)');
        expect(html).toContain('300 × 200');
        expect(html).toContain('A dimly lit hall.');
        // Doors — room-relative exit point (300x200 room at origin, neighbor
        // at (400, 250) → right edge at (300, 190))
        expect(html).toContain('right_door (300.00, 190.00) → The Eastern Corridor');
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

    it('events sub-section: renders recent events newest-first with full context + warn color', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        const now = 1750000000000;
        // Server returns oldest → newest; the unified view sends the active
        // entity so the server enriches each event with the room context, and
        // the panel reads the tail newest-first.
        const context = {
            roomId: 'room_abc123',
            roomName: 'The Entrance Hall',
            roomWidth: 40,
            roomHeight: 30,
            playerPosition: { x: 2.1, y: -1.4 },
            entities: [{ name: 'Droid A', x: 3, y: 5 }],
            droppedItems: [{ name: 'Coal' }, { name: 'Knife' }],
            exits: [{ door: 'right_door', targetRoomName: 'Corridor' }]
        };
        global.fetch = vi.fn((url) => {
            // Perception (Feature G) fetch is routed separately; return an
            // empty delta list so the "What Changed" section renders "no changes
            // yet" without interfering with the events assertion.
            if (!url.includes('/world-events')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true, kind: 'delta', deltas: [] })
                });
            }
            expect(url).toContain('limit=100');
            expect(url).toContain('entityId=e_player_1');
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    events: [
                        { tick: now - 20000000, time: now - 20000000, message: 'Old event' },
                        { tick: now - 1000, time: now - 1000, message: 'Droid A dropped Knife', level: 'warn', context },
                        { tick: now, time: now, message: 'John performed punch on Droid A', context }
                    ]
                })
            });
        });
        panel.update(state, state.entities.e_player_1);
        await flushMicrotasks();
        const eventsEl = content.querySelector('#in-text-events');
        expect(eventsEl).toBeTruthy();
        const eventsHtml = eventsEl.innerHTML;
        // Newest first: punch (newest) before dropped Knife before Old event.
        expect(eventsHtml.indexOf('John performed punch')).toBeLessThan(eventsHtml.indexOf('Droid A dropped Knife'));
        expect(eventsHtml.indexOf('Droid A dropped Knife')).toBeLessThan(eventsHtml.indexOf('Old event'));
        // No 60s staleness cap: the merged view keeps the whole recent tail.
        expect(eventsHtml).toContain('John performed punch');
        expect(eventsHtml).toContain('Droid A dropped Knife');
        expect(eventsHtml).toContain('Old event');
        // Full context (merged from the old Events tab).
        expect(eventsHtml).toContain('The Entrance Hall');
        expect(eventsHtml).toContain('40x30');
        expect(eventsHtml).toContain('you: (2, -1)');
        expect(eventsHtml).toContain('Droid A (3, 5)');
        expect(eventsHtml).toContain('items: 2');
        expect(eventsHtml).toContain('right_door→Corridor');
        // Warn event carries the warn class.
        expect(eventsHtml).toContain('in-text-event-warn');
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

describe('InTextPanel — perception full flow (_loadPerception)', () => {
    it('renders the room-scoped delta stream, newest-first, against the real endpoint shape', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        state.serverTime = 1750000000000;
        let urlSeen = null;
        const deltaOld = { tick: 1, kind: 'delta', summary: '1 droid appeared', entities: { appeared: [{ name: 'Player' }] } };
        const deltaNew = { tick: 2, kind: 'delta', summary: '1 droid appeared', entities: { appeared: [{ name: 'Bolt' }] } };
        global.fetch = vi.fn((u) => {
            if (u.includes('perception')) {
                urlSeen = u;
                // Real /perception/:roomId response shape.
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        success: true,
                        roomId: 'room_abc123',
                        kind: 'delta',
                        deltas: [deltaOld, deltaNew]
                    })
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        });
        panel.update(state, state.entities.e_player_1);
        await flushMicrotasks();
        const perc = content.querySelector('#in-text-perception');
        expect(perc).toBeTruthy();
        expect(urlSeen).toBe('/perception/room_abc123?limit=10');
        const html = perc.innerHTML;
        expect(html).toContain('+ Player');
        expect(html).toContain('+ Bolt');
        // Newest entry renders first. (Headlines share the same round, so the
        // per-entry differentiator is the bullet: + Bolt is the newer tick-2
        // entry and must come before + Player.)
        expect(html.indexOf('+ Bolt')).toBeLessThan(html.indexOf('+ Player'));
    });

    it('empty deltas → "no changes yet"; no droid/location → perception is never fetched', async () => {
        const { content, panel } = buildPanel();
        const state = makeState();
        state.serverTime = 1750000000000;
        global.fetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, kind: 'delta', deltas: [] })
        }));
        panel.update(state, state.entities.e_player_1);
        await flushMicrotasks();
        expect(content.querySelector('#in-text-perception').innerHTML).toContain('no changes yet');

        // No droid (null) → currentRoomId is null → _loadPerception must not
        // fetch (only the events fetch fires).
        const { panel: panel2 } = buildPanel();
        const state2 = makeState();
        state2.serverTime = 1750000000000;
        let percCalled = false;
        global.fetch = vi.fn((u) => {
            if (u.includes('perception')) percCalled = true;
            return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        });
        panel2.update(state2, null);
        await flushMicrotasks();
        expect(percCalled).toBe(false);
    });
});

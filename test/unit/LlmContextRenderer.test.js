/**
 * LlmContextController unit tests (Feature B, spec §4.3 / §9).
 *
 * World is fully mocked (no composition root, no data files): the renderer
 * is a pure reader/composer, so a hand-built facade mock keeps the tests
 * fast and deterministic. Covers:
 *   - section presence & stable order (eight headers, state before change),
 *   - "(none)" for empty sections (stable structure for weak models),
 *   - action line format (name/description/range/requirement/first canExecute id),
 *   - not-executable summary line,
 *   - other-room entity labeling,
 *   - the perception block: "now in this room" state before
 *     "since you last looked" deltas, baseline entries never displayed,
 *   - world failures: warn-level events only (info excluded),
 *   - hard budget (stats.chars ≤ 5000) and stats.truncated flags (the cascade
 *     sheds delta lines before state lines, state before failures).
 *
 * @module test/unit/LlmContextRenderer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import LlmContextController, { formatActionList, formatInstinctList } from '../../src/controllers/networking/LlmContextController.js';

// =========================================================================
// Mock world
// =========================================================================

const COMPONENT_REGISTRY = {
    coreBall: { traits: { Physical: { existence: 100, volume: 10 } } },
    head: { traits: { Physical: { existence: 50 }, Mind: { think_level: 5 } } },
    hand: { traits: { Physical: { strength: 25 }, Manipulation: { fine_controls: 30 } } },
    roller: { traits: { Physical: { existence: 60 }, Movement: { move: 20 } } }
};

const ACTION_REGISTRY = {
    'droid punch': {
        description: 'Throw a punch with your arm, dealing damage equal to your Physical.strength. Close-range melee attack.',
        range: 100,
        requirements: [{ trait: 'Physical', stat: 'strength', minValue: 15 }]
    },
    selfHeal: {
        description: 'Run a self-repair cycle that restores 10 existence to your core.',
        requirements: [
            { trait: 'Movement', stat: 'move', minValue: 1 },
            { trait: 'Physical', stat: 'existence', minValue: 1 }
        ]
    },
    cut: {
        description: 'Slice the target with an equipped knife, dealing damage equal to the knife\'s sharpness. The knife loses 1 sharpness with every cut.',
        range: 50,
        requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: 20 }]
    }
};

function makeComponent(id, type) { return { id, type }; }

function makeWorld(overrides = {}, extraEntities = {}) {
    const selfEntity = {
        id: 'ent-self',
        name: 'Bolt the Merchant',
        isNPC: true,
        location: 'room-1',
        spatial: { x: 100, y: 100 },
        components: [
            makeComponent('comp-core', 'coreBall'),
            makeComponent('comp-head', 'head'),
            makeComponent('comp-hand', 'hand'),
            makeComponent('comp-roller', 'roller')
        ]
    };
    const sameRoomEntity = {
        id: 'ent-same',
        name: 'Player Droid',
        location: 'room-1',
        spatial: { x: 134, y: 100 },
        components: [makeComponent('comp-same-core', 'coreBall'), makeComponent('comp-same-hand', 'hand')]
    };
    const otherRoomEntity = {
        id: 'ent-other',
        name: 'Vault Droid',
        location: 'room-2',
        spatial: { x: 10, y: 10 },
        components: [makeComponent('comp-other-core', 'coreBall')]
    };
    const entities = { 'ent-self': selfEntity, 'ent-same': sameRoomEntity, 'ent-other': otherRoomEntity, ...extraEntities };

    const rooms = {
        'room-1': {
            id: 'room-1',
            name: 'The Entrance Hall',
            width: 300,
            height: 200,
            x: 0,
            y: 0,
            connections: { right_door: { target: 'room-2' } }
        },
        'room-2': {
            id: 'room-2',
            name: 'The Deep Vault',
            width: 320,
            height: 220,
            x: 900,
            y: 250,
            connections: { left_door: { target: 'room-1' } }
        }
    };

    // Live component stats (current values); max existence comes from COMPONENT_REGISTRY.
    const componentStats = {};
    for (const compId of ['comp-core', 'comp-head', 'comp-hand', 'comp-roller', 'comp-same-core', 'comp-same-hand', 'comp-other-core']) {
        componentStats[compId] = {
            Physical: { existence: compId.startsWith('comp-same') ? 78 : compId.startsWith('comp-other') ? 80 : 90 },
            Spatial: { x: 0, y: 0 }
        };
    }
    componentStats['comp-hand'] = { Physical: { existence: 90, strength: 25 }, Manipulation: { fine_controls: 30 }, Spatial: { x: 0, y: 0 } };
    componentStats['comp-roller'] = { Physical: { existence: 60 }, Movement: { move: 20 }, Spatial: { x: 0, y: 0 } };
    componentStats['comp-head'] = { Physical: { existence: 45 }, Mind: { think_level: 8 }, Spatial: { x: 0, y: 0 } };
    componentStats['comp-same-hand'] = { Physical: { existence: 78, strength: 25 }, Spatial: { x: 0, y: 0 } };

    const actionsForEntity = {
        'droid punch': {
            ...ACTION_REGISTRY['droid punch'],
            canExecute: [{ entityId: 'ent-self', componentId: 'comp-hand', componentType: 'hand', score: 95 }],
            cannotExecute: []
        },
        selfHeal: {
            ...ACTION_REGISTRY.selfHeal,
            canExecute: [{ entityId: 'ent-self', componentId: 'comp-roller', componentType: 'roller', score: 80 }],
            cannotExecute: []
        },
        cut: {
            ...ACTION_REGISTRY.cut,
            canExecute: [],
            cannotExecute: [{ entityId: 'ent-self', componentName: 'Entity', componentIdentifier: 'ent-self' }]
        }
    };

    // Ring buffer contract: oldest → newest. The second event is warn-level:
    // the WORLD FAILURES section renders only warn events; the info event
    // stays in the ring but must not appear in the context.
    const recentEvents = [
        { tick: 3505, action: 'dropItem', targetId: null, message: 'Item \'knife\' dropped at (120, 40)', level: 'info', ts: 1 },
        { tick: 3520, action: 'droid punch', targetId: 'comp-same-core', message: 'Droid performed a punch dealing 25 damage!', level: 'warn', ts: 2 }
    ];

    return {
        getEntity: (id) => entities[id] || null,
        getAll: () => ({ entities }),
        getRooms: () => rooms,
        getComponentStats: (compId) => componentStats[compId] || null,
        getEquippedItems: (id) => (id === 'ent-self'
            ? [{ eqId: 'eq-knife', itemId: 'item-knife', itemType: 'knife', componentId: 'comp-hand' }]
            : []),
        getEntityItems: (id) => (id === 'ent-self'
            ? { 'comp-hand': [{ id: 'item-knife', type: 'knife' }, { id: 'item-cell-1', type: 'powerCell' }, { id: 'item-cell-2', type: 'powerCell' }] }
            : {}),
        getActionsForEntity: (id) => (id === 'ent-self' ? actionsForEntity : {}),
        getRecentEvents: (limit) => recentEvents.slice(-limit),
        // Perception stream (room-scoped, cursor-on-read). The default world
        // is quiet; tests that exercise the "since you last looked" block
        // override this with delta entries.
        getAgentRoomPerception: () => [],
        // Dropped items in the current room (positions), for the "Dropped items:" line.
        getDroppedItemsByRoom: (roomId) => (roomId === 'room-1'
            ? { 'dropped-1': { id: 'dropped-1', itemType: 'knife', name: 'Knife', x: 150, y: 120, roomId: 'room-1' } }
            : {}),
        // Public accessor only (BUG-032 pattern): the renderer must read the
        // component registry via getComponentDefinition(), never the internal
        // componentRegistry property directly.
        componentController: {
            componentRegistry: COMPONENT_REGISTRY,
            getComponentDefinition: (type) => COMPONENT_REGISTRY[type] || null
        },
        equippedItemStats: { getStats: (eqId) => (eqId === 'eq-knife' ? { Physical: { sharpness: 49 } } : null) },
        ...overrides
    };
}

describe('LlmContextController (context renderer)', () => {
    let controller;
    let world;

    beforeEach(() => {
        world = makeWorld();
        controller = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        controller.setWorldStateController(world);
    });

    it('requires the facade before building context', () => {
        const bare = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        expect(() => bare.buildContext('ent-self')).toThrow(/facade not injected/);
    });

    // R1: stable headers, in order (perception block moved to the end of
    // the context, directly above ROOM CHAT, per operator directive). The
    // action list and instincts are no longer fixed context sections — they
    // are discovered on demand via the get_actions / get_instincts tools
    // (in-round agent loop), so the stable narrative carries six headers.
    it('returns all six stable section headers, in order (R1)', () => {
        const { text } = controller.buildContext('ent-self');
        const headers = [
            '=== YOUR STATE ===',
            '=== HINTS ===',
            '=== WORLD FAILURES ===',
            '=== YOUR LAST ACTIONS & RESULTS ===',
            '=== YOUR WORLD (The Entrance Hall) ===',
            '=== ROOM CHAT ==='
        ];
        let last = -1;
        for (const header of headers) {
            const idx = text.indexOf(header);
            expect(idx, `header "${header}" must be present`).toBeGreaterThan(last);
            last = idx;
        }
    });

    it('renders the self section (name, room block, existence lowest-ratio-first, key stats, equipped, inventory)', () => {
        const { text, data } = controller.buildContext('ent-self');
        expect(text).toContain('Name: Bolt the Merchant');
        // Enriched room block (spec: better text & vision).
        expect(text).toContain('You are in: The Entrance Hall');
        expect(text).toContain('Room size: 300 x 200 | Your position: (100, 100)');
        expect(text).toContain('Exits: right_door → The Deep Vault');
        // Body: every component of the droid in droid order (coreBall, head,
        // hand, roller). In this fixture all four carry a Physical.existence
        // stat, so each renders as "type current/max".
        expect(data.self.existence).toHaveLength(4);
        expect(data.self.existence).toEqual(expect.arrayContaining([
            expect.objectContaining({ component: 'coreBall', current: 90, max: 100 }),
            expect.objectContaining({ component: 'head', current: 45, max: 50 }),
            expect.objectContaining({ component: 'hand', current: 90, max: 90 }),
            expect.objectContaining({ component: 'roller', current: 60, max: 60 })
        ]));
        expect(text).toContain('Existence: coreBall 90/100, head 45/50, hand 90/90, roller 60/60');
        expect(text).toContain('Key stats: strength=25 move=20 think=8');
        expect(text).toContain('Equipped: knife');
        expect(text).toContain('powerCell x2');
        expect(data.self.isNPC).toBe(true);
    });

    it('renders components without a Physical.existence stat as their type alone, in droid order', () => {
        const bareWorld = makeWorld({}, {
            'ent-bare': {
                id: 'ent-bare',
                name: 'Bare Droid',
                isNPC: true,
                location: 'room-1',
                spatial: { x: 20, y: 20 },
                components: [makeComponent('comp-bare-hand', 'hand'), makeComponent('comp-bare-roller', 'roller')]
            }
        });
        const c2 = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        c2.setWorldStateController(bareWorld);
        const { text, data } = c2.buildContext('ent-bare');
        // comp-bare-hand / comp-bare-roller are not in the fixture's live
        // stats, so both lack a Physical.existence stat and render as type
        // alone (matches the format: existence components carry current/max).
        expect(text).toContain('Existence: hand, roller');
        expect(data.self.existence).toHaveLength(2);
        expect(data.self.existence).toEqual(expect.arrayContaining([
            expect.objectContaining({ component: 'hand', current: null, max: null }),
            expect.objectContaining({ component: 'roller', current: null, max: null })
        ]));
    });

    it('shows the side label for repeated component types (m1Droid style)', () => {
        // Live entities built from blueprints carry an `identifier` per
        // component (e.g. m1Toe under m1Leg 'frontal_left' is
        // 'left_frontal_left'). Plain (un-varianted) components use the
        // 'default' label, which must render as a bare type.
        const m1Ent = {
            id: 'ent-m1',
            name: 'M1 Droid',
            isNPC: true,
            location: 'room-1',
            spatial: { x: 50, y: 50 },
            components: [
                { id: 'c-body', type: 'coreBall', identifier: 'default' },
                { id: 'c-leg-l', type: 'm1Leg', identifier: 'frontal_left' },
                { id: 'c-leg-r', type: 'm1Leg', identifier: 'frontal_right' },
                { id: 'c-toe-1', type: 'm1Toe', identifier: 'left_frontal_left' }
            ]
        };
        const m1World = makeWorld({
            getEntity: (id) => (id === 'ent-m1' ? m1Ent : null),
            getComponentStats: (compId) => ({
                'c-body': { Physical: { existence: 100 } },
                'c-leg-l': { Physical: { existence: 1 } },
                'c-leg-r': { Physical: { existence: 1 } },
                'c-toe-1': { Physical: { existence: 1 } }
            })[compId] || null
        }, {});
        const c2 = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        c2.setWorldStateController(m1World);
        const { text, data } = c2.buildContext('ent-m1');
        // 'default' label (coreBall) → bare type; labelled legs/toe → type (label).
        expect(text).toContain(
            'Existence: coreBall 100/100, m1Leg (frontal_left) 1/1, m1Leg (frontal_right) 1/1, m1Toe (left_frontal_left) 1/1'
        );
        expect(data.self.existence).toHaveLength(4);
        expect(data.self.existence[0]).toEqual({
            component: 'coreBall', identifier: null, current: 100, max: 100, ratio: 1
        });
        expect(data.self.existence[3]).toEqual({
            component: 'm1Toe', identifier: 'left_frontal_left', current: 1, max: 1, ratio: 1
        });
    });

    it('lists same-room entities with distance + position and other-room entities room-named', () => {
        const { text, data } = controller.buildContext('ent-self');
        expect(text).toContain('1. Player Droid (34 away) at (134, 100)');
        expect(text).toContain('in The Deep Vault');
        const same = data.entities.filter(e => e.room === 'same');
        const other = data.entities.filter(e => e.room !== 'same');
        expect(same).toHaveLength(1);
        expect(same[0]).toMatchObject({ id: 'ent-same', distance: 34, x: 134, y: 100 });
        expect(other).toHaveLength(1);
        expect(other[0].room).toBe('The Deep Vault');
        // Dropped items sub-list with positions (spec: better text & vision).
        expect(text).toContain('Dropped items: Knife at (150, 120)');
        expect(data.droppedItems).toEqual([{ id: 'dropped-1', name: 'Knife', itemType: 'knife', x: 150, y: 120 }]);
    });

    it('lists current-room placed machines (positions) in the "Placed machines:" line', () => {
        const machWorld = makeWorld({}, {
            'mach-1': {
                id: 'mach-1',
                name: 'Knife Generator',
                isMachine: true,
                location: 'room-1',
                spatial: { x: 200, y: 80 },
                machineType: 'knifeGenerator',
                ownerEntityId: 'ent-self'
            }
        });
        const c2 = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        c2.setWorldStateController(machWorld);
        const { text, data } = c2.buildContext('ent-self');
        expect(text).toContain('Placed machines: Knife Generator [type:knifeGenerator] at (200, 80), ent:mach-1');
        expect(data.placedMachines).toEqual([{
            id: 'mach-1', name: 'Knife Generator', machineType: 'knifeGenerator', x: 200, y: 80
        }]);
    });

    it('caps placed machines at the CONTEXT_MAX_PLACED_MACHINES budget', () => {
        const machines = {};
        for (let i = 1; i <= 7; i += 1) {
            machines[`mach-${i}`] = {
                id: `mach-${i}`, name: `Mach ${i}`, isMachine: true,
                location: 'room-1', spatial: { x: 10 * i, y: 10 * i }, machineType: `type-${i}`
            };
        }
        const mw = makeWorld({}, machines);
        const c2 = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        c2.setWorldStateController(mw);
        const { text, data } = c2.buildContext('ent-self');
        // Six fit, the seventh (Mach 7) is dropped from both text and data.
        expect(data.placedMachines).toHaveLength(6);
        expect(text).toContain('Placed machines: Mach 1 [type:type-1] at (10, 10), ent:mach-1');
        // Mach 6 sits at the end of the same one-line list (no re-prefixed prefix).
        expect(text).toContain('Mach 6 [type:type-6] at (60, 60), ent:mach-6');
        expect(text).not.toContain('Mach 7');
    });

    // Ghost exclusion (subtask 2b, defense-in-depth): a component-less "ghost"
    // entity (mid-cascade or not yet despawned) must NOT appear in the
    // YOUR WORLD section — the LLM must never "see" a corpse. Exclusion
    // (no dead marker) is the behavior the spec wants ("really deleted").
    describe('ghost exclusion (defense-in-depth, subtask 2b)', () => {
        it('excludes a component-less same-room ghost from YOUR WORLD (text + data mirror)', () => {
            // dist 1 from self — without the filter the ghost would sort FIRST.
            const ghost = {
                id: 'ent-ghost',
                name: 'Ghost Droid',
                location: 'room-1',
                spatial: { x: 101, y: 100 },
                components: []
            };
            const ghostWorld = makeWorld({}, { [ghost.id]: ghost });
            const ghostCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
            ghostCtrl.setWorldStateController(ghostWorld);

            const { text, data } = ghostCtrl.buildContext('ent-self');

            expect(text).not.toContain('Ghost Droid');
            expect(data.entities.find(e => e.id === 'ent-ghost')).toBeUndefined();
            // Regression guard: the living same-room entity is still listed
            // (now at index 1 — the ghost no longer occupies the top slot).
            expect(text).toContain('1. Player Droid (34 away) at (134, 100)');
            expect(data.entities.filter(e => e.room === 'same')).toHaveLength(1);
        });

        it('excludes a component-less other-room ghost from the room-named list', () => {
            const ghost = {
                id: 'ent-ghost-2',
                name: 'Wreck Droid',
                location: 'room-2',
                spatial: { x: 10, y: 10 },
                components: []
            };
            const ghostWorld = makeWorld({}, { [ghost.id]: ghost });
            const ghostCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
            ghostCtrl.setWorldStateController(ghostWorld);

            const { text, data } = ghostCtrl.buildContext('ent-self');

            expect(text).not.toContain('Wreck Droid');
            expect(data.entities.find(e => e.id === 'ent-ghost-2')).toBeUndefined();
            // The healthy other-room entity is still listed by room name.
            expect(text).toContain('Vault Droid');
            expect(data.entities.filter(e => e.room !== 'same')).toHaveLength(1);
        });
    });

    it('exposes the enriched room detail in data.room (name, size, environment, resolved exits)', () => {
        const { data } = controller.buildContext('ent-self');
        expect(data.room).toEqual({
            id: 'room-1',
            name: 'The Entrance Hall',
            width: 300,
            height: 200,
            x: 0,
            y: 0,
            surface: null,
            acoustic: null,
            lightSource: null,
            ceiling: null,
            condition: null,
            power: null,
            exits: [{ door: 'right_door', targetRoomName: 'The Deep Vault' }],
            atmosphere: null
        });
    });

    // Atmosphere (optional static room block, validated in RoomsController).
    // Rendered as a key=value line ("Atmosphere: light=dim, temperature=18.5, ...")
    // and mirrored in data.room. The default world has no atmosphere, so the
    // line is absent and data.room.atmosphere is null (the "exposes the enriched
    // room detail" test above pins the null case).
    it('renders an Atmosphere line (key=value style) and mirrors it in data.room when the room carries one', () => {
        const atmoWorld = makeWorld({
            getRooms: () => ({
                'room-1': {
                    id: 'room-1',
                    name: 'The Entrance Hall',
                    width: 300,
                    height: 200,
                    x: 0,
                    y: 0,
                    connections: { right_door: { target: 'room-2' } },
                    atmosphere: {
                        temperature: 18.5,
                        lightLevel: 'dim',
                        lightColor: 'warm',
                        smell: 'dust and old oil',
                        ambientSound: 'distant dripping water',
                        humidity: 60,
                        airQuality: 'stale',
                        fog: 'hazy'
                    },
                    surface: 'stone',
                    acoustic: 'echoey',
                    lightSource: 'flickering lanterns',
                    ceiling: 'high',
                    condition: 'worn',
                    power: 'flickering'
                },
                'room-2': {
                    id: 'room-2',
                    name: 'The Deep Vault',
                    width: 320,
                    height: 220,
                    x: 900,
                    y: 250,
                    connections: { left_door: { target: 'room-1' } }
                }
            })
        });
        const ctrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctrl.setWorldStateController(atmoWorld);

        const { text, data } = ctrl.buildContext('ent-self');
        expect(text).toContain(
            'Atmosphere: light=dim, color=warm, temperature=18.5, humidity=60%, air=stale, fog=hazy, smell=dust and old oil, sound=distant dripping water'
        );
        expect(text).toContain('Surface: stone | Acoustic: echoey | Light source: flickering lanterns | Ceiling: high | Condition: worn | Power: flickering');
        expect(data.room.atmosphere).toEqual({
            temperature: 18.5,
            lightLevel: 'dim',
            lightColor: 'warm',
            smell: 'dust and old oil',
            ambientSound: 'distant dripping water',
            humidity: 60,
            airQuality: 'stale',
            fog: 'hazy'
        });
        expect(data.room.surface).toBe('stone');
        expect(data.room.acoustic).toBe('echoey');
        expect(data.room.lightSource).toBe('flickering lanterns');
        expect(data.room.ceiling).toBe('high');
        expect(data.room.condition).toBe('worn');
        expect(data.room.power).toBe('flickering');
    });

    it('renders only the present fields (mixed presence) for both Atmosphere and env lines', () => {
        const mixedWorld = makeWorld({
            getRooms: () => ({
                'room-1': {
                    id: 'room-1',
                    name: 'The Entrance Hall',
                    width: 300,
                    height: 200,
                    x: 0,
                    y: 0,
                    connections: { right_door: { target: 'room-2' } },
                    atmosphere: {
                        lightLevel: 'dim',
                        temperature: 18.5,
                        airQuality: 'stale'
                    },
                    surface: 'stone',
                    power: 'dead'
                },
                'room-2': {
                    id: 'room-2',
                    name: 'The Deep Vault',
                    width: 320,
                    height: 220,
                    x: 900,
                    y: 250,
                    connections: { left_door: { target: 'room-1' } }
                }
            })
        });
        const ctrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctrl.setWorldStateController(mixedWorld);

        const { text, data } = ctrl.buildContext('ent-self');
        // Only light/temperature/air present -> color, humidity, fog, smell, sound omitted.
        expect(text).toContain('Atmosphere: light=dim, temperature=18.5, air=stale');
        // Only surface/power present -> acoustic, lightSource, ceiling, condition omitted.
        expect(text).toContain('Surface: stone | Power: dead');
        // No absent field may leak into either line.
        expect(text).not.toContain('color=');
        expect(text).not.toContain('humidity=');
        expect(text).not.toContain('fog=');
        expect(text).not.toContain('smell=');
        expect(text).not.toContain('sound=');
        expect(text).not.toContain('Acoustic:');
        expect(text).not.toContain('Light source:');
        expect(text).not.toContain('Ceiling:');
        expect(text).not.toContain('Condition:');
        expect(data.room.atmosphere).toEqual({
            lightLevel: 'dim',
            temperature: 18.5,
            airQuality: 'stale'
        });
        expect(data.room.surface).toBe('stone');
        expect(data.room.power).toBe('dead');
        expect(data.room.acoustic).toBeNull();
        expect(data.room.lightSource).toBeNull();
        expect(data.room.ceiling).toBeNull();
        expect(data.room.condition).toBeNull();
    });

    it('omits the Atmosphere line when the room has none (default world)', () => {
        const { text } = controller.buildContext('ent-self');
        expect(text).not.toContain('Atmosphere:');
    });

    // L4-1: empty dropped-items case → no "Dropped items:" line, data.droppedItems === []
    it('L4-1: omits the "Dropped items:" line and sets data.droppedItems to [] when the room has none', () => {
        const noDropWorld = makeWorld({ getDroppedItemsByRoom: () => ({}) });
        const ctrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctrl.setWorldStateController(noDropWorld);

        const { text, data } = ctrl.buildContext('ent-self');
        expect(text).not.toContain('Dropped items:');
        expect(data.droppedItems).toEqual([]);
    });

    // L4-2: no-connections room → "Exits: (none)", data.room.exits === []
    it('L4-2: renders "Exits: (none)" and data.room.exits === [] for a room with no connections', () => {
        const noConnWorld = makeWorld({
            getRooms: () => ({
                'room-1': {
                    id: 'room-1',
                    name: 'The Entrance Hall',
                    width: 300,
                    height: 200,
                    x: 0,
                    y: 0,
                    connections: {}
                },
                'room-2': {
                    id: 'room-2',
                    name: 'The Deep Vault',
                    width: 320,
                    height: 220,
                    x: 900,
                    y: 250,
                    connections: { left_door: { target: 'room-1' } }
                }
            })
        });
        const ctrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctrl.setWorldStateController(noConnWorld);

        const { text, data } = ctrl.buildContext('ent-self');
        expect(text).toContain('Exits: (none)');
        expect(data.room.exits).toEqual([]);
    });

    // L4-3: same-room entity WITHOUT spatial → no "at (" slot, x/y null in data
    it('L4-3: a same-room entity without spatial renders no "at (x, y)" slot and carries null x/y in data', () => {
        const selfEntity = {
            id: 'ent-self',
            name: 'Bolt the Merchant',
            isNPC: true,
            location: 'room-1',
            spatial: { x: 100, y: 100 },
            components: [
                makeComponent('comp-core', 'coreBall'),
                makeComponent('comp-head', 'head'),
                makeComponent('comp-hand', 'hand'),
                makeComponent('comp-roller', 'roller')
            ]
        };
        // Same-room entity with NO spatial (not yet placed).
        const sameRoomNoSpatial = {
            id: 'ent-same',
            name: 'Player Droid',
            location: 'room-1',
            components: [makeComponent('comp-same-core', 'coreBall'), makeComponent('comp-same-hand', 'hand')]
        };
        const noSpatialWorld = makeWorld({
            getEntity: (id) => (id === 'ent-self' ? selfEntity : null),
            getAll: () => ({ entities: { 'ent-self': selfEntity, 'ent-same': sameRoomNoSpatial } })
        });
        const ctrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctrl.setWorldStateController(noSpatialWorld);

        const { text, data } = ctrl.buildContext('ent-self');
        const sameEntry = text.split('\n').find(l => l.startsWith('1. Player Droid'));
        expect(sameEntry).toBeDefined();
        expect(sameEntry).not.toContain(' at (');
        const dataSame = data.entities.find(e => e.id === 'ent-same');
        expect(dataSame).toBeDefined();
        expect(dataSame.x).toBeNull();
        expect(dataSame.y).toBeNull();
    });

    it('degrades gracefully when the room is missing (no throw, fallback line, room: null)', () => {
        // Entity in a room UID that does not exist in the rooms map.
        const world2 = makeWorld();
        world2.getEntity = (id) => (id === 'ent-self'
            ? { id: 'ent-self', name: 'Bolt', isNPC: true, location: 'room-missing', spatial: { x: 10, y: 10 }, components: [] }
            : null);
        const ctrl2 = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctrl2.setWorldStateController(world2);

        const result = ctrl2.buildContext('ent-self');
        expect(result.data.room).toBeNull();
        expect(result.text).toContain('You are in: room-missing');
        // No size/position/exits lines when the room cannot be resolved.
        expect(result.text).not.toContain('Room size:');
        expect(result.text).not.toContain('Exits:');
    });

    // Actions are no longer a fixed context section: the get_actions tool
    // serves this data (and pins the classic render format it emits).
    it('action data carries description, range, requirement and a valid canExecute id (get_actions tool backing)', () => {
        const { data } = controller.buildContext('ent-self');
        expect(data.actions.entries.map(a => a.name).sort()).toEqual(['droid punch', 'selfHeal']);
        for (const entry of data.actions.entries) {
            expect(entry.canExecute[0]).toMatch(/^comp-/);
            expect(entry.description.length).toBeGreaterThan(0);
        }
        // The get_actions tool renders the classic format from this data; pin
        // it so a tool-side regression is caught.
        const rendered = formatActionList(data.actions.entries, data.actions.notExecutable);
        expect(rendered).toMatch(/- droid punch: Throw a punch with your arm.*\| range 100 \| needs Physical\.strength >= 15 \| use comp-hand/);
        expect(rendered).toMatch(/- selfHeal: Run a self-repair cycle.*\| range self \| needs Movement\.move >= 1, Physical\.existence >= 1 \| use comp-roller/);
    });

    it('summarizes non-executable actions in a single line (get_actions tool backing)', () => {
        const { data } = controller.buildContext('ent-self');
        expect(data.actions.notExecutable).toEqual(['cut']);
        const rendered = formatActionList(data.actions.entries, data.actions.notExecutable);
        expect(rendered).toContain('1 action not executable right now: cut');
    });

    it('renders world failures (warn-level events only) as "[tick] [action] message"', () => {
        const { text } = controller.buildContext('ent-self');
        // The warn event renders.
        expect(text).toContain('[3520] [droid punch] Droid performed a punch dealing 25 damage!');
        // The info event is excluded: success/intent events no longer occupy
        // the context — their state consequences ride the perception stream.
        expect(text).not.toContain('[3505] [dropItem]');
    });

    it('prints "(none)" for empty sections instead of omitting them', () => {
        const emptyWorld = makeWorld({
            getRecentEvents: () => [],
            getEquippedItems: () => [],
            getEntityItems: () => ({}),
            hintController: null // no hints → (none)
        });
        const emptyController = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        emptyController.setWorldStateController(emptyWorld);
        const { text } = emptyController.buildContext('ent-self');
        expect(text).toContain('Equipped: (none)');
        expect(text).toContain('Inventory: (none)');
        expect(text).toContain('=== WORLD FAILURES ===\n(none)');
        expect(text).toContain('since you last looked:\n(none)');
        expect(text).toContain('=== ROOM CHAT ===\n(none)');
    });

    it('ROOM CHAT section: renders recent room messages as "Speaker: text" (spec §7.5)', () => {
        // The RoomChatController facade (Feature D backend): oldest → newest.
        const messages = [
            { id: 'chat-1', roomId: 'room-1', speakerName: 'Player', speakerEntityId: null, text: 'Do you have fresh power cells?', tick: 7200, ts: 1 },
            { id: 'chat-2', roomId: 'room-1', speakerName: 'Bolt the Merchant', speakerEntityId: 'ent-self', text: 'Fresh power cells, best in the vault.', tick: 7204, ts: 2 }
        ];
        const chatWorld = makeWorld({
            getRoomChatMessages: (roomId, limit) => {
                expect(roomId).toBe('room-1'); // the entity's OWN room
                return messages.slice(-limit);
            }
        });
        const chatController = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        chatController.setWorldStateController(chatWorld);

        const { text, data } = chatController.buildContext('ent-self');

        // Both player AND npc lines make it into the NPC context (short-term memory).
        const section = text.slice(text.indexOf('=== ROOM CHAT ===') + '=== ROOM CHAT ==='.length);
        expect(section).toContain('Player: Do you have fresh power cells?');
        expect(section).toContain('Bolt the Merchant: Fresh power cells, best in the vault.');
        // Oldest → newest order.
        expect(section.indexOf('Player:')).toBeLessThan(section.indexOf('Bolt the Merchant:'));
        // The structured mirror carries the raw messages (truncation-safe).
        expect(data.roomChat).toHaveLength(2);
        expect(data.roomChat[0]).toContain('Player: Do you have fresh power cells?');
    });

    // RECENT TOOLS: the newest outcomes of the outcome-producing tools the
    // agent invoked (execute_action, toApproach, use_instinct, speak_in_room),
    // success + failure, named the way it called each tool. Rendered after the
    // room chat (the agent reads it last). Uses the same feedback ring as
    // "YOUR LAST ACTIONS & RESULTS" (LlmAgentFeedbackController), newest first.
    it('RECENT TOOLS: newest tool outcomes below ROOM CHAT, success + failure, named as called (spec §4.2)', () => {
        const feedback = [
            { actionName: 'toApproach', success: true, detail: 'queued' },
            { actionName: 'shootT1', success: false, detail: 'Target is too far away (distance 350 > 50)' },
            { actionName: 'speak_in_room', success: true, detail: 'said "Hello, Bolt."' },
            { actionName: 'use_instinct', success: false, detail: 'instinct chase requires a valid target' }
        ];
        const recentWorld = makeWorld({
            llmAgentFeedbackController: {
                getRecent: (entityId) => {
                    expect(entityId).toBe('ent-self');
                    return feedback.slice(); // newest first
                }
            }
        });
        const recentController = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        recentController.setWorldStateController(recentWorld);

        const { text } = recentController.buildContext('ent-self');

        const toolsIdx = text.indexOf('=== RECENT TOOLS ===');
        const chatIdx = text.indexOf('=== ROOM CHAT ===');
        expect(toolsIdx, 'RECENT TOOLS header must be present').toBeGreaterThanOrEqual(0);
        // Placed after the room chat (last thing the agent reads).
        expect(toolsIdx).toBeGreaterThan(chatIdx);

        const section = text.slice(toolsIdx + '=== RECENT TOOLS ==='.length);
        expect(section).toContain('- ✓ toApproach: queued');
        expect(section).toContain('- ✗ shootT1: Target is too far away (distance 350 > 50)');
        expect(section).toContain(`- ✓ speak_in_room: said "Hello, Bolt."`);
        expect(section).toContain('- ✗ use_instinct: instinct chase requires a valid target');
        // Newest first, in the order the feedback ring carries it.
        expect(section.indexOf('toApproach')).toBeLessThan(section.indexOf('shootT1'));
        expect(section.indexOf('shootT1')).toBeLessThan(section.indexOf('speak_in_room'));
        expect(section.indexOf('speak_in_room')).toBeLessThan(section.indexOf('use_instinct'));
    });

    it('RECENT TOOLS: (none) when no tool outcomes recorded', () => {
        const emptyWorld = makeWorld({
            llmAgentFeedbackController: { getRecent: () => [] }
        });
        const controller = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        controller.setWorldStateController(emptyWorld);

        const { text } = controller.buildContext('ent-self');
        expect(text).toContain('=== RECENT TOOLS ===\n(none)');
    });

    it('caps the rendered text at the 5000-char budget and flags the overflowing section', () => {
        // Flood the perception delta window (the only uncapped section — each
        // summary is unbounded length) so the composed context blows the budget;
        // the cascade sheds deltas first and flags the overflow. Failures and
        // chat are capped (10 x 200 chars) and cannot push the base context over
        // 5000 on their own once the action/instinct lists left the fixed
        // sections (they are now tool-backed discovery).
        const longSummary = 'x'.repeat(500);
        const deltaFlood = Array.from({ length: 10 }, (_, i) => ({
            sequence: i + 1, tick: i, kind: 'delta', summary: `${longSummary} ${i}`
        }));
        const floodWorld = makeWorld({
            getAgentRoomPerception: () => deltaFlood
        });
        const floodController = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        floodController.setWorldStateController(floodWorld);

        const { text, stats } = floodController.buildContext('ent-self');
        expect(stats.budgetChars).toBe(5000);
        expect(stats.chars).toBeLessThanOrEqual(5000);
        expect(text.length).toBeLessThanOrEqual(5000);
        // The overflow came from deltas, so that is the section flagged.
        expect(stats.truncated.deltas).toBe(true);
        // All stable headers survive truncation (the perception block ends the
        // narrative; every header must still be present).
        for (const header of ['=== YOUR STATE ===', '=== HINTS ===', '=== WORLD FAILURES ===', '=== ROOM CHAT ===']) {
            expect(text).toContain(header);
        }
    });

    it('honors option overrides (clamped to the budget maxes)', () => {
        const { data, text } = controller.buildContext('ent-self', { maxFailures: 1, maxEntities: 1 });
        expect(data.worldFailures).toHaveLength(1);
        // same-room list capped at 1, but the other-room entry still allowed
        expect(data.entities.filter(e => e.room === 'same')).toHaveLength(1);
        expect(text).toContain('[3520] [droid punch]');
        expect(text).not.toContain('[3505] [dropItem]');
    });

    // ------------------------------------------------------------------
    // Perception block ("YOUR WORLD"): state first, then change.
    // ------------------------------------------------------------------

    it('YOUR WORLD: state block comes before "since you last looked", delta lines render summaries in order', () => {
        const deltaWorld = makeWorld({
            getAgentRoomPerception: (entityId, roomId, { limit }) => {
                expect(entityId).toBe('ent-self');
                expect(roomId).toBe('room-1'); // the agent's OWN room
                return [
                    { sequence: 3, tick: 40, kind: 'delta', summary: '1 entity moved in The Entrance Hall' },
                    { sequence: 5, tick: 41, kind: 'delta', summary: '2 actions performed (droid punch by Bolt) in The Entrance Hall' }
                ].slice(-limit);
            }
        });
        const deltaCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        deltaCtrl.setWorldStateController(deltaWorld);
        const { text, data } = deltaCtrl.buildContext('ent-self');

        // The section is room-named and state-first.
        expect(text).toContain('=== YOUR WORLD (The Entrance Hall) ===');
        const nowIdx = text.indexOf('now in this room:');
        const sinceIdx = text.indexOf('since you last looked:');
        expect(nowIdx).toBeGreaterThan(-1);
        expect(sinceIdx).toBeGreaterThan(nowIdx);
        // The state block renders the current layout (the baseline).
        expect(text).toContain('1. Player Droid (34 away) at (134, 100)');
        // Delta summaries render, oldest → newest.
        expect(text).toContain('- 1 entity moved in The Entrance Hall');
        expect(text).toContain('- 2 actions performed (droid punch by Bolt) in The Entrance Hall');
        expect(text.indexOf('1 entity moved')).toBeLessThan(text.indexOf('2 actions performed'));
        // The data mirror carries the raw entries.
        expect(data.deltas).toHaveLength(2);
        expect(data.deltas[1].summary).toBe('2 actions performed (droid punch by Bolt) in The Entrance Hall');
    });

    it('YOUR WORLD: baseline entries are never displayed (first observation renders state only)', () => {
        const baselineWorld = makeWorld({
            getAgentRoomPerception: () => [{
                sequence: 1, tick: 1, kind: 'baseline',
                summary: 'initial observation of The Entrance Hall: 2 entities (Player Droid, Vault Droid)'
            }]
        });
        const baselineCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        baselineCtrl.setWorldStateController(baselineWorld);
        const { text } = baselineCtrl.buildContext('ent-self');

        // The baseline is the state block itself — the change window is quiet.
        expect(text).toContain('since you last looked:\n(none)');
        expect(text).not.toContain('initial observation');
        // …but the current layout is still rendered.
        expect(text).toContain('1. Player Droid (34 away) at (134, 100)');
    });

    it('YOUR WORLD: "now in this room" lines carry the LIVE targeting ids (entity + first existence component)', () => {
        // Regression: the Minako/tree incident (2026-10-21) — the model kept
        // cutting a stale tree id it remembered from an earlier round
        // ("Target entity … not found") because the context showed the tree
        // with no id at all and ids regenerate on respawn. The line must
        // always carry the CURRENT entity id (targetEntityId actions) and
        // the body component id (targetingType "component" actions, e.g. cut).
        const liveCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        liveCtrl.setWorldStateController(makeWorld());
        const { text } = liveCtrl.buildContext('ent-self');
        const lines = text.split('\n');

        const sameLine = lines.find((l) => l.startsWith('1. Player Droid'));
        expect(sameLine).toContain('[ent: ent-same | target comp: comp-same-core]');

        const vaultLine = lines.find((l) => l.startsWith('2. Vault Droid'));
        expect(vaultLine).toContain('[ent: ent-other | target comp: comp-other-core]');
    });

    it('budget cascade: delta lines are shed before the state block (state survives)', () => {
        // 10 long summaries (~5KB) on top of the base context blow the
        // 5000-char budget; the cascade halves the delta window first.
        const longSummary = 'x'.repeat(500);
        const deltaFlood = Array.from({ length: 10 }, (_, i) => ({
            sequence: i + 1, tick: i, kind: 'delta', summary: `${longSummary} ${i}`
        }));
        const cascadeWorld = makeWorld({
            getAgentRoomPerception: (id, roomId, { limit }) => deltaFlood.slice(-limit)
        });
        const cascadeCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        cascadeCtrl.setWorldStateController(cascadeWorld);

        const { text, stats } = cascadeCtrl.buildContext('ent-self');
        expect(stats.chars).toBeLessThanOrEqual(5000);
        expect(stats.truncated.deltas).toBe(true);
        // The state block (the agent's spatial anchor) survived the cascade.
        expect(text).toContain('1. Player Droid (34 away) at (134, 100)');
        // The delta window was halved (10 → 5).
        const sinceIdx = text.indexOf('since you last looked:');
        // ROOM CHAT is now the section that follows the perception block,
        // so the delta lines are sliced up to that header, not YOUR ACTIONS.
        const chatIdx = text.indexOf('=== ROOM CHAT ===');
        const deltaSection = text.slice(sinceIdx, chatIdx);
        const deltaLines = (deltaSection.match(/^- /gm) || []).length;
        expect(deltaLines).toBe(5);
    });

    it('returns empty output for an unknown entity (route maps this to 404)', () => {
        const result = controller.buildContext('ent-unknown');
        expect(result.text).toBe('');
        expect(result.data).toBeNull();
        expect(result.stats.chars).toBe(0);
    });

    it('includes HINTS section with hint messages when hintController is present', () => {
        const hintMessages = [
            'To move to entity target-ent go to (15, 20), you can\'t reach it but you get closer!',
            'Another hint message'
        ];
        const mockHintController = {
            getHints: () => ({ hints: hintMessages.map((msg, i) => ({ entityId: 'target-ent', message: msg, suggestedPosition: { x: 15 + i * 5, y: 20 } })) })
        };
        const hintWorld = makeWorld({ hintController: mockHintController });
        const ctxCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctxCtrl.setWorldStateController(hintWorld);

        const { text, data } = ctxCtrl.buildContext('ent-self');

        expect(text).toContain('=== HINTS ===');
        expect(text).toContain(hintMessages[0]);
        // _buildHintsData returns raw hint objects (not message strings); data.hints is an array of hint objects.
        expect(data.hints).toHaveLength(2);
        expect(data.hints[0].message).toBe(hintMessages[0]);
        expect(data.hints[0].suggestedPosition).toEqual({ x: 15, y: 20 });
    });

    it('prints "(none)" for empty hints section', () => {
        const hintWorld = makeWorld({ hintController: { getHints: () => ({ hints: [] }) } });
        const hintCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        hintCtrl.setWorldStateController(hintWorld);

        const { text } = hintCtrl.buildContext('ent-self');
        expect(text).toContain('=== HINTS ===\n(none)');
    });

    // --- LLM Degradation Tests (#9) ---

    it('hintController throws → renders "(none)" and round proceeds (spec degradation contract)', () => {
        const throwingHintController = {
            getHints: () => { throw new Error('hint controller failure'); }
        };
        const throwWorld = makeWorld({ hintController: throwingHintController });
        const throwCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        throwCtrl.setWorldStateController(throwWorld);

        // Should not throw; should render (none).
        expect(() => throwCtrl.buildContext('ent-self')).not.toThrow();
        const { text } = throwCtrl.buildContext('ent-self');
        expect(text).toContain('=== HINTS ===\n(none)');
    });

    it('hintController absent → renders "(none)" (older composition without hints)', () => {
        const noHintWorld = makeWorld({ hintController: null });
        const noHintCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        noHintCtrl.setWorldStateController(noHintWorld);

        const { text } = noHintCtrl.buildContext('ent-self');
        expect(text).toContain('=== HINTS ===\n(none)');
    });

    it('5 hints → exactly 3 rendered/data (budget cap enforcement)', () => {
        const fiveHints = [
            { entityId: 'target-1', message: 'Hint one for target-1', suggestedPosition: { x: 10, y: 10 } },
            { entityId: 'target-2', message: 'Hint two for target-2', suggestedPosition: { x: 20, y: 20 } },
            { entityId: 'target-3', message: 'Hint three for target-3', suggestedPosition: { x: 30, y: 30 } },
            { entityId: 'target-4', message: 'Hint four for target-4', suggestedPosition: { x: 40, y: 40 } },
            { entityId: 'target-5', message: 'Hint five for target-5', suggestedPosition: { x: 50, y: 50 } }
        ];
        const manyHintsController = {
            getHints: () => ({ hints: fiveHints })
        };
        const manyHintsWorld = makeWorld({ hintController: manyHintsController });
        const manyHintsCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        manyHintsCtrl.setWorldStateController(manyHintsWorld);

        const { text, data } = manyHintsCtrl.buildContext('ent-self');

        // Only 3 hints should be rendered/data.
        expect(data.hints).toHaveLength(3);
        expect(text).toContain(fiveHints[0].message);
        expect(text).toContain(fiveHints[1].message);
        expect(text).toContain(fiveHints[2].message);
        expect(text).not.toContain(fiveHints[3].message);
        expect(text).not.toContain(fiveHints[4].message);
    });

    it('raw hint objects → data.hints contains raw objects (not message strings)', () => {
        const rawHint = { entityId: 'target-ent', message: 'Test hint message', suggestedPosition: { x: 15, y: 20 } };
        const rawHintController = {
            getHints: () => ({ hints: [rawHint] })
        };
        const rawWorld = makeWorld({ hintController: rawHintController });
        const rawCtrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        rawCtrl.setWorldStateController(rawWorld);

        const { text, data } = rawCtrl.buildContext('ent-self');

        // data.hints should contain the raw hint objects (after fix #8).
        expect(data.hints).toHaveLength(1);
        expect(data.hints[0]).toBe(rawHint);
        expect(data.hints[0].message).toBe('Test hint message');
        expect(text).toContain('- Test hint message');
    });

    // R2: instinct line format (served by the get_instincts tool, not a
    // fixed context section — pin the line format the tool emits from the
    // instinct data).
    it('R2: instinct data renders as "- name: description" (get_instincts tool backing)', () => {
        const instincts = [
            { name: 'chase', description: 'move toward the target' },
            { name: 'chase_attack', description: 'chase and attack with punch' }
        ];
        const { data } = controller.buildContext('ent-self', { instincts });

        expect(data.instincts).toHaveLength(2);
        const rendered = formatInstinctList(data.instincts);
        expect(rendered).toContain('- chase: move toward the target');
        expect(rendered).toContain('- chase_attack: chase and attack with punch');
    });

    // R3: empty list / absent → data.instincts = [] (the get_instincts tool
    // would emit "(none)" via formatInstinctList); no throw.
    it('R3: empty instincts array → data.instincts = []; absent → data.instincts = []', () => {
        const { data: dataEmpty } = controller.buildContext('ent-self', { instincts: [] });
        expect(dataEmpty.instincts).toEqual([]);
        expect(formatInstinctList(dataEmpty.instincts)).toBe('(none)');

        // Absent instincts (undefined) → also empty
        const { data: dataAbsent } = controller.buildContext('ent-self');
        expect(dataAbsent.instincts).toEqual([]);
        expect(formatInstinctList(dataAbsent.instincts)).toBe('(none)');
    });

    // R4: facade fallback when options.instincts absent but facade has instinctController
    it('R4: options.instincts absent → falls back to facade instinctController (debug path)', () => {
        const facadeWithInstincts = {
            getEntity: world.getEntity,
            getAll: world.getAll,
            getRooms: world.getRooms,
            getComponentStats: world.getComponentStats,
            getEquippedItems: world.getEquippedItems,
            getEntityItems: world.getEntityItems,
            getActionsForEntity: world.getActionsForEntity,
            getRecentEvents: world.getRecentEvents,
            componentController: world.componentController,
            equippedItemStats: world.equippedItemStats,
            getRoomChatMessages: world.getRoomChatMessages,
            // Facade has instinct controller stub
            instinctController: {
                generateForEntity: () => [{ name: 'debug_instinct', description: 'from facade' }]
            }
        };
        const ctrl = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        ctrl.setWorldStateController(facadeWithInstincts);

        const { data } = ctrl.buildContext('ent-self'); // no options.instincts

        expect(data.instincts).toHaveLength(1);
        expect(data.instincts[0]).toEqual({ name: 'debug_instinct', description: 'from facade' });
        expect(formatInstinctList(data.instincts)).toContain('- debug_instinct: from facade');
    });

    // R5: too many instincts → data.instincts is capped to BUDGET.maxInstincts
    // (5). Instincts no longer occupy a fixed context section, so the cap is
    // on the data mirror / the get_instincts tool payload, not on rendered text.
    it('R5: more than BUDGET.maxInstincts → data.instincts capped to 5', () => {
        const manyInstincts = Array.from({ length: 8 }, (_, i) => ({
            name: `instinct_${i}`,
            description: 'x'.repeat(600)
        }));
        const { data } = controller.buildContext('ent-self', { instincts: manyInstincts });
        expect(data.instincts).toHaveLength(5);
        expect(data.instincts.map(i => i.name)).toEqual(['instinct_0', 'instinct_1', 'instinct_2', 'instinct_3', 'instinct_4']);
        // All five are rendered by the get_instincts tool (the old budget-driven
        // trim to 3 no longer applies; instinct count no longer drives text length).
        const rendered = formatInstinctList(data.instincts);
        expect(rendered).toMatch(/- instinct_0: /);
        expect(rendered).toMatch(/- instinct_4: /);
    });

    // R6: data.instincts mirror present in structured output (raw objects, not rendered lines)
    it('R6: data.instincts mirror contains the raw instinct objects', () => {
        const instincts = [
            { name: 'chase', description: 'move toward target' },
            { name: 'flee', description: 'run away from danger' }
        ];
        const { data } = controller.buildContext('ent-self', { instincts });

        expect(data.instincts).toBeDefined();
        expect(Array.isArray(data.instincts)).toBe(true);
        expect(data.instincts).toHaveLength(2);
        // data.instincts contains raw objects, not rendered lines
        expect(data.instincts[0]).toEqual({ name: 'chase', description: 'move toward target' });
        expect(data.instincts[1]).toEqual({ name: 'flee', description: 'run away from danger' });
    });
});

// =========================================================================
// _buildCraftData — cross-component crafting discovery (the get_crafts
// tool's data source). The recipe is craftable when the ENTITY holds the
// inputs ACROSS its components and at least one component can receive the
// outputs (the first in entity order is the reported destination).
// =========================================================================

const CRAFT_RECIPES = [
    {
        id: 'knife_to_t1',
        name: 'T1 Assembly',
        description: 'Forge one knife into a T1 container weapon.',
        inputs: [{ type: 'knife', quantity: 1 }],
        outputs: [{ type: 't1', quantity: 1 }]
    },
    {
        id: 'knife_generator',
        name: 'Knife Generator',
        description: 'Forge coal + knife into a generator.',
        inputs: [
            { type: 'knife', quantity: 1 },
            { type: 'coal', quantity: 1 }
        ],
        outputs: [{ type: 'knifeGenerator', quantity: 1 }]
    }
];

const ITEM_DEFINITIONS = {
    knife: { volume: 2 },
    coal: { volume: 1 },
    t1: { form: { volume: 10, externalVolume: 1 } },
    knifeGenerator: { volume: 3 }
};

const CRAFT_ENTITY = {
    id: 'ent-craft',
    type: 'droid',
    components: [
        { id: 'comp-head', type: 'head' },
        { id: 'comp-arm', type: 'hand' }
    ]
};

function makeCraftFacade({ recipes = CRAFT_RECIPES, entity, items, volumes = {} } = {}) {
    return {
        getCraftingRecipes: () => recipes,
        getEntity: (id) => (id === 'ent-craft' ? entity : null),
        getEntityItems: (id) => (id === 'ent-craft' ? items : {}),
        inventoryManager: {
            getItemDefinitions: () => ITEM_DEFINITIONS,
            getComponentVolume: (_e, componentId) => volumes[componentId] || { used: 0, max: 100 }
        }
    };
}

function makeCraftCtx(facade) {
    const ctx = new LlmContextController({ actionRegistry: {} });
    ctx.setWorldStateController(facade);
    return ctx;
}

describe('_buildCraftData (cross-component crafting discovery)', () => {
    it('craftable: input on comp-arm; the destination is the first component with room (comp-head, not the input host)', () => {
        const facade = makeCraftFacade({
            entity: CRAFT_ENTITY,
            items: { 'comp-arm': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const data = makeCraftCtx(facade)._buildCraftData('ent-craft');

        expect(data.craftable).toHaveLength(1);
        expect(data.craftable[0]).toMatchObject({
            recipeId: 'knife_to_t1',
            componentId: 'comp-head'
        });
        expect(data.notCraftable).toHaveLength(1);
        expect(data.notCraftable[0]).toMatchObject({
            recipeId: 'knife_generator',
            reason: 'missing coal x1'
        });
    });

    it('craftable: inputs split across components (coal on head, knife on arm)', () => {
        const facade = makeCraftFacade({
            entity: CRAFT_ENTITY,
            items: {
                'comp-head': [{ id: 'item-coal-1', type: 'coal', hostVolume: 1 }],
                'comp-arm': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }]
            }
        });
        const data = makeCraftCtx(facade)._buildCraftData('ent-craft');

        const gen = data.craftable.find((c) => c.recipeId === 'knife_generator');
        expect(gen).toMatchObject({
            recipeId: 'knife_generator',
            componentId: 'comp-head'
        });
    });

    it('lists a missing-ingredient recipe ONCE (entity-wide check, not per component)', () => {
        // The old per-component rule would have reported knife_generator
        // once per component without the ingredient; the entity-wide rule
        // reports it once.
        const facade = makeCraftFacade({
            entity: CRAFT_ENTITY,
            items: { 'comp-arm': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const data = makeCraftCtx(facade)._buildCraftData('ent-craft');

        const gen = data.notCraftable.filter((n) => n.recipeId === 'knife_generator');
        expect(gen).toHaveLength(1);
        expect(gen[0].reason).toBe('missing coal x1');
    });

    it('notCraftable: no component has room for the outputs (entity-wide freed volume)', () => {
        const facade = makeCraftFacade({
            entity: CRAFT_ENTITY,
            items: {
                'comp-head': [{ id: 'item-coal-1', type: 'coal', hostVolume: 1 }],
                'comp-arm': [{ id: 'item-knife-1', type: 'knife', hostVolume: 1 }]
            },
            volumes: {
                'comp-head': { used: 100, max: 100 },
                'comp-arm': { used: 100, max: 100 }
            }
        });
        const data = makeCraftCtx(facade)._buildCraftData('ent-craft');

        const gen = data.notCraftable.find((n) => n.recipeId === 'knife_generator');
        expect(gen).toBeDefined();
        expect(gen.reason).toBe(
            'no component has room for the outputs (tried "comp-head": free 0, gains 2, needs 3)');
    });

    it('nested items (hosted by an item, not by a component) are excluded from the pool', () => {
        const facade = makeCraftFacade({
            entity: CRAFT_ENTITY,
            items: {
                'comp-head': [{ id: 'item-box-1', type: 'box' }],
                // The knife sits INSIDE the box item — not a component host.
                'item-box-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }]
            }
        });
        const data = makeCraftCtx(facade)._buildCraftData('ent-craft');

        expect(data.craftable).toHaveLength(0);
        expect(data.notCraftable).toHaveLength(2);
        expect(data.notCraftable.every((n) => n.reason.includes('missing knife x1'))).toBe(true);
    });

    it('degrades to empty lists without a facade, without recipes, or without an entity', () => {
        const noFacade = new LlmContextController({ actionRegistry: {} });
        expect(noFacade._buildCraftData('ent-craft')).toEqual({ craftable: [], notCraftable: [] });

        const noRecipes = makeCraftCtx({
            getCraftingRecipes: () => [],
            getEntity: () => CRAFT_ENTITY,
            getEntityItems: () => ({})
        });
        expect(noRecipes._buildCraftData('ent-craft')).toEqual({ craftable: [], notCraftable: [] });

        const noEntity = makeCraftCtx({
            getCraftingRecipes: () => CRAFT_RECIPES,
            getEntity: () => null,
            getEntityItems: () => ({})
        });
        expect(noEntity._buildCraftData('ent-craft')).toEqual({ craftable: [], notCraftable: [] });
    });
});

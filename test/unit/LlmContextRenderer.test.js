/**
 * LlmContextController unit tests (Feature B, spec §4.3 / §9).
 *
 * World is fully mocked (no composition root, no data files): the renderer
 * is a pure reader/composer, so a hand-built facade mock keeps the tests
 * fast and deterministic. Covers:
 *   - section presence & stable order,
 *   - "(none)" for empty sections (stable structure for weak models),
 *   - action line format (name/description/range/requirement/first canExecute id),
 *   - not-executable summary line,
 *   - other-room entity labeling,
 *   - hard budget (stats.chars ≤ 4000) and stats.truncated flags,
 *   - event line format "[tick] [action] message".
 *
 * @module test/unit/LlmContextRenderer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import LlmContextController from '../../src/controllers/networking/LlmContextController.js';

// =========================================================================
// Mock world
// =========================================================================

const COMPONENT_REGISTRY = {
    coreBall: { traits: { Physical: { durability: 100, volume: 10 } } },
    head: { traits: { Physical: { durability: 50 }, Mind: { think_level: 5 } } },
    hand: { traits: { Physical: { strength: 25 }, Manipulation: { fine_controls: 30 } } },
    roller: { traits: { Physical: { durability: 60 }, Movement: { move: 20 } } }
};

const ACTION_REGISTRY = {
    'droid punch': {
        description: 'Throw a punch with your arm, dealing damage equal to your Physical.strength. Close-range melee attack.',
        range: 100,
        requirements: [{ trait: 'Physical', stat: 'strength', minValue: 15 }]
    },
    selfHeal: {
        description: 'Run a self-repair cycle that restores 10 durability to your core.',
        requirements: [
            { trait: 'Movement', stat: 'move', minValue: 1 },
            { trait: 'Physical', stat: 'durability', minValue: 1 }
        ]
    },
    cut: {
        description: 'Slice the target with an equipped knife, dealing damage equal to the knife\'s sharpness. The knife loses 1 sharpness with every cut.',
        range: 50,
        requirements: [{ trait: 'Physical', stat: 'sharpness', minValue: 20 }]
    }
};

function makeComponent(id, type) { return { id, type }; }

function makeWorld(overrides = {}) {
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
    const entities = { 'ent-self': selfEntity, 'ent-same': sameRoomEntity, 'ent-other': otherRoomEntity };

    const rooms = {
        'room-1': { id: 'room-1', name: 'The Entrance Hall', description: 'A dimly lit hall.' },
        'room-2': { id: 'room-2', name: 'The Deep Vault', description: 'Cold and metallic.' }
    };

    // Live component stats (current values); max durability comes from COMPONENT_REGISTRY.
    const componentStats = {};
    for (const compId of ['comp-core', 'comp-head', 'comp-hand', 'comp-roller', 'comp-same-core', 'comp-same-hand', 'comp-other-core']) {
        componentStats[compId] = {
            Physical: { durability: compId.startsWith('comp-same') ? 78 : compId.startsWith('comp-other') ? 80 : 90 },
            Spatial: { x: 0, y: 0 }
        };
    }
    componentStats['comp-hand'] = { Physical: { durability: 90, strength: 25 }, Manipulation: { fine_controls: 30 }, Spatial: { x: 0, y: 0 } };
    componentStats['comp-roller'] = { Physical: { durability: 60 }, Movement: { move: 20 }, Spatial: { x: 0, y: 0 } };
    componentStats['comp-head'] = { Physical: { durability: 45 }, Mind: { think_level: 8 }, Spatial: { x: 0, y: 0 } };
    componentStats['comp-same-hand'] = { Physical: { durability: 78, strength: 25 }, Spatial: { x: 0, y: 0 } };

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

    // Ring buffer contract: oldest → newest
    const recentEvents = [
        { tick: 3505, action: 'dropItem', targetId: null, message: 'Item \'knife\' dropped at (120, 40)', level: 'info', ts: 1 },
        { tick: 3520, action: 'droid punch', targetId: 'comp-same-core', message: 'Droid performed a punch dealing 25 damage!', level: 'info', ts: 2 }
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

    it('returns all six stable section headers, in order', () => {
        const { text } = controller.buildContext('ent-self');
        const headers = [
            '=== YOUR STATE ===',
            '=== NEARBY ENTITIES ===',
            '=== YOUR ACTIONS (executable now) ===',
            '=== HINTS ===',
            '=== RECENT EVENTS ===',
            '=== ROOM CHAT ==='
        ];
        let last = -1;
        for (const header of headers) {
            const idx = text.indexOf(header);
            expect(idx, `header "${header}" must be present`).toBeGreaterThan(last);
            last = idx;
        }
    });

    it('renders the self section (name, room, durability lowest-ratio-first, key stats, equipped, inventory)', () => {
        const { text, data } = controller.buildContext('ent-self');
        expect(text).toContain('Name: Bolt the Merchant');
        expect(text).toContain('Room: The Entrance Hall - A dimly lit hall.');
        // max 2 durability components, lowest ratio first (stable sort keeps
        // component order on ties: head 45/50 = 0.9 and core 90/100 = 0.9)
        expect(data.self.durability).toHaveLength(2);
        expect(data.self.durability).toEqual(expect.arrayContaining([
            expect.objectContaining({ component: 'head', current: 45, max: 50 }),
            expect.objectContaining({ component: 'coreBall', current: 90, max: 100 })
        ]));
        expect(text).toContain('head 45/50');
        expect(text).toContain('Key stats: strength=25 move=20 think=8');
        expect(text).toContain('Equipped: knife');
        expect(text).toContain('powerCell x2');
        expect(data.self.isNPC).toBe(true);
    });

    it('lists same-room entities with Euclidean distance and other-room entities room-named', () => {
        const { text, data } = controller.buildContext('ent-self');
        expect(text).toContain('1. Player Droid (34 away)');
        expect(text).toContain('in The Deep Vault');
        const same = data.entities.filter(e => e.room === 'same');
        const other = data.entities.filter(e => e.room !== 'same');
        expect(same).toHaveLength(1);
        expect(same[0]).toMatchObject({ id: 'ent-same', distance: 34 });
        expect(other).toHaveLength(1);
        expect(other[0].room).toBe('The Deep Vault');
    });

    it('renders executable actions with description, range, requirement and a valid canExecute id', () => {
        const { text, data } = controller.buildContext('ent-self');
        expect(text).toMatch(/- droid punch: Throw a punch with your arm.*\| range 100 \| needs Physical\.strength >= 15 \| use comp-hand/);
        expect(text).toMatch(/- selfHeal: Run a self-repair cycle.*\| range self \| needs Movement\.move >= 1, Physical\.durability >= 1 \| use comp-roller/);
        expect(data.actions.entries.map(a => a.name).sort()).toEqual(['droid punch', 'selfHeal']);
        for (const entry of data.actions.entries) {
            expect(entry.canExecute[0]).toMatch(/^comp-/);
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });

    it('summarizes non-executable actions in a single line', () => {
        const { text, data } = controller.buildContext('ent-self');
        expect(text).toContain('1 action not executable right now: cut');
        expect(data.actions.notExecutable).toEqual(['cut']);
    });

    it('renders events as "[tick] [action] message"', () => {
        const { text } = controller.buildContext('ent-self');
        expect(text).toContain('[3520] [droid punch] Droid performed a punch dealing 25 damage!');
        expect(text).toContain("[3505] [dropItem] Item 'knife' dropped at (120, 40)");
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
        expect(text).toContain('=== RECENT EVENTS ===\n(none)');
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

    it('caps the rendered text at the 4000-char budget and flags truncation', () => {
        // Flood the event log with long lines to blow the budget.
        const flood = Array.from({ length: 200 }, (_, i) => ({
            tick: i, action: 'droid punch', targetId: null,
            message: 'Droid performed a punch dealing 25 damage! '.repeat(8),
            level: 'info', ts: i
        }));
        const floodWorld = makeWorld({ getRecentEvents: (limit) => flood.slice(-limit) });
        const floodController = new LlmContextController({ actionRegistry: ACTION_REGISTRY });
        floodController.setWorldStateController(floodWorld);

        const { text, stats } = floodController.buildContext('ent-self');
        expect(stats.budgetChars).toBe(4000);
        expect(stats.chars).toBeLessThanOrEqual(4000);
        expect(text.length).toBeLessThanOrEqual(4000);
        expect(stats.truncated.events).toBe(true);
        // all headers survive truncation (including HINTS)
        for (const header of ['=== YOUR STATE ===', '=== YOUR ACTIONS (executable now) ===', '=== HINTS ===', '=== RECENT EVENTS ===']) {
            expect(text).toContain(header);
        }
    });

    it('honors option overrides (clamped to the budget maxes)', () => {
        const { data, text } = controller.buildContext('ent-self', { maxEvents: 1, maxEntities: 1 });
        expect(data.recentEvents).toHaveLength(1);
        // same-room list capped at 1, but the other-room entry still allowed
        expect(data.entities.filter(e => e.room === 'same')).toHaveLength(1);
        expect(text).toContain('[3520] [droid punch]');
        expect(text).not.toContain('[3505] [dropItem]');
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
});

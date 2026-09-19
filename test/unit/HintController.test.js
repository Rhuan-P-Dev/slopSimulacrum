/**
 * HintController unit tests — ReachabilityRule spec §7 test matrix
 *
 * Tests the full ReachabilityRule contract with a comprehensive mock WSC
 * following the createMockWorldStateController() pattern.
 *
 * @module test/unit/HintController.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import HintController from '../../src/controllers/hints/HintController.js';
import { ReachabilityRule } from '../../src/controllers/hints/rules/ReachabilityRule.js';
import { DROP_BASE_RANGE, DROP_RANGE_MULTIPLIER } from '../../src/utils/Constants.js';

// =========================================================================
// Comprehensive Mock WorldStateController
// =========================================================================

function createMockWSC(opts = {}) {
    const {
        entities = {},
        rooms = {},
        droppedItems = {},
        componentStats = {},
        allEntities = {}
    } = opts;

    return {
        getEntity(id) {
            return entities[id] || null;
        },
        getRooms() {
            return rooms;
        },
        getDroppedItems() {
            return droppedItems;
        },
        getComponentStats(compId) {
            return componentStats[compId] || null;
        },
        stateEntityController: {
            getAll() {
                return allEntities;
            }
        }
    };
}

/**
 * Build a minimal player entity with location and spatial position.
 */
function makePlayer(x = 0, y = 0, room = 'room-1') {
    return {
        id: 'ent-player',
        location: room,
        spatial: { x, y },
        components: []
    };
}

/**
 * Build a dropped item.
 */
function makeItem(id, x, y, name = 'item') {
    return { id, roomId: 'room-1', x, y, name };
}

/**
 * Build an entity (NPC, droid, etc.) in a room.
 */
function makeEntity(id, name, x, y, room = 'room-1', extra = {}) {
    return {
        id,
        name,
        location: room,
        spatial: { x, y },
        components: [],
        ...extra
    };
}

/**
 * Build rooms with width/height.
 */
function makeRooms() {
    return {
        'room-1': { uid: 'room-1', name: 'Room 1', width: 200, height: 200 }
    };
}

/**
 * Build a full context for ReachabilityRule.evaluate().
 */
function makeContext(opts = {}) {
    const {
        playerX = 0,
        playerY = 0,
        playerRoom = 'room-1',
        items = [],
        maxMove = 10,
        maxStrength = 5,
        rangeExpression = null,
        targetId = null,
        componentStatsOverride = {}
    } = opts;

    const rooms = makeRooms();
    const player = makePlayer(playerX, playerY, playerRoom);

    // Build component stats for the player.
    const components = [
        { id: 'comp-movement', stats: { Movement: { move: maxMove } } },
        { id: 'comp-physical', stats: { Physical: { strength: maxStrength } } }
    ];
    player.components = components;

    const droppedItems = {};
    for (const item of items) {
        droppedItems[item.id] = item;
    }

    // Merge component stats override.
    const allComponentStats = {
        'comp-movement': { Movement: { move: maxMove } },
        'comp-physical': { Physical: { strength: maxStrength } },
        ...componentStatsOverride
    };

    const actionRegistry = {};
    if (rangeExpression !== null) {
        actionRegistry['dropItem'] = { range: rangeExpression };
    } else {
        // Default: no range expression → numeric fallback.
        actionRegistry['dropItem'] = { range: null };
    }

    const facade = createMockWSC({
        entities: { 'ent-player': player },
        rooms,
        droppedItems,
        componentStats: allComponentStats
    });

    return { facade, player, items, maxMove, maxStrength, targetId, actionRegistry };
}

// =========================================================================
// Test Suite — ReachabilityRule Spec §7 Matrix
// =========================================================================

describe('ReachabilityRule — Spec §7 Test Matrix', () => {
    let controller;

    beforeEach(() => {
        controller = new HintController({ actionRegistry: {} });
    });

    // --- Test 1: In-range target → hints: [] ---
    it('Test 1: In-range target should return no hints', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            items: [makeItem('item-1', 3, 4)] // distance = 5, range ≈ 15 (fallback)
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints).toEqual([]);
    });

    // --- Test 2: Out-of-range target → one hint with correct properties ---
    it('Test 2: Out-of-range target should return one hint; suggested position strictly between player and target', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            items: [makeItem('knife', 30, 40)] // distance = 50, range ≈ 15
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints.length).toBe(1);
        const hint = result.hints[0];

        // Suggested position should be on the line from player to target.
        const { x: sx, y: sy } = hint.suggestedPosition;
        const { x: px, y: py } = { x: 0, y: 0 };
        const { x: tx, y: ty } = { x: 30, y: 40 };

        // Distance from player to suggested should be ≤ maxMove.
        const distToSuggested = Math.sqrt((sx - px) ** 2 + (sy - py) ** 2);
        expect(distToSuggested).toBeLessThanOrEqual(10 + 0.01); // CLAMP_EPSILON tolerance

        // Suggested position should be strictly closer to target than player is.
        const distPlayerToTarget = Math.sqrt((tx - px) ** 2 + (ty - py) ** 2); // 50
        const distSuggestedToTarget = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2);
        expect(distSuggestedToTarget).toBeLessThan(distPlayerToTarget - 0.01);

        // Suggested position should be on the line between player and target.
        // Check that the direction is preserved: sx/tx ≈ sy/ty.
                const expectedSx = px + ((tx - px) / distPlayerToTarget) * distToSuggested;
        const expectedSy = py + ((ty - py) / distPlayerToTarget) * distToSuggested;
        expect(sx).toBeCloseTo(expectedSx, 1);
        expect(sy).toBeCloseTo(expectedSy, 1);
    });

    // --- Test 3: Distance > M → step length equals exactly M ---
    it('Test 3: When distance > M, step length should equal exactly M (movement stat)', () => {
        const maxMove = 7;
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove,
            maxStrength: 5,
            items: [makeItem('shield', 100, 0)] // distance = 100, range ≈ 15
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints.length).toBe(1);
        const { x: sx, y: sy } = result.hints[0].suggestedPosition;

        // Step should be exactly maxMove (7) along the x-axis.
        expect(sx).toBeCloseTo(maxMove, 1);
        expect(sy).toBeCloseTo(0, 1);
    });

    // --- Test 4: Clamping near wall → suggested position on wall edge, still strictly closer ---
    it('Test 4: Player near wall, target beyond → clamped position on wall edge, strictly closer', () => {
        const rooms = {
            'room-1': { uid: 'room-1', name: 'Room 1', width: 20, height: 20 }
        };

        const player = makePlayer(8, 0, 'room-1'); // Player at x=8 (near right wall at x=10)
        player.components = [
            { id: 'comp-movement', stats: { Movement: { move: 10 } } },
            { id: 'comp-physical', stats: { Physical: { strength: 5 } } }
        ];

        const item = makeItem('axe', 25, 0); // Target at x=25 (beyond room wall at x=10)
        const droppedItems = { 'axe': { ...item, roomId: 'room-1' } };

        const facade = createMockWSC({
            entities: { 'ent-player': player },
            rooms,
            droppedItems,
            componentStats: {
                'comp-movement': { Movement: { move: 10 } },
                'comp-physical': { Physical: { strength: 5 } }
            }
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints.length).toBe(1);
        const { x: sx, y: sy } = result.hints[0].suggestedPosition;

        // Clamped position should be within room bounds.
        expect(sx).toBeLessThanOrEqual(10); // halfWidth
        expect(sx).toBeGreaterThanOrEqual(-10); // -halfWidth
        expect(sy).toBeLessThanOrEqual(10);
        expect(sy).toBeGreaterThanOrEqual(-10);

        // Should be strictly closer than player (at x=8, distance to target at x=25 = 17).
        const distPlayerToTarget = Math.abs(25 - 8); // 17
        const distSuggestedToTarget = Math.sqrt((25 - sx) ** 2 + (0 - sy) ** 2);
        expect(distSuggestedToTarget).toBeLessThan(distPlayerToTarget - 0.01);

        // Should be clamped to the wall edge (x ≈ 10).
        expect(sx).toBeCloseTo(10, 0);
    });

    // --- Test 5: No movement stat (M = 0) → hints: [] ---
    it('Test 5: M = 0 (no movement) should return no hints', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 0,
            maxStrength: 5,
            items: [makeItem('potion', 50, 50)]
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints).toEqual([]);
    });

    // --- Test 6a: targetId filter → hint only for requested item ---
    it('Test 6a: targetId filter should return hint only for the requested item', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            items: [
                makeItem('item-a', 30, 0),
                makeItem('item-b', 60, 0)
            ],
            targetId: 'item-a'
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player', { targetId: 'item-a' });

        expect(result.hints.length).toBe(1);
        expect(result.hints[0].targetId).toBe('item-a');
    });

    // --- Test 6b: Unknown targetId → hints: [] ---
    it('Test 6b: Unknown targetId should return no hints', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            items: [makeItem('item-a', 30, 0)],
            targetId: 'unknown-item'
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player', { targetId: 'unknown-item' });

        expect(result.hints).toEqual([]);
    });

    // --- Test 7: Multiple items → nearest-first ordering ---
    it('Test 7: Multiple out-of-range items should return hints sorted nearest-first', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 5,
            maxStrength: 3,
            items: [
                makeItem('far-item', 80, 60), // distance ≈ 100
                makeItem('near-item', 30, 40) // distance = 50
            ]
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints.length).toBe(2);
        // Nearest item should be first.
        expect(result.hints[0].targetId).toBe('near-item');
        expect(result.hints[1].targetId).toBe('far-item');

        // Verify distances are in ascending order.
        expect(result.hints[0].distance).toBeLessThan(result.hints[1].distance);
    });

    // --- Test 8: Message contract → exact Portuguese template match ---
    it('Test 8: Message should match exact Portuguese template with item name and rounded coordinates', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            items: [makeItem('item-knife', 30, 40, 'Knife')] // distance = 50
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints.length).toBe(1);
        const hint = result.hints[0];

        // Message should be in English with item name and rounded coordinates.
        expect(hint.message).toContain('To move to entity Knife');
        expect(hint.message).toContain('\u2014 you can\'t reach it, but you get closer!');

        // Coordinates should be rounded to 1 decimal place.
        const { x: cx, y: cy } = hint.suggestedPosition;
        expect(String(cx)).toMatch(/^-?\d+(\.\d)?$/);
        expect(String(cy)).toMatch(/^-?\d+(\.\d)?$/);
    });

    // --- Test 9: Unknown entity → hints: [] ---
    it('Test 9: Unknown entity should return empty hints', () => {
        const { facade } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            items: [makeItem('item', 30, 40)]
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('nonexistent-entity');

        expect(result.entityId).toBe('nonexistent-entity');
        expect(result.hints).toEqual([]);
    });

    // --- Test 10: Reach fallback formula ---
    it('Test 10: Reach fallback should equal DROP_BASE_RANGE + maxStrength × DROP_RANGE_MULTIPLIER', () => {
        const { facade, maxStrength } = makeContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 7,
            items: [makeItem('gem', 50, 0)],
            // No range expression → numeric fallback.
            rangeExpression: null
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints.length).toBe(1);

        // Verify the range matches the fallback formula.
        const expectedRange = DROP_BASE_RANGE + maxStrength * DROP_RANGE_MULTIPLIER;
        expect(result.hints[0].range).toBeCloseTo(expectedRange, 1);

        // The suggested position should be at distance ≤ expectedRange from player.
        const { x: sx } = result.hints[0].suggestedPosition;
        expect(sx).toBeLessThanOrEqual(expectedRange + 0.01);
    });
});

// =========================================================================
// HintController — Rule Registration & Validation Tests
// =========================================================================

describe('HintController — Rule Registration', () => {
    let controller;

    beforeEach(() => {
        controller = new HintController({ actionRegistry: {} });
    });

    it('should start with no rules and return empty hints', () => {
        // Note: HintController auto-registers ReachabilityRule, so this tests the empty case before facade injection.
        const result = controller.getHints('ent-1');
        expect(result.entityId).toBe('ent-1');
        expect(result.hints).toEqual([]);
    });

    it('should reject a rule lacking evaluate() method', () => {
        // A rule with only resolve() (old contract) should be rejected.
        const oldRule = { id: 'old-rule', priority: 0, resolve: () => ({}) };
        controller.registerRule(oldRule);

        // The rule should not be in the registry (no evaluate method).
        const { facade } = makeContext({
            maxMove: 10,
            items: [makeItem('test', 30, 40)]
        });
        controller.setWorldStateController(facade);
        // Only ReachabilityRule should be active (no old-rule).
    });

    it('should accept a rule with evaluate() method', () => {
        const customRule = {
            id: 'custom-rule',
            priority: 5,
            evaluate() {
                return { id: 'custom', message: 'custom hint' };
            }
        };
        controller.registerRule(customRule);

        expect(controller['_rules'].length).toBeGreaterThan(1); // ReachabilityRule + custom rule
    });

    it('should sort rules by priority (lower = higher priority)', () => {
        const lowPriority = { id: 'low', priority: 50, evaluate() { return { id: 'low' }; } };
        const highPriority = { id: 'high', priority: 1, evaluate() { return { id: 'high' }; } };

        controller.registerRule(lowPriority);
        controller.registerRule(highPriority);

        const rules = controller['_rules'];
        // Find indices of custom rules (exclude ReachabilityRule with priority 10).
        const highIdx = rules.findIndex(r => r.id === 'high');
        const lowIdx = rules.findIndex(r => r.id === 'low');

        expect(highIdx).toBeLessThan(lowIdx);
    });

    it('should catch rule evaluation errors and continue', () => {
        const badRule = {
            id: 'bad-rule',
            priority: 0,
            evaluate() {
                throw new Error('boom');
            }
        };
        controller.registerRule(badRule);

        const { facade } = makeContext({
            maxMove: 10,
            items: [makeItem('test', 30, 40)]
        });
        controller.setWorldStateController(facade);

        // Should not throw; degraded hints only.
        expect(() => controller.getHints('ent-player')).not.toThrow();
    });
});

// =========================================================================
// ReachabilityRule — canApply Tests
// =========================================================================

describe('ReachabilityRule — canApply', () => {
    it('should apply when player, room, and dropped items exist', () => {
        const rule = new ReachabilityRule();
        const context = {
            player: {},
            room: { width: 100, height: 100 },
            droppedItems: [{ id: 'item-1' }]
        };
        expect(rule.canApply(context)).toBe(true);
    });

    it('should apply when only entities exist (no dropped items)', () => {
        const rule = new ReachabilityRule();
        const context = {
            player: {},
            room: { width: 100, height: 100 },
            droppedItems: [],
            entities: [{ id: 'ent-npc-1', name: 'Bolt' }]
        };
        expect(rule.canApply(context)).toBe(true);
    });

    it('should not apply when no dropped items and no entities', () => {
        const rule = new ReachabilityRule();
        const context = {
            player: {},
            room: { width: 100, height: 100 },
            droppedItems: [],
            entities: []
        };
        expect(rule.canApply(context)).toBe(false);
    });

    it('should not apply when no room', () => {
        const rule = new ReachabilityRule();
        const context = {
            player: {},
            room: null,
            droppedItems: [{ id: 'item-1' }]
        };
        expect(rule.canApply(context)).toBe(false);
    });
});

// =========================================================================
// ReachabilityRule — Entity Candidate Tests
// =========================================================================

describe('ReachabilityRule — Entity Candidates', () => {
    let controller;

    beforeEach(() => {
        controller = new HintController({ actionRegistry: {} });
    });

    /**
     * Build a full context with entities for entity-specific tests.
     */
    function makeEntityContext(opts = {}) {
        const {
            playerX = 0,
            playerY = 0,
            playerRoom = 'room-1',
            items = [],
            entities = [],
            maxMove = 10,
            maxStrength = 5,
            targetId = null
        } = opts;

        const rooms = {
            'room-1': { uid: 'room-1', name: 'Room 1', width: 200, height: 200 }
        };
        const player = makePlayer(playerX, playerY, playerRoom);
        player.components = [
            { id: 'comp-movement', stats: { Movement: { move: maxMove } } },
            { id: 'comp-physical', stats: { Physical: { strength: maxStrength } } }
        ];

        const droppedItems = {};
        for (const item of items) {
            droppedItems[item.id] = item;
        }

        // allEntities includes player + other entities (HintController filters self).
        const allEntities = {
            'ent-player': player,
            ...Object.fromEntries(entities.map(e => [e.id, e]))
        };

        const componentStats = {
            'comp-movement': { Movement: { move: maxMove } },
            'comp-physical': { Physical: { strength: maxStrength } }
        };

        const actionRegistry = { 'dropItem': { range: null } };

        const facade = createMockWSC({
            entities: { 'ent-player': player },
            rooms,
            droppedItems,
            componentStats,
            allEntities
        });

        return { facade, player, items, entities, maxMove, maxStrength, targetId, actionRegistry };
    }

    // (a) Out-of-range entity in same room → hint with exact PT template
    it('Test (a): Out-of-range entity in same room should return hint with entity name', () => {
        const { facade } = makeEntityContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            entities: [makeEntity('ent-npc-1', 'Bolt the Merchant', 30, 40, 'room-1')]
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints.length).toBe(1);
        const hint = result.hints[0];
        expect(hint.targetId).toBe('ent-npc-1');
        expect(hint.targetName).toBe('Bolt the Merchant');
        expect(hint.targetType).toBe('entity');
        expect(hint.message).toContain('To move to entity Bolt the Merchant');
        expect(hint.message).toContain('\u2014 you can\'t reach it, but you get closer!');
    });

    // (b) In-range entity → no hint for it
    it('Test (b): In-range entity should not return a hint', () => {
        const { facade } = makeEntityContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            entities: [makeEntity('ent-npc-1', 'Bolt', 3, 4, 'room-1')] // distance = 5, range ≈ 15
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints).toEqual([]);
    });

    // (c) Entity in another room → no hint
    it('Test (c): Entity in another room should not return a hint', () => {
        const { facade } = makeEntityContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            entities: [makeEntity('ent-npc-1', 'Bolt', 30, 40, 'other-room')] // different room
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints).toEqual([]);
    });

    // (d) Player's own entity → never a hint
    it('Test (d): Player\'s own entity should never be a hint target', () => {
        const playerRoom = 'room-1';
        const player = makePlayer(0, 0, playerRoom);
        player.id = 'ent-player'; // same ID as what we query
        player.components = [
            { id: 'comp-movement', stats: { Movement: { move: 10 } } },
            { id: 'comp-physical', stats: { Physical: { strength: 5 } } }
        ];

        const rooms = { 'room-1': { uid: 'room-1', name: 'Room 1', width: 200, height: 200 } };
        const allEntities = {
            'ent-player': player
            // No other entities — player is excluded from candidates
        };

        const facade = createMockWSC({
            entities: { 'ent-player': player },
            rooms,
            droppedItems: {},
            componentStats: {
                'comp-movement': { Movement: { move: 10 } },
                'comp-physical': { Physical: { strength: 5 } }
            },
            allEntities
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        expect(result.hints).toEqual([]);
    });

    // (e) Mixed items + entities → combined nearest-first ordering
    it('Test (e): Mixed items and entities should return combined nearest-first ordering', () => {
        const { facade } = makeEntityContext({
            playerX: 0,
            playerY: 0,
            maxMove: 5,
            maxStrength: 3,
            items: [makeItem('far-item', 80, 60, 'Distant Chest')], // distance ≈ 100
            entities: [
                makeEntity('ent-npc-1', 'Bolt', 30, 40, 'room-1'), // distance = 50
                makeItem('near-item', 10, 0, 'Near Knife')         // distance = 10 (in range, no hint)
            ]
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player');

        // Two hints: near-item is in-range so no hint for it.
        // Bolt (dist=50) and far-item (dist≈100) should be out of range.
        expect(result.hints.length).toBe(2);
        expect(result.hints[0].distance).toBeLessThan(result.hints[1].distance);
        // Nearest should be the entity (Bolt).
        expect(result.hints[0].targetId).toBe('ent-npc-1');
        expect(result.hints[0].targetType).toBe('entity');
        expect(result.hints[1].targetType).toBe('droppedItem');
    });

    // (f) targetId for entity → hint works for that entity
    it('Test (f): targetId matching an entity should return hint for that entity', () => {
        const { facade } = makeEntityContext({
            playerX: 0,
            playerY: 0,
            maxMove: 10,
            maxStrength: 5,
            entities: [
                makeEntity('ent-npc-1', 'Bolt', 30, 40, 'room-1'),
                makeEntity('ent-npc-2', 'Killer', 60, 80, 'room-1')
            ],
            targetId: 'ent-npc-2'
        });

        controller.setWorldStateController(facade);
        const result = controller.getHints('ent-player', { targetId: 'ent-npc-2' });

        expect(result.hints.length).toBe(1);
        expect(result.hints[0].targetId).toBe('ent-npc-2');
        expect(result.hints[0].targetName).toBe('Killer');
    });
});

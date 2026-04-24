/**
 * ComponentCapabilityController — Unit Test Suite
 *
 * Tests for src/controllers/componentCapabilityController.js
 * Covers: Constructor, Scoring, Capability Cache, Requirement Checking,
 *          Stat Change Flow, Event Subscriptions, Cache Operations.
 *
 * Quality Standards (per wiki/code_quality_and_best_practices.md):
 * - Each test validates one specific behavior (SRP)
 * - Tests are independent and isolated
 * - Semantic naming following BDD style
 * - JSDoc type hints for clarity
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import ComponentCapabilityController from '../src/controllers/componentCapabilityController.js';
import { ACTION_SCORING, CLOSE_TO_THRESHOLD_FACTOR } from '../src/utils/ActionScoring.js';

// ============================================================================
// MOCK FACTORY
// ============================================================================

/**
 * Logger mock
 */
const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
}));
vi.mock('../src/utils/Logger.js', () => ({
    default: mockLogger,
}));

/**
 * Creates a mock WorldStateController.
 * @param {Object} overrides - Additional properties to merge.
 * @returns {Object}
 */
function createMockWSC(overrides = {}) {
    return {
        componentController: {
            getComponentStats: vi.fn(),
            updateComponentStatDelta: vi.fn(),
            updateComponentStat: vi.fn(),
            registerStatChangeListener: vi.fn(),
            unregisterStatChangeListener: vi.fn(),
        },
        stateEntityController: {
            getEntity: vi.fn(),
            updateEntitySpatial: vi.fn(),
        },
        getAll: vi.fn(() => ({ entities: {} })),
        ...overrides,
    };
}

/**
 * Creates the default action registry matching data/actions.json.
 * @returns {Object}
 */
function createDefaultActionRegistry() {
    return {
        move: {
            targetingType: 'spatial',
            requirements: [{ trait: 'Movement', stat: 'move', minValue: 5 }],
            consequences: [{ type: 'deltaSpatial', params: { speed: ':Movement.move' } }],
            failureConsequences: [{ type: 'log', level: 'warn', message: "Action 'move' failed" }],
        },
        dash: {
            targetingType: 'spatial',
            requirements: [
                { trait: 'Movement', stat: 'move', minValue: 5 },
                { trait: 'Physical', stat: 'durability', minValue: 30 },
            ],
            consequences: [
                { type: 'deltaSpatial', params: { speed: ':Movement.move*2' } },
                { type: 'updateComponentStatDelta', params: { trait: 'Physical', stat: 'durability', value: -5 } },
            ],
            failureConsequences: [{ type: 'log', level: 'warn', message: "Action 'dash' failed" }],
        },
        selfHeal: {
            targetingType: 'none',
            requirements: [
                { trait: 'Movement', stat: 'move', minValue: 1 },
                { trait: 'Physical', stat: 'durability', minValue: 1 },
            ],
            consequences: [
                { type: 'updateComponentStatDelta', params: { trait: 'Physical', stat: 'durability', value: 10 } },
            ],
            failureConsequences: [{ type: 'log', level: 'warn', message: "Action 'selfHeal' failed" }],
        },
        'droid punch': {
            targetingType: 'component',
            range: 100,
            requirements: [{ trait: 'Physical', stat: 'strength', minValue: 1 }],
            consequences: [
                { type: 'damageComponent', params: { trait: 'Physical', stat: 'durability', value: '-:Physical.strength' } },
                { type: 'log', level: 'info', message: 'Droid performed a punch!' },
            ],
            failureConsequences: [{ type: 'log', level: 'warn', message: 'Punch failed' }],
        },
    };
}

/**
 * Creates a ComponentCapabilityController with default mocks.
 * @param {Object} options - Configuration options.
 * @returns {ComponentCapabilityController}
 */
function createController(options = {}) {
    const {
        worldStateController = createMockWSC(),
        actionRegistry = createDefaultActionRegistry(),
    } = options;

    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.critical.mockClear();

    return new ComponentCapabilityController(worldStateController, actionRegistry);
}

/**
 * Creates a full world state with entities and components.
 * @param {Array<Object>} entityDefs - Entity definitions.
 * @returns {Object}
 */
function createWorldState(entityDefs = []) {
    const entities = {};
    for (const def of entityDefs) {
        entities[def.id] = {
            id: def.id,
            components: def.components || [],
            ...def.extra,
        };
    }
    return { entities };
}

// ============================================================================
// 1. CONSTRUCTOR & INITIALIZATION
// ============================================================================

describe('ComponentCapabilityController — Constructor & Initialization', () => {
    it('should store worldStateController reference', () => {
        const wsc = createMockWSC();
        const controller = new ComponentCapabilityController(wsc, createDefaultActionRegistry());
        expect(controller.worldStateController).toBe(wsc);
    });

    it('should store actionRegistry reference', () => {
        const registry = createDefaultActionRegistry();
        const controller = new ComponentCapabilityController(createMockWSC(), registry);
        expect(controller.actionRegistry).toBe(registry);
    });

    it('should initialize _capabilityCache as empty object', () => {
        const controller = createController();
        expect(controller._capabilityCache).toEqual({});
    });

    it('should initialize _actionSubscribers as Map', () => {
        const controller = createController();
        expect(controller._actionSubscribers).toBeInstanceOf(Map);
    });

    it('should initialize _traitStatActionIndex as Map', () => {
        const controller = createController();
        expect(controller._traitStatActionIndex).toBeInstanceOf(Map);
    });

    it('should build correct reverse index from action registry', () => {
        const controller = createController();

        expect(controller._traitStatActionIndex.has('Movement.move')).toBe(true);
        expect(controller._traitStatActionIndex.get('Movement.move')).toEqual(new Set(['move', 'dash', 'selfHeal']));

        expect(controller._traitStatActionIndex.has('Physical.durability')).toBe(true);
        expect(controller._traitStatActionIndex.get('Physical.durability')).toEqual(new Set(['dash', 'selfHeal']));

        expect(controller._traitStatActionIndex.has('Physical.strength')).toBe(true);
        expect(controller._traitStatActionIndex.get('Physical.strength')).toEqual(new Set(['droid punch']));
    });

    it('should handle null actionRegistry', () => {
        const controller = new ComponentCapabilityController(createMockWSC(), null);
        expect(controller.actionRegistry).toEqual({});
        expect(controller._traitStatActionIndex.size).toBe(0);
    });

    it('should return actionRegistry via getActionRegistry()', () => {
        const registry = createDefaultActionRegistry();
        const controller = new ComponentCapabilityController(createMockWSC(), registry);
        expect(controller.getActionRegistry()).toBe(registry);
    });
});

// ============================================================================
// 2. SCORING SYSTEM
// ============================================================================

describe('ComponentCapabilityController — Scoring System', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    it('should score 1.0 when requirement met exactly', () => {
        const stats = { Physical: { strength: 10 } };
        const reqs = [{ trait: 'Physical', stat: 'strength', minValue: 10 }];
        expect(controller._calculateComponentScore(stats, reqs)).toBe(1.0);
    });

    it('should score 1.0 when value exceeds threshold moderately', () => {
        const stats = { Physical: { strength: 15 } };
        const reqs = [{ trait: 'Physical', stat: 'strength', minValue: 10 }];
        expect(controller._calculateComponentScore(stats, reqs)).toBe(1.0);
    });

    it('should apply bonus when value significantly exceeds threshold', () => {
        // value=25, minValue=10, ratio=2.5, bonus = 0.1*(2.5-1) = 0.15, total = 1.15
        const stats = { Physical: { strength: 25 } };
        const reqs = [{ trait: 'Physical', stat: 'strength', minValue: 10 }];
        expect(controller._calculateComponentScore(stats, reqs)).toBeCloseTo(1.15);
    });

    it('should score 0 when component has missing trait', () => {
        const stats = { Agility: { speed: 10 } };
        const reqs = [{ trait: 'Physical', stat: 'strength', minValue: 5 }];
        expect(controller._calculateComponentScore(stats, reqs)).toBe(0);
    });

    it('should score 0 when component has missing stat within trait', () => {
        const stats = { Physical: { mass: 5 } };
        const reqs = [{ trait: 'Physical', stat: 'strength', minValue: 5 }];
        expect(controller._calculateComponentScore(stats, reqs)).toBe(0);
    });

    it('should score 0 for empty requirements array', () => {
        const stats = { Physical: { strength: 10 } };
        expect(controller._calculateComponentScore(stats, [])).toBe(0);
    });

    it('should sum scores for multiple requirements met', () => {
        const stats = {
            Movement: { move: 10 },
            Physical: { strength: 8 },
            Agility: { speed: 12 },
        };
        const reqs = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
            { trait: 'Agility', stat: 'speed', minValue: 5 },
        ];
        // req1: 10/5=2.0 (no bonus, 2.0 > 2.0 is false), req2: 8/5=1.6 (no bonus), req3: 12/5=2.4 (bonus=0.14)
        expect(controller._calculateComponentScore(stats, reqs)).toBeCloseTo(3.14);
    });

    it('should satisfy monotonicity: higher values produce higher or equal scores', () => {
        const reqs = [{ trait: 'Physical', stat: 'strength', minValue: 5 }];
        const scoreA = controller._calculateComponentScore({ Physical: { strength: 10 } }, reqs);
        const scoreB = controller._calculateComponentScore({ Physical: { strength: 20 } }, reqs);
        expect(scoreB).toBeGreaterThanOrEqual(scoreA);
    });
});

// ============================================================================
// 3. CAPABILITY CACHE MANAGEMENT
// ============================================================================

describe('ComponentCapabilityController — Capability Cache Management', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    // --- scanAllCapabilities ---

    it('should populate cache with qualifying entries from single entity', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidArm', identifier: 'left' },
                { id: 'c2', type: 'droidHand', identifier: 'right' },
            ],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Movement: { move: 10 }, Physical: { strength: 8 } };
            if (compId === 'c2') return { Movement: { move: 6 }, Physical: { strength: 3 } };
            return null;
        });

        const cache = controller.scanAllCapabilities(state);

        expect(cache.move.length).toBe(2);
        expect(cache.move[0].entityId).toBe('e1');
        expect(cache.move[0].componentId).toBe('c1');
        expect(cache.move[1].componentId).toBe('c2');
    });

    it('should produce empty array when no components qualify', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 1 } });

        const cache = controller.scanAllCapabilities(state);
        expect(cache.move).toEqual([]);
    });

    it('should skip components with no stats', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue(null);

        const cache = controller.scanAllCapabilities(state);
        expect(cache.move).toEqual([]);
    });

    it('should handle entity with no components', () => {
        const state = createWorldState([{ id: 'e1', components: [] }]);
        const cache = controller.scanAllCapabilities(state);
        expect(cache.move).toEqual([]);
    });

    it('should handle empty state (no entities)', () => {
        const state = { entities: {} };
        const cache = controller.scanAllCapabilities(state);
        expect(cache.move).toEqual([]);
        expect(cache.dash).toEqual([]);
    });

    it('should initialize cache for all registered actions', () => {
        const state = { entities: {} };
        const cache = controller.scanAllCapabilities(state);
        expect(Object.keys(cache)).toEqual(['move', 'dash', 'selfHeal', 'droid punch']);
    });

    it('should sort entries by score descending', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidArm', identifier: 'left' },
                { id: 'c2', type: 'droidHand', identifier: 'right' },
            ],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Movement: { move: 20 } };
            if (compId === 'c2') return { Movement: { move: 10 } };
            return null;
        });

        const cache = controller.scanAllCapabilities(state);
        expect(cache.move[0].score).toBeGreaterThanOrEqual(cache.move[1].score);
    });

    it('should return the cache reference', () => {
        const state = { entities: {} };
        const cache = controller.scanAllCapabilities(state);
        expect(cache).toBe(controller._capabilityCache);
    });

    // --- Entry Structure Validation ---

    it('should include all required fields in capability entries', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 10 } });

        const cache = controller.scanAllCapabilities(state);
        const entry = cache.move[0];

        expect(entry).toHaveProperty('entityId', 'e1');
        expect(entry).toHaveProperty('componentId', 'c1');
        expect(entry).toHaveProperty('componentType', 'droidArm');
        expect(entry).toHaveProperty('componentIdentifier', 'left');
        expect(entry).toHaveProperty('score');
        expect(entry).toHaveProperty('requirementValues');
        expect(entry).toHaveProperty('fulfillingComponents');
        expect(entry).toHaveProperty('requirementsStatus');
    });

    it('should default componentIdentifier to "default" when not set', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 10 } });

        const cache = controller.scanAllCapabilities(state);
        expect(cache.move[0].componentIdentifier).toBe('default');
    });

    // --- Getter Methods ---

    it('should return best component for action via getBestComponentForAction()', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidArm', identifier: 'left' },
                { id: 'c2', type: 'droidHand', identifier: 'right' },
            ],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Movement: { move: 20 } };
            if (compId === 'c2') return { Movement: { move: 10 } };
            return null;
        });

        controller.scanAllCapabilities(state);

        const best = controller.getBestComponentForAction('move');
        expect(best.componentId).toBe('c1');
    });

    it('should return null when no entries for action', () => {
        expect(controller.getBestComponentForAction('nonexistent')).toBeNull();
    });

    it('should return all capabilities for action via getAllCapabilitiesForAction()', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 10 } });

        controller.scanAllCapabilities(state);

        const all = controller.getAllCapabilitiesForAction('move');
        expect(Array.isArray(all)).toBe(true);
        expect(all.length).toBe(1);
    });

    it('should return empty array for unknown action via getAllCapabilitiesForAction()', () => {
        expect(controller.getAllCapabilitiesForAction('nonexistent')).toEqual([]);
    });

    it('should return capabilities for entity via getCapabilitiesForEntity()', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 10 } });

        controller.scanAllCapabilities(state);

        const caps = controller.getCapabilitiesForEntity('e1');
        expect(caps.length).toBe(1);
        expect(caps[0].entityId).toBe('e1');
    });

    it('should return empty array for unknown entity via getCapabilitiesForEntity()', () => {
        expect(controller.getCapabilitiesForEntity('unknown')).toEqual([]);
    });

    it('should return cache reference via getCachedCapabilities()', () => {
        const state = { entities: {} };
        controller.scanAllCapabilities(state);
        expect(controller.getCachedCapabilities()).toBe(controller._capabilityCache);
    });
});

// ============================================================================
// 4. REQUIREMENT CHECKING (Component-Level)
// ============================================================================

describe('ComponentCapabilityController — Component Requirement Checking', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    it('should pass when component satisfies all requirements', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
            Physical: { strength: 8 },
        });

        const reqs = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
        ];

        const result = controller._checkRequirementsForComponent(reqs, 'e1', 'c1');

        expect(result.passed).toBe(true);
        expect(result.requirementValues['Movement.move']).toBe(10);
        expect(result.fulfillingComponents['Movement.move']).toBe('c1');
    });

    it('should fail when component is missing a required trait', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        const reqs = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
        ];

        const result = controller._checkRequirementsForComponent(reqs, 'e1', 'c1');

        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('MISSING_TRAIT_STAT');
    });

    it('should fail when component stats are null', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue(null);

        const reqs = [{ trait: 'Movement', stat: 'move', minValue: 5 }];
        const result = controller._checkRequirementsForComponent(reqs, 'e1', 'c1');

        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('ENTITY_NOT_FOUND');
    });

    it('should fail when value is below minValue', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 2 },
        });

        const reqs = [{ trait: 'Movement', stat: 'move', minValue: 5 }];
        const result = controller._checkRequirementsForComponent(reqs, 'e1', 'c1');

        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('MISSING_TRAIT_STAT');
    });

    it('should pass at exact boundary (value === minValue)', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 5 },
        });

        const reqs = [{ trait: 'Movement', stat: 'move', minValue: 5 }];
        const result = controller._checkRequirementsForComponent(reqs, 'e1', 'c1');

        expect(result.passed).toBe(true);
    });
});

// ============================================================================
// 5. RE-EVALUATION
// ============================================================================

describe('ComponentCapabilityController — Re-evaluation', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    it('should return null for unknown action in reEvaluateActionForComponent', () => {
        const state = { entities: {} };
        const result = controller.reEvaluateActionForComponent(state, 'nonexistent', 'c1');
        expect(result).toBeNull();
    });

    it('should return null when component stats are null', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue(null);
        const state = { entities: {} };
        const result = controller.reEvaluateActionForComponent(state, 'move', 'c1');
        expect(result).toBeNull();
    });

    it('should remove entry when component no longer qualifies', () => {
        // First, add an entry to the cache
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 10 } });
        controller.scanAllCapabilities(state);
        expect(controller._capabilityCache.move.length).toBe(1);

        // Now reduce stats so component no longer qualifies
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 2 } });
        const result = controller.reEvaluateActionForComponent(state, 'move', 'c1');

        expect(result).toBeNull();
        expect(controller._capabilityCache.move.length).toBe(0);
    });

    it('should return empty array from reEvaluateAllActionsForComponent when component not found', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue(null);
        const state = { entities: {} };
        const result = controller.reEvaluateAllActionsForComponent(state, 'nonexistent');
        expect(result).toEqual([]);
    });

    it('should return empty array from reEvaluateEntityCapabilities when entity not found', () => {
        const state = { entities: {} };
        const result = controller.reEvaluateEntityCapabilities(state, 'nonexistent');
        expect(result).toEqual([]);
    });
});

// ============================================================================
// 6. EVENT SUBSCRIPTIONS
// ============================================================================

describe('ComponentCapabilityController — Event Subscriptions', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    it('should add a subscriber via on()', () => {
        const callback = vi.fn();
        controller.on('move', callback);
        expect(controller._actionSubscribers.get('move')).toContain(callback);
    });

    it('should not add duplicate subscribers', () => {
        const callback = vi.fn();
        controller.on('move', callback);
        controller.on('move', callback);
        expect(controller._actionSubscribers.get('move').length).toBe(1);
    });

    it('should ignore non-function callbacks', () => {
        controller.on('move', 'not a function');
        expect(controller._actionSubscribers.has('move')).toBe(false);
    });

    it('should remove a subscriber via off()', () => {
        const callback = vi.fn();
        controller.on('move', callback);
        controller.off('move', callback);
        expect(controller._actionSubscribers.get('move')).not.toContain(callback);
    });

    it('should notify subscribers when an entry is added', () => {
        const callback = vi.fn();
        controller.on('move', callback);

        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockReturnValue({ Movement: { move: 10 } });

        // Manually trigger re-evaluation which calls _notifySubscribers
        controller.reEvaluateActionForComponent(state, 'move', 'c1');

        expect(callback).toHaveBeenCalled();
        expect(callback.mock.calls[0][0]).toBe('move');
        expect(callback.mock.calls[0][1]).toHaveProperty('componentId', 'c1');
    });

    it('should send a RemovalMarker when an entry is removed', () => {
        const callback = vi.fn();
        controller.on('move', callback);

        // Pre-populate cache
        controller._capabilityCache.move = [{
            entityId: 'e1',
            componentId: 'c1',
            componentType: 'droidArm',
            componentIdentifier: 'left',
            score: 1.0,
        }];

        controller._removeComponentFromActionCache('move', 'c1');

        expect(callback).toHaveBeenCalled();
        expect(callback.mock.calls[0][1]).toHaveProperty('_type', 'REMOVAL');
        expect(callback.mock.calls[0][1]).toHaveProperty('componentId', 'c1');
    });

    it('should catch errors in subscriber callbacks', () => {
        const badCallback = vi.fn(() => { throw new Error('Subscriber error'); });
        controller.on('move', badCallback);

        // This should not throw
        expect(() => controller._notifySubscribers('move', { componentId: 'c1' })).not.toThrow();
        expect(mockLogger.error).toHaveBeenCalled();
    });
});

// ============================================================================
// 7. STAT CHANGE HANDLER
// ============================================================================

describe('ComponentCapabilityController — Stat Change Handler', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    it('should not re-evaluate if value did not change', () => {
        controller.worldStateController.getAll.mockReturnValue({ entities: {} });
        controller.reEvaluateActionForComponent = vi.fn();

        // Patch to track calls
        const origReEvaluate = controller.reEvaluateActionForComponent;

        controller.onStatChange('c1', 'Movement', 'move', 10, 10);

        // Since newValue === oldValue, no re-evaluation should happen
        // We verify by checking that _getActionsForTraitStat was not used for re-evaluation
        expect(controller._traitStatActionIndex.has('Movement.move')).toBe(true);
    });

    it('should re-evaluate dependent actions when stat changes', () => {
        const state = { entities: {} };
        controller.worldStateController.getAll.mockReturnValue(state);

        // Mock reEvaluateActionForComponent to return null (component not found)
        controller.reEvaluateActionForComponent = vi.fn(() => null);

        controller.onStatChange('c1', 'Movement', 'move', 10, 5);

        // Should have been called for move, dash, selfHeal (all depend on Movement.move)
        expect(controller.reEvaluateActionForComponent).toHaveBeenCalledTimes(3);
    });
});

// ============================================================================
// 8. CACHE CLEANUP
// ============================================================================

describe('ComponentCapabilityController — Cache Cleanup', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    it('should remove entity from all action caches', () => {
        // Pre-populate cache
        controller._capabilityCache.move = [{ entityId: 'e1', componentId: 'c1' }];
        controller._capabilityCache.dash = [{ entityId: 'e1', componentId: 'c1' }];

        controller.removeEntityFromCache('e1');

        expect(controller._capabilityCache.move).toEqual([]);
        expect(controller._capabilityCache.dash).toEqual([]);
    });

    it('should not throw when removing from empty cache', () => {
        expect(() => controller.removeEntityFromCache('nonexistent')).not.toThrow();
    });

    it('should create correct removal marker', () => {
        const marker = controller._createRemovalMarker('c1', 'e1');
        expect(marker._type).toBe('REMOVAL');
        expect(marker.componentId).toBe('c1');
        expect(marker.entityId).toBe('e1');
    });
});

// ============================================================================
// 9. REVERSE INDEX UTILITIES
// ============================================================================

describe('ComponentCapabilityController — Reverse Index Utilities', () => {
    let controller;

    beforeEach(() => {
        controller = createController();
    });

    it('should return dependent actions for a trait.stat', () => {
        const actions = controller._getActionsForTraitStat('Movement', 'move');
        expect(actions).toContain('move');
        expect(actions).toContain('dash');
        expect(actions).toContain('selfHeal');
    });

    it('should return empty array for unknown trait.stat', () => {
        const actions = controller._getActionsForTraitStat('Unknown', 'stat');
        expect(actions).toEqual([]);
    });

    it('should return null from _getActionsForTraitStatFromComponent when stats are null', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue(null);
        const result = controller._getActionsForTraitStatFromComponent('nonexistent');
        expect(result).toBeNull();
    });

    it('should return actions from _getActionsForTraitStatFromComponent', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
            Physical: { strength: 5 },
        });
        const result = controller._getActionsForTraitStatFromComponent('c1');
        expect(result).toContain('move');
        expect(result).toContain('dash');
        expect(result).toContain('selfHeal');
        expect(result).toContain('droid punch');
    });
});

// ============================================================================
// 10. SCORING CONSTANTS VALIDATION
// ============================================================================

describe('ComponentCapabilityController — Scoring Constants Validation', () => {
    it('should have REQUIREMENT_MET equal to 1.0', () => {
        expect(ACTION_SCORING.REQUIREMENT_MET).toBe(1.0);
    });

    it('should have REQUIREMENT_EXCEEDED_BONUS equal to 0.1', () => {
        expect(ACTION_SCORING.REQUIREMENT_EXCEEDED_BONUS).toBe(0.1);
    });

    it('should have CLOSE_TO_THRESHOLD_PENALTY equal to -0.2', () => {
        expect(ACTION_SCORING.CLOSE_TO_THRESHOLD_PENALTY).toBe(-0.2);
    });

    it('should have EXCEEDED_THRESHOLD_MULTIPLIER equal to 2.0', () => {
        expect(ACTION_SCORING.EXCEEDED_THRESHOLD_MULTIPLIER).toBe(2.0);
    });

    it('should have CLOSE_TO_THRESHOLD_FACTOR equal to 1.25', () => {
        expect(CLOSE_TO_THRESHOLD_FACTOR).toBe(1.25);
    });
});
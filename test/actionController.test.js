/**
 * ActionController — Unit Test Suite
 *
 * Tests for src/controllers/actionController.js
 *
 * ActionController responsibilities (after SRP split):
 * - Action execution (executeAction)
 * - Entity-level requirement validation (checkRequirements, _checkRequirements)
 * - Component-level requirement validation (_checkRequirementsForComponent)
 * - Consequence execution (_executeConsequences)
 * - Placeholder resolution (_resolvePlaceholders)
 * - Error resolution (_resolveError)
 * - Delegates capability cache queries to ComponentCapabilityController
 *
 * NOTE: Capability cache, scoring, event subscriptions, and re-evaluation
 * tests have been moved to test/componentCapabilityController.test.js
 *
 * Quality Standards (per wiki/code_quality_and_best_practices.md):
 * - Each test validates one specific behavior (SRP)
 * - Tests are independent and isolated
 * - Semantic naming following BDD style
 * - JSDoc type hints for clarity
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import ActionController from '../src/controllers/actions/actionController.js';
import { ACTION_SCORING, CLOSE_TO_THRESHOLD_FACTOR } from '../src/utils/ActionScoring.js';

// ============================================================================
// SCORING CONSTANTS VALIDATION
// ============================================================================

describe('ActionScoring Constants Validation', () => {
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

// ============================================================================
// MOCK FACTORY
// ============================================================================

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
        getAll: vi.fn(),
        ...overrides,
    };
}

/**
 * Creates a mock ConsequenceHandlers.
 * @param {Object} handlers - Custom handler functions.
 * @returns {Object}
 */
function createMockConsequenceHandlers(handlers = {}) {
    return {
        handlers: {
            updateSpatial: vi.fn((targetId, params, context) => ({ success: true, message: 'spatial updated', data: params })),
            deltaSpatial: vi.fn((targetId, params, context) => ({ success: true, message: 'spatial delta', data: params })),
            log: vi.fn((targetId, params, context) => ({ success: true, message: 'logged', data: params })),
            updateStat: vi.fn((targetId, params, context) => ({ success: true, message: 'stat updated', data: params })),
            updateComponentStatDelta: vi.fn((targetId, params, context) => ({ success: true, message: 'stat delta updated', data: params })),
            triggerEvent: vi.fn((targetId, params, context) => ({ success: true, message: 'event triggered', data: params })),
            damageComponent: vi.fn((targetId, params, context) => ({ success: true, message: 'damage dealt', data: params })),
            ...handlers,
        },
    };
}

/**
 * Creates a mock ComponentCapabilityController.
 * @param {Object} overrides - Additional methods to override.
 * @returns {Object}
 */
function createMockComponentCapabilityController(overrides = {}) {
    return {
        scanAllCapabilities: vi.fn(() => ({})),
        getCachedCapabilities: vi.fn(() => ({})),
        getBestComponentForAction: vi.fn(() => null),
        getAllCapabilitiesForAction: vi.fn(() => []),
        getCapabilitiesForEntity: vi.fn(() => []),
        getActionsForEntity: vi.fn(() => ({})),
        getActionCapabilities: vi.fn(() => ({})),
        reEvaluateEntityCapabilities: vi.fn(() => []),
        removeEntityFromCache: vi.fn(),
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
            failureConsequences: [{ type: 'log', level: 'warn', message: "Action 'move' failed - requirement not met" }],
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
            failureConsequences: [{ type: 'log', level: 'warn', message: "Action 'dash' failed - requirement not met" }],
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
            failureConsequences: [{ type: 'log', level: 'warn', message: "Action 'selfHeal' failed - requirement not met" }],
        },
        'droid punch': {
            targetingType: 'component',
            range: 100,
            requirements: [{ trait: 'Physical', stat: 'strength', minValue: 1 }],
            consequences: [
                { type: 'damageComponent', params: { trait: 'Physical', stat: 'durability', value: '-:Physical.strength' } },
                { type: 'log', level: 'info', message: 'Droid performed a punch dealing :Physical.strength damage!' },
            ],
            failureConsequences: [{ type: 'log', level: 'warn', message: 'Punch failed - strength too low' }],
        },
    };
}

/**
 * Creates an ActionController with default mocks.
 * @param {Object} options - Configuration options.
 * @returns {ActionController}
 */
function createMockActionController(options = {}) {
    const {
        worldStateController = createMockWSC(),
        consequenceHandlers = createMockConsequenceHandlers(),
        actionRegistry = options.actions || createDefaultActionRegistry(),
        componentCapabilityController = createMockComponentCapabilityController(),
    } = options;

    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.critical.mockClear();

    return new ActionController(worldStateController, consequenceHandlers, actionRegistry, componentCapabilityController);
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

describe('ActionController — Constructor & Initialization', () => {
    it('should store worldStateController reference', () => {
        const wsc = createMockWSC();
        const ch = createMockConsequenceHandlers();
        const registry = createDefaultActionRegistry();
        const ccc = createMockComponentCapabilityController();
        const controller = new ActionController(wsc, ch, registry, ccc);

        expect(controller.worldStateController).toBe(wsc);
    });

    it('should store consequenceHandlers reference', () => {
        const wsc = createMockWSC();
        const ch = createMockConsequenceHandlers();
        const registry = createDefaultActionRegistry();
        const ccc = createMockComponentCapabilityController();
        const controller = new ActionController(wsc, ch, registry, ccc);

        expect(controller.consequenceHandlers).toBe(ch);
    });

    it('should store actionRegistry reference', () => {
        const wsc = createMockWSC();
        const ch = createMockConsequenceHandlers();
        const registry = createDefaultActionRegistry();
        const ccc = createMockComponentCapabilityController();
        const controller = new ActionController(wsc, ch, registry, ccc);

        expect(controller.actionRegistry).toBe(registry);
    });

    it('should store componentCapabilityController reference', () => {
        const wsc = createMockWSC();
        const ch = createMockConsequenceHandlers();
        const registry = createDefaultActionRegistry();
        const ccc = createMockComponentCapabilityController();
        const controller = new ActionController(wsc, ch, registry, ccc);

        expect(controller.componentCapabilityController).toBe(ccc);
    });

    it('should handle null actionRegistry', () => {
        const wsc = createMockWSC();
        const ch = createMockConsequenceHandlers();
        const ccc = createMockComponentCapabilityController();
        const controller = new ActionController(wsc, ch, null, ccc);

        expect(controller.actionRegistry).toEqual({});
    });

    it('should return actionRegistry via getRegistry()', () => {
        const registry = createDefaultActionRegistry();
        const controller = createMockActionController({ actionRegistry: registry });
        expect(controller.getRegistry()).toBe(registry);
    });
});

// ============================================================================
// 2. CAPABILITY DELEGATION
// ============================================================================

describe('ActionController — Capability Delegation', () => {
    let controller;
    let ccc;

    beforeEach(() => {
        ccc = createMockComponentCapabilityController();
        controller = createMockActionController({ componentCapabilityController: ccc });
    });

    it('should delegate scanAllCapabilities to ComponentCapabilityController', () => {
        const state = { entities: {} };
        controller.scanAllCapabilities(state);
        expect(ccc.scanAllCapabilities).toHaveBeenCalledWith(state);
    });

    it('should delegate getCachedCapabilities to ComponentCapabilityController', () => {
        controller.getCachedCapabilities();
        expect(ccc.getCachedCapabilities).toHaveBeenCalled();
    });

    it('should delegate getBestComponentForAction to ComponentCapabilityController', () => {
        controller.getBestComponentForAction('move');
        expect(ccc.getBestComponentForAction).toHaveBeenCalledWith('move');
    });

    it('should delegate getAllCapabilitiesForAction to ComponentCapabilityController', () => {
        controller.getAllCapabilitiesForAction('move');
        expect(ccc.getAllCapabilitiesForAction).toHaveBeenCalledWith('move');
    });

    it('should delegate getCapabilitiesForEntity to ComponentCapabilityController', () => {
        controller.getCapabilitiesForEntity('e1');
        expect(ccc.getCapabilitiesForEntity).toHaveBeenCalledWith('e1');
    });

    it('should delegate getActionsForEntity to ComponentCapabilityController', () => {
        const state = { entities: {} };
        controller.getActionsForEntity(state, 'e1');
        expect(ccc.getActionsForEntity).toHaveBeenCalledWith(state, 'e1');
    });

    it('should delegate getActionCapabilities to ComponentCapabilityController', () => {
        const state = { entities: {} };
        controller.getActionCapabilities(state);
        expect(ccc.getActionCapabilities).toHaveBeenCalledWith(state);
    });

    it('should delegate reEvaluateEntityCapabilities to ComponentCapabilityController', () => {
        const state = { entities: {} };
        controller.reEvaluateEntityCapabilities(state, 'e1');
        expect(ccc.reEvaluateEntityCapabilities).toHaveBeenCalledWith(state, 'e1');
    });

    it('should delegate removeEntityFromCache to ComponentCapabilityController', () => {
        controller.removeEntityFromCache('e1');
        expect(ccc.removeEntityFromCache).toHaveBeenCalledWith('e1');
    });
});

// ============================================================================
// 3. REQUIREMENT CHECKING
// ============================================================================

describe('ActionController — Requirement Checking', () => {
    let controller;

    beforeEach(() => {
        controller = createMockActionController();
    });

    // --- _checkRequirements (Entity-level, multi-component) ---

    it('should pass when single component satisfies all requirements', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
            Physical: { strength: 8 },
        });

        const requirements = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
        ];

        const result = controller._checkRequirements(requirements, 'e1');

        expect(result.passed).toBe(true);
        expect(result.requirementValues['Movement.move']).toBe(10);
        expect(result.fulfillingComponents['Movement.move']).toBe('c1');
        expect(result.componentId).toBe('c1');
    });

    it('should pass when multiple components satisfy different requirements', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidArm', identifier: 'left' },
                { id: 'c2', type: 'droidHand', identifier: 'right' },
            ],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Movement: { move: 10 } };
            if (compId === 'c2') return { Physical: { strength: 8 } };
            return null;
        });

        const requirements = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
        ];

        const result = controller._checkRequirements(requirements, 'e1');

        expect(result.passed).toBe(true);
        expect(result.fulfillingComponents['Movement.move']).toBe('c1');
        expect(result.fulfillingComponents['Physical.strength']).toBe('c2');
    });

    it('should return ENTITY_NOT_FOUND for non-existent entity', () => {
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue(null);

        const result = controller._checkRequirements(
            [{ trait: 'Movement', stat: 'move', minValue: 5 }],
            'nonexistent'
        );

        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('ENTITY_NOT_FOUND');
    });

    it('should return MISSING_TRAIT_STAT when no component has required value', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 2 },
        });

        const result = controller._checkRequirements(
            [{ trait: 'Movement', stat: 'move', minValue: 5 }],
            'e1'
        );

        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('MISSING_TRAIT_STAT');
    });

    it('should handle boundary equality (value === minValue)', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 5 },
        });

        const result = controller._checkRequirements(
            [{ trait: 'Movement', stat: 'move', minValue: 5 }],
            'e1'
        );

        expect(result.passed).toBe(true);
    });

    // --- _checkRequirementsForComponent (Single-component, strict) ---

    it('should pass when component has all required traits', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
            Physical: { strength: 8 },
        });

        const requirements = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
        ];

        const result = controller._checkRequirementsForComponent(requirements, 'e1', 'c1');

        expect(result.passed).toBe(true);
        expect(result.fulfillingComponents['Movement.move']).toBe('c1');
        expect(result.fulfillingComponents['Physical.strength']).toBe('c1');
    });

    it('should fail when component lacks one required trait', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        const requirements = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
        ];

        const result = controller._checkRequirementsForComponent(requirements, 'e1', 'c1');

        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('MISSING_TRAIT_STAT');
    });

    it('should fail when component stat is below minValue', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 3 },
        });

        const result = controller._checkRequirementsForComponent(
            [{ trait: 'Movement', stat: 'move', minValue: 5 }],
            'e1',
            'c1'
        );

        expect(result.passed).toBe(false);
    });

    it('should fail when component has no stats', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue(null);

        const result = controller._checkRequirementsForComponent(
            [{ trait: 'Movement', stat: 'move', minValue: 5 }],
            'e1',
            'c1'
        );

        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('ENTITY_NOT_FOUND');
    });

    it('should be stricter than _checkRequirements (single vs multi-component)', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidArm', identifier: 'left' },
                { id: 'c2', type: 'droidHand', identifier: 'right' },
            ],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Movement: { move: 10 } };
            if (compId === 'c2') return { Physical: { strength: 8 } };
            return null;
        });

        const requirements = [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'strength', minValue: 5 },
        ];

        // _checkRequirements passes (multi-component)
        const multiResult = controller._checkRequirements(requirements, 'e1');
        expect(multiResult.passed).toBe(true);

        // _checkRequirementsForComponent fails for c1 alone (missing Physical)
        const singleResult = controller._checkRequirementsForComponent(requirements, 'e1', 'c1');
        expect(singleResult.passed).toBe(false);
    });

    // --- checkRequirements (Public API) ---

    it('should pass for valid action name', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        const result = controller.checkRequirements('move', 'e1');
        expect(result.passed).toBe(true);
    });

    it('should return ACTION_NOT_FOUND for unknown action', () => {
        const result = controller.checkRequirements('nonexistent', 'e1');
        expect(result.passed).toBe(false);
        expect(result.error.code).toBe('ACTION_NOT_FOUND');
    });
});

// ============================================================================
// 4. ACTION EXECUTION
// ============================================================================

describe('ActionController — Action Execution', () => {
    let controller;

    beforeEach(() => {
        controller = createMockActionController();
    });

    // --- Success Cases ---

    it('should execute successfully with entity-wide requirement fulfillment', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        const result = controller.executeAction('move', 'e1');

        expect(result.success).toBe(true);
        expect(result.action).toBe('move');
        expect(result.entityId).toBe('e1');
        expect(result.executedConsequences).toBeGreaterThan(0);
    });

    it('should use attackerComponentId for requirement resolution', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidHand', identifier: 'right' },
                { id: 'c2', type: 'leg', identifier: 'right' },
            ],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Movement: { move: 10 }, Physical: { durability: 50 } };
            if (compId === 'c2') return { Movement: { move: 8 } };
            return null;
        });

        const result = controller.executeAction('dash', 'e1', { attackerComponentId: 'c1' });
        expect(result.success).toBe(true);
    });

    it('should use targetComponentId for requirement resolution (legacy)', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        const result = controller.executeAction('move', 'e1', { targetComponentId: 'c1' });
        expect(result.success).toBe(true);
    });

    it('should prioritize attackerComponentId over targetComponentId', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidHand', identifier: 'right' },
                { id: 'c2', type: 'leg', identifier: 'right' },
            ],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Physical: { strength: 10 } };
            if (compId === 'c2') return { Movement: { move: 1 } };
            return null;
        });

        const result = controller.executeAction('droid punch', 'e1', {
            attackerComponentId: 'c1',
            targetComponentId: 'c2',
        });

        expect(result.success).toBe(true);
    });

    it('should pass fulfillingComponents and requirementValues to consequence context', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        controller.executeAction('move', 'e1');

        const callArgs = controller.consequenceHandlers.handlers.deltaSpatial.mock.calls[0];
        expect(callArgs[2].fulfillingComponents).toHaveProperty('Movement.move');
        expect(callArgs[2].requirementValues).toHaveProperty('Movement.move', 10);
    });

    // --- Failure Cases ---

    it('should return failure when action does not exist', () => {
        const result = controller.executeAction('nonexistent', 'e1');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('should return failure when requirements not met (entity-wide)', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 1 },
        });

        const result = controller.executeAction('move', 'e1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Requirement failed');
        expect(result.executedFailureConsequences).toBeGreaterThan(0);
    });

    it('should return failure when attackerComponentId does not meet requirements', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidHand', identifier: 'right' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Physical: { strength: 0 },
        });

        const result = controller.executeAction('droid punch', 'e1', { attackerComponentId: 'c1' });
        expect(result.success).toBe(false);
    });

    it('should catch system errors and return SYSTEM_RUNTIME_ERROR', () => {
        controller.worldStateController.stateEntityController.getEntity.mockImplementation(() => {
            throw new Error('Simulated crash');
        });

        const result = controller.executeAction('move', 'e1');
        expect(result.success).toBe(false);
        expect(result.error).toContain('unexpected system error');
    });

    // --- Consequence Execution ---

    it('should execute single consequence successfully', () => {
        const result = controller._executeConsequences('move', 'e1', { 'Movement.move': 10 }, {});
        expect(result.success).toBe(true);
        expect(result.executedConsequences).toBe(1);
    });

    it('should execute multiple consequences', () => {
        const result = controller._executeConsequences('dash', 'e1', { 'Movement.move': 10, 'Physical.durability': 50 }, {});
        expect(result.success).toBe(true);
        expect(result.executedConsequences).toBe(2);
    });

    it('should handle unknown consequence type', () => {
        const actionRegistry = {
            testAction: {
                consequences: [{ type: 'nonexistentHandler', params: {} }],
            },
        };
        const controller2 = createMockActionController({ actionRegistry });

        const result = controller2._executeConsequences('testAction', 'e1', {}, {});
        expect(result.success).toBe(true);
        expect(result.results[0].success).toBe(false);
        expect(result.results[0].error).toContain('Unknown consequence type');
    });

    it('should handle consequence handler throwing error', () => {
        const mockHandler = vi.fn(() => { throw new Error('Handler crash'); });
        const ch = createMockConsequenceHandlers({ testHandler: mockHandler });
        const actionRegistry = {
            testAction: {
                consequences: [{ type: 'testHandler', params: {} }],
            },
        };
        const controller2 = createMockActionController({ consequenceHandlers: ch, actionRegistry });

        const result = controller2._executeConsequences('testAction', 'e1', {}, {});
        expect(result.success).toBe(true);
        expect(result.results[0].success).toBe(false);
    });

    it('should return error when action has no consequences', () => {
        const actionRegistry = { testAction: { requirements: [] } };
        const controller2 = createMockActionController({ actionRegistry });

        const result = controller2._executeConsequences('testAction', 'e1', {}, {});
        expect(result.success).toBe(false);
        expect(result.error).toContain('no consequences defined');
    });

    it('should execute failure consequences when defined', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 1 },
        });

        const result = controller.executeAction('move', 'e1');
        expect(result.success).toBe(false);
        expect(result.executedFailureConsequences).toBe(1);
    });
});

// ============================================================================
// 5. PLACEHOLDER RESOLUTION
// ============================================================================

describe('ActionController — Placeholder Resolution', () => {
    let controller;

    beforeEach(() => {
        controller = createMockActionController();
    });

    it('should resolve exact placeholder to numeric value', () => {
        const result = controller._resolvePlaceholders(':Movement.move', { 'Movement.move': 10 }, {});
        expect(result).toBe(10);
    });

    it('should resolve placeholder with multiplier', () => {
        const result = controller._resolvePlaceholders(':Physical.strength*3', { 'Physical.strength': 25 }, {});
        expect(result).toBe(75);
    });

    it('should resolve placeholder with negative multiplier', () => {
        const result = controller._resolvePlaceholders(':Physical.strength*-2', { 'Physical.strength': 25 }, {});
        expect(result).toBe(-50);
    });

    it('should resolve embedded placeholder in string', () => {
        const result = controller._resolvePlaceholders('move :Movement.move units', { 'Movement.move': 10 }, {});
        expect(result).toBe('move 10 units');
    });

    it('should resolve multiple embedded placeholders in one string', () => {
        const result = controller._resolvePlaceholders(
            ':Physical.strength - :Movement.move',
            { 'Physical.strength': 25, 'Movement.move': 10 },
            {}
        );
        expect(result).toBe('25 - 10');
    });

    it('should keep original string when placeholder is undefined', () => {
        const result = controller._resolvePlaceholders(':NonExistent.stat', {}, {});
        expect(result).toBe(':NonExistent.stat');
    });

    it('should pass through null, undefined, and numbers unchanged', () => {
        expect(controller._resolvePlaceholders(null, {}, {})).toBeNull();
        expect(controller._resolvePlaceholders(undefined, {}, {})).toBeUndefined();
        expect(controller._resolvePlaceholders(42, {}, {})).toBe(42);
    });

    it('should resolve placeholders in array', () => {
        const result = controller._resolvePlaceholders(
            [':Strength.power', ':Agility.speed'],
            { 'Strength.power': 10, 'Agility.speed': 8 },
            {}
        );
        expect(result).toEqual([10, 8]);
    });

    it('should resolve placeholders in nested object', () => {
        const result = controller._resolvePlaceholders(
            { damage: ':Physical.strength', range: ':Movement.move' },
            { 'Physical.strength': 25, 'Movement.move': 10 },
            {}
        );
        expect(result).toEqual({ damage: 25, range: 10 });
    });

    it('should resolve production pattern -:Trait.stat', () => {
        const result = controller._resolvePlaceholders('-:Physical.strength', { 'Physical.strength': 25 }, {});
        expect(result).toBe(-25);
    });

    it('should resolve production pattern :Trait.stat*multiplier', () => {
        const result = controller._resolvePlaceholders(':Movement.move*2', { 'Movement.move': 10 }, {});
        expect(result).toBe(20);
    });
});

// ============================================================================
// 6. ERROR RESOLUTION
// ============================================================================

describe('ActionController — Error Resolution', () => {
    let controller;

    beforeEach(() => {
        controller = createMockActionController();
    });

    it('should resolve ENTITY_NOT_FOUND', () => {
        const result = controller._resolveError({ code: 'ENTITY_NOT_FOUND', details: { entityId: 'e1' } });
        expect(result).toBe('Entity "e1" not found.');
    });

    it('should resolve ACTION_NOT_FOUND', () => {
        const result = controller._resolveError({ code: 'ACTION_NOT_FOUND', details: { actionName: 'test' } });
        expect(result).toBe('Action "test" not found.');
    });

    it('should resolve MISSING_TRAIT_STAT', () => {
        const result = controller._resolveError({
            code: 'MISSING_TRAIT_STAT',
            details: { trait: 'Physical', stat: 'strength', minValue: 5 },
        });
        expect(result).toBe('No component possesses the required Physical.strength (>= 5)');
    });

    it('should resolve SYSTEM_RUNTIME_ERROR', () => {
        const result = controller._resolveError({
            code: 'SYSTEM_RUNTIME_ERROR',
            details: { error: 'something broke' },
        });
        expect(result).toBe('An unexpected system error occurred: something broke');
    });

    it('should handle unknown error code', () => {
        const result = controller._resolveError({ code: 'UNKNOWN_CODE', details: {} });
        expect(result).toBe('An undefined error occurred.');
    });

    it('should handle null/undefined error', () => {
        expect(controller._resolveError(null)).toBe('An unknown error occurred.');
        expect(controller._resolveError(undefined)).toBe('An unknown error occurred.');
    });

    it('should call Logger.critical for SYSTEM_RUNTIME_ERROR', () => {
        controller._resolveError({ code: 'SYSTEM_RUNTIME_ERROR', details: { error: 'test crash' } });
        expect(mockLogger.critical).toHaveBeenCalled();
    });

    it('should call Logger.warn for MISSING_TRAIT_STAT', () => {
        controller._resolveError({
            code: 'MISSING_TRAIT_STAT',
            details: { trait: 'Physical', stat: 'strength', minValue: 5 },
        });
        expect(mockLogger.warn).toHaveBeenCalled();
    });
});

// ============================================================================
// 7. INTEGRATION: FULL ACTION EXECUTION FLOW
// ============================================================================

describe('ActionController — Integration: Full Action Execution Flow', () => {
    let controller;

    beforeEach(() => {
        controller = createMockActionController();
    });

    it('should execute complete flow: check requirements -> execute consequences for dash', () => {
        const entityDef = {
            id: 'e1',
            components: [
                { id: 'c1', type: 'droidArm', identifier: 'left' },
                { id: 'c2', type: 'droidHand', identifier: 'right' },
            ],
        };
        const state = createWorldState([entityDef]);

        controller.worldStateController.componentController.getComponentStats.mockImplementation((compId) => {
            if (compId === 'c1') return { Movement: { move: 15 }, Physical: { durability: 50, strength: 10 } };
            if (compId === 'c2') return { Movement: { move: 10 }, Physical: { durability: 40 } };
            return null;
        });
        controller.worldStateController.stateEntityController.getEntity.mockImplementation((eid) => state.entities[eid]);

        // Step 1: Check requirements
        const checkResult = controller.checkRequirements('dash', 'e1');
        expect(checkResult.passed).toBe(true);

        // Step 2: Execute action
        const executeResult = controller.executeAction('dash', 'e1');
        expect(executeResult.success).toBe(true);
        expect(executeResult.executedConsequences).toBeGreaterThan(0);
    });

    it('should handle action failure with failure consequences', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 1 },
        });

        const result = controller.executeAction('move', 'e1');
        expect(result.success).toBe(false);
        expect(result.executedFailureConsequences).toBe(1);
    });
});

// ============================================================================
// 8. EDGE CASES & ROBUSTNESS
// ============================================================================

describe('ActionController — Edge Cases & Robustness', () => {
    let controller;

    beforeEach(() => {
        controller = createMockActionController();
    });

    it('should handle action with no consequences key', () => {
        const actionRegistry = { noConsequences: { requirements: [] } };
        const controller2 = createMockActionController({ actionRegistry });

        const result = controller2._executeConsequences('noConsequences', 'e1', {}, {});
        expect(result.success).toBe(false);
    });

    it('should handle requirements with single object instead of array', () => {
        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        const result = controller._checkRequirements(
            { trait: 'Movement', stat: 'move', minValue: 5 },
            'e1'
        );
        expect(result.passed).toBe(true);
    });

    it('should handle _checkRequirementsForComponent with single object requirements', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({
            Movement: { move: 10 },
        });

        const result = controller._checkRequirementsForComponent(
            { trait: 'Movement', stat: 'move', minValue: 5 },
            'e1',
            'c1'
        );
        expect(result.passed).toBe(true);
    });

    it('should handle component with empty stats object', () => {
        controller.worldStateController.componentController.getComponentStats.mockReturnValue({});

        const result = controller._checkRequirementsForComponent(
            [{ trait: 'Movement', stat: 'move', minValue: 5 }],
            'e1',
            'c1'
        );
        expect(result.passed).toBe(false);
    });

    it('should handle _resolvePlaceholders with deeply nested object', () => {
        const result = controller._resolvePlaceholders(
            { level1: { level2: { value: ':Movement.move' } } },
            { 'Movement.move': 10 },
            {}
        );
        expect(result).toEqual({ level1: { level2: { value: 10 } } });
    });

    it('should handle executeAction with non-existent entity', () => {
        controller.worldStateController.stateEntityController.getEntity.mockReturnValue(null);

        const result = controller.executeAction('move', 'nonexistent');
        expect(result.success).toBe(false);
    });

    it('should handle action with no requirements defined', () => {
        const actionRegistry = {
            testAction: { requirements: [], consequences: [] },
        };
        const controller2 = createMockActionController({ actionRegistry });

        const entityDef = {
            id: 'e1',
            components: [{ id: 'c1', type: 'droidArm', identifier: 'left' }],
        };
        controller2.worldStateController.stateEntityController.getEntity.mockReturnValue({
            id: 'e1',
            components: entityDef.components,
        });

        const result = controller2.executeAction('testAction', 'e1');
        expect(result.success).toBe(true);
        expect(result.executedConsequences).toBe(0);
    });
});
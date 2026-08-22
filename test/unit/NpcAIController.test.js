/**
 * NpcAIController unit tests (AI system, spec §9.1).
 *
 * Everything external is mocked (no composition root, no data files, no
 * network): the facade / turn system are hand-built objects exposing only
 * the surface the AI brain reads.
 *
 * Covers the spec §9.1 checklist:
 *   1. Entity without isNPC → think returns NOT_NPC
 *   2. NPC without ai (passive/LLM NPC) → think returns NO_AI
 *   3. Unknown ai.behavior → warn + UNKNOWN_BEHAVIOR; no throw
 *   4. Empty room (only AI entity) → idle; queueAction not called
 *   5. Two entities in same room at dist 30 (≤100) → queues droid punch
 *   6. Three entities: closest + farther same room + different room → picks closest, ignores other room
 *   7. Target at dist 150 (>100) → queues move with targetX/Y
 *   8. Target at exactly dist 100 → attacks (≤)
 *   9. Two AIs in same room → each queues attack against the other
 *   10. Capability gate: entity without strength ≥ 15 → punch not executable → skip capability
 *   11. Planning open + turns active → queueAction called; executeAction immediate NOT called
 *   12. Phase = resolution (window closed) + turns active → discard (log); no queue, no immediate exec
 *   13. No tick clock (world without turns) → fallback executeAction immediate
 *   14. think() throws inside strategy (bug simulated) → root guard captures; returns structured skip
 *   15. registerBehavior('test_idle', → null) + entry in registry → dispatch uses registered behavior
 *   16. Custom config: ai.attackRange = 50 + target at 70 → move (not attack)
 *
 * @module test/unit/NpcAIController
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import NpcAIController from '../../src/controllers/ai/NpcAIController.js';

// =========================================================================
// Mocks
// =========================================================================

const NPC_ID = 'ent-npc-ai-0001';
const TARGET_ID = 'ent-target-0001';
const OTHER_NPC_ID = 'ent-npc-ai-0002';

const NPC_ENTITY = {
    id: NPC_ID,
    name: 'Rogue Droid',
    blueprint: 'smallBallDroid',
    isNPC: true,
    location: 'room-main',
    spatial: { x: 0, y: 0 },
    components: [
        { id: 'comp-core-1', type: 'centralBall', stats: { 'Physical.durability': 100 } },
        { id: 'comp-hand-1', type: 'droidHand', stats: { 'Physical.strength': 25 } },
        { id: 'comp-arm-1', type: 'droidArm', stats: {} },
        { id: 'comp-wheel-1', type: 'droidRollingBall', stats: { 'Movement.move': 20 } },
        { id: 'comp-wheel-2', type: 'droidRollingBall', stats: { 'Movement.move': 20 } }
    ],
    npcConfig: {
        personality: 'Hunts everything',
        ai: { behavior: 'chase_attack' }
    },
    status: 'active',
    internalComponents: {}
};

const TARGET_ENTITY = {
    id: TARGET_ID,
    name: 'Player1',
    blueprint: 'smallBallDroid',
    isNPC: false,
    location: 'room-main',
    spatial: { x: 30, y: 0 }, // dist = 30 from NPC
    components: [
        { id: 'comp-core-2', type: 'centralBall', stats: { 'Physical.durability': 100 } },
        { id: 'comp-hand-2', type: 'droidHand', stats: { 'Physical.strength': 25 } }
    ],
    status: 'active',
    internalComponents: {},
    items: []
};

const FAR_TARGET_ENTITY = {
    id: 'ent-far-0001',
    name: 'FarTarget',
    blueprint: 'smallBallDroid',
    isNPC: false,
    location: 'room-main',
    spatial: { x: 150, y: 0 }, // dist = 150 from NPC
    components: [
        { id: 'comp-core-far', type: 'centralBall', stats: { 'Physical.durability': 100 } }
    ],
    status: 'active',
    internalComponents: {},
    items: []
};

const OTHER_ROOM_ENTITY = {
    id: 'ent-other-room-0001',
    name: 'OtherRoom',
    blueprint: 'smallBallDroid',
    isNPC: false,
    location: 'room-other', // Different room!
    spatial: { x: 10, y: 10 },
    components: [
        { id: 'comp-core-other', type: 'centralBall', stats: { 'Physical.durability': 100 } }
    ],
    status: 'active',
    internalComponents: {},
    items: []
};

const OTHER_AI_ENTITY = {
    id: OTHER_NPC_ID,
    name: 'Rogue Droid 2',
    blueprint: 'smallBallDroid',
    isNPC: true,
    location: 'room-main',
    spatial: { x: 50, y: 0 }, // dist = 50 from NPC
    components: [
        { id: 'comp-core-3', type: 'centralBall', stats: { 'Physical.durability': 100 } },
        { id: 'comp-hand-3', type: 'droidHand', stats: { 'Physical.strength': 25 } }
    ],
    npcConfig: {
        personality: 'Another rogue',
        ai: { behavior: 'chase_attack' }
    },
    status: 'active',
    internalComponents: {}
};

const ACTION_REGISTRY = {
    'droid punch': { description: 'punch with droid hand', range: 100, requirements: [{ trait: 'Physical.strength', min: 15 }] },
    'move': { description: 'walk', range: null, requirements: [{ trait: 'Movement.move', min: 5 }] }
};

/**
 * Builds a fake facade with configurable state.
 */
function makeFacade({ entities = {}, canExecute = {}, executeResult } = {}) {
    const executeCalls = [];
    return {
        executeCalls,
        getEntity: (id) => entities[id] || null,
        // New public API methods added by C2 — required for brain to find entities / registry
        getAllEntities: () => entities,
        getActionRegistry: () => ACTION_REGISTRY,
        // Clone-free capability gate (sub task C3): returns boolean.
        canEntityExecuteAction: (id, actionName) => {
            const available = canExecute[id] || canExecute['default'] || {};
            const entries = available[actionName];
            return Array.isArray(entries) && entries.length > 0;
        },
        // Legacy internal shape (kept for backward compat with existing tests)
        actionController: { getRegistry: () => ACTION_REGISTRY },
        stateEntityController: { getAll: () => entities },
        getActionsForEntity: (id) => {
            const out = {};
            // Default: all actions executable for NPC_ID if no specific canExecute provided
            const available = canExecute[id] || canExecute['default'] || {};
            for (const name of Object.keys(ACTION_REGISTRY)) {
                out[name] = { canExecute: available[name] || [] };
            }
            return out;
        },
        executeAction: (actionName, entityId, params) => {
            executeCalls.push({ actionName, entityId, params });
            return executeResult ?? { success: true };
        }
    };
}

/**
 * Builds a fake turn system.
 */
function makeTurns({ phase = 'planning', queueResult } = {}) {
    const queued = [];
    return {
        queued,
        getRoundState: () => ({ phase, roundNumber: 1 }),
        queueAction: (entityId, actionName, params, source) => {
            queued.push({ entityId, actionName, params, source });
            return queueResult ?? { success: true, queueId: `q-${queued.length}` };
        }
    };
}

/**
 * Builds an NpcAIController with custom deps.
 */
function makeController({ facade, turns } = {}) {
    const fakeFacade = facade || makeFacade();
    const fakeTurns = turns || makeTurns();
    const controller = new NpcAIController({
        worldStateController: fakeFacade,
        turnSystemController: fakeTurns
    });
    return { controller, facade: fakeFacade, turns: fakeTurns };
}

// =========================================================================
// Tests (spec §9.1 checklist)
// =========================================================================

describe('NpcAIController.think (AI system, spec §9.1)', () => {
    it('1. Entity without isNPC → think returns NOT_NPC', () => {
        const entities = { 'ent-player-1': { id: 'ent-player-1', isNPC: false, location: 'room-main', spatial: { x: 0, y: 0 } } };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const { controller } = makeController({ facade });

        const result = controller.think('ent-player-1', 1);
        expect(result).toEqual({ acted: false, skipped: 'NOT_NPC' });
    });

    it('2. NPC without ai (passive/LLM NPC) → think returns NO_AI', () => {
        const npcWithoutAi = { ...NPC_ENTITY, npcConfig: { personality: 'Passive NPC' } };
        const entities = { [NPC_ID]: npcWithoutAi };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const { controller } = makeController({ facade });

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, skipped: 'NO_AI' });
    });

    it('3. Unknown ai.behavior → warn + UNKNOWN_BEHAVIOR; no throw', () => {
        const npcWithUnknown = { ...NPC_ENTITY, npcConfig: { ...NPC_ENTITY.npcConfig, ai: { behavior: 'unknown_behavior' } } };
        const entities = { [NPC_ID]: npcWithUnknown };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const { controller } = makeController({ facade });

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, skipped: 'UNKNOWN_BEHAVIOR' });
    });

    it('4. Empty room (only AI entity) → idle; queueAction not called', () => {
        const entities = { [NPC_ID]: NPC_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(turns.queued).toHaveLength(0);
    });

    it('5. Two entities in same room at dist 30 (≤100) → queues droid punch with targetComponentId = core of target', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');
        expect(turns.queued[0].params.targetComponentId).toBe('comp-core-2'); // TARGET_ENTITY.components[0].id
        expect(turns.queued[0].source).toBe('npc');
    });

    it('6. Three entities: closest + farther same room + different room → picks closest, ignores other room', () => {
        // NPC at (0,0), TARGET_ENTITY at (30,0) = dist 30, OTHER_ROOM_ENTITY at different room
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY, 'ent-other': OTHER_ROOM_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].params.targetComponentId).toBe('comp-core-2'); // TARGET_ENTITY's core (closest)
    });

    it('7. Target at dist 150 (>100) → queues move with targetX/Y = target spatial', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, 'ent-far': FAR_TARGET_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('move');
        expect(turns.queued[0].params.targetX).toBe(150);
        expect(turns.queued[0].params.targetY).toBe(0);
    });

    it('8. Target at exactly dist 100 → attacks (≤)', () => {
        const targetAt100 = { ...TARGET_ENTITY, spatial: { x: 100, y: 0 } }; // dist = 100
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: targetAt100 };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(turns.queued[0].actionName).toBe('droid punch');
    });

    it('9. Two AIs in same room → each queues attack against the other', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [OTHER_NPC_ID]: OTHER_AI_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns1 = makeTurns();
        const turns2 = makeTurns();
        const { controller: ai1 } = makeController({ facade, turns: turns1 });
        const { controller: ai2 } = makeController({ facade, turns: turns2 });

        const result1 = ai1.think(NPC_ID, 1);
        const result2 = ai2.think(OTHER_NPC_ID, 1);

        expect(result1.acted).toBe(true);
        expect(result2.acted).toBe(true);
        expect(turns1.queued).toHaveLength(1);
        expect(turns2.queued).toHaveLength(1);
        // AI1 attacks AI2's core
        expect(turns1.queued[0].params.targetComponentId).toBe('comp-core-3');
        // AI2 attacks AI1's core
        expect(turns2.queued[0].params.targetComponentId).toBe('comp-core-1');
    });

    it('10. Capability gate: entity without strength ≥ 15 → punch not executable → skip capability', () => {
        const weakNpc = { ...NPC_ENTITY };
        // Remove strength from components (no component has Physical.strength)
        weakNpc.components = [{ id: 'comp-weak-1', type: 'centralBall', stats: {} }];
        const entities = { [NPC_ID]: weakNpc, [TARGET_ID]: TARGET_ENTITY };
        // Block punch for NPC_ID specifically, but allow move
        const facade = makeFacade({ 
            entities,
            canExecute: { 
                [NPC_ID]: { 'droid punch': [], 'move': ['comp-wheel-1'] },
                'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] }
            }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, reason: 'capability' });
        expect(turns.queued).toHaveLength(0);
    });

    it('11. Planning open + turns active → queueAction called; executeAction immediate NOT called', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns({ phase: 'planning' });
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(facade.executeCalls).toHaveLength(0); // No immediate execution
    });

    it('12. Phase = resolution (window closed) + turns active → decision discarded; acted false, reason=window_closed', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns({ phase: 'resolution' });
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        // Window closed: decision discarded by _dispatchDecision.
        expect(result.acted).toBe(false);
        expect(result.reason).toBe('window_closed');
        expect(turns.queued).toHaveLength(0); // Not queued because window closed
        expect(facade.executeCalls).toHaveLength(0); // No immediate execution
    });

    it('13. No tick clock (world without turns) → fallback executeAction immediate', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        // Pass null for turnSystemController → no turns.
        const controller = new NpcAIController({
            worldStateController: facade,
            turnSystemController: null
        });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(facade.executeCalls).toHaveLength(1);
        expect(facade.executeCalls[0].actionName).toBe('droid punch');
    });

    it('14. think() throws inside strategy (bug simulated) → root guard captures; returns structured skip', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const { controller } = makeController({ facade });

        // Inject a broken strategy that throws.
        controller.registerBehavior('chase_attack', () => { throw new Error('Simulated bug'); });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(false);
        expect(result.skipped).toBe('THINK_ERROR');
        expect(result.reason).toBe('Simulated bug');
    });

    it('15. registerBehavior(\'test_idle\', → null) + entry in registry → dispatch uses registered behavior', () => {
        const npcWithIdle = { ...NPC_ENTITY, npcConfig: { ...NPC_ENTITY.npcConfig, ai: { behavior: 'test_idle' } } };
        const entities = { [NPC_ID]: npcWithIdle };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const controller = new NpcAIController({
            worldStateController: facade,
            turnSystemController: turns
        });
        // Register a behavior that always returns null (idle).
        controller.registerBehavior('test_idle', () => null);

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, reason: 'idle' });
    });

    it('16. Custom config: ai.attackRange = 50 + target at 70 → move (not attack)', () => {
        const npcWithRange = {
            ...NPC_ENTITY,
            npcConfig: { ...NPC_ENTITY.npcConfig, ai: { behavior: 'chase_attack', attackRange: 50 } }
        };
        const targetAt70 = { ...TARGET_ENTITY, spatial: { x: 70, y: 0 } }; // dist = 70
        const entities = { [NPC_ID]: npcWithRange, [TARGET_ID]: targetAt70 };
        const facade = makeFacade({ 
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(turns.queued[0].actionName).toBe('move'); // Not attack because 70 > 50
    });

    // TURNS_DISABLED parity — HIGH #1 fix (mirror LLMAgentController._dispatchAction fallback)
    it('TURNS_DISABLED → getRoundState returns {phase:"planning", roundNumber:0, currentTick:0}, queueAction returns {success:false, code:"TURNS_DISABLED"} ⇒ executeAction called once, {acted:true}', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        // Turn system where getRoundState returns a valid planning object but queueAction says TURNS_DISABLED.
        const turns = {
            getRoundState: () => ({ phase: 'planning', roundNumber: 0, currentTick: 0 }),
            queueAction: () => ({ success: false, code: 'TURNS_DISABLED' }),
            queued: []
        };
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(facade.executeCalls).toHaveLength(1);
        expect(facade.executeCalls[0].actionName).toBe('droid punch');
        expect(facade.executeCalls[0].entityId).toBe(NPC_ID);
    });

    it('TURNS_DISABLED → facade.executeAction throws ⇒ {acted:false, reason:"execute_failed"}, no crash', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const executeCalls = [];
        const facade = {
            ...makeFacade({
                entities,
                canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
            }),
            executeAction: (actionName, entityId, params) => {
                executeCalls.push({ actionName, entityId, params });
                throw new Error('Simulated execution failure');
            }
        };
        const turns = {
            getRoundState: () => ({ phase: 'planning', roundNumber: 0, currentTick: 0 }),
            queueAction: () => ({ success: false, code: 'TURNS_DISABLED' }),
            queued: []
        };
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(false);
        expect(result.reason).toBe('execute_failed');
    });

    // L3: Lacunas de teste nos ramos de dispatch
    it('L3a. queueAction {success:false, code:\"PLANNING_CLOSED\"} → {acted:false, reason:\"queue_rejected\"}', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns({ phase: 'planning', queueResult: { success: false, code: 'PLANNING_CLOSED' } });
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        // think() propaga acted + reason; code fica interno ao _dispatchDecision.
        expect(result.acted).toBe(false);
        expect(result.reason).toBe('queue_rejected');
    });

    it('L3b. getRoundState() === undefined (com turnSystem presente) → executeAction 1×, {acted:true}', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        // Turn system com getRoundState retornando undefined.
        const turns = {
            getRoundState: () => undefined,
            queueAction: () => ({ success: true }),
            queued: []
        };
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(facade.executeCalls).toHaveLength(1);
    });

    // L2: NaN guards em _chaseAttackBehavior
    it('L2a. entity com spatial {x: NaN, y: 0} → {acted:false, reason:\"idle\"}, nada enfileirado', () => {
        const npcWithNaN = { ...NPC_ENTITY, spatial: { x: NaN, y: 0 } };
        const entities = { [NPC_ID]: npcWithNaN, [TARGET_ID]: TARGET_ENTITY };
        const facade = makeFacade({
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(turns.queued).toHaveLength(0);
    });

    it('L2b. alvo com spatial {x: Infinity, y: 0} → {acted:false, reason:\"idle\"}', () => {
        const targetWithInf = { ...TARGET_ENTITY, spatial: { x: Infinity, y: 0 } };
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: targetWithInf };
        const facade = makeFacade({
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(turns.queued).toHaveLength(0);
    });

    it('L3c. alvo em alcance sem components[0] → {acted:false, reason:\"idle\"}', () => {
        const targetNoCore = { ...TARGET_ENTITY, components: [] };
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: targetNoCore };
        const facade = makeFacade({
            entities,
            canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
        });
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result).toEqual({ acted: false, reason: 'idle' });
    });

    // M3: hasDeterministicBrain static predicate tests
    it('M3. hasDeterministicBrain → true para {npcConfig:{ai:{behavior:\"chase_attack\"}}}', () => {
        const entity = { npcConfig: { ai: { behavior: 'chase_attack' } } };
        expect(NpcAIController.hasDeterministicBrain(entity)).toBe(true);
    });

    it('M3. hasDeterministicBrain → false para behavior:\"\"', () => {
        const entity = { npcConfig: { ai: { behavior: '' } } };
        expect(NpcAIController.hasDeterministicBrain(entity)).toBe(false);
    });

    it('M3. hasDeterministicBrain → false para ai:null', () => {
        const entity = { npcConfig: { ai: null } };
        expect(NpcAIController.hasDeterministicBrain(entity)).toBe(false);
    });

    it('M3. hasDeterministicBrain → false para npcConfig:{}', () => {
        const entity = { npcConfig: {} };
        expect(NpcAIController.hasDeterministicBrain(entity)).toBe(false);
    });

    it('M3. hasDeterministicBrain → false para entity undefined', () => {
        expect(NpcAIController.hasDeterministicBrain(undefined)).toBe(false);
        expect(NpcAIController.hasDeterministicBrain({})).toBe(false);
    });

    // C3: Hot-path performance — clone-free capability gate
    it('C3. Single think() results in at most 1 getAllEntities() call and 0 getActionsForEntity() calls', () => {
        const entities = { [NPC_ID]: NPC_ENTITY, [TARGET_ID]: TARGET_ENTITY };
        let getAllEntitiesCallCount = 0;
        let getActionsForEntityCallCount = 0;
        const facade = {
            ...makeFacade({
                entities,
                canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
            }),
            getAllEntities: () => { getAllEntitiesCallCount++; return entities; },
            getActionsForEntity: () => { getActionsForEntityCallCount++; return {}; }
        };
        const turns = makeTurns();
        const { controller } = makeController({ facade, turns });

        const result = controller.think(NPC_ID, 1);
        expect(result.acted).toBe(true);
        expect(getAllEntitiesCallCount).toBeLessThanOrEqual(1);
        expect(getActionsForEntityCallCount).toBe(0);
    });

    // C10: Component selection heuristic — targetComponentId picks HP-bearing component
    describe('chase_attack component selection (C10)', () => {
        it('a. target [plain, hp-bearing] → attack uses the HP-bearing component id (not components[0])', () => {
            const plainTarget = {
                id: 'ent-plain-hp',
                name: 'PlainThenHP',
                blueprint: 'smallBallDroid',
                isNPC: false,
                location: 'room-main',
                spatial: { x: 30, y: 0 }, // dist = 30
                components: [
                    { id: 'comp-plain-no-dur', type: 'droidArm', stats: { 'Physical.strength': 10 } },
                    { id: 'comp-hp-bearing', type: 'centralBall', stats: { 'Physical.durability': 100 } }
                ],
                status: 'active',
                internalComponents: {},
                items: []
            };
            const entities = { [NPC_ID]: NPC_ENTITY, [plainTarget.id]: plainTarget };
            const facade = makeFacade({
                entities,
                canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
            });
            const turns = makeTurns();
            const { controller } = makeController({ facade, turns });

            const result = controller.think(NPC_ID, 1);
            expect(result.acted).toBe(true);
            expect(turns.queued).toHaveLength(1);
            expect(turns.queued[0].actionName).toBe('droid punch');
            expect(turns.queued[0].params.targetComponentId).toBe('comp-hp-bearing'); // NOT components[0]
        });

        it('b. target [hp-bearing, plain] → uses the first one (order-stable when already correct)', () => {
            const hpFirstTarget = {
                id: 'ent-hp-first',
                name: 'HPFirst',
                blueprint: 'smallBallDroid',
                isNPC: false,
                location: 'room-main',
                spatial: { x: 30, y: 0 }, // dist = 30
                components: [
                    { id: 'comp-hp-first', type: 'centralBall', stats: { 'Physical.durability': 100 } },
                    { id: 'comp-plain-after', type: 'droidArm', stats: { 'Physical.strength': 10 } }
                ],
                status: 'active',
                internalComponents: {},
                items: []
            };
            const entities = { [NPC_ID]: NPC_ENTITY, [hpFirstTarget.id]: hpFirstTarget };
            const facade = makeFacade({
                entities,
                canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
            });
            const turns = makeTurns();
            const { controller } = makeController({ facade, turns });

            const result = controller.think(NPC_ID, 1);
            expect(result.acted).toBe(true);
            expect(turns.queued).toHaveLength(1);
            expect(turns.queued[0].actionName).toBe('droid punch');
            expect(turns.queued[0].params.targetComponentId).toBe('comp-hp-first'); // first IS hp-bearing
        });

        it('c. target [plain, plain] (no health stat) → falls back to components[0]', () => {
            const allPlainTarget = {
                id: 'ent-all-plain',
                name: 'AllPlain',
                blueprint: 'smallBallDroid',
                isNPC: false,
                location: 'room-main',
                spatial: { x: 30, y: 0 }, // dist = 30
                components: [
                    { id: 'comp-plain-a', type: 'droidArm', stats: { 'Physical.strength': 10 } },
                    { id: 'comp-plain-b', type: 'droidHand', stats: { 'Physical.strength': 5 } }
                ],
                status: 'active',
                internalComponents: {},
                items: []
            };
            const entities = { [NPC_ID]: NPC_ENTITY, [allPlainTarget.id]: allPlainTarget };
            const facade = makeFacade({
                entities,
                canExecute: { 'default': { 'droid punch': ['comp-hand-1'], 'move': ['comp-wheel-1'] } }
            });
            const turns = makeTurns();
            const { controller } = makeController({ facade, turns });

            const result = controller.think(NPC_ID, 1);
            expect(result.acted).toBe(true);
            expect(turns.queued).toHaveLength(1);
            expect(turns.queued[0].actionName).toBe('droid punch');
            expect(turns.queued[0].params.targetComponentId).toBe('comp-plain-a'); // fallback to components[0]
        });
    });
});

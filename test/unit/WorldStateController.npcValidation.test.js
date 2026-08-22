/**
 * WorldStateController — NPC AI validation warning tests (MEDIUM #3: untested validation branches).
 *
 * These tests drive the REAL production validation code in WorldStateController._spawnNpcs()
 * (src/controllers/WorldStateController.js, lines 231-271). They do NOT use a copied helper.
 *
 * Construction/mock seam:
 *   - A single top-level vi.mock of '../../src/utils/DataLoader.js' uses a mutable `fixtureNpcs`
 *     variable set per-test. The mock returns fixtureNPCs for 'data/npcs.json' and a minimal
 *     valid room definition for 'data/rooms.json', delegating all other paths to the real DataLoader.
 *   - The full controller is built via buildWorldState(tickSystem) from the composition root,
 *     then initializeWorld() is called — which invokes _spawnNpcs() with our fixture NPC data.
 *   - Logger.warn is spied on to capture validation warnings.
 *
 * This ensures tests stay in sync with production: if the mirror drifts, these tests fail.
 *
 * @module test/unit/WorldStateController.npcValidation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import Logger from '../../src/utils/Logger.js';

// =========================================================================
// Mutable fixture state (shared across all tests via top-level vi.mock)
// =========================================================================

/** @type {Object|null} — set per-test via setFixture; null = empty registry */
let fixtureNpcs = null;

/**
 * Build fixture NPC entries keyed by blueprint name.
 * @param {Object[]} npcs - Array of NPC entry objects (each has displayName, ai, etc.)
 * @returns {Object} Keyed map: { [blueprint]: npcEntry }
 */
function buildNpcRegistry(npcs) {
    // Always use 'smallBallDroid' as the blueprint key — it exists in data/blueprints.json.
    // The blueprint KEY (object key in npcs.json) is what gets passed to spawnEntity,
    // NOT the `blueprint` property inside the entry.
    const registry = {};
    for (let i = 0; i < npcs.length; i++) {
        const npc = npcs[i];
        const key = npcs.length === 1 ? 'smallBallDroid' : `smallBallDroid_${i}`;
        registry[key] = {
            displayName: npc.displayName || `Test NPC ${i}`,
            personality: npc.personality || 'Tests things',
            room: npc.room || 'start_room',
            ai: npc.ai ?? null,
            maxWorldActionsPerRound: npc.maxWorldActionsPerRound,
            maxChatMessagesPerRound: npc.maxChatMessagesPerRound,
            ...(npc.extra || {})
        };
    }
    return registry;
}

/**
 * Set the NPC fixture for the next buildWorldState call.
 * @param {Object[]} npcs - Array of NPC entry objects.
 */
function setFixture(npcs) {
    fixtureNpcs = buildNpcRegistry(npcs);
}

function resetFixture() {
    fixtureNpcs = null;
}

// =========================================================================
// Top-level DataLoader mock (hoisted by vitest)
// =========================================================================

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');
    const realDefault = actual.default || {};

    return {
        default: {
            loadJsonSafe(path, defaultValue) {
                if (path === 'data/npcs.json') {
                    return fixtureNpcs !== null ? fixtureNpcs : defaultValue;
                }
                if (path === 'data/rooms.json') {
                    // Minimal room definition that passes RoomsController validation
                    return {
                        start_room: {
                            name: 'Start Room',
                            description: 'A test room.',
                            x: 0,
                            y: 0,
                            width: 100,
                            height: 100,
                            connections: {}
                        }
                    };
                }
                // Delegate all other paths to the real DataLoader
                if (realDefault.loadJsonSafe) {
                    return realDefault.loadJsonSafe(path, defaultValue);
                }
                return defaultValue;
            }
        }
    };
});

// =========================================================================
// Helpers
// =========================================================================

/**
 * Filter warnings that are specifically AI validation warnings (from the ai block).
 */
function filterAiWarnings(calls) {
    return calls.filter(w =>
        typeof w === 'string' && (
            w.includes('[WorldStateController]') &&
            (w.includes('ai.') || w.includes('AI disabled'))
        )
    );
}

/**
 * Find an NPC entity by display name.
 * The entity object has: id, isNPC, name (displayName from entry), npcConfig: { personality, ai, ... }
 */
function findNpcEntity(entities, name) {
    return Object.values(entities).find(e => e.name === name);
}

// =========================================================================
// Test groups
// =========================================================================

describe('NPC AI validation — REAL production code path (MEDIUM #3)', () => {
    let warnSpy;
    let tickSystem;

    beforeEach(() => {
        warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        resetFixture();
    });

    afterEach(() => {
        warnSpy.mockRestore();
        if (tickSystem) {
            try { tickSystem.stop(); } catch (_) {}
        }
        resetFixture();
    });

    // ---------------------------------------------------------------------
    // C4 converted scenarios (7 existing tests re-based onto real code)
    // ---------------------------------------------------------------------

    it('warns when attackRange is a string (e.g. "50") and drops it from normalized output', () => {
        setFixture([{
            displayName: 'StringRangeDroid',
            ai: { behavior: 'chase_attack', attackRange: '50' }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'StringRangeDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const rangeWarn = aiWarnings.find(w => w.includes('StringRangeDroid') && w.includes('attackRange'));
        expect(rangeWarn).toBeDefined();
        expect(rangeWarn).toContain('string');
    });

    it('warns when attackAction is a number and drops the override', () => {
        setFixture([{
            displayName: 'NumActionDroid',
            ai: { behavior: 'chase_attack', attackRange: 10, attackAction: 123 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NumActionDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.behavior).toBe('chase_attack');
        expect(npcEntity.npcConfig.ai.attackAction).toBeUndefined();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const actionWarn = aiWarnings.find(w => w.includes('NumActionDroid') && w.includes('attackAction'));
        expect(actionWarn).toBeDefined();
        expect(actionWarn).toContain('number');
    });

    it('warns when moveAction is an object and drops the override', () => {
        setFixture([{
            displayName: 'ObjMoveDroid',
            ai: { behavior: 'chase_attack', attackRange: 10, moveAction: {} }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'ObjMoveDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.behavior).toBe('chase_attack');
        expect(npcEntity.npcConfig.ai.moveAction).toBeUndefined();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const moveWarn = aiWarnings.find(w => w.includes('ObjMoveDroid') && w.includes('moveAction'));
        expect(moveWarn).toBeDefined();
        expect(moveWarn).toContain('object');
    });

    it('does NOT warn when attackRange is null (treated as ABSENT)', () => {
        setFixture([{
            displayName: 'NullRangeDroid',
            ai: { behavior: 'chase_attack', attackRange: null }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NullRangeDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.behavior).toBe('chase_attack');

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const nullRangeWarn = aiWarnings.find(w => w.includes('NullRangeDroid') && w.includes('attackRange') && w.includes('ignoring'));
        expect(nullRangeWarn).toBeUndefined();
    });

    it('does NOT warn when attackAction is undefined (ABSENT)', () => {
        setFixture([{
            displayName: 'UndefActionDroid',
            ai: { behavior: 'chase_attack', attackRange: 10 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'UndefActionDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.behavior).toBe('chase_attack');

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const undefActionWarn = aiWarnings.find(w => w.includes('UndefActionDroid') && w.includes('attackAction') && w.includes('expected'));
        expect(undefActionWarn).toBeUndefined();
    });

    it('does NOT warn when moveAction is undefined (ABSENT)', () => {
        setFixture([{
            displayName: 'UndefMoveDroid',
            ai: { behavior: 'chase_attack', attackRange: 10 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'UndefMoveDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.behavior).toBe('chase_attack');

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const undefMoveWarn = aiWarnings.find(w => w.includes('UndefMoveDroid') && w.includes('moveAction') && w.includes('expected'));
        expect(undefMoveWarn).toBeUndefined();
    });

    it('valid normal input produces no warnings and preserves all fields', () => {
        setFixture([{
            displayName: 'ValidDroid',
            ai: { behavior: 'chase_attack', attackRange: 50, attackAction: 'droid_punch', moveAction: 'droid_move' }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'ValidDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.behavior).toBe('chase_attack');
        expect(npcEntity.npcConfig.ai.attackRange).toBe(50);
        expect(npcEntity.npcConfig.ai.attackAction).toBe('droid_punch');
        expect(npcEntity.npcConfig.ai.moveAction).toBe('droid_move');

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const validDroidWarns = aiWarnings.filter(w => w.includes('ValidDroid'));
        expect(validDroidWarns).toHaveLength(0);
    });

    // ---------------------------------------------------------------------
    // New branch coverage tests (MEDIUM #3 actual gaps)
    // ---------------------------------------------------------------------

    it('attackRange: 0 → warning, entire AI disabled (hasValidAttackRange=false → normalizedAi=null)', () => {
        // Production code line 251: if (hasValidBehavior && hasValidAttackRange) — when attackRange=0,
        // hasValidAttackRange=false, so the condition fails and normalizedAi stays null.
        setFixture([{
            displayName: 'ZeroRangeDroid',
            ai: { behavior: 'chase_attack', attackRange: 0 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'ZeroRangeDroid');
        expect(npcEntity).toBeDefined();
        // hasValidAttackRange=false → entire AI block disabled (not partial with just behavior)
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const zeroWarn = aiWarnings.find(w => w.includes('ZeroRangeDroid') && w.includes('attackRange'));
        expect(zeroWarn).toBeDefined();
        expect(zeroWarn).toContain('0');
    });

    it('attackRange: -5 → warning, entire AI disabled', () => {
        setFixture([{
            displayName: 'NegativeRangeDroid',
            ai: { behavior: 'chase_attack', attackRange: -5 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NegativeRangeDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const negWarn = aiWarnings.find(w => w.includes('NegativeRangeDroid') && w.includes('attackRange'));
        expect(negWarn).toBeDefined();
    });

    it('attackRange: NaN → warning (non-finite), entire AI disabled', () => {
        setFixture([{
            displayName: 'NaNRangeDroid',
            ai: { behavior: 'chase_attack', attackRange: NaN }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NaNRangeDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const nanWarn = aiWarnings.find(w => w.includes('NaNRangeDroid') && w.includes('attackRange'));
        expect(nanWarn).toBeDefined();
    });

    it('attackRange: Infinity → warning (non-finite), entire AI disabled', () => {
        setFixture([{
            displayName: 'InfRangeDroid',
            ai: { behavior: 'chase_attack', attackRange: Infinity }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'InfRangeDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const infWarn = aiWarnings.find(w => w.includes('InfRangeDroid') && w.includes('attackRange'));
        expect(infWarn).toBeDefined();
    });

    it('behavior: "" (empty string) → AI disabled (ai = null) + warning', () => {
        setFixture([{
            displayName: 'EmptyBehaviorDroid',
            ai: { behavior: '', attackRange: 10 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'EmptyBehaviorDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const emptyWarn = aiWarnings.find(w => w.includes('EmptyBehaviorDroid') && w.includes('behavior'));
        expect(emptyWarn).toBeDefined();
        expect(emptyWarn).toContain('disabled');
    });

    it('behavior missing (undefined) → AI disabled (ai = null) + warning', () => {
        setFixture([{
            displayName: 'MissingBehaviorDroid',
            ai: { attackRange: 10 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'MissingBehaviorDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const missingWarn = aiWarnings.find(w => w.includes('MissingBehaviorDroid') && w.includes('behavior'));
        expect(missingWarn).toBeDefined();
    });

    it('behavior: 123 (non-string) → AI disabled (ai = null) + warning (real code behavior)', () => {
        // Production code checks: typeof rawAi.behavior === 'string' && rawAi.behavior !== ''
        // A numeric behavior fails the type check → hasValidBehavior = false → AI disabled
        setFixture([{
            displayName: 'NonStringBehaviorDroid',
            ai: { behavior: 123, attackRange: 10 }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NonStringBehaviorDroid');
        expect(npcEntity).toBeDefined();
        // Production code: typeof 123 !== 'string', so hasValidBehavior = false → ai = null
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const nonStrWarn = aiWarnings.find(w => w.includes('NonStringBehaviorDroid') && w.includes('behavior'));
        expect(nonStrWarn).toBeDefined();
    });

    it('ai: null → no AI, no crash, no spurious warning', () => {
        setFixture([{
            displayName: 'NullAiDroid',
            ai: null
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        expect(() => worldStateController.initializeWorld()).not.toThrow();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NullAiDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const nullAiWarn = aiWarnings.find(w => w.includes('NullAiDroid'));
        expect(nullAiWarn).toBeUndefined();
    });

    it('ai: "not-an-object" (string) → no AI, no crash', () => {
        setFixture([{
            displayName: 'StringAiDroid',
            ai: 'not-an-object'
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        expect(() => worldStateController.initializeWorld()).not.toThrow();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'StringAiDroid');
        expect(npcEntity).toBeDefined();
        // Production: !rawAi || typeof rawAi !== 'object' → normalizedAi = null
        expect(npcEntity.npcConfig.ai).toBeNull();
    });

    it('ai key missing entirely → no AI, no crash', () => {
        setFixture([{
            displayName: 'NoAiDroid',
            ai: undefined
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        expect(() => worldStateController.initializeWorld()).not.toThrow();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NoAiDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).toBeNull();
    });

    it('valid: behavior chase_attack + attackRange 40 + both action overrides → all fields kept, zero warnings', () => {
        setFixture([{
            displayName: 'FullValidDroid',
            ai: { behavior: 'chase_attack', attackRange: 40, attackAction: 'punch', moveAction: 'walk' }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'FullValidDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.behavior).toBe('chase_attack');
        expect(npcEntity.npcConfig.ai.attackRange).toBe(40);
        expect(npcEntity.npcConfig.ai.attackAction).toBe('punch');
        expect(npcEntity.npcConfig.ai.moveAction).toBe('walk');

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const fullWarns = aiWarnings.filter(w => w.includes('FullValidDroid'));
        expect(fullWarns).toHaveLength(0);
    });

    // ---------------------------------------------------------------------
    // Additional edge cases for thorough coverage
    // ---------------------------------------------------------------------

    it('attackRange: "abc" (non-number string) → warning, type mismatch logged', () => {
        setFixture([{
            displayName: 'BadStringRangeDroid',
            ai: { behavior: 'chase_attack', attackRange: 'abc' }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'BadStringRangeDroid');
        expect(npcEntity).toBeDefined();
        // String attackRange → hasValidAttackRange = false → normalizedAi stays null (needs both valid behavior AND range)
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const badStrWarn = aiWarnings.find(w => w.includes('BadStringRangeDroid') && w.includes('attackRange'));
        expect(badStrWarn).toBeDefined();
        expect(badStrWarn).toContain('string');
    });

    it('attackAction: "" (empty string) → warning, override dropped', () => {
        setFixture([{
            displayName: 'EmptyAttackActionDroid',
            ai: { behavior: 'chase_attack', attackRange: 10, attackAction: '' }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'EmptyAttackActionDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.attackAction).toBeUndefined();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const emptyActionWarn = aiWarnings.find(w => w.includes('EmptyAttackActionDroid') && w.includes('attackAction'));
        expect(emptyActionWarn).toBeDefined();
    });

    it('moveAction: "" (empty string) → warning, override dropped', () => {
        setFixture([{
            displayName: 'EmptyMoveActionDroid',
            ai: { behavior: 'chase_attack', attackRange: 10, moveAction: '' }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'EmptyMoveActionDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.moveAction).toBeUndefined();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const emptyMoveWarn = aiWarnings.find(w => w.includes('EmptyMoveActionDroid') && w.includes('moveAction'));
        expect(emptyMoveWarn).toBeDefined();
    });

    it('attackAction: null → no warning (ABSENT), override dropped', () => {
        setFixture([{
            displayName: 'NullAttackActionDroid',
            ai: { behavior: 'chase_attack', attackRange: 10, attackAction: null }
        }]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'NullAttackActionDroid');
        expect(npcEntity).toBeDefined();
        expect(npcEntity.npcConfig.ai).not.toBeNull();
        expect(npcEntity.npcConfig.ai.attackAction).toBeUndefined();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        const nullActionWarn = aiWarnings.find(w => w.includes('NullAttackActionDroid') && w.includes('attackAction') && w.includes('expected'));
        expect(nullActionWarn).toBeUndefined();
    });

    it('multiple NPCs with different issues → each produces its own warning', () => {
        // Use separate fixture entries — each key maps to 'smallBallDroid' blueprint.
        // Since all keys resolve to the same blueprint, we test multiple warnings in a single NPC.
        setFixture([
            {
                displayName: 'MultiIssueDroid',
                ai: { behavior: '', attackRange: -1 }
            }
        ]);

        const { worldStateController } = buildWorldState(tickSystem);
        worldStateController.initializeWorld();

        const entities = worldStateController.getAll().entities;
        const npcEntity = findNpcEntity(entities, 'MultiIssueDroid');
        expect(npcEntity).toBeDefined();
        // Both behavior invalid AND attackRange invalid → ai = null
        expect(npcEntity.npcConfig.ai).toBeNull();

        const aiWarnings = filterAiWarnings(warnSpy.mock.calls.map(c => c[0]));
        // Should have warnings for both behavior and attackRange
        const behaviorWarn = aiWarnings.find(w => w.includes('MultiIssueDroid') && w.includes('behavior'));
        const rangeWarn = aiWarnings.find(w => w.includes('MultiIssueDroid') && w.includes('attackRange'));
        expect(behaviorWarn).toBeDefined();
        expect(rangeWarn).toBeDefined();
    });
});

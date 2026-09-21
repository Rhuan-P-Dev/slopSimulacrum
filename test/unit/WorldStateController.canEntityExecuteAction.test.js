/**
 * WorldStateController — `canEntityExecuteAction` regression test.
 *
 * Validates the fix for the NPC AI capability gate bug:
 *   - `actionController.getActionRegistry?.()` was a dead call (the real method is `getRegistry()`),
 *     causing the method to always return false.
 *   - The self-heal fallback (full-scan when cache lacks an action entry) must work.
 *
 * Construction seam:
 *   - Uses `buildWorldState(tickSystem)` from the composition root to build the real facade
 *     with real sub-controllers (actionController + componentCapabilityController).
 *   - No DataLoader mock — real data files are used (same pattern as contract tests).
 *
 * @module test/unit/WorldStateController.canEntityExecuteAction
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

// =========================================================================
// Test setup — shared across all tests in this suite
// =========================================================================

let tickSystem;
let wsController;
let npcEntityId;

beforeAll(() => {
    // Build the real world state (mirrors src/server.js + contract test pattern).
    tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const result = buildWorldState(tickSystem);
    wsController = result.worldStateController;
    
    // Find an NPC entity that was spawned during initializeWorld().
    const state = wsController.getAll();
    const entities = state.entities || {};

    // Locate an entity with a move-capable component: the smallBallDroid is
    // the blueprint with organ function stats (move/strength/think); the live
    // registry no longer ships an un-gated NPC at all (crafterDrone removed;
    // killerLlmDrone env-gated OFF in the test environment). We locate it by
    // the presence of a move-capable component (a moveCore-granted rolling
    // ball).
    //
    // Historically this was the registry's "Rogue Droid" NPC, then the
    // crafterDrone world; both registry entries were removed from
    // data/npcs.json, so when no move-capable NPC is registered we spawn a
    // smallBallDroid through the public facade (the capability gate under
    // test is blueprint-driven, not isNPC-driven).
    const npcEntry = Object.values(entities).find(e => {
        if (!e.isNPC) return false;
        return (e.components || []).some(c => {
            const stats = wsController.getComponentStats(c.id);
            return typeof stats?.Movement?.move === 'number' && stats.Movement.move > 0;
        });
    });
    if (npcEntry) {
        npcEntityId = npcEntry.id;
    } else {
        const startRoomId = wsController.getRoomUidByLogicalId('start_room');
        npcEntityId = wsController.spawnEntity('smallBallDroid', startRoomId);
    }
});

afterAll(() => {
    if (tickSystem) {
        try { tickSystem.stop(); } catch (_) { /* ignore */ }
    }
    if (wsController) {
        try { wsController.dispose?.(); } catch (_) { /* ignore */ }
    }
});

// =========================================================================
// Test groups
// =========================================================================

describe('canEntityExecuteAction — regression test for NPC AI capability gate', () => {
    // -----------------------------------------------------------------
    // Test 1: NPC with 'move' capability should return true
    // -----------------------------------------------------------------

    it('should return true for an NPC that has a valid move capability', () => {
        if (!npcEntityId) {
            // No NPC was spawned (data issue); fail loudly for debugging.
            expect(true).toBe(false);
            return;
        }

        const result = wsController.canEntityExecuteAction(npcEntityId, 'move');
        expect(result).toBe(true);
    });

    // -----------------------------------------------------------------
    // Test 2: Bogus action name should return false
    // -----------------------------------------------------------------

    it('should return false for a non-existent action name', () => {
        if (!npcEntityId) {
            expect(true).toBe(false);
            return;
        }

        const result = wsController.canEntityExecuteAction(npcEntityId, 'nonexistent_action_xyz');
        expect(result).toBe(false);
    });

    // -----------------------------------------------------------------
    // Test 3: Null entity ID should return false
    // -----------------------------------------------------------------

    it('should return false for a null entity ID', () => {
        const result = wsController.canEntityExecuteAction(null, 'move');
        expect(result).toBe(false);
    });

    // -----------------------------------------------------------------
    // Test 4: Empty action name should return false
    // -----------------------------------------------------------------

    it('should return false for an empty action name', () => {
        const result = wsController.canEntityExecuteAction('some-entity', '');
        expect(result).toBe(false);
    });

    // -----------------------------------------------------------------
    // Test 5: Non-existent entity ID should return false
    // -----------------------------------------------------------------

    it('should return false for a non-existent entity ID', () => {
        const result = wsController.canEntityExecuteAction('ent-nonexistent-xyz', 'move');
        expect(result).toBe(false);
    });

    // -----------------------------------------------------------------
    // Test 6: Self-heal fallback — cache miss triggers full scan
    // This test verifies the self-heal path by removing only the 'move'
    // entry from the capability cache and ensuring the method still
    // returns true after triggering a full scan that repopulates it.
    // -----------------------------------------------------------------

    it('should self-heal via full-scan when cache lacks an action entry', () => {
        if (!npcEntityId) {
            expect(true).toBe(false);
            return;
        }

        // First, ensure the cache is populated (normal path).
        const initialResult = wsController.canEntityExecuteAction(npcEntityId, 'move');
        expect(initialResult).toBe(true);

        // Now remove only the 'move' entry from the capability cache to simulate
        // a scenario where this specific action's cache entry was invalidated.
        // We do NOT reassign _capabilityCache itself — we just delete the entry.
        const actionController = wsController.actionController;
        const capabilityController = actionController?.componentCapabilityController;
        expect(capabilityController).toBeDefined();

        const cache = capabilityController._capabilityCache;
        expect(cache).toBeDefined();
        expect(cache['move']).toBeDefined();

        // Delete only the 'move' entry.
        delete cache['move'];

        // After clearing the cache entry, calling canEntityExecuteAction should trigger
        // the self-heal fallback (scanAllCapabilities) which will repopulate the entire cache.
        const healedResult = wsController.canEntityExecuteAction(npcEntityId, 'move');
        expect(healedResult).toBe(true);
    });

    // -----------------------------------------------------------------
    // Test 7: Multiple actions — verify different action names work correctly
    // -----------------------------------------------------------------

    it('should return true for dash action if entity has movement component', () => {
        if (!npcEntityId) {
            expect(true).toBe(false);
            return;
        }

        const result = wsController.canEntityExecuteAction(npcEntityId, 'dash');
        // 'dash' requires Movement.move >= 10; the NPC's centralBall has move=20.
        expect(result).toBe(true);
    });
});

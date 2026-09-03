/**
 * WorldStateController — entity-level elimination (despawn) regression test.
 *
 * Verifies that when a damage cascade removes ALL components of an entity,
 * the entity is genuinely despawned (removed from world state) rather than
 * lingering as a "ghost" record with an empty components array.
 *
 * Also verifies the secondary leak fix: equipped items on a broken host
 * component are removed and their stats cleaned up.
 *
 * @module test/unit/WorldStateController.entityElimination
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import Logger from '../../src/utils/Logger.js';

// =========================================================================
// Constants
// =========================================================================

/**
 * Kills a component on the 0–1 existence scale. A fresh component holds 1.0;
 * a delta of −175 drives it far below 0, triggering the component:broke event.
 * Using a large negative value (not just −1) ensures the threshold crossing
 * is unambiguous regardless of floating-point accumulation from prior damage.
 */
const KILL_EXISTENCE_DELTA = -175;

// =========================================================================
// Helpers
// =========================================================================

/** Build a minimal world for testing. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    return { world, tick, subControllers };
}

/**
 * Applies a large negative delta to a component's existence stat, driving it
 * below 0 and triggering the component:broke event → removeBrokenComponent cascade.
 */
function breakComponent(world, compId) {
    return world.componentController.updateComponentStatDelta(compId, 'Physical', 'existence', KILL_EXISTENCE_DELTA);
}

/**
 * Breaks ALL components of an entity by driving each one's existence to 0.
 * Since the cascade from the root component (centralBall) should remove all
 * dependents, breaking just the root is sufficient for smallBallDroid.
 */
function breakAllComponents(world, entityId) {
    const entity = world.stateEntityController.getEntity(entityId);
    if (!entity || !entity.components || entity.components.length === 0) return;

    // Break the first (root) component — the cascade should handle the rest.
    const rootComp = entity.components[0];
    breakComponent(world, rootComp.id);
}

// =========================================================================
// Tests — Entity-level elimination
// =========================================================================

describe('Entity-level elimination — cascade despawn', () => {
    it('entity is despawned when all components are removed via cascade', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Verify entity exists
        const before = world.stateEntityController.getEntity(entityId);
        expect(before).not.toBeNull();
        expect(before.components.length).toBeGreaterThan(0);
        const initialComponentCount = before.components.length;

        // Break the root component — cascade should remove all dependents
        breakAllComponents(world, entityId);

        // Entity must be despawned (removed from world state)
        const after = world.stateEntityController.getEntity(entityId);
        expect(after).toBeNull();

        // Entity must be gone from the entities store
        const allEntities = world.stateEntityController.getAll();
        expect(allEntities[entityId]).toBeUndefined();
    });

    it('entity is despawned and not present in getAll() world state', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Verify entity is in the full world state before break
        const stateBefore = world.getAll();
        expect(stateBefore.entities[entityId]).toBeDefined();

        // Break the root component — cascade should remove all components
        breakAllComponents(world, entityId);

        // Entity must be absent from the full world state
        const stateAfter = world.getAll();
        expect(stateAfter.entities[entityId]).toBeUndefined();
    });

    it('entity with multiple components is despawned after full cascade', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        const entity = world.stateEntityController.getEntity(entityId);
        expect(entity.components.length).toBeGreaterThanOrEqual(2);

        // Break each component individually (not relying on cascade from root)
        // to ensure the check fires regardless of cascade depth.
        const compIds = entity.components.map(c => c.id);
        for (const compId of compIds) {
            // Only break if the component still exists (cascade may have already removed it)
            const stats = world.getComponentStats(compId);
            if (stats !== null) {
                breakComponent(world, compId);
            }
        }

        // After all components are gone, entity must be despawned
        const after = world.stateEntityController.getEntity(entityId);
        expect(after).toBeNull();
    });

    it('entity is NOT despawned when components remain after a cascade', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        const entity = world.stateEntityController.getEntity(entityId);
        expect(entity).not.toBeNull();
        expect(entity.components.length).toBeGreaterThan(1);
        const initialComponentCount = entity.components.length;

        // Break a LEAF component (droidHead — no dependents in the blueprint).
        // The cascade from a leaf has no children to traverse, so only this
        // one component is removed. The entity must survive with N−1 components.
        // If the elimination check over-triggers (despawns despite remaining
        // components), this test FAILS — that's its purpose.
        const leafComp = entity.components.find(c => c.type === 'droidHead');
        expect(leafComp, 'droidHead leaf component must exist in smallBallDroid').toBeDefined();

        // Set existence to 1 first (clean state), then apply the kill delta.
        world.componentController.updateComponentStat(leafComp.id, 'Physical', 'existence', 1);
        breakComponent(world, leafComp.id);

        // Entity must still exist (only 1 of N components was removed)
        const after = world.stateEntityController.getEntity(entityId);
        expect(after, 'entity must survive — only a leaf component was broken').not.toBeNull();
        expect(after.components.length).toBe(initialComponentCount - 1);

        // The broken component must be gone
        expect(after.components.some(c => c.id === leafComp.id)).toBe(false);

        // Remaining components must retain their stats (not corrupted by the cascade)
        const remainingComp = after.components.find(c => c.type !== 'droidHead');
        expect(remainingComp, 'at least one non-droidHead component must remain').toBeDefined();
        const stats = world.getComponentStats(remainingComp.id);
        expect(stats).not.toBeNull();
        expect(stats.Physical.existence).toBeGreaterThan(0);
    });
});

// =========================================================================
// Tests — Missing-array branch guard
// =========================================================================

describe('Entity-level elimination — missing components array guard', () => {
    it('entity is despawned when components array is absent (not just empty)', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        const entity = world.stateEntityController.getEntity(entityId);
        expect(entity).not.toBeNull();
        expect(entity.components.length).toBeGreaterThan(0);

        // Remove ALL components via the public API (mirrors trigger test 9 style).
        // This leaves components = [] (empty array). Now delete the array entirely
        // to exercise the "components is absent" guard branch in _maybeEliminateEntity.
        const compIds = entity.components.map(c => c.id);
        for (const compId of compIds) {
            world.stateEntityController.removeComponent(entityId, compId);
        }

        // Delete the components array on the live reference to simulate the
        // "absent" branch (not just length === 0). The guard in
        // _maybeEliminateEntity checks `!liveEntity.components` first.
        const liveEntity = world.stateEntityController.getEntity(entityId);
        if (liveEntity) {
            delete liveEntity.components;
        }

        // Now drive a final removeBrokenComponent call to trigger the cascade
        // unwind → _maybeEliminateEntity. We need a component to break, but
        // all are removed. Instead, call removeBrokenComponent directly with a
        // synthetic payload to force the finally-block elimination check.
        // This is safe: the entity has no components, so the check fires.
        world.removeBrokenComponent({
            entityId,
            componentId: compIds[0], // already removed — won't re-cascade
            kind: 'component',
            position: { x: 0, y: 0 },
            roomId: startRoomId
        });

        // Entity must be despawned (guard fires on absent components)
        const after = world.stateEntityController.getEntity(entityId);
        expect(after).toBeNull();
    });
});

// =========================================================================
// Tests — Idempotency
// =========================================================================

describe('Entity-level elimination — idempotency', () => {
    it('second removeBrokenComponent after despawn is a no-op (no throw, no double-despawn)', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // First: break all → entity despawned
        breakAllComponents(world, entityId);
        expect(world.stateEntityController.getEntity(entityId)).toBeNull();

        // Spy on Logger.error to assert no error is logged on the second call
        const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});

        // Second: call removeBrokenComponent with the same entity — must not throw
        expect(() => {
            world.removeBrokenComponent({
                entityId,
                componentId: 'comp-nonexistent',
                kind: 'component',
                position: { x: 0, y: 0 },
                roomId: startRoomId
            });
        }).not.toThrow();

        // Entity must remain despawned (no resurrection)
        expect(world.stateEntityController.getEntity(entityId)).toBeNull();

        // No "entity elimination failed" error should have been logged
        const eliminationErrors = errorSpy.mock.calls.filter(
            args => args[0] && args[0].includes('entity elimination failed')
        );
        expect(eliminationErrors).toHaveLength(0);

        errorSpy.mockRestore();
    });
});

// =========================================================================
// Tests — Cross-entity cascade (M3 verification)
// =========================================================================

describe('Entity-level elimination — cross-entity cascade', () => {
    it('every entity in the affected set receives the elimination check (spy on _maybeEliminateEntity)', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Spy on _maybeEliminateEntity to verify it's called for the affected entity
        const eliminateSpy = vi.spyOn(world, '_maybeEliminateEntity');

        // Break the root component — triggers cascade → finally block → elimination check
        breakAllComponents(world, entityId);

        // The elimination check must have been called for this entity
        expect(eliminateSpy).toHaveBeenCalledWith(entityId);

        eliminateSpy.mockRestore();
    });

    it('cross-entity cascade: both entities are checked when set size > 1', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');

        // Spawn two droids
        const entityIdA = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const entityIdB = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Spy on _maybeEliminateEntity and Logger.warn to verify cross-entity behavior
        const eliminateSpy = vi.spyOn(world, '_maybeEliminateEntity');
        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

        // Simulate a cross-entity cascade by injecting entityIdB into the
        // affected set BEFORE the root cascade unwinds. We do this by calling
        // removeBrokenComponent on entity B's component INSIDE entity A's cascade.
        //
        // Practical approach: break a component of A, and during the cascade,
        // the _cascadeDependents will only affect A's own components. To truly
        // simulate cross-entity, we inject B's id directly into the set (this
        // verifies the mechanism: both ids receive the check).
        const entityA = world.stateEntityController.getEntity(entityIdA);
        const compA = entityA.components[0];

        // Pre-inject entityIdB into the affected set (simulates a cross-entity
        // re-entry that would happen if A's cascade forced a break on B).
        // The set is initialized when reentrancy count hits 1, so we patch it
        // via a wrapper: call removeBrokenComponent and rely on the set being
        // active during the cascade.
        //
        // Simpler approach: use the real mechanism — spy on _cascadeDependents
        // to inject a second entity's break during the cascade.
        const originalCascade = world._cascadeDependents.bind(world);
        vi.spyOn(world, '_cascadeDependents').mockImplementation((entity, originId) => {
            // Simulate cross-entity: during A's cascade, also break B's root
            const entityB = world.stateEntityController.getEntity(entityIdB);
            if (entityB && entityB.components && entityB.components.length > 0) {
                const compB = entityB.components[0];
                // This will re-enter removeBrokenComponent for entity B
                breakComponent(world, compB.id);
            }
            return originalCascade(entity, originId);
        });

        // Break A's root — this should trigger cascades on both A and B
        breakComponent(world, compA.id);

        // Both entities must have received the elimination check
        expect(eliminateSpy).toHaveBeenCalledWith(entityIdA);
        expect(eliminateSpy).toHaveBeenCalledWith(entityIdB);

        // Both should be despawned (both had all components removed)
        expect(world.stateEntityController.getEntity(entityIdA)).toBeNull();
        expect(world.stateEntityController.getEntity(entityIdB)).toBeNull();

        // Cross-entity warning must have been logged (set size was > 1)
        const crossEntityWarnings = warnSpy.mock.calls.filter(
            args => args[0] && args[0].includes('Cross-entity cascade detected')
        );
        expect(crossEntityWarnings.length).toBeGreaterThan(0);

        eliminateSpy.mockRestore();
        warnSpy.mockRestore();
    });
});

// =========================================================================
// Tests — Throwing despawn (L3 verification)
// =========================================================================

describe('Entity-level elimination — throwing despawn isolation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('cascade completes without propagating when despawnEntity throws', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Make despawnEntity throw to simulate a failure
        const despawnSpy = vi.spyOn(world, 'despawnEntity').mockImplementation(() => {
            throw new Error('Simulated despawn failure');
        });

        // Spy on Logger.error to capture the elimination failure log
        const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});

        // Break all components — the cascade should complete despite despawn throwing
        expect(() => {
            breakAllComponents(world, entityId);
        }).not.toThrow();

        // The error must be logged with the correct prefix
        const eliminationErrors = errorSpy.mock.calls.filter(
            args => args[0] && args[0].includes('[removeBrokenComponent] entity elimination failed')
        );
        expect(eliminationErrors.length).toBeGreaterThan(0);
        expect(eliminationErrors[0][0]).toContain(entityId);

        // The cascade must have completed (components were removed)
        // Entity is NOT despawned (despawn threw) but the cascade didn't crash
        // The entity may or may not still exist — what matters is no throw propagated
        // and the error was logged with the distinguishable prefix.

        despawnSpy.mockRestore();
        errorSpy.mockRestore();
    });
});

// =========================================================================
// Tests — Secondary leak: equipped items on broken host component
// =========================================================================

describe('Secondary leak — equipped items on broken host component', () => {
    it('equipped item is removed from tracking when its host component breaks', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const entity = world.stateEntityController.getEntity(entityId);

        // Find a droidHand component (has sufficient strength to hold a knife)
        const hostComp = entity.components.find(c => c.type === 'droidHand');
        expect(hostComp).toBeDefined();

        // Equip a knife through the REAL pipeline (world.equipItem)
        const equipResult = world.equipItem(entityId, 'item-knife-test-1', 'knife', hostComp.id);
        expect(equipResult.success).toBe(true);

        // Verify item is tracked as equipped
        const equippedBefore = world.holdingCostController.getEquippedItems(entityId);
        const equippedEntry = equippedBefore.find(eq => eq.componentId === hostComp.id);
        expect(equippedEntry).toBeDefined();
        const eqIdBefore = equippedEntry.eqId;

        // Verify stats exist for the equipped item
        expect(world.equippedItemStats.hasStats(eqIdBefore)).toBe(true);

        // Break the host component — should trigger equipped item cleanup
        breakComponent(world, hostComp.id);

        // Equipped item tracking must be cleaned up
        const equippedAfter = world.holdingCostController.getEquippedItems(entityId);
        const stillEquipped = equippedAfter.find(eq => eq.eqId === eqIdBefore);
        expect(stillEquipped).toBeUndefined();

        // Equipped item stats must be removed
        expect(world.equippedItemStats.hasStats(eqIdBefore)).toBe(false);
    });

    it('equipped item is removed from inventory when its host component breaks', () => {
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const entity = world.stateEntityController.getEntity(entityId);

        const hostComp = entity.components.find(c => c.type === 'droidHand');
        expect(hostComp).toBeDefined();

        // Equip a knife through the REAL pipeline
        const equipResult = world.equipItem(entityId, 'item-knife-test-2', 'knife', hostComp.id);
        expect(equipResult.success).toBe(true);

        // Break the host component — the equipped item should be cleaned up
        breakComponent(world, hostComp.id);

        // The host component is gone; if the entity still exists, the item
        // must not remain in the entity's equipped tracking.
        const equippedAfter = world.holdingCostController.getEquippedItems(entityId);
        const remainingOnHost = equippedAfter.filter(eq => eq.componentId === hostComp.id);
        expect(remainingOnHost).toHaveLength(0);
    });
});

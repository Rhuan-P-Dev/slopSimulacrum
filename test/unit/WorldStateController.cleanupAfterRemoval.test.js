/**
 * WorldStateController._cleanupAfterRemoval — internal component resync regression test.
 *
 * Verifies the fix for B3#9: after removing internal components during a broken-component
 * cascade, _cleanupAfterRemoval must resync the owning entity's `internalComponents` snapshot
 * with the authoritative list from InternalComponentController, preventing stale ids.
 *
 * NOTE: This test uses a narrow unit approach — it directly invokes `_cleanupAfterRemoval`
 * with minimum real objects wired, rather than exercising the full public broken-component
 * flow (which would require building a full existence-breaking cascade).
 *
 * @module test/unit/WorldStateController.cleanupAfterRemoval
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

// =========================================================================
// Helpers
// =========================================================================

/** Build a minimal world for testing. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const result = buildWorldState(tick);
    return { world: result.worldStateController, tick, subControllers: result.subControllers };
}

/**
 * Add an internal component instance to a host component on an entity.
 * Uses the InternalComponentController directly (bypassing auto-install).
 */
function addInternalComponentToWorld(world, entityId, hostComponentId, internalType) {
    world.internalComponentController.addInternalComponent(entityId, hostComponentId, internalType);
}

/**
 * Sync entity's internalComponents from the authoritative InternalComponentController.
 * Mimics what spawnEntity does at stateEntityController.js:~94.
 */
function syncInternalComponents(world, entityId) {
    const entity = world.getEntity(entityId);
    if (entity) {
        entity.internalComponents = world.internalComponentController.getInternalComponentsForEntity(entityId);
    }
}

// =========================================================================
// Tests — B3#9: _cleanupAfterRemoval resyncs internalComponents after cascade
// =========================================================================

describe('B3#9 — _cleanupAfterRemoval internal component resync', () => {
    it('entity.internalComponents is resynced after _cleanupAfterRemoval removes internal components', () => {
        const { world } = buildWorld();

        // 1. Spawn a droid entity
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const entity = world.getEntity(entityId);
        expect(entity).not.toBeNull();

        // 2. Find the centralBall component (host for internal components)
        const centralBall = entity.components.find(c => c.type === 'centralBall');
        expect(centralBall).toBeDefined();
        const hostComponentId = centralBall.id;

        // 3. Manually add an internal component to the host component
        addInternalComponentToWorld(world, entityId, hostComponentId, 'repairSphere');

        // 4. Sync entity's internalComponents so it matches the authoritative state
        syncInternalComponents(world, entityId);

        // Verify: entity has the internal component before removal
        const beforeSync = world.internalComponentController.getInternalComponentsForEntity(entityId);
        expect(beforeSync).toHaveProperty(hostComponentId);
        expect(beforeSync[hostComponentId].length).toBeGreaterThan(0);
        const icIdBefore = beforeSync[hostComponentId][0].id;
        expect(entity.internalComponents).toHaveProperty(hostComponentId);
        expect(entity.internalComponents[hostComponentId].some(ic => ic.id === icIdBefore)).toBe(true);

        // 5. Call _cleanupAfterRemoval directly, simulating the broken-component cascade path
        // This removes internal components from the host component via the loop at lines 2376-2379
        world._cleanupAfterRemoval(entity, {
            componentId: centralBall.id,
            kind: 'component'
        });

        // 6. Assert: entity.internalComponents no longer contains the removed internal component id
        const afterSync = world.internalComponentController.getInternalComponentsForEntity(entityId);

        // The authoritative source should have no internal components for this host (they were removed)
        // or at least not contain the removed icId
        if (afterSync[hostComponentId]) {
            expect(afterSync[hostComponentId].some(ic => ic.id === icIdBefore)).toBe(false);
        }

        // The entity's snapshot must match the authoritative list (the core fix)
        expect(entity.internalComponents).toEqual(afterSync);

        // Specifically, if the host still exists in internalComponents, it should not have stale ids
        if (entity.internalComponents[hostComponentId]) {
            expect(entity.internalComponents[hostComponentId].some(ic => ic.id === icIdBefore)).toBe(false);
        }
    });

    it('entity.internalComponents matches authoritative list after _cleanupAfterRemoval with multiple internal components', () => {
        const { world } = buildWorld();

        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const entity = world.getEntity(entityId);
        expect(entity).not.toBeNull();

        const centralBall = entity.components.find(c => c.type === 'centralBall');
        const hostComponentId = centralBall.id;

        // Add two internal components to the same host
        addInternalComponentToWorld(world, entityId, hostComponentId, 'repairSphere');
        addInternalComponentToWorld(world, entityId, hostComponentId, 'moveCore');

        syncInternalComponents(world, entityId);

        const beforeSync = world.internalComponentController.getInternalComponentsForEntity(entityId);
        expect(beforeSync[hostComponentId].length).toBe(2);
        const icIdsBefore = beforeSync[hostComponentId].map(ic => ic.id);

        // Call _cleanupAfterRemoval
        world._cleanupAfterRemoval(entity, {
            componentId: centralBall.id,
            kind: 'component'
        });

        const afterSync = world.internalComponentController.getInternalComponentsForEntity(entityId);

        // Entity snapshot must match authoritative source exactly
        expect(entity.internalComponents).toEqual(afterSync);

        // None of the removed ids should remain
        if (afterSync[hostComponentId]) {
            for (const removedId of icIdsBefore) {
                expect(afterSync[hostComponentId].some(ic => ic.id === removedId)).toBe(false);
            }
        }
        if (entity.internalComponents[hostComponentId]) {
            for (const removedId of icIdsBefore) {
                expect(entity.internalComponents[hostComponentId].some(ic => ic.id === removedId)).toBe(false);
            }
        }
    });
});

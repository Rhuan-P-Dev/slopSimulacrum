/**
 * Contract tests for material-traits persistence and display.
 *
 * Two scenarios:
 * 1. A fresh world adds knife items via inventory system — they get material-derived
 *    traits (mass, flammability). After serialize/restore, those traits survive.
 * 2. An old-format snapshot (items missing material stats) is restored — resyncItemTraits
 *    fills them in automatically.
 * 3. getItemStats returns material-derived stats for a knife item.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a knife item in the inventory manager's internal store.
 * @param {Object} inventoryManager - The InventoryManager instance.
 * @param {string} entityId - Entity ID to check.
 * @returns {{ item: Object, itemId: string } | null}
 */
function findKnifeInInventoryManager(inventoryManager, entityId) {
    const entityInv = inventoryManager._inventory[entityId];
    if (!entityInv) return null;
    for (const [itemId, item] of Object.entries(entityInv)) {
        if (item.type === 'knife') {
            return { item, itemId };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Material traits — persistence contract', () => {
    let world;
    let entityId;

    beforeEach(() => {
        world = buildWorldState();
        // Spawn an entity to hold items.
        const wsc = world.worldStateController;
        const stateEntityController = world.subControllers.stateEntityController;

        // Use the entity controller to create an entity from a blueprint.
        const blueprint = 'merchantCore';
        const roomId = Object.keys(wsc.roomsController.getAll())[0] || 'room-1';
        entityId = stateEntityController.spawnEntity(blueprint, roomId);
    });

    it('fresh-spawn knife items have material-derived mass and flammability in serialized snapshot', () => {
        const wsc = world.worldStateController;

        // Add a knife to the entity's component.
        const result = wsc.addItemToEntity(entityId, 'knife', 'merchantCore-1');
        expect(result.success).toBe(true);

        // Check inventory via InventoryManager.
        const knifeData = findKnifeInInventoryManager(world.subControllers.inventoryManager, entityId);
        expect(knifeData, 'an entity should have a knife item in inventory').toBeTruthy();

        // Verify material-derived stats are present.
        expect(knifeData.item.traits.Physical.mass).toBeCloseTo(4.92, 1);
        expect(knifeData.item.traits.Physical.flammability).toBe(35);
    });

    it('restored snapshot retains material-derived traits on knife items', () => {
        const wsc = world.worldStateController;

        // Add a knife to the entity.
        const addResult = wsc.addItemToEntity(entityId, 'knife', 'merchantCore-1');
        expect(addResult.success).toBe(true);
        const knifeItemId = addResult.item.id;

        // Check before serialize.
        let knifeData = findKnifeInInventoryManager(world.subControllers.inventoryManager, entityId);
        expect(knifeData, 'knife found before serialize').toBeTruthy();
        expect(knifeData.item.traits.Physical.mass).toBeCloseTo(4.92, 1);

        // Serialize.
        const originalSnapshot = wsc.serialize();

        // Verify snapshot contains the knife with material stats.
        const snapshotInventory = originalSnapshot.state.inventory[entityId];
        expect(snapshotInventory[knifeItemId].traits.Physical.mass).toBeCloseTo(4.92, 1);
        expect(snapshotInventory[knifeItemId].traits.Physical.flammability).toBe(35);

        // Restore the snapshot.
        const restoreResult = wsc.restore(originalSnapshot);
        expect(restoreResult.success).toBe(true);

        // Check inventory after restore — resyncItemTraits should have re-derived.
        knifeData = findKnifeInInventoryManager(world.subControllers.inventoryManager, entityId);
        expect(knifeData, 'a knife item must survive restore').toBeTruthy();
        // Material stats should be present (either from original serialization or re-derivation).
        expect(knifeData.item.traits.Physical.mass).toBeCloseTo(4.92, 1);
        expect(knifeData.item.traits.Physical.flammability).toBe(35);
    });

    it('old-format snapshot (missing material stats) gets them after restore via resyncItemTraits', () => {
        const wsc = world.worldStateController;

        // Add a knife to the entity.
        const addResult = wsc.addItemToEntity(entityId, 'knife', 'merchantCore-1');
        expect(addResult.success).toBe(true);
        const knifeItemId = addResult.item.id;

        // Serialize and then tamper with the snapshot: strip mass and flammability from items.
        const originalSnapshot = wsc.serialize();

        // Strip from the inventory index.
        for (const entityInv of Object.values(originalSnapshot.state.inventory)) {
            if (!entityInv) continue;
            for (const item of Object.values(entityInv)) {
                if (item.traits && item.traits.Physical) {
                    delete item.traits.Physical.mass;
                    delete item.traits.Physical.flammability;
                }
            }
        }

        // Verify tampering worked.
        const tamperedKnife = originalSnapshot.state.inventory[entityId][knifeItemId];
        expect(tamperedKnife).toBeDefined();
        expect(tamperedKnife.traits.Physical.mass).toBeUndefined();
        expect(tamperedKnife.traits.Physical.flammability).toBeUndefined();

        // Restore the tampered snapshot.
        const restoreResult = wsc.restore(originalSnapshot);
        expect(restoreResult.success).toBe(true);

        // Check inventory after restore — resyncItemTraits should have filled in missing stats.
        const knifeData = findKnifeInInventoryManager(world.subControllers.inventoryManager, entityId);
        expect(knifeData, 'a knife item must survive restore').toBeTruthy();
        // resyncItemTraits should have filled in the missing material stats.
        expect(knifeData.item.traits.Physical.mass).toBeCloseTo(4.92, 1);
        expect(knifeData.item.traits.Physical.flammability).toBe(35);
    });
});

describe('Material traits — getItemStats display', () => {
    let world;
    let entityId;
    let knifeItemId;

    beforeEach(() => {
        world = buildWorldState();
        const wsc = world.worldStateController;
        const stateEntityController = world.subControllers.stateEntityController;

        // Spawn an entity.
        const blueprint = 'merchantCore';
        const roomId = Object.keys(wsc.roomsController.getAll())[0] || 'room-1';
        entityId = stateEntityController.spawnEntity(blueprint, roomId);

        // Add a knife to the entity and capture the returned item ID.
        const result = wsc.addItemToEntity(entityId, 'knife', 'merchantCore-1');
        expect(result.success).toBe(true);
        knifeItemId = result.item.id;
    });

    it('getItemStats returns material-derived stats for a knife item', () => {
        const wsc = world.worldStateController;

        // Call getItemStats.
        const stats = wsc.getItemStats(entityId, knifeItemId);
        expect(stats).toBeTruthy();
        expect(stats._baseStats).toBeDefined();

        // Material-derived stats should be in _baseStats.
        expect(stats._baseStats.mass).toBeCloseTo(4.92, 1);
        expect(stats._baseStats.flammability).toBe(35);
    });
});

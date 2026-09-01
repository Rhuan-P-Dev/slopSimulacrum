/**
 * CONTRACT TEST — dropItem spatial range enforcement (the drop-range bug).
 *
 * Regression guarded: the original drop-range bug let the client DISPLAY one range
 * while the server ENFORCED another (or nothing), so a player could drop an item at
 * any coordinate. The fix made the server enforce the SAME range the client displays
 * (single source of truth: data/actions.json dropItem.range, resolved through the
 * shared RangeResolver).
 *
 * This is a higher-level integration test that verifies the FULL server path
 *   executeAction() → ActionController._validateRange() → RangeValidator.checkSpatialRange()
 *   → RangeChecker.checkPointRange()
 * using the REAL WorldStateController (built via the composition root, same as the
 * other contract tests) and the REAL data/actions.json range value. It drives
 * worldStateController.executeAction('dropItem', ...) directly — the exact method the
 * POST /execute-action route delegates to (src/routes/actionRoutes.js) — so the
 * route → controller → validator → checker contract is covered without the socket.io
 * / HTTP plumbing.
 *
 *   1. A drop target OUTSIDE the enforced range is REJECTED with the point-target
 *      message ("Target is too far away") — NOT the grab message.
 *   2. A drop target WITHIN range is ACCEPTED (success: true), proving the enforced
 *      boundary matches data/actions.json dropItem.range.
 *
 * @module test/contract/dropItemSpatialRange.contract.test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';

/**
 * Reads the REAL dropItem.range from data/actions.json so the test validates the
 * actual configured range (not a hardcoded fixture).
 */
function readDropItemRange() {
    const dataPath = new URL('../../data/actions.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(dataPath), 'utf8');
    return JSON.parse(raw).dropItem.range;
}

/**
 * Creates a fully-constructed WorldStateController with a test droid, and returns
 * handles for the droid entity and one of its components (with a knife in its
 * inventory so the dropItem consequence can drop a real item).
 *
 * @returns {{ world: import('../../src/controllers/WorldStateController.js'), entityId: string, componentId: string, itemId: string, itemType: string }}
 */
function createWorldWithDroid() {
    const { worldStateController: world } = buildWorldState(null);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

    // Find the client droid (not an NPC — data/npcs.json spawns a Rogue Droid).
    const allEntities = Object.values(world.stateEntityController.entities);
    const entity = allEntities.find(e => e.isNPC !== true) || allEntities[0];
    expect(entity, 'a client droid must be spawned').toBeTruthy();

    // The dropItem action requires the host component to possess strength
    // (data/actions.json requirement). Use a holding-capable droidHand (which
    // carries a strengthCore and thus strength) as the host component.
    const component =
        entity.components.find(c => c.type === 'droidHand') ||
        entity.components.find(c => c.type === 'droidArm') ||
        entity.components[0];
    expect(component, 'the droid must have at least one component').toBeTruthy();

    // Give the droid a knife to drop (the drop-range contract is item-type-
    // agnostic; a knife is a standard held item). Use the public addItemToEntity
    // API on the strength-bearing component, then locate it in the inventory.
    const add = world.addItemToEntity(entity.id, 'knife', component.id);
    expect(add.success, 'the droid must be able to hold a knife to drop it').toBe(true);

    const inventory = world.getEntityItems(entity.id);
    let droppable = null;
    for (const items of Object.values(inventory)) {
        const found = (items || []).find(item => item && item.id);
        if (found) {
            droppable = found;
            break;
        }
    }
    expect(droppable, 'a droppable item must be available in the droid inventory').toBeTruthy();

    return {
        world,
        entityId: entity.id,
        componentId: component.id,
        itemId: droppable.id,
        itemType: droppable.type
    };
}

describe('dropItem spatial range enforcement (drop-range regression)', () => {
    it('REJECTS a drop target OUTSIDE the enforced range with the point-target message', () => {
        const dropRange = readDropItemRange();
        const { world, entityId, componentId, itemId, itemType } = createWorldWithDroid();

        // Target far beyond the enforced range on the +X axis.
        const result = world.executeAction('dropItem', entityId, {
            componentId,
            itemId,
            itemType,
            targetX: dropRange + 100,
            targetY: 0
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        // The spatial (point-target) failure message — NOT the grab-target message.
        expect(result.error).toContain('Target is too far away');
        expect(result.error).not.toContain('Item is too far away');
        expect(result.error).not.toContain('Move closer to grab it');
    });

    it('ACCEPTS a drop target WITHIN the enforced range (boundary matches data/actions.json)', () => {
        const dropRange = readDropItemRange();
        const { world, entityId, componentId, itemId, itemType } = createWorldWithDroid();

        // Target well inside the enforced range (halfway to the boundary on +X).
        const result = world.executeAction('dropItem', entityId, {
            componentId,
            itemId,
            itemType,
            targetX: Math.floor(dropRange / 2),
            targetY: 0
        });

        expect(result.success).toBe(true);
    });
});

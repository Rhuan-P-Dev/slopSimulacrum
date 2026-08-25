/**
 * Unit tests for InventoryManager material-traits derivation.
 *
 * Verifies that items with a materials composition get their traits merged
 * (material-derived under, blueprint overrides on top), and that items without
 * materials or a null controller are backward-compatible passthroughs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import InventoryManager from '../../src/utils/InventoryManager.js';
import MaterialController from '../../src/controllers/materials/MaterialController.js';

// ---------------------------------------------------------------------------
// Shared fixtures (mirror data/materials.json + propertyTraitMapping.json)
// ---------------------------------------------------------------------------

const materialsRegistry = {
    wood: {
        name: 'Wood',
        density: 0.6,
        properties: {
            flammability: 80,
            electricalConduction: 5,
            moistureRetention: 60,
            cutResistance: 20,
            impactResistance: 70,
            wearResistance: 30,
            heatConduction: 15
        }
    },
    iron: {
        name: 'Iron',
        density: 7.8,
        properties: {
            flammability: 5,
            electricalConduction: 90,
            moistureRetention: 0,
            cutResistance: 85,
            impactResistance: 45,
            wearResistance: 80,
            heatConduction: 85
        }
    }
};

const mappingRegistry = {
    'Physical.mass': { formula: 'densityVolume' },
    'Physical.durability': {
        sources: { wearResistance: 0.5, impactResistance: 0.3, cutResistance: 0.2 }
    },
    'Physical.flammability': { sources: { flammability: 1.0 } }
};

const itemDefinitions = {
    knife: {
        name: 'Knife',
        volume: 1,
        materials: [
            { material: 'iron', fraction: 0.6, role: 'blade' },
            { material: 'wood', fraction: 0.4, role: 'handle' }
        ],
        traits: { Physical: { durability: 30, sharpness: 50 } }
    },
    metalBox: {
        name: 'Metal Box',
        volume: 10,
        materials: [{ material: 'iron', fraction: 1.0 }],
        traits: { Physical: { mass: 2, durability: 100 } }
    },
    powerCell: {
        name: 'Power Cell',
        volume: 2,
        // No materials field — backward-compatible passthrough
        traits: { Physical: { mass: 1, durability: 50 } }
    }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createManager({ materialController = null } = {}) {
    const manager = new InventoryManager({ materialController });
    // Replace the internal item definitions with our test fixtures.
    // We directly set _itemDefinitions to override DataLoader results.
    manager._itemDefinitions = itemDefinitions;
    return manager;
}

function makeEntity(id = 'entity-1') {
    return { id, components: [], items: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InventoryManager — material traits derivation', () => {
    let controller;

    beforeEach(() => {
        controller = new MaterialController(materialsRegistry, mappingRegistry);
    });

    // ---- Knife (has materials) ------------------------------------------

    it('knife instance traits contain material-derived mass (~4.92)', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'knife', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        expect(item.traits.Physical.mass).toBeCloseTo(4.92, 1);
    });

    it('knife instance traits contain material-derived flammability (35)', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'knife', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        // 0.6*5 + 0.4*80 = 3 + 32 = 35
        expect(item.traits.Physical.flammability).toBe(35);
    });

    it('knife blueprint override wins for durability (30, not ~58.3)', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'knife', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        // Material-derived durability ~58.3 but blueprint overrides to 30
        expect(item.traits.Physical.durability).toBe(30);
    });

    it('knife preserves blueprint sharpness (50)', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'knife', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        expect(item.traits.Physical.sharpness).toBe(50);
    });

    it('knife stats panel display: mass, durability, sharpness, flammability all present', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'knife', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        expect(item.traits.Physical.mass).toBeDefined();
        expect(item.traits.Physical.durability).toBe(30);
        expect(item.traits.Physical.sharpness).toBe(50);
        expect(item.traits.Physical.flammability).toBe(35);
    });

    // ---- metalBox (single-material, 100% iron) --------------------------

    it('metalBox: blueprint mass override (2) wins over material-derived (78)', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'metalBox', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        // Blueprint has mass: 2 which overrides derived 78
        expect(item.traits.Physical.mass).toBe(2);
        // But flammability (5) comes from material since blueprint doesn't override it
        expect(item.traits.Physical.flammability).toBe(5);
    });

    // ---- powerCell (no materials) ----------------------------------------

    it('powerCell without materials gets raw blueprint traits', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'powerCell', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        // No materials → traits unchanged from blueprint
        expect(item.traits.Physical.mass).toBe(1);
        expect(item.traits.Physical.durability).toBe(50);
        expect(item.traits.Physical.flammability).toBeUndefined();
    });

    it('powerCell with null controller gets raw blueprint traits', () => {
        const manager = createManager({ materialController: null });
        const entity = makeEntity();
        const result = manager.addItem(entity, 'knife', 'comp-1');
        expect(result.success).toBe(true);

        const item = entity.items[0];
        // Null controller → traits unchanged from blueprint (no mass/flammability)
        expect(item.traits.Physical.durability).toBe(30);
        expect(item.traits.Physical.sharpness).toBe(50);
        expect(item.traits.Physical.mass).toBeUndefined();
        expect(item.traits.Physical.flammability).toBeUndefined();
    });

    // ---- addItemToContainer (children) -----------------------------------

    it('container child (knife inside metalBox) also gets material-derived traits', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();

        // Add container first
        const boxResult = manager.addItem(entity, 'metalBox', 'comp-1');
        expect(boxResult.success).toBe(true);

        // Add child into container
        const childResult = manager.addItemToContainer(entity, boxResult.item.id, 'knife');
        expect(childResult.success).toBe(true);

        const childItem = entity.items.find(i => i.hostComponentId === boxResult.item.id);
        expect(childItem).toBeDefined();
        expect(childItem.traits.Physical.mass).toBeCloseTo(4.92, 1);
        expect(childItem.traits.Physical.flammability).toBe(35);
    });

    // ---- resyncItemTraits (restore idempotence) --------------------------

    it('resyncItemTraits re-derives traits for items missing material stats', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();

        // Simulate an old-format item: raw blueprint traits only (no material stats).
        // We manually create the item to bypass _mergeItemTraits.
        manager._ensureEntityInventory(entity.id);
        const oldItem = {
            id: 'old-item-1',
            type: 'knife',
            name: 'Knife',
            volume: 1,
            hostVolume: 1,
            externalVolume: null,
            traits: { Physical: { durability: 30, sharpness: 50 } }, // no mass/flammability
            hostComponentId: 'comp-1'
        };
        entity.items.push(oldItem);
        manager._inventory[entity.id][oldItem.id] = oldItem;

        // Run resync — should add material-derived stats.
        manager.resyncItemTraits();

        expect(oldItem.traits.Physical.mass).toBeCloseTo(4.92, 1);
        expect(oldItem.traits.Physical.flammability).toBe(35);
    });

    it('resyncItemTraits is idempotent: re-merging already-merged traits yields same result', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();

        // Fresh item (already has merged traits).
        const result = manager.addItem(entity, 'knife', 'comp-1');
        expect(result.success).toBe(true);
        const item = entity.items[0];
        const massBefore = item.traits.Physical.mass;
        const flammBefore = item.traits.Physical.flammability;

        // Re-sync again.
        manager.resyncItemTraits();

        // Values should be identical.
        expect(item.traits.Physical.mass).toBeCloseTo(massBefore, 1);
        expect(item.traits.Physical.flammability).toBe(flammBefore);
    });

    it('resyncItemTraits on items without materials is a no-op', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();

        const result = manager.addItem(entity, 'powerCell', 'comp-1');
        expect(result.success).toBe(true);
        const item = entity.items[0];
        const traitsBefore = JSON.stringify(item.traits);

        manager.resyncItemTraits();

        expect(JSON.stringify(item.traits)).toBe(traitsBefore);
    });

    // ---- resyncItemTraits — tampered values preserved (fill-only contract) ---

    it('resyncItemTraits PRESERVES tampered (persisted) trait values while filling missing keys', () => {
        const manager = createManager({ materialController: controller });
        const entity = makeEntity();

        // Simulate an old-format item whose persisted traits were TAMPERED (changed from derived).
        // The derived mass for knife is ~4.92 and flammability is 35.
        // We set mass to a tampered value (999) while leaving flammability missing.
        manager._ensureEntityInventory(entity.id);
        const tamperedItem = {
            id: 'tampered-item-1',
            type: 'knife',
            name: 'Knife',
            volume: 1,
            hostVolume: 1,
            externalVolume: null,
            traits: { Physical: { durability: 30, sharpness: 50, mass: 999 } }, // mass tampered
            hostComponentId: 'comp-1'
        };
        entity.items.push(tamperedItem);
        manager._inventory[entity.id][tamperedItem.id] = tamperedItem;

        // Run resync — should fill missing keys (flammability) but preserve tampered mass.
        manager.resyncItemTraits();

        // Tampered value MUST be preserved (fill-only, not overwrite).
        expect(tamperedItem.traits.Physical.mass).toBe(999);
        // Missing key MUST be filled from derived values.
        expect(tamperedItem.traits.Physical.flammability).toBe(35);
        // Blueprint overrides should still be present.
        expect(tamperedItem.traits.Physical.durability).toBe(30);
        expect(tamperedItem.traits.Physical.sharpness).toBe(50);
    });
});

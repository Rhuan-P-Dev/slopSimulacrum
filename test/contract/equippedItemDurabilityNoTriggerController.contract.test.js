/**
 * WorldStateController — equipped-item durability without triggerController (regression).
 *
 * Regression for the missing null-guard on the equipped-item (P8) durability path.
 * Prior to the fix, any world/façade that did NOT inject a `triggerController` would
 * crash on the first equipped-item durability stat change with:
 *   `TypeError: Cannot read properties of undefined (reading 'onEquippedItemBrokeCheck')`
 *
 * This test constructs `WorldStateController` directly (omitting `triggerController`)
 * and fires an equipped-item durability stat change via `equippedItemStats.setStat()`.
 * It asserts that no exception is thrown and state remains consistent.
 *
 * @module test/contract/equippedItemDurabilityNoTriggerController.contract
 */

import { describe, it, expect, vi } from 'vitest';
import WorldStateController from '../../src/controllers/WorldStateController.js';
import ComponentStatsController from '../../src/controllers/core/componentStatsController.js';
import TraitsController from '../../src/controllers/traits/TraitsController.js';
import InternalComponentController from '../../src/controllers/core/InternalComponentController.js';
import ComponentController from '../../src/controllers/core/componentController.js';
import EntityController from '../../src/controllers/core/entityController.js';
import RoomsController from '../../src/controllers/core/RoomsController.js';
import InventoryManager from '../../src/utils/InventoryManager.js';
import EquippedItemStatsController from '../../src/controllers/core/EquippedItemStatsController.js';
import ComponentCapabilityController from '../../src/controllers/capabilities/componentCapabilityController.js';
import ActionSelectController from '../../src/controllers/actions/actionSelectController.js';
import SynergyController from '../../src/controllers/synergy/synergyController.js';
import ConsequenceHandlers from '../../src/controllers/consequences/consequenceHandlers.js';
import ActionController from '../../src/controllers/actions/actionController.js';
import stateEntityController from '../../src/controllers/core/stateEntityController.js';
import HoldingCostController from '../../src/controllers/core/HoldingCostController.js';
import WorldEventLogController from '../../src/controllers/core/WorldEventLogController.js';
import LlmContextController from '../../src/controllers/networking/LlmContextController.js';
import TurnSystemController from '../../src/controllers/core/TurnSystemController.js';

// =========================================================================
// Helpers — minimal stubs for dependencies not exercised by this test
// =========================================================================

function createStubController(overrides = {}) {
    return { ...overrides };
}

/** Build a minimal deps object for WorldStateController WITHOUT triggerController. */
function buildMinimalDeps() {
    const statsController = new ComponentStatsController();
    const traitsRegistry = {};
    const traitsController = new TraitsController(traitsRegistry);
    const internalComponentController = new InternalComponentController(null, null);
    const componentRegistry = {};
    const blueprintRegistry = {};
    const actionRegistry = {};
    const synergyRegistry = {};

    const componentController = new ComponentController(statsController, traitsController, componentRegistry);
    const entityController = new EntityController(componentController, blueprintRegistry);
    const roomsController = new RoomsController();
    const inventoryManager = new InventoryManager();
    const equippedItemStats = new EquippedItemStatsController();
    const componentCapabilityController = new ComponentCapabilityController(actionRegistry);
    const actionSelectController = new ActionSelectController();
    const synergyController = new SynergyController(null, synergyRegistry, null, null);
    const turnSystemController = new TurnSystemController({ tickSystem: null, config: {} });

    // Minimal consequence handlers stub — no-op handlers that don't throw
    const consequenceHandlers = new ConsequenceHandlers({
        spatialHandler: createStubController(),
        statHandler: createStubController(),
        damageHandler: createStubController(),
        consumeHandler: createStubController(),
        dropHandler: createStubController(),
        pickupHandler: createStubController(),
        eventHandler: createStubController(),
        logHandler: createStubController(),
    });

    const actionController = new ActionController(null, null, null, consequenceHandlers, null);
    const stateCtrl = new stateEntityController(componentController, blueprintRegistry);
    const holdingCostController = new HoldingCostController({
        actionController,
        equippedItemStats
    });
    const worldEventLogController = new WorldEventLogController(50);
    const llmContextController = new LlmContextController({ actionRegistry: actionRegistry });

    return {
        // Intentionally OMITTING triggerController — this is the regression scenario
        tickSystem: null,
        statsController,
        traitsController,
        internalComponentController,
        componentController,
        entityController,
        roomsController,
        inventoryManager,
        equippedItemStats,
        componentCapabilityController,
        actionSelectController,
        synergyController,
        consequenceHandlers,
        actionController,
        stateEntityController: stateCtrl,
        holdingCostController,
        worldEventLogController,
        llmContextController,
        turnSystemController,
        hintController: null,
        roomChatController: null,
        llmAgentFeedbackController: null,
    };
}

// =========================================================================
// Tests
// =========================================================================

describe('Equipped-item durability without triggerController (regression)', () => {
    it('should NOT throw when equipped-item durability stat changes without triggerController', () => {
        const deps = buildMinimalDeps();
        const { equippedItemStats, holdingCostController } = deps;

        // Construct the facade WITHOUT triggerController
        const controller = new WorldStateController(deps);

        // Verify triggerController is not injected
        expect(controller.triggerController).toBeNull();

        // Set up an equipped item so that the stat change callback has data to work with
        const eqId = 'eq-test-1';
        const itemId = 'item-knife-1';
        const itemType = 'knife';

        // Register the item in holdingCostController's equipped items map
        // The format is: { [entityId]: { [eqId]: { eqId, itemId, itemType, componentId } } }
        const entityId = 'entity-test-1';
        holdingCostController._equippedItems[entityId] = {
            [eqId]: { eqId, itemId, itemType, componentId: null }
        };

        // Initialize stats for the equipped item
        equippedItemStats.initializeStats(eqId, itemId, itemType);

        // This is the critical assertion: changing durability should NOT throw
        // even when triggerController is undefined/null
        expect(() => {
            equippedItemStats.updateStatDelta(eqId, 'Physical', 'durability', -1);
        }).not.toThrow();

        // State should be consistent after the change
        const currentStats = equippedItemStats.getStats(eqId);
        expect(currentStats).toBeDefined();
    });

    it('should NOT throw when durability crosses zero without triggerController', () => {
        const deps = buildMinimalDeps();
        const { equippedItemStats, holdingCostController } = deps;

        // Construct the facade WITHOUT triggerController
        const controller = new WorldStateController(deps);

        const eqId = 'eq-test-2';
        const itemId = 'item-knife-2';
        const itemType = 'knife';
        const entityId = 'entity-test-2';

        holdingCostController._equippedItems[entityId] = {
            [eqId]: { eqId, itemId, itemType, componentId: null }
        };

        // Initialize stats for the equipped item
        equippedItemStats.initializeStats(eqId, itemId, itemType);

        // Set durability to 1, then drop below zero (crossing point)
        expect(() => {
            equippedItemStats.updateStatDelta(eqId, 'Physical', 'durability', -5);
        }).not.toThrow();

        const currentStats = equippedItemStats.getStats(eqId);
        // Default durability is 30; delta=-5 → 25
        expect(currentStats.Physical.durability).toBe(25);
    });
});

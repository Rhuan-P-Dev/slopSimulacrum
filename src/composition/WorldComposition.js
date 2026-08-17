/**
 * WorldComposition — COMPOSITION ROOT for the world state graph.
 *
 * FASE 5 (god-class refactoring): this module is the single place that
 * constructs the WorldStateController's sub-controllers, in topological
 * dependency order, and hands them to the facade via dependency injection.
 *
 * WHY THIS EXISTS (root cause of BUG-100 constructor-ordering):
 *   The old `WorldStateController` constructor instantiated every sub-controller
 *   internally, passing `this` (the god class) to each BEFORE all of its own
 *   properties were assigned. Sub-controllers therefore captured a partially
 *   initialized facade and a hard cycle formed (facade → sub → facade).
 *
 *   The fix, applied here:
 *     1. Every sub-controller is constructed FIRST, receiving only the NAMED
 *        dependencies it actually needs (data registries / other sub-controllers).
 *        NONE of them receives the facade at construction time.
 *     2. The facade is then constructed with the already-built sub-controllers.
 *     3. Only AFTER the facade is fully built do we inject the facade reference
 *        into the (few) sub-controllers that legitimately depend on the facade,
 *        via a `setWorldStateController()` setter. No sub-controller ever sees
 *        the facade during its own construction.
 *
 *   Because no sub-controller's constructor reads the facade (they only store the
 *   reference and dereference it lazily at method-call time), deferring the facade
 *   reference to a post-construction setter is behavior-preserving: by the time any
 *   sub-controller method runs, the facade reference is already in place.
 *
 * Which sub-controllers keep the facade (documented legitimate facade dependencies):
 *   - ComponentCapabilityController  (uses facade getAll/getAllEquippedItems/getItemRegistry
 *                                      + componentController + equippedItemStats — 5 surfaces)
 *   - ActionSelectController         (facade getEquippedItem + stateEntityController)
 *   - SynergyController              (facade + nested SynergyComponentGatherer)
 *   - ActionController               (facade + nested RangeValidator/ComponentResolver/
 *                                      RequirementResolver/ConsequenceDispatcher)
 *   - ConsequenceHandlers            (facade + nested Spatial/Stat/Damage handlers)
 *   - HoldingCostController          (facade + actionController + equippedItemStats)
 *   - InternalComponentController    (facade, via the pre-existing setter)
 *   These are injected via `setWorldStateController()` AFTER the facade is ready.
 *
 * @module WorldComposition
 */

import DataLoader from '../utils/DataLoader.js';
import Logger from '../utils/Logger.js';

// Bottom-level data stores
import ComponentStatsController from '../controllers/core/componentStatsController.js';
import TraitsController from '../controllers/traits/TraitsController.js';
import InternalComponentController from '../controllers/core/InternalComponentController.js';

// Logic controllers (depend on data stores)
import ComponentController from '../controllers/core/componentController.js';
import EntityController from '../controllers/core/entityController.js';

// Instance managers / top-level controllers
import RoomsController from '../controllers/core/RoomsController.js';
import InventoryManager from '../utils/InventoryManager.js';
import EquippedItemStatsController from '../controllers/core/EquippedItemStatsController.js';
import ComponentCapabilityController from '../controllers/capabilities/componentCapabilityController.js';
import ActionSelectController from '../controllers/actions/actionSelectController.js';
import SynergyController from '../controllers/synergy/synergyController.js';
import ConsequenceHandlers from '../controllers/consequences/consequenceHandlers.js';
import ActionController from '../controllers/actions/actionController.js';
import stateEntityController from '../controllers/core/stateEntityController.js';
import HoldingCostController from '../controllers/core/HoldingCostController.js';

// The facade
import WorldStateController from '../controllers/WorldStateController.js';

/**
 * Builds the fully-wired world state graph.
 *
 * This is the ONLY supported construction path for a WorldStateController.
 * It performs:
 *   1. Loading of data registries.
 *   2. Topological construction of every sub-controller (named deps, no facade).
 *   3. Construction of the facade with the built sub-controllers.
 *   4. Post-construction facade injection into the facade-dependent sub-controllers.
 *   5. Observer/listener wiring (spawn observer, stat-change listeners, tick job).
 *   6. World initialization + initial capability scan.
 *
 * @param {UniversalTickSystem|null} [tickSystem] - The global tick system (may be null in tests).
 * @returns {{ worldStateController: WorldStateController, subControllers: Object }}
 *   The assembled facade plus a named map of every sub-controller (for inspection/testing).
 */
export function buildWorldState(tickSystem = null) {
    // =========================================================================
    // 0. Load Configuration Data (registries)
    // =========================================================================
    const actionRegistry = DataLoader.loadJsonSafe('data/actions.json');
    const componentRegistry = DataLoader.loadJsonSafe('data/components.json');
    const traitsRegistry = DataLoader.loadJsonSafe('data/traits.json');
    const blueprintRegistry = DataLoader.loadJsonSafe('data/blueprints.json', {});
    const synergyRegistry = DataLoader.loadJsonSafe('data/synergy.json') || {};

    if (!actionRegistry || Object.keys(actionRegistry).length === 0) {
        Logger.warn('Action registry is empty or missing. Actions will not be available.');
    }

    // =========================================================================
    // 1. TOPOLogICAL CONSTRUCTION — bottom-up. Each sub-controller receives ONLY
    //    the named dependencies it needs. NONE receives the facade here.
    // =========================================================================

    // --- Layer 0: data stores (no controller deps) ---
    const statsController = new ComponentStatsController();
    const traitsController = new TraitsController(traitsRegistry);
    const internalComponentController = new InternalComponentController(null, tickSystem);
    const roomsController = new RoomsController();
    const inventoryManager = new InventoryManager();
    // NOTE: EquippedItemStatsController no longer takes the facade (its reference was
    // dead code — it was stored but never read). It is a pure data store.
    const equippedItemStats = new EquippedItemStatsController();

    // --- Layer 1: logic controllers (depend on data stores + registries) ---
    const componentController = new ComponentController(statsController, traitsController, componentRegistry);
    const entityController = new EntityController(componentController, blueprintRegistry);

    // --- Layer 2: facade-independent top-level controllers ---
    // ComponentCapabilityController: built with its registry; the facade is injected later.
    const componentCapabilityController = new ComponentCapabilityController(actionRegistry);
    // ActionSelectController: built standalone; the facade is injected later.
    const actionSelectController = new ActionSelectController();
    // SynergyController: depends on actionSelectController (named); facade injected later.
    const synergyController = new SynergyController(actionRegistry, synergyRegistry, actionSelectController);

    // --- Layer 3: action system (depends on the controllers above) ---
    // ConsequenceHandlers: needs equippedItemStats (named); facade injected later.
    const consequenceHandlers = new ConsequenceHandlers({ equippedItemStats });
    // ActionController: needs its named collaborators; facade injected later.
    const actionController = new ActionController(
        consequenceHandlers,
        actionRegistry,
        componentCapabilityController,
        synergyController,
        actionSelectController,
        equippedItemStats
    );
    // stateEntityController: pure named deps (entityController, actionController, internalComponentController).
    const stateEntityControllerInstance = new stateEntityController(entityController, actionController, internalComponentController);
    // HoldingCostController: needs actionController + equippedItemStats (named); facade injected later.
    const holdingCostController = new HoldingCostController({ actionController, equippedItemStats });

    // =========================================================================
    // 2. CONSTRUCT THE FACADE with the already-built sub-controllers (injection).
    //    The facade no longer instantiates anything itself.
    // =========================================================================
    const worldStateController = new WorldStateController({
        tickSystem,
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
        // NOTE: the imported class is `stateEntityController` (lowercase), so the
        // built instance is referenced explicitly by its local name here.
        stateEntityController: stateEntityControllerInstance,
        holdingCostController
    });

    // =========================================================================
    // 3. POST-CONSTRUCTION FACADE INJECTION.
    //    Only now that the facade is fully built do we hand it to the sub-controllers
    //    that legitimately depend on it. This is what breaks the constructor-ordering
    //    cycle: no sub-controller saw the facade during its own construction.
    //    Each setter propagates to its own nested children (see their implementations).
    // =========================================================================
    internalComponentController.setWorldStateController(worldStateController);
    componentCapabilityController.setWorldStateController(worldStateController);
    actionSelectController.setWorldStateController(worldStateController);
    synergyController.setWorldStateController(worldStateController);
    actionController.setWorldStateController(worldStateController);
    consequenceHandlers.setWorldStateController(worldStateController);
    holdingCostController.setWorldStateController(worldStateController);

    // =========================================================================
    // 4. WORLD INITIALIZATION + INITIAL CAPABILITY SCAN.
    //    These run HERE (not in the facade constructor) so that every facade
    //    reference has already been injected by step 3 before any code path that
    //    can trigger a sub-controller method (spawn observer, stat listeners,
    //    capability scans) executes. This exactly mirrors the original event order:
    //    observers/listeners wired → facade ready → initializeWorld() → scan.
    // =========================================================================
    worldStateController.initializeWorld();
    worldStateController.actionController.scanAllCapabilities(worldStateController.getAll());

    // =========================================================================
    // 6. RETURN the assembled facade + a named sub-controller map.
    // =========================================================================
    return {
        worldStateController,
        subControllers: {
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
            stateEntityController: stateEntityControllerInstance,
            holdingCostController
        }
    };
}

export default buildWorldState;

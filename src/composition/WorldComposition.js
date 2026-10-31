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

import Logger from '../utils/Logger.js';
import RegistryStore from '../services/RegistryStore.js';
import ModLoader from '../services/ModLoader.js';
import { setRegistries as setComponentNamingRegistries } from '../utils/ComponentNaming.js';
import { setRegistries as setEntityAttributeRegistries } from '../utils/EntityAttributeData.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import {
    WORLD_EVENTS_MAX_LIMIT,
    AGENT_FEEDBACK_CAPACITY,
    ROOM_CHAT_HISTORY_LIMIT,
    CHAT_MESSAGE_MAX_LENGTH
} from '../utils/Constants.js';
import { SOCKET_EVENTS } from '../../shared/SocketProtocol.js';

// Bottom-level data stores
import ComponentStatsController from '../controllers/core/componentStatsController.js';
import TraitsController from '../controllers/traits/TraitsController.js';
import InternalComponentController from '../controllers/core/InternalComponentController.js';
import MaterialController from '../controllers/materials/MaterialController.js';
import CraftingController from '../controllers/crafting/CraftingController.js';
import MachineRegistryController from '../controllers/core/MachineRegistryController.js';
import KnowledgeController from '../controllers/knowledge/KnowledgeController.js';
import WorldRulesController from '../controllers/worldRules/WorldRulesController.js';
import OnDamageDropListener from '../controllers/worldRules/OnDamageDropListener.js';

// Logic controllers (depend on data stores)
import ComponentController from '../controllers/core/componentController.js';
import EntityController from '../controllers/core/entityController.js';

// Instance managers / top-level controllers
import RoomsController from '../controllers/core/RoomsController.js';
import InventoryManager from '../utils/InventoryManager.js';
import EquippedItemStatsController from '../controllers/core/EquippedItemStatsController.js';
import WorldEventLogController from '../controllers/core/WorldEventLogController.js';
// Generic action attribution: the single source of truth for "which components
// powered action X" + "how many", written by the dispatcher at the execution
// choke point and read by perception.
import ActionAttributionStore from '../utils/ActionAttributionStore.js';
// Feature G (perception): per-room "what changed since the last observation"
// state owner. Pure observer — never mutates world state (wiki/code_quality:
// single source of truth); world state changes are reported to it by the
// facade's mutation sites (see WorldStateController._markPerceptionDirty).
import PerceptionController from '../controllers/core/PerceptionController.js';
import RoundProseController from '../controllers/core/RoundProseController.js';
import ViewController from '../controllers/core/ViewController.js';
// Feature D backend (spec §7.3, pulled forward to C for speak_in_room):
// per-room chat ring buffers (state owner; deliberately NO getAll() →
// excluded from the world-state broadcast aggregation).
import RoomChatController from '../controllers/core/RoomChatController.js';
// Feature E: per-agent action-outcome feedback store (agent's "what did I do" memory).
import LlmAgentFeedbackController from '../controllers/networking/LlmAgentFeedbackController.js';
// Feature A: deterministic round/turn system (state owner; needs only the
// tick system at construction — the facade is injected via setter below).
import TurnSystemController from '../controllers/core/TurnSystemController.js';
// Temporal effect system (reusable "expires after N rounds unless re-executed" engine
// for stat consequences): facade-backed, injected post-construction.
import EffectTracker from '../controllers/effects/EffectTracker.js';
// Energy flow (wiki/subMDs/systems/energy_flow.md): cross-component Physical.energy
// redistribution. Logic controller; constructed with its three named deps
// (all already in scope — no new file I/O); the facade reference is injected
// via setter below (same pattern as the IC / turn-system peers).
import EnergyFlowController from '../controllers/core/EnergyFlowController.js';
import EntityEnergyController from '../controllers/core/EntityEnergyController.js';
import LlmContextController from '../controllers/networking/LlmContextController.js';
import ComponentCapabilityController from '../controllers/capabilities/componentCapabilityController.js';
import ActionSelectController from '../controllers/actions/actionSelectController.js';
import SynergyController from '../controllers/synergy/synergyController.js';
import ConsequenceHandlers from '../controllers/consequences/consequenceHandlers.js';
import ActionController from '../controllers/actions/actionController.js';
import stateEntityController from '../controllers/core/stateEntityController.js';
import HoldingCostController from '../controllers/core/HoldingCostController.js';

// Trigger system (component:broke event pipeline).
import TriggerController from '../controllers/triggers/TriggerController.js';
import BrokenComponentRemovalHandler from '../controllers/triggers/BrokenComponentRemovalHandler.js';
import KnifeDropTriggerHandler from '../controllers/triggers/KnifeDropTriggerHandler.js';

// Hint system (logic controller; facade injected later).
import HintController from '../controllers/hints/HintController.js';

// Instinct system (stateless logic controller for LLM agent behavior primitives).
import InstinctController from '../controllers/ai/InstinctController.js';

// The facade
import WorldStateController from '../controllers/WorldStateController.js';

/**
 * The world definition at boot: every enabled mod package, merged by the loader.
 *
 * This is where "packages on disk" becomes "the world". The shipped content is the
 * 21 official `core-*` packages; a directory dropped into `data/mods/` with a valid
 * manifest contributes to the same registries from here on, in load order, and what
 * it overrode is reported rather than silent (`wiki/decisions/mod-system.md`).
 *
 * A package that failed to load is logged and skipped, never fatal: one broken
 * directory must not keep the server from booting. The result is a candidate this
 * function adopts; the runtime pipeline (enable / disable while the world runs)
 * applies a new candidate at a round boundary, and until it exists a mod needs a
 * restart to take effect.
 *
 * @returns {Object.<string, Object>} Content for every registry kind.
 */
function buildBootRegistries() {
    const { registries, invalid } = new ModLoader().build();
    for (const entry of invalid) {
        Logger.warn(
            `[WorldComposition] mod "${entry.modId ?? entry.dir}"`
            + ` contributed nothing${entry.kind ? ` for ${entry.kind}` : ''}: ${entry.message}`
        );
    }
    // The attribute catalog keeps its wrapper even when nothing ships it, so readers
    // see an empty catalog rather than a shape they must re-check.
    registries[REGISTRY_KINDS.ENTITY_ATTRIBUTES] = {
        attributes: {},
        ...(registries[REGISTRY_KINDS.ENTITY_ATTRIBUTES] ?? {})
    };
    return registries;
}

/**
 * Builds the fully-wired world state graph.
 *
 * This is the ONLY supported construction path for a WorldStateController.
 * It performs:
 *   1. Building the world definition from the mod packages and handing it to the
 *      `RegistryStore` (read by kind, swapped as one step — see
 *      `src/services/RegistryStore.js` and `buildBootRegistries` above).
 *   2. Topological construction of every sub-controller (named deps, no facade).
 *   3. Construction of the facade with the built sub-controllers.
 *   4. Post-construction facade injection into the facade-dependent sub-controllers.
 *   5. Observer/listener wiring (spawn observer, stat-change listeners, tick job).
 *   6. World initialization + initial capability scan.
 *
 * @param {UniversalTickSystem|null} [tickSystem] - The global tick system (may be null in tests).
 * @param {RegistryStore|null} [registryStore] - Pre-built registries (a test, or a
 *   caller that already resolved the world definition). Built from the data seam
 *   when omitted.
 * @returns {{ worldStateController: WorldStateController, subControllers: Object, registryStore: RegistryStore }}
 *   The assembled facade, a named map of every sub-controller (for
 *   inspection/testing), and the registry store that owns the world definition.
 */
export function buildWorldState(tickSystem = null, registryStore = null) {
    // =========================================================================
    // 0. Load Configuration Data (registries)
    //
    // The mod packages build one definition, the store holds it, and every local
    // below is the store's LIVE holder for its kind. Readers therefore cannot drift
    // from the swapped definition: when the mod pipeline replaces content, these very
    // objects change contents (see RegistryStore's identity rule).
    // =========================================================================
    const store = registryStore ?? new RegistryStore(buildBootRegistries());

    // Two utility modules cache their registry at module level (they are imported
    // by name, not injected). Handing them the store keeps them on the live
    // definition; without this they would keep serving the boot-time parse after a
    // mod swap — the half-applied world this store exists to prevent.
    setComponentNamingRegistries(store);
    setEntityAttributeRegistries(store);

    const actionRegistry = store.read(REGISTRY_KINDS.ACTIONS);
    const componentRegistry = store.read(REGISTRY_KINDS.COMPONENTS);
    const traitsRegistry = store.read(REGISTRY_KINDS.TRAITS);
    const blueprintRegistry = store.read(REGISTRY_KINDS.BLUEPRINTS);
    const synergyRegistry = store.read(REGISTRY_KINDS.SYNERGY);

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
    // Hoisted to named consts so both the MaterialController and the
    // KnowledgeController read the SAME loaded registries — one load, N readers
    // (zero new file I/O; the controller itself never loads).
    const materialsRegistry = store.read(REGISTRY_KINDS.MATERIALS);
    const propertyTraitMappingRegistry = store.read(REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING);
    // Feature 1: per-material damage-type distributions (data/mods/core-material-damage-types/materialDamageTypes.json).
    // Loaded here (one load, N readers) and injected into the MaterialController, which
    // validates it (cross-checking material keys against the materials registry) and
    // serves it to the damage handler. Absent/empty file → feature off (graceful).
    const materialDamageTypesRegistry = store.read(REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES);
    // Feature 2: per-material chunk-drop rates (data/mods/core-material-drop-rates/materialDropRates.json). Same
    // one-load/N-readers pattern; the MaterialController validates it (minChunkVolume,
    // per-material dropRate/chunkFraction in [0,1], material-key cross-check) and serves
    // it to the chunk-drop handler. Absent/empty file → feature off (graceful — no drops).
    const materialDropRatesRegistry = store.read(REGISTRY_KINDS.MATERIAL_DROP_RATES);
    const materialController = new MaterialController(materialsRegistry, propertyTraitMappingRegistry, materialDamageTypesRegistry, materialDropRatesRegistry);
    // World-rules layer (WR-4): a new Layer-0 data owner for world-level rules.
    // Loaded here (one load, N readers) and injected into the WorldRulesController,
    // which validates it (WR-1/WR-5: "off, never crash" degradation). Absent/empty
    // file → all rules off (legacy behavior, bit-identical world).
    const worldRulesRegistry = store.read(REGISTRY_KINDS.WORLD_RULES);
    const worldRulesController = new WorldRulesController(worldRulesRegistry);

    // =========================================================================
    // 0.5: FAIL-FAST STARTUP VALIDATION — validate all compositions now,
    //      not mid-game. Component and inventory-item registries are loaded;
    //      any data defect throws TypeError here (boot failure).
    // =========================================================================
    const inventoryItemRegistry = store.read(REGISTRY_KINDS.INVENTORY_ITEMS);
    for (const [type, def] of Object.entries(componentRegistry)) {
        if (def.materials) materialController.validateComposition(type, def.materials);
    }
    for (const [type, def] of Object.entries(inventoryItemRegistry)) {
        if (def.materials) materialController.validateComposition(type, def.materials);
    }

    Logger.info(`[WorldComposition] Startup validation passed: ${Object.keys(componentRegistry).length} components, ${Object.keys(inventoryItemRegistry).length} inventory items`);
    // Hoisted so the KnowledgeController below can reuse the SAME recipe
    // registry (one load, N readers). CraftingController's behavior is
    // unchanged: it receives the identical parsed object.
    const craftingRegistry = store.read(REGISTRY_KINDS.CRAFTING);
    // CraftingController: state controller owning the recipe registry
    // (data/mods/core-crafting/crafting.json). Receives the already-loaded item registry so every
    // recipe input/output type is cross-validated against inventoryItems.json
    // right here (fail-fast at boot). No controller deps —
    // no setWorldStateController() needed (it never reads world state).
    const craftingController = new CraftingController(
        craftingRegistry,
        inventoryItemRegistry
    );
    // MachineRegistryController: state controller owning the machine registry
    // (data/mods/core-machines/machines.json). Binds each machine's three forms (item ↔
    // blueprint ↔ recipe) and validates them against the already-loaded registries
    // at boot (fail-fast — a machine with a missing blueprint/item/recipe fails
    // startup, never mid-game). No controller deps and no setWorldStateController()
    // (it never reads live world state) — same Layer-0 shape as CraftingController.
    // Deliberately kept OUT of the broadcast subControllers map below: static
    // config data must stay out of the full-state aggregation (same rule).
    const machineRegistryController = new MachineRegistryController(
        store.read(REGISTRY_KINDS.MACHINES),
        blueprintRegistry,
        inventoryItemRegistry,
        craftingRegistry
    );
    // KnowledgeController: state controller owning the static "Knowledge" codex
 // (wiki/subMDs/frontend/knowledge_viewer.md). Layer 0 data store — the same layer as the
    // other state controllers it reads (traits / materials / property mapping /
    // crafting / inventory items). Receives the already-loaded registries (zero
    // new file I/O) and validates them at boot (fail-fast). No controller deps and
    // no setWorldStateController() (it never reads live world state). Deliberately
    // kept OUT of the broadcast subControllers map below: the static codex must
    // stay out of the full-state aggregation (same rule as craftingController /
    // roomChatController — shipping a codex in every update would bloat clients).
    const knowledgeController = new KnowledgeController({
        traits: traitsRegistry,
        materials: materialsRegistry,
        propertyTraitMapping: propertyTraitMappingRegistry,
        recipes: craftingRegistry,
        items: inventoryItemRegistry
    });
    // The `store` argument below hands each data store the LIVE registry holder
    // (identity-stable, content swapped as one step), so a mod applied at a round
    // boundary reaches a controller that captured its registry at construction.
    const internalComponentController = new InternalComponentController(null, tickSystem, store);
    const roomsController = new RoomsController(store);
    // World objects (props) are spawned as isStatic entities by the facade's
    // initializeWorld() → _spawnStaticProps() (see
    // wiki/subMDs/systems/world_objects.md); no separate controller is needed.
    const inventoryManager = new InventoryManager({ materialController, registries: store });
    // Feature B: world event ring buffer (state owner; capacity WORLD_EVENTS_MAX_LIMIT per spec §4.1)
    const worldEventLogController = new WorldEventLogController(WORLD_EVENTS_MAX_LIMIT);
    // Feature E: per-agent action-outcome feedback store (capacity AGENT_FEEDBACK_CAPACITY per agent).
    const llmAgentFeedbackController = new LlmAgentFeedbackController(AGENT_FEEDBACK_CAPACITY);
    // Feature D backend (spec §7.3): per-room chat rings (ROOM_CHAT_HISTORY_LIMIT/room,
    // CHAT_MESSAGE_MAX_LENGTH-char messages). No getAll() on purpose — the
    // full-state broadcast stays lean.
    const roomChatController = new RoomChatController(ROOM_CHAT_HISTORY_LIMIT, CHAT_MESSAGE_MAX_LENGTH);
    // Feature G (perception): per-room "what changed since the last observation"
    // state owner (entity inventory/attributes, dropped items, equipped set,
    // internal components, room count). Zero world-state mutation — a pure
    // observer; its only facade dependency is the tick value (via the WSC's
    // _currentTick seam) for the observation watermark. Injected after the
    // facade so the WSC can reference it; the WSC's mutation methods call
    // markDirty() directly, so this instance is read-only relative to the facade.
    const perceptionController = new PerceptionController();
    // Round-prose reader (Feature G round reconstruction): a pure reader over
    // the perception rings and the turn system's round tick window. No
    // getAll() by design; stays out of the broadcast aggregate (same rule as
    // perceptionController / roomChatController).
    const roundProseController = new RoundProseController();
    // ViewController: the generic "what can I see?" reader behind GET /view/:id
    // (entity / component / item / equipped payloads). Read-only assembly with
    // no persistent world data and no getAll() → deliberately OUT of the
    // subControllers broadcast map (same rule as perceptionController / knowledgeController).
    // Its own facade reference is injected post-construction, below, so view
    // payloads read live state.
    const viewController = new ViewController();
    // Generic action attribution store (shared by the dispatcher — writer — and
    // perception — reader). Built before the facade; the facade reference is never
    // needed (tick is read off the WSC at record time). Injected to each consumer
    // after the facade is fully built, alongside the other setter-based injections.
    const actionAttributionStore = new ActionAttributionStore();
    // NOTE: EquippedItemStatsController no longer takes the facade (its reference was
    // dead code — it was stored but never read). It is a pure data store.
    const equippedItemStats = new EquippedItemStatsController(store);

    // --- Layer 1: logic controllers (depend on data stores + registries) ---
    const componentController = new ComponentController(statsController, traitsController, componentRegistry, materialController);
    const entityController = new EntityController(componentController, blueprintRegistry);

    // --- Layer 2: facade-independent top-level controllers ---
    // ComponentCapabilityController: built with its registry; the facade is injected later.
    const componentCapabilityController = new ComponentCapabilityController(actionRegistry);
    // ActionSelectController: built standalone; the facade is injected later.
    const actionSelectController = new ActionSelectController();
    // SynergyController: depends on actionSelectController (named); facade injected later.
    const synergyController = new SynergyController(actionRegistry, synergyRegistry, actionSelectController);

    // --- Layer 3: action system (depends on the controllers above) ---
    // ConsequenceHandlers: needs equippedItemStats (named); the world event log
    // feeds the LogConsequenceHandler sink (Feature B); facade injected later.
    // materialController is forwarded (feature 1) so the damage handler can apply the
    // attacker's per-material damage-type split at the single damage choke point.
    const consequenceHandlers = new ConsequenceHandlers({ equippedItemStats, worldEventLog: worldEventLogController, materialController, worldRulesController, machineRegistry: machineRegistryController });
    // onDamage world-event rule (Layer 3): the enforcement arm of the world-rules
    // layer. Constructed before the facade (like the other logic controllers) with
    // only its named deps (both already in scope — no new file I/O). The facade
    // reference is injected post-construction below.
    const onDamageDropListener = new OnDamageDropListener({ materialController, worldRulesController });
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
    const holdingCostController = new HoldingCostController({ actionController, equippedItemStats, registries: store });
    // Feature B: LLM context renderer (logic controller; reads the facade's
    // public API — facade injected later, same pattern as the other readers).
    const llmContextController = new LlmContextController({ actionRegistry });
    // Hint system: deterministic suggestions for the player and the LLM agent.
    const hintController = new HintController({ actionRegistry });
    // InstinctController: stateless logic controller for LLM agent behavior primitives.
    const instinctController = new InstinctController({ actionRegistry });
    // Feature A: turn system (state owner; needs only the tick system here —
    // the facade + broadcaster + NPC agent are injected via setters below).
    const turnSystemController = new TurnSystemController({ tickSystem });
    // Temporal effect system: makes stat consequences "durable" — they expire after N
    // rounds unless re-executed (flat, restored to their first recorded baseline). A
    // facade-backed service; the facade reference is injected post-construction below,
    // and it is exposed on the facade (`worldStateController.effectTracker`) so the
    // ConsequenceDispatcher (reaches it via the facade, forwarded from the
    // ActionController) and the turn system both reach it with no dedicated setter
    // on either controller.
    const effectTracker = new EffectTracker();
 // Energy flow (wiki/subMDs/systems/energy_flow.md): the "blood system". Logic
    // controller with named deps only — the already-loaded componentRegistry
    // (data/mods/core-components/components.json — used ONLY to resolve the optional per-recipe
    // `energyCapacity` bound) and the worldRulesController (the flow reads the
    // validated rule via getRule('energyFlow'), never the file). No tick-system
    // dependency: the flow runs once per turn, driven from the turn system's
    // round-start hook below. Deliberately NOT passed into the facade's
    // broadcast subControllers map: it has no getAll().
    const energyFlowController = new EnergyFlowController(
        componentRegistry,
        worldRulesController
    );

    // §3.2: EntityEnergyController — the whole-entity energy-life system (wiki/entity_attributes).
    // Per-turn drain of each entity's energy attribute; elimination (spill +
    // despawn) when the attribute hits 0. Logic controller — no persistent
    // world data (reads the entity record via the facade's public API). Deliberately
    // NOT passed into the facade's broadcast subControllers map: it has no
    // getAll(). The facade reference is injected below, post-construction.
    const entityEnergyController = new EntityEnergyController();

    // §3.3: TriggerController — constructed before facade, facade injected later.
    const triggerController = new TriggerController();

    // =========================================================================
    // 2. CONSTRUCT THE FACADE with the already-built sub-controllers (injection).
    //    The facade no longer instantiates anything itself.
    // =========================================================================
    const worldStateController = new WorldStateController({
        tickSystem,
        // The live world definition. Readers that need a registry at call time go
        // through facade.getRegistry(kind); see src/services/RegistryStore.js and
        // wiki/decisions/mod-system.md.
        registryStore: store,
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
        worldEventLogController,
        // Feature G (perception): null-tolerant (the facade's perception hooks
        // no-op if omitted — hand-built test facades that skip it keep working).
        perceptionController,
        // ViewController: GET /view/:id read-only payload assembly. Null-tolerant
        // like craftingController / knowledgeController — a test may hand-build
        // the facade without it; the facade stores it and exposes getViewData().
        viewController,
        llmContextController,
        hintController,
        turnSystemController,
        roomChatController,
        llmAgentFeedbackController,
        // NOTE: the imported class is `stateEntityController` (lowercase), so the
        // built instance is referenced explicitly by its local name here.
        stateEntityController: stateEntityControllerInstance,
        holdingCostController,
        // trigger controller for component:broke events
        triggerController,
        // InstinctController: stateless behavior-primitive generator (null-tolerant).
        instinctController,
        // MaterialController: provides static material definitions + compositions
        // to the client via getMaterialRegistry() / GET /materials/registry.
        materialController,
        // CraftingController: recipe registry (data/mods/core-crafting/crafting.json). The facade
        // reads it via getRecipe()/getRecipes() inside craftItems(); null-tolerant
        // so tests that hand-build the facade can omit it.
        craftingController,
        // MachineRegistryController: machine registry (data/mods/core-machines/machines.json).
        // Null-tolerant like craftingController — the place/retrieve routes read
        // it via the facade; deliberately NOT in the subControllers broadcast map.
        machineRegistry: machineRegistryController,
        // Null-tolerant like craftingController — a test may hand-build
        // the facade without it; the facade stores it and exposes getKnowledge().
        knowledgeController,
        // WorldRulesController: world-level rules registry (data/mods/core-world-rules/worldRules.json).
        // Null-tolerant like craftingController/knowledgeController — a test may
        // hand-build the facade without it. Deliberately NOT in the subControllers
        // broadcast map: static config data must stay out of the full-state
        // aggregation (same rule as craftingController / knowledgeController).
        worldRulesController,
        // OnDamageDropListener: enforcement arm of the onDamage world-event rule.
        // Null-tolerant like worldRulesController — a test may hand-build the facade
        // without it. Deliberately NOT in the subControllers broadcast map (same rule).
        onDamageDropListener,
        // EnergyFlowController: cross-component energy redistribution (logic
        // controller, no getAll() → stays out of the broadcast aggregation,
        // same rule as worldRulesController). The facade calls its
        // initialize() in its own constructor (right after the turn system's);
        // the flow's OWN facade reference is injected below, post-construction.
        energyFlowController,
        // EntityEnergyController: whole-entity energy-life system (per-turn
        // energy-attribute drain + death). Logic controller — no persistent
        // world data; no getAll() → stays out of the broadcast aggregation.
        entityEnergyController
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
    llmContextController.setWorldStateController(worldStateController);
    actionSelectController.setWorldStateController(worldStateController);
    synergyController.setWorldStateController(worldStateController);
    actionController.setWorldStateController(worldStateController);
    // Wire the dispatcher (the single execution choke point) to the shared action-
    // attribution store: it is where every successful action records "which & how
    // many components powered it".
    actionController.consequenceDispatcher.setActionAttributionStore(actionAttributionStore);
    consequenceHandlers.setWorldStateController(worldStateController);
    holdingCostController.setWorldStateController(worldStateController);
    turnSystemController.setWorldStateController(worldStateController);
    // Temporal effect wiring: give the EffectTracker the facade and expose it on the
    // facade. Both the ConsequenceDispatcher and the turn system read it via
    // `facade.effectTracker` (no dedicated setter needed on those controllers).
    effectTracker.setWorldStateController(worldStateController);
    worldStateController.effectTracker = effectTracker;
    // onDamage listener: injected AFTER world init (below) so that the INIT
    // damage events fired by initializeWorld() / scanAllCapabilities() reach the
    // listener with its worldStateController still null (a no-op per the listener's
    // null-guard). Once init is complete, the listener has a valid facade for all
    // real damage (equip-cost, cut, shoot, removal cascades). This also lets the
    // test suite pin the Bernoulli stream via buildWorldState before the first
    // post-init damage event can draw.
 // Per-turn subsystem steps at ROUND START (wiki/subMDs/systems/energy_flow.md).
    // Wired here (composition root) because the turn system, the IC controller
    // and the flow controller are siblings — none owns another. The hook
    // receives the round number that just started.
    //
    // 3-layer isolation contract:
    //   L1 — inside processTurnEffects, each overTime effect is guarded by its
    //        own try/catch (per-effect isolation).
    //   L2 — HERE: each subsystem step runs in its own guarded block, so an IC-
    //        step failure can never skip the flow step, and a flow-step failure
    //        can never skip the NPC agents that fire after this hook.
    //   L3 — the turn system's own round-start hook invocation is wrapped in a
    //        try/catch (the hook can never take down the round).
    turnSystemController.setTurnStartHook((round) => {
        try {
            internalComponentController.processTurnEffects(round);
        } catch (err) {
            Logger.warn(`[WorldComposition] Round ${round}: IC turn step failed: ${err && err.message ? err.message : err}`);
        }
        try {
            energyFlowController.processFlowTurn(round);
        } catch (err) {
            Logger.warn(`[WorldComposition] Round ${round}: flow turn step failed: ${err && err.message ? err.message : err}`);
        }
        try {
            // Entity energy lifecycle: per-turn drain of each entity's energy
            // attribute, then death (spill + despawn) when the attribute hits 0.
            // Runs after the internal component effects so the entity's charge
            // is final for this turn before the life check.
            entityEnergyController.processEnergyTurn(round);
        } catch (err) {
            Logger.warn(`[WorldComposition] Round ${round}: entity-energy turn step failed: ${err && err.message ? err.message : err}`);
        }
    });
    // Energy flow: inject the facade (post-construction) so the flow step can
    // enumerate entities, read stats, and write through the public API. By the
    // time a round starts (i.e. after this wiring step), the reference is
    // always resolved before first use.
    energyFlowController.setWorldStateController(worldStateController);
    entityEnergyController.setWorldStateController(worldStateController);
    // Hint system: reads world state; does not mutate it.
    hintController.setWorldStateController(worldStateController);
    // InstinctController: reads world state for generation/expansion.
    instinctController.setWorldStateController(worldStateController);
    
    // TriggerController — inject facade + broadcaster, register handlers.
    // Handler order matters: BrokenComponentRemovalHandler 1º, KnifeDropTriggerHandler 2º.
    triggerController.setWorldStateController(worldStateController);
    // Broadcaster will be injected after setBroadcastService is called on the facade.
    // Register handlers in deterministic order.
    const brokenComponentRemovalHandler = new BrokenComponentRemovalHandler({ worldStateController });
    const knifeDropTriggerHandler = new KnifeDropTriggerHandler({ worldStateController });
    triggerController.on(SOCKET_EVENTS.COMPONENT_BROKE, (payload) => brokenComponentRemovalHandler.handle(payload));
    triggerController.on(SOCKET_EVENTS.COMPONENT_BROKE, (payload) => knifeDropTriggerHandler.handle(payload));
    
    // Feature D backend: the room chat layer needs the facade for room
    // existence checks (sendMessage → ROOM_NOT_FOUND). No subControllers
    // map entry on purpose — it has no getAll() and must stay out of the
    // full-state broadcast aggregation (spec §7.3).
    roomChatController.setWorldStateController(worldStateController);
    // Expose the turn system to the facade's getAll() aggregation so its
    // getRoundState() appears as `state.turns` in every world-state broadcast
    // (spec §5.7 — free via the sub-controller loop).
    worldStateController.subControllers.turns = turnSystemController;
    // PerceptionController: observer that reads the facade (getEntities,
    // getDroppedItems, getEquippedItems, getInternalComponentsForEntity,
    // getComponentStats) — inject the root so its lazy _roomSnapshot / _extractEntity
    // reads work. Injected *before* world init so the markDirty() calls fired by
    // init's spawns land on an already-wired controller.
    perceptionController.setWorldStateController(worldStateController);
    // ViewController: reads live facade state at view time — inject after the
    // facade (same as perceptionController), before world init.
    viewController.setWorldStateController(worldStateController);
    // Perception reads the *same* store so moved-entity rows credit the
    // authoritative components that powered the action (not a re-derived heuristic).
    perceptionController.setActionAttributionStore(actionAttributionStore);

    // Round-prose reader: wired for the routes (GET /perception/round/*) to
    // reach it via the facade. Pure reader, so no timing constraint vs world
    // init.
    roundProseController.setWorldStateController(worldStateController);
    worldStateController.roundProseController = roundProseController;

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

    // onDamage listener: inject the facade (post-construction) so handleDamage can
    // read component/entity/material state via the public API. Wired HERE — after
    // world init — so that the INIT damage events fired by initializeWorld() and
    // scanAllCapabilities() reach the listener with its worldStateController still
    // null (a no-op per the listener's null-guard). Once init is complete, the
    // listener has a valid facade for all real damage (equip-cost, cut, shoot, and
    // removal cascades). Deferring this injection also lets the test suite pin the
    // Bernoulli stream via buildWorldState() before the first post-init damage
    // event can draw with the production Math.random.
    onDamageDropListener.setWorldStateController(worldStateController);

    // =========================================================================
    // 6. RETURN the assembled facade + a named sub-controller map.
    // =========================================================================
    return {
        worldStateController,
        // The store that owns the world definition this facade was built from.
        // The mod pipeline swaps content here; every reader above is already
        // looking at these holders.
        registryStore: store,
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
            holdingCostController,
            worldEventLogController,
            llmContextController,
            hints: hintController,
            turnSystemController,
            roomChatController,
            llmAgentFeedbackController,
            // Inspection-only (not in broadcast) — the controller has no getAll()
            // by design (static recipe data; must stay out of the full-state
            // broadcast aggregation, same rule as roomChatController).
            craftingController,
            // Inspection-only (not in broadcast) — the static knowledge codex has
            // no getAll() by design; it must stay out of the full-state broadcast
            // aggregation (same rule as craftingController / roomChatController).
            // Surfaced here for tests/inspection only.
            knowledgeController,
            // Inspection-only (not in broadcast) — per spec §2.1 exclusion rule.
            instincts: instinctController,
            // Inspection-only (not in broadcast) — the world-rules registry has no
            // getAll() by design; static config data must stay out of the full-state
            // broadcast aggregation (same rule as craftingController / knowledgeController).
            worldRulesController,
            // Inspection-only (not in broadcast) — Feature G (perception): no
            // getAll() by design (it is not world state; it is the *observer's*
            // derived view), so it must stay out of the full-state broadcast
            // aggregation (same rule as roomChatController). Exposed here for
            // direct reads from routes/tests (GET /perception/:roomId etc.).
            perceptionController,
            // Inspection-only (not in broadcast) — Feature G (round-prose):
            // pure reader over the perception rings and turn bookkeeping (not
            // world state), so it must stay out of the full-state broadcast
            // aggregate (same rule as perceptionController / roomChatController).
            roundProseController,
            // Inspection-only (not in broadcast) — the onDamage enforcement arm is a
            // null-tolerant actor with no getAll(); it must stay out of the full-state
            // broadcast aggregation (same rule as worldRulesController).
            onDamageDropListener,
            // Inspection-only (not in broadcast) — the energy flow is a logic
            // controller with no getAll(); static-ish config + a tick job must
            // stay out of the full-state broadcast aggregation (same rule as
            // worldRulesController / onDamageDropListener).
            energyFlowController
        }
    };
}

export default buildWorldState;

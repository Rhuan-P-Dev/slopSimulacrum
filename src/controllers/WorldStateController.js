import Logger from '../utils/Logger.js';
import WorldGraphBuilder from '../utils/WorldGraphBuilder.js';
import IdResolver from '../utils/IdResolver.js';
import { DEFAULT_TRIGGER_RADIUS } from '../utils/DiskSampler.js';
import { DEFAULT_TURNS_SNAPSHOT } from './core/TurnSystemController.js';
import { WORLD_EVENTS_RECENT_LIMIT, ROOM_CHAT_HISTORY_LIMIT, AGENT_FEEDBACK_CAPACITY } from '../utils/Constants.js';
import { TRAIT_GROUPS, STAT_NAMES } from '../../shared/StatVocabulary.js';
import { getAttributes } from '../utils/EntityAttributeData.js';
import { emptyKnowledgePayload } from './knowledge/KnowledgeController.js';
import { spawnDataDrivenNpcs, checkNpcSpawnGate, normalizeNpcAiConfig, buildNpcConfig, applyInitialItems, resolveEquippableHostComponent } from './logic/NpcSpawnLogic.js';
import { applyInitialSpawns, resolveInitialSpawnSlot } from './logic/InitialSpawnLogic.js';
import { executeCraftTransaction, resolveCraftTarget, validateCraftInputs, precheckCraftVolume, consumeCraftInputs, produceCraftOutputs, isRecipeInputType } from './logic/CraftingLogic.js';
import { removeBrokenComponentCascade, spillContent, cascadeDependents, forceDirectRemoval, maybeEliminateEntity, removeComponentOrItem, cleanupAfterRemoval, spillAllEntityItems } from './logic/RemovalCascadeLogic.js';

/**
 * WorldStateController — the world-state facade (thin root).
 *
 * FASE 5 (god-class refactoring): this class NO LONGER instantiates its own
 * sub-controllers. Every sub-controller is constructed by the composition root
 * (src/composition/WorldComposition.js — `buildWorldState()`), which builds them
 * in topological dependency order and hands them here via `deps`. This removes
 * the old constructor-ordering defect (BUG-100 root cause): previously the
 * facade passed `this` to each sub-controller BEFORE its own properties were
 * fully assigned, creating dependency cycles and partially-initialized access.
 *
 * Construction contract:
 *   - The constructor only STORES the injected sub-controllers and wires the
 *     internal observers/listeners between them. It never instantiates a
 *     sub-controller and never passes `this` to one.
 *   - Sub-controllers that legitimately depend on THIS facade receive it via a
 *     `setWorldStateController()` setter, called by the composition root AFTER
 *     this facade is fully constructed. See the JSDoc of each setter.
 *   - World initialization (`initializeWorld()`) and the initial capability
 *     scan are triggered by the composition root, not here, so that all facade
 *     references are in place before any code path that can trigger sub-controllers.
 *
 * The public method surface is snapshot-guarded by
 * test/contract/worldStateController.contract.test.js.
 */
class WorldStateController {
    /**
     * @param {Object} deps - Fully-constructed sub-controllers (injected by the
     *   composition root). See the individual JSDoc for each named dependency.
     * @param {UniversalTickSystem|null} [deps.tickSystem] - The global tick system.
     * @param {ComponentStatsController} deps.statsController
     * @param {TraitsController} deps.traitsController
     * @param {InternalComponentController} deps.internalComponentController
     * @param {ComponentController} deps.componentController
     * @param {EntityController} deps.entityController
     * @param {RoomsController} deps.roomsController
     * @param {InventoryManager} deps.inventoryManager
     * @param {EquippedItemStatsController} deps.equippedItemStats
     * @param {ComponentCapabilityController} deps.componentCapabilityController
     * @param {ActionSelectController} deps.actionSelectController
     * @param {SynergyController} deps.synergyController
     * @param {ConsequenceHandlers} deps.consequenceHandlers
     * @param {ActionController} deps.actionController
     * @param {stateEntityController} deps.stateEntityController
     * @param {HoldingCostController} deps.holdingCostController
     * @param {WorldEventLogController} deps.worldEventLogController
     * @param {LlmContextController} deps.llmContextController
     * @param {import('./hints/HintController.js')} deps.hintController
     * @param {import('../controllers/ai/InstinctController.js')} [deps.instinctController]
     * @param {import('./triggers/TriggerController.js')} [deps.triggerController]
     * @param {import('./materials/MaterialController.js')} [deps.materialController]
     * @param {import('./crafting/CraftingController.js')} [deps.craftingController]
     * @param {import('./knowledge/KnowledgeController.js')} [deps.knowledgeController]
     * @param {import('./core/EnergyFlowController.js')} [deps.energyFlowController] - The
     *   energy flow logic controller (constructed by the composition root). Its
     *   initialize() is called from this constructor right after the turn system's
     *   (same lifecycle as both peers); its OWN facade reference is injected
     *   post-construction by the composition root.
     */
    constructor(deps) {
        if (!deps || typeof deps !== 'object') {
            throw new Error(
                '[WorldStateController] Missing injected dependencies. ' +
                'Construct via buildWorldState() (src/composition/WorldComposition.js), ' +
                'not directly — the facade no longer self-instantiates its sub-controllers.'
            );
        }

        // --- Store the injected sub-controllers (named dependencies) -------------
        /** @private {UniversalTickSystem|null} */
        this.tickSystem = deps.tickSystem ?? null;
        /** @private {import('./triggers/TriggerController.js').default|null} */
        this.triggerController = deps.triggerController ?? null;
        this.statsController = deps.statsController;
        this.traitsController = deps.traitsController;
        this.internalComponentController = deps.internalComponentController;
        this.componentController = deps.componentController;
        this.entityController = deps.entityController;
        this.roomsController = deps.roomsController;
        this.inventoryManager = deps.inventoryManager;
        this.equippedItemStats = deps.equippedItemStats;
        this.componentCapabilityController = deps.componentCapabilityController;
        this.actionSelectController = deps.actionSelectController;
        this.synergyController = deps.synergyController;
        this.consequenceHandlers = deps.consequenceHandlers;
        this.actionController = deps.actionController;
        this.stateEntityController = deps.stateEntityController;
        this.holdingCostController = deps.holdingCostController;
        this.worldEventLogController = deps.worldEventLogController;
        this.llmContextController = deps.llmContextController;
        this.turnSystemController = deps.turnSystemController ?? null;
        // Hint system: deterministic suggestions for the player and the LLM agent.
        this.hintController = deps.hintController ?? null;
        // Feature D backend (spec §7.3): per-room chat ring buffers (state
        // owner; deliberately NO getAll() → excluded from the broadcast).
        this.roomChatController = deps.roomChatController ?? null;
        // Feature E: per-agent action-outcome feedback store (state owner;
        // deliberately NO getAll() → excluded from the broadcast).
        this.llmAgentFeedbackController = deps.llmAgentFeedbackController ?? null;
        // InstinctController: stateless behavior-primitive generator (null-tolerant).
        this.instinctController = deps.instinctController ?? null;
        /** @private {import('./materials/MaterialController.js')|null} */
        this.materialController = deps.materialController ?? null;
        // CraftingController: recipe registry (data/crafting.json). State
        // controller; null-tolerant like materialController (tests may build
        // the facade without it). Deliberately NOT in the subControllers map
        // below: it has no getAll() and must stay out of the getAll()/
        // broadcast aggregation (static recipe data).
        // See test/contract/crafting.contract.test.js for the seam usage.
        /** @private {import('./crafting/CraftingController.js')|null} */
        this.craftingController = deps.craftingController ?? null;
 // KnowledgeController: static "Knowledge" codex (wiki/subMDs/frontend/knowledge_viewer.md).
        // State controller; null-tolerant like craftingController (tests may
        // build the facade without it). Deliberately NOT in the subControllers map
        // below: it has no getAll() and must stay out of the getAll()/broadcast
        // aggregation (static codex data — the route reads it via getKnowledge()).
        /** @private {import('./knowledge/KnowledgeController.js')|null} */
        this.knowledgeController = deps.knowledgeController ?? null;
        // WorldRulesController: world-level rules registry (data/world_rules.json).
        // Null-tolerant like craftingController/knowledgeController — a test may
        // hand-build the facade without it. Deliberately NOT in the subControllers
        // broadcast map: static config data must stay out of the full-state
        // aggregation (same rule as craftingController / knowledgeController).
        /** @private {import('./worldRules/WorldRulesController.js')|null} */
        this.worldRulesController = deps.worldRulesController ?? null;
        // OnDamageDropListener: enforcement arm of the onDamage world-event rule.
        // A null-tolerant actor (no getAll()) — deliberately NOT in the subControllers
        // broadcast map (same rule as worldRulesController). The facade registers it
        // on the component damage-listener list below; the listener's OWN facade
        // reference is injected post-construction by the composition root.
        /** @private {import('./worldRules/OnDamageDropListener.js')|null} */
        this.onDamageDropListener = deps.onDamageDropListener ?? null;
        // EnergyFlowController: cross-component Physical.energy redistribution
 // (wiki/subMDs/systems/energy_flow.md). Logic controller — owns no persistent
        // world data, null-tolerant like worldRulesController (tests may build
        // the facade without it). Deliberately NOT in the subControllers
        // broadcast map: it has no getAll() and must stay out of the full-state
        // aggregation (same rule as worldRulesController / onDamageDropListener).
        /** @private {import('./core/EnergyFlowController.js').default|null} */
        this.energyFlowController = deps.energyFlowController ?? null;

        // EntityEnergyController: the whole-entity energy-life system (wiki/entity_attributes).
        // Per-turn drain of an entity's energy attribute; elimination (spill +
        // despawn) when the attribute reaches 0. Logic controller — no persistent
        // world data (reads the entity record via the facade's public API). Not in
        // the subControllers broadcast map: it has no getAll().
        /** @private {import('./core/EntityEnergyController.js').default|null} */
        this.entityEnergyController = deps.entityEnergyController ?? null;

        // --- Broadcast service (injected later via setBroadcastService()) --------
        /** @private {WorldStateBroadcastService|null} */
        this._broadcastService = null;

        // Re-entrancy counter for stat-change listeners.
        // Incremented at entry of removeBrokenComponent, decremented in finally.
        // Listeners only broadcast when counter === 0 → exactly 1 broadcast per cascade chain.
        /** @private {number} */
        this._cascadeReentrancyCount = 0;
        // Flow-scope counter (mirrors _cascadeReentrancyCount, wiki/subMDs/systems/energy_flow.md):
        // the energy flow is mid-step, so the stat-change
        // broadcast gate suppresses per-write broadcasts; the step itself closes
        // the scope with at most one full-state broadcast (only if something
        // moved). The counter is incremented/decremented in lockstep by
        // beginEnergyFlowTurn() / endEnergyFlowTurn() — always balanced by the
        // flow controller's begin → work → finally close.
        /** @private {number} */
        this._energyFlowScopeCount = 0;
        /**
         * @private {Set<string>|null} — shared visited-set across recursive cascade (§3.6.4).
         * One logical cascade chain per re-entrant break event; the shared set prevents
         * re-visiting components within that chain. The chain terminates, and the set is
         * (re)established per chain via the re-entrancy counter guards at lines ~2104-2106
         * and ~2147-2148. This is by design — not a spec violation.
         */
        this._cascadeVisitedSet = null;
        /**
         * @private {Set<string>|null} — per-root-cascade set of all entityIds that
         * entered removeBrokenComponent during the current cascade chain (root or
         * re-entry). Initialized and cleared in lockstep with _cascadeVisitedSet.
         * At root exit (re-entrancy count → 0), every id in this set receives the
         * entity-level elimination check. Size > 1 indicates a cross-entity cascade
         * (the same-entity assumption was violated — logged as a warning).
         */
        this._cascadeAffectedEntityIds = null;

        // Map of sub-controllers for easy iteration/extension
        this.subControllers = {
            rooms: this.roomsController,
            entities: this.stateEntityController,
            components: this.componentController,
            internalComponents: this.internalComponentController,
            actions: this.actionController,
            capabilities: this.componentCapabilityController,
            synergy: this.synergyController,
            selections: this.actionSelectController,
            inventory: this.inventoryManager,
            holdingCost: this.holdingCostController,
            equippedItemStats: this.equippedItemStats
            // NOTE: `triggers` entry removed — no code in src/ reads `subControllers.triggers`;
            // TriggerController is accessed directly via `this.triggerController` where needed.
        };

        // --- Wire internal observers/listeners between sub-controllers -----------
        // NOTE: none of these callbacks dereference the facade's own state at
        // construction time; they run later (on spawn / on stat change), by which
        // point the composition root has injected the facade into every sub-controller.

        // Register spawn observer — applies the declarative initial spawns from
        // data/world.json to every spawned entity (data-driven replacement of the
        // former hardcoded spawn items).
        this.stateEntityController.registerSpawnObserver((entityId) => {
            this._applyInitialSpawns(entityId);
        });

        // Wire up stat change notifications from ComponentController to
        // ComponentCapabilityController — enables automatic capability
        // re-evaluation when component stats change (+ broadcast).
        // Also delegate to TriggerController for component:broke detection.
        // Broadcast only when cascadeReentrancyCount === 0 (exactly 1 broadcast per chain).
        this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
            this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
            
            // Delegate to TriggerController for crossing detection
            if (this.triggerController && traitId === TRAIT_GROUPS.PHYSICAL && statName === STAT_NAMES.EXISTENCE) {
                // Find which entity owns this component via public API
                let owningEntity;
                owningEntity = this.stateEntityController.findEntityByComponent(componentId);
                // Edge cases: when owning entity is despawned, the component:broke
                // event must STILL be logged; only removal/spill/drop side-effects are skipped.
                // We always call onComponentBrokeCheck so the event is emitted per spec.
                // When the entity or its anchors are missing we pass honest fallbacks.
                if (!owningEntity || !owningEntity.location || !owningEntity.spatial) {
                    Logger.warn(
                        `[WorldStateController] Component ${componentId} broke but owning entity/anchors missing — event still logged; removal/spill/drop skipped.`
                    );
                    this.triggerController.onComponentBrokeCheck(
                        componentId,
                        owningEntity?.id ?? componentId,
                        oldValue,
                        newValue,
                        {
                            roomId: null,
                            position: { x: 0, y: 0 },
                            tick: this.tickSystem?.currentTick ?? 0
                        }
                    );
                } else {
                    this.triggerController.onComponentBrokeCheck(
                        componentId,
                        owningEntity.id,
                        oldValue,
                        newValue,
                        {
                            roomId: owningEntity.location,
                            position: owningEntity.spatial,
                            tick: this.tickSystem?.currentTick ?? 0
                        }
                    );
                }
            }
            
            // Trigger broadcast if broadcastService is available and not in middle of cascade,
            // AND not in the middle of an energy-flow step (the flow closes its scope with at
            // most one full-state broadcast — see endEnergyFlowTurn; wiki/subMDs/systems/energy_flow.md).
            if (this._broadcastService && this._cascadeReentrancyCount === 0 && this._energyFlowScopeCount === 0) {
                this._broadcastService.broadcast();
            }
        });

        // onDamage world-event rule: subscribe the consumer to the component
        // damage-listener list (source-agnostic weakening events). Null-tolerant —
        // a hand-built facade without the listener is a no-op. The listener's OWN
        // facade reference is injected by the composition root (post-construction),
        // so by the time any real damage event fires it is already wired.
        this.componentController.registerDamageListener((componentId, traitId, statName, oldValue, newValue) => {
            this.onDamageDropListener?.handleDamage(componentId, traitId, statName, oldValue, newValue);
        });

        // Initialize the Turn System (Feature A) with the global tick system —
        // same pattern as internal components: the job registration is
        // side-effect-free until tickSystem.start(). The facade reference is
        // injected by the composition root AFTER this constructor.
        this.turnSystemController?.initialize();

        // Initialize the Energy Flow (wiki/subMDs/systems/energy_flow.md) — right after the
        // turn system's initialize(): it resolves the `energyFlow` rule once and
        // fail-soft-validates the per-recipe capacity fields. The per-turn flow
        // step itself is driven from the turn system's round-start hook (after
        // the IC turn step), not a tick job. Same lifecycle as its peers:
        // side-effect-free until a round starts, and the facade reference is
        // injected by the composition root AFTER this constructor.
        this.energyFlowController?.initialize();

        // Wire equippedItemStats stat change callback to trigger capability
        // re-evaluation. When an equipped item's stats change (e.g., sharpness
        // drain from cut), the capability cache re-scans with CURRENT stats, not
        // stale base stats.
        // Also delegate to TriggerController.onEquippedItemBrokeCheck
        // when traitId==='Physical' && statName==='existence' (P8 path).
        this.equippedItemStats.setStatChangeCallback((eqId, traitId, statName, newValue, oldValue) => {
            // P8 delegate: delegate to TriggerController BEFORE the broadcast
            if (this.triggerController && traitId === TRAIT_GROUPS.PHYSICAL && statName === STAT_NAMES.EXISTENCE) {
                const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
                for (const [entityId, items] of Object.entries(allEquipped)) {
                    if (items[eqId]) {
                        const equippedData = items[eqId]; // { eqId, itemId, itemType, componentId }
                        // Resolve entity spatial position via public API
                        const entity = this.stateEntityController.getEntity(entityId);
                        const extra = {
                            roomId: entity?.location ?? null,
                            position: entity?.spatial ?? { x: 0, y: 0 },
                            itemType: equippedData.itemType || null,
                            componentId: equippedData.componentId || null,
                            itemId: equippedData.itemId || eqId,
                            tick: this.tickSystem?.currentTick ?? 0
                        };
                        this.triggerController.onEquippedItemBrokeCheck(
                            eqId, entityId, equippedData.componentId || null,
                            oldValue, newValue, extra
                        );
                        break; // only one entity can own this eqId
                    }
                }
            }

            // Find which entity this item belongs to by scanning equipped items.
            // HoldingCostController.getEquippedItemsByEntity() returns: { [entityId]: { [eqId]: itemData } }
            const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
            for (const [entityId, items] of Object.entries(allEquipped)) {
                if (items[eqId]) {
                    // Entity found — re-evaluate its capabilities with current stats
                    const state = this.getAll();
                    this.actionController.reEvaluateEntityCapabilities(state, entityId);
                    // Broadcast only when cascadeReentrancyCount === 0
                    if (this._broadcastService && this._cascadeReentrancyCount === 0) {
                        this._broadcastService.broadcast();
                    }
                    Logger.info(`[WorldStateController] Capability re-evaluated for entity "${entityId}" after ${traitId}.${statName} changed: ${oldValue} → ${newValue}`);
                    return;
                }
            }
        });
    }

    /**
     * Sets up initial world state. NPCs are spawned via _spawnNpcs();
     * player droids are incarnated only via socket connection.
     */
    initializeWorld() {
        // Feature D (spec §7.2): spawn the data-driven NPCs from data/npcs.json
        // (e.g. "Bolt the Merchant" in the start room). NPCs are NOT in
        // world.json initialSpawns — their goods come from initialItems.
        this._spawnNpcs();
    }

    /**
     * FASE 6 (facade logic extraction): Spawns every NPC declared in data/npcs.json (Feature D, spec §7.2).
     * Implementation: src/controllers/logic/NpcSpawnLogic.js (`spawnDataDrivenNpcs`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
     */
    _spawnNpcs() {
        return spawnDataDrivenNpcs(this);
    }

    /**
     * FASE 6 (facade logic extraction): Data-driven spawn gate for a single registry entry.
     * Implementation: src/controllers/logic/NpcSpawnLogic.js (`checkNpcSpawnGate`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entry
 * @param {*} blueprint
     */
    _checkNpcSpawnGate(entry, blueprint) {
        return checkNpcSpawnGate(this, entry, blueprint);
    }

    /**
     * FASE 6 (facade logic extraction): Validates the optional ai block at boot (M1 + M4).
     * Implementation: src/controllers/logic/NpcSpawnLogic.js (`normalizeNpcAiConfig`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entry
     */
    _normalizeNpcAiConfig(entry) {
        return normalizeNpcAiConfig(this, entry);
    }

    /**
     * FASE 6 (facade logic extraction): Assembles the persisted npcConfig for a registry entry.
     * Implementation: src/controllers/logic/NpcSpawnLogic.js (`buildNpcConfig`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entry
 * @param {*} normalizedAi
     */
    _buildNpcConfig(entry, normalizedAi) {
        return buildNpcConfig(this, entry, normalizedAi);
    }

    /**
     * FASE 6 (facade logic extraction): Applies the entry's initialItems to a just-spawned entity.
     * Implementation: src/controllers/logic/NpcSpawnLogic.js (`applyInitialItems`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entityId
 * @param {*} entry
     */
    _applyInitialItems(entityId, entry) {
        return applyInitialItems(this, entityId, entry);
    }

    /**
     * FASE 6 (facade logic extraction): Resolves the host component for an initialItems entry flagged `equip: true`.
     * Implementation: src/controllers/logic/NpcSpawnLogic.js (`resolveEquippableHostComponent`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entity
 * @param {*} itemType
     */
    _resolveEquippableHostComponent(entity, itemType) {
        return resolveEquippableHostComponent(this, entity, itemType);
    }

    /**
     * FASE 6 (facade logic extraction): Applies the declarative initial spawns from data/world.json to a spawned entity.
     * Implementation: src/controllers/logic/InitialSpawnLogic.js (`applyInitialSpawns`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entityId
 * @param {*} spawnConfig
     */
    _applyInitialSpawns(entityId, spawnConfig) {
        return applyInitialSpawns(this, entityId, spawnConfig);
    }

    /**
     * FASE 6 (facade logic extraction): Resolves the target component for an initial-spawn entry.
     * Implementation: src/controllers/logic/InitialSpawnLogic.js (`resolveInitialSpawnSlot`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entity
 * @param {*} entry
     */
    _resolveInitialSpawnSlot(entity, entry) {
        return resolveInitialSpawnSlot(this, entity, entry);
    }

    /**
     * Returns the per-entity-type attribute declaration registry as seen by a
     * given blueprint name. Lets the client (stat-bar panel) and any backend
     * consumer read the full ceiling/drain of a blueprint's whole-entity
     * attributes without reaching into the raw data file.
     * @param {string|null|undefined} [blueprintName]
     * @returns {Object<string, { value: number, max: number, drainPerTurn: number }>}
     */
    getEntityAttributeDeclarations(blueprintName) {
        return getAttributes(blueprintName);
    }

    /**
     * Returns the current (live) value of one entity attribute (whole-entity stat,
     * e.g. Physical.energy). Returns null when the entity, trait or stat is
     * missing.
     * @param {string} entityId - The entity id.
     * @param {string} traitId - The trait group key (e.g. "Physical").
     * @param {string} statName - The stat name (e.g. "energy").
     * @returns {number|null}
     */
    getEntityAttribute(entityId, traitId, statName) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity || !entity.attributes) return null;
        const group = entity.attributes[traitId];
        if (!group) return null;
        return group[statName] == null ? null : Number(group[statName]) || 0;
    }

    /**
     * Returns the declaration ({ value, max, drainPerTurn }) for one entity
     * attribute, or null when the entity/stat is missing.
     * @param {string} entityId
     * @param {string} traitId
     * @param {string} statName
     * @returns {Object|null}
     */
    getEntityAttributeConfig(entityId, traitId, statName) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity || !entity.attributesConfig) return null;
        const group = entity.attributesConfig[traitId];
        if (!group) return null;
        return group[statName] ?? null;
    }

    /**
     * Adjusts one entity attribute by a delta, clamping it into [0, max].
     * Returns true when the value actually changed (broadcasting on change,
     * gated by cascade reentrancy like other stat changes). The max is read
     * from the attribute declaration so a mis-tuned cap can never exceed the
     * declared ceiling.
     * @param {string} entityId
     * @param {string} traitId - The trait group key (e.g. "Physical").
     * @param {string} statName - The stat name (e.g. "energy").
     * @param {number} delta - The amount to add (positive = charge, negative = drain).
     * @param {boolean} [broadcast=true] - Broadcast the change after writing it.
     * @returns {boolean} Whether the value changed.
     */
    setEntityAttributeDelta(entityId, traitId, statName, delta, broadcast = true) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity || !entity.attributes) return false;
        const group = entity.attributes[traitId];
        if (!group || !(statName in group)) return false;
        const config = entity.attributesConfig && entity.attributesConfig[traitId] ?
            entity.attributesConfig[traitId][statName] : null;
        const max = config && typeof config.max === 'number' ? Math.max(0, config.max) : 0;
        const previousValue = Number(group[statName]) || 0;
        const newValue = Math.max(0, Math.min(max, previousValue + (Number(delta) || 0)));
        if (newValue === previousValue) return false;
        group[statName] = newValue;
        if (broadcast && this._broadcastService && this._cascadeReentrancyCount === 0) {
            this._broadcastService.broadcast();
        }
        return true;
    }

    /**
     * Eliminates an entity by energy death: spills ALL of its items (its own
     * inventory, which holds every item it carries — each tagged with the
     * component that holds it) to the floor, then despawns the entity.
     * Called by EntityEnergyController when the entity's energy attribute hits 0.
     * No-op when the entity is absent/inactive (double-elimination is safe).
     * @param {string} entityId
     * @returns {boolean} Whether this call actually eliminated (removed) an entity.
     */
    eliminateEntityByEnergy(entityId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity || entity.status !== 'active') return false;
        try {
            this._spillAllEntityItems(entityId);
            this.stateEntityController.despawnEntity(entityId);
            Logger.warn(`[WorldStateController] Entity ${entityId} eliminated (energy exhausted).`);
            return true;
        } catch (error) {
            Logger.error(`[WorldStateController] Failed to eliminate entity ${entityId} by energy: ${error.message}`, {
                entityId: entityId,
                error: error.message
            });
            return false;
        }
    }

    /**
     * FASE 6 (facade logic extraction): Death path for an energy-exhausted entity: spill live contents to the floor, then clear inventory.
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`spillAllEntityItems`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entityId
     */
    _spillAllEntityItems(entityId) {
        return spillAllEntityItems(this, entityId);
    }

    /**
     * Aggregates state data from all registered sub-controllers.
     * This method serves as a unified "getState" for the entire world.
     * @returns {Object} The combined state of the world.
     */
    getAll() {
        const globalState = {};

        // Dynamically collect data from all sub-controllers that implement getAll()
        for (const [key, controller] of Object.entries(this.subControllers)) {
            if (typeof controller.getAll === 'function') {
                globalState[key] = controller.getAll();
            }
        }

        // Include dropped items in the global state for real-time broadcast
        const droppedItems = this.getDroppedItems();
        if (droppedItems && Object.keys(droppedItems).length > 0) {
            globalState.droppedItems = droppedItems;
        }

        return globalState;
    }

    /**
     * Returns a deep clone of the entity map (same data as
     * stateEntityController.getAll()), exposed as a public facade method so
     * that callers do not need to reach into sub-controllers directly.
     * @returns {Object} Deep clone of the entities store.
     */
    getEntities() {
        if (typeof this.stateEntityController?.getAll === 'function') {
            return this.stateEntityController.getAll();
        }
        return {};
    }

    /**
     * Returns the action registry from the action sub-controller, exposed as a
     * public facade method so that callers do not need to reach into
     * sub-controllers directly.
     * @returns {Object} The action registry keyed by action name.
     */
    getActionRegistry() {
        if (typeof this.actionController?.getRegistry === 'function') {
            return structuredClone(this.actionController.getRegistry());
        }
        return {};
    }

    // =========================================================================
    // PERSISTENCE — serialize() / restore() (FASE 3)
    // =========================================================================

    /**
     * Snapshot schema version. Bump when the snapshot format changes;
     * restore() rejects any other version with SCHEMA_VERSION_MISMATCH.
     */
    static get PERSISTENCE_SCHEMA_VERSION() {
        // v2 (Feature B): snapshot gains the "events" section (world event
        // ring buffer). v3 (two-phase barrier turns): the "turns" section
        // gains the "barrier" sub-state (roster, signaled, close info) plus
        // the stored phase. v1/v2 snapshots are rejected by restore() — the
        // strict versioning contract is documented in the persistence tests.
        return 3;
    }

    /**
     * Serializes the COMPLETE mutable world state into a JSON-serializable
     * snapshot, for save/load, checkpoints, and test/debug snapshots.
     *
     * Coverage (every piece of mutable state a sub-controller owns — see the
     * "IMPL DECISION" note on restore() for the ownership map):
     *   - entities:  live entity instances (ids, components, spatial, status,
     *                items with full nesting via hostComponentId, internalComponents)
     *   - components: per-instance merged stats (ComponentStatsController)
     *   - inventory: InventoryManager._inventory index (mirrors entity.items,
     *                kept in sync so the manager's index matches on restore)
     *   - equipped:  HoldingCostController._equippedItems + _preEquipStats
     *                (pre-equip stats keep unequip-undo bookkeeping intact)
     *   - equippedItemStats: EquippedItemStatsController._itemStats
     *                        (mutable sharpness/existence per eqId)
     *   - internalComponents: InternalComponentController.internalComponents
     *                        (canonical store; entity.internalComponents mirrors it)
     *   - rooms:     dynamic room state (entities/objects lists) — the room
     *                structure itself (positions, connections, doorPositions)
     *                is static data from data/rooms.json and is intentionally
     *                NOT snapshotted
     *   - droppedItems: WorldStateController._droppedItems
     *   - selections: ActionSelectController._selectionRegistry (Map → array)
     *
     * Defensiveness: the snapshot is a JSON round-trip (same defensiveness
     * pattern the project uses for broadcasts — WorldStateBroadcastService
     * _transformForBroadcast does structuredClone; JSON.parse(JSON.stringify())
     * is equivalent for this pure data and additionally guarantees no live
     * references, Maps, or functions leak out).
     *
     * All IDs (ent-, comp-, item-, eq-, room UIDs, internal-component UIDs)
     * are PRESERVED in the snapshot — a restored world is identical to the
     * one that produced it (modulo serializedAtTick/serializedAt metadata).
     *
     * @returns {Object} JSON-serializable snapshot:
     *   { schemaVersion: number, serializedAtTick: number|null,
     *     serializedAt: number, state: { entities, components, inventory,
     *     equipped, preEquipStats, equippedItemStats, internalComponents,
     *     rooms, droppedItems, selections, events, turns, roomChat } }
     */
    serialize() {
        const snapshot = {
            schemaVersion: WorldStateController.PERSISTENCE_SCHEMA_VERSION,
            serializedAtTick: this.internalComponentController?.tickSystem?.currentTick ?? null,
            serializedAt: Date.now(),
            state: {
                // Entities (live instances; the spread in .map() creates new objects,
                // and the final JSON round-trip at the method bottom guarantees no
                // live references — so the intermediate structuredClone is redundant).
                // Defense-in-depth: strip the legacy boot-time flag
                // `_skipInitialSpawns` from any entity record so the snapshot
                // can never carry it (new spawns no longer inject it, but
                // records restored from older snapshots might).
                entities: Object.fromEntries(
                    Object.entries(this.stateEntityController.getAll())
                        .map(([entityId, entity]) => [entityId, {
                            ...entity,
                            _skipInitialSpawns: undefined
                        }])
                ),
                // Component instance stats (full merged stats per comp-* id)
                components: this.componentController.statsController.getAll(),
                // InventoryManager's per-entity item index
                inventory: structuredClone(this.inventoryManager._inventory),
                // Equipped items + pre-equip stat bookkeeping (undo data)
                equipped: structuredClone(this.holdingCostController._equippedItems),
                preEquipStats: structuredClone(this.holdingCostController._preEquipStats),
                // Mutable per-equipped-item stats (sharpness, existence, ...)
                equippedItemStats: this.equippedItemStats.getAll(),
                // Canonical internal-component store
                internalComponents: structuredClone(this.internalComponentController.internalComponents),
                // Dynamic room state only (structure comes from data/rooms.json)
                rooms: this.roomsController.getAll(),
                // Dropped items on the map
                droppedItems: this.getDroppedItems(),
                // Active component→action selection locks (Map serialized to array)
                selections: [...this.actionSelectController._selectionRegistry.entries()],
                // World event ring buffer (Feature B, schema v2)
                events: this.worldEventLogController.serialize(),
                // Turn system bookkeeping (Feature A, schema v3).
                // { roundNumber, phase, queues, resolvedRound, lastRound, barrier }
                // Fallback when no turn system is injected: DEFAULT_TURNS_SNAPSHOT
                // — the single shared definition (also used by _reset()), so the
                // fallback can never drift from the real serialize() shape.
                turns: this.turnSystemController?.serialize() ?? DEFAULT_TURNS_SNAPSHOT,
                // Room chat store (Feature D backend, schema v2 — additive).
                // { [roomId]: [ { id, roomId, speakerName, speakerEntityId, text, tick, ts } ] }
                roomChat: this.roomChatController?.serialize() ?? {}
            }
        };

        // JSON round-trip: guarantees the result is a pure JSON-serializable
        // snapshot with zero references into the live world state.
        return JSON.parse(JSON.stringify(snapshot));
    }

    /**
     * Restores the complete world state from a snapshot produced by serialize().
     *
     * IMPL DECISION — option (a): per-sub-controller state injection.
     * Each state-owning sub-controller exposes a plain data store
     * (entities, componentStats, _inventory, _equippedItems/_preEquipStats,
     * _itemStats, internalComponents, rooms, _droppedItems, _selectionRegistry)
     * that has NO derived logic — the logic controllers (ActionController,
     * ComponentCapabilityController, SynergyController, ...) derive everything
     * on demand. Restoring therefore means:
     *   1. validate the payload (shape + schemaVersion),
     *   2. replace each owned store with a deep-cloned copy of the snapshot
     *      section (no live references shared with the caller),
     *   3. rebuild derived caches via the EXISTING public APIs:
     *        - stateEntityController._restoreFromSnapshot() re-syncs each
     *          entity's internalComponents mirror from the canonical internal
     *          store (run AFTER the internal store itself is restored, so the
     *          mirror matches the restored data). Spawn observers are NOT
     *          fired: the snapshot already contains the final entity state,
     *          and re-running the declarative initial-spawn path would
     *          double-add items.
     *        - actionController.scanAllCapabilities() rebuilds the capability
     *          cache from the restored state (fresh cache, same as constructor).
     *        - synergyController.clearCache() drops stale cached results.
     *
     * Why (a) over (b) (re-apply via public action APIs): re-applying would
     * re-run the spawn logic (which generates NEW ids for entities,
     * components, items — breaking id preservation, a round-trip requirement),
     * re-generate eqIds, and cannot reconstruct _preEquipStats or
     * selection locks at all. Direct store injection preserves every id and
     * bookkeeping field, and it is the same primitive the constructor itself
     * uses (fresh stores, then populate).
     *
     * Known limitation (documented): rooms.json door positions and the idMap
     * are structural/static; restore() replaces the dynamic room entries
     * (entities/objects) but keeps the constructor-built structure. Since
     * room structure is data-driven and immutable at runtime, this is safe
     * for the current game.
     *
     * NOTE: this is an explicit operator/test operation — it does NOT run on
     * a tick and does NOT broadcast (callers broadcast after a successful
     * restore, e.g. the /api/world/load route).
     *
     * @param {Object} payload - Snapshot as returned by serialize().
     * @returns {{ success: true } | { success: false, error: { code: string, message: string } }}
     */
    restore(payload) {
        // --- Validation -----------------------------------------------------
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: 'restore() requires a snapshot object (result of serialize()).' }
            };
        }
        if (payload.schemaVersion !== WorldStateController.PERSISTENCE_SCHEMA_VERSION) {
            return {
                success: false,
                error: {
                    code: 'SCHEMA_VERSION_MISMATCH',
                    message: `Unsupported schemaVersion ${JSON.stringify(payload.schemaVersion)} — expected ${WorldStateController.PERSISTENCE_SCHEMA_VERSION}.`
                }
            };
        }
        const s = payload.state;
        if (!s || typeof s !== 'object') {
            return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: 'Snapshot is missing the "state" section.' }
            };
        }
        for (const key of ['entities', 'components', 'inventory', 'equipped', 'preEquipStats', 'equippedItemStats', 'internalComponents', 'rooms', 'droppedItems', 'selections', 'events']) {
            if (!(key in s)) {
                return {
                    success: false,
                    error: { code: 'INVALID_PAYLOAD', message: `Snapshot "state" is missing required section "${key}".` }
                };
            }
        }
        // NOTE: "turns" (Feature A) and "roomChat" (Feature D) are intentionally
        // OMITTED from the required list above — a well-formed v3 snapshot may
        // lack either section (the turn bookkeeping simply resumes idle; the
        // phase is stored state, so an absent section means round 0 starts
        // lazily on the next onTick(); chat is ephemeral memory). Versioning
        // is strict at schema v3: the schemaVersion check above rejects every
        // other version outright.

        try {
            // 1. Canonical internal-component store FIRST — the entity
            //    mirror re-sync in step 2 reads from this store, so the
            //    restored values must be in place before entities are restored.
            this.internalComponentController.internalComponents = structuredClone(s.internalComponents);

            // 2. Entities (re-syncs each entity's internalComponents mirror
            //    from the canonical store above — see stateEntityController).
            //    Legacy snapshots may still carry the boot-time
            //    `_skipInitialSpawns` flag on NPC records — strip it (it is
            //    never persisted by serialize() anymore); the opt-out of the
            //    declarative spawns keys off the persisted isNPC field.
            const restoredEntities = structuredClone(s.entities);
            for (const entity of Object.values(restoredEntities)) {
                delete entity._skipInitialSpawns;
            }
            this.stateEntityController._restoreFromSnapshot(restoredEntities);

            // 3. Component instance stats (plain store replacement)
            this.componentController.statsController.componentStats = structuredClone(s.components);

            // 4. InventoryManager item index (entity.items already restored
            //    with the entities above; this re-syncs the manager's index).
            //    Re-derive material traits for old-format snapshots that lack them.
            this.inventoryManager._inventory = structuredClone(s.inventory);
            this.inventoryManager.resyncItemTraits();

            // 5. Equipped items + pre-equip undo bookkeeping
            this.holdingCostController._equippedItems = structuredClone(s.equipped);
            this.holdingCostController._preEquipStats = structuredClone(s.preEquipStats);

            // 6. Mutable per-equipped-item stats
            this.equippedItemStats._itemStats = structuredClone(s.equippedItemStats);

            // 7. Dynamic room state (replace entries; keep constructor-built
            //    structure: idMap + doorPositions come from data/rooms.json)
            const restoredRooms = structuredClone(s.rooms);
            for (const roomId of Object.keys(this.roomsController.rooms)) {
                delete this.roomsController.rooms[roomId];
            }
            for (const [roomId, room] of Object.entries(restoredRooms)) {
                this.roomsController.rooms[roomId] = room;
            }

            // 8. Dropped items
            this._droppedItems = structuredClone(s.droppedItems);

            // 9. Selection locks (array → Map)
            const registry = new Map();
            for (const [componentId, selection] of (Array.isArray(s.selections) ? s.selections : [])) {
                if (typeof componentId === 'string' && selection && typeof selection === 'object') {
                    registry.set(componentId, { ...selection });
                }
            }
            this.actionSelectController._selectionRegistry = registry;

            // 10. World event ring buffer (Feature B)
            this.worldEventLogController.restore(structuredClone(s.events));

            // 10b. Turn system bookkeeping (Feature A — optional section)
            if (s.turns && typeof s.turns === 'object') {
                this.turnSystemController?.restore(structuredClone(s.turns));
            }

            // 10c. Room chat store (Feature D backend — optional section:
            //     early v2 snapshots predate it and are still accepted; chat
            //     is ephemeral memory, its absence simply means "empty")
            if (s.roomChat && typeof s.roomChat === 'object') {
                this.roomChatController?.restore(structuredClone(s.roomChat));
            }

            // 11. Rebuild derived caches via existing public APIs
            this.actionController.scanAllCapabilities(this.getAll());
            if (this.synergyController?.clearCache) {
                this.synergyController.clearCache();
            }

            Logger.info(
                `[WorldStateController] World state restored from snapshot (schemaVersion ${WorldStateController.PERSISTENCE_SCHEMA_VERSION}, ` +
                `${Object.keys(this.stateEntityController.getAll()).length} entities, ${Object.keys(this._droppedItems).length} dropped items).`
            );
            return { success: true };
        } catch (error) {
            Logger.error(`[WorldStateController] restore() failed: ${error.message}`, { error: error.stack });
            return {
                success: false,
                error: { code: 'RESTORE_FAILED', message: `Failed to restore world state: ${error.message}` }
            };
        }
    }

    // =========================================================================
    // PUBLIC API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Spawns an entity from a blueprint into a room.
     * @param {string} blueprintName - The blueprint to use.
     * @param {string} roomId - The room to spawn into.
     * @returns {string} The new entity ID.
     */
    spawnEntity(blueprintName, roomId) {
        return this.stateEntityController.spawnEntity(blueprintName, roomId);
    }

    /**
     * Despawns an entity and cleans up its capabilities.
     * @param {string} entityId - The entity to despawn.
     * @returns {boolean} True if successful.
     */
    despawnEntity(entityId) {
        return this.stateEntityController.despawnEntity(entityId);
    }

    /**
     * Moves an entity to a different room.
     * @param {string} entityId - The entity to move.
     * @param {string} targetRoomId - The destination room.
     * @param {Object} [options] - Optional parameters.
     * @param {string} [options.sourceDoor] - The door name the entity exited from in the source room.
     * @returns {boolean} True if successful.
     */
    moveEntity(entityId, targetRoomId, options = {}) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            return false;
        }

        let spawnSpatial = null;
        if (options.sourceDoor) {
            const sourceRoomId = entity.location;
            spawnSpatial = this.roomsController.getSpawnPositionForDoorTraversal(
                sourceRoomId,
                options.sourceDoor,
                targetRoomId
            );
        }

        const moveOptions = spawnSpatial ? { spatial: spawnSpatial } : {};
        return this.stateEntityController.moveEntity(entityId, targetRoomId, moveOptions);
    }

    /**
     * Resolves a logical room name to its UUID.
     * @param {string} logicalId - The logical room name.
     * @returns {string|null} The room UUID or null.
     */
    getRoomUidByLogicalId(logicalId) {
        return this.roomsController.getUidByLogicalId(logicalId);
    }

    /**
     * Retrieves an entity by its ID.
     * Provides a public API for accessing entity state instead of direct property access.
     * @param {string} entityId - The entity ID.
     * @returns {Object|null} The entity object, or null if not found.
     */
    getEntity(entityId) {
        return this.stateEntityController.getEntity(entityId);
    }

    /**
     * Retrieves component stats by component ID.
     * @param {string} componentId - The component ID.
     * @returns {Object|null} The component stats object, or null if not found.
     */
    getComponentStats(componentId) {
        return this.componentController.getComponentStats(componentId);
    }

    /**
     * Opens an energy-flow broadcast scope (wiki/subMDs/systems/energy_flow.md)
     *
     * Called by the EnergyFlowController at the start of one flow turn. While
     * the scope count is > 0, the component stat-change broadcast gate
     * suppresses its per-write broadcasts, so a flow turn that changes many
     * components does not fire one broadcast per component. The scope is
     * closed (and, if requested, the single full-state broadcast fires) by the
     * matching endEnergyFlowTurn() — always via the controller's
     * begin → work → finally close, so the two calls are balanced.
     * Mirrors the documented _cascadeReentrancyCount pattern.
     * @returns {void}
     */
    beginEnergyFlowTurn() {
        this._energyFlowScopeCount++;
    }

    /**
     * Closes an energy-flow broadcast scope (wiki/subMDs/systems/energy_flow.md)
     *
     * When the scope count returns to zero, exactly one full-state broadcast is
     * emitted if — and only if — `shouldBroadcast` is true (the flow turn
     * wrote at least one stat) and a broadcast service is wired. When nothing
     * moved, the step is silent: zero broadcasts (steady-state and zero-energy
     * worlds produce no client traffic from the flow).
     * @param {boolean} shouldBroadcast - True when the flow turn wrote any stat.
     * @returns {void}
     */
    endEnergyFlowTurn(shouldBroadcast) {
        this._energyFlowScopeCount--;
        if (this._energyFlowScopeCount === 0 && shouldBroadcast && this._broadcastService) {
            this._broadcastService.broadcast();
        }
    }

    /**
     * Returns a component's full flag set (derived flags like flammable/
     * conductive — a pure function of the material composition — plus granted
     * flags like corrosive set by organs on install), unioned and sorted.
     * Flags are derived on read so they never desync from the composition.
     * @param {string} componentId - The component ID.
     * @returns {string[]} Sorted array of active flag names.
     */
    getComponentFlags(componentId) {
        return this.componentController.getComponentFlags(componentId);
    }

    /**
     * Returns a component's transient conditions (burning, wet, corroded) as a
     * defensive copy. These are stored world state (they survive save/load).
     * @param {string} componentId - The component ID.
     * @returns {string[]} Copy of the active condition names.
     */
    getComponentConditions(componentId) {
        return this.componentController.getComponentConditions(componentId);
    }

    // =========================================================================
    // INTERNAL COMPONENT API (for internal components system)
    // =========================================================================

    /**
     * Adds an internal component to a host component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to add.
     * @returns {Object|null} The created instance, or null if failed.
     */
    addInternalComponent(entityId, hostComponentId, internalComponentType) {
        return this.internalComponentController.addInternalComponent(entityId, hostComponentId, internalComponentType);
    }

    /**
     * Gets internal components for a specific host component.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @returns {Array} Deep copy of internal component instances for the host.
     */
    getInternalComponents(entityId, hostComponentId) {
        return this.internalComponentController.getInternalComponents(entityId, hostComponentId);
    }

    /**
     * Gets all internal components for an entity.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Deep copy of all internal components for the entity.
     */
    getInternalComponentsForEntity(entityId) {
        return this.internalComponentController.getInternalComponentsForEntity(entityId);
    }

    /**
     * Removes an internal component from a host component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentInstanceId - The internal component instance ID to remove.
     * @returns {boolean} True if removed successfully.
     */
    removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId) {
        return this.internalComponentController.removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId);
    }

    /**
     * Checks if a host component has a specific type of internal component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to check.
     * @returns {boolean} True if the host has the specified internal component type.
     */
    hasInternalComponent(entityId, hostComponentId, internalComponentType) {
        return this.internalComponentController.hasInternalComponent(entityId, hostComponentId, internalComponentType);
    }

    /**
     * Cleans up all internal components for a specific entity.
     * Called when an entity is despawned.
     * @param {string} entityId - The entity ID to clean up.
     * @returns {boolean} True if cleanup was performed.
     */
    cleanupInternalComponents(entityId) {
        return this.internalComponentController.cleanupEntity(entityId);
    }

    // =========================================================================
    // SYNERGY PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Computes synergy for an action without executing it.
     * @param {string} actionName - The action name
     * @param {string} entityId - The entity executing the action
     * @param {Object} [context] - Optional context (e.g., synergyGroups for multi-entity)
     * @returns {Object} SynergyResult object
     */
    computeSynergy(actionName, entityId, context) {
        return this.synergyController.computeSynergy(actionName, entityId, context);
    }

    /**
     * Gets all actions that have synergy enabled.
     * @returns {string[]} Array of action names with synergy
     */
    getActionsWithSynergy() {
        return this.synergyController.getActionsWithSynergy();
    }

    /**
     * Gets synergy configuration for an action.
     * @param {string} actionName - The action name
     * @returns {Object} Synergy config object
     */
    getSynergyConfig(actionName) {
        return this.synergyController.getSynergyConfig(actionName);
    }

    // =========================================================================
    // ACTION DATA PREVIEW (for synergy preview system)
    // =========================================================================

    /**
     * Previews action data including resolved values and synergy for a given component selection.
     * Used by the enhanced synergy preview endpoint.
     * @param {string} actionName - The action name
     * @param {string} entityId - The entity executing the action
     * @param {Object} [context] - Optional context (providedComponentIds, etc.)
     * @returns {Object} Preview data with actionData, resolvedValues, and synergyResult
     */
    previewActionData(actionName, entityId, context) {
        return this.actionController.previewActionData(actionName, entityId, context);
    }

    // =========================================================================
    // ACTION API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns actions relevant to a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Action status for the entity.
     */
    getActionsForEntity(entityId) {
        const state = this.getAll();
        return this.actionController.getActionsForEntity(state, entityId);
    }

    /**
     * Clone-free capability gate: checks whether an entity can execute a specific action.
     *
     * This method is intentionally lightweight — it reads the small action registry and
     * inspects the per-action capability cache directly, avoiding the full-world `getAll()`
     * clone that `getActionsForEntity()` performs.  If the cache is empty or lacks an entry
     * array for the requested action, it falls back to a full-scan (via
     * `scanAllCapabilities`) to self-heal the cache, then re-checks.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} actionName - The action name to check.
     * @returns {boolean} True if the entity has at least one component that can execute the action.
     */
    canEntityExecuteAction(entityId, actionName) {
        try {
            const actionController = this.actionController;
            if (!actionController) return false;

            const registry = actionController.getRegistry?.();
            if (!registry || !actionName) return false;

            const capabilityController = actionController.componentCapabilityController;
            if (!capabilityController) return false;

            const cache = capabilityController._capabilityCache;
            if (!cache) return false;

            // Check the per-action cache for entries matching this entityId.
            let actionEntries = cache[actionName];
            if (!Array.isArray(actionEntries)) {
                // Self-heal fallback: if the cache lacks an entry array for this action,
                // trigger a full-scan to populate the cache (mirrors getActionsForEntity pattern).
                const state = this.getAll();
                capabilityController.scanAllCapabilities(state);

                // Re-read the cache reference (scanAllCapabilities may replace the cache object).
                const healedCache = capabilityController._capabilityCache;
                actionEntries = healedCache?.[actionName];
                if (!Array.isArray(actionEntries)) return false;
            }

            for (let i = 0; i < actionEntries.length; i++) {
                if (actionEntries[i].entityId === entityId) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            // Defensive: never throw on a capability check.
            Logger.warn(`[WorldStateController] canEntityExecuteAction() failed for ${entityId}/${actionName}: ${error.message}`);
            return false;
        }
    }

    /**
     * Returns the last world events (Feature B, spec §4.1).
     * @param {number} [limit=WORLD_EVENTS_RECENT_LIMIT] - Maximum number of events (oldest → newest).
     * @returns {Array} Event entries { tick, action, targetId, message, level, ts }.
     */
    getRecentEvents(limit = WORLD_EVENTS_RECENT_LIMIT) {
        return this.worldEventLogController.getRecent(limit);
    }

    /**
     * Sends a room chat message (Feature D backend, spec §7.3 — public API
     * wrapper so the routes never reach into the sub-controller directly).
     * The room chat layer is deliberately absent-safe: when it was not wired
     * (e.g. a partial test world) this returns a structured failure instead
     * of throwing.
     * @param {Object} args - { roomId, speakerName?, speakerEntityId?, text }.
     * @returns {Object} { success: true, message } | { success: false, code, error }.
     */
    sendRoomChat(args) {
        if (!this.roomChatController) {
            return { success: false, code: 'ROOM_CHAT_UNAVAILABLE', error: 'Room chat layer is not wired.' };
        }
        return this.roomChatController.sendMessage(args);
    }

    /**
     * Returns a room's chat history, oldest → newest (spec §7.3).
     * @param {string} roomId - Room UID.
     * @param {number} [limit=ROOM_CHAT_HISTORY_LIMIT] - Maximum number of messages.
     * @returns {Array}
     */
    getRoomChatMessages(roomId, limit = ROOM_CHAT_HISTORY_LIMIT) {
        return this.roomChatController ? this.roomChatController.getMessages(roomId, limit) : [];
    }

    /**
     * Returns the last N action-outcome records for a specific entity
     * (Feature E: per-agent action feedback for LLM context).
     * @param {string} entityId - The entity ID.
     * @param {number} [limit=5] - Maximum number of records.
     * @returns {Array} Action-outcome entries (oldest→newest), empty if none.
     */
    getAgentActionFeedback(entityId, limit = AGENT_FEEDBACK_CAPACITY) {
        return this.llmAgentFeedbackController
            ? this.llmAgentFeedbackController.getRecent(entityId, limit)
            : [];
    }

    /**
     * Returns all action capabilities across all entities.
     * @returns {Object} Action capabilities data.
     */
    getActionCapabilities() {
        const state = this.getAll();
        return this.actionController.getActionCapabilities(state);
    }

    /**
     * Executes an action on an entity.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity executing the action.
     * @param {Object} [params] - Optional action parameters.
     * @returns {Object} Execution result.
     */
    executeAction(actionName, entityId, params) {
        return this.actionController.executeAction(actionName, entityId, params);
    }

    // =========================================================================
    // COMPONENT CAPABILITY API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns the cached action capability data for all actions.
     * @returns {Object} Cached capabilities.
     */
    getCachedCapabilities() {
        return this.componentCapabilityController.getCachedCapabilities();
    }

    /**
     * Returns the best component for a specific action across all entities.
     * @param {string} actionName - The action name.
     * @returns {Object|null} Best component entry or null.
     */
    getBestComponentForAction(actionName) {
        return this.componentCapabilityController.getBestComponentForAction(actionName);
    }

    /**
     * Returns all capability entries for a specific entity across all actions.
     * @param {string} entityId - The entity ID.
     * @returns {Array} Capability entries array.
     */
    getCapabilitiesForEntity(entityId) {
        return this.componentCapabilityController.getCapabilitiesForEntity(entityId);
    }

    /**
     * Re-evaluates all action capabilities for a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array} Updated capability entries.
     */
    reEvaluateEntityCapabilities(entityId) {
        const state = this.getAll();
        return this.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
    }

    // =========================================================================
    // ROOM API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns all rooms.
     * @returns {Object} All rooms data.
     */
    getRooms() {
        return this.roomsController.getAll();
    }

    /**
     * Returns the world graph with resolved room names for all connections.
     * @returns {Object} World graph structure.
     */
    getWorldGraph() {
        const rooms = this.roomsController.getAll();
        const builder = new WorldGraphBuilder(rooms);
        return builder.build();
    }

    // =========================================================================
    // ACTION SELECTION API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Expires all stale component selections.
     * Should be called before executing any action.
     * @returns {void}
     */
    expireStaleSelections() {
        this.actionSelectController.expireStaleSelections();
    }

    /**
     * Locks multiple components to a specific action (batch selection).
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Array} components - Array of {componentId, role} objects.
     * @returns {Object} Selection result.
     */
    registerSelections(actionName, entityId, components) {
        return this.actionSelectController.registerSelections(actionName, entityId, components);
    }

    /**
     * Locks a single component to a specific action.
     * @param {string} actionName - The action name.
     * @param {string} componentId - The component ID.
     * @param {string} entityId - The entity ID.
     * @param {string} role - The component role.
     * @returns {Object} Selection result.
     */
    registerSelection(actionName, componentId, entityId, role) {
        return this.actionSelectController.registerSelection(actionName, componentId, entityId, role);
    }

    /**
     * Releases (unlocks) a component selection.
     * @param {string} componentId - The component ID to release (can be comp-* or eq-*).
     * @param {string} [entityId] - Optional entity ID for resolving equipment IDs.
     * @returns {boolean} Whether the selection was released.
     */
    releaseSelection(componentId, entityId) {
        return this.actionSelectController.releaseSelection(componentId, entityId);
    }

    /**
     * Returns all current component selections for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Locked components data.
     */
    getLockedComponents(entityId) {
        return this.actionSelectController.getLockedComponents(entityId);
    }

    // =========================================================================
    // INVENTORY PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Gets the item type definitions (registry).
     * Returns a defensive deep copy.
     * @returns {Object} Item definitions.
     */
    getItemRegistry() {
        return this.inventoryManager.getItemDefinitions();
    }

    /**
     * Gets inventory items for an entity grouped by host component.
     * Returns a defensive deep copy.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Item data grouped by component.
     */
    getEntityItems(entityId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for inventory query.`);
            return {};
        }
        return this.inventoryManager.getEntityItems(entity);
    }

    /**
     * Adds an item to an entity's inventory, attached to a specific component.
     * All items must be associated with a component — there is no general/unassigned inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} itemType - The item type identifier.
     * @param {string} componentId - The component ID to attach the item to (required).
     * @returns {{ success: boolean, message?: string, item?: Object }}
     */
    addItemToEntity(entityId, itemType, componentId, options = {}) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item addition.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.addItem(entity, itemType, componentId, {
            componentController: this.componentController,
            ...options
        });

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Removes an item from an entity's inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to remove.
     * @returns {{ success: boolean, message?: string }}
     */
    removeItemFromEntity(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item removal.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.removeItem(entity, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Moves an item to a different component within an entity.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to move.
     * @param {string} targetComponentId - The target component ID.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemInEntity(entityId, itemId, targetComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item move.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.moveItem(entity, itemId, targetComponentId, {
            componentController: this.componentController
        });

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * FASE 6 (facade logic extraction): Crafts a recipe: consumes inputs and produces outputs on the same component.
     * Implementation: src/controllers/logic/CraftingLogic.js (`executeCraftTransaction`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @param {*} entityId
 * @param {*} recipeId
 * @param {*} componentId
 * @param {*} itemIds
     */
    craftItems(entityId, recipeId, componentId, itemIds) {
        return executeCraftTransaction(this, entityId, recipeId, componentId, itemIds);
    }

    /**
     * FASE 6 (facade logic extraction): Craft steps 1–3: resolve recipe, entity, and component.
     * Implementation: src/controllers/logic/CraftingLogic.js (`resolveCraftTarget`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entityId
 * @param {*} recipeId
 * @param {*} componentId
     */
    _resolveCraftTarget(entityId, recipeId, componentId) {
        return resolveCraftTarget(this, entityId, recipeId, componentId);
    }

    /**
     * FASE 6 (facade logic extraction): Craft step 4: validate every requested item instance.
     * Implementation: src/controllers/logic/CraftingLogic.js (`validateCraftInputs`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} recipe
 * @param {*} entity
 * @param {*} componentId
 * @param {*} itemIds
     */
    _validateCraftInputs(recipe, entity, componentId, itemIds) {
        return validateCraftInputs(this, recipe, entity, componentId, itemIds);
    }

    /**
     * FASE 6 (facade logic extraction): Craft step 6: volume pre-check BEFORE any mutation (item-loss guard).
     * Implementation: src/controllers/logic/CraftingLogic.js (`precheckCraftVolume`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} recipe
 * @param {*} entity
 * @param {*} componentId
 * @param {*} items
     */
    _precheckCraftVolume(recipe, entity, componentId, items) {
        return precheckCraftVolume(this, recipe, entity, componentId, items);
    }

    /**
     * FASE 6 (facade logic extraction): Craft step 7: remove each input item.
     * Implementation: src/controllers/logic/CraftingLogic.js (`consumeCraftInputs`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entity
 * @param {*} itemIds
     */
    _consumeCraftInputs(entity, itemIds) {
        return consumeCraftInputs(this, entity, itemIds);
    }

    /**
     * FASE 6 (facade logic extraction): Craft step 8: add each output item on the same component.
     * Implementation: src/controllers/logic/CraftingLogic.js (`produceCraftOutputs`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} recipe
 * @param {*} entity
 * @param {*} componentId
     */
    _produceCraftOutputs(recipe, entity, componentId) {
        return produceCraftOutputs(this, recipe, entity, componentId);
    }

    /**
     * Returns all crafting recipe definitions for the client (the crafting
     * panel renders one card per recipe). Thin passthrough to the injected
     * CraftingController — routes must never reach into sub-controllers
     * (Public API Only, project rule §2).
     * @returns {Array<Object>} Defensive deep copies of every recipe (array form).
     */
    getCraftingRecipes() {
        if (!this.craftingController) {
            Logger.warn('[WorldStateController] craftingController is not wired (null); recipe lookups will fail — check the composition root (WorldComposition.js:158).');
            return [];
        }
        return this.craftingController.getRecipes();
    }

    /**
     * FASE 6 (facade logic extraction): Checks whether an item type is one of the recipe's input types.
     * Implementation: src/controllers/logic/CraftingLogic.js (`isRecipeInputType`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} recipe
 * @param {*} itemType
     */
    _isRecipeInputType(recipe, itemType) {
        return isRecipeInputType(this, recipe, itemType);
    }

    // =========================================================================
    // BROADCAST SERVICE INJECTION
    // =========================================================================

    /**
     * Injects the broadcast service for stat-change-driven broadcasts.
     * Called from server.js after WorldStateController is fully initialized.
     * @param {WorldStateBroadcastService} broadcastService - The broadcast service instance.
     */
    setBroadcastService(broadcastService) {
        this._broadcastService = broadcastService;
        // Also inject broadcaster into TriggerController (fallback defensivo).
        if (this.triggerController) {
            this.triggerController.setBroadcaster(() => broadcastService.broadcast());
        }
    }

    /**
     * Triggers an initial broadcast of world state after the broadcast service is injected.
     * Called from server.js after setBroadcastService() to sync initial state (including spawn items) to clients.
     * @returns {void}
     */
    triggerInitialBroadcast() {
        if (this._broadcastService) {
            this._broadcastService.broadcast();
            Logger.info('[WorldStateController] Initial broadcast triggered after broadcast service injection.');
        } else {
            Logger.warn('[WorldStateController] Broadcast service not available for initial broadcast.');
        }
    }

    // =========================================================================
    // HOLDING COST PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Equips an item on a component (applies holding cost debuffs, triggers capability re-evaluation).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being equipped.
     * @param {string} itemType - The item type (e.g., "knife").
     * @param {string} componentId - The component ID to equip on.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    equipItem(entityId, itemId, itemType, componentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.equipItem(entityId, itemId, itemType, componentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Unequips an item from its component (reverses debuffs, triggers capability re-evaluation).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being unequipped.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    unequipItem(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for unequip.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.unequipItem(entityId, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Transfers an equipped item from one component to another (hand swap).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being transferred.
     * @param {string} itemType - The item type.
     * @param {string} fromComponentId - The source component ID.
     * @param {string} toComponentId - The target component ID.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip transfer.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Gets all equipped items for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array<{ itemId: string, itemType: string, componentId: string }>}
     */
    getEquippedItems(entityId) {
        return this.holdingCostController.getEquippedItems(entityId);
    }

    /**
     * Gets all equipped items across all entities.
     * Used by the capability controller to scan all equipped items for action resolution.
     * @returns {Array<{ entityId: string, itemId: string, itemType: string, componentId: string }>}
     */
    getAllEquippedItems() {
        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return [];
        const allItems = [];
        for (const [entityId, items] of Object.entries(allEquipped)) {
            for (const [eqId, item] of Object.entries(items)) {
                allItems.push({
                    entityId,
                    eqId,
                    itemId: item.itemId,
                    itemType: item.itemType,
                    componentId: item.componentId
                });
            }
        }
        return allItems;
    }

    // =========================================================================
    // TYPED ID MIGRATION: GET EQUIPPED ITEM PUBLIC METHODS
    // =========================================================================

    /**
     * Gets a specific equipped item by its typed equipped-item ID.
     * TYPED ID MIGRATION: Uses eq- prefixed IDs (e.g., "eq-uuid") for equipped items.
     * @param {string} entityId - The entity ID.
     * @param {string} eqId - The typed equipped-item ID (must start with "eq-").
     * @returns {Object|null} The equipped item data object, or null if not found/invalid.
     */
    getEquippedItem(entityId, eqId) {
        // TYPED ID MIGRATION: Validate that eqId has the proper "eq-" prefix
        if (!this._validateEquippedId(eqId)) {
            Logger.warn(`[WorldStateController] Invalid equipped-item ID: "${eqId}" — must start with "eq-"`);
            return null;
        }

        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        const item = entityItems[eqId];
        return item ? { ...item } : null;
    }

    /**
     * Gets a specific equipped item by its item ID (not typed eqId).
     * TYPED ID MIGRATION: Internal use only — prefers eqId for lookups.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to find.
     * @returns {Object|null} The equipped item data object, or null if not found.
     */
    getEquippedItemByItemId(entityId, itemId) {
        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        for (const [_eqId, item] of Object.entries(entityItems)) {
            if (item.itemId === itemId) {
                return { ...item };
            }
        }

        return null;
    }

    /**
     * Gets an equipped item for a specific component.
     * TYPED ID MIGRATION: Returns equipped item data keyed by eqId for the given component.
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component ID to check.
     * @returns {Object|null} The equipped item data, or null if no item is equipped on this component.
     */
    getEquippedItemForComponent(entityId, componentId) {
        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        for (const [_eqId, item] of Object.entries(entityItems)) {
            if (item.componentId === componentId) {
                return { ...item };
            }
        }

        return null;
    }

    /**
     * Validates that an equipped-item ID has the proper "eq-" prefix.
     * TYPED ID MIGRATION: Internal validation helper for typed ID enforcement.
     * @param {string} eqId - The equipped-item ID to validate.
     * @returns {boolean} True if the ID has the proper "eq-" prefix.
     * @private
     */
    _validateEquippedId(eqId) {
        return IdResolver.isEquippedId(eqId);
    }

    /**
     * Gets the holding cost definitions registry.
     * @returns {Object} Holding cost definitions.
     */
    getHoldingCostRegistry() {
        return this.holdingCostController.getHoldingCostRegistry();
    }

    /**
     * Returns the material definitions and blueprint compositions to the client.
     * Static data — served via GET /materials/registry, never embedded in the
     * mutable world state or persistence snapshot (static vs mutable separation).
     * @returns {{ materials: Object, compositions: Object }}
     */
    getMaterialRegistry() {
        const materials = this.materialController ? this.materialController.getMaterialsRegistry() : {};
        const compositions = {};
        if (this.componentController) Object.assign(compositions, this.componentController.getComponentMaterialsByType());
        if (this.inventoryManager) {
            for (const [type, def] of Object.entries(this.inventoryManager.getItemDefinitions())) {
                if (Array.isArray(def.materials)) compositions[type] = def.materials; // getItemDefinitions() already deep-clones
            }
        }
        return { materials, compositions };
    }

    /**
 * Returns the full knowledge codex payload (wiki/subMDs/frontend/knowledge_viewer.md):
     * `{ traitStats: { groups, mappings, materials, vocabulary }, recipes, items }`.
     * Static reference data — served via GET /knowledge (not embedded in the
     * mutable world state or the broadcast; same static-vs-mutable separation as
     * getMaterialRegistry). Thin passthrough to the injected KnowledgeController;
     * the route must never reach into sub-controllers (Public API Only, §2).
     * @returns {Object} A fresh deep copy of the codex payload, or the total
     *   empty-shape payload (never null) when the controller is unwired —
     *   wiki/subMDs/frontend/knowledge_viewer.md: the client renders per-section empty states, not an error,
     *   on a wiring miss.
     */
    getKnowledge() {
        if (!this.knowledgeController) {
            Logger.warn('[WorldStateController] knowledgeController is not wired (null); knowledge lookups will fail — check the composition root (WorldComposition.js).');
            return emptyKnowledgePayload();
        }
        return this.knowledgeController.getKnowledge();
    }

    /**
     * Returns a defensive copy of the active world-rules registry, or a total
     * empty rule set (never null) when the controller is unwired — the
     * "payload getters degrade to an empty shape" rule (controller_patterns §5).
     * The route/tests read the rules through this facade getter; the route must
     * never reach into sub-controllers (Public API Only, §2).
     * @returns {Object} A fresh copy of the active rules map, or `{}` when
     *   the controller is unwired or all rules are off.
     */
    getWorldRules() {
        if (!this.worldRulesController) {
            return {};
        }
        // Aggregated through the controller's public reader (Single Source of
        // Truth, project_rules §2): active rules only, defensive copies,
        // inactive keys omitted — the same shape the facade always returned.
        return this.worldRulesController.getActiveRules();
    }

    // =========================================================================
    // DROPPED ITEMS PUBLIC API
    // =========================================================================

    /**
     * Gets all dropped items in the world.
     * Returns a defensive deep copy to prevent external mutation.
     * @returns {Object<string, {id: string, itemType: string, itemId: string, x: number, y: number, ownerId: string}>} Dropped items map.
     */
    getDroppedItems() {
        // Initialize if not yet created
        if (!this._droppedItems) {
            this._droppedItems = {};
        }
        return structuredClone(this._droppedItems);
    }

    /**
     * Gets dropped items filtered by room ID.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} roomId - The room ID to filter by.
     * @returns {Object<string, Object>} Dropped items map filtered by room.
     */
    getDroppedItemsByRoom(roomId) {
        if (!this._droppedItems) {
            return {};
        }
        const filtered = {};
        for (const [id, item] of Object.entries(this._droppedItems)) {
            if (item.roomId === roomId) {
                filtered[id] = item;
            }
        }
        return structuredClone(filtered);
    }

    /**
     * Sets all dropped items in the world.
     * @param {Object} droppedItems - The dropped items map.
     * @returns {void}
     */
    setDroppedItems(droppedItems) {
        this._droppedItems = droppedItems;

        // Gate broadcasts by cascade — only when _cascadeReentrancyCount === 0
        // The caller removeDroppedItem (and writeDroppedItem via facade) continues broadcasting
        // normally; during cascade, the gate suppresses intermediate broadcasts.
        if (this._broadcastService && this._cascadeReentrancyCount === 0) {
            this._broadcastService.broadcast();
        }
    }

    /**
     * Removes a dropped item from the world.
     * @param {string} droppedItemId - The dropped item ID.
     * @returns {{ success: boolean, message?: string }}
     */
    removeDroppedItem(droppedItemId) {
        const droppedItems = this.getDroppedItems();
        if (!droppedItems[droppedItemId]) {
            Logger.warn(`[WorldStateController] Dropped item "${droppedItemId}" not found.`);
            return { success: false, message: `Dropped item "${droppedItemId}" not found.` };
        }

        delete droppedItems[droppedItemId];
        this.setDroppedItems(droppedItems);

        Logger.info(`[WorldStateController] Removed dropped item "${droppedItemId}".`);
        return { success: true };
    }

    /**
     * Picks up a dropped item from the map and adds it to an entity's inventory component.
     * This is the public API for the pick-up-item operation, delegating to the consequence handler system.
     *
     * @param {string} entityId - The entity picking up the item.
     * @param {string} droppedItemId - The ID of the dropped item on the map.
     * @param {string} componentId - The component ID to attach the item to.
     * @returns {{ success: boolean, message?: string, pickedUpItem?: object }}
     */
    executePickUpItem(entityId, droppedItemId, componentId) {
        // Delegate to the ConsequenceHandlers public dispatch() API (BUG-122:
        // no more 3-layer deep access through consequenceHandlers.handlers.pickUpItem).
        const result = this.actionController?.consequenceHandlers?.dispatch('pickUpItem', null, { entityId, droppedItemId, componentId }, { entityId });

        if (!result) {
            Logger.error('[WorldStateController] ConsequenceHandlers dispatch unavailable for pickUpItem.');
            return { success: false, message: 'PickUpItem handler not available.' };
        }

        return result;
    }

    /**
     * Retrieves a component by its instance ID, searching across all active entities.
     * Returns a defensive copy to prevent external mutation of internal state.
     *
     * @param {string} componentId - The component instance ID.
     * @returns {Object|null} The component object with `id`, `type`, and `entityId` fields, or null if not found.
     */
    getComponent(componentId) {
        const allEntities = this.stateEntityController.getAll();
        for (const [, entity] of Object.entries(allEntities)) {
            if (Array.isArray(entity.components)) {
                const component = entity.components.find(c => c.id === componentId);
                if (component) {
                    return { ...component, entityId: entity.id };
                }
            }
        }
        return null;
    }

    /**
     * Gets a specific item instance by ID from an entity's inventory.
     * Returns a defensive deep copy.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to find.
     * @returns {Object|null} Deep clone of the item, or null if not found.
     */
    getItem(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) return null;
        return this.inventoryManager.getItem(entity, itemId);
    }

    // =========================================================================
    // NESTED INVENTORY PUBLIC API
    // =========================================================================

    /**
     * Adds an item to a container item within an entity's inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemType - The item type to add.
     * @returns {{ success: boolean, message?: string, item?: Object }}
     */
    addItemToContainer(entityId, containerItemId, itemType) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container add.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.addItemToContainer(entity, containerItemId, itemType);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Removes an item from a container item within an entity's inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to remove.
     * @returns {{ success: boolean, message?: string }}
     */
    removeItemFromContainer(entityId, containerItemId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container remove.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.removeItemFromContainer(entity, containerItemId, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Moves an item from component level (or another container) into a container.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to move into container.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemIntoContainer(entityId, containerItemId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container move-in.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.moveItemIntoContainer(entity, containerItemId, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Moves an item out of a container back to the component level.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to move out of container.
     * @param {string} targetComponentId - The component to attach the item to.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemOutOfContainer(entityId, containerItemId, itemId, targetComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container move-out.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.moveItemOutOfContainer(entity, containerItemId, itemId, targetComponentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Gets direct children of a container item.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @returns {Array} Array of contained item instances.
     */
    getContainerItems(entityId, containerItemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container items query.`);
            return [];
        }
        return this.inventoryManager.getContainerItems(entity, containerItemId);
    }

    // =========================================================================
    // ITEM STATS — COMPUTED STATS FOR A SPECIFIC ITEM
    // =========================================================================

    /**
     * Computes the full stats for a single item instance, combining:
     * - Base traits from inventoryItems.json (always shown)
     * - Dynamic equipped item stats (sharpness, existence current — shown when equipped)
     * - Holding cost requirements (shown when equipped, informational only)
     *
     * Note: Holding cost debuffs are applied to the COMPONENT's stats, not the item's.
     * They are shown as informational metadata, not subtracted from item stats.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID.
     * @returns {Object|null} The combined stats object, or null if item not found.
     */
    getItemStats(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) return null;

        const item = this.inventoryManager.getItem(entity, itemId);
        if (!item) return null;

        // 1. Build base stats from item traits (always present)
        const baseStats = {};
        const traitCategories = {}; // Track which trait categories have stats
        if (item.traits && typeof item.traits === 'object') {
            for (const [traitCategory, traitData] of Object.entries(item.traits)) {
                if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                    traitCategories[traitCategory] = true;
                    for (const [statName, statValue] of Object.entries(traitData)) {
                        if (typeof statValue === 'number') {
                            baseStats[statName] = statValue;
                        }
                    }
                }
            }
        }

        // 2. Check if equipped and get dynamic stats
        const isEquipped = this.holdingCostController.isItemEquipped(entityId, itemId);
        const dynamicStats = {};
        const dynamicStatCategories = {};

        if (isEquipped && this.equippedItemStats) {
            // FIX: Get eqId from itemId to properly look up equipped item stats
            const equippedItem = this.getEquippedItemByItemId(entityId, itemId);
            if (equippedItem && equippedItem.eqId) {
                const eqStats = this.equippedItemStats.getStats(equippedItem.eqId);
                if (eqStats) {
                    for (const [traitCategory, traitData] of Object.entries(eqStats)) {
                        if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                            dynamicStatCategories[traitCategory] = true;
                            for (const [statName, statValue] of Object.entries(traitData)) {
                                dynamicStats[statName] = statValue;
                            }
                        }
                    }
                }
            }
        }

        // 3. Get holding cost requirements if equipped (informational, NOT applied to item stats)
        const holdingCostRequirements = [];
        if (isEquipped) {
            const holdingCostDef = this.holdingCostController.getHoldingCostDefinition(item.type);
            if (holdingCostDef && holdingCostDef.holdingCost) {
                for (const costEntry of holdingCostDef.holdingCost) {
                    holdingCostRequirements.push({
                        trait: costEntry.trait,
                        stat: costEntry.stat,
                        value: costEntry.value
                    });
                }
            }
        }

        // 4. Build final result with metadata and separated sections
        const result = {
            _itemId: item.id,
            _type: item.type,
            _name: item.name || item.type,
            _isEquipped: isEquipped,
            _volume: item.volume,
            _baseStats: baseStats,
            _traitCategories: traitCategories
        };

        // Add dynamic stats when equipped
        if (isEquipped && Object.keys(dynamicStats).length > 0) {
            result._dynamicStats = dynamicStats;
            result._dynamicStatCategories = dynamicStatCategories;
        }

        // Add holding cost requirements when equipped
        if (isEquipped && holdingCostRequirements.length > 0) {
            result._holdingCostRequirements = holdingCostRequirements;
        }

        // Also flatten for easy display: base + dynamic merged
        const displayStats = { ...baseStats };
        for (const [statName, statValue] of Object.entries(dynamicStats)) {
            displayStats[statName] = statValue;
        }
        Object.assign(result, displayStats);

        return result;
    }

    /**
     * Finds all dropped items near a spatial coordinate.
     * @param {number} x - The X coordinate.
     * @param {number} y - The Y coordinate.
     * @param {number} radius - Search radius.
     * @returns {Array<{id: string, itemType: string, itemId: string, x: number, y: number, ownerId: string, distance: number}>}
     */
    findDroppedItemsNear(x, y, radius = DEFAULT_TRIGGER_RADIUS) {
        const droppedItems = this.getDroppedItems();
        const nearby = [];

        for (const [_id, item] of Object.entries(droppedItems)) {
            const dx = item.x - x;
            const dy = item.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance <= radius) {
                nearby.push({ ...item, distance: Math.round(distance * 100) / 100 });
            }
        }

        return nearby;
    }

    // =========================================================================
    // TRIGGER SYSTEM — removeBrokenComponent
    // =========================================================================

    /**
     * FASE 6 (facade logic extraction): Removes a broken component/equipped-item instance: (a) spill → (a½) dependency cascade → (b) remove → (c) cleanup → root-exit elimination.
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`removeBrokenComponentCascade`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @param {*} payload
     */
    removeBrokenComponent(payload) {
        return removeBrokenComponentCascade(this, payload);
    }

    /**
     * FASE 6 (facade logic extraction): Phase (a): spill of content from destroyed component/container.
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`spillContent`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entity
 * @param {*} payload
     */
    _spillContent(entity, payload) {
        return spillContent(this, entity, payload);
    }

    /**
     * FASE 6 (facade logic extraction): Phase (a½): dependency cascade (visited-set prevents loops).
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`cascadeDependents`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entity
 * @param {*} originId
     */
    _cascadeDependents(entity, originId) {
        return cascadeDependents(this, entity, originId);
    }

    /**
     * FASE 6 (facade logic extraction): Direct removal WITHOUT event (for dependents already ≤ 0).
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`forceDirectRemoval`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} compId
 * @param {*} entity
     */
    _forceDirectRemoval(compId, entity) {
        return forceDirectRemoval(this, compId, entity);
    }

    /**
     * FASE 6 (facade logic extraction): Entity-level elimination check (root-exit choke-point).
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`maybeEliminateEntity`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entityId
     */
    _maybeEliminateEntity(entityId) {
        return maybeEliminateEntity(this, entityId);
    }

    /**
     * FASE 6 (facade logic extraction): Phase (b): unequip + remove instance.
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`removeComponentOrItem`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entity
 * @param {*} payload
     */
    _removeComponentOrItem(entity, payload) {
        return removeComponentOrItem(this, entity, payload);
    }

    /**
     * FASE 6 (facade logic extraction): Phase (c): cleanup — stats, internal components, selection, capabilities, equipped items.
     * Implementation: src/controllers/logic/RemovalCascadeLogic.js (`cleanupAfterRemoval`). This thin
     * delegator stays on the class so instance-level spies/mocks and direct
     * calls (tests) keep working unchanged.
 * @private
 * @param {*} entity
 * @param {*} payload
     */
    _cleanupAfterRemoval(entity, payload) {
        return cleanupAfterRemoval(this, entity, payload);
    }

}

export default WorldStateController;
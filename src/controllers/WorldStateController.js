import DataLoader from '../utils/DataLoader.js';
import Logger from '../utils/Logger.js';
import { getDefinitionFootprint } from '../utils/definitionVolume.js';
import { isEnvFlagOn } from '../utils/Constants.js';
import WorldGraphBuilder from '../utils/WorldGraphBuilder.js';
import IdResolver from '../utils/IdResolver.js';
import { buildReverseIndex } from '../utils/ComponentDependents.js';
import { sampleDiskPoint, DEFAULT_TRIGGER_RADIUS } from '../utils/DiskSampler.js';
import { writeDroppedItem } from '../controllers/consequences/DropItemHandler.js';
import { DEFAULT_TURNS_SNAPSHOT } from './core/TurnSystemController.js';
import { WORLD_EVENTS_RECENT_LIMIT, ROOM_CHAT_HISTORY_LIMIT, AGENT_FEEDBACK_CAPACITY } from '../utils/Constants.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';
import { TRAIT_GROUPS, STAT_NAMES, EXISTENCE_GONE_AT } from '../../shared/StatVocabulary.js';
import { emptyKnowledgePayload } from './knowledge/KnowledgeController.js';

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
     * Spawns every NPC declared in data/npcs.json (Feature D, spec §7.2).
     *
     * Registry shape (key = blueprint name; the same registry LLMAgentController
     * validates in its constructor):
     *   { [blueprint]: { displayName, room, personality, objective?,
     *                    initialItems? ({ item, count, equip?,
     *                                     contents? ({ item, count })[] }),
     *                    maxWorldActionsPerRound?, maxChatMessagesPerRound?,
     *                    envGate? } }
     *
     * Per entry (each concern delegated to a single-purpose helper):
     *   - `_checkNpcSpawnGate(entry, blueprint)` — the data-driven spawn
     *     gate: the optional envGate names an env var that must be ON per
     *     isEnvFlagOn (string equal to "true" after trim and case-folding;
     *     unset/other values are OFF) for the entry to spawn. The gate is
     *     read once at bootstrap (spawn time, not a runtime toggle). A
     *     missing/malformed envGate means "no gate" (the entry spawns
     *     normally, as before); a gated-out entry is skipped with an info
     *     log;
     *   - `_normalizeNpcAiConfig(entry)` — validates the optional ai block
     *     at boot (behavior/attackRange/attackAction/moveAction), warning
     *     per invalid field and falling back to the registry defaults;
     *   - `_buildNpcConfig(entry, normalizedAi)` — assembles the persisted
     *     npcConfig: personality, the per-round action/chat caps, and the
     *     normalized ai block; the optional objective is persisted
     *     alongside personality only when present (non-empty), so existing
     *     entries keep their exact stored shape;
     *   - `_applyInitialItems(entityId, entry)` — places each initialItems
     *     entry on a merchantArm (fallback: first arm-like component, then
     *     any component) via the existing addItemToEntity() API, nests any
     *     declared contents into the just-added instance via the public
     *     addItemToContainer() API, and equips equip: true items on a
     *     holding-capable component via the public equipItem() API; a
     *     failed add/equip/nest is a warning only (the item stays held and
     *     the entity keeps its unequipped baseline — spawn never fails).
     *
     * The outer loop (per entry, inside a try/catch): malformed-entry warn
     * → gate check → displayName/personality check → room logical→UID
     * resolution → npcConfig build → spawnEntity with extra = { isNPC: true,
     * name: displayName, npcConfig: {…} } → room-center positioning →
     * _applyInitialItems. The persisted isNPC field is what makes the
     * world.json spawn observer bypass the NPC (the declarative spawns
     * target player-droid component types and would spam warn-logs on an
     * NPC); no separate opt-out flag is stored — nothing to leak into
     * serialize() snapshots or broadcasts.
     *
     * Tolerant of a missing/malformed registry — a boot-time warning only,
     * never a crash (the same tolerance as LLMAgentController._loadNpcRegistry).
     * @private
     */
    _spawnNpcs() {
        const raw = DataLoader.loadJsonSafe('data/npcs.json', {});
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return; // no NPC registry configured — not an error
        }

        let count = 0;
        for (const [blueprint, entry] of Object.entries(raw)) {
            try {
                if (!entry || typeof entry !== 'object') {
                    Logger.warn(`[WorldStateController] npcs.json: entry "${blueprint}" is malformed — skipped.`);
                    continue;
                }
                if (!this._checkNpcSpawnGate(entry, blueprint)) continue;
                if (typeof entry.displayName !== 'string' || typeof entry.personality !== 'string') {
                    Logger.warn(`[WorldStateController] npcs.json: entry "${blueprint}" lacks displayName/personality — skipped.`);
                    continue;
                }
                const roomLogicalId = typeof entry.room === 'string' ? entry.room : 'start_room';
                const roomUid = this.roomsController.getUidByLogicalId(roomLogicalId);
                if (!roomUid) {
                    Logger.warn(`[WorldStateController] npcs.json: "${entry.displayName}" has unknown room "${roomLogicalId}" — skipped.`);
                    continue;
                }
                const room = Object.values(this.roomsController.rooms || {}).find(r => r.id === roomUid) || null;

                const normalizedAi = this._normalizeNpcAiConfig(entry);

                const npcConfig = this._buildNpcConfig(entry, normalizedAi);

                const entityId = this.stateEntityController.spawnEntity(blueprint, roomUid, {
                    isNPC: true,
                    name: entry.displayName,
                    npcConfig
                });
                if (!entityId) {
                    Logger.warn(`[WorldStateController] NPC spawn failed for blueprint "${blueprint}".`);
                    continue;
                }

                // Position at the room center (spec §7.2).
                if (room && typeof room.width === 'number' && typeof room.height === 'number') {
                    this.stateEntityController.updateEntitySpatial(entityId, { x: room.width / 2, y: room.height / 2 });
                }

                // Apply initialItems (e.g. Bolt's wares) to an arm component.
                this._applyInitialItems(entityId, entry);

                count++;
                Logger.info(`[WorldStateController] NPC spawned: "${entry.displayName}" (${blueprint}) in room "${roomLogicalId}" as ${entityId}.`);
            } catch (error) {
                Logger.error(`[WorldStateController] NPC spawn failed for "${entry?.displayName || blueprint}": ${error.message}`);
            }
        }
        if (count > 0) {
            Logger.info(`[WorldStateController] ${count} NPC(s) spawned from data/npcs.json.`);
        }
    }

    /**
     * Data-driven spawn gate for a single registry entry: the optional
     * `envGate` names an environment variable that must be ON (per
     * isEnvFlagOn: a string equal to "true" after trim and case-folding) for
     * the entry to spawn. Unset/empty/malformed envGate means "no gate"
     * (spawn normally); any other value skips the entry with an info log.
     * The variable is read once at bootstrap (spawn time), not a runtime
     * toggle — restarting the server applies changes to it.
     * @private
     * @param {Object} entry - The registry entry being checked (known to be
     *   an object at this point).
     * @param {string} blueprint - The registry key; used as the display-name
     *   fallback in the skip log when the entry's displayName is not a string.
     * @returns {boolean} true = spawn the entry, false = skip it.
     */
    _checkNpcSpawnGate(entry, blueprint) {
        const gateVar = typeof entry.envGate === 'string' ? entry.envGate.trim() : '';
        if (gateVar === '') return true;
        if (isEnvFlagOn(process.env[gateVar])) return true;
        Logger.info(`[WorldStateController] npcs.json: "${typeof entry.displayName === 'string' ? entry.displayName : blueprint}" is gated by ${gateVar} (not "true") — skipped.`);
        return false;
    }

    /**
     * M1 + M4: Validates the optional ai block at boot (behavior,
     * attackRange, attackAction, moveAction), warning per invalid field and
     * ignoring the offending value (the registry defaults apply downstream).
     * @private
     * @param {Object} entry - The registry entry (used for the displayName in
     *   the warn logs and for entry.ai).
     * @returns {Object|null} The normalized `{ behavior[, attackAction,
     *   moveAction, attackRange] }`, or null when the entry has no usable
     *   ai block (an LLM-routed NPC).
     */
    _normalizeNpcAiConfig(entry) {
        const rawAi = entry.ai;
        let normalizedAi = null;

        if (rawAi && typeof rawAi === 'object') {
            const hasValidBehavior = typeof rawAi.behavior === 'string' && rawAi.behavior !== '';

            let hasValidAttackRange = true;
            if (rawAi.attackRange !== undefined && rawAi.attackRange !== null) {
                if (typeof rawAi.attackRange === 'number') {
                    hasValidAttackRange = isFinite(rawAi.attackRange) && rawAi.attackRange > 0;
                    if (!hasValidAttackRange) {
                        Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.attackRange=${rawAi.attackRange} is invalid (must be finite and > 0) — ignoring config value, will use registry fallback.`);
                    }
                } else {
                    Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.attackRange=${JSON.stringify(rawAi.attackRange)} is present but has type ${typeof rawAi.attackRange}, expected number — ignoring config value, will use registry fallback.`);
                    hasValidAttackRange = false;
                }
            }

            if (hasValidBehavior && hasValidAttackRange) {
                normalizedAi = { behavior: rawAi.behavior };
                if (rawAi.attackAction !== undefined && rawAi.attackAction !== null) {
                    if (typeof rawAi.attackAction === 'string' && rawAi.attackAction !== '') {
                        normalizedAi.attackAction = rawAi.attackAction;
                    } else {
                        Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.attackAction=${JSON.stringify(rawAi.attackAction)} is present but has type ${typeof rawAi.attackAction}, expected non-empty string — ignoring config value.`);
                    }
                }
                if (rawAi.moveAction !== undefined && rawAi.moveAction !== null) {
                    if (typeof rawAi.moveAction === 'string' && rawAi.moveAction !== '') {
                        normalizedAi.moveAction = rawAi.moveAction;
                    } else {
                        Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.moveAction=${JSON.stringify(rawAi.moveAction)} is present but has type ${typeof rawAi.moveAction}, expected non-empty string — ignoring config value.`);
                    }
                }
                if (hasValidAttackRange) normalizedAi.attackRange = rawAi.attackRange;
            } else if (!hasValidBehavior) {
                Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.behavior is missing or empty — AI disabled for this entity.`);
            }
        }

        return normalizedAi;
    }

    /**
     * Assembles the persisted npcConfig for a registry entry: personality,
     * the per-round action/chat caps (undefined passes through — the agent
     * applies its own defaults), and the normalized ai block. The optional
     * objective is added only when present (non-empty string) so existing
     * entries keep the exact npcConfig shape they stored before the
     * objective feature.
     *
     * Note: the LLM prompt is rendered from the agent's in-memory registry
     * (LLMAgentController._loadNpcRegistry re-reads data/npcs.json), NOT
     * from this persisted npcConfig copy — that one exists for
     * serialization and inspection only; the two stay in sync via the
     * data file.
     * @private
     * @param {Object} entry - The registry entry (displayName and personality
     *   known to be non-empty-able strings by the caller's checks).
     * @param {Object|null} normalizedAi - Result of _normalizeNpcAiConfig(entry).
     * @returns {Object} The npcConfig object stored on the spawned entity.
     */
    _buildNpcConfig(entry, normalizedAi) {
        const npcConfig = {
            personality: entry.personality,
            maxWorldActionsPerRound: entry.maxWorldActionsPerRound,
            maxChatMessagesPerRound: entry.maxChatMessagesPerRound,
            ai: normalizedAi
        };
        if (typeof entry.objective === 'string' && entry.objective.trim() !== '') {
            npcConfig.objective = entry.objective;
        }
        return npcConfig;
    }

    /**
     * Applies the entry's initialItems to a just-spawned entity. Each
     * `{ item, count, equip?, contents? }` is added `count` times via the
     * existing addItemToEntity() API: unequipped entries go to a merchantArm
     * (fallback: first arm-like component, then any component); equip: true
     * entries go to a component that can meet the item's holding-cost
     * requirements (see _resolveEquippableHostComponent). Any declared
     * `contents` ({ item, count }[]) are nested into the just-added instance
     * through the public addItemToContainer() facade (never InventoryManager
     * directly). equip: true items are then equipped on the same host
     * component. A failed add/equip/nest is a warning only — the item stays
     * held (or absent) and the entity keeps its unequipped baseline; spawn
     * never fails.
     * @private
     * @param {string} entityId - The just-spawned entity.
     * @param {Object} entry - The registry entry (displayName is a string).
     */
    _applyInitialItems(entityId, entry) {
        const entity = this.stateEntityController.getEntity(entityId);
        const items = Array.isArray(entry.initialItems) ? entry.initialItems : [];
        for (const { item, count: n, equip, contents } of items) {
            const times = Math.max(0, Number(n) || 0);
            // equip: true entries are placed on a component that can
            // actually meet the item's holding-cost requirements, so
            // the equip below can succeed (e.g. a droidHand with
            // strength, not a bare droidArm). Unequipped entries keep
            // the historical arm-first placement.
            const hostComponent = equip === true
                ? this._resolveEquippableHostComponent(entity, item)
                : entity?.components?.find(c => c.type === 'merchantArm')
                    || entity?.components?.find(c => /arm|hand/i.test(c.type || ''))
                    || entity?.components?.[0]
                    || null;
            if (!hostComponent) {
                Logger.warn(`[WorldStateController] NPC "${entry.displayName}" has no component to hold item "${item}".`);
                continue;
            }
            for (let i = 0; i < times; i++) {
                const result = this.addItemToEntity(entityId, item, hostComponent.id);
                if (!result.success) {
                    Logger.warn(`[WorldStateController] NPC item "${item}" #${i + 1} failed on ${hostComponent.type}: ${result.message}`);
                    continue;
                }
                // Nest the entry's declared contents into the just-added
                // instance (public facade only; the instance's own
                // internal volume bounds how many fit).
                const declaredContents = Array.isArray(contents) ? contents : [];
                for (const c of declaredContents) {
                    const type = typeof c?.item === 'string' ? c.item.trim() : '';
                    const nestTimes = Math.max(0, Number(c?.count) || 0);
                    if (!type || !result?.item?.id || nestTimes === 0) continue;
                    for (let j = 0; j < nestTimes; j++) {
                        const nest = this.addItemToContainer(entityId, result.item.id, type);
                        if (!nest?.success) Logger.warn(`[WorldStateController] NPC "${entry.displayName}" contents "${type}" #${j + 1} into "${item}" failed: ${nest?.message}`);
                    }
                }
                if (equip === true && result.item?.id) {
                    // Equip on the same host component the item was
                    // added to (spec §3.3). A failed equip (volume,
                    // insufficient stats) is a warning only: the item
                    // stays held and the entity keeps its unequipped
                    // baseline — spawn never fails.
                    const equipResult = this.equipItem(entityId, result.item.id, item, hostComponent.id);
                    if (!equipResult.success) {
                        Logger.warn(`[WorldStateController] NPC item "${item}" #${i + 1} added but equip failed on ${hostComponent.type}: ${equipResult.message}`);
                    }
                }
            }
        }
    }

    /**
     * Resolves the host component for an initialItems entry flagged
     * `equip: true`: the first component whose current stats satisfy the item
     * type's holding-cost requirements (data/holdingCost.json), so the
     * subsequent equipItem() call can actually succeed (e.g. a droidHand with
     * strength, not a bare droidArm). Falls back to the standard
     * arm/hand/first-component chain when no component qualifies — in that
     * case the item is still added, the equip fails with a warning, and the
     * entity keeps its unequipped baseline (spawn never fails).
     * @private
     * @param {Object} entity - The spawned entity.
     * @param {string} itemType - The item type to be equipped.
     * @returns {Object|null} The resolved component, or null if the entity has none.
     */
    _resolveEquippableHostComponent(entity, itemType) {
        const components = entity?.components;
        if (Array.isArray(components)) {
            for (const component of components) {
                const stats = this.componentController.getComponentStats(component.id);
                if (stats && this.holdingCostController.canHoldItem(itemType, stats).success) {
                    return component;
                }
            }
        }
        return components?.find(c => c.type === 'merchantArm')
            || components?.find(c => /arm|hand/i.test(c.type || ''))
            || components?.[0]
            || null;
    }

    /**
     * Applies the declarative initial spawns from data/world.json to a spawned entity.
     * Generic replacement of the former hardcoded spawn methods (_spawnMetalBoxWithKnives,
     * _addKnifeToClientEntity, _addTestItemToClientEntity, _addT1WeaponToEntity): the exact
     * item composition is now declared in data/world.json (initialSpawns) and this method
     * only interprets it.
     *
     * Supported entry fields:
     * - { item, slot, count?: number, children?: [{ item, count }], ammo?: number,
     *   fallback?: "<type>" }: add `item` to a component resolved by `slot`, then add each
     *   child item `count` times inside the created container item. `count` is an optional
     *   top-level multiplicity (default 1) — the item is added that many times to the same
     *   resolved slot, mirroring the children count loop one level up (children and ammo
     *   apply to each added instance). Entries without `count` add exactly one item,
     *   identical to the pre-count behavior. slot forms: "<type>" (first component of that
     *   type), "firstFit:<type>[,<type>...]" (first of the listed types with enough
     *   available volume).
     * - { item, slot, fallback?: "<type>" }: like above, plus a fallback component type tried
     *   when the primary slot has no capacity.
     * - { item, slot: "bestAvailable[:<preferredType>...]", ammo?: number }: add `item`
     *   to the first component (in component order) whose available volume is the highest
     *   among all fitting components; an optional "bestAvailable:hand" list of preferred
     *   types is tried first (first preferred type with enough capacity wins), mirroring
     *   the legacy "hand component first, then best available" weapon placement. Then
     *   load `ammo` knife projectile(s) into the item for weapons that fire stored items.
     *
     * @param {string} entityId - The entity ID to apply initial spawns to.
     * @param {Object} [spawnConfig] - Optional spawn config; defaults to data/world.json.
     * @returns {{ applied: number, failed: number }} Summary of applied/failed spawn entries.
     * @private
     */
    _applyInitialSpawns(entityId, spawnConfig) {
        // Feature D (spec §7.2): NPC entities opt out of the declarative
        // world.json spawns — their goods come from the npcs.json
        // initialItems list instead. The opt-out keys off the persisted
        // `isNPC` field (already merged into the record before this
        // observer runs): no separate boot-time flag is stored anywhere, so
        // nothing can leak into persistence snapshots or broadcasts.
        if (this.stateEntityController.getEntity(entityId)?.isNPC === true) {
            return { applied: 0, failed: 0 };
        }

        let config = spawnConfig;
        if (!config) {
            config = DataLoader.loadJsonSafe('data/world.json', {});
        }

        const entries = config?.initialSpawns;
        if (!Array.isArray(entries) || entries.length === 0) {
            return { applied: 0, failed: 0 };
        }

        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity || !entity.components || !Array.isArray(entity.components)) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found or has no components for initial spawns.`);
            return { applied: 0, failed: entries.length };
        }

        let applied = 0;
        let failed = 0;

        for (const entry of entries) {
            try {
                const target = this._resolveInitialSpawnSlot(entity, entry);
                if (!target) {
                    Logger.warn(`[WorldStateController] Initial spawn "${entry.item}" has no valid slot ("${entry.slot}") on entity "${entityId}".`);
                    failed++;
                    continue;
                }

                // Optional top-level multiplicity (data/world.json `count`, default
                // 1): mirrors the children count loop one level up so a loadout
                // entry can add the same item several times (e.g. the M1 coal
                // loadout). Entries without `count` add exactly one item —
                // identical to the pre-count behavior.
                const spawnCount = Math.max(1, Math.floor(Number(entry.count) || 1));
                let addedAny = false;
                for (let i = 0; i < spawnCount; i++) {
                    const addResult = this.inventoryManager.addItem(entity, entry.item, target.component.id, {
                        componentController: this.componentController
                    });
                    if (!addResult.success) {
                        Logger.warn(`[WorldStateController] Initial spawn "${entry.item}"${spawnCount > 1 ? ` #${i + 1}` : ''} failed on ${target.component.type} (entity ${entityId}): ${addResult.message}`);
                        continue;
                    }

                    // Container children (e.g., metalBox pre-filled with knives)
                    if (Array.isArray(entry.children)) {
                        for (const child of entry.children) {
                            const count = Math.max(0, Number(child?.count) || 0);
                            for (let j = 0; j < count; j++) {
                                const childResult = this.inventoryManager.addItemToContainer(entity, addResult.item?.id, child.item);
                                if (!childResult.success) {
                                    Logger.warn(`[WorldStateController] Initial spawn child "${child.item}" #${j + 1} into "${entry.item}" failed (entity ${entityId}): ${childResult.message}`);
                                }
                            }
                        }
                    }

                    // Weapon ammo (e.g., t1 pre-loaded with knife projectiles)
                    if (typeof entry.ammo === 'number' && entry.ammo > 0) {
                        for (let j = 0; j < entry.ammo; j++) {
                            const ammoResult = this.inventoryManager.addItemToContainer(entity, addResult.item?.id, 'knife');
                            if (!ammoResult.success) {
                                Logger.warn(`[WorldStateController] Initial spawn ammo #${j + 1} into "${entry.item}" failed (entity ${entityId}): ${ammoResult.message}`);
                            }
                        }
                    }

                    addedAny = true;
                }

                if (!addedAny) {
                    failed++;
                    continue;
                }

                applied++;
                Logger.info(`[WorldStateController] Initial spawn "${entry.item}" applied to ${target.component.type} (component: ${target.component.id}) on entity ${entityId}`);
            } catch (error) {
                Logger.error(`[WorldStateController] Error applying initial spawn "${entry?.item}" to entity "${entityId}": ${error.message}`);
                failed++;
            }
        }

        return { applied, failed };
    }

    /**
     * Resolves the target component for an initial-spawn entry (data/world.json).
     *
     * Slot forms:
     * - "<type>": the first component of that type.
     * - "firstFit:<type>[,<type>...]" in that order: the first component (in order) with
     *   enough available volume for the item's host footprint.
     * - "bestAvailable" / "bestAvailable:<preferredType>[,...]": the first listed
     *   preferred component type (substring match, e.g., "hand") with enough available
     *   volume; without a preference, the component with the highest available volume
     *   (first one wins ties).
     *
     * @param {Object} entity - The entity object.
     * @param {Object} entry - The initial spawn entry ({ item, slot, fallback? }).
     * @returns {{ component: Object }|null} The resolved component, or null if no slot matches.
     * @private
     */
    _resolveInitialSpawnSlot(entity, entry) {
        const itemDef = this.inventoryManager.getItemDefinitions()[entry.item];
        if (!itemDef) {
            Logger.warn(`[WorldStateController] Unknown item type "${entry.item}" in initial spawn config.`);
            return null;
        }
        // Items like T1 occupy their externalVolume footprint on the host component.
        // Single source of truth: the shared footprint helper (definitionVolume.js),
        // so the initial-spawn resolver and InventoryManager.addItem agree.
        const hostFootprint = getDefinitionFootprint(itemDef);

        const slot = entry.slot;
        if (typeof slot !== 'string' || slot === '') {
            return null;
        }

        const firstOfType = (type) => entity.components.find(c => c.type === type) || null;

        if (slot === 'bestAvailable' || slot.startsWith('bestAvailable:')) {
            // Optional preferred types (e.g., "bestAvailable:hand" → types containing "hand"):
            // the first preferred component with enough available volume wins, matching the
            // legacy hand-first weapon placement.
            let preferredTypes = [];
            if (slot.startsWith('bestAvailable:')) {
                preferredTypes = slot.slice('bestAvailable:'.length).split(',').map(t => t.trim()).filter(Boolean);
            }
            if (preferredTypes.length > 0) {
                for (const component of entity.components) {
                    const matchesPreference = preferredTypes.some(p => (component.type || '').toLowerCase().includes(p));
                    if (matchesPreference && this.inventoryManager.getAvailableVolume(entity, component.id) >= hostFootprint) {
                        return { component };
                    }
                }
            }
            // Fallback: the component with the highest available volume (first one wins ties,
            // identical to the legacy strict-greater selection).
            let bestComponent = null;
            let bestAvailableVolume = 0;
            for (const component of entity.components) {
                const availableVolume = this.inventoryManager.getAvailableVolume(entity, component.id);
                if (availableVolume >= hostFootprint && availableVolume > bestAvailableVolume) {
                    bestAvailableVolume = availableVolume;
                    bestComponent = component;
                }
            }
            return bestComponent ? { component: bestComponent } : null;
        }

        if (slot.startsWith('firstFit:')) {
            const types = slot.slice('firstFit:'.length).split(',').map(t => t.trim()).filter(Boolean);
            for (const type of types) {
                const candidate = firstOfType(type);
                if (candidate && this.inventoryManager.getAvailableVolume(entity, candidate.id) >= hostFootprint) {
                    return { component: candidate };
                }
            }
            return null;
        }

        // Plain type slot, with optional fallback type
        const primary = firstOfType(slot);
        if (primary && this.inventoryManager.getAvailableVolume(entity, primary.id) >= hostFootprint) {
            return { component: primary };
        }
        if (entry.fallback) {
            const fallback = firstOfType(entry.fallback);
            if (fallback && this.inventoryManager.getAvailableVolume(entity, fallback.id) >= hostFootprint) {
                return { component: fallback };
            }
        }
        return null;
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
     * Crafts a recipe: consumes the given item instances from a component and
     * produces the recipe's outputs on the SAME component. Pure UI-panel
     * feature: no world effect, no range, no room requirement, no turn
     * (crafting is deliberately NOT a registry action — it executes
     * synchronously outside the round system, like the other inventory ops).
     *
     * Volume is pre-checked BEFORE consumption (free + freed ≥ needed) so a
     * full component can never destroy inputs; with that guarantee and
     * single-threaded execution the consume→add sequence is atomic in effect
     * (item-loss prevention — the data-corruption class of BUG-008).
     *
     * Every item mutation goes through InventoryManager (single source of
     * truth); this method only orchestrates. Never throws — every failure
     * returns a `code` the route maps to a status:
     *   1. resolve recipe (_resolveCraftTarget)
     *                                           → RECIPE_NOT_FOUND
     *   2. resolve entity (_resolveCraftTarget)
     *                                           → ENTITY_NOT_FOUND
     *   3. component on the entity (_resolveCraftTarget)
     *                                           → COMPONENT_NOT_FOUND
     *   4. resolve each requested item (_validateCraftInputs: must exist,
     *      be typed `item-*`, be hosted on `componentId`, not appear twice
     *      in `itemIds`, and hold no nested items)
     *                                           → INVALID_ITEM
     *   5. item multiset exactly matches the recipe inputs
     *      (CraftingController.checkExactInputs)
     *                                           → INPUTS_MISMATCH
     *   6. volume pre-check (_precheckCraftVolume, before any mutation)
     *                                           → INSUFFICIENT_VOLUME
     *   7. remove each input item (_consumeCraftInputs, in order)
     *   8. add each output item (_produceCraftOutputs) on the same component
     *   9. broadcast (null-guarded, mirrors addItemToEntity)
     *  10. return { success, recipeId, consumed, produced }
     *
     * @param {string} entityId - Typed entity ID (ent-<uuid>).
     * @param {string} recipeId - Recipe ID from data/crafting.json.
     * @param {string} componentId - Typed component ID (comp-<uuid>) hosting the inputs AND receiving the outputs.
     * @param {string[]} itemIds - Exact item instance IDs (item-<uuid>) to consume; must exactly satisfy the recipe inputs.
     * @returns {{ success: boolean, code?: string, message?: string, recipeId?: string, consumed?: string[], produced?: Object[] }}
     */
    craftItems(entityId, recipeId, componentId, itemIds) {
        // DELIBERATELY SYNCHRONOUS: no await anywhere in this chain (steps
        // 1–10, including the helpers). Concurrent identical POSTs serialize
        // safely because each craft is a synchronous transaction; do NOT
        // introduce an await without re-evaluating that invariant.

        // 1–3. Resolve recipe, entity, and component.
        const target = this._resolveCraftTarget(entityId, recipeId, componentId);
        if (!target.ok) {
            return { success: false, code: target.code, message: target.message };
        }
        const { recipe, entity } = target;

        // 4. Validate every requested item instance.
        const validated = this._validateCraftInputs(recipe, entity, componentId, itemIds);
        if (!validated.ok) {
            return { success: false, code: validated.code, message: validated.message };
        }

        // 5. The multiset of item types must exactly match the recipe inputs.
        //    The controller is non-null here because the recipe was resolved
        //    from it in step 1.
        const { satisfied, missing } = this.craftingController.checkExactInputs(validated.items, recipe);
        if (!satisfied) {
            // missing[0] is the first differing type (same order as the old
            // inline check) — the message text is unchanged.
            const first = missing[0];
            return { success: false, code: 'INPUTS_MISMATCH', message: `Craft inputs do not exactly match recipe "${recipeId}": ${first.type}: have ${first.have}, need ${first.need}.` };
        }

        // 6. Volume pre-check BEFORE any mutation (item-loss guard).
        const volume = this._precheckCraftVolume(recipe, entity, componentId, validated.items);
        if (!volume.ok) {
            return { success: false, code: 'INSUFFICIENT_VOLUME', message: volume.message };
        }

        // 7. Consume the inputs (in the given order).
        const consumed = this._consumeCraftInputs(entity, itemIds);
        if (!consumed.ok) {
            return { success: false, code: 'CRAFT_FAILED', message: consumed.message };
        }

        // 8. Produce the outputs on the SAME component.
        const produced = this._produceCraftOutputs(recipe, entity, componentId);
        if (!produced.ok) {
            return { success: false, code: 'CRAFT_FAILED', message: produced.message };
        }

        // 9. Broadcast on success (null-guarded, exactly like addItemToEntity).
        if (this._broadcastService) {
            this._broadcastService.broadcast();
        }

        // 10.
        return { success: true, recipeId, consumed: [...itemIds], produced: produced.produced };
    }

    /**
     * Craft steps 1–3: resolve the recipe (from the injected
     * CraftingController), the entity, and the component on that entity.
     * @param {string} entityId
     * @param {string} recipeId
     * @param {string} componentId
     * @returns {{ok: true, recipe: Object, entity: Object, componentId: string} | {ok: false, code: string, message: string}}
     * @private
     */
    _resolveCraftTarget(entityId, recipeId, componentId) {
        // 1. Resolve the recipe (defensive copy; null when unknown). An
        //    unwired controller is a composition-root miswiring, not a
        //    normal runtime state — warn per call so it is never silent
        //    (same warn style as the not-found paths above).
        let recipe = null;
        if (this.craftingController) {
            recipe = this.craftingController.getRecipe(recipeId);
        } else {
            Logger.warn('[WorldStateController] craftingController is not wired (null); recipe lookups will fail — check the composition root (WorldComposition.js:158).');
        }
        if (!recipe) {
            return { ok: false, code: 'RECIPE_NOT_FOUND', message: `Recipe "${recipeId}" not found.` };
        }

        // 2. Resolve the entity (live reference — InventoryManager mutates it).
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for crafting.`);
            return { ok: false, code: 'ENTITY_NOT_FOUND', message: `Entity "${entityId}" not found.` };
        }

        // 3. The component must belong to this entity.
        const component = Array.isArray(entity.components)
            ? entity.components.find(c => c.id === componentId)
            : null;
        if (!component) {
            return { ok: false, code: 'COMPONENT_NOT_FOUND', message: `Component "${componentId}" not found on entity "${entityId}".` };
        }

        return { ok: true, recipe, entity, componentId };
    }

    /**
     * Craft step 4: validate every requested item instance. Early rejects,
     * in order: duplicate ID → existence → recipe-input type → host
     * component → nested contents.
     * @param {Object} recipe - The recipe (deep copy from CraftingController).
     * @param {Object} entity - The live entity.
     * @param {string} componentId
     * @param {string[]} itemIds
     * @returns {{ok: true, items: Array<Object>} | {ok: false, code: 'INVALID_ITEM', message: string}}
     * @private
     */
    _validateCraftInputs(recipe, entity, componentId, itemIds) {
        const entityId = entity.id;

        // Reject a duplicated ID BEFORE the per-item resolution loop: a
        // repeated ID cannot be consumed twice — the multiset check below
        // would count it once per occurrence, so a "satisfied" craft would
        // still remove only one instance while the caller believes both
        // were consumed. That is the item-loss class
        // wiki/subMDs/systems/crafting_system.md §7 exists to prevent.
        // Server-side by design: the route intentionally does not dedupe
        // itemIds (the explicit list stays the auditable request).
        const seenItemIds = new Set();
        for (const itemId of itemIds) {
            if (seenItemIds.has(itemId)) {
                return { ok: false, code: 'INVALID_ITEM', message: `Item ID "${itemId}" is listed more than once in itemIds; each item instance can only be consumed once.` };
            }
            seenItemIds.add(itemId);
        }

        // (per item) Each requested item must exist, be a recipe input
        // type, and be hosted on the crafting component (nested container
        // items are excluded naturally: their hostComponentId is a
        // container item ID).
        const items = [];
        for (const itemId of itemIds) {
            const item = this.inventoryManager.getItem(entity, itemId);
            if (!item) {
                return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" not found on entity "${entityId}".` };
            }
            if (!this._isRecipeInputType(recipe, item.type)) {
                return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" (type "${item.type}") is not an input of recipe "${recipe.id}".` };
            }
            if (item.hostComponentId !== componentId) {
                return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" is hosted on component "${item.hostComponentId}", not "${componentId}".` };
            }
            // A recipe input is consumed as a whole unit: removeItem cascades
            // to all descendants, so crafting an item that currently contains
            // nested items would silently destroy what it holds — the
            // item-loss class crafting_system.md §7 exists to prevent.
            // Containers with contents are rejected (the player must empty
            // them first). Public API only: collectNestedItems.
            if (this.inventoryManager.collectNestedItems(entity, itemId).length > 0) {
                return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" contains nested items; empty it before crafting.` };
            }
            items.push(item);
        }

        return { ok: true, items };
    }

    /**
     * Craft step 6: volume pre-check BEFORE any mutation (item-loss guard).
     * The two sides measure different things, deliberately: `freed` is
     * INSTANCE-based (item.hostVolume ?? item.volume, the same unit
     * InventoryManager.getComponentVolume sums) because an item keeps the
     * footprint it was created with — data re-tuning never retro-changes
     * persisted items (cf. InventoryManager.resyncItemTraits) — so only the
     * stored footprints are what removal will actually free; `needed` is
     * DEFINITION-based via hostVolumeOf because NEW outputs pick up the
     * current definition footprint in InventoryManager.addItem. Computing
     * `freed` from the current definition would let a re-tuned definition
     * overstate the space a craft frees, admitting a consume that cannot
     * actually fit — the no-item-loss guarantee (crafting_system.md §7)
     * must hold under definition drift, so only `freed` is instance-based.
     * @param {Object} recipe - The recipe (deep copy from CraftingController).
     * @param {Object} entity - The live entity.
     * @param {string} componentId
     * @param {Array<Object>} items - The resolved input instances (step 4).
     * @returns {{ok: true} | {ok: false, message: string}}
     * @private
     */
    _precheckCraftVolume(recipe, entity, componentId, items) {
        const itemDefs = this.inventoryManager.getItemDefinitions();
        const hostVolumeOf = (type) => {
            const def = itemDefs[type] || {};
            // recipe→derivation: the external footprint lives under form.externalVolume
            // (legacy top-level externalVolume is a fallback); the full volume lives under
            // form.volume. The footprint (what counts against a component's capacity) is the
            // external footprint when declared, else the full volume.
            // Deliberately NOT unified with getDefinitionFootprint (utils/definitionVolume.js):
            // its first two chain steps match, but its declared-volume fallback is the
            // DEFAULT_ITEM_VOLUME no-item-loss floor (an undeclared output must never read as a
            // zero-footprint item in a craft), while the helper falls back to
            // getDefinitionVolume (0 when undeclared). TODO: Refactor — revisit unifying the
            // external-footprint prefix once that fallback difference is reconciled.
            const external = (typeof def.form?.externalVolume === 'number')
                ? def.form.externalVolume
                : (typeof def.externalVolume === 'number' ? def.externalVolume : undefined);
            if (typeof external === 'number') return external;
            return (typeof def.form?.volume === 'number')
                ? def.form.volume
                : (typeof def.volume === 'number' ? def.volume : DEFAULT_ITEM_VOLUME);
        };
        const freed = items.reduce((sum, item) => sum + (item.hostVolume ?? item.volume ?? 0), 0);
        const needed = recipe.outputs.reduce((sum, output) => sum + hostVolumeOf(output.type) * output.quantity, 0);
        // Self-contained available-volume computation (does not rely on the InventoryManager
        // capacity check, which is intentionally non-enforcing). maxVolume comes from the
        // component definition's form.volume; usedVolume sums the items on the component.
        const componentDefs = DataLoader.loadJsonSafe('data/components.json', {});
        const comp = entity.components?.find(c => c.id === componentId);
        const compDef = comp ? (componentDefs[comp.type] || {}) : {};
        const maxVolume = (typeof compDef.form?.volume === 'number')
            ? compDef.form.volume
            : (typeof compDef.volume === 'number' ? compDef.volume : 0);
        const usedVolume = (entity.items || [])
            .filter(item => item.hostComponentId === componentId)
            .reduce((sum, item) => sum + (item.hostVolume ?? item.volume ?? 0), 0);
        const free = Math.max(0, maxVolume - usedVolume);
        if (free + freed < needed) {
            return { ok: false, message: `Component ${componentId} has ${free} free, gains ${freed}, needs ${needed}.` };
        }
        return { ok: true };
    }

    /**
     * Craft step 7: remove each input item (in the given order). A failure
     * here cannot be a volume issue (validated in step 6); any other
     * failure is a hard error and stops BEFORE producing anything.
     * @param {Object} entity - The live entity.
     * @param {string[]} itemIds
     * @returns {{ok: true} | {ok: false, message: string}}
     * @private
     */
    _consumeCraftInputs(entity, itemIds) {
        for (const itemId of itemIds) {
            const removed = this.inventoryManager.removeItem(entity, itemId);
            if (!removed.success) {
                Logger.error(`[WorldStateController] Unexpected removal failure while crafting: ${removed.message}`);
                return { ok: false, message: removed.message };
            }
        }
        return { ok: true };
    }

    /**
     * Craft step 8: add each output item on the SAME component. Cannot fail
     * on volume: step 6 proved the final footprint fits, and prefixes of a
     * fitting total always fit. Output footprints come from the CURRENT
     * definitions (InventoryManager.addItem), not from persisted instances
     * — the outputs are brand-new items.
     * @param {Object} recipe - The recipe (deep copy from CraftingController).
     * @param {Object} entity - The live entity.
     * @param {string} componentId
     * @returns {{ok: true, produced: Array<Object>} | {ok: false, message: string}}
     * @private
     */
    _produceCraftOutputs(recipe, entity, componentId) {
        const produced = [];
        for (const output of recipe.outputs) {
            for (let i = 0; i < output.quantity; i++) {
                const added = this.inventoryManager.addItem(entity, output.type, componentId, {
                    componentController: this.componentController
                });
                if (!added.success) {
                    Logger.error(`[WorldStateController] Unexpected addition failure while crafting "${recipe.id}": ${added.message}`);
                    return { ok: false, message: added.message };
                }
                produced.push(added.item);
            }
        }
        return { ok: true, produced };
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
     * Checks whether an item type is one of the recipe's input types.
     * @param {Object} recipe - The recipe (deep copy from CraftingController).
     * @param {string} itemType - The item's type ID.
     * @returns {boolean}
     * @private
     */
    _isRecipeInputType(recipe, itemType) {
        return recipe.inputs.some(input => input.type === itemType);
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
     * Facade orchestrator for complete broken component/item removal.
     * Order (a)→(a½)→(b)→(c).
     * Re-entrancy counter for single broadcast.
     *
     * @param {Object} payload - Payload of the component:broke event.
     */
    removeBrokenComponent(payload) {
        const { entityId, componentId, kind } = payload;

        // Increment re-entrancy counter
        this._cascadeReentrancyCount++;
        // Initialize shared visited-set + affected-entity set at root call
        if (this._cascadeReentrancyCount === 1) {
            this._cascadeVisitedSet = new Set();
            this._cascadeAffectedEntityIds = new Set();
        }
        // Track every entity touched by this cascade chain (root or re-entry) so
        // the root-exit elimination check covers all affected entities, not just
        // the outermost call's entity (cross-entity cascade robustness — M3).
        this._cascadeAffectedEntityIds.add(entityId);
        try {
            // Look up the entity
            const entity = this.stateEntityController.getEntity(entityId);
            if (!entity) {
                Logger.warn(`[removeBrokenComponent] Entity "${entityId}" not found — skipping removal.`);
                return;
            }

            // === (a) Spill: drain content from component/container ===
            try {
                this._spillContent(entity, payload);
            } catch (error) {
                Logger.error(`[removeBrokenComponent] Phase (a) _spillContent failed for component ${componentId} of entity ${entityId}: ${error.message}`, { payload });
                // Continue to next phase — a failed spill must not block removal or cleanup
            }

            // === (a½) Dependency cascade ===
            if (kind === 'component') {
                try {
                    this._cascadeDependents(entity, componentId);
                } catch (error) {
                    Logger.error(`[removeBrokenComponent] Phase (a½) _cascadeDependents failed for component ${componentId} of entity ${entityId}: ${error.message}`, { payload });
                    // Continue to next phase — a failed cascade must not block removal or cleanup
                }
            }

            // === (b) Desequip + remove instance — UNGUARDED (primary path) ===
            this._removeComponentOrItem(entity, payload);

            // === (c) Cleanup ===
            try {
                this._cleanupAfterRemoval(entity, payload);
            } catch (error) {
                Logger.error(`[removeBrokenComponent] Phase (c) _cleanupAfterRemoval failed for component ${componentId} of entity ${entityId}: ${error.message}`, { payload });
                // Continue — cleanup failure must not block the result
            }
        } finally {
            // Decrement counter — broadcast only occurs when it reaches 0
            this._cascadeReentrancyCount--;
            // Clear visited-set + affected-entity set on exit from root chain
            if (this._cascadeReentrancyCount === 0) {
                // Entity-level elimination: after the full root cascade
                // completes (re-entrancy count returns to 0), check every entity
                // affected during this cascade chain. This handles cross-entity
                // cascades where a break on entity A forces a break on entity B.
                const affectedIds = this._cascadeAffectedEntityIds;
                if (affectedIds && affectedIds.size > 1) {
                    Logger.warn(`[removeBrokenComponent] Cross-entity cascade detected — affected entities: [${[...affectedIds].join(', ')}]. Each entity will receive the elimination check.`);
                }
                for (const affectedId of affectedIds) {
                    this._maybeEliminateEntity(affectedId);
                }
                this._cascadeVisitedSet = null;
                this._cascadeAffectedEntityIds = null;
            }
        }
    }

    /**
     * Phase (a): spill of content from destroyed component/container.
     * @private
     */
    _spillContent(entity, payload) {
        const { componentId, kind, position, roomId, entityId } = payload;
        let hostId = componentId;
        if (kind === 'equipped-item') {
            // For equipped items, the host is the itemId from the payload (container)
            hostId = payload.itemId || componentId;
        }

        // Get items stored in the destroyed host
        const inventory = this.inventoryManager.getEntityItems(entity);
        const items = inventory[hostId] || [];

        if (items.length === 0) return;

        // Fetch item registry for definitions
        const itemRegistry = this.getItemRegistry();

        // PHASE 9: batch — accumulate items in local map and write once (avoids read-modify-write O(n))
        const batchDroppedItems = this.getDroppedItems() || {};

        for (const item of items) {
            // Item isolation (failure logged + continues)
            try {
                // Snapshot of grandchildren — use public wrapper
                let nestedItems = [];
                try {
                    nestedItems = this.inventoryManager.collectNestedItems(entity, item.id);
                } catch (error) {
                    Logger.error(`[removeBrokenComponent] Error collecting nested items for ${item.id}: ${error.message}`);
                }

                // Disk sampling with radius DEFAULT_TRIGGER_RADIUS, center position, no clamp
                // No-magic-numbers rule: use shared constant from DiskSampler for spill radius
                // Defensively skip null results (should never happen with DEFAULT_TRIGGER_RADIUS=5)
                const point = sampleDiskPoint(position.x, position.y, DEFAULT_TRIGGER_RADIUS);
                if (point === null) {
                    Logger.warn(`[removeBrokenComponent] sampleDiskPoint returned null for item ${item.id}; skipping spill.`);
                    continue;
                }

                // Look up item definition (use passed itemDef to avoid re-fetch)
                const itemDef = itemRegistry[item.type] || itemRegistry[item.itemType] || {};

                // Accumulate in local batch map
                // writeDroppedItem receives a narrow-deps stub (not the full facade), implementing only:
                //   getDroppedItems()  → returns the dropped-items map
                //   setDroppedItems(items) → merges `items` into the map via Object.assign (batch accumulation)
                // The handler must not assume other WorldStateController methods exist on this dependency.
                writeDroppedItem(
                    {
                        getDroppedItems: () => batchDroppedItems,
                        setDroppedItems: (items) => { Object.assign(batchDroppedItems, items); }
                    },
                    item.type || item.itemType,
                    point.x,
                    point.y,
                    roomId,
                    entityId,
                    itemDef,
                    nestedItems
                );

                Logger.info(`[removeBrokenComponent] Spilled item ${item.id} (${item.type}) from broken ${kind}.`);
            } catch (error) {
                Logger.error(`[removeBrokenComponent] Error spilling item ${item.id}: ${error.message}`);
                // Skip this item, continue with cascade (isolation per item)
            }
        }

        // Write once at the end (batch write)
        this.setDroppedItems(batchDroppedItems);

        // Remove all items from entity inventory — isolation per item
        for (const item of items) {
            try {
                this.inventoryManager.removeItem(entity, item.id);
            } catch (error) {
                Logger.error(`[removeBrokenComponent] Error removing item ${item.id} from inventory: ${error.message}`);
            }
        }
    }

    /**
     * Phase (a½): dependency cascade (visited-set prevents loops).
     * Pre-order DFS with visited-set.
     * @private
     */
    _cascadeDependents(entity, originId) {
        const components = entity.components || [];
        const reverseIndex = buildReverseIndex(components);
        // Use shared visited-set across recursive cascade (visited-set prevents loops)
        const visited = this._cascadeVisitedSet || new Set([originId]);
        const queue = [originId];

        Logger.debug(`[removeBrokenComponent] _cascadeDependents starting for origin ${originId}, components count: ${components.length}`);
        
        // Log reverse index for debugging (trace → debug)
        for (const [parentId, children] of reverseIndex) {
            if (children.length > 0) {
                Logger.debug(`[removeBrokenComponent] Reverse index: ${parentId} → [${children.join(', ')}]`);
            }
        }

        while (queue.length > 0) {
            const curId = queue.shift();
            Logger.info(`[removeBrokenComponent] Processing from queue: ${curId}`);
            
            // origin is skipped (already broke — it was the event that started the cascade)
            if (curId === originId) {
                // Add origin's children to queue to continue cascade
                const children = reverseIndex.get(curId) || [];
                Logger.info(`[removeBrokenComponent] Origin ${originId} has ${children.length} children: [${children.join(', ')}]`);
                for (const childId of children) {
                    if (!visited.has(childId)) {
                        visited.add(childId);
                        queue.push(childId);
                        Logger.info(`[removeBrokenComponent] Enqueued child ${childId}`);
                    } else {
                        Logger.info(`[removeBrokenComponent] Child ${childId} already visited, skipping`);
                    }
                }
                continue;
            }

            // Liveness on pop: id already removed?
            const comp = components.find(c => c.id === curId);
            if (!comp) {
                Logger.warn(`[removeBrokenComponent] Component ${curId} not found in entity.components (may have been removed)`);
                continue;
            }

            // Check if it still has existence stats
            const stats = this.statsController.getStats(curId);
            if (!stats || !stats[TRAIT_GROUPS.PHYSICAL] || stats[TRAIT_GROUPS.PHYSICAL][STAT_NAMES.EXISTENCE] === undefined) {
                Logger.warn(`[removeBrokenComponent] Dependent ${curId} has no existence stat — skipping.`);
                continue;
            }

            const dur = stats[TRAIT_GROUPS.PHYSICAL][STAT_NAMES.EXISTENCE];
            Logger.info(`[removeBrokenComponent] Component ${curId} has existence ${dur}`);

            if (dur <= EXISTENCE_GONE_AT) {
                // Defensive — direct removal WITHOUT event (already broken)
                Logger.warn(`[removeBrokenComponent] Dependent ${curId} already broken (dur=${dur}) — direct removal without event.`);
                this._forceDirectRemoval(curId, entity);
                continue;
            }

            // Force break: write 0 to existing mutator → re-enters the funnel
            Logger.info(`[removeBrokenComponent] Forcing break of dependent ${curId} (dur=${dur} → 0).`);
            this.componentController.updateComponentStat(curId, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, EXISTENCE_GONE_AT);
            
            // Add this dependent's children to queue to continue cascade
            const children = reverseIndex.get(curId) || [];
            Logger.info(`[removeBrokenComponent] Dependent ${curId} has ${children.length} children: [${children.join(', ')}]`);
            for (const childId of children) {
                if (!visited.has(childId)) {
                    visited.add(childId);
                    queue.push(childId);
                    Logger.info(`[removeBrokenComponent] Enqueued child ${childId}`);
                } else {
                    Logger.info(`[removeBrokenComponent] Child ${childId} already visited, skipping`);
                }
            }
        }
        
        Logger.info(`[removeBrokenComponent] _cascadeDependents finished. Visited: [${[...visited].join(', ')}]`);
    }

    /**
     * Direct removal WITHOUT event (for dependents already ≤ 0).
     * @private
     */
    _forceDirectRemoval(compId, entity) {
        try {
            // Spill content
            this._spillContent(entity, { componentId: compId, kind: 'component', position: entity.spatial, roomId: entity.location });
            // Unequip + remove
            const payload = { componentId: compId, kind: 'component', entityId: entity.id };
            this._removeComponentOrItem(entity, payload);
            // Cleanup
            this._cleanupAfterRemoval(entity, payload);
        } catch (error) {
            Logger.error(`[removeBrokenComponent] Error in _forceDirectRemoval for ${compId}: ${error.message}`);
        }
    }

    /**
     * Entity-level elimination check.
     *
     * Re-reads the live entity via the public API and, if its component array
     * is missing or empty, despawns it to prevent a "ghost" record from
     * lingering in world state. This is the single choke-point where an
     * entity is truly removed after a damage cascade strips all its components.
     *
     * Why isolated in try/catch (L3): a throw here must not poison the whole
     * cascade chain or mask the real phase in handler-level logs. If despawn
     * fails, the entity may remain (logged, not silent) but the cascade
     * completes — graceful degradation.
     *
     * Re-entrancy invariant: this method is called ONLY from the root-exit
     * finally block of removeBrokenComponent (when _cascadeReentrancyCount
     * returns to 0), so it never re-enters the cascade funnel.
     *
     * @private
     * @param {string} entityId - The entity to check for elimination.
     */
    _maybeEliminateEntity(entityId) {
        try {
            const liveEntity = this.stateEntityController.getEntity(entityId);
            if (liveEntity && (!liveEntity.components || liveEntity.components.length === 0)) {
                Logger.info(`[removeBrokenComponent] Entity ${entityId} has zero components after cascade — despawning (entity elimination).`);
                this.despawnEntity(entityId);
            }
        } catch (error) {
            Logger.error(`[removeBrokenComponent] entity elimination failed for ${entityId}: ${error.message}`, { entityId });
            // Do NOT re-throw: a despawn failure must not abort the cascade
            // unwind or mask the original break event in handler-level logs.
            // The entity may remain in world state (logged above) — the
            // system degrades gracefully rather than crashing mid-cascade.
        }
    }

    /**
     * Phase (b): unequip + remove instance.
     * @private
     */
    _removeComponentOrItem(entity, payload) {
        const { componentId, kind, eqId, itemId } = payload;

        if (kind === 'equipped-item') {
            // Desequip (restores holding cost on host)
            if (eqId) {
                this.holdingCostController.unequipItem(entity.id, eqId);
            }
            // Remove item instance from inventory — use payload.itemId (not eqId)
            const removeId = itemId || eqId;
            if (removeId) {
                this.inventoryManager.removeItem(entity, removeId);
            }
        } else {
            // removeComponent via stateEntityController (replacement by filter)
            this.stateEntityController.removeComponent(entity.id, componentId);
        }
    }

    /**
     * Phase (c): cleanup — stats, internal components, selection, capabilities,
     * + equipped items hosted on the broken host (component path) or the
     * unequipped item's tracking/stats (equipped-item path).
     * @private
     */
    _cleanupAfterRemoval(entity, payload) {
        const { componentId, kind, eqId } = payload;

        if (kind === 'component') {
            // (3) removeStats
            this.statsController.removeStats(componentId);

            // (4) Clean up internal components of host (the broken component is the host)
            // InternalComponentController.removeInternalComponent(entityId, hostComponentId, internalCompId)
            // But here we want to clean ALL internals of this component — iterate
            const internalComps = this.internalComponentController.getInternalComponents(entity.id, componentId);
            for (const ic of internalComps) {
                this.internalComponentController.removeInternalComponent(entity.id, componentId, ic.id);
            }

            // Resync entity's internalComponents snapshot with the authoritative source
            // from InternalComponentController — prevents stale ids after cascade removal
            const liveEntity = this.getEntity(entity.id);
            if (liveEntity) {
                liveEntity.internalComponents = this.internalComponentController.getInternalComponentsForEntity(entity.id);
            }

            // (5) removeEntityFromCache + reEvaluateEntityCapabilities
            // Narrowed: build a minimal state with only the affected entity —
            // reEvaluateEntityCapabilities reads state.entities[entityId] and then
            // fetches component stats directly from the controller, so a full-world
            // getAll() is unnecessary here.
            if (this.actionController) {
                this.actionController.removeEntityFromCache(entity.id);
                const liveEntity = this.getEntity(entity.id);
                const narrowState = liveEntity ? { entities: { [liveEntity.id]: liveEntity } } : { entities: {} };
                this.actionController.reEvaluateEntityCapabilities(narrowState, entity.id);
            }

            // (6) releaseSelection of the component
            this.actionSelectController.releaseSelection(componentId);

            // (7) Remove equipped items hosted on this broken component.
            // When a host component is destroyed, any items equipped on it become
            // orphaned — their tracking and stats would linger referencing a dead host.
            // Mirrors the equipped-item cleanup path (kind === 'equipped-item').
            const equippedOnHost = this.holdingCostController.getEquippedItems(entity.id)
                .filter(eq => eq.componentId === componentId);
            for (const eq of equippedOnHost) {
                try {
                    this.holdingCostController.cleanupEquippedItem(entity.id, eq.eqId);
                    if (eq.itemId) {
                        this.inventoryManager.removeItem(entity, eq.itemId);
                    }
                    this.equippedItemStats.removeStats(eq.eqId);
                    this.actionSelectController.releaseSelection(eq.eqId);
                    Logger.info(`[removeBrokenComponent] Removed equipped item ${eq.itemId} (${eq.itemType}) from broken host ${componentId}.`);
                } catch (error) {
                    Logger.error(`[removeBrokenComponent] Error removing equipped item ${eq.itemId} from broken host ${componentId}: ${error.message}`);
                }
            }
        } else if (kind === 'equipped-item') {
            // (3') cleanupEquippedItem wrapper from HoldingCostController
            this.holdingCostController.cleanupEquippedItem(entity.id, eqId);

            // (5') re-evaluate capabilities — ONLY of host entity (not all)
            // Narrowed: same minimal-state approach as the component path above.
            if (this.actionController) {
                const liveEntity = this.getEntity(entity.id);
                const narrowState = liveEntity ? { entities: { [liveEntity.id]: liveEntity } } : { entities: {} };
                this.actionController.reEvaluateEntityCapabilities(narrowState, entity.id);
            }

            // (6') release selection for eqId
            this.actionSelectController.releaseSelection(eqId);
        }
    }

}

export default WorldStateController;
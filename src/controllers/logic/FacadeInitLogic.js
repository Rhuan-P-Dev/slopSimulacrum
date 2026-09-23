/**
 * FacadeInitLogic — FASE 7 (facade logic extraction — phase 4).
 *
 * The WorldStateController constructor's PREPARATION steps, extracted so the
 * constructor is back to its own contract: validate deps, store them, and
 * call one preparator per step. The seven calls keep the ORIGINAL
 * constructor order — the composition root and the tests rely on the
 * relative order of registration and initialize. House shape (facade as
 * first argument — the convention ruling in plans/FIX-PLAN-2026-09.md T9
 * step B): every function here takes the facade UNDER CONSTRUCTION, because
 * each step either registers a callback whose body must read facade state
 * at fire time, or assembles a value from the stored dependencies. None
 * reads the raw deps object — the facade stores everything these steps need.
 *
 * The callbacks run later, not at construction time: by the time any of
 * them fires, the composition root has already injected the facade into
 * every sub-controller (WorldComposition.js step 3), so the deferred
 * facade references are always resolved.
 *
 * Callback bodies are moved verbatim (only `this.` became `facade.`);
 * no behaviour changed.
 */

import Logger from '../../utils/Logger.js';
import { TRAIT_GROUPS, STAT_NAMES } from '../../../shared/StatVocabulary.js';

/**
 * Builds the sub-controllers map (iteration/extension + the broadcast
 * aggregation) from the facade's stored dependencies.
 * @param {import('../WorldStateController.js').default} facade - the facade under construction
 * @returns {Object} the sub-controllers map
 */
function buildSubControllersMap(facade) {
    // Map of sub-controllers for easy iteration/extension
    return {
        rooms: facade.roomsController,
        entities: facade.stateEntityController,
        components: facade.componentController,
        internalComponents: facade.internalComponentController,
        actions: facade.actionController,
        capabilities: facade.componentCapabilityController,
        synergy: facade.synergyController,
        selections: facade.actionSelectController,
        inventory: facade.inventoryManager,
        holdingCost: facade.holdingCostController,
        equippedItemStats: facade.equippedItemStats
        // NOTE: `triggers` entry removed — no code in src/ reads `subControllers.triggers`;
        // TriggerController is accessed directly via `facade.triggerController` where needed.
    };
}

/**
 * Registers the spawn observer that applies the declarative initial spawns
 * from data/world/world.json to every spawned entity (data-driven replacement of
 * the former hardcoded spawn items).
 * @param {import('../WorldStateController.js').default} facade - the facade under construction
 */
function registerSpawnObserver(facade) {
    // Register spawn observer — applies the declarative initial spawns from
    // data/world/world.json to every spawned entity (data-driven replacement of the
    // former hardcoded spawn items).
    facade.stateEntityController.registerSpawnObserver((entityId) => {
        facade._applyInitialSpawns(entityId);
    });
}

/**
 * Wires ComponentController stat-change notifications: capability
 * re-evaluation, component:broke detection (with honest fallbacks when the
 * owning entity/anchors are missing), and the cascade- and flow-gated
 * broadcast (exactly one per chain).
 * @param {import('../WorldStateController.js').default} facade - the facade under construction
 */
function registerStatChangeListener(facade) {
    // Wire up stat change notifications from ComponentController to
    // ComponentCapabilityController — enables automatic capability
    // re-evaluation when component stats change (+ broadcast).
    // Also delegate to TriggerController for component:broke detection.
    // Broadcast only when cascadeReentrancyCount === 0 (exactly 1 broadcast per chain).
    facade.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
        facade.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);

        // Delegate to TriggerController for crossing detection
        if (facade.triggerController && traitId === TRAIT_GROUPS.PHYSICAL && statName === STAT_NAMES.EXISTENCE) {
            // Find which entity owns this component via public API
            let owningEntity;
            owningEntity = facade.stateEntityController.findEntityByComponent(componentId);
            // Edge cases: when owning entity is despawned, the component:broke
            // event must STILL be logged; only removal/spill/drop side-effects are skipped.
            // We always call onComponentBrokeCheck so the event is emitted per spec.
            // When the entity or its anchors are missing we pass honest fallbacks.
            if (!owningEntity || !owningEntity.location || !owningEntity.spatial) {
                Logger.warn(
                    `[WorldStateController] Component ${componentId} broke but owning entity/anchors missing — event still logged; removal/spill/drop skipped.`
                );
                facade.triggerController.onComponentBrokeCheck(
                    componentId,
                    owningEntity?.id ?? componentId,
                    oldValue,
                    newValue,
                    {
                        roomId: null,
                        position: { x: 0, y: 0 },
                        tick: facade.tickSystem?.currentTick ?? 0
                    }
                );
            } else {
                facade.triggerController.onComponentBrokeCheck(
                    componentId,
                    owningEntity.id,
                    oldValue,
                    newValue,
                    {
                        roomId: owningEntity.location,
                        position: owningEntity.spatial,
                        tick: facade.tickSystem?.currentTick ?? 0
                    }
                );
            }
        }

        // Trigger broadcast if broadcastService is available and not in middle of cascade,
        // AND not in the middle of an energy-flow step (the flow closes its scope with at
        // most one full-state broadcast — see endEnergyFlowTurn; wiki/subMDs/systems/energy_flow.md).
        if (facade._broadcastService && facade._cascadeReentrancyCount === 0 && facade._energyFlowScopeCount === 0) {
            facade._broadcastService.broadcast();
        }
    });
}

/**
 * Subscribes the onDamage world-event consumer to the component
 * damage-listener list (source-agnostic weakening events). Null-tolerant —
 * a hand-built facade without the listener is a no-op; the listener's OWN
 * facade reference is injected by the composition root (post-construction),
 * so by the time any real damage event fires it is already wired.
 * @param {import('../WorldStateController.js').default} facade - the facade under construction
 */
function registerDamageListener(facade) {
    // onDamage world-event rule: subscribe the consumer to the component
    // damage-listener list (source-agnostic weakening events). Null-tolerant —
    // a hand-built facade without the listener is a no-op. The listener's OWN
    // facade reference is injected by the composition root (post-construction),
    // so by the time any real damage event fires it is already wired.
    facade.componentController.registerDamageListener((componentId, traitId, statName, oldValue, newValue) => {
        facade.onDamageDropListener?.handleDamage(componentId, traitId, statName, oldValue, newValue);
    });
}

/**
 * Initializes the Turn System (Feature A) with the global tick system —
 * same pattern as internal components: the job registration is
 * side-effect-free until tickSystem.start(). The facade reference is
 * injected by the composition root AFTER this constructor.
 * @param {import('../WorldStateController.js').default} facade - the facade under construction
 */
function initializeTurnSystem(facade) {
    // Initialize the Turn System (Feature A) with the global tick system —
    // same pattern as internal components: the job registration is
    // side-effect-free until tickSystem.start(). The facade reference is
    // injected by the composition root AFTER this constructor.
    facade.turnSystemController?.initialize();
}

/**
 * Initializes the Energy Flow (wiki/subMDs/systems/energy_flow.md) — right
 * after the turn system's initialize(): it resolves the `energyFlow` rule
 * once and fail-soft-validates the per-recipe capacity fields. The per-turn
 * flow step itself is driven from the turn system's round-start hook
 * (after the IC turn step), not a tick job. Same lifecycle as its peers:
 * side-effect-free until a round starts, and the facade reference is
 * injected by the composition root AFTER this constructor.
 * @param {import('../WorldStateController.js').default} facade - the facade under construction
 */
function initializeEnergyFlow(facade) {
    // Initialize the Energy Flow (wiki/subMDs/systems/energy_flow.md) — right after the
    // turn system's initialize(): it resolves the `energyFlow` rule once and
    // fail-soft-validates the per-recipe capacity fields. The per-turn flow
    // step itself is driven from the turn system's round-start hook (after
    // the IC turn step), not a tick job. Same lifecycle as its peers:
    // side-effect-free until a round starts, and the facade reference is
    // injected by the composition root AFTER this constructor.
    facade.energyFlowController?.initialize();
}

/**
 * Wires the equippedItemStats stat-change callback: when an equipped
 * item's stats change (e.g. sharpness drain from cut), the capability
 * cache re-scans with CURRENT stats, not stale base stats. Also delegates
 * to TriggerController.onEquippedItemBrokeCheck when
 * traitId==='Physical' && statName==='existence' (P8 path), before the
 * gated broadcast.
 * @param {import('../WorldStateController.js').default} facade - the facade under construction
 */
function registerEquippedStatsCallback(facade) {
    // Wire equippedItemStats stat change callback to trigger capability
    // re-evaluation. When an equipped item's stats change (e.g., sharpness
    // drain from cut), the capability cache re-scans with CURRENT stats, not
    // stale base stats.
    // Also delegate to TriggerController.onEquippedItemBrokeCheck
    // when traitId==='Physical' && statName==='existence' (P8 path).
    facade.equippedItemStats.setStatChangeCallback((eqId, traitId, statName, newValue, oldValue) => {
        // P8 delegate: delegate to TriggerController BEFORE the broadcast
        if (facade.triggerController && traitId === TRAIT_GROUPS.PHYSICAL && statName === STAT_NAMES.EXISTENCE) {
            const allEquipped = facade.holdingCostController.getEquippedItemsByEntity();
            for (const [entityId, items] of Object.entries(allEquipped)) {
                if (items[eqId]) {
                    const equippedData = items[eqId]; // { eqId, itemId, itemType, componentId }
                    // Resolve entity spatial position via public API
                    const entity = facade.stateEntityController.getEntity(entityId);
                    const extra = {
                        roomId: entity?.location ?? null,
                        position: entity?.spatial ?? { x: 0, y: 0 },
                        itemType: equippedData.itemType || null,
                        componentId: equippedData.componentId || null,
                        itemId: equippedData.itemId || eqId,
                        tick: facade.tickSystem?.currentTick ?? 0
                    };
                    facade.triggerController.onEquippedItemBrokeCheck(
                        eqId, entityId, equippedData.componentId || null,
                        oldValue, newValue, extra
                    );
                    break; // only one entity can own this eqId
                }
            }
        }

        // Find which entity this item belongs to by scanning equipped items.
        // HoldingCostController.getEquippedItemsByEntity() returns: { [entityId]: { [eqId]: itemData } }
        const allEquipped = facade.holdingCostController.getEquippedItemsByEntity();
        for (const [entityId, items] of Object.entries(allEquipped)) {
            if (items[eqId]) {
                // Entity found — re-evaluate its capabilities with current stats
                const state = facade.getAll();
                facade.actionController.reEvaluateEntityCapabilities(state, entityId);
                // Broadcast only when cascadeReentrancyCount === 0
                if (facade._broadcastService && facade._cascadeReentrancyCount === 0) {
                    facade._broadcastService.broadcast();
                }
                Logger.info(`[WorldStateController] Capability re-evaluated for entity "${entityId}" after ${traitId}.${statName} changed: ${oldValue} → ${newValue}`);
                return;
            }
        }
    });
}

export { buildSubControllersMap, registerSpawnObserver, registerStatChangeListener, registerDamageListener, initializeTurnSystem, initializeEnergyFlow, registerEquippedStatsCallback };

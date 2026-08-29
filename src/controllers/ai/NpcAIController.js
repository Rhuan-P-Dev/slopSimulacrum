/**
 * NpcAIController — stateless, data-driven "brain" for deterministic NPCs.
 *
 * The controller reads the world state via the facade's public API (WorldStateController),
 * never mutates state directly, and queues at most 1 action per round via TurnSystem.
 *
 * Behaviors are registered via `registerBehavior(name, strategyFn)`.
 * The strategy receives `{ entity, round, ai, facade }` and returns `{ actionName, params }` or null.
 *
 * Built-in behaviors:
 *   - `chase_attack`: chase and attack the nearest entity in the same room.
 *   - `craft_loop`: Crafter Drone — forage a dropped item, forge it into the
 *     recipe output, and drop it on the ground (wiki/crafter_drone_spec.md).
 *
 * @module NpcAIController
 */

import Logger from '../../utils/Logger.js';
import {
    hasDeterministicBrain,
    findNearestDroppedItem,
    PICK_RANGE,
    RECIPE_ID,
    TARGET_ITEM_TYPE,
    CRAFT_OUTPUT_TYPE
} from '../../utils/npcAiUtils.js';
import { resolveRange } from '../../../shared/RangeResolver.js';

/**
 * Fallback for attack range when resolution is not possible.
 * @constant
 */
const DEFAULT_ATTACK_RANGE_FALLBACK = 100;

/**
 * Threshold below which a durability value is considered "broken" (unusable).
 * @constant
 */
const BROKEN_DURABILITY_THRESHOLD = 1;

/**
 * Key for the components' durability stat (also consumed by the damage pipeline).
 * @constant
 */
const DURABILITY_STAT_KEY = 'Physical.durability';

/**
 * Fixed action names used by craft_loop. The spec pins these (no
 * moveAction/attackAction overrides for this behavior), so they are module
 * constants rather than ai-configurable values.
 * @constant
 */
const CRAFT_MOVE_ACTION = 'move';

/**
 * Fixed action name used by craft_loop: the delivery drop of the forged
 * output item at the drone's own position. The spec pins these (no
 * moveAction/attackAction overrides for this behavior), so they are module
 * constants rather than ai-configurable values.
 * @constant
 */
const CRAFT_DROP_ACTION = 'dropItem';

/**
 * The drone's own core component type — the pickup target for craft_loop
 * (foraged items land on the 12-volume core, keeping the 6-volume arms free).
 * Keep in sync with data/blueprints.json / data/components.json.
 * Spec §4.3 mandates this hardcode; a data-driven resolution would add a
 * fragile volume heuristic, so the sync risk is pinned by contract test 1's
 * blueprint assertions.
 * @constant
 */
const CRAFT_CORE_COMPONENT_TYPE = 'crafterCore';

/**
 * Calculates Euclidean distance between two spatial points.
 * @param {Object} a — { x, y }
 * @param {Object} b — { x, y }
 * @returns {number}
 */
function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

class NpcAIController {
    /**
     * @param {Object} deps
     * @param {Object} deps.worldStateController — facade (public API only)
     * @param {Object|null} deps.turnSystemController — TurnSystemController or null (world without turns)
     */
    constructor({ worldStateController, turnSystemController }) {
        this._facade = worldStateController;
        this._turnSystem = turnSystemController;
        this._behaviors = new Map();

        // Pre-registers the built-in behaviors.
        this.registerBehavior('chase_attack', this._chaseAttackBehavior.bind(this));
        this.registerBehavior('craft_loop', this._craftLoopBehavior.bind(this));
    }

    /**
     * Centralized predicate: does the entity have a deterministic brain configured?
     * Used by the dispatcher (server.js), the LLM guard, and the NO_AI guard in think().
     * @param {Object} entity — entity with possibly npcConfig.ai
     * @returns {boolean}
     */
    static hasDeterministicBrain(entity) {
        return hasDeterministicBrain(entity);
    }

    /**
     * Registers a behavior (behavior name → strategy function).
     * @param {string} name
     * @param {Function} strategy — receives ctx = { entity, round, ai, facade }
     */
    registerBehavior(name, strategy) {
        this._behaviors.set(name, strategy);
        Logger.info(`[NpcAI] Registered behavior: "${name}".`);
    }

    /**
     * ENTRY POINT (called by the dispatcher in the agent slot, tick 20).
     * Synchronous, stateless, NEVER throws.
     * @param {string} npcEntityId
     * @param {number} round
     * @param {Object|null} [preFetchedEntity=null] — optional pre-fetched entity (avoids double-fetch from dispatcher)
     * @returns {{ acted: boolean, skipped?: string, reason?: string }}
     */
    think(npcEntityId, round, preFetchedEntity = null) {
        try {
            // 1. Guard: entity existe + isNPC === true (use pre-fetched if provided)
            const entity = preFetchedEntity ?? this._facade.getEntity?.(npcEntityId);
            if (!entity || entity.isNPC !== true) {
                return { acted: false, skipped: 'NOT_NPC' };
            }

            // 2. Ler ai do npcConfig (centralizado via hasDeterministicBrain)
            if (!NpcAIController.hasDeterministicBrain(entity)) {
                return { acted: false, skipped: 'NO_AI' };
            }

            // 3. Look up strategy in registry
            const ai = entity.npcConfig?.ai;
            const strategy = this._behaviors.get(ai.behavior);
            if (!strategy) {
                Logger.warn(`[NpcAI] Unknown behavior "${ai.behavior}" for ${npcEntityId} — skipping.`);
                return { acted: false, skipped: 'UNKNOWN_BEHAVIOR' };
            }

            // 4. Execute strategy (stateless) — single per-tick snapshot via allEntities.
            const allEntities = this._facade.getEntities?.();
            const decision = strategy({ entity, round, ai, facade: this._facade, allEntities });
            if (decision === null) {
                return { acted: false, reason: 'idle' };
            }

            // 5. Capability gate (clone-free via canEntityExecuteAction).
            const canAct = this._facade.canEntityExecuteAction?.(npcEntityId, decision.actionName);
            if (canAct !== true) {
                Logger.warn(`[NpcAI] Capability gate failed for ${npcEntityId}: ${decision.actionName} not executable.`);
                return { acted: false, reason: 'capability' };
            }

            // 6. Dispatch decision
            const dispatchResult = this._dispatchDecision(npcEntityId, decision);
            if (dispatchResult.acted) {
                Logger.info(`[NpcAI] Round ${round}: ${entity.name || npcEntityId} executed ${decision.actionName}.`);
                return { acted: true };
            }
            Logger.warn(`[NpcAI] Round ${round}: ${entity.name || npcEntityId} decision "${decision.actionName}" rejected: ${dispatchResult.reason}.`);
            return { acted: false, reason: dispatchResult.reason };
        } catch (error) {
            // Root-level failsafe: behavior bug cannot break the turn loop.
            Logger.error(`[NpcAI] think() failed for ${npcEntityId}: ${error.message}`);
            return { acted: false, skipped: 'THINK_ERROR', reason: error.message };
        }
    }

    /**
     * Mirrors LLMAgentController._dispatchAction semantics:
     *  - phase === 'planning' → turnSystem.queueAction(entityId, actionName, params, 'npc')
     *  - TURNS_DISABLED → immediate executeAction fallback (LLM mirroring)
     *  - PLANNING_CLOSED / closed window → discard with log
     *  - no tick clock (tests/world without turns) → immediate facade.executeAction (fallback)
     * @returns {{ acted: boolean, reason?: string }}
     */
    _dispatchDecision(entityId, decision) {
        const actionName = decision.actionName;
        const params = decision.params || {};

        const hasTurnSystem = this._turnSystem !== null && typeof this._turnSystem === 'object';

        if (hasTurnSystem) {
            const roundState = this._turnSystem.getRoundState?.();

            if (!roundState) {
                Logger.warn(`[NpcAI] World has no turns — executing ${actionName} immediately for ${entityId}.`);
                try {
                    this._facade.executeAction?.(actionName, entityId, params);
                    return { acted: true };
                } catch (error) {
                    Logger.error(`[NpcAI] executeAction fallback failed for ${entityId}: ${error.message}`);
                    return { acted: false, reason: 'execute_failed' };
                }
            }

            if (roundState.phase !== 'planning') {
                Logger.warn(`[NpcAI] Window closed for ${entityId}: ${actionName} discarded (phase=${roundState.phase}).`);
                return { acted: false, reason: 'window_closed' };
            }

            try {
                const queueResult = this._turnSystem.queueAction?.(entityId, actionName, params, 'npc');
                if (queueResult && queueResult.success) {
                    return { acted: true };
                }
                // TURNS_DISABLED fallback — mirror LLMAgentController._dispatchAction (spec §5.8).
                if (queueResult?.code === 'TURNS_DISABLED') {
                    Logger.warn(`[NpcAI] Turns disabled during planning — executing ${actionName} immediately for ${entityId}.`);
                    try {
                        this._facade.executeAction?.(actionName, entityId, params);
                        return { acted: true };
                    } catch (error) {
                        Logger.error(`[NpcAI] executeAction fallback failed for ${entityId}: ${error.message}`);
                        return { acted: false, reason: 'execute_failed' };
                    }
                }
                Logger.error(`[NpcAI] queueAction rejected for ${entityId}: code=${queueResult?.code}, error=${queueResult?.error}, action=${actionName}.`);
                return { acted: false, reason: 'queue_rejected', code: queueResult?.code };
            } catch (error) {
                Logger.error(`[NpcAI] queueAction threw for ${entityId}: ${error.message}`);
                return { acted: false, reason: 'queue_error', error: error.message };
            }
        } else {
            Logger.warn(`[NpcAI] No turn system — executing ${actionName} immediately for ${entityId}.`);
            try {
                this._facade.executeAction?.(actionName, entityId, params);
                return { acted: true };
            } catch (error) {
                Logger.error(`[NpcAI] executeAction fallback failed for ${entityId}: ${error.message}`);
                return { acted: false, reason: 'execute_failed' };
            }
        }
    }

    /**
     * Reads the range declared in the actions registry.
     * @param {Object} facade
     * @param {string} actionName
     * @returns {number|string|undefined}
     */
    _getRegistryRange(facade, actionName) {
        const registry = facade.getActionRegistry?.();
        if (!registry) return undefined;
        const action = registry[actionName];
        if (!action) return undefined;
        return action.range;
    }

    /**
     * Resolves an action's range using the registry + RangeResolver.
     * @param {Object} facade
     * @param {string} actionName
     * @param {Object} entity — to resolve placeholders
     * @returns {number}
     */
    _resolveActionRange(facade, actionName, entity) {
        const rawRange = this._getRegistryRange(facade, actionName);
        if (typeof rawRange === 'number') {
            return rawRange;
        }
        if (typeof rawRange === 'string' && rawRange.startsWith(':')) {
            // Resolve placeholders via entity stats.
            const statMap = this._buildStatMap(entity);
            return resolveRange(rawRange, statMap, DEFAULT_ATTACK_RANGE_FALLBACK);
        }
        // If it's a string number or other format, try parsing.
        const parsed = Number(rawRange);
        return isFinite(parsed) ? parsed : DEFAULT_ATTACK_RANGE_FALLBACK;
    }

    /**
     * Builds a basic statMap from the entity.
     * @param {Object} entity
     * @returns {Object}
     */
    _buildStatMap(entity) {
        const statMap = {};
        const components = Array.isArray(entity.components) ? entity.components : [];
        for (const comp of components) {
            const stats = comp.stats || {};
            for (const [key, value] of Object.entries(stats)) {
                // key can be "Physical.strength", "Movement.move", etc.
                if (typeof value === 'number') {
                    statMap[key] = value;
                }
            }
        }
        return statMap;
    }

    /**
     * Reads the durability stat of a component, accepting only finite numbers.
     * Non-numeric values (strings, booleans, NaN) are treated as missing.
     *
     * Read priority:
     *   1. Authoritative store (ComponentStatsController via facade.getComponentStats) —
     *      the nested layer { Physical: { durability } } that the damage pipeline updates.
     *      This is the only live source at runtime, since EntityController.createEntityFromBlueprint()
     *      never fills comp.stats on the entity copy (only { type, identifier, id }).
     *   2. Fallback: flat keys embedded in comp.stats — preserved for compatibility
     *      with test fixtures that inject flat stats manually into the facade mock.
     *
     * @param {Object} comp — component with .id and optionally .stats
     * @returns {number|undefined}
     * @private
     */
    _readDurability(comp) {
        // 1. Authoritative nested store via the facade (ComponentStatsController).
        if (this._facade && typeof this._facade.getComponentStats === 'function' && comp && comp.id) {
            const value = this._facade.getComponentStats(comp.id)?.Physical?.durability;
            if (typeof value === 'number' && Number.isFinite(value)) {
                return value;
            }
        }
        // 2. Fallback: flat-key stats embedded on the component (test fixtures / legacy).
        if (!comp || !comp.stats || typeof comp.stats !== 'object') {
            return undefined;
        }
        const value = comp.stats[DURABILITY_STAT_KEY];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        return undefined;
    }

    /**
     * Finds the first component with finite numeric durability.
     * @param {Object[]} components
     * @returns {Object|null}
     * @private
     */
    _findDurabilityComponent(components) {
        for (const comp of components) {
            if (this._readDurability(comp) !== undefined) {
                return comp;
            }
        }
        return null;
    }

    /**
     * Filters components usable for damage: no durability stat OR durability >= threshold.
     * @param {Object[]} components
     * @returns {Object[]}
     * @private
     */
    _filterUsableComponents(components) {
        return components.filter(comp => {
            const dur = this._readDurability(comp);
            return (dur === undefined) || (dur >= BROKEN_DURABILITY_THRESHOLD);
        });
    }

    /**
     * `chase_attack` behavior:
     * - Candidates: ALL other entities in the SAME room.
     * - Target: the closest (Euclidean distance).
     * - dist ≤ attackRange → attack (droid punch by default).
     * - dist > attackRange → move toward the target.
     *
     * @param {Object} ctx
     * @param {Object} ctx.entity
     * @param {number} ctx.round
     * @param {Object} ctx.ai
     * @param {Object} ctx.facade
     * @param {Object} [ctx.allEntities] — optional; fallback to facade.getEntities()
     * @returns {{ actionName: string, params: Object }|null}
     */
    _chaseAttackBehavior({ entity, round, ai, facade, allEntities }) {
        const room = entity.location;
        if (!room || !entity.spatial) {
            return null;
        }

        // L2: Guard non-finite spatial on the entity.
        if (!Number.isFinite(entity.spatial.x) || !Number.isFinite(entity.spatial.y)) {
            Logger.warn(`[NpcAI] ${entity.name || entity.id} has non-finite spatial — skipping.`);
            return null;
        }

        // Candidates: ALL other entities in the SAME room.
        const all = allEntities ?? (facade.getEntities?.() || {});
        const candidates = Object.values(all).filter(e =>
            e && e.id !== entity.id && e.location === room && e.spatial
        );

        if (candidates.length === 0) {
            return null; // empty room → idle
        }

        // Target: the closest (Euclidean distance).
        let target = candidates[0];
        let minDistance = dist(entity.spatial, candidates[0].spatial);

        for (let i = 1; i < candidates.length; i++) {
            const d = dist(entity.spatial, candidates[i].spatial);
            if (d < minDistance) {
                minDistance = d;
                target = candidates[i];
            }
        }

        // L2: Guard non-finite spatial on the selected target.
        if (!Number.isFinite(target.spatial.x) || !Number.isFinite(target.spatial.y)) {
            Logger.warn(`[NpcAI] Target ${target.name || target.id} has non-finite spatial — skipping.`);
            return null;
        }

        const attackAction = typeof ai.attackAction === 'string' ? ai.attackAction : 'droid punch';
        const moveAction = typeof ai.moveAction === 'string' ? ai.moveAction : 'move';
        const attackRange = (typeof ai.attackRange === 'number')
            ? ai.attackRange
            : this._resolveActionRange(facade, attackAction, entity);

        if (minDistance <= attackRange) {
            // Attack: select the best component for the target.
            const targetComponent = this._selectTargetComponent(target, entity.id, round);
            if (!targetComponent) {
                return null;
            }
            Logger.debug(`[NpcAI] Round ${round}: ${entity.name} chases ${target.name || target.id} (dist: ${minDistance.toFixed(1)} ≤ ${attackRange}) → ${attackAction}.`);
            return { actionName: attackAction, params: { targetComponentId: targetComponent.id } };
        }

        // Chase: move with targetX/Y = target's position.
        Logger.debug(`[NpcAI] Round ${round}: ${entity.name} chases ${target.name || target.id} (dist: ${minDistance.toFixed(1)} > ${attackRange}) → move.`);
        return {
            actionName: moveAction,
            params: { targetX: target.spatial.x, targetY: target.spatial.y }
        };
    }

    /**
     * `craft_loop` behavior (Crafter Drone): forage → forge → drop.
     *
     * Deterministic and stateless — re-derives the drone's situation every round
     * and emits at most ONE turn action:
     *
     *   Stage A — holds a foraged item (found via facade.getEntityItems on any
     *            component): craft immediately via the facade (crafting is
     *            intentionally NOT a registry action — no turn cost). On success,
     *            the NEW output item is detected as the set-difference of output
     *            item ids before/after the craft, and a single dropItem action
     *            targeting the drone's own position is returned. On craft
     *            failure → idle (retry next round).
     *   Stage B — no item held: scan dropped items for the target item type in
     *            the drone's OWN room only. None → idle.
     *   Stage C — nearest in-room item (Euclidean distance, id tie-break):
     *            distance ≤ PICK_RANGE → immediate zero-cost pickup on the core
     *            component (returns idle); beyond PICK_RANGE → a move action
     *            toward the item, repeated each round until in range (no
     *            pathfinding — identical pattern to chase_attack).
     *
     * After the drop, the loop returns to Stage B on the next round. No RNG.
     *
     * @param {Object} ctx
     * @param {Object} ctx.entity
     * @param {number} ctx.round
     * @param {Object} [ctx.ai] — accepted for signature symmetry; craft_loop has
     *   no ai-configurable overrides (fixed action names, spec §3.1).
     * @param {Object} ctx.facade — world state facade (public API only)
     * @returns {{ actionName: string, params: Object }|null} single turn action or null (idle)
     */
    _craftLoopBehavior({ entity, round, facade }) {
        // Guards: known room + finite spatial (mirrors chase_attack).
        if (!entity || !entity.location || !entity.spatial) {
            return null;
        }
        if (!Number.isFinite(entity.spatial.x) || !Number.isFinite(entity.spatial.y)) {
            Logger.warn(`[NpcAI] ${entity.name || entity.id} has non-finite spatial — skipping.`);
            return null;
        }

        const targetItemType = this._resolveCraftInputType(facade);

        // Stage A is TERMINAL: if the drone holds a foraged item, this round is
        // spent crafting it (or idling on craft failure) — it never falls
        // through to the forage scan. (Preserved from the original single method:
        // a craft-failure round must not also pick up another knife.)
        const heldItems = this._flattenEntityItems(facade.getEntityItems?.(entity.id));
        const heldTarget = heldItems.find(item => item && item.type === targetItemType);
        if (heldTarget && heldTarget.hostComponentId) {
            return this._craftLoopCraftStage({ entity, round, facade, targetItemType, heldItems, heldTarget });
        }

        // Stages B + C — no item held: forage in the drone's own room.
        return this._craftLoopForageStage({ entity, round, facade, targetItemType });
    }

    /**
     * Stage A — the drone holds a foraged item: craft it (zero-cost, immediate)
     * and, on success, return the single turn action that drops the freshly
     * produced output item at the drone's own position. Returns null (idle) when
     * the craft fails or the new output cannot be detected — the drone
     * re-derives next round.
     *
     * @param {Object} ctx
     * @param {Object} ctx.entity
     * @param {number} ctx.round
     * @param {Object} ctx.facade — world state facade (public API only)
     * @param {string} ctx.targetItemType — resolved recipe input type
     * @param {Object[]} ctx.heldItems — flattened items held before the craft
     * @param {Object} ctx.heldTarget — the held target item (has a hostComponentId)
     * @returns {{ actionName: string, params: Object }|null}
     * @private
     */
    _craftLoopCraftStage({ entity, round, facade, targetItemType, heldItems, heldTarget }) {
        const outputIdsBefore = new Set(
            heldItems
                .filter(item => item && item.type === CRAFT_OUTPUT_TYPE)
                .map(item => item.id)
        );

        const craftResult = facade.craftItems
            ? facade.craftItems(entity.id, RECIPE_ID, heldTarget.hostComponentId, [heldTarget.id])
            : null;

        if (craftResult && craftResult.success) {
            const outputIdsAfter = this._flattenEntityItems(facade.getEntityItems?.(entity.id))
                .filter(item => item && item.type === CRAFT_OUTPUT_TYPE)
                .map(item => item.id);
            // The new item is the set-difference (the recipe consumes exactly
            // the held input); fall back to any present output id defensively.
            const newItemId = outputIdsAfter.find(id => !outputIdsBefore.has(id)) ?? outputIdsAfter[0];
            if (newItemId) {
                Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} crafted ${RECIPE_ID} — dropping ${CRAFT_OUTPUT_TYPE} ${newItemId}.`);
                return {
                    actionName: CRAFT_DROP_ACTION,
                    params: {
                        itemId: newItemId,
                        itemType: CRAFT_OUTPUT_TYPE,
                        targetX: entity.spatial.x,
                        targetY: entity.spatial.y
                    }
                };
            }
            Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} crafted ${RECIPE_ID} but the new ${CRAFT_OUTPUT_TYPE} could not be detected — idle this round.`);
            return null;
        }

        // Structured failure (e.g. nested-item guard) → idle; retry next round.
        Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} craft ${RECIPE_ID} failed (${craftResult?.code || 'unknown'}) — idle this round.`);
        return null;
    }

    /**
     * Stages B + C — the drone holds no target item: scan the world's dropped
     * items for the target item type (the helper owns the room and finite-
     * coordinate guards), then act on the nearest in-room item — within
     * PICK_RANGE: immediate zero-cost pickup on the core component (idle this
     * round); beyond: a move action toward the item, repeated each round until
     * in range (no pathfinding — identical pattern to chase_attack). Returns
     * null (idle) when no candidate item exists.
     *
     * @param {Object} ctx
     * @param {Object} ctx.entity
     * @param {number} ctx.round
     * @param {Object} ctx.facade — world state facade (public API only)
     * @param {string} ctx.targetItemType — resolved recipe input type
     * @returns {{ actionName: string, params: Object }|null}
     * @private
     */
    _craftLoopForageStage({ entity, round, facade, targetItemType }) {
        // Stage B — target items dropped anywhere; the helper owns the
        // room/finite-coordinate guards, so this filter keeps only the craft
        // policy (item type).
        const droppedItems = facade.getDroppedItems ? Object.values(facade.getDroppedItems() || {}) : [];
        const candidates = droppedItems.filter(item => item && item.itemType === targetItemType);
        if (candidates.length === 0) {
            return null; // idle — no target items in the world at all
        }

        // Stage C — nearest in-room item (Euclidean, id tie-break); the helper
        // reports the distance so the range rule is applied exactly once, here
        // (mirrors chase_attack's in-behavior range decision).
        const nearest = findNearestDroppedItem(candidates, entity.location, entity.spatial.x, entity.spatial.y);
        if (!nearest) {
            // Reachable now: target items exist, but none in this room with
            // finite coordinates — idle.
            return null;
        }

        const { item: targetItem, distance } = nearest;
        if (distance <= PICK_RANGE) {
            this._craftLoopAttemptPickup(entity, round, facade, targetItem, distance, targetItemType);
            return null; // the pickup is free — nothing to queue this round
        }

        // Out of range → move toward the item (repeats each round; no pathfinding).
        return {
            actionName: CRAFT_MOVE_ACTION,
            params: { targetX: targetItem.x, targetY: targetItem.y }
        };
    }

    /**
     * Immediate zero-cost pickup of an in-range dropped item on the drone's core
     * component (kept out of the 6-volume arms so the forged container fits,
     * spec §1). The handler re-validates at call time; on rejection the drone
     * re-derives next round (stateless) — but the rejection must be visible in
     * the log (code_quality_and_best_practices.md §3.1). See M2.
     *
     * @param {Object} entity
     * @param {number} round
     * @param {Object} facade — world state facade (public API only)
     * @param {Object} item — the dropped item entry (in range, in the drone's room)
     * @param {number} distance — pre-computed distance to the item
     * @param {string} targetItemType
     * @private
     */
    _craftLoopAttemptPickup(entity, round, facade, item, distance, targetItemType) {
        const core = (Array.isArray(entity.components) ? entity.components : [])
            .find(comp => comp && comp.type === CRAFT_CORE_COMPONENT_TYPE);
        if (!core) {
            Logger.warn(`[NpcAI] Round ${round}: ${entity.name || entity.id} has no ${CRAFT_CORE_COMPONENT_TYPE} component — cannot pick up ${item.id}.`);
            return;
        }

        const pickResult = facade.executePickUpItem?.(entity.id, item.id, core.id);
        if (pickResult && pickResult.success) {
            Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} picked up dropped ${targetItemType} ${item.id} (dist: ${distance.toFixed(1)} ≤ ${PICK_RANGE}).`);
        } else {
            // Visible graceful degradation: the handler rejected the pickup
            // (stale target, out-of-range, capacity, nested children, or the
            // dispatcher is missing). The drone is stateless and re-derives next
            // round — but the rejection is logged (with the handler's reason)
            // instead of a false success.
            Logger.warn(`[NpcAI] Round ${round}: ${entity.name || entity.id} pickup of ${item.id} rejected (${pickResult?.message || pickResult?.code || 'unknown'}) — re-derives next round.`);
        }
    }

    /**
     * Resolves the item type that craft_loop forages: prefers the first input
     * type of RECIPE_ID from the live recipe registry (the recipe is the single
     * source of truth), falling back to TARGET_ITEM_TYPE when the registry is
     * unavailable or the recipe is absent.
     *
     * @param {Object} facade — world state facade (public API only)
     * @returns {string} the target item type
     * @private
     */
    _resolveCraftInputType(facade) {
        const recipes = facade.getCraftingRecipes ? facade.getCraftingRecipes() : null;
        const recipe = Array.isArray(recipes) ? recipes.find(r => r && r.id === RECIPE_ID) : null;
        const inputType = recipe?.inputs?.[0]?.type;
        if (typeof inputType === 'string' && inputType.length > 0) {
            return inputType;
        }
        return TARGET_ITEM_TYPE;
    }

    /**
     * Flattens the `{ [hostComponentId]: [item, ...] }` map returned by
     * `facade.getEntityItems()` into a single array of item objects, skipping
     * malformed entries.
     *
     * @param {Object|null|undefined} itemsByComponent
     * @returns {Object[]}
     * @private
     */
    _flattenEntityItems(itemsByComponent) {
        if (!itemsByComponent || typeof itemsByComponent !== 'object') {
            return [];
        }
        const items = [];
        for (const list of Object.values(itemsByComponent)) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                if (item && typeof item === 'object') {
                    items.push(item);
                }
            }
        }
        return items;
    }

    /**
     * Selects the best component of a target for attack decisions.
     *
     * Selection rule (deterministic):
     * 1. Prefer the first component with finite numeric durability.
     * 2. Fallback: first component in the list.
     * 3. No valid components → null (attack is ignored).
     * 4. If the selected component is broken (durability < threshold),
     *    deterministic reselection among usable candidates; if none
     *    exist, null (attack is ignored rather than wasted).
     *
     * @param {Object} target — entity with .components[]
     * @param {string} entityId — NPC entity id (for deterministic selection)
     * @param {number} round — current round
     * @returns {Object|null}
     * @private
     */
    _selectTargetComponent(target, entityId, round) {
        const components = target.components;
        if (!Array.isArray(components) || components.length === 0) {
            return null;
        }

        // Normalize: removes entries that are not objects (prevents TypeError downstream).
        const validComponents = components.filter(c => c != null && typeof c === 'object');
        if (validComponents.length === 0) {
            return null;
        }

        const selected = this._findDurabilityComponent(validComponents);
        if (selected === null) {
            return validComponents[0];
        }

        const durability = this._readDurability(selected);
        if (durability !== undefined && durability < BROKEN_DURABILITY_THRESHOLD) {
            const candidates = this._filterUsableComponents(validComponents);

            if (candidates.length > 0) {
                Logger.debug(`[NpcAI] Target ${selected.id} broken (durability: ${durability}) — reselection among ${candidates.length} candidate(s).`);
                return this._pickRandomComponent(candidates, entityId, round);
            }

                Logger.debug(`[NpcAI] All components of target ${target.id} are broken — attack ignored.`);
            return null;
        }

        return selected;
    }

    /**
     * Selects a component from an array using a deterministic per-tick choice.
     * The seed is derived from entityId + round — ensuring reproducible results
     * in replay/debug/save-load scenarios.
     * @param {Object[]} components
     * @param {string} entityId — NPC entity id (part of the seed)
     * @param {number} round — current round number (part of the seed)
     * @param {Function} [rng] — optional override for testing; default is deterministic hash
     * @returns {Object|null}
     * @private
     */
    _pickRandomComponent(components, entityId, round, rng) {
        if (!Array.isArray(components) || components.length === 0) {
            return null;
        }
        if (components.length === 1) {
            return components[0];
        }
        if (typeof rng === 'function') {
            const index = Math.min(Math.floor(rng() * components.length), components.length - 1);
            return components[index];
        }
        // Deterministic: simple hash of (entityId + '|' + round), mixed with the round
        // so that different rounds choose different candidates.
        let seed = 0;
        const seedStr = entityId + '|' + round;
        for (let i = 0; i < seedStr.length; i++) {
            seed = ((seed << 5) - seed) + seedStr.charCodeAt(i);
            seed |= 0; // clamp to int 32 bits
        }
        const index = ((seed >>> 0) + round) % components.length;
        return components[index];
    }
}

export default NpcAIController;

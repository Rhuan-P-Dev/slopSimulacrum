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
 *   - `chase_attack`: chase and attack the nearest VIABLE entity in the same room
 *     (a component-less "ghost" is never targeted — see _isViableTarget).
 *   - `craft_loop`: Crafter Drone — forage a dropped item, forge it into the
 * recipe output, and drop it on the ground (wiki/subMDs/controllers/npc_ai_controller.md).
 *
 * @module NpcAIController
 */

import Logger from '../../utils/Logger.js';
import {
    hasDeterministicBrain,
    findNearestDroppedItem,
    resolvePickUpRange,
    hasUsableComponent,
    RECIPE_ID,
    TARGET_ITEM_TYPE,
    CRAFT_OUTPUT_TYPE
} from '../../utils/npcAiUtils.js';
import { resolveRange } from '../../../shared/RangeResolver.js';
import { NPC_DEFAULT_ATTACK_RANGE, NPC_BEHAVIOR_CHASE_ATTACK } from '../../utils/Constants.js';
import { ACTION_NAMES } from '../../../shared/ActionVocabulary.js';
import { TURN_PHASES } from '../../../shared/TurnPhases.js';
import { EXISTENCE_GONE_AT } from '../../../shared/StatVocabulary.js';

/**
 * Key for the components' existence stat (also consumed by the damage pipeline).
 * @constant
 */
const EXISTENCE_STAT_KEY = 'Physical.existence';

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
 * A data-driven resolution would add a fragile volume heuristic, so the sync risk is pinned by contract test 1's blueprint assertions.
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
        this.registerBehavior(NPC_BEHAVIOR_CHASE_ATTACK, this._chaseAttackBehavior.bind(this));
        this.registerBehavior('craft_loop', this._craftLoopBehavior.bind(this));
        // Pre-registers the first behavior.
        
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

            if (roundState.phase !== TURN_PHASES.PLANNING) {
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
            return resolveRange(rawRange, statMap, NPC_DEFAULT_ATTACK_RANGE);
        }
        // If it's a string number or other format, try parsing.
        const parsed = Number(rawRange);
        return isFinite(parsed) ? parsed : NPC_DEFAULT_ATTACK_RANGE;
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
     * Reads the existence stat of a component, accepting only finite numbers.
     * Non-numeric values (strings, booleans, NaN) are treated as missing.
     *
     * Read priority:
     *   1. Authoritative store (ComponentStatsController via facade.getComponentStats) —
     *      the nested layer { Physical: { existence } } that the damage pipeline updates.
     *      This is the only live source at runtime, since EntityController.createEntityFromBlueprint()
     *      never fills comp.stats on the entity copy (only { type, identifier, id }).
     *   2. Fallback: flat keys embedded in comp.stats — preserved for compatibility
     *      with test fixtures that inject flat stats manually into the facade mock.
     *
     * @param {Object} comp — component with .id and optionally .stats
     * @returns {number|undefined}
     * @private
     */
    _readExistence(comp) {
        // 1. Authoritative nested store via the facade (ComponentStatsController).
        if (this._facade && typeof this._facade.getComponentStats === 'function' && comp && comp.id) {
            const value = this._facade.getComponentStats(comp.id)?.Physical?.existence;
            if (typeof value === 'number' && Number.isFinite(value)) {
                return value;
            }
        }
        // 2. Fallback: flat-key stats embedded on the component (test fixtures / legacy).
        if (!comp || !comp.stats || typeof comp.stats !== 'object') {
            return undefined;
        }
        const value = comp.stats[EXISTENCE_STAT_KEY];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        return undefined;
    }

    /**
     * Finds the first component with finite numeric existence.
     * @param {Object[]} components
     * @returns {Object|null}
     * @private
     */
    _findExistenceComponent(components) {
        for (const comp of components) {
            if (this._readExistence(comp) !== undefined) {
                return comp;
            }
        }
        return null;
    }

    /**
     * Filters components usable for damage: no existence stat OR existence >= threshold.
     * @param {Object[]} components
     * @returns {Object[]}
     * @private
     */
    _filterUsableComponents(components) {
        return components.filter(comp => {
            const dur = this._readExistence(comp);
            return (dur === undefined) || (dur > EXISTENCE_GONE_AT);
        });
    }

    /**
     * Viability filter for chase_attack candidates (defense-in-depth).
     *
     * WHY: the allEntities snapshot taken at think() entry can briefly contain
     * an entity that has ceased to exist — a component-less "ghost" left behind
     * by a mid-cascade removal, or an id that has since been despawned. Such an
     * entity sits at distance ≈ 0 for a droid that chased it there, so without
     * this filter it permanently wins the closest-candidate race: in range the
     * brain idles stuck on the corpse (zero usable components), out of range it
     * chases the ghost forever. A ghost must never be targeted: the droid either
     * attacks a viable entity or idles. The root fix (WorldStateController
     * despawns fully-eliminated entities) makes this path rare; the filter is
     * the backstop for the window where a ghost is still visible.
     *
     * L2 — live-read semantics: when the facade exposes getEntity, component
     * membership AND existence are read from the LIVE entity, never the stale
     * snapshot (a mid-cascade wreck's components have reached existence 0 in the
     * live state even though the snapshot still shows them alive; conversely a
     * snapshot-ghost may be a fully alive live entity). getEntity is read
     * through the facade's public API only — never internal state. The snapshot
     * `candidate` is used ONLY when the facade has no getEntity (test facades
     * that expose a single immutable world), where the snapshot IS the live
     * state and there is no fresher source to read.
     *
     * Targetability is delegated to the shared core predicate
     * (npcAiUtils.hasUsableComponent): at least one usable component
     * (existence unknown, or > EXISTENCE_GONE_AT) — the same notion the LLM
     * context enforces, so the brain and the LLM context never disagree.
     *
     * @param {Object} candidate — entity from the allEntities snapshot
     * @returns {boolean} true when the entity still exists and has ≥ 1 usable component
     * @private
     */
    _isViableTarget(candidate) {
        const facade = this._facade;

        // L2: prefer the LIVE entity. A stale snapshot can reference an id that
        // has since been despawned (getEntity → null → non-viable), or an
        // entity whose components have since changed (mid-cascade). When the
        // facade exposes getEntity, source = the live entity, never the snapshot.
        let source = candidate;
        if (typeof facade.getEntity === 'function') {
            const live = facade.getEntity(candidate.id);
            if (!live) return false; // despawned after the snapshot was taken
            source = live;
        }

        // A component-less entity is a ghost — nothing left to damage. The live
        // entity's `components` may be a missing array (a mid-cascade wreck that
        // has not been despawned yet); treat it as a ghost (non-viable). There
        // is NO snapshot fallback here — that is exactly the stale data this
        // guards against.
        const components = Array.isArray(source.components) ? source.components : [];
        if (components.length === 0) return false;

        // Core targetability (single source of truth — npcAiUtils): ≥ 1 usable
        // component (existence unknown, or > EXISTENCE_GONE_AT). The reader is
        // the brain's own _readExistence (authoritative store, flat-key fallback
        // for test fixtures).
        return hasUsableComponent(components, (comp) => this._readExistence(comp));
    }

    /**
     * `chase_attack` behavior:
     * - Candidates: ALL other VIABLE entities in the SAME room (a
     *   component-less "ghost" is never targeted — see _isViableTarget).
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

        // Candidates: ALL other VIABLE entities in the SAME room. The
        // viability filter is defense-in-depth: a mid-cascade or not-yet-
        // despawned "ghost" must never win the closest-candidate race
        // (otherwise it is chased forever, or the droid idles stuck on it).
        const all = allEntities ?? (facade.getEntities?.() || {});
        const candidates = Object.values(all).filter(e =>
            e && e.id !== entity.id && e.location === room && e.spatial
            && this._isViableTarget(e)
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

        // L2: the snapshot candidate's id is authoritative, but its components
        // and spatial may be stale (a mid-cascade wreck, or a snapshot-ghost
        // that is actually alive). When the facade exposes getEntity, re-resolve
        // the LIVE entity once and use it for everything downstream — the live
        // read wins over the snapshot. (Read via the facade's public API only;
        // when the facade has no getEntity the snapshot candidate IS the live
        // state, so we fall back to it unchanged.)
        const liveTarget = (typeof facade.getEntity === 'function')
            ? (facade.getEntity(target.id) || target)
            : target;

        // L2: Guard non-finite spatial on the selected (live) target.
        if (!Number.isFinite(liveTarget.spatial?.x) || !Number.isFinite(liveTarget.spatial?.y)) {
            Logger.warn(`[NpcAI] Target ${liveTarget.name || liveTarget.id} has non-finite spatial — skipping.`);
            return null;
        }

        const attackAction = typeof ai.attackAction === 'string' ? ai.attackAction : ACTION_NAMES.PUNCH;
        const moveAction = typeof ai.moveAction === 'string' ? ai.moveAction : ACTION_NAMES.MOVE;
        const attackRange = (typeof ai.attackRange === 'number')
            ? ai.attackRange
            : this._resolveActionRange(facade, attackAction, entity);

        if (minDistance <= attackRange) {
            // Attack: select the best component of the LIVE target.
            const targetComponent = this._selectTargetComponent(liveTarget, entity.id, round);
            if (!targetComponent) {
                return null;
            }
            Logger.debug(`[NpcAI] Round ${round}: ${entity.name} chases ${liveTarget.name || liveTarget.id} (dist: ${minDistance.toFixed(1)} ≤ ${attackRange}) → ${attackAction}.`);
            return { actionName: attackAction, params: { targetComponentId: targetComponent.id } };
        }

        // Chase: move toward the LIVE target's position.
        Logger.debug(`[NpcAI] Round ${round}: ${entity.name} chases ${liveTarget.name || liveTarget.id} (dist: ${minDistance.toFixed(1)} > ${attackRange}) → move.`);
        return {
            actionName: moveAction,
            params: { targetX: liveTarget.spatial.x, targetY: liveTarget.spatial.y }
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
     *            distance ≤ the resolved pickup range (each round, from the
     *            data-driven pickUpItem action definition — the same source
     *            the PickUpItemHandler validates against) → immediate
     *            zero-cost pickup on the core component (returns idle);
     *            beyond → a move action toward the item, repeated each round
     *            until in range (no pathfinding — identical pattern to
     *            chase_attack). If the in-range pickup is rejected by the
     *            handler (e.g. a range desync), the drone falls back to the
     *            approach phase instead of re-deriving the pickup forever
     *            (graceful degradation — the goal still completes).
     *
     * After the drop, the loop returns to Stage B on the next round. No RNG.
     *
     * @param {Object} ctx
     * @param {Object} ctx.entity
     * @param {number} ctx.round
     * @param {Object} [ctx.ai] — accepted for signature symmetry; craft_loop has
     *   no ai-configurable overrides (fixed action names, wiki/subMDs/controllers/npc_ai_controller.md).
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
    _craftLoopCraftStage({ entity, round, facade, heldItems, heldTarget }) {
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
     * coordinate guards), then act on the nearest in-room item — within the
     * resolved pickup range (the data-driven pickUpItem range, the same
     * source as the PickUpItemHandler): immediate zero-cost pickup on the
     * core component (idle this round); beyond: a move action toward the
     * item, repeated each round until in range (no pathfinding — identical
     * pattern to chase_attack). If the in-range pickup is rejected by the
     * handler, the stage falls back to the approach phase (a move) instead
     * of re-deriving the same pickup decision every round. Returns null
     * (idle) when no candidate item exists.
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
        // The brain's range decision resolves from the same data-driven
        // pickUpItem definition the handler validates against — the two
        // cannot drift (single source of truth, see resolvePickUpRange).
        const pickRange = resolvePickUpRange(facade, entity);
        if (distance <= pickRange) {
            const pickedUp = this._craftLoopAttemptPickup(entity, round, facade, targetItem, distance, pickRange, targetItemType);
            if (pickedUp) {
                return null; // the pickup is free — nothing to queue this round
            }
            // Graceful degradation: the handler rejected the in-range pickup
            // (range desync, stale target, capacity, ...). Instead of
            // re-deriving the same pickup decision every round, the drone
            // falls back to the approach phase — it keeps converging on the
            // item and retries the pickup as it closes, so the goal still
            // completes even under a desync.
            Logger.warn(`[NpcAI] Round ${round}: ${entity.name || entity.id} pickup of ${targetItem.id} rejected — falling back to the approach phase (dist: ${distance.toFixed(1)}, pick range: ${pickRange}).`);
        }

        // Out of range (or the in-range pickup was rejected) → move toward
        // the item (repeats each round; no pathfinding).
        return {
            actionName: CRAFT_MOVE_ACTION,
            params: { targetX: targetItem.x, targetY: targetItem.y }
        };
    }

    /**
     * Immediate zero-cost pickup of an in-range dropped item on the drone's core
     * component (kept out of the 6-volume arms so the forged container fits,
     * spec §1). The handler re-validates at call time; on rejection the
     * rejection must be visible in the log
     * (code_quality_and_best_practices.md §3.1) and the caller falls back to
     * the approach phase instead of re-deriving the same pickup decision
     * forever. See M2.
     *
     * @param {Object} entity
     * @param {number} round
     * @param {Object} facade — world state facade (public API only)
     * @param {Object} item — the dropped item entry (in range, in the drone's room)
     * @param {number} distance — pre-computed distance to the item
     * @param {number} pickRange — the resolved pickup range (for logging)
     * @param {string} targetItemType
     * @returns {boolean} true when the pickup was committed, false when the
     *   handler rejected it (or the dispatcher is missing)
     * @private
     */
    _craftLoopAttemptPickup(entity, round, facade, item, distance, pickRange, targetItemType) {
        const core = (Array.isArray(entity.components) ? entity.components : [])
            .find(comp => comp && comp.type === CRAFT_CORE_COMPONENT_TYPE);
        if (!core) {
            Logger.warn(`[NpcAI] Round ${round}: ${entity.name || entity.id} has no ${CRAFT_CORE_COMPONENT_TYPE} component — cannot pick up ${item.id}.`);
            return false;
        }

        const pickResult = facade.executePickUpItem?.(entity.id, item.id, core.id);
        if (pickResult && pickResult.success) {
            Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} picked up dropped ${targetItemType} ${item.id} (dist: ${distance.toFixed(1)} ≤ ${pickRange}).`);
            return true;
        }
        // Visible graceful degradation: the handler rejected the pickup
        // (stale target, out-of-range, capacity, nested children, or the
        // dispatcher is missing). The caller falls back to the approach
        // phase — but the rejection is logged (with the handler's reason)
        // instead of a false success.
        Logger.warn(`[NpcAI] Round ${round}: ${entity.name || entity.id} pickup of ${item.id} rejected (${pickResult?.message || pickResult?.code || 'unknown'}).`);
        return false;
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
     * 1. Prefer the first component with finite numeric existence.
     * 2. Fallback: first component in the list.
     * 3. No valid components → null (attack is ignored).
     * 4. If the selected component is broken (existence < threshold),
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

        const selected = this._findExistenceComponent(validComponents);
        if (selected === null) {
            return validComponents[0];
        }

        const existence = this._readExistence(selected);
        if (existence !== undefined && existence <= EXISTENCE_GONE_AT) {
            const candidates = this._filterUsableComponents(validComponents);

            if (candidates.length > 0) {
                Logger.debug(`[NpcAI] Target ${selected.id} broken (existence: ${existence}) — reselection among ${candidates.length} candidate(s).`);
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

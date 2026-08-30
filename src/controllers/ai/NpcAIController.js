/**
 * NpcAIController — stateless, data-driven "brain" for deterministic NPCs.
 *
 * The controller reads the world state via the facade's public API (WorldStateController),
 * never mutates state directly, and queues at most 1 action per round via TurnSystem.
 *
 * Behaviors are registered via `registerBehavior(name, strategyFn)`.
 * The strategy receives `{ entity, round, ai, facade }` and returns `{ actionName, params }` or null.
 *
 * First behavior: `chase_attack` (chase and attack the nearest entity in the same room).
 *
 * @module NpcAIController
 */

import Logger from '../../utils/Logger.js';
import { hasDeterministicBrain } from '../../utils/npcAiUtils.js';
import { resolveRange } from '../../../shared/RangeResolver.js';
import { NPC_DEFAULT_ATTACK_RANGE, NPC_BEHAVIOR_CHASE_ATTACK } from '../../utils/Constants.js';
import { ACTION_NAMES } from '../../../shared/ActionVocabulary.js';
import { TURN_PHASES } from '../../../shared/TurnPhases.js';
import { DURABILITY_USABLE_MIN } from '../../../shared/StatVocabulary.js';

/**
 * Key for the components' durability stat (also consumed by the damage pipeline).
 * @constant
 */
const DURABILITY_STAT_KEY = 'Physical.durability';

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

        // Pre-registers the first behavior.
        this.registerBehavior(NPC_BEHAVIOR_CHASE_ATTACK, this._chaseAttackBehavior.bind(this));
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
            return (dur === undefined) || (dur >= DURABILITY_USABLE_MIN);
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
     * @param {Object} [ctx.allEntities] — optional; fallback to facade.stateEntityController?.getAll()
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

        const attackAction = typeof ai.attackAction === 'string' ? ai.attackAction : ACTION_NAMES.PUNCH;
        const moveAction = typeof ai.moveAction === 'string' ? ai.moveAction : ACTION_NAMES.MOVE;
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
        if (durability !== undefined && durability < DURABILITY_USABLE_MIN) {
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

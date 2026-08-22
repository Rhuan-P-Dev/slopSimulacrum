/**
 * NpcAIController — "cérebro" stateless e data-driven para NPCs determinísticos.
 *
 * O controller lê o estado do mundo via API pública do facade (WorldStateController),
 * nunca muta estado diretamente, e enfileira no máximo 1 ação por round via TurnSystem.
 *
 * Comportamentos são registrados via `registerBehavior(name, strategyFn)`.
 * A strategy recebe `{ entity, round, ai, facade }` e devolve `{ actionName, params }` ou null.
 *
 * Primeiro comportamento: `chase_attack` (perseguir e atacar a entity mais próxima na mesma sala).
 *
 * @module NpcAIController
 */

import Logger from '../../utils/Logger.js';
import { hasDeterministicBrain } from '../../utils/npcAiUtils.js';
import { resolveRange } from '../../../shared/RangeResolver.js';

/**
 * Fallback para range de ataque quando não é possível resolver.
 * @constant
 */
const DEFAULT_ATTACK_RANGE_FALLBACK = 100;

/**
 * Calcula distância euclidiana entre dois pontos spatial.
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
     * @param {Object} deps.worldStateController — facade (API pública só)
     * @param {Object|null} deps.turnSystemController — TurnSystemController ou null (mundo sem turns)
     */
    constructor({ worldStateController, turnSystemController }) {
        this._facade = worldStateController;
        this._turnSystem = turnSystemController;
        this._behaviors = new Map();

        // Pré-registra o 1º comportamento.
        this.registerBehavior('chase_attack', this._chaseAttackBehavior.bind(this));
    }

    /**
     * Predicado centralizado: a entity tem um cérebro determinístico configurado?
     * Usado pelo dispatcher (server.js), pela guarda do LLM e pelo guard NO_AI do think().
     * @param {Object} entity — entity com possivelmente npcConfig.ai
     * @returns {boolean}
     */
    static hasDeterministicBrain(entity) {
        return hasDeterministicBrain(entity);
    }

    /**
     * Registra um comportamento (behavior name → strategy function).
     * @param {string} name
     * @param {Function} strategy — recebe ctx = { entity, round, ai, facade }
     */
    registerBehavior(name, strategy) {
        this._behaviors.set(name, strategy);
        Logger.info(`[NpcAI] Registered behavior: "${name}".`);
    }

    /**
     * PONTO DE ENTRADA (chamado pelo dispatcher no slot de agente, tick 20).
     * Sincrono, stateless, NUNCA lança.
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

            // 3. Buscar strategy no registro
            const ai = entity.npcConfig?.ai;
            const strategy = this._behaviors.get(ai.behavior);
            if (!strategy) {
                Logger.warn(`[NpcAI] Unknown behavior "${ai.behavior}" for ${npcEntityId} — skipping.`);
                return { acted: false, skipped: 'UNKNOWN_BEHAVIOR' };
            }

            // 4. Executar estratégia (stateless) — single per-tick snapshot via allEntities.
            const allEntities = this._facade.getAllEntities?.();
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
            // Failsafe na raiz: bug de comportamento não pode quebrar o loop de turnos.
            Logger.error(`[NpcAI] think() failed for ${npcEntityId}: ${error.message}`);
            return { acted: false, skipped: 'THINK_ERROR', reason: error.message };
        }
    }

    /**
     * Espelha a semântica de LLMAgentController._dispatchAction:
     *  - phase === 'planning' → turnSystem.queueAction(entityId, actionName, params, 'npc')
     *  - TURNS_DISABLED → fallback executeAction imediato (espelhamento do LLM)
     *  - PLANNING_CLOSED / janela fechada → descarta com log
     *  - sem tick clock (tests/mundo sem turns) → facade.executeAction imediato (fallback)
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
     * Lê o range declarado no registry de ações.
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
     * Resolve o range de uma ação usando o registry + RangeResolver.
     * @param {Object} facade
     * @param {string} actionName
     * @param {Object} entity — para resolver placeholders
     * @returns {number}
     */
    _resolveActionRange(facade, actionName, entity) {
        const rawRange = this._getRegistryRange(facade, actionName);
        if (typeof rawRange === 'number') {
            return rawRange;
        }
        if (typeof rawRange === 'string' && rawRange.startsWith(':')) {
            // Resolver placeholders via stats da entity.
            const statMap = this._buildStatMap(entity);
            return resolveRange(rawRange, statMap, DEFAULT_ATTACK_RANGE_FALLBACK);
        }
        // Se for número em string ou outro formato, tenta parse.
        const parsed = Number(rawRange);
        return isFinite(parsed) ? parsed : DEFAULT_ATTACK_RANGE_FALLBACK;
    }

    /**
     * Constrói um statMap básico a partir da entity.
     * @param {Object} entity
     * @returns {Object}
     */
    _buildStatMap(entity) {
        const statMap = {};
        const components = Array.isArray(entity.components) ? entity.components : [];
        for (const comp of components) {
            const stats = comp.stats || {};
            for (const [key, value] of Object.entries(stats)) {
                // key pode ser "Physical.strength", "Movement.move", etc.
                if (typeof value === 'number') {
                    statMap[key] = value;
                }
            }
        }
        return statMap;
    }

    /**
     * Comportamento `chase_attack`:
     * - Candidatos: TODAS as outras entities na MESMA sala.
     * - Alvo: o mais próximo (distância euclidiana).
     * - dist ≤ attackRange → ataca (droid punch por padrão).
     * - dist > attackRange → move em direção ao alvo.
     *
     * @param {Object} ctx
     * @param {Object} ctx.entity
     * @param {number} ctx.round
     * @param {Object} ctx.ai
     * @param {Object} ctx.facade
     * @param {Object} [ctx.allEntities] — opcional; fallback para facade.stateEntityController?.getAll()
     * @returns {{ actionName: string, params: Object }|null}
     */
    _chaseAttackBehavior({ entity, round, ai, facade, allEntities }) {
        const room = entity.location;
        if (!room || !entity.spatial) {
            return null;
        }

        // L2: Guard non-finite spatial na entity.
        if (!Number.isFinite(entity.spatial.x) || !Number.isFinite(entity.spatial.y)) {
            Logger.warn(`[NpcAI] ${entity.name || entity.id} has non-finite spatial — skipping.`);
            return null;
        }

        // Candidatos: TODAS as outras entities na MESMA sala.
        const all = allEntities ?? (facade.getAllEntities?.() || {});
        const candidates = Object.values(all).filter(e =>
            e && e.id !== entity.id && e.location === room && e.spatial
        );

        if (candidates.length === 0) {
            return null; // sala vazia → idle
        }

        // Alvo: o mais próximo (distância euclidiana).
        let target = candidates[0];
        let minDistance = dist(entity.spatial, candidates[0].spatial);

        for (let i = 1; i < candidates.length; i++) {
            const d = dist(entity.spatial, candidates[i].spatial);
            if (d < minDistance) {
                minDistance = d;
                target = candidates[i];
            }
        }

        // L2: Guard non-finite spatial no alvo selecionado.
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
            // Atacar: seleccionar o melhor componente para o alvo.
            const targetComponent = this._selectTargetComponent(target);
            if (!targetComponent) {
                return null;
            }
            Logger.debug(`[NpcAI] Round ${round}: ${entity.name} chases ${target.name || target.id} (dist: ${minDistance.toFixed(1)} ≤ ${attackRange}) → ${attackAction}.`);
            return { actionName: attackAction, params: { targetComponentId: targetComponent.id } };
        }

        // Perseguir: move com targetX/Y = posição do alvo.
        Logger.debug(`[NpcAI] Round ${round}: ${entity.name} chases ${target.name || target.id} (dist: ${minDistance.toFixed(1)} > ${attackRange}) → move.`);
        return {
            actionName: moveAction,
            params: { targetX: target.spatial.x, targetY: target.spatial.y }
        };
    }
    /**
     * Seleciona o melhor componente de um alvo para decisões de ataque.
     *
     * Regra de selecção (determinística):
     * 1. Preferir um componente cujos stats incluem `Physical.durability`
     *    (a chave de saúde/durabilidade que o pipeline de dano consome).
     * 2. Fallback: `components[0]` (comportamento existente).
     * 3. Se não há componentes → retorna null (o caller retorna null → skip).
     *
     * @param {Object} target — entity com `.components[]`
     * @returns {Object|null} — o componente seleccionado ou null
     * @private
     */
    _selectTargetComponent(target) {
        const components = target.components;
        if (!Array.isArray(components) || components.length === 0) {
            return null;
        }

        // Preferir componente com Physical.durability (health-equivalent stat).
        for (const comp of components) {
            const stats = comp && comp.stats;
            if (stats && typeof stats === 'object' && stats['Physical.durability'] != null) {
                return comp;
            }
        }

        // Fallback: primeiro componente (comportamento existente).
        return components[0];
    }
}

export default NpcAIController;

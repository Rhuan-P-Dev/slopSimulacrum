/**
 * TurnSystemController — State owner of the deterministic round/turn system.
 *
 * Feature A (spec §5): the world runs on a fixed round cadence of
 * TURN_ROUND_TICKS (360) ticks:
 *   - PLANNING  (local ticks [0, TURN_PLANNING_TICKS)): any entity may
 *     enqueue up to TURN_MAX_QUEUED_PER_ROUND actions via queueAction().
 *   - AGENT     (local tick TURN_NPC_AGENT_TICK): the (future) LLM agent
 *     hook is fired once per NPC entity. Until Feature C plugs an agent in,
 *     the slot is empty and the turn system runs with zero NPCs.
 *   - RESOLUTION (local tick === TURN_PLANNING_TICKS): the queued actions
 *     replay SYNCHRONOUSLY through the real ActionController.executeAction
 *     pipeline (facade.executeAction) in initiative order.
 *   - SETTLE    (local ticks [TURN_PLANNING_TICKS, TURN_ROUND_TICKS)):
 *     results are already applied; clients catch up on broadcasts.
 *
 * THE TURN SYSTEM OWNS TIMING AND ORDERING ONLY. It never validates actions
 * or applies consequences — that is entirely the job of the existing
 * action pipeline. Entries that fail validation at resolution time (range
 * closed, requirement unmet, target gone) are discarded with a log line and
 * the round continues; a single bad entry never aborts the round.
 *
 * Initiative (spec §5.2): sum of `Movement.move` across all of an entity's
 * components (read live via the facade's getComponentStats), tiebreak by
 * ascending typed entityId (lexicographic). Deterministic and stateless.
 *
 * Dependency inversion (spec §5.3/§5.8): the controller does NOT import the
 * LLM layer. The agent is injected via setNpcAgent(agentFn) where
 * agentFn(npcEntityId, round) => Promise<*> is called fire-and-forget at
 * the NPC agent tick. Feature C will plug LLMAgentController.runRound in
 * there WITHOUT touching this controller.
 *
 * Recursion note: getAll() is called from inside the facade's own
 * getAll() aggregation loop, so this controller must NEVER call
 * facade.getAll(). Entities are read via the non-recursive
 * stateEntityController.getAll() and component stats via
 * facade.getComponentStats().
 *
 * @module TurnSystemController
 */

import Logger from '../../utils/Logger.js';
import { TickJob } from '../../utils/UniversalTickSystem.js';
import { generateQueueId } from '../../utils/idGenerator.js';
import IdResolver from '../../utils/IdResolver.js';
import {
    TURN_ROUND_TICKS,
    TURN_PLANNING_TICKS,
    TURN_NPC_AGENT_TICK,
    TURN_MAX_QUEUED_PER_ROUND
} from '../../utils/Constants.js';

/** How often (in ticks) to broadcast state during the planning phase while the LLM is thinking. 10 ticks = 1.0 second at 10/s. */
const PLANNING_BROADCAST_INTERVAL = 10;

const DEFAULT_CONFIG = {
    roundTicks: TURN_ROUND_TICKS,
    planningTicks: TURN_PLANNING_TICKS,
    npcAgentTick: TURN_NPC_AGENT_TICK,
    maxQueuedPerRound: TURN_MAX_QUEUED_PER_ROUND,
    planningBroadcastInterval: PLANNING_BROADCAST_INTERVAL
};

class TurnSystemController {
    /**
     * @param {Object} [deps]
     * @param {import('../../utils/UniversalTickSystem.js').UniversalTickSystem|null} [deps.tickSystem] - The global tick system (null in tests).
     * @param {Object} [deps.config] - Optional overrides for the round geometry.
     */
    constructor({ tickSystem = null, config = {} } = {}) {
        /** @private */
        this.tickSystem = tickSystem;
        /** @private */
        this.config = { ...DEFAULT_CONFIG, ...config };

        /** @private {import('../../controllers/WorldStateController.js')|null} Injected post-construction. */
        this.worldStateController = null;
        /** @private {import('../../services/WorldStateBroadcastService.js')|null} Injected post-construction. */
        this._broadcaster = null;
        /** @private {Function|null} (npcEntityId: string, round: number) => Promise<*> */
        this._npcAgent = null;

        // Round bookkeeping (persisted via serialize()/restore()).
        /** @private {number} Last round number whose start has been processed. */
        this._lastRound = -1;
        /** @private {number} Last round whose resolution has executed. */
        this._resolvedRound = -1;
        /** @private {boolean} Whether the NPC agent tick has fired this round. */
        this._agentFiredThisRound = false;
        /** @private {number} Tick number of the last planning-phase broadcast (for continuous HUD updates). */
        this._lastPlanningBroadcastTick = -1;
        /** @private {Object<string, Array>} Queued actions: { [entityId]: [entry] }. */
        this._queues = {};
        /** @private {Array} Cached initiative ordering for the current round. */
        this._actorOrder = [];
    }

    // =========================================================================
    // DEPENDENCY INJECTION (post-construction setters)
    // =========================================================================

    /**
     * Injects the world state facade. Reads entities/stats and replays
     * queued actions through facade.executeAction().
     * @param {import('../../controllers/WorldStateController.js')} facade
     */
    setWorldStateController(facade) {
        this.worldStateController = facade;
    }

    /**
     * Injects the broadcast service (WorldStateBroadcastService or a stub).
     * @param {Object} broadcastService
     */
    setBroadcaster(broadcastService) {
        this._broadcaster = broadcastService;
    }

    /**
     * Injects the NPC agent hook (Feature C). Called fire-and-forget at
     * TURN_NPC_AGENT_TICK for each isNPC entity: agentFn(npcEntityId, round).
     * Until plugged in, the turn system runs with an empty agent slot.
     * @param {Function|null} agentFn
     */
    setNpcAgent(agentFn) {
        if (agentFn !== null && typeof agentFn !== 'function') {
            throw new TypeError('TurnSystemController.setNpcAgent: agentFn must be a function or null');
        }
        this._npcAgent = agentFn;
    }

    /**
     * Registers the tick job. No-op (with a warning) when no tickSystem was
     * provided (test mode — tests drive onTick() directly). Job order 1 so
     * it runs after internal-components (order 0): stat effects from this
     * tick are visible before initiative math.
     */
    initialize() {
        if (!this.tickSystem) {
            Logger.warn('[TurnSystem] No tickSystem provided. Turn rounds will not run automatically (driven manually).');
            return;
        }
        this.tickSystem.register(new TickJob(
            'turn-system',
            () => this.onTick(),
            1, // Interval: every tick (phase math is trivial at 10/s)
            1  // Order: after internal-components (order 0)
        ));
        Logger.info('[TurnSystem] Registered with UniversalTickSystem (round=360 ticks, planning=300, agent=20)');
    }

    // =========================================================================
    // TICK-DRIVEN STATE MACHINE (spec §5.6) — all deterministic
    // =========================================================================

    /**
     * Advances the round state machine one tick. Derives round/phase from the
     * tick clock and fires at most one transition per tick:
     *   - new round        → _roundStart(round)
     *   - L === agent tick → _npcAgentPhase(round)   (once per round)
     *   - L === planning   → phase flip + _resolveRound(round)
     * PUBLIC and side-effect-free enough that tests drive it directly after
     * setting tickSystem.currentTick.
     * @returns {void}
     */
    onTick() {
        const currentTick = this._currentTick();
        const { round, local } = this._deriveRound(currentTick);

        if (round !== this._lastRound) {
            this._roundStart(round);
            return;
        }

        if (local === this.config.npcAgentTick && !this._agentFiredThisRound) {
            this._agentFiredThisRound = true;
            this._npcAgentPhase(round);
            return;
        }

        // Periodic planning-phase broadcast: while the LLM agent is thinking
        // (agent has fired but planning window hasn't closed), emit a lightweight
        // state broadcast every PLANNING_BROADCAST_INTERVAL ticks so the client's
        // "🕒 Planning" progress bar updates in real time.
        if (local < this.config.planningTicks && this._agentFiredThisRound) {
            const interval = this.config.planningBroadcastInterval;
            if (currentTick - this._lastPlanningBroadcastTick >= interval) {
                this._lastPlanningBroadcastTick = currentTick;
                if (this._broadcaster) {
                    try {
                        this._broadcaster.broadcast();
                    } catch (err) {
                        Logger.warn(`[TurnSystem] Periodic planning broadcast failed: ${err?.message || err}`);
                    }
                }
            }
        }

        if (local === this.config.planningTicks && this._resolvedRound !== round) {
            this._resolvedRound = round;
            this._flipToResolution(round, currentTick);
            this._resolveRound(round);
        }
    }

    // =========================================================================
    // READ API
    // =========================================================================

    /**
     * The live round state, as broadcast under `state.turns` (spec §5.3 /
     * Appendix A). Defensive copy — safe for broadcast/JSON.
     * @returns {Object}
     */
    getRoundState() {
        const currentTick = this._currentTick();
        const { round, local } = this._deriveRound(currentTick);
        const phase = local < this.config.planningTicks ? 'planning' : 'resolution';

        // actorOrder is cached at round start; live queue counts are overlaid
        // so the HUD reflects enqueues without recomputing initiative.
        const queueCounts = {};
        for (const [entityId, entries] of Object.entries(this._queues)) {
            queueCounts[entityId] = entries.length;
        }
        const actorOrder = this._actorOrder.map(actor => ({
            entityId: actor.entityId,
            name: actor.name,
            initiative: actor.initiative,
            queuedCount: queueCounts[actor.entityId] || 0
        }));

        // queues: copy (the entries themselves are plain data).
        const queues = {};
        for (const [entityId, entries] of Object.entries(this._queues)) {
            queues[entityId] = entries.map(entry => ({ ...entry }));
        }

        return {
            roundNumber: round,
            phase,
            currentTick,
            planningDeadlineTick: round * this.config.roundTicks + this.config.planningTicks,
            actorOrder,
            queues
        };
    }

    /**
     * Facade aggregation hook — appears as `state.turns` in every
     * world-state-update. (NOT the same as getRoundState()'s caller context:
     * this runs inside the facade's own getAll() loop, so it must not call
     * facade.getAll() — see module header.)
     * @returns {Object}
     */
    getAll() {
        return this.getRoundState();
    }

    // =========================================================================
    // QUEUE API (players via REST, NPCs internally)
    // =========================================================================

    /**
     * Enqueues an action for the CURRENT round's resolution.
     *
     * Accepted only during the planning window of a running round, while the
     * entity exists, the action exists in the registry, and the per-entity
     * cap is not reached. No deep target validation happens at queue time —
     * range/requirement truth may change by resolution, which is exactly why
     * resolution re-runs the full pipeline (spec §5.4/§5.5).
     *
     * @param {string} entityId - Typed entity ID (ent-...).
     * @param {string} actionName - Registry action name.
     * @param {Object} [params={}] - Action params (same shape as executeAction).
     * @param {'player'|'npc'} [source='player'] - Who queued the entry.
     * @returns {Object} { success: true, queueId, queue } | { success: false, code, error }
     */
    queueAction(entityId, actionName, params = {}, source = 'player') {
        // Malformed input → caller maps to 400; here we validate shape only.
        if (!IdResolver.isEntityId(entityId)) {
            return { success: false, code: 'ENTITY_NOT_FOUND', error: `Invalid or unknown entityId: "${entityId}".` };
        }
        if (typeof actionName !== 'string' || actionName.trim() === '') {
            return { success: false, code: 'ACTION_NOT_FOUND', error: 'Invalid actionName.' };
        }
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
            return { success: false, code: 'ACTION_NOT_FOUND', error: 'params must be an object.' };
        }

        // TURNS_DISABLED: no tick clock → the round machine cannot run.
        if (!this._isRunning()) {
            return { success: false, code: 'TURNS_DISABLED', error: 'Turn system is not running (no tick system).' };
        }

        const { local } = this._deriveRound(this._currentTick());
        if (local >= this.config.planningTicks) {
            return { success: false, code: 'PLANNING_CLOSED', error: 'Planning window is closed; the round has entered resolution.' };
        }

        const facade = this.worldStateController;
        if (!facade || !facade.stateEntityController?.getEntity(entityId)) {
            return { success: false, code: 'ENTITY_NOT_FOUND', error: `Entity "${entityId}" does not exist.` };
        }

        const registry = facade.actionController?.getRegistry?.() || {};
        if (!registry[actionName]) {
            return { success: false, code: 'ACTION_NOT_FOUND', error: `Action "${actionName}" not found in the registry.` };
        }

        const existing = this._queues[entityId] || [];
        if (existing.length >= this.config.maxQueuedPerRound) {
            return { success: false, code: 'QUEUE_FULL', error: `Entity already has ${existing.length} queued action(s) this round (max ${this.config.maxQueuedPerRound}).` };
        }

        const entry = {
            queueId: generateQueueId(),
            actionName,
            params: { ...params },
            queuedAtTick: this._currentTick(),
            source: source === 'npc' ? 'npc' : 'player'
        };
        this._queues[entityId] = [...existing, entry];

        Logger.info(`[TurnSystem] Queued "${actionName}" for ${entityId} (source=${entry.source}, tick ${entry.queuedAtTick}, queueId ${entry.queueId})`);
        return { success: true, queueId: entry.queueId, queue: this._queueCopy(entityId) };
    }

    /**
     * Removes a queued entry. Only the owner entity's own entries are
     * addressable (spec §5.4 — the DELETE route passes the owner's entityId).
     * @param {string} entityId
     * @param {string} queueId
     * @returns {{ success: boolean, removed?: boolean, error?: string }}
     */
    cancelAction(entityId, queueId) {
        if (!IdResolver.isEntityId(entityId) || typeof queueId !== 'string' || !queueId.startsWith('q-')) {
            return { success: false, removed: false, error: 'Invalid entityId or queueId.' };
        }
        const entries = this._queues[entityId];
        if (!entries) {
            return { success: false, removed: false, error: 'No queued entries for this entity.' };
        }
        const index = entries.findIndex(entry => entry.queueId === queueId);
        if (index === -1) {
            return { success: false, removed: false, error: `Queue entry "${queueId}" not found for ${entityId}.` };
        }
        this._queues[entityId] = entries.filter((_, i) => i !== index);
        if (this._queues[entityId].length === 0) {
            delete this._queues[entityId];
        }
        Logger.info(`[TurnSystem] Cancelled queued entry ${queueId} for ${entityId}`);
        return { success: true, removed: true };
    }

    /**
     * Returns the entity's queued entries (defensive copies, FIFO order).
     * @param {string} entityId
     * @returns {Array}
     */
    getQueuedActions(entityId) {
        return this._queueCopy(entityId);
    }

    // =========================================================================
    // PERSISTENCE (spec §5.9) — schema v2 "turns" section
    // =========================================================================

    /**
     * Snapshot of the round bookkeeping.
     * @returns {Object} { roundNumber, phase, queues, resolvedRound, lastRound }
     */
    serialize() {
        const { round } = this._deriveRound(this._currentTick());
        const local = round !== this._lastRound
            ? 0
            : this._currentTick() - this._lastRound * this.config.roundTicks;
        return {
            roundNumber: round,
            phase: local < this.config.planningTicks ? 'planning' : 'resolution',
            queues: JSON.parse(JSON.stringify(this._queues)),
            resolvedRound: this._resolvedRound,
            lastRound: this._lastRound
        };
    }

    /**
     * Restores round bookkeeping from a snapshot. The next onTick() re-derives
     * phase from the tick clock (a restore during planning keeps the pending
     * queues; during resolution/settle the queue is already empty).
     * @param {Object} snapshot - Output of serialize().
     */
    restore(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            Logger.warn('[TurnSystem] restore() called with a malformed snapshot — resetting to idle.');
            this._reset();
            return;
        }
        this._lastRound = typeof snapshot.lastRound === 'number' ? snapshot.lastRound : -1;
        this._resolvedRound = typeof snapshot.resolvedRound === 'number' ? snapshot.resolvedRound : -1;
        this._agentFiredThisRound = false;
        this._queues = (snapshot.queues && typeof snapshot.queues === 'object')
            ? JSON.parse(JSON.stringify(snapshot.queues))
            : {};

        // Restoring MID-PLANNING of a round whose start was already processed
        // (snapshot.lastRound === current round) must NOT leave _actorOrder
        // empty: _roundStart() will not run again for that round (onTick()
        // only fires it when the round number changes), and resolution at the
        // planning deadline would filter an empty order and silently drop
        // every pending queue. Recompute the order now — same deterministic
        // function _roundStart() uses. (Defense-in-depth: _resolveRound()
        // also reconciles an empty order against live queues.)
        const queued = Object.keys(this._queues).length > 0;
        const { round, local } = this._deriveRound(this._currentTick());
        if (queued && this._lastRound === round && local < this.config.planningTicks) {
            this._actorOrder = this._computeActorOrder();
            Logger.info(`[TurnSystem] Restored mid-planning of round ${round} with ${queued} queued actor(s) — actor order recomputed (${this._actorOrder.length} actors).`);
        } else {
            this._actorOrder = []; // recomputed on next _roundStart (or _resolveRound reconciliation)
        }
        Logger.info(`[TurnSystem] Restored round bookkeeping (lastRound=${this._lastRound}, resolvedRound=${this._resolvedRound}, queues=${Object.keys(this._queues).length}).`);
    }

    // =========================================================================
    // INTERNALS
    // =========================================================================

    /**
     * Round start: clear queues, compute + cache the initiative order, reset
     * the agent flag, broadcast the transition (spec §5.6).
     * @private
     */
    _roundStart(round) {
        this._lastRound = round;
        this._agentFiredThisRound = false;
        this._lastPlanningBroadcastTick = -1;
        this._queues = {};
        this._actorOrder = this._computeActorOrder();

        Logger.info(`[TurnSystem] Round ${round} started — phase PLANNING. Actor order: ${this._actorOrder.map(a => `${a.name}(init ${a.initiative})`).join(' → ') || '(none)'}`);
        this._recordEvent(`Round ${round} started — planning phase`, 'info');
        this._broadcastTurnUpdate(round, 'planning');
    }

    /**
     * Phase flip to resolution (broadcast BEFORE executing so clients see the
     * flip on the same tick, spec §5.7).
     * @private
     */
    _flipToResolution(round, currentTick) {
        Logger.info(`[TurnSystem] Round ${round} — PLANNING CLOSED (tick ${currentTick}). Resolving queued actions in initiative order.`);
        this._recordEvent(`Round ${round} — planning closed, resolution phase`, 'info');
        this._broadcastTurnUpdate(round, 'resolution');
    }

    /**
     * NPC agent phase (spec §5.8): fire agentFn(npcEntityId, round)
     * fire-and-forget for each isNPC entity. A missing agent slot is logged
     * once per round. The agent may queueAction() for its own entity while
     * planning; if its async LLM call lands after the window closed, the
     * queue call is rejected and the NPC simply did nothing this round.
     * @private
     */
    _npcAgentPhase(round) {
        const entities = this._getEntities();
        const npcs = Object.values(entities).filter(e => e && e.isNPC === true);

        if (!this._npcAgent) {
            if (npcs.length > 0) {
                Logger.info(`[TurnSystem] Round ${round}: ${npcs.length} NPC(s) present but the agent slot is empty (no-op until Feature C plugs LLMAgentController.runRound).`);
            }
            return;
        }

        if (npcs.length === 0) {
            // Proof of life for the wiring: the hook IS active, the world just
            // has no NPC entities yet (Feature D spawns the first one).
            Logger.info(`[TurnSystem] Round ${round}: NPC agent active — 0 NPCs configured, no-op this round (waiting for Feature D).`);
            return;
        }

        for (const npc of npcs) {
            try {
                Promise.resolve(this._npcAgent(npc.id, round)).catch((err) => {
                    Logger.warn(`[TurnSystem] Round ${round}: NPC agent for ${npc.id} failed: ${err?.message || err}`);
                });
            } catch (err) {
                // agentFn threw synchronously — never break the tick loop.
                Logger.warn(`[TurnSystem] Round ${round}: NPC agent for ${npc.id} threw: ${err?.message || err}`);
            }
        }
    }

    /**
     * Resolution (spec §5.5) — synchronous, deterministic:
     *   1. Order actors with ≥1 queued action by (initiative desc, entityId asc).
     *   2. For each actor, replay each entry FIFO through the REAL pipeline
     *      (facade.executeAction). Failures are logged + discarded; the round
     *      never aborts.
     *   3. Clear all queues and broadcast the settled world.
     * @private
     */
    _resolveRound(round) {
        const facade = this.worldStateController;
        if (!facade) {
            Logger.warn(`[TurnSystem] Round ${round}: facade not injected — cannot resolve.`);
            return;
        }

        // 0.5. Grab the per-agent feedback store (Feature E) so the resolution
        // loop can record real outcomes for NPC agents.  Best-effort: missing
        // feedback controller → no-op (tests that don't wire it must not fail).
        const feedbackController = facade.llmAgentFeedbackController;

        // 0. Reconcile the cached initiative order against the live queues.
        //    Two failure modes must never drop a pending queue silently:
        //      (a) a RESTORE mid-planning that somehow lost _actorOrder
        //          (defense-in-depth for the restore() recompute);
        //      (b) an entity that joined the world AFTER _roundStart cached
        //          the order — its queueAction() succeeded (the entity
        //          existed) but it is absent from _actorOrder.
        //    Reconciliation: missing queue owners are appended with their
        //    initiative computed on the fly via the same deterministic
        //    function, then the whole order is re-sorted — deterministic,
        //    stateless, no rejection of already-accepted queues.
        const queueOwners = Object.keys(this._queues);
        if (queueOwners.length > 0) {
            const known = new Set(this._actorOrder.map(actor => actor.entityId));
            const missing = queueOwners.filter(entityId => !known.has(entityId));
            if (this._actorOrder.length === 0) {
                this._actorOrder = this._computeActorOrder();
                Logger.warn(`[TurnSystem] Round ${round}: _actorOrder was empty at resolution but ${queueOwners.length} actor(s) have queued entries — order recomputed instead of discarding the queues.`);
            } else if (missing.length > 0) {
                const entities = this._getEntities();
                for (const entityId of missing) {
                    const entity = entities[entityId];
                    if (!entity) continue; // stale queue of a despawned entity — discarded below with a log
                    this._actorOrder.push({
                        entityId: entity.id,
                        name: entity.name || entity.blueprint || entity.id,
                        initiative: this._computeInitiative(entity)
                    });
                    Logger.warn(`[TurnSystem] Round ${round}: ${entity.id} (${entity.name || entity.blueprint}) joined the round after the order was cached — appended to the resolution order (init ${this._computeInitiative(entity)}).`);
                }
                this._actorOrder.sort((a, b) => {
                    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
                    return a.entityId < b.entityId ? -1 : (a.entityId > b.entityId ? 1 : 0);
                });
            }
        }

        // 1. Actors that actually have something queued, in initiative order.
        const queuedOrder = this._actorOrder.filter(actor => (this._queues[actor.entityId] || []).length > 0);
        Logger.info(`[TurnSystem] Round ${round}: resolution order — ${queuedOrder.map((a, i) => `#${i + 1} ${a.name} (init ${a.initiative})`).join(' → ') || '(no queued actions)'}`);

        // 2. Replay through the real pipeline.
        queuedOrder.forEach((actor, actorIndex) => {
            const entries = this._queues[actor.entityId] || [];
            const entity = facade.stateEntityController.getEntity(actor.entityId);

            if (!entity) {
                const line = `${actor.name} removed before acting — ${entries.length} queued entr${entries.length === 1 ? 'y' : 'ies'} discarded`;
                Logger.warn(`[TurnSystem] Round ${round}: ${line}`);
                this._recordEvent(`Round ${round}: ${line}`, 'warn');
                delete this._queues[actor.entityId];
                return;
            }

            entries.forEach((entry, entryIndex) => {
                let result;
                try {
                    result = facade.executeAction(entry.actionName, actor.entityId, { ...entry.params });
                } catch (err) {
                    // executeAction is designed to never throw, but the round
                    // must be bulletproof regardless.
                    result = { success: false, error: err?.message || String(err) };
                }

                if (result && result.success) {
                    const line = `${actor.name} executed ${entry.actionName} (init ${actor.initiative}, order ${actorIndex + 1}, entry ${entryIndex + 1})`;
                    Logger.info(`[TurnSystem] Round ${round}: ${line}`);
                    this._recordEvent(`Round ${round}: ${line}`, 'info');
                    // Capture point A (spec §4.1): record the REAL outcome for
                    // the NPC agent's short-term memory (Feature E).
                    // Forward the reserved _instinct key from queued params into the outcome.
                    if (feedbackController && typeof feedbackController.record === 'function') {
                        try {
                            feedbackController.record(actor.entityId, {
                                round,
                                actionName: entry.actionName,
                                componentId: entry.params?.componentId ?? null,
                                targetEntityId: entry.params?.targetEntityId ?? null,
                                queued: true,
                                success: true,
                                detail: entry.actionName === 'punch' ? 'punch hit' : 'executed',
                                instinct: entry.params?._instinct ?? null,
                                atTick: this._currentTick()
                            });
                        } catch (_) { /* best-effort — must not break the round */ }
                    }
                } else {
                    const reason = result?.error || 'unknown failure';
                    const line = `${actor.name}'s ${entry.actionName} discarded: ${reason}`;
                    Logger.warn(`[TurnSystem] Round ${round}: ${line}`);
                    this._recordEvent(`Round ${round}: ${line}`, 'warn');
                    // Capture point A (failure path): record the failure outcome.
                    // Forward the reserved _instinct key from queued params into the outcome.
                    if (feedbackController && typeof feedbackController.record === 'function') {
                        try {
                            feedbackController.record(actor.entityId, {
                                round,
                                actionName: entry.actionName,
                                componentId: entry.params?.componentId ?? null,
                                targetEntityId: entry.params?.targetEntityId ?? null,
                                queued: true,
                                success: false,
                                detail: reason,
                                instinct: entry.params?._instinct ?? null,
                                atTick: this._currentTick()
                            });
                        } catch (_) { /* best-effort */ }
                    }
                }
            });
        });

        // 3. Clear all queues (including actors with zero queued entries —
        //    the key set is empty anyway) and broadcast the settled world.
        this._queues = {};
        if (this._broadcaster?.broadcast) {
            try {
                this._broadcaster.broadcast();
            } catch (err) {
                Logger.warn(`[TurnSystem] Round ${round}: post-resolution broadcast failed: ${err?.message || err}`);
            }
        }
    }

    /**
     * Computes the initiative ordering for ALL entities:
     * (initiative desc, entityId asc). Cached at round start; the live
     * queuedCount overlay happens in getRoundState().
     * @private
     */
    _computeActorOrder() {
        const entities = this._getEntities();
        return Object.values(entities)
            .filter(entity => entity && entity.id)
            .map(entity => ({
                entityId: entity.id,
                name: entity.name || entity.blueprint || entity.id,
                initiative: this._computeInitiative(entity)
            }))
            .sort((a, b) => {
                if (b.initiative !== a.initiative) return b.initiative - a.initiative;
                return a.entityId < b.entityId ? -1 : (a.entityId > b.entityId ? 1 : 0);
            });
    }

    /**
     * Initiative = sum of Movement.move across all of the entity's components
     * (spec §5.2). Read live via the facade's getComponentStats.
     * @private
     */
    _computeInitiative(entity) {
        const facade = this.worldStateController;
        if (!facade || !Array.isArray(entity.components)) return 0;
        let total = 0;
        for (const comp of entity.components) {
            const stats = facade.getComponentStats?.(comp.id);
            const move = stats?.Movement?.move;
            if (typeof move === 'number' && isFinite(move)) {
                total += move;
            }
        }
        return total;
    }

    /**
     * Defensive copy of an entity's queue.
     * @private
     */
    _queueCopy(entityId) {
        const entries = this._queues[entityId];
        if (!entries) return [];
        return entries.map(entry => ({ ...entry }));
    }

    /**
     * Records a line in the world event log (Feature B) — the "who acted in
     * what order" memory the LLM context surfaces. Best-effort: a missing
     * event log (e.g. a partial test world) must never break the round.
     * @private
     */
    _recordEvent(message, level) {
        const facade = this.worldStateController;
        const log = facade?.worldEventLogController;
        if (!log || typeof log.record !== 'function') return;
        try {
            log.record({
                tick: this._currentTick(),
                action: 'turn',
                targetId: null,
                message,
                level: level === 'warn' ? 'warn' : 'info'
            });
        } catch (err) {
            Logger.debug(`[TurnSystem] event log record failed (ignored): ${err?.message || err}`);
        }
    }

    /**
     * Emits the dedicated `turn-round-update` transition event (spec §5.7).
     * Payload excludes queues (those ride the full state) to keep the packet
     * small. Best-effort — tests inject a stub; absence is a no-op.
     * @private
     */
    _broadcastTurnUpdate(round, phase) {
        if (!this._broadcaster?.broadcastTurnUpdate) return;
        try {
            const state = this.getRoundState();
            this._broadcaster.broadcastTurnUpdate({
                roundNumber: state.roundNumber,
                phase,
                currentTick: state.currentTick,
                planningDeadlineTick: state.planningDeadlineTick,
                actorOrder: state.actorOrder
            });
        } catch (err) {
            Logger.warn(`[TurnSystem] turn-round-update broadcast failed: ${err?.message || err}`);
        }
    }

    // --- tick/round math -----------------------------------------------------

    /**
     * @private
     * @returns {number}
     */
    _currentTick() {
        return typeof this.tickSystem?.currentTick === 'number' ? this.tickSystem.currentTick : 0;
    }

    /**
     * @private
     * @returns {boolean}
     */
    _isRunning() {
        return !!(this.tickSystem && typeof this.tickSystem.currentTick === 'number');
    }

    /**
     * @private
     * @returns {{ round: number, local: number }}
     */
    _deriveRound(currentTick) {
        const round = Math.floor(currentTick / this.config.roundTicks);
        const local = currentTick - round * this.config.roundTicks;
        return { round, local };
    }

    /**
     * Non-recursive entity map ({ [entityId]: entity }). NEVER uses
     * facade.getAll() (recursion — see module header).
     * @private
     */
    _getEntities() {
        const entities = this.worldStateController?.stateEntityController?.getAll?.();
        return (entities && typeof entities === 'object') ? entities : {};
    }

    /**
     * @private
     */
    _reset() {
        this._lastRound = -1;
        this._resolvedRound = -1;
        this._agentFiredThisRound = false;
        this._lastPlanningBroadcastTick = -1;
        this._queues = {};
        this._actorOrder = [];
    }
}

export default TurnSystemController;

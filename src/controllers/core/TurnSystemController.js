/**
 * TurnSystemController — State owner of the event-driven round/turn system.
 *
 * Spec v2 (wiki/two_phase_turns_design.md): planning has NO end time. A round
 * is a REDEZVOUS, not a time span: the round number is STORED state
 * (incremented when a round starts), nothing is derived from the tick clock,
 * and the tick job owns no round geometry.
 *   - Round 0 starts LAZILY on the first tick (the roster is a snapshot of
 *     the live entities; the first tick is the earliest moment the intended
 *     roster is guaranteed to exist on every boot path — production and all
 *     test harnesses build the world and its entities before the first tick).
 *   - PLANNING: any entity may enqueue up to TURN_MAX_QUEUED_PER_ROUND
 *     actions via queueAction(). Planning closes ONLY when every round-start
 *     roster planner is complete: signaled plan-complete (signalPlanComplete,
 *     or the settlement of an agent promise the turn system fired) or removed
 *     (vacuously complete). There is NO deadline — a player who never
 *     signals delays the round indefinitely (binding product decision).
 *   - NPC planning happens at ROUND START: the agent hook fires
 *     fire-and-forget for each roster NPC; its settlement (resolve OR
 *     reject) signals plan-complete for that NPC. A synchronous agent throw
 *     settles immediately as "did nothing"; an empty agent slot auto-signals
 *     roster NPCs as vacuous plans — with no deadline to catch a hang, every
 *     NPC outcome MUST be settled (spec v2 §1.4 i/ii, §4).
 *   - RESOLUTION (same call as the close): the queued actions replay
 *     SYNCHRONOUSLY through the real ActionController.executeAction
 *     pipeline (facade.executeAction) in initiative order.
 *   - The next round starts on the tick AFTER resolution completed: the
 *     resolution phase stays observable for at least one tick (so
 *     PLANNING_CLOSED has a real, testable window) and clients see the close
 *     transition and the settled state before the next planning transition.
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
 * ROUND START for every roster NPC. Feature C plugs LLMAgentController.runRound
 * in there WITHOUT touching this controller.
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
import { TURN_MAX_QUEUED_PER_ROUND } from '../../utils/Constants.js';
import { ID_PREFIXES, isPrefixed } from '../../../shared/IdPrefixes.js';

/**
 * Purely OBSERVATIONAL threshold for the agent-settlement watchdog (M2): a
 * roster NPC whose agent promise is still unsettled this many ticks after
 * firing is reported ONCE per round with an error log. This is NOT a
 * deadline — spec v2 has no deadline of any kind and the round keeps
 * waiting; the log exists only to make a hung agent promise visible (in
 * production the LLM agent always settles via its per-call timeout budget,
 * so this is pure observability, never intervention).
 * @constant {number}
 */
const TURN_AGENT_UNSETTLED_OBSERVABILITY_THRESHOLD_TICKS = 300;

const DEFAULT_CONFIG = {
    maxQueuedPerRound: TURN_MAX_QUEUED_PER_ROUND
};

/**
 * The default `state.turns` shape (schema v3) of a fresh / idle turn system.
 * Single source of truth for the `WorldStateController.serialize()` fallback
 * (no turn system controller injected) AND for `_reset()` bookkeeping — one
 * definition, zero drift. Key-for-key identical to what serialize() emits,
 * including the barrier section (same keys as `_barrierSnapshot()`).
 * @constant {Object}
 */
export const DEFAULT_TURNS_SNAPSHOT = {
    roundNumber: 0,
    phase: 'planning',
    queues: {},
    resolvedRound: -1,
    lastRound: -1,
    barrier: {
        roster: [],
        signaled: [],
        closed: false,
        closedAtTick: null,
        closeReason: null
    }
};

class TurnSystemController {
    /**
     * @param {Object} [deps]
     * @param {import('../../utils/UniversalTickSystem.js').UniversalTickSystem|null} [deps.tickSystem] - The global tick system (null in tests).
     * @param {Object} [deps.config] - Optional overrides (currently only the per-entity queue cap).
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
        /** @private {Function|null} Turn-start hook (injected via setTurnStartHook). */
        this._turnStartHook = null;

        // Round bookkeeping (persisted via serialize()/restore()).
        /** @private {number} Last round number whose start has been processed. -1 = no round started yet (round 0 starts lazily on the first tick). */
        this._lastRound = -1;
        /** @private {number} Last round whose resolution has executed. */
        this._resolvedRound = -1;
        /** @private {Object<string, Array>} Queued actions: { [entityId]: [entry] }. */
        this._queues = {};
        /** @private {Array} Cached initiative ordering for the current round. */
        this._actorOrder = [];

        // Two-phase barrier (persisted via serialize()/restore() — design
        // spec §1.5). The roster is a round-start snapshot; the signaled set
        // accumulates plan-complete signals until the all-ready close and is
        // ALSO the record of which NPC agents have fired-and-settled (spec v2
        // §4 — v1's separate "agent fired" flag is gone).
        /** @private {'planning'|'resolution'|null} Stored phase — null before the first round start. */
        this._phase = null;
        /** @private {Set<string>} Entities present at round start (planner roster). */
        this._barrierRoster = new Set();
        /** @private {Set<string>} Roster entities that signaled plan-complete this round. */
        this._barrierSignaled = new Set();
        /** @private {boolean} Planning has closed (all-ready only in v2). */
        this._barrierClosed = false;
        /** @private {number|null} Global tick at which planning closed (plain timestamp — no geometry role). */
        this._barrierClosedAtTick = null;
        /** @private {'all-ready'|'deadline'|null} Which close rule fired. v2 only ever PRODUCES 'all-ready'; 'deadline' survives solely as a display-only value accepted from v1-era saves on restore. */
        this._barrierCloseReason = null;
        /** @private {Set<string>} Roster removals already warned about (log de-dup only — never persisted). */
        this._barrierRemovalWarned = new Set();
        /** @private {Object|null} Barrier view last emitted to clients — the baseline for the dirty-gated planning broadcast (spec v2 §2.3). */
        this._lastBroadcastBarrier = null;
        /** @private {Map<string, {firedAtTick: number, settled: boolean, warned: boolean}>} In-memory agent-settlement watch (observability only — see _checkAgentSettlementWatchdog). Never persisted; rebuilt on every round start, reset, and restore. */
        this._agentFireWatch = new Map();
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
     * ROUND START for each roster NPC: agentFn(npcEntityId, round). Until
     * plugged in, roster NPCs auto-signal as vacuous plans (spec v2 §1.4 ii)
     * so a world without a wired agent can never hang a round.
     * @param {Function|null} agentFn
     */
    setNpcAgent(agentFn) {
        if (agentFn !== null && typeof agentFn !== 'function') {
            throw new TypeError('TurnSystemController.setNpcAgent: agentFn must be a function or null');
        }
        this._npcAgent = agentFn;
    }

    /**
     * Injects the turn-start hook (the per-turn subsystem steps).
     * Called at ROUND START after barrier reset and before NPC agents fire,
     * receiving the round number that just started, so the IC turn effects
     * (and the per-turn energy-flow redistribution that follows them) are
     * visible to agent planning and initiative math.
     * @param {Function|null} fn - The hook, invoked as fn(round).
     */
    setTurnStartHook(fn) {
        if (fn !== null && typeof fn !== 'function') {
            throw new TypeError('TurnSystemController.setTurnStartHook: fn must be a function or null');
        }
        this._turnStartHook = fn;
    }

    /**
     * Registers the tick job. No-op (with a warning) when no tickSystem was
     * provided (test mode — tests drive onTick() directly). Job order 1:
     * the slot after the **retired** internal-components job is reserved —
     * the per-turn IC effects now run at ROUND START via the turn-start hook
     * (not as a tick job), so their stat effects are still visible before
     * initiative math. The job itself is geometry-free: it only starts lazy
     * rounds and sweeps the barrier (spec v2 §3).
     */
    initialize() {
        if (!this.tickSystem) {
            Logger.warn('[TurnSystem] No tickSystem provided. Turn rounds will not run automatically (driven manually).');
            return;
        }
        this.tickSystem.register(new TickJob(
            'turn-system',
            () => this.onTick(),
            1, // Interval: every tick (rounds are event-driven — the tick only observes)
            1  // Order: 1 — slot reserved after the retired internal-components job
        ));
        Logger.info('[TurnSystem] Registered with UniversalTickSystem (event-driven rounds: lazy round 0, all-ready close, next round on the tick after resolution)');
    }

    // =========================================================================
    // TICK JOB (spec v2 §3) — exactly three duties, no round geometry
    // =========================================================================

    /**
     * Advances the event-driven round machine one tick. Exactly three duties
     * (spec v2 §3):
     *   1. start round 0 when no round has started yet (lazy first tick);
     *   2. start the next round when the current round resolved (phase is
     *      resolution — close and resolution always complete in the same
     *      call, so a stored 'resolution' means "resolved, waiting");
     *   3. while planning: evaluate the roster (liveness sweep for vacuous
     *      completion + the all-ready close check), run the log-only
     *      agent-settlement watchdog, and emit the barrier-dirty full-state
     *      broadcast (at most once per tick).
     * PUBLIC and side-effect-free enough that tests drive it directly after
     * setting tickSystem.currentTick.
     * @returns {void}
     */
    onTick() {
        // Duty 1: round 0 starts lazily on the first tick (spec v2 §1.2).
        if (this._lastRound === -1) {
            this._roundStart();
            return;
        }

        // Duty 2: the next round starts on the tick AFTER resolution
        // completed (spec v2 §1.2) — the resolution phase stays observable
        // for at least one tick.
        if (this._phase === 'resolution') {
            this._roundStart();
            return;
        }

        // Duty 3: while planning — liveness sweep + settlement watchdog +
        // barrier-dirty broadcast.
        if (this._phase === 'planning') {
            this._checkBarrierAllReady(this._lastRound);
            if (this._phase === 'planning') {
                // The sweep may have just closed the round (a passing check
                // acts); the close already emitted its transition and
                // post-resolution state, so skip the watchdog and the dirty
                // broadcast.
                this._checkAgentSettlementWatchdog(this._lastRound);
                this._maybeBroadcastBarrierChange();
            }
        }
    }

    // =========================================================================
    // READ API
    // =========================================================================

    /**
     * The live round state, as broadcast under `state.turns`. Carries EXACTLY
     * these keys (spec v2 §2.3): `actorOrder`, `barrier`, `currentTick`,
     * `phase`, `queues`, `roundNumber`. `roundNumber` is stored state (no
     * tick derivation); `planningDeadlineTick` was removed with the deadline.
     * Defensive copy — safe for broadcast/JSON.
     * @returns {Object}
     */
    getRoundState() {
        const currentTick = this._currentTick();
        const phase = this._currentPhase();

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
            roundNumber: this._currentRound(),
            phase,
            currentTick,
            actorOrder,
            queues,
            barrier: this._barrierView()
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
     * Accepted only during the planning phase of a running round, while the
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

        // PLANNING_CLOSED: the gate reads the STORED phase (not raw tick
        // math). The rejection window runs from the all-ready close tick
        // until the next round starts on the next tick (spec v2 §6) — a real,
        // observable window. All other codes are unchanged.
        if (this._currentPhase() !== 'planning') {
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
        if (!IdResolver.isEntityId(entityId) || !isPrefixed(queueId, ID_PREFIXES.QUEUE)) {
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
    // BARRIER API (two-phase turns — design spec §1.5/§2.4)
    // =========================================================================

    /**
     * Signals plan-complete for one entity of the CURRENT round's barrier
     * roster. Resolution starts ONLY when every roster entity has signaled
     * (all-ready, or vacuously via removal) — there is no second trigger and
     * no deadline (spec v2 §1.1; binding decision 2: a player who never
     * signals delays the round indefinitely).
     *
     * Idempotent: signaling an already-signaled entity is a safe no-op that
     * returns `alreadySignaled: true`, changes no state, and can never
     * trigger a second close — repeated calls from a flaky client are
     * harmless. If the signal completes the roster, planning closes (reason
     * all-ready) and resolution runs synchronously in this same call.
     *
     * @param {string} entityId - Typed entity ID (ent-...).
     * @param {'player'|'npc-agent'} [source='player'] - Who signaled.
     * @returns {Object}
     *   Success: { success: true, alreadySignaled: boolean, closed: boolean, barrier: Object }
     *   Failure: { success: false, code: 'TURNS_DISABLED'|'ENTITY_NOT_FOUND'|'OUT_OF_ROUND', error: string }
     *     TURNS_DISABLED — no tick clock (the round machine cannot run);
     *     ENTITY_NOT_FOUND — malformed ID or absent entity;
     *     OUT_OF_ROUND — the entity exists but is not in this round's roster
     *     (a mid-round spawn; its plan does not gate this round).
     */
    signalPlanComplete(entityId, source = 'player') {
        if (!IdResolver.isEntityId(entityId)) {
            return { success: false, code: 'ENTITY_NOT_FOUND', error: `Invalid or unknown entityId: "${entityId}".` };
        }
        if (!this._isRunning()) {
            return { success: false, code: 'TURNS_DISABLED', error: 'Turn system is not running (no tick system).' };
        }
        const facade = this.worldStateController;
        if (!facade || !facade.stateEntityController?.getEntity(entityId)) {
            return { success: false, code: 'ENTITY_NOT_FOUND', error: `Entity "${entityId}" does not exist.` };
        }
        if (!this._barrierRoster.has(entityId)) {
            return { success: false, code: 'OUT_OF_ROUND', error: `Entity "${entityId}" is not in the current round's planner roster (a mid-round spawn — its plan does not gate this round).` };
        }

        const alreadySignaled = this._applyPlanCompleteSignal(entityId, source);

        return {
            success: true,
            alreadySignaled,
            closed: this._barrierClosed,
            barrier: this._barrierView()
        };
    }

    // =========================================================================
    // PERSISTENCE (spec §5.9 + design spec §8) — schema STAYS v3
    // =========================================================================

    /**
     * Snapshot of the round bookkeeping, including the barrier. Schema v3 is
     * unchanged by spec v2 (spec v2 §8: nothing v2 removed was ever
     * persisted).
     * @returns {Object} { roundNumber, phase, queues, resolvedRound, lastRound, barrier }
     */
    serialize() {
        return {
            roundNumber: this._currentRound(),
            phase: this._currentPhase(),
            queues: JSON.parse(JSON.stringify(this._queues)),
            resolvedRound: this._resolvedRound,
            lastRound: this._lastRound,
            barrier: this._barrierSnapshot()
        };
    }

    /**
     * Restores round bookkeeping from a snapshot (schema v3, spec v2 §8).
     * Restore semantics:
     *   - mid-planning (stored phase 'planning'): the barrier RESUMES — the
     *     roster/signaled sets are rebuilt from the snapshot, the remaining
     *     signals still close the round, and the agent is RE-FIRED for every
     *     roster NPC that still exists and is not in the signaled set (the
     *     in-flight promise was lost with the process and there is no
     *     deadline to catch the resulting hang — spec v2 §4).
     *   - at/after close (stored phase 'resolution'): resolution never
     *     re-runs (existing guard); the barrier is restored as closed for
     *     display; the next onTick() starts the next round as usual.
     *   - malformed/absent barrier section inside an otherwise valid v3
     *     snapshot: warn + defaults (empty roster, not closed) — graceful
     *     degradation, matching the existing restore style.
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
        this._queues = (snapshot.queues && typeof snapshot.queues === 'object')
            ? JSON.parse(JSON.stringify(snapshot.queues))
            : {};

        this._phase = this._validateRestorePhase(snapshot.phase);
        // Fail-safe (M1): a null/invalid phase WITH round history means the
        // snapshot is untrustworthy — the live round machine can never reach
        // "stored phase null but lastRound >= 0", so without this guard the
        // controller would be left silently wedged (lazy round 0 never fires
        // because _lastRound !== -1, yet no round is in flight).
        if (this._phase === null && this._lastRound >= 0) {
            Logger.error('TurnSystemController.restore: malformed persisted turn state (phase absent but round history present). Resetting to idle.');
            this._reset();
            return;
        }
        this._restoreBarrier(snapshot);
        // The agent fires that produced any watch entries died with the
        // pre-restore process: start from a clean watch so the restored
        // round only ever reports fires that actually happen post-restore
        // (the re-fire below re-records what it fires).
        this._agentFireWatch = new Map();

        const queued = Object.keys(this._queues).length;
        const snapshotRound = typeof snapshot.roundNumber === 'number' ? snapshot.roundNumber : -1;
        this._prepareActorOrderForRestore(queued, snapshotRound);
        this._refireAgentsAfterRestore();
        Logger.info(`[TurnSystem] Restored round bookkeeping (lastRound=${this._lastRound}, resolvedRound=${this._resolvedRound}, queues=${Object.keys(this._queues).length}).`);
    }

    // =========================================================================
    // INTERNALS
    // =========================================================================

    /**
     * Round start (spec v2 §1.2) — a thin orchestrator over four single-
     * purpose routines: round bookkeeping (round counter, queues, initiative
     * actor order), the barrier reset (fresh roster snapshot + planning
     * state), the round-start agent firing (§4), and — unless the barrier
     * closed synchronously during agent firing — the `turn-round-update`
     * transition (clients re-arm their ready button).
     * @private
     */
    _roundStart() {
        const round = this._beginRoundBookkeeping();
        this._resetBarrierForNewRound();
        // Turn-driven IC effects fire at ROUND START, before agents plan
        // (spec: wiki/turn_driven_ic_and_flow_spec.md). Guarded: a hook failure
        // must never break the round machine.
        if (this._turnStartHook) {
            try {
                this._turnStartHook(round);
            } catch (err) {
                Logger.warn(`[TurnSystem] Round ${round}: turn-start hook failed: ` + (err && err.message ? err.message : err));
            }
        }
        // Agents fire at ROUND START (spec v2 §4): the agent is the slowest
        // planner (an LLM call takes seconds), so its plan starts the moment
        // the round opens. Synchronous outcomes (empty slot, sync throw)
        // settle inside this call and may close the round before we return.
        this._fireNpcAgents(round);
        this._emitRoundStartTransition(round);
    }

    /**
     * Round bookkeeping for a round start (spec v2 §1.2): the round number
     * is STORED state — incremented here, never derived from the tick clock
     * — and the queues + initiative actor order are re-established for the
     * fresh round.
     * @private
     * @returns {number} The round number that just started.
     */
    _beginRoundBookkeeping() {
        // The round number is stored state, incremented at round start
        // (spec v2 §1.2): nothing derives it from the tick clock.
        const round = this._lastRound + 1;
        this._lastRound = round;
        this._queues = {};
        this._actorOrder = this._computeActorOrder();
        return round;
    }

    /**
     * Resets the barrier to a fresh planning state for a new round (spec v2
     * §1.2/§1.3): the roster is a SNAPSHOT of every entity present at round
     * start (the same entity read the actor-order computation performs). A
     * snapshot — not a live set — because the turn system must not subscribe
     * to spawn/despawn: removals are vacuously complete and mid-round spawns
     * never gate the round (spec v2 §1.3). Every roster member is a planner,
     * regardless of kind: NPCs auto-signal on agent-promise settlement (or
     * vacuously when the agent slot is empty), others signal via the ready
     * route.
     * @private
     * @returns {void}
     */
    _resetBarrierForNewRound() {
        this._barrierRoster = new Set(this._actorOrder.map(actor => actor.entityId));
        this._barrierSignaled = new Set();
        this._barrierClosed = false;
        this._barrierClosedAtTick = null;
        this._barrierCloseReason = null;
        this._barrierRemovalWarned = new Set();
        this._phase = 'planning';
        this._lastBroadcastBarrier = null;
        // The in-memory agent-settlement watch is rebuilt from the fresh
        // round's fires (M2 observability state — never persisted).
        this._agentFireWatch = new Map();
    }

    /**
     * Emits the round-start `turn-round-update` transition (spec v2 §1.2) —
     * UNLESS the barrier already closed synchronously during agent firing:
     * in that case the close emitted its own transition and post-resolution
     * state, and a planning transition would arrive out of order, so only a
     * log line is recorded.
     * @private
     * @param {number} round - The round being started.
     * @returns {void}
     */
    _emitRoundStartTransition(round) {
        if (this._phase === 'planning') {
            Logger.info(`[TurnSystem] Round ${round} started — phase PLANNING. Actor order: ${this._actorOrder.map(a => `${a.name}(init ${a.initiative})`).join(' → ') || '(none)'}. Barrier roster: ${this._barrierRoster.size} planner(s).`);
            this._recordEvent(`Round ${round} started — planning phase`, 'info');
            this._broadcastTurnUpdate(round, 'planning');
            // Baseline for the dirty-gated planning broadcast (spec v2 §2.3):
            // remember exactly what the clients just saw in the planning
            // transition, so the first dirty broadcast fires only on a real
            // change.
            this._lastBroadcastBarrier = this._barrierView();
        } else {
            // The barrier closed all-ready DURING agent firing at round start
            // (e.g. an all-NPC roster with an empty agent slot, or a
            // synchronous agent throw on a single-planner roster): the close
            // already emitted its transition and post-resolution state, so
            // emitting a planning transition now would arrive out of order.
            Logger.info(`[TurnSystem] Round ${round} closed all-ready during agent firing at round start — the close transition already announced the phase flip; no planning transition emitted.`);
        }
    }

    /**
     * Phase flip to resolution (broadcast BEFORE executing so clients see the
     * flip on the same tick, spec §5.7). Carries which close rule fired so
     * the log/event lines can state it. In v2 only 'all-ready' is produced
     * (the legacy 'deadline' value can appear only in restored v1-era state,
     * display-only).
     * @private
     */
    _flipToResolution(round, currentTick, closeReason = null) {
        Logger.info(`[TurnSystem] Round ${round} — PLANNING CLOSED (reason: ${closeReason ?? 'unknown'}, tick ${currentTick}). Resolving queued actions in initiative order.`);
        this._recordEvent(`Round ${round} — planning closed (${closeReason ?? 'unknown'}), resolution phase`, 'info');
        this._broadcastTurnUpdate(round, 'resolution');
    }

    /**
     * Fires the NPC agents for the round (spec v2 §4), called at ROUND START.
     * For each roster NPC:
     *   - agent slot empty  → the NPC auto-signals as a VACUOUS plan (one
     *     info log each) — a world without a wired agent must never hang a
     *     round (spec v2 §1.4 ii; v1 only logged here, which would hang in v2);
     *   - agent wired       → fire-and-forget with the settlement hook.
     * A roster with no NPC entities is a logged no-op.
     * @private
     * @param {number} round - The round being started.
     */
    _fireNpcAgents(round) {
        const entities = this._getEntities();
        const npcs = [...this._barrierRoster]
            .map(entityId => entities[entityId])
            .filter(entity => entity && entity.isNPC === true);

        if (npcs.length === 0) {
            // Proof of life for the wiring: the hook IS active, the roster
            // just has no NPC entities.
            if (this._npcAgent) {
                Logger.info(`[TurnSystem] Round ${round}: NPC agent active — 0 roster NPCs, no agent calls this round.`);
            }
            return;
        }

        if (!this._npcAgent) {
            for (const npc of npcs) {
                Logger.info(`[TurnSystem] Round ${round}: roster NPC ${npc.id} auto-signaled as a vacuous plan (agent slot empty).`);
                this.signalPlanComplete(npc.id, 'npc-agent');
            }
            return;
        }

        for (const npc of npcs) {
            this._fireNpcAgent(npc.id, round);
        }
    }

    /**
     * Fire-and-forget one NPC agent (spec v2 §4):
     *   - the promise's settlement (resolve OR reject) signals the barrier
     *     plan-complete for that NPC via the round-keyed settlement hook;
     *   - a SYNCHRONOUS agentFn throw is settled immediately as "did nothing"
     *     (warn + signal) — mandatory in v2, because with no deadline a
     *     thrown agent would otherwise hang the round forever (spec v2 §1.4 i).
     * @private
     * @param {string} npcEntityId
     * @param {number} round
     */
    _fireNpcAgent(npcEntityId, round) {
        try {
            // The round key is captured at fire time so a very late
            // settlement can be dropped instead of polluting a later round's
            // barrier (spec v2 §1.6).
            const promise = Promise.resolve(this._npcAgent(npcEntityId, round));
            promise.then(
                () => {
                    this._signalAgentSettled(npcEntityId, round);
                    this._markAgentSettled(npcEntityId);
                },
                (err) => {
                    Logger.warn(`[TurnSystem] Round ${round}: NPC agent for ${npcEntityId} failed: ${err?.message || err}`);
                    this._signalAgentSettled(npcEntityId, round);
                    this._markAgentSettled(npcEntityId);
                }
            );
            // Observability watch (M2): record the fire-and-forget so a
            // promise that NEVER settles becomes visible in the logs. The
            // watchdog is log-only — it never signals, never closes the
            // round, and never bounds the wait.
            this._agentFireWatch.set(npcEntityId, { firedAtTick: this._currentTick(), settled: false, warned: false });
        } catch (err) {
            // agentFn threw synchronously — never break the tick loop, and the
            // planner must not be left un-signaled (no deadline to catch it).
            Logger.warn(`[TurnSystem] Round ${round}: NPC agent for ${npcEntityId} threw — settling as "did nothing": ${err?.message || err}`);
            this.signalPlanComplete(npcEntityId, 'npc-agent');
            this._markAgentSettled(npcEntityId); // defensive: a sync throw never created a watch entry
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

    // --- two-phase barrier (spec v2 §1-§2) -------------------------------

    /**
     * Stored phase read for the public API: the phase is STORED state — close
     * is event-driven (all-ready) and can no longer be derived from the tick
     * clock (spec v2 §2.1). Before the first round start the stored phase is
     * null and public reads map it to 'planning'. The public phase vocabulary
     * is exactly {'planning', 'resolution'} (no third phase).
     * @private
     * @returns {'planning'|'resolution'}
     */
    _currentPhase() {
        return this._phase === 'resolution' ? 'resolution' : 'planning';
    }

    /**
     * The round number as stored state (spec v2 §1.2): the last round whose
     * start has been processed, or 0 before the first round starts.
     * @private
     * @returns {number}
     */
    _currentRound() {
        return this._lastRound >= 0 ? this._lastRound : 0;
    }

    /**
     * Live barrier view for getRoundState/getAll and signal responses
     * (spec v2 §2.3). Liveness is checked per roster member via the O(1)
     * facade getEntity() — a removed planner is counted as vacuously complete
     * and never appears in pendingEntityIds.
     * @private
     */
    _barrierView() {
        const facade = this.worldStateController;
        let readyCount = 0;
        const pendingEntityIds = [];
        for (const entityId of this._barrierRoster) {
            const signaled = this._barrierSignaled.has(entityId);
            const exists = !!facade?.stateEntityController?.getEntity(entityId);
            if (signaled || !exists) {
                readyCount += 1;
            } else {
                pendingEntityIds.push(entityId);
            }
        }
        return {
            closed: this._barrierClosed,
            closedAtTick: this._barrierClosedAtTick,
            closeReason: this._barrierCloseReason,
            readyCount,
            pendingCount: pendingEntityIds.length,
            pendingEntityIds
        };
    }

    /**
     * Persistent shape of the barrier (serialize/restore, spec v2 §8):
     * the full roster + signaled sets plus the close info.
     * @private
     */
    _barrierSnapshot() {
        return {
            roster: [...this._barrierRoster],
            signaled: [...this._barrierSignaled],
            closed: this._barrierClosed,
            closedAtTick: this._barrierClosedAtTick,
            closeReason: this._barrierCloseReason
        };
    }

    /**
     * All-ready check — THE ONLY close trigger in v2: there is no deadline
     * (spec v2 §1.1, binding decision 2). Every roster member is either
     * signaled or no longer present in the world. A removed planner is
     * vacuously complete (one warn per removal, de-duped in memory only);
     * when the check passes it closes the round NOW via the shared close
     * routine — a passing check never merely reports, it acts.
     * @private
     * @returns {boolean} true when this call closed the round all-ready.
     */
    _checkBarrierAllReady(round) {
        if (this._barrierClosed || this._phase !== 'planning') return false;
        const facade = this.worldStateController;
        for (const entityId of this._barrierRoster) {
            if (this._barrierSignaled.has(entityId)) continue;
            const exists = !!facade?.stateEntityController?.getEntity(entityId);
            if (exists) return false; // at least one planner has not signaled yet
            if (!this._barrierRemovalWarned.has(entityId)) {
                this._barrierRemovalWarned.add(entityId);
                Logger.warn(`[TurnSystem] Round ${round}: roster entity ${entityId} was removed during planning — counted as vacuously complete.`);
            }
        }
        this._closePlanning(round, 'all-ready');
        return true;
    }

    /**
     * Observability-only watchdog for never-settling agent promises (M2).
     * Spec v2 has NO deadline — a round waits forever until every roster
     * planner signals — so a promise that never settles is the sole
     * remaining hang vector, and the only sanctioned reaction to it is a
     * LOG: once per round per entity, when an un-signaled roster NPC's agent
     * promise has been unsettled for more than
     * TURN_AGENT_UNSETTLED_OBSERVABILITY_THRESHOLD_TICKS ticks, this emits
     * one Logger.error naming the entity, the round, and the ticks
     * unsettled. It MUST NOT (and does not) signal, close, or time-bound the
     * round — in production the LLM agent always settles via its per-call
     * timeout budget, so this is pure observability, never intervention.
     * @private
     * @param {number} round - The round being watched (for the log line).
     * @returns {void}
     */
    _checkAgentSettlementWatchdog(round) {
        const currentTick = this._currentTick();
        for (const [entityId, entry] of this._agentFireWatch) {
            if (!this._barrierRoster.has(entityId)) continue; // not this round's roster
            if (this._barrierSignaled.has(entityId)) continue; // signaled (settled or vacuous)
            if (entry.settled) continue;
            const ticksUnsettled = currentTick - entry.firedAtTick;
            if (ticksUnsettled <= TURN_AGENT_UNSETTLED_OBSERVABILITY_THRESHOLD_TICKS) continue;
            if (entry.warned) continue;
            entry.warned = true;
            Logger.error(`[TurnSystem] Round ${round}: NPC agent for ${entityId} fired at tick ${entry.firedAtTick} and is still unsettled after ${ticksUnsettled} ticks — the round keeps waiting (observability only; no deadline exists in spec v2).`);
        }
    }

    /**
     * The single shared close routine (spec v2 §1.1/§2.2): store the close
     * info, set the stored phase to resolution, broadcast the transition,
     * then resolve — all in the same tick/call. The _resolvedRound guard
     * keeps resolution at-most-once per round no matter which trigger
     * arrives (a signal, or the tick liveness sweep — the only two paths
     * into this routine in v2).
     * @private
     */
    _closePlanning(round, reason) {
        if (this._resolvedRound === round) return;
        this._resolvedRound = round;
        this._barrierClosed = true;
        this._barrierClosedAtTick = this._currentTick();
        this._barrierCloseReason = reason;
        this._phase = 'resolution';
        this._flipToResolution(round, this._currentTick(), reason);
        this._resolveRound(round);
    }

    /**
     * Barrier-dirty planning broadcast (spec v2 §2.3): while planning, a
     * full-state broadcast is emitted at most once per tick and ONLY when
     * the barrier view (closed flag, ready count, pending-ID set) changed
     * since the last emission. WHY keep any broadcast at all: ready signals
     * are point-to-point REST responses — a client that clicked nothing
     * itself learns "one fewer planner is pending" only through a
     * full-state broadcast. WHY dirty-gated: with unlimited planning a quiet
     * phase can last minutes, and an unconditional periodic broadcast would
     * cost full states forever for zero change; the gate costs nothing in an
     * idle phase and makes any signal visible to every client within one
     * tick (≈33 ms at 30 tps).
     * @private
     * @returns {void}
     */
    _maybeBroadcastBarrierChange() {
        const view = this._barrierView();
        const last = this._lastBroadcastBarrier;
        const changed = !last
            || last.closed !== view.closed
            || last.readyCount !== view.readyCount
            || last.pendingEntityIds.length !== view.pendingEntityIds.length
            || view.pendingEntityIds.some((id, i) => last.pendingEntityIds[i] !== id);
        if (!changed) return;
        this._lastBroadcastBarrier = view;
        if (this._broadcaster?.broadcast) {
            try {
                this._broadcaster.broadcast();
            } catch (err) {
                Logger.warn(`[TurnSystem] Barrier-change broadcast failed: ${err?.message || err}`);
            }
        }
    }

    /**
     * Restores the actor-order bookkeeping for a mid-planning restore (the
     * actor-order recompute guard). v2 condition (spec v2 §2.4): queued > 0
     * AND the snapshot's round matches the stored lastRound AND the stored
     * phase is planning. In that case _roundStart() will NOT run again for
     * this round (rounds are stored state, not tick-derived), so the order
     * must be recomputed now — same deterministic function _roundStart()
     * uses — or resolution would filter an empty order and silently drop
     * every pending queue. (Defense-in-depth: _resolveRound() also
     * reconciles an empty order against live queues.)
     * @private
     * @param {number} queuedCount - Number of entities with queued entries.
     * @param {number} snapshotRound - Round number carried by the snapshot.
     * @returns {void}
     */
    _prepareActorOrderForRestore(queuedCount, snapshotRound) {
        if (queuedCount > 0 && snapshotRound === this._lastRound && this._phase === 'planning') {
            this._actorOrder = this._computeActorOrder();
            Logger.info(`[TurnSystem] Restored mid-planning of round ${this._lastRound} with ${queuedCount} queued actor(s) — actor order recomputed (${this._actorOrder.length} actors).`);
        } else {
            this._actorOrder = []; // recomputed on next _roundStart (or _resolveRound reconciliation)
        }
    }

    /**
     * Re-fires the agent after a mid-planning restore (spec v2 §4): restore
     * loses any in-flight agent promise with the process, and an un-signaled
     * roster NPC would otherwise wait forever (there is no deadline to catch
     * it). Re-fire for every roster NPC that still exists and is not in the
     * restored signaled set (the signaled set is the record of who has
     * fired-and-settled). When the agent slot is EMPTY, an un-signaled roster
     * NPC is instead auto-signaled as a vacuous plan — the round-start
     * empty-slot rule (spec v2 §1.4 ii) applies to restore as well, so a
     * restore can never leave a roster signal outstanding. A restore with
     * stored phase 'resolution' re-fires nothing (the window is closed).
     * @private
     * @returns {void}
     */
    _refireAgentsAfterRestore() {
        if (this._phase !== 'planning') return;
        const entities = this._getEntities();
        for (const entityId of this._barrierRoster) {
            if (this._barrierSignaled.has(entityId)) continue;
            const entity = entities[entityId];
            if (!entity || entity.isNPC !== true) continue;
            if (!this._npcAgent) {
                // An empty agent slot must not leave the roster signal
                // outstanding after a restore either (L1): settle the plan
                // vacuously, exactly as round start does.
                Logger.info(`TurnSystemController._refireAgentsAfterRestore: ${entityId} auto-signaled as a vacuous plan (agent slot empty).`);
                this.signalPlanComplete(entityId, 'npc-agent');
                continue;
            }
            Logger.warn(`[TurnSystem] Restored mid-planning of round ${this._lastRound}: roster NPC ${entityId} had not settled its agent plan — re-firing the agent (the in-flight promise was lost with the process).`);
            this._fireNpcAgent(entityId, this._lastRound);
        }
    }

    /**
     * Validates the stored phase of a restore snapshot (two-phase barrier):
     * restores what the snapshot stored; a missing/invalid value falls back
     * to null (public reads map null to 'planning').
     * @private
     * @param {*} phase - Raw snapshot.phase value.
     * @returns {'planning'|'resolution'|null}
     */
    _validateRestorePhase(phase) {
        return (phase === 'planning' || phase === 'resolution')
            ? phase
            : null;
    }

    /**
     * Restores the barrier section of a v3 snapshot (spec v2 §8). Sets are
     * rebuilt as arrays → Set; every field is type-checked so a corrupted
     * section degrades to defaults instead of poisoning the round machine.
     * A keyless `{}` carries no barrier information and is treated as
     * malformed (warn + defaults). closeReason accepts 'all-ready' AND the
     * legacy 'deadline' — a v1-era v3 save may carry it; it is display-only
     * in v2 and is never produced.
     * @private
     * @param {Object} snapshot - v3 "turns" section of a serialize() output.
     * @returns {void}
     */
    _restoreBarrier(snapshot) {
        const barrier = (snapshot.barrier && typeof snapshot.barrier === 'object' && Object.keys(snapshot.barrier).length > 0) ? snapshot.barrier : null;
        if (!barrier) {
            Logger.warn('[TurnSystem] Snapshot has no valid "barrier" section — restoring an empty (not closed) barrier.');
            this._barrierRoster = new Set();
            this._barrierSignaled = new Set();
            this._barrierClosed = false;
            this._barrierClosedAtTick = null;
            this._barrierCloseReason = null;
        } else {
            this._barrierRoster = new Set(
                Array.isArray(barrier.roster) ? barrier.roster.filter(id => typeof id === 'string') : []
            );
            this._barrierSignaled = new Set(
                Array.isArray(barrier.signaled) ? barrier.signaled.filter(id => typeof id === 'string') : []
            );
            this._barrierClosed = barrier.closed === true;
            this._barrierClosedAtTick = typeof barrier.closedAtTick === 'number' ? barrier.closedAtTick : null;
            this._barrierCloseReason = (barrier.closeReason === 'all-ready' || barrier.closeReason === 'deadline')
                ? barrier.closeReason
                : null;
        }
        this._barrierRemovalWarned = new Set();
    }

    /**
     * Applies one plan-complete signal (spec v2 §1.6): adds the entity to the
     * signaled set (idempotent), and for a new signal on an open barrier
     * evaluates all-ready — if the signal completed the roster, close +
     * resolve happen in the same call.
     * @private
     * @param {string} entityId - Typed entity ID (ent-...).
     * @param {'player'|'npc-agent'} source - Who signaled.
     * @returns {boolean} true when the entity had already signaled (no-op).
     */
    _applyPlanCompleteSignal(entityId, source) {
        const alreadySignaled = this._barrierSignaled.has(entityId);
        if (!alreadySignaled) {
            this._barrierSignaled.add(entityId);
            Logger.info(`[TurnSystem] Plan-complete signaled for ${entityId} (source=${source === 'npc-agent' ? 'npc-agent' : 'player'}); barrier ${this._barrierSignaled.size}/${this._barrierRoster.size}.`);
        }

        if (!alreadySignaled && !this._barrierClosed) {
            // Close evaluation after any signal (spec v2 §1.6): if this
            // signal completed the roster, close + resolve in the same call.
            // The round is stored state (this._lastRound — never tick-derived).
            this._checkBarrierAllReady(this._lastRound);
        }
        return alreadySignaled;
    }

    /**
     * Agent-promise settlement hook (spec v2 §1.6): called when an NPC agent's
     * promise settles (resolve OR reject). The round key captured at fire
     * time guards late cross-round settlements (the round closed all-ready
     * while an LLM call was still in flight) — they are dropped with a warn
     * and must not pollute a later round's barrier. Otherwise it delegates to
     * the public signalPlanComplete() so idempotency and close logic live in
     * one place.
     * @private
     */
    _signalAgentSettled(npcEntityId, firedRound) {
        if (this._lastRound !== firedRound) {
            Logger.warn(`[TurnSystem] Round ${firedRound}: NPC agent for ${npcEntityId} settled after the round advanced to ${this._lastRound} — plan-complete signal ignored.`);
            return;
        }
        this.signalPlanComplete(npcEntityId, 'npc-agent');
    }
    /**
     * Marks a fired agent's watch entry as settled (M2 observability): all
     * settlement outcomes — resolve, reject, and the synchronous-throw "did
     * nothing" path — converge here. Guarded: a sync throw never created a
     * watch entry, and a cleared watch (round start / reset / restore) has
     * none.
     * @private
     * @param {string} npcEntityId
     * @returns {void}
     */
    _markAgentSettled(npcEntityId) {
        const entry = this._agentFireWatch.get(npcEntityId);
        if (entry) entry.settled = true;
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
     * Payload (spec v2 §2.3) carries the round state minus queues (those
     * ride the full state) to keep the packet small: `roundNumber`, `phase`,
     * `currentTick`, `actorOrder`, `barrier`. The additive `barrier` object
     * IS included so clients render the ready status without a full-state
     * round-trip. Best-effort — tests inject a stub; absence is a no-op.
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
                actorOrder: state.actorOrder,
                barrier: state.barrier
            });
        } catch (err) {
            Logger.warn(`[TurnSystem] turn-round-update broadcast failed: ${err?.message || err}`);
        }
    }

    // --- tick bookkeeping ---------------------------------------------------

    /**
     * Reads the tick clock for bookkeeping (round state, queue and watchdog
     * timestamps). The v2 machine is event-driven, so the tick only
     * observes — but a corrupt clock (e.g. NaN from a stale test driver)
     * must never masquerade as a valid tick: non-finite values are
     * rejected with a warn (raw value included) and the existing fallback
     * (0) is returned. A missing clock (manual-drive worlds) stays the
     * silent 0 of before.
     * @private
     * @returns {number}
     */
    _currentTick() {
        const raw = this.tickSystem?.currentTick;
        if (typeof raw === 'number') {
            if (Number.isFinite(raw)) return raw;
            Logger.warn(`[TurnSystem] non-finite tick clock (raw: ${String(raw)}) — using fallback 0`);
            return 0;
        }
        return 0;
    }

    /**
     * @private
     * @returns {boolean}
     */
    _isRunning() {
        return !!(this.tickSystem && typeof this.tickSystem.currentTick === 'number');
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
        const def = DEFAULT_TURNS_SNAPSHOT;
        this._lastRound = def.lastRound;
        this._resolvedRound = def.resolvedRound;
        this._queues = { ...def.queues };
        this._actorOrder = [];
        // _phase intentionally stays null (NOT def.phase): null keeps the
        // public phase mapped to 'planning' before the first round start and
        // keeps onTick() duty 1 (lazy round 0) armed.
        this._phase = null;
        this._barrierRoster = new Set(def.barrier.roster);
        this._barrierSignaled = new Set(def.barrier.signaled);
        this._barrierClosed = def.barrier.closed;
        this._barrierClosedAtTick = def.barrier.closedAtTick;
        this._barrierCloseReason = def.barrier.closeReason;
        this._barrierRemovalWarned = new Set();
        this._lastBroadcastBarrier = null;
        this._agentFireWatch = new Map();
    }
}

export default TurnSystemController;

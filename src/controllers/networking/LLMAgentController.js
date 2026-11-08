/**
 * LLMAgentController — the LLM "agent" that lets NPCs act on the world.
 *
 * Feature C (spec §6.3): the model proposes, the world disposes. This
 * controller orchestrates ONE agent round per NPC per turn round:
 *   1. guard (entity exists + isNPC) — graceful 'NPC_GONE' otherwise;
 *   2. build the world context via LlmContextController (Feature B);
 *   3. call LLMController.chatFull with the generated tool set
 *      (execute_action + toApproach, plus speak_in_room when chat is enabled,
 *      use_instinct when instincts exist, craft/get_crafts when the NPC
 *      has a recipe registry, and equip_item / unequip_item for what it carries
 *      and wears, plus move_item to shift it between its own components),
 *      tool_choice "auto", and a
 *      per-NPC system prompt — PROTOCOL B: the native tool call is the ONLY
 *      output protocol (no JSON-in-content; the dual mode that briefly ran
 *      here is what produced the scaffold-loop incident, spec §6.4);
 *   4. PRE-VALIDATE every proposed tool call — actionName against the data
 *      registry, typed-ID hygiene via IdResolver, capability gate via the
 *      live canExecute cache — and force the acting entity to the NPC's own
 *      server-injected entityId (the model never chooses who acts);
 *   5. dispatch: actions queue through the turn system while planning
 *      (immediate fallback for non-turn worlds), chat through the
 *      RoomChatController with the room forced to the NPC's location; a
 *      response with no tool calls is never interpreted — prose is ignored
 *      (the model chose silence, spec §6.3) and degenerate / tool-scaffold
 *      content is replaced by a neutral placeholder before it is stored, so
 *      it can never re-prime the next round;
 *   6. in-round agent loop (spec §6.5): up to LLM_AGENT_MAX_ITERATIONS LLM
 *      calls, each continuing with its tool results fed back, until the model
 *      ends the round with the done tool or stays silent;
 *   7. any LLMError (timeout / HTTP / parse / network) → logged + the NPC
 *      is SILENT this round. runRound NEVER throws — it is a tick-driven
 *      fire-and-forget hook and must never break the turn loop.
 *
 * Construction tier (spec §1.2 / §6.3): this is LLM orchestration, not world
 * state — it is constructed in server.js (same tier as
 * WorldStateBroadcastService), NOT in the composition root.
 *
 * @module LLMAgentController
 */

import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import IdResolver from '../../utils/IdResolver.js';
import { hasDeterministicBrain } from '../../utils/npcAiUtils.js';
import { CHAT_MESSAGE_MAX_LENGTH, LLM_AGENT_VIEW_HISTORY_ROUNDS, LLM_REPLAY_ROUNDS, isEnvFlagOn } from '../../utils/Constants.js';
import { TURN_PHASES } from '../../../shared/TurnPhases.js';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';
import { formatActionList, formatInstinctList, formatCraftList } from './LlmContextController.js';
import { measureDoorReach } from '../consequences/DoorTraversalHandler.js';
import { getWearMinVolume } from '../logic/WearLogic.js';

/** Default per-round world-action cap (spec §6.5); npcs.json may override. */
const DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND = 2;
/** Default per-round chat cap (spec §6.5); npcs.json may override. */
const DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND = 1;
/** Per-call LLM timeout budget (spec §6.5 default 4500 ms − no turn deadline exists in spec v2; the budget
 * bounds the LLM call itself, so every agent promise settles). The value here must cover a full
 * reasoning turn on the slow local model: generation alone can exceed 45 s per call (observed
 * 30–70 s on 127.0.0.1), so the 45 s cap misfired as LLM_TIMEOUT. (max_tokens is now 51200,
 * which is why the call can run long; the timeout is what finally bounds it.)
 * Raised to 450 s (7.5 min) so a slow "think carefully" round settles instead of timing out.
 * The outer bound on a round remains this timeout, not the per-call iteration cap. */
const LLM_ROUND_TIMEOUT_MS = 450000;
/** Per-call token cap: 10× the previous 5120 (100× the original 512). Local
 * reasoning models count their thinking tokens against this budget; a long
 * "think carefully" turn can burn tens of thousands of thinking tokens before
 * it finally acts, so a smaller cap truncated the reasoning (finishReason
 * "length") before the (now generous) timeout would settle. 51200 gives the
 * thinking budget ample headroom; the outer bound on a round is the
 * timeout, not this cap (see LLM_ROUND_TIMEOUT_MS).
 * Sized for a round that thinks. Thinking is now OFF unless the operator turns it
 * on (LLM_AGENT_THINKING_ENABLED), so a default round never spends this budget on
 * reasoning; the cap stays where the reasoning state needs it rather than being
 * lowered for the off state, which would have to be raised again on the first
 * opt-in. */
const LLM_ROUND_MAX_TOKENS = 51200;
/**
 * Per-call sampling temperature — deliberately below the global 1 default
 * (LLMController.DEFAULT_TEMPERATURE): a protocol-B round is a constrained
 * choice (one of a small fixed tool set, or silence) and 0.7 is the drift
 * zone where small local models started looping (the scaffold-loop incident
 * ran at 0.7). See spec §6.5.
 */
const LLM_ROUND_TEMPERATURE = 0.5;
/**
 * The environment variable that lets the operator turn the model's reasoning on
 * and off for the NPC agent round. OFF is the default: unset, empty, or any value
 * that is not "true" (the relaxed `isEnvFlagOn` reading, same convention as
 * KILLER_LLM_DRONE_ENABLED) sends `enable_thinking: false`.
 *
 * Scoped to the agent round on purpose, and not to the whole `LLMController`:
 * the round is the call the world fires every turn, and it is a constrained
 * choice (one tool out of a fixed set, or silence) - which is what the operator
 * pays reasoning tokens for. Room chat and `agent-body-design` keep their
 * current behaviour untouched; the body designer was raised to 10x tokens
 * precisely because it needs the thinking budget (see AgentBodyController).
 * Decision and measurements: wiki/decisions/llm-agent-thinking.md.
 * @constant
 */
const LLM_AGENT_THINKING_ENV_VAR = 'LLM_AGENT_THINKING_ENABLED';

/**
 * Reads the thinking gate for one LLM call.
 *
 * Read per call, not once at import, like every other LLM knob in this stack
 * (`LLMController` resolves `LLM_ENDPOINT` / `LLM_MODEL` / `LLM_TIMEOUT_MS`
 * inside `chatFull`): a world runs for hours and the gate is the kind of thing
 * flipped between rounds to compare what the model does with and without
 * reasoning. This deliberately differs from the KILLER_LLM_DRONE_ENABLED gate,
 * which is read once at spawn because spawning is a one-shot event. Note that
 * dotenv loads `.env` once at boot, so editing the file still needs a restart;
 * exporting the variable in the shell does not.
 * @returns {boolean} true only when the variable reads "true".
 */
function isAgentThinkingEnabled() {
    return isEnvFlagOn(process.env[LLM_AGENT_THINKING_ENV_VAR]);
}

/**
 * The in-round agent loop is the model's own turn budget, not a retry
 * mechanism (spec §6.5): up to LLM_AGENT_MAX_ITERATIONS chatFull calls per
 * round, each continuing the loop with its tool results fed back
 * (spec §6.3.6), until the model itself ends the round with the done tool
 * or stays silent. A fixed cap exists because the tool list is finite and a
 * model that never calls done must be bounded.
 * @constant
 */
const LLM_AGENT_DONE_TOOL_NAME = 'done';
const LLM_AGENT_MAX_ITERATIONS = 50;

/**
 * The registered action the `use_door` tool dispatches
 * (data/mods/core-actions/actions.json). The tool is a thin intent wrapper over
 * it — the same shape as `toApproach` over `move` — so the requirement gate
 * (Movement.move), the turn queue and the room-crossing itself stay in data and
 * in the `traverseDoor` consequence handler, never here.
 * @constant
 */
const CROSS_DOOR_ACTION = 'crossDoor';

/**
 * Upper bound on a model-supplied door name (`A-7`: every inbound value is
 * bounded). Doors are named by the room data (`right_door`, `left_door`); a
 * longer string is not a door name but an invention, and it is rejected before
 * the world is asked. @constant
 */
const DOOR_NAME_MAX_LENGTH = 64;

/**
 * Upper bound on a model-supplied item type (`A-7`: every inbound value is
 * bounded). Types come from the item registry (`knife`, `tshirt`); a longer
 * string is an invention, rejected before the world is asked. @constant
 */
const ITEM_TYPE_MAX_LENGTH = 64;

class LLMAgentController {
    /**
     * @param {Object} deps
     * @param {import('./LLMController.js')} deps.llmController
     * @param {import('../WorldStateController.js')} deps.worldStateController
     * @param {import('./LlmContextController.js')} deps.llmContextController
     * @param {import('../core/RoomChatController.js')} deps.roomChatController
     * @param {import('../core/TurnSystemController.js')} deps.turnSystemController
     * @param {import('../ai/InstinctController.js')} [deps.instinctController]
     */
    constructor({ llmController, worldStateController, llmContextController, roomChatController, turnSystemController, instinctController = null }) {
        this.llmController = llmController;
        this.worldStateController = worldStateController;
        this.llmContextController = llmContextController;
        this.roomChatController = roomChatController;
        this.turnSystemController = turnSystemController;
        this.instinctController = instinctController;

        /**
         * NPC registry (data/mods/core-npcs/npcs.json, spec §7.1): key = blueprint name,
         * value = { displayName, room, personality, objective?,
         * initialItems?, maxWorldActionsPerRound?, maxChatMessagesPerRound? }.
         *
         * Feature C ships BEFORE the file exists (Feature D creates it), so
         * the loader is tolerant: a missing/malformed registry simply means
         * "no NPCs configured" → every runRound degrades to a logged no-op
         * path, never a boot failure.
         * @private
         */
        this._npcRegistry = this._loadNpcRegistry();

        /**
         * Per-NPC round history (npcEntityId → array of round entries,
         * oldest → newest), capped at LLM_AGENT_VIEW_HISTORY_ROUNDS — the
         * "Agent View" inspector window (all of it is exposed by
         * describeAgentView). The LLM's conversation memory (spec §6.5) is
         * a view over the TAIL of this same buffer: _transcriptFor replays
         * only the last LLM_REPLAY_ROUNDS rounds. The two windows are equal
         * today (both 10000, owner request 2026-11-01), so this cap is the
         * only bound on how much an NPC remembers — and it is a round COUNT,
         * not a size budget: see wiki/decisions/llm-memory-window.md.
         * @private {Map<string, Array>}
         */
        this._transcripts = new Map();
    }

    // =========================================================================
    // NPC DISCOVERY
    // =========================================================================

    /**
     * Discovers the live NPCs: entities with `isNPC: true` joined with their
     * resolved per-entity config (see `_resolveNpcConfig`).
     * @returns {Array<{ entityId: string, entity: Object, config: Object }>}
     */
    getNpcs() {
        const entities = this.worldStateController?.stateEntityController?.getAll?.() || {};
        const npcs = [];
        for (const entity of Object.values(entities)) {
            if (!entity || entity.isNPC !== true) continue;
            const config = this._resolveNpcConfig(entity);
            npcs.push({ entityId: entity.id, entity, config });
        }
        return npcs;
    }

    // =========================================================================
    // FEEDBACK CONTROLLER SETTER (Feature E: immediate-outcome recording)
    // =========================================================================

    /**
     * Injects the per-agent feedback store (LlmAgentFeedbackController) so the
     * agent can record immediate outcomes (pre-validation failures, queue
     * rejections) BEFORE the turn system resolution hook sees them.
     * @param {import('./LlmAgentFeedbackController.js').default} feedbackController
     */
    setFeedbackController(feedbackController) {
        this._feedbackController = feedbackController;
    }

    // =========================================================================
    // INSTINCT GENERATION (spec §2.3/§2.5)
    // =========================================================================

    /**
     * Safely generates instincts for one NPC (try/catch → [] + Logger.warn).
     * The result is passed to buildContext and _buildTools.
     * @private
     */
    _safeGenerateInstincts(npcEntityId) {
        try {
            if (!this.instinctController) {
                return [];
            }
            return this.instinctController.generateForEntity(npcEntityId) || [];
        } catch (err) {
            Logger.warn(`[LLMAgent] _safeGenerateInstincts failed for ${npcEntityId}: ${err?.message || err}`);
            return [];
        }
    }

    // =========================================================================
    // THE HOOK — called fire-and-forget by TurnSystemController at the agent tick
    // =========================================================================

    /**
     * Runs ONE agent round for one NPC (spec §6.3). NEVER throws: every
     * failure path resolves with a structured result + a log line, so the
     * tick-driven hook (and the whole turn system) survives any LLM outage.
     *
     * @param {string} npcEntityId - The NPC's typed entity ID (server-injected).
     * @param {number} round - The turn round number.
     * @returns {Promise<{
     *   entityId: string,
     *   round: number,
     *   iterations: number,
     *   chat: { sent: boolean, text?: string, reason?: string },
     *   actions: Array<{ actionName: string, queued?: boolean, queueId?: string, success: boolean, detail?: string }>,
     *   note: string|undefined - why the agent stopped (done / no response /
     *     prose-ignored / degenerated / iterations exhausted / LLM error code),
     *   done: boolean - true when the agent stopped by its own call (done tool
     *     or silence), not by an error,
     *   error: string|null
     * }>}
     */
    async runRound(npcEntityId, round) {
        const result = {
            entityId: npcEntityId,
            round,
            iterations: 0,
            done: undefined,
            note: undefined,
            chat: { sent: false },
            actions: [],
            approaches: [],
            doors: [],
            crafts: [],
            equips: [],
            unequips: [],
            moves: [],
            error: null
        };

        try {
            // 1. Guard: the entity must exist and be an NPC.
            const entity = this.worldStateController?.getEntity?.(npcEntityId);
            if (!entity || entity.isNPC !== true) {
                Logger.warn(`[LLMAgent] runRound: entity ${npcEntityId} missing or not an NPC — no-op this round.`);
                result.error = 'NPC_GONE';
                this._storeTranscript(npcEntityId, round, { error: 'NPC_GONE' });
                return result;
            }

            // Deterministic AI guard: if the entity has a behavior configured,
            // skip the LLM entirely — the deterministic brain handles it.
            if (hasDeterministicBrain(entity)) {
                const aiBehavior = entity.npcConfig?.ai?.behavior;
                Logger.info(`[LLMAgent] runRound: ${npcEntityId} has a deterministic AI brain (${aiBehavior}) — LLM agent skips.`);
                result.error = 'DETERMINISTIC_AI';
                return result; // never call the LLM, no transcript
            }
            const npc = { entity, config: this._resolveNpcConfig(entity) };
            const displayName = npc.config?.displayName || entity.name || 'NPC';
            const maxActions = this._asPositiveInt(npc.config?.maxWorldActionsPerRound, DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND);
            const rawMaxChat = npc.config?.maxChatMessagesPerRound;
            const maxChat = (rawMaxChat === 0) ? 0 : this._asPositiveInt(rawMaxChat, DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND);

            // 2. Generate instincts (live from capabilities — spec §2.5).
            const instincts = this._safeGenerateInstincts(npcEntityId);

            // 3. Context (Feature B). A broken/absent context layer must not
            //    kill the round — fall back to a minimal identity line.
            let contextText;
            try {
                const ctx = this.llmContextController.buildContext(npcEntityId, { instincts });
                contextText = ctx && typeof ctx.text === 'string' && ctx.text.length > 0
                    ? ctx.text
                    : this._minimalContextLine(entity);
            } catch (err) {
                Logger.warn(`[LLMAgent] round ${round}: context build failed for ${displayName} — using minimal context: ${err?.message || err}`);
                contextText = this._minimalContextLine(entity);
            }

            // 4. Conversation: transcript replay (last LLM_REPLAY_ROUNDS rounds)
            // + fresh context. Every round the LLM sees is anchored by a user
            // message — the round number plus its context snapshot; the replay
            // carries each prior round's anchor (and saved context), the live
            // round gets its own (decisions/round-anchored-transcript.md).
            const messages = [
                ...this._transcriptFor(npcEntityId),
                { role: 'user', content: `round ${round}\n\n${contextText}` }
            ];

            const options = {
                system: this._buildSystemPrompt(npc, this._roomName(entity)),
                tools: this._buildTools({ includeChat: maxChat > 0, instincts }),
                // PROTOCOL B (spec §6.2 has always said "auto"): never
                // "required" — forcing a tool call is exactly what turned a
                // weak local model into the scaffold-loop incident (with the
                // constraint unsatisfiable through the native channel, the
                // model "satisfied" it by emitting the function-call markup
                // as literal text and looping on it). With "auto" silence is
                // legal (the prompt says so), and a broken response is the
                // genuinely degenerate case, caught by the sanitizer.
                tool_choice: 'auto',
                temperature: LLM_ROUND_TEMPERATURE,
                timeout_ms: LLM_ROUND_TIMEOUT_MS,
                max_tokens: LLM_ROUND_MAX_TOKENS,
                // Always a boolean, never absent: the gate has a default (off), so a
                // round states its position instead of leaving reasoning to whatever
                // the server happens to do. Read per round, so flipping the variable
                // takes effect on the next round of the same running world.
                thinkingEnabled: isAgentThinkingEnabled()
            };

            let executedActions = 0;
            let sentChats = 0;
            // Per-call results for speak_in_room, stored in the transcript so
            // the NEXT round replays the REAL outcome (a successful speak must
            // not be replayed as success:false — the pre-fix transcript lied).
            const speakResults = [];
            // One aggregated result per instinct call (spec \u00a76.5); success =
            // all steps succeeded. Drives the transcript tool-result (see
            // _buildRoundGroup).
            const instinctResults = [];
            // One group per LLM call (the in-round agent loop, spec §6.5);
            // capped by LLM_AGENT_MAX_ITERATIONS. Replayed as history next
            // round (see _transcriptFor) and shown in the Agent View
            // inspector (see _getTranscriptRounds).
            const groups = [];

            for (let iteration = 1; iteration <= LLM_AGENT_MAX_ITERATIONS; iteration++) {
                result.iterations = iteration;

                // 4. The LLM call — any LLMError = graceful silence (no retry).
                //    (tool_choice is "auto", so the "required" 400-retry of
                //    the mixed-protocol era is gone with it.)
                let full;
                try {
                    full = await this.llmController.chatFull(messages, options);
                } catch (err) {
                    const code = err?.code || 'LLM_REQUEST_ERROR';
                    const msg = err?.message || String(err);
                    Logger.warn(`[LLMAgent] round ${round} missed for ${displayName}: ${code} (${msg})`);
                    result.error = code;
                    this._storeTranscript(npcEntityId, round, { groups, note: code, error: code, context: contextText });
                    return result; // NPC silent — window may be gone anyway
                }

                // 5. Parse tool calls (includes use_instinct). The assistant
                //    message is SANITIZED FIRST: degenerate or scaffold-bearing
                //    content is replaced by a neutral placeholder before it is
                //    parsed, replayed to a retry, or stored — the pi harness
                //    does the equivalent structurally (its adapter never lets
                //    broken content become history).
                const assistantMessage = this._sanitizeAssistantMessage(full.message);
                const parsed = this._parseToolCalls(assistantMessage);
                let actionableFailure = null; // → triggers the single retry

                for (const call of parsed.actions) {
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.actions.push({ actionName: String(call.args.actionName), success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, {
                            actionName: String(call.args.actionName), success: false, detail,
                            targetEntityId: this._targetEntityIdOf(call.args)
                        });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateAction(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.actions.push({ actionName: String(call.args.actionName), success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, {
                            actionName: String(call.args.actionName), success: false, detail: validation.error,
                            targetEntityId: this._targetEntityIdOf(call.args)
                        });
                        if (!actionableFailure) actionableFailure = { call, error: validation.error };
                        continue;
                    }

                    const dispatch = this._dispatchAction(npcEntityId, String(call.args.actionName), validation.params);
                    executedActions += 1;
                    result.actions.push({
                        actionName: dispatch.actionName,
                        queued: dispatch.queued,
                        queueId: dispatch.queueId,
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    this._recordImmediateOutcome(npcEntityId, {
                        actionName: dispatch.actionName,
                        success: dispatch.success,
                        detail: dispatch.detail || (dispatch.queued ? 'queued' : 'executed'),
                        targetEntityId: this._targetEntityIdOf(validation.params)
                    });
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'execution failed' };
                    }
                }

                for (const call of parsed.speaks) {
                    const callId = call.id;
                    const text = call.args?.message;
                    if (sentChats >= maxChat || typeof text !== 'string' || text.trim() === '' || text.length > CHAT_MESSAGE_MAX_LENGTH) {
                        const reason = sentChats >= maxChat
                            ? `max chat messages per round reached (${maxChat})`
                            : 'invalid message text';
                        result.chat = { sent: false, reason };
                        speakResults.push({ id: callId, success: false, detail: reason });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'speak_in_room', success: false, detail: reason });
                        continue;
                    }
                    const sendResult = this._dispatchSpeak(entity, displayName, text.trim());
                    if (sendResult.success) {
                        sentChats += 1;
                        result.chat = { sent: true, text: sendResult.message?.text ?? text };
                        // Remember the send outcome (tool_call id + success) so
                        // the transcript replay is truthful next round.
                        speakResults.push({
                            id: callId,
                            success: true,
                            messageId: sendResult.message?.id || null
                        });
                        const spoken = text.trim();
                        const spokenShort = spoken.length > 60 ? `${spoken.slice(0, 57)}...` : spoken;
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'speak_in_room', success: true, detail: `said "${spokenShort}"` });
                    } else {
                        const reason = sendResult.error || sendResult.code;
                        result.chat = { sent: false, reason };
                        speakResults.push({ id: callId, success: false, detail: reason });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'speak_in_room', success: false, detail: reason });
                    }
                }

                // Dispatch approach calls (toApproach tool): world-action intent
                // resolved to the registered move action (server-side coordinates
                // from the target's live spatial position).
                for (const call of parsed.approaches) {
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.approaches.push({ id: call.id, actionName: 'toApproach', success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, {
                            actionName: 'toApproach', success: false, detail,
                            targetEntityId: this._targetEntityIdOf(call.args)
                        });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateApproach(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.approaches.push({ id: call.id, actionName: 'toApproach', success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, {
                            actionName: 'toApproach', success: false, detail: validation.error,
                            targetEntityId: this._targetEntityIdOf(call.args)
                        });
                        if (!actionableFailure) actionableFailure = { call, error: validation.error };
                        continue;
                    }

                    const dispatch = this._dispatchApproach(npcEntityId, validation.params);
                    executedActions += 1;
                    result.approaches.push({
                        id: call.id,
                        actionName: dispatch.actionName,
                        queued: dispatch.queued,
                        queueId: dispatch.queueId,
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    this._recordImmediateOutcome(npcEntityId, {
                        actionName: 'toApproach',
                        success: dispatch.success,
                        detail: dispatch.detail || (dispatch.queued ? 'queued' : 'executed'),
                        targetEntityId: this._targetEntityIdOf(validation.params)
                    });
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'execution failed' };
                    }
                }

                // Dispatch door calls (use_door tool): the intent wrapper over the
                // registered crossDoor action, same shape as toApproach over move.
                // Counts as a world action (maxActions) and is gated by the same
                // capability check — a droid that cannot move cannot leave a room.
                for (const call of parsed.doors) {
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.doors.push({ id: call.id, actionName: 'use_door', success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'use_door', success: false, detail });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateDoor(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.doors.push({ id: call.id, actionName: 'use_door', success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'use_door', success: false, detail: validation.error });
                        if (!actionableFailure) actionableFailure = { call, error: validation.error };
                        continue;
                    }

                    const dispatch = this._dispatchDoor(npcEntityId, validation.params);
                    executedActions += 1;
                    result.doors.push({
                        id: call.id,
                        actionName: dispatch.actionName,
                        queued: dispatch.queued,
                        queueId: dispatch.queueId,
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    this._recordImmediateOutcome(npcEntityId, {
                        actionName: 'use_door',
                        success: dispatch.success,
                        detail: dispatch.detail || (dispatch.queued ? 'queued' : 'executed')
                    });
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'crossing failed' };
                    }
                }

                // 7. Dispatch instinct calls (use_instinct tool). One aggregated
                // result per call, in call order, drives the transcript
                // tool-result (see _buildRoundGroup).
                if (this.instinctController && parsed.instincts && parsed.instincts.length > 0) {
                    for (const entry of parsed.instincts) {
                        const instinctResult = await this._dispatchInstinct(npcEntityId, entry, round, result);
                        result.actions.push(...instinctResult.actions);
                        // success = every step succeeded. Accurate even for the
                        // missing-id early-return, where actionable is false but
                        // the call clearly failed.
                        const instinctOk = instinctResult.actions.length > 0
                            ? instinctResult.actions.every(a => Boolean(a.success))
                            : !instinctResult.actionable;
                        instinctResults.push({
                            id: entry.id,
                            success: instinctOk,
                            detail: instinctOk ? undefined : (instinctResult.detail || 'instinct failed')
                        });
                        const iid = entry.args?.instinctId;
                        this._recordImmediateOutcome(npcEntityId, {
                            actionName: 'use_instinct',
                            success: instinctOk,
                            detail: instinctOk
                                ? (iid ? `executed ${iid}` : 'executed')
                                : (instinctResult.detail || 'instinct failed'),
                            targetEntityId: this._targetEntityIdOf(entry.args)
                        });
                        if (instinctResult.actionable && !actionableFailure) {
                            actionableFailure = { call: entry, error: instinctResult.detail || 'instinct failed' };
                        }
                    }
                }

                // 8. Dispatch craft calls (craft tool): recipe + ingredient
                //    multiset + destination component. The pre-check rejects
                //    unknown recipes, malformed multisets, and entities that
                //    do not hold the ingredients (across all of the entity's
                //    components); the server picks the concrete items
                //    to consume, and facade.craftItems runs the full transaction
                //    (exact multiset, volume pre-check, consume, produce). In a
                //    turn world the planning window applies (drop, mirrors
                //    toApproach). Counts as a world action (maxActions).
                for (const call of parsed.crafts) {
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        const recipeId = typeof call.args?.recipeId === 'string' ? call.args.recipeId : '';
                        result.crafts.push({ recipeId, success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'craft', success: false, detail });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateCraft(npcEntityId, call.args);
                    if (!validation.ok) {
                        const recipeId = typeof call.args?.recipeId === 'string' ? call.args.recipeId : '';
                        result.crafts.push({ recipeId, success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'craft', success: false, detail: validation.error });
                        if (!actionableFailure) actionableFailure = { call, error: validation.error };
                        continue;
                    }

                    const dispatch = this._dispatchCraft(npcEntityId, validation.params);
                    executedActions += 1;
                    result.crafts.push({
                        recipeId: dispatch.recipeId,
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    this._recordImmediateOutcome(npcEntityId, {
                        actionName: 'craft',
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'craft failed' };
                    }
                }

                // Dispatch equip calls (equip_item tool): one carried item goes
                // onto one of the NPC's own components. The same tool is the
                // clothing tool — wearing is equipping under the fit rule, so a
                // wearable type dispatches through WearLogic (see _executeEquip).
                // Counts as a world action (maxActions), like craft.
                for (const call of parsed.equips) {
                    const itemType = typeof call.args?.itemType === 'string' ? call.args.itemType : '';
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.equips.push({ itemType, success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'equip_item', success: false, detail });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateEquip(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.equips.push({ itemType, success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'equip_item', success: false, detail: validation.error });
                        if (!actionableFailure) actionableFailure = { call, error: validation.error };
                        continue;
                    }

                    const dispatch = this._dispatchEquip(npcEntityId, validation.params);
                    executedActions += 1;
                    result.equips.push({
                        itemType: dispatch.itemType,
                        itemId: dispatch.itemId,
                        componentId: dispatch.componentId,
                        wearable: dispatch.wearable,
                        queued: dispatch.queued,
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    this._recordImmediateOutcome(npcEntityId, {
                        actionName: 'equip_item',
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'equip failed' };
                    }
                }

                // Dispatch unequip calls (unequip_item tool): taking clothing off
                // is taking an equipped entry off, so the one call covers both.
                for (const call of parsed.unequips) {
                    const itemType = typeof call.args?.itemType === 'string' ? call.args.itemType : '';
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.unequips.push({ itemType, success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'unequip_item', success: false, detail });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateUnequip(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.unequips.push({ itemType, success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'unequip_item', success: false, detail: validation.error });
                        if (!actionableFailure) actionableFailure = { call, error: validation.error };
                        continue;
                    }

                    const dispatch = this._dispatchUnequip(npcEntityId, validation.params);
                    executedActions += 1;
                    result.unequips.push({
                        itemType: dispatch.itemType,
                        itemId: dispatch.itemId,
                        componentId: dispatch.componentId,
                        wearable: dispatch.wearable,
                        queued: dispatch.queued,
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    this._recordImmediateOutcome(npcEntityId, {
                        actionName: 'unequip_item',
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'unequip failed' };
                    }
                }

                // Dispatch move calls (move_item tool): one carried or equipped
                // item goes from one of the NPC's own components to another.
                // Counts as a world action (maxActions), like craft/equip/unequip.
                for (const call of parsed.moves) {
                    const itemType = typeof call.args?.itemType === 'string' ? call.args.itemType : '';
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.moves.push({ itemType, success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'move_item', success: false, detail });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateMoveItem(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.moves.push({ itemType, success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, { actionName: 'move_item', success: false, detail: validation.error });
                        if (!actionableFailure) actionableFailure = { call, error: validation.error };
                        continue;
                    }

                    const dispatch = this._dispatchMoveItem(npcEntityId, validation.params);
                    executedActions += 1;
                    result.moves.push({
                        itemType: dispatch.itemType,
                        itemId: dispatch.itemId,
                        fromComponentId: dispatch.fromComponentId,
                        toComponentId: dispatch.toComponentId,
                        kind: dispatch.kind,
                        queued: dispatch.queued,
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    this._recordImmediateOutcome(npcEntityId, {
                        actionName: 'move_item',
                        success: dispatch.success,
                        detail: dispatch.detail
                    });
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'move failed' };
                    }
                }

                // 9. Discovery payloads: get_actions / get_instincts / get_crafts
                //    return the formatted list directly — the tool result IS the
                //    list (one per call, built from the live registry / instinct
                //    list / craft state, filtered as requested).
                const actionData = this.llmContextController
                    && typeof this.llmContextController.getActionData === 'function'
                    ? this.llmContextController.getActionData(npcEntityId)
                    : { entries: [], notExecutable: [] };
                const craftData = this.llmContextController
                    && typeof this.llmContextController.getCraftData === 'function'
                    ? this.llmContextController.getCraftData(npcEntityId)
                    : { craftable: [], notCraftable: [] };
                const payloadMap = {};
                for (const discovery of parsed.discoveries) {
                    const list =
                        discovery.kind === 'get_actions'
                            ? formatActionList(actionData.entries, actionData.notExecutable, discovery.args.filter)
                            : discovery.kind === 'get_instincts'
                                ? formatInstinctList(instincts, discovery.args.filter)
                                : formatCraftList(craftData.craftable, craftData.notCraftable, discovery.args.filter);
                    payloadMap[discovery.id] = { success: true, list };
                }

                // 10. This LLM call is one group of the in-round agent loop
                //     (spec §6.5); the full loop is what replays next round.
                //     The assistant message is the SANITIZED one (degenerate /
                //     scaffold content was replaced by a neutral placeholder in
                //     the parser), so the stored group cannot re-prime the next
                //     round (BUG-007).
                const group = this._buildRoundGroup(assistantMessage, parsed, result, {
                    speakResults,
                    instinctResults,
                    payloadMap
                });
                groups.push(group);

                // 11. Stop conditions (each ends the round — the loop IS the
                //     agent, not a retry mechanism).
                const hasTools =
                    parsed.actions.length > 0 ||
                    parsed.speaks.length > 0 ||
                    parsed.approaches.length > 0 ||
                    parsed.doors.length > 0 ||
                    parsed.instincts.length > 0 ||
                    parsed.crafts.length > 0 ||
                    parsed.equips.length > 0 ||
                    parsed.unequips.length > 0 ||
                    parsed.moves.length > 0 ||
                    parsed.discoveries.length > 0 ||
                    parsed.done;

                if (!hasTools && !actionableFailure) {
                    // No tools, no failure: the model chose silence (spec
                    // §6.3). PROTOCOL B: the content is NEVER interpreted
                    // as an intent — it is simply discarded.
                    const content = parsed.prose;
                    let note;
                    if (content === null) {
                        note = 'no response';
                    } else {
                        // Degeneracy check on the RAW model content (the
                        // placeholder itself must not loop — tested).
                        const rawContent =
                            typeof full.message?.content === 'string' ? full.message.content : '';
                        const degenerated = this._isDegenerate(rawContent);
                        note = degenerated ? 'degenerated' : 'prose-ignored';
                    }
                    Logger.warn(`[LLMAgent] round ${round}: ${displayName} — LLM output ${note} (content discarded, NPC silent this round).`);
                    result.done = true;
                    result.note = note;
                    result.chat = { sent: false, reason: note };
                    this._storeTranscript(npcEntityId, round, { groups, note, context: contextText });
                    return result;
                }

                if (parsed.done && !actionableFailure) {
                    // The agent declared its work complete with the done tool
                    // (spec §6.5.6).
                    result.done = true;
                    result.note = 'done';
                    this._storeTranscript(npcEntityId, round, { groups, note: 'done', context: contextText });
                    return result;
                }

                if (actionableFailure) {
                    // Failed call with budget left: feed the failure back
                    // (spec §6.3.6) and continue the loop.
                    Logger.info(`[LLMAgent] round ${round}: ${displayName} — feeding failure back to the model: ${actionableFailure.error}`);
                    const feedback = this._buildFeedbackMessages(group);
                    messages.push(...feedback);
                    continue;
                }

                if (iteration >= LLM_AGENT_MAX_ITERATIONS) {
                    // Budget exhausted: the loop ends; the final call lives in
                    // `groups` (no retries were left to spend).
                    result.note = result.note || 'iterations exhausted';
                    this._storeTranscript(npcEntityId, round, { groups, note: result.note, context: contextText });
                    return result;
                }

                // Success with no failure and no stop: feed the assistant's
                // tool results back so the model can chain calls (spec §6.5)
                // and continue the loop. Without this append the next
                // iteration re-sees the identical state — the get_actions /
                // get_instincts discovery loop (and any multi-call round
                // without done) spins to LLM_AGENT_MAX_ITERATIONS.
                messages.push(...this._buildFeedbackMessages(group));
            }

            // Defensive fallback: the loop normally returns above; this only
            // fires if the final iteration had an actionableFailure (the
            // failure-fed-back continue pushed past the budget cap).
            this._storeTranscript(npcEntityId, round, {
                groups,
                note: result.note || 'loop ended without return',
                context: contextText
            });
            return result;
        } catch (err) {
            // Last-resort guard: runRound must NEVER throw out of the hook.
            // The stack is logged (not just the message) so a future failure
            // points at the exact line — message-only hid the 2026-10-21
            // stale-process dispatch crash.
            Logger.warn(`[LLMAgent] round ${round}: unexpected agent failure for ${npcEntityId}: ${err?.message || err}`, { stack: err?.stack ?? null });
            result.error = result.error || 'AGENT_INTERNAL_ERROR';
            return result;
        }
    }

    // =========================================================================
    // TOOLS (generated from data — never hardcoded, spec §6.2 / BUG-018)
    // =========================================================================

    /**
     * Builds the tool OpenAI schema — generated from data every round, never
     * hardcoded (BUG-018): the `get_actions` / `get_instincts` / `get_crafts`
     * tools are the model's ONLY source of executable options; `execute_action`
     * carries no actionName enum (the registry is the live list, not the tool
     * list); `toApproach` is a fixed intent tool that dispatches the registered
     * move action toward the target's live coordinates; `use_door` is its
     * room-travel counterpart, dispatching the registered crossDoor action with
     * a door named by the CURRENT room's connections; `equip_item` /
     * `unequip_item` put one carried item on the body and take one off again,
     * and they are also the clothing tools — a worn item IS an equipped entry
     * (WearLogic), so there is no second pair for clothes; `move_item` shifts
     * a carried or equipped item to another one of the body's own components
     * (an equipped item re-equips under the fit rule); `craft` takes a recipe
     * id, the named ingredient multiset, and the component that receives the
     * outputs — pre-validation runs against the live recipe registry and the
     * component's holdings before the real transaction; `use_instinct` is
     * offered only when the instinct controller generated instincts this
     * round; `done` ends the round and is listed last.
     * @param {Object} [opts]
     * @param {boolean} [opts.includeChat=true] - Whether to include the speak_in_room tool.
     * @param {Array<Object>} [opts.instincts] - Generated instincts for this round (if non-empty, adds the use_instinct tool).
     * @returns {Array<Object>}
     */
    _buildTools({ includeChat = true, instincts = [] } = {}) {
        const executeAction = {
            type: 'function',
            function: {
                name: 'execute_action',
                description: 'Execute one world action with your own body. Only use action names the get_actions tool returned — those are the ONLY executable options this round. Machine actions (placeMachine / retrieveMachine) take itemType / machineType, and use the placed-machine world state.',
                parameters: {
                    type: 'object',
                    properties: {
                        actionName: {
                            type: 'string',
                            description: 'The action to perform. See the get_actions output for names, parameters, and whether it is executable right now.'
                        },
                        targetComponentId: { type: 'string', description: 'comp-… target component (attacks, cuts, pickup target).' },
                        componentId: { type: 'string', description: 'comp-… your own source component (e.g. the arm/hand using the tool).' },
                        targetEntityId: { type: 'string', description: 'ent-… entity being affected (range-checked).' },
                        itemId: { type: 'string', description: 'item-… item to drop (dropItem / pickUpItem).' },
                        itemType: { type: 'string', description: 'Machine item type to place (e.g. "knifeGenerator"); used by placeMachine when you name the machine by type rather than instance id.' },
                        machineType: { type: 'string', description: 'Machine type to retrieve (e.g. "knifeGenerator"); used by retrieveMachine to pick up your own placed machine.' },
                        targetX: { type: 'number', description: 'Target x in room coordinates (move/dash/drop).' },
                        targetY: { type: 'number', description: 'Target y in room coordinates (move/dash/drop).' },
                        targetRoomId: { type: 'string', description: 'Unused: no registered action consumes it. To change rooms call the use_door tool.' }
                    },
                    required: ['actionName']
                }
            }
        };

        const toApproach = {
            type: 'function',
            function: {
                name: 'toApproach',
                description: 'Move toward another droid in the current room as far as your movement stat allows. Pass only the target entity id (ent-…); the server resolves its live coordinates. It does not cross rooms — to change rooms call the use_door tool.',
                parameters: {
                    type: 'object',
                    properties: {
                        targetEntityId: {
                            type: 'string',
                            description: 'The entity to move toward (ent-…).'
                        }
                    },
                    required: ['targetEntityId']
                }
            }
        };

        const useDoor = {
            type: 'function',
            function: {
                name: 'use_door',
                description: "Walk through one door of the room you are standing in and appear in the room beyond. You must be STANDING AT the door: your 'Exits:' line prints each door's position, so walk there with move first if you are not next to it. Pass the door name exactly as that line shows it (e.g. \"right_door\") — the server resolves where the door leads and where inside the next room you appear. This is the only way to leave a room; you cannot name the destination.",
                parameters: {
                    type: 'object',
                    properties: {
                        door: { type: 'string', description: 'Door name from your Exits line (e.g. "right_door").' }
                    },
                    required: ['door']
                }
            }
        };

        const speakInRoom = {
            type: 'function',
            function: {
                name: 'speak_in_room',
                description: 'Say something in the chat of the room you are currently in.',
                parameters: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', description: 'The line to say (under 25 words, in character).' }
                    },
                    required: ['message']
                }
            }
        };

        const useInstinct = {
            type: 'function',
            function: {
                name: 'use_instinct',
                description: "Perform a whole registered behavior in one call: the server expands and executes the instinct's action sequence. See the get_instincts output for available instincts and their ids.",
                parameters: {
                    type: 'object',
                    properties: {
                        instinctId: {
                            type: 'string',
                            description: 'The instinct to perform (see the get_instincts tool output).'
                        },
                        targetEntityId: { type: 'string', description: 'Optional target entity id (ent-…); default: nearest entity in your room.' }
                    },
                    required: ['instinctId']
                }
            }
        };

        // Equip / unequip: one pair for carried gear AND for clothing. The
        // clothes feature deliberately has no tool of its own — wearing is
        // `HoldingCostController.equipItem` under the fit rule (WearLogic), so a
        // worn t-shirt is an equipped entry and comes off through the same call
        // as a knife. The model names the item TYPE (the only thing its
        // Inventory / Equipped lines print) and never an instance id; the server
        // resolves which concrete item, exactly as the craft tool resolves the
        // ingredient multiset it is handed by type.
        const equipItemTool = {
            type: 'function',
            function: {
                name: 'equip_item',
                description: 'Put one item you are carrying onto one of your own components. This is also how you put CLOTHING on: an item the world declares wearable (a t-shirt) fits only when that component has enough free volume for it, and then it is worn there. Pass the item type exactly as your Inventory line shows it, and the comp-… component that carries it — that same component is what wears or holds it. You never name an item id; the server picks the item.',
                parameters: {
                    type: 'object',
                    properties: {
                        itemType: { type: 'string', description: 'Item type from your Inventory line (e.g. "knife", "tshirt").' },
                        componentId: { type: 'string', description: 'comp-… your own component that carries the item and receives it equipped/worn.' }
                    },
                    required: ['itemType', 'componentId']
                }
            }
        };

        const unequipItemTool = {
            type: 'function',
            function: {
                name: 'unequip_item',
                description: 'Take one equipped item off your own body. This is also how you take CLOTHING off: a worn item is an equipped entry, so one call removes it (and lifts the carrying cost it was adding). Pass the item type exactly as your Equipped line shows it; the server picks which instance of that type and tells you where it came off.',
                parameters: {
                    type: 'object',
                    properties: {
                        itemType: { type: 'string', description: 'Item type from your Equipped line (e.g. "knife", "tshirt").' }
                    },
                    required: ['itemType']
                }
            }
        };

        const moveItemTool = {
            type: 'function',
            function: {
                name: 'move_item',
                description: 'Move one item you have to another component of your own droid body: a carried item, or an equipped one (which re-equips on the new component under the fit rule). Pass the item type exactly as your Inventory line shows it, the comp-… it is currently on, and the comp-… that will carry it. It must fit the destination (free volume). Never invent an item id — name the type and the components.',
                parameters: {
                    type: 'object',
                    properties: {
                        itemType: { type: 'string', description: 'Item type from your Inventory line (e.g. "knife", "tshirt").' },
                        fromComponentId: { type: 'string', description: 'The comp-… component currently hosting the item, from your Inventory line.' },
                        toComponentId: { type: 'string', description: 'The comp-… component that will host the item after the move, from your Inventory line.' }
                    },
                    required: ['itemType', 'fromComponentId', 'toComponentId']
                }
            }
        };

        const getActions = {
            type: 'function',
            function: {
                name: 'get_actions',
                description: 'List the actions you can execute right now, with their parameters, costs, and whether they are executable. This is the ONLY source of executable options — call it at the start of every round.',
                parameters: {
                    type: 'object',
                    properties: {
                        filter: { type: 'string', description: 'Optional text filter to narrow the list (e.g. a room name).' }
                    },
                    required: []
                }
            }
        };

        const getInstincts = {
            type: 'function',
            function: {
                name: 'get_instincts',
                description: 'List the instincts available to you this round, with their ids and parameters. This is the ONLY source of instinct ids — call it at the start of every round.',
                parameters: {
                    type: 'object',
                    properties: {
                        filter: { type: 'string', description: 'Optional text filter to narrow the list (e.g. move or attack).' }
                    },
                    required: []
                }
            }
        };

        const getCrafts = {
            type: 'function',
            function: {
                name: 'get_crafts',
                description: 'List the recipes you can craft right now, with their exact required ingredients (you may hold them on any of your components, pooled), what they produce, and the comp-… component that receives the outputs, plus recipes that are not craftable and why. This is the ONLY source of craftable options — call it before you craft, not after.',
                parameters: {
                    type: 'object',
                    properties: {
                        filter: { type: 'string', description: 'Optional text filter to narrow the list (e.g. "knife" or "coal").' }
                    },
                    required: []
                }
            }
        };

        const craftTool = {
            type: 'function',
            function: {
                name: 'craft',
                description: 'Craft a recipe: consume the named ingredient multiset from your components (the ingredients may sit on different components of your droid) and place the produced outputs on the component you name. Only use a recipe id the get_crafts tool returned — that is the ONLY source of recipe ids, required ingredients, and the destination component. Name each ingredient by type and by exactly how many; the server picks the concrete items it holds across your components.',
                parameters: {
                    type: 'object',
                    properties: {
                        recipeId: {
                            type: 'string',
                            description: 'Recipe id. See the get_crafts output for ids, needed ingredients, and the component that receives the outputs.'
                        },
                        ingredients: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    type: {
                                        type: 'string',
                                        description: 'Ingredient item type (e.g. "knife", "coal", "chunk_wood").'
                                    },
                                    quantity: {
                                        type: 'integer',
                                        minimum: 1,
                                        description: 'How many of that type to consume.'
                                    }
                                },
                                required: ['type', 'quantity'],
                                additionalProperties: false
                            },
                            description: 'The exact ingredient multiset to consume — match the "need" line of the recipe you are crafting (surplus of a type is fine; only the named multiset is consumed).'
                        },
                        componentId: {
                            type: 'string',
                            description: 'comp-… of the component that receives the produced outputs; the ingredients may be on any of your components. See the "on <comp>" line of the get_crafts output.'
                        }
                    },
                    required: ['recipeId', 'ingredients', 'componentId']
                }
            }
        };

        const doneTool = {
            type: 'function',
            function: {
                name: LLM_AGENT_DONE_TOOL_NAME,
                description: 'Ends your round. Call it once your actions, chat, and approaches for this round are done. It is listed last: check your actions first, then end the round when nothing else remains.',
                parameters: {
                    type: 'object',
                    properties: {
                        note: { type: 'string', description: 'Optional short note (up to 100 chars) explaining why you are stopping this round.' }
                    },
                    required: []
                }
            }
        };

        // Order: discovery tools first (read at round start), action tools
        // (move toward → leave the room → craft → put on / take off → shift
        // between components), chat, instincts, and the round-end done tool last.
        const tools = [getActions, getInstincts, getCrafts, executeAction, toApproach, craftTool, useDoor, equipItemTool, unequipItemTool, moveItemTool];
        if (includeChat) {
            tools.push(speakInRoom);
        }
        if (instincts && instincts.length > 0) {
            tools.push(useInstinct);
        }
        tools.push(doneTool);

        return tools;
    }
    // =========================================================================
    // SYSTEM PROMPT (spec §6.4 template)
    // =========================================================================

    /**
     * Builds the per-NPC system prompt (spec §6.4 template). Entries with a
     * non-empty objective gain an `Objective:` line and a strengthened
     * advance-instead-of-stay-silent rule; entries without one render the
     * historical template byte-identically.
     * @private
     * @param {Object} npc - The NPC record: `npc.config` (the resolved per-entity
     *   config — the live entity `npcConfig` merged over the static registry
     *   by blueprint, live values taking precedence, see `_resolveNpcConfig` —
     *   displayName, personality, objective?, maxWorldActionsPerRound?,
     *   maxChatMessagesPerRound?) and `npc.entity` (the spawned entity, used
     *   as the display-name fallback when the config has no display name).
     *   The live-config precedence is what lets dynamically-spawned cards (no
     *   registry entry) render their own name/personality, while registry
     *   NPCs stay byte-identical (their live `npcConfig` mirrors the registry).
     * @param {string} roomName - The display name of the NPC's current room,
     *   rendered into the prompt's first line.
     * @returns {string} The full system prompt text issued to the LLM for
     *   this NPC's next round.
     */
    _buildSystemPrompt(npc, roomName) {
        const config = npc.config || {};
        const displayName = config.displayName || npc.entity.name || 'NPC';
        const personality = config.personality || 'You are a friendly droid. Keep replies short.';
        const objective = typeof config.objective === 'string' ? config.objective.trim() : '';
        const maxActions = this._asPositiveInt(config.maxWorldActionsPerRound, DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND);
        const rawMaxChatPrompt = config.maxChatMessagesPerRound;
        const maxChat = (rawMaxChatPrompt === 0) ? 0 : this._asPositiveInt(rawMaxChatPrompt, DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND);

        const chatLine = maxChat > 0
            ? `- You may issue at most ${maxActions} world action call(s) and send at most ${maxChat} chat message(s) this round. Call the done tool to end your round.`
            : `- You may issue at most ${maxActions} world action call(s) this round. You MUST NOT use the speak_in_room tool or produce any chat output. Call the done tool to end your round.`;

        const actionRule = objective
            ? '- Only use actions the get_actions tool returned. If you cannot complete your objective this round, take the action that best advances it (e.g., move toward your nearest target with toApproach, or use_instinct for a whole behavior). Stop the round when no action serves your objective.'
            : '- Only use actions the get_actions tool returned. Move toward your goals with toApproach (pass the targetEntityId — the server resolves the position). Stop the round when nothing is worth doing.';

        // PROTOCOL B (restores spec §6.2/§6.3/§6.4): the native tool call is
        // the ONLY response protocol — there is no JSON-in-content block.
        // The mixed mode this file briefly ran in (a "Respond with ONE JSON
        // object" prompt PLUS the native tools PLUS tool_choice:"required")
        // told the model two contradictory formats in one request; small
        // local models hedged between them (JSON in the content, function-
        // call markup as literal text) and the markup looped to the token
        // cap. One protocol per request: tools, or silence.
        const sayLine = maxChat > 0
            ? '- To say something, call the speak_in_room tool with your line as the "message" argument.\n'
            : '';

        return [
            `You are ${displayName}, an NPC droid in the room "${roomName}".`,
            `Personality: ${personality}`,
            ...(objective ? [`Objective: ${objective}`] : []),
            '',
            'World rules:',
            '- You are the only actor: you never choose another entity\'s ID as the acting entity.',
            chatLine,
            actionRule,
            '- You may call use_instinct to perform a whole behavior (e.g. chase and attack) in one call; it is preferred over chaining execute_action calls for the same intent.',
            '- Craft with the craft tool only: pass the recipeId, the exact ingredient multiset (type x quantity), and the comp-… that receives the outputs. get_crafts is the ONLY source of valid recipe ids, ingredients, and components — never invent a recipe or an ingredient type.',
            '- Start each round with get_actions (and get_instincts when instincts exist, and get_crafts when you want to craft): that is the ONLY source of executable options — issue execute_action / toApproach / use_instinct / craft only with names the discovery calls returned.',
            '- You may call toApproach { targetEntityId: "ent-..." } to move toward an entity in your current room as far as possible this round (one full move step, capped by your movement stat). Name only the target — the server resolves where it is. It does not cross rooms: to enter another room call use_door with a door name from your Exits line.',
            '- Leave a room with the use_door tool only: pass the door name exactly as your Exits line shows it — that line also prints each door\'s position, and you must be standing at the door to cross it, so walk there with move first. You cannot name the destination room — the door decides it.',
            '- Put a carried item on with the equip_item tool (its type from your Inventory line, plus the comp-… carrying it) and take an equipped one off with unequip_item (type only). Those are also how you dress: a worn item is just an equipped one, and it fits a component with enough free volume. Never invent an item id — name the type.',
            '- Shift an item between your own components with the move_item tool: a carried one, or an equipped one (which re-equips on the new component under the same fit rule). Name the item type plus the comp-… it is on and the comp-… that will hold it; the destination must have free volume for it. It still counts toward your per-round action budget.',
            ...(maxChat > 0 ? ['- Keep chat messages under 25 words, in character, no fourth-wall breaks.'] : []),
            '',
            'How you respond:',
            '- Act only through the available tools — the tool calls ARE your content. Never write JSON, code, XML, or tool-call markup in your message text.',
            sayLine + '- If nothing is worth doing or saying this round, call the done tool (or respond with no tool call at all — silence is allowed and counts as a finished round).'
        ].join('\n');
    }

    // =========================================================================
    // TRANSCRIPT (per-NPC round history: the Agent View shows every stored
    // round; the model replays only the last LLM_REPLAY_ROUNDS rounds, each
    // anchored by a user message (round number + context snapshot) — spec
    // §6.5. The window is a count, not a size budget — llm-memory-window.md;
    // the context-snapshot cost delta is in
    // decisions/round-anchored-transcript.md)
    // =========================================================================

    /**
     * Returns the replayable message history for the LLM: for each of the
     * LAST LLM_REPLAY_ROUNDS stored rounds — the replay tail of the inspector
     * buffer — a user message anchoring the round (the round number plus the
     * context snapshot saved for it; legacy entries carry the number alone)
     * followed by every group (one per in-round LLM call — the agent loop,
     * spec §6.5) with its assistant tool-call message, then one tool-role
     * result per call. Legacy entries ({ assistant, results? } / { error })
     * are still playable as single-call history. Follows the relaxed
     * _validateMessages contract (assistant content: null + tool_calls; tool
     * messages: content + tool_call_id).
     * `upToRound` (optional) bounds the replay to the rounds stored BEFORE it,
     * which is what makes an exact reconstruction of a past request possible:
     * the request sent in round N replayed exactly the rounds that were stored
     * before N ({@link _lastSentRequest},
     * wiki/decisions/inspector-shows-last-request.md). Without it the behaviour
     * is unchanged.
     * @private
     */
    _transcriptFor(npcEntityId, { upToRound } = {}) {
        // Only the last LLM_REPLAY_ROUNDS rounds of the inspector buffer are
        // ever replayed (spec §6.5). Nothing here is shed by size: a round that
        // wrote a lot costs a lot on every later replay, and LLMController sends
        // the assembled body as-is — so this slice, not a budget, is what bounds
        // the prompt.
        const stored = this._transcripts.get(npcEntityId) || [];
        // Undated (legacy) entries stay in: they were in the buffer at send time,
        // and their absence would make the reconstruction wrong rather than honest.
        const eligible = Number.isInteger(upToRound)
            ? stored.filter((entry) => !Number.isInteger(entry?.round) || entry.round < upToRound)
            : stored;
        const rounds = eligible.slice(-LLM_REPLAY_ROUNDS);
        const messages = [];
        for (const entry of rounds) {
            if (!entry || typeof entry !== 'object') continue;
            // One group per in-round LLM call (spec §6.5); legacy entries with
            // an assistant are treated as single-call history. Entries with no
            // groups (error / guard stops) replay nothing.
            const groups = (entry.groups && Array.isArray(entry.groups))
                ? entry.groups
                : (entry.assistant ? [entry] : []);
            if (groups.length === 0) continue;
            // Each replayed round is anchored by a user message — the round
            // number plus the context snapshot saved for that round (spec §6.5;
            // decisions/round-anchored-transcript.md). Identical shape to the
            // live round's anchor in runRound; legacy / guard-stop entries with
            // no saved snapshot get the round number alone.
            const anchorParts = [];
            if (typeof entry.round === 'number') {
                anchorParts.push('round ' + entry.round);
            }
            if (typeof entry.context === 'string' && entry.context.length > 0) {
                anchorParts.push(entry.context);
            }
            if (anchorParts.length > 0) {
                messages.push({ role: 'user', content: anchorParts.join('\n\n') });
            }
            for (const group of groups) {
                if (!group || !group.assistant) continue;
                const assistantMessage = group.assistant;
                const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
                // A replayed assistant message keeps either content or tool_calls.
                // Degenerate / scaffold content was already replaced by the
                // neutral placeholder in _sanitizeAssistantMessage before the
                // group was stored, so no broken output can re-prime a round.
                const hasContent =
                    typeof assistantMessage.content === 'string' && assistantMessage.content.length > 0;
                if (hasContent || toolCalls.length > 0) {
                    const replay = {
                        role: 'assistant',
                        content: hasContent ? assistantMessage.content : null,
                        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                    };
                    // Re-send the model's own reasoning_content when the
                    // provider produced one: reasoning models served via the
                    // OpenAI-compatible endpoint expect their reasoning
                    // replayed in multi-turn (same as the fresh-turn
                    // _lastAssistantReplay handling).
                    if (typeof assistantMessage.reasoning_content === 'string') {
                        replay.reasoning_content = assistantMessage.reasoning_content;
                    }
                    messages.push(replay);
                }
                const results = Array.isArray(group.results) ? group.results : [];
                const nameCounts = {};
                for (const call of toolCalls) {
                    const fn = call?.function;
                    const name = fn && typeof fn.name === 'string' ? fn.name : '';
                    const occurrence = (nameCounts[name] = (nameCounts[name] || 0) + 1) - 1;
                    if (!fn || typeof fn.name !== 'string') continue;
                    const r = results.find(x => x?.id === call?.id) || {};
                    messages.push({
                        role: 'tool',
                        // Stable unique id when the model omitted one.
                        tool_call_id: (typeof call?.id === 'string' && call.id !== '')
                            ? call.id
                            : `call-${npcEntityId}-${entry.round}-${occurrence}`,
                        content: JSON.stringify({
                            success: Boolean(r.success),
                            ...(r.detail ? { error: r.detail } : {}),
                            ...(r.list ? { list: r.list } : {})
                        })
                    });
                }
            }
        }
        return messages;
    }
    /**
     * Appends one round to the NPC's round history (capped at
     * LLM_AGENT_VIEW_HISTORY_ROUNDS — the Agent View inspector window).
     * Entry shapes (spec §6.5): { groups: [...], note?, error?, context? } —
     * the in-round agent loop (one group per LLM call, each { assistant,
     * results }) plus the note explaining why the round ended (done, no
     * response, prose-ignored, degenerated, iterations exhausted, LLM
     * error code), and the context snapshot that round saw (round-anchored
     * transcript; decisions/round-anchored-transcript.md) — or { error }
     * (guard stops such as NPC_GONE) or the legacy { assistant?, results? }
     * (single-call history). Replay reads only the last LLM_REPLAY_ROUNDS
     * via _transcriptFor (each stored round anchored by its user message);
     * the inspector reads all stored rounds via _getTranscriptRounds.
     * @private
     */
    _storeTranscript(npcEntityId, round, entry) {
        const rounds = this._transcripts.get(npcEntityId) || [];
        rounds.push({ round, ...entry });
        this._transcripts.set(
            npcEntityId,
            rounds.slice(-LLM_AGENT_VIEW_HISTORY_ROUNDS)
        );
    }

    /**
     * The request the model LAST RECEIVED, reconstructed from stored state —
     * never recomposed (wiki/decisions/inspector-shows-last-request.md).
     *
     * Why reconstruction and not recomposition: the request that went out is
     * `_transcriptFor(entity)` + the round's anchor (`round N` + the context
     * snapshot) + the feedback of every earlier call in that round. All of it is
     * stored or derivable — the replay is a pure function of the transcript
     * buffer, the snapshot is saved with the round (`_storeTranscript`), and the
     * feedback is rebuilt with the very builder `runRound` appended
     * (`_buildFeedbackMessages`). So this is the array that went out, assembled
     * the same way — and a unit test pins it against the bytes a provider
     * actually received.
     *
     * Honest limits, surfaced rather than hidden: `system` and `tools` are
     * recomputed at view time (storing them per round would cost megabytes, and
     * the tool list is already exposed separately); the reconstruction is exact
     * only for rounds still resident in the buffer and while `LLM_REPLAY_ROUNDS`
     * has not changed since.
     *
     * @param {string} npcEntityId
     * @param {Object} [view] - recomputed pair to accompany the messages
     * @param {string|null} [view.system=null] - the system prompt as composed now
     * @param {Array} [view.tools=[]] - the tool set as built now
     * @returns {{ round: number, system: string|null, tools: Array,
     *   messages: Array<Object> }|null} null when nothing has been sent, or when
     *   the round cannot be dated (a legacy entry with no round number — the
     *   anchor text cannot be rebuilt, and guessing one would be a lie).
     * @private
     */
    _lastSentRequest(npcEntityId, { system = null, tools = [] } = {}) {
        const entries = this._transcripts?.get(npcEntityId) || [];
        // A stored context snapshot means the anchor was composed and the request
        // went out (the guard stops never reach context build).
        let sent = null;
        for (const entry of entries) {
            if (entry && Number.isInteger(entry.round)
                && typeof entry.context === 'string' && entry.context.length > 0) {
                sent = entry;
            }
        }
        if (!sent) return null;
        // Legacy entries ({ assistant, results }) replay as a single call, same
        // rule as _transcriptFor.
        const groups = Array.isArray(sent.groups)
            ? sent.groups
            : (sent.assistant ? [sent] : []);
        const messages = [
            ...this._transcriptFor(npcEntityId, { upToRound: sent.round }),
            { role: 'user', content: `round ${sent.round}\n\n${sent.context}` }
        ];
        // The round's own agent loop: every call but the LAST was followed by
        // another request, so its feedback (assistant message, tool results, the
        // nudge) is inside the request reconstructed here. The final group's
        // assistant message is a response — never part of a request.
        for (const group of groups.slice(0, -1)) {
            messages.push(...this._buildFeedbackMessages(group));
        }
        return { round: sent.round, system, tools, messages };
    }

    // =========================================================================
    // AGENT VIEW — public inspector (dev tab, GET /llm/agent/:entityId)
    //
    // Two views, and the difference is the whole point
    // (wiki/decisions/inspector-shows-last-request.md):
    //   lastRequest — THE EXACT request the model last received, reconstructed
    //     from stored state (`_lastSentRequest`): the replay the round runner
    //     would emit for that round plus its saved `round N` anchor. This is the
    //     only "what does the agent see" view that is true.
    //   context — a fresh composition of the ROOM (observe: false: the room's
    //     perception window, the world-event tail, the room transcript tail).
    //     It is what the room holds right now, NOT what any agent was sent: the
    //     agent's own window was consumed by its turn and cannot be reproduced
    //     (2026-11-02, and wiki/decisions/current-round-events.md for the tails).
    //
    // Reuses the EXACT round-runner logic (_resolveNpcConfig, _buildTools,
    // _buildSystemPrompt, _safeGenerateInstincts), so the system prompt and the
    // tool set are byte-identical to what a live round is handed. The transcript
    // section shows the FULL inspector history: every stored round (capped at
    // LLM_AGENT_VIEW_HISTORY_ROUNDS), each with all of its in-round LLM calls
    // (the loop's subcalls) and per-call results. Read-only: never mutates round
    // state and never consumes any agent's cursor.
    // =========================================================================

    /**
     * Builds a plain, serializable snapshot of one agent's LLM-facing state.
     * @param {string} entityId - Typed entity id ("ent-uuid").
     * @param {Object} [options] - Optional context overrides ({ maxEntities,
     *   maxEvents, maxChat }) forwarded to buildContext.
     * @returns {{
     *   entityId: string, name: string|null,
     *   room: { id: string|null, name: string|null },
     *   isNpc: boolean, deterministicBrain: boolean,
     *   config: Object, systemPrompt: string|null,
     *   context: { text: string, data: Object|null, stats: Object|null },
     *   tools: Array, instincts: Array,
     *   registry: Object<string, Object>,
     *   transcriptRounds: Array<{ round: number|null, note: string|null,
     *     error: string|null, context: string|null,
     *     groups: Array<{ content: string|null,
     *       reasoning_content: string|null, tool_calls: Array|null,
     *       results: Array }> }>,
     *   lastRequest: { round: number, system: string|null, tools: Array,
     *     messages: Array<{ role: string, content: string|null, tool_calls?: Array }> }
     *     | null - the exact request the model last received (null when nothing
     *     has been sent yet, or when the round cannot be dated)
     *   error: string|null
     * }}
     */
    describeAgentView(entityId, options = {}) {
        const out = {
            entityId: typeof entityId === 'string' ? entityId : null,
            name: null,
            room: { id: null, name: null },
            isNpc: false,
            deterministicBrain: false,
            config: null,
            systemPrompt: null,
            context: { text: '', data: null, stats: null },
            tools: [],
            instincts: [],
            registry: {},
            transcriptRounds: [],
            lastRequest: null,
            error: null
        };

        const wsc = this.worldStateController;

        const entity = typeof wsc?.getEntity === 'function' ? wsc.getEntity(entityId) : null;
        if (!entity || typeof entity !== 'object') {
            out.error = 'ENTITY_NOT_FOUND';
            return out;
        }
        out.name = entity.name ?? null;
        const rooms = typeof wsc?.getRooms === 'function' ? wsc.getRooms() : {};
        if (entity.location && rooms[entity.location]) {
            out.room = { id: entity.location, name: rooms[entity.location].name ?? null };
        } else {
            out.room = { id: entity.location ?? null, name: null };
        }
        out.isNpc = entity.isNPC === true;

        // Deterministic AI: the LLM never runs for these (deterministic brain
        // handles them). Flag it so the view is honest.
        try {
            if (hasDeterministicBrain(entity)) out.deterministicBrain = true;
        } catch (err) {
            // ignore — flag only on success; never block the view.
        }

        // Same NPC config resolution as the round runner.
        const npc = { entity, config: this._resolveNpcConfig(entity) };
        out.config = npc.config;

        // Same system-prompt builder + room name as the round runner.
        try {
            out.systemPrompt = this._buildSystemPrompt(npc, this._roomName(entity));
        } catch (err) {
            out.systemPrompt = null;
        }

        // Same live instinct generation as the round runner.
        let instincts;
        try {
            instincts = this._safeGenerateInstincts(entityId) ?? [];
        } catch (err) {
            instincts = [];
        }
        out.instincts = instincts;

        // includeChat flag: same rule as the round runner — explicit 0 disables
        // chat; anything else falls back to the default.
        let includeChat;
        try {
            const rawMaxChat = npc.config?.maxChatMessagesPerRound;
            const maxChat = (rawMaxChat === 0) ? 0 : this._asPositiveInt(rawMaxChat, DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND);
            includeChat = maxChat > 0;
        } catch (err) {
            includeChat = false;
        }

        // Byte-identical tool set to what the LLM is handed.
        try {
            out.tools = this._buildTools({ includeChat, instincts });
        } catch (err) {
            out.tools = [];
        }

        // Action registry (source of the execute_action enum).
        try {
            const registry = typeof wsc?.actionController?.getRegistry === 'function'
                ? wsc.actionController.getRegistry()
                : {};
            out.registry = registry && typeof registry === 'object' ? registry : {};
        } catch (err) {
            out.registry = {};
        }

        // A fresh composition of the ROOM — NOT what the LLM was sent (that is
        // `lastRequest` below). `observe: false`, so it reads the ROOM's recent
        // window instead of the agent's pending one. The inspector looks; only
        // the brain observes. Reading the
        // agent's window here failed twice over (2026-11-02): consuming it made
        // every panel open erase what the agent was about to perceive, and a
        // non-consuming peek of it still showed `(none)`, because the round
        // runner reads every round and the agent's own window is empty by the
        // time anyone opens the panel — while the agent's transcript carried the
        // blow. The room window is the one that shows an operator what happened.
        try {
            const ctx = this.llmContextController?.buildContext
                ? this.llmContextController.buildContext(entityId, { instincts, ...options, observe: false })
                : { text: '', data: null, stats: null };
            out.context = ctx && typeof ctx === 'object' ? ctx : { text: '', data: null, stats: null };
        } catch (err) {
            try {
                out.context.text = this._minimalContextLine(entity);
            } catch (e) {
                out.context.text = '';
            }
            out.context.data = null;
            out.context.stats = null;
        }

        // Full inspector transcript history: every stored round (oldest →
        // newest; the client renders newest first), each with all of its
        // in-round LLM calls (subcalls) and per-call results.
        try {
            out.transcriptRounds = this._getTranscriptRounds(entityId);
        } catch (err) {
            out.transcriptRounds = [];
        }

        // The exact request that went out — reconstructed, never recomposed.
        // wiki/decisions/inspector-shows-last-request.md.
        try {
            out.lastRequest = this._lastSentRequest(entityId, {
                system: out.systemPrompt, tools: out.tools
            });
        } catch (err) {
            // why: the inspector must never fail because of one derived view —
            // null says "this one could not be built", an empty array would say
            // "nothing was sent".
            out.lastRequest = null;
        }

        return out;
    }

    /**
     * All stored transcript rounds for an NPC (the Agent View inspector
     * history — the full depth of the _transcripts buffer, capped at
     * LLM_AGENT_VIEW_HISTORY_ROUNDS), oldest → newest, each normalized for
     * client display: the round number, the note explaining why the round
     * ended (done, prose-ignored, iterations exhausted, LLM error code,
     * ...), the error when the round died without LLM calls (NPC_GONE), and
     * every group of the in-round agent loop (one per LLM call — the
     * subcalls): the assistant content / reasoning / tool_calls plus one
     * result per tool call. Legacy entries ({ assistant, results })
     * normalize as a single-call group.
     * @private
     * @param {string} entityId
     * @returns {Array<{ round: number|null, note: string|null,
     *   error: string|null, context: string|null,
     *   groups: Array<Object> }>}
     */
    _getTranscriptRounds(entityId) {
        const entries = Array.from((this._transcripts?.get(entityId)) || []);
        const out = [];
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            // One group per in-round LLM call (spec §6.5); legacy entries
            // (guard stops / single-call history) count as one group.
            const groups = (entry.groups && Array.isArray(entry.groups))
                ? entry.groups
                : (entry.assistant ? [entry] : []);
            out.push({
                round: (typeof entry.round === 'number') ? entry.round : null,
                note: (typeof entry.note === 'string') ? entry.note : null,
                error: (typeof entry.error === 'string') ? entry.error : null,
                context: (typeof entry.context === 'string') ? entry.context : null,
                groups: groups
                    .filter(g => g && typeof g === 'object' && g.assistant)
                    .map(g => this._normalizeTranscriptGroup(g))
            });
        }
        return out;
    }

    /**
     * Projects one round group (one LLM call) onto the inspector shape:
     * assistant content / reasoning / tool_calls plus the per-call results
     * ({ id, success, detail?, list? }). The raw stored shape is the
     * replay-ready message; this projection keeps exactly what the view
     * shows. @private
     * @param {Object} group - one _buildRoundGroup entry ({ assistant,
     *   results }).
     * @returns {{ content: string|null, reasoning_content: string|null,
     *   tool_calls: Array|null, results: Array }}
     */
    _normalizeTranscriptGroup(group) {
        const assistant = group.assistant;
        return {
            content: (typeof assistant.content === 'string') ? assistant.content : null,
            reasoning_content: (typeof assistant.reasoning_content === 'string') ? assistant.reasoning_content : null,
            tool_calls: (assistant.tool_calls && Array.isArray(assistant.tool_calls)) ? assistant.tool_calls : null,
            results: (group.results && Array.isArray(group.results)) ? group.results : []
        };
    }
    // =========================================================================
    // TOOL-CALL PARSING
    // =========================================================================

    /**
     * Normalizes the model's tool_calls into dispatchable groups.
     * Malformed `arguments` JSON → the call is treated as INVALID with error
     * `malformed tool arguments` (it still counts as an execute_action/speak
     * failure for retry purposes via args.__malformed).
     *
     * @param {Object} message - The raw choices[0].message.
     * @returns {{ speaks: Array<{id: string, args: Object}>, actions: Array<{id: string, args: Object}>, instincts: Array<{id: string, args: Object}>, approaches: Array<{id: string, args: Object}>, doors: Array<{id: string, args: Object}>, crafts: Array<{id: string, args: Object}>, equips: Array<{id: string, args: Object}>, unequips: Array<{id: string, args: Object}>, moves: Array<{id: string, args: Object}>, discoveries: Array<{id: string, kind: string, args: Object}>, done: boolean, prose: string|null }}
     * @private
     */
    _parseToolCalls(message) {
        const speaks = [];
        const actions = [];
        const instincts = [];
        const approaches = [];
        const doors = [];
        const crafts = [];
        const equips = [];
        const unequips = [];
        const moves = [];
        const discoveries = [];
        // Did the model call the done tool? (no args; the call itself is the
        // round-end signal — spec §6.5.)
        let done = false;
        // PROTOCOL B (spec §6.4): prose is never interpreted as an intent —
        // it is only stored (see runRound, where content is ignored and the
        // round is treated as the model "chose silence"). Keeping prose out of
        // the tool lists lets the "no tool calls" stop condition be decided
        // from the parsed result alone.
        const prose = (message && typeof message.content === 'string' && message.content.trim() !== '')
            ? message.content
            : null;

        const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const call of toolCalls) {
            const fn = call?.function;
            const name = fn && typeof fn.name === 'string' ? fn.name : '';
            let args = {};
            if (fn) {
                const raw = fn.arguments;
                if (typeof raw === 'string') {
                    if (raw.trim() === '') {
                        args = {};
                    } else {
                        try {
                            const parsed = JSON.parse(raw);
                            args = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
                        } catch {
                            args = { __malformed: 'malformed tool arguments' };
                        }
                    }
                } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    args = raw; // some backends send an object directly
                }
            }
            const entry = { id: typeof call?.id === 'string' ? call.id : '', args };
            if (name === 'speak_in_room') speaks.push(entry);
            else if (name === 'execute_action') actions.push(entry);
            else if (name === 'use_instinct') instincts.push(entry);
            else if (name === 'toApproach') approaches.push(entry);
            else if (name === 'use_door') doors.push(entry);
            else if (name === 'craft') crafts.push(entry);
            else if (name === 'equip_item') equips.push(entry);
            else if (name === 'unequip_item') unequips.push(entry);
            else if (name === 'move_item') moves.push(entry);
            else if (name === 'get_actions') {
                const filter = entry.args.filter;
                discoveries.push({
                    id: entry.id,
                    kind: 'get_actions',
                    args: { filter: (filter && typeof filter === 'string') ? filter : undefined }
                });
            } else if (name === 'get_instincts') {
                const filter = entry.args.filter;
                discoveries.push({
                    id: entry.id,
                    kind: 'get_instincts',
                    args: { filter: (filter && typeof filter === 'string') ? filter : undefined }
                });
            } else if (name === 'get_crafts') {
                const filter = entry.args.filter;
                discoveries.push({
                    id: entry.id,
                    kind: 'get_crafts',
                    args: { filter: (filter && typeof filter === 'string') ? filter : undefined }
                });
            } else if (name === LLM_AGENT_DONE_TOOL_NAME) {
                done = true;
            }
            // Unknown tool names: ignored (the schema is closed; the model is
            // told "respond ONLY with tool calls" from the known set).
        }
        return { speaks, actions, instincts, approaches, doors, crafts, equips, unequips, moves, discoveries, done, prose };
    }

    // =========================================================================
    // PRE-VALIDATION (spec §6.3.5 — the model is never trusted)
    // =========================================================================

    /**
     * Pre-execution validation of one execute_action call:
     *   - actionName exists in the data registry;
     *   - the ACTOR is always the NPC (injected here — the model's value, if
     *     any, is discarded);
     *   - typed-ID hygiene for every comp-/ent-/item- argument;
     *   - capability gate: canExecute must be non-empty for the NPC.
     *
     * @param {string} npcEntityId
     * @param {Object} args - Parsed tool arguments.
     * @returns {{ ok: true, params: Object } | { ok: false, error: string }}
     */
    _prevalidateAction(npcEntityId, args) {
        if (!args || typeof args !== 'object') {
            return { ok: false, error: 'malformed tool arguments' };
        }
        if (args.__malformed) {
            return { ok: false, error: args.__malformed };
        }

        const actionName = args.actionName;
        const registry = this.worldStateController?.actionController?.getRegistry?.() || {};
        if (typeof actionName !== 'string' || !registry[actionName]) {
            return { ok: false, error: `unknown action "${actionName}"` };
        }

        // ID hygiene: any typed-ID argument must pass its prefix check.
        const idChecks = [
            ['targetComponentId', IdResolver.isCompId],
            ['componentId', IdResolver.isCompId],
            ['targetEntityId', IdResolver.isEntityId],
            ['itemId', IdResolver.isItemId]
        ];
        for (const [key, check] of idChecks) {
            const value = args[key];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'string' || !check(value)) {
                return { ok: false, error: `invalid id format: ${key}="${value}"` };
            }
        }
        for (const key of ['targetX', 'targetY']) {
            const value = args[key];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return { ok: false, error: `invalid number format: ${key}="${value}"` };
            }
        }

        // Capability gate: the NPC must be able to execute the action right now.
        const actions = this.worldStateController?.getActionsForEntity?.(npcEntityId) || {};
        const canExecute = actions[actionName]?.canExecute;
        if (!Array.isArray(canExecute) || canExecute.length === 0) {
            return { ok: false, error: `action not executable right now: ${actionName}` };
        }

        // Build the executeAction params — actor is ALWAYS the NPC (the model
        // can never choose who acts). Whitelist of known keys only.
        const params = { entityId: npcEntityId };
        if (typeof args.targetComponentId === 'string') params.targetComponentId = args.targetComponentId;
        if (typeof args.componentId === 'string') params.componentId = args.componentId;
        if (typeof args.targetEntityId === 'string') params.targetEntityId = args.targetEntityId;
        if (typeof args.itemId === 'string') params.itemId = args.itemId;
        if (typeof args.itemType === 'string') params.itemType = args.itemType;
        if (typeof args.machineType === 'string') params.machineType = args.machineType;
        if (typeof args.targetX === 'number') params.targetX = args.targetX;
        if (typeof args.targetY === 'number') params.targetY = args.targetY;
        if (typeof args.targetRoomId === 'string') params.targetRoomId = args.targetRoomId;

        return { ok: true, params };
    }

    /**
     * Pre-execution validation for one toApproach call:
     *   - targetEntityId must be a non-empty, well-formed, typed entity ID
     *     that resolves to a live entity;
     *   - the target must share the NPC's room — spatial coordinates are per
     *     room and the agent's context (Feature B) is same-room perception,
     *     so cross-room "approach" is intentionally out of scope (door travel
     *     goes through the use_door tool);
     *   - the NPC must be able to execute the registered `move` action right
     *     now (the same capability gate as execute_action).
     *
     * @param {string} npcEntityId
     * @param {Object} args - Parsed tool arguments ({ targetEntityId }).
     * @returns {{ ok: true, params: Object } | { ok: false, error: string }}
     * @private
     */
    _prevalidateApproach(npcEntityId, args) {
        if (!args || typeof args !== 'object') {
            return { ok: false, error: 'malformed tool arguments' };
        }
        if (args.__malformed) {
            return { ok: false, error: args.__malformed };
        }

        const targetEntityId = args.targetEntityId;
        if (typeof targetEntityId !== 'string' || targetEntityId.trim() === '') {
            return { ok: false, error: 'missing "targetEntityId"' };
        }
        if (!IdResolver.isEntityId(targetEntityId)) {
            return { ok: false, error: `invalid id format: targetEntityId="${targetEntityId}"` };
        }

        const self = this.worldStateController?.getEntity?.(npcEntityId);
        const target = this.worldStateController?.getEntity?.(targetEntityId);
        if (!self || !target) {
            return { ok: false, error: self ? 'target entity not found' : 'actor entity not found' };
        }
        if (self.location !== target.location) {
            return {
                ok: false,
                error: 'target not in your room — cross a door with the use_door tool first'
            };
        }
        if (!target.spatial || typeof target.spatial.x !== 'number' || typeof target.spatial.y !== 'number') {
            return { ok: false, error: 'target has no spatial position' };
        }

        // Capability gate: the NPC must be able to execute move right now.
        const actions = this.worldStateController?.getActionsForEntity?.(npcEntityId) || {};
        const canExecute = actions.move?.canExecute;
        if (!Array.isArray(canExecute) || canExecute.length === 0) {
            return { ok: false, error: 'move not executable right now (insufficient movement stats)' };
        }

        return {
            ok: true,
            params: { targetX: target.spatial.x, targetY: target.spatial.y }
        };
    }

    // =========================================================================
    // DISPATCH
    // =========================================================================

    /**
     * Dispatches one validated action: queue through the turn system while
     * planning (respecting the cap), immediate pipeline fallback otherwise.
     *
     * @param {string} npcEntityId - The NPC's typed entity ID (the actor — server-injected).
     * @param {string} actionName - Registry action name (validated by _prevalidateAction).
     * @param {Object} params - Validated executeAction params (no entityId needed; the actor is the 1st arg).
     * @returns {{ actionName: string, queued: boolean, queueId?: string, success: boolean, detail?: string }}
     * @private
     */
    _dispatchAction(npcEntityId, actionName, params) {
        const clean = { ...params };
        delete clean.entityId; // the actor is always injected as the 2nd arg

        const turns = this.turnSystemController;
        const phase = turns?.getRoundState?.()?.phase;
        const turnsActive = turns && phase !== undefined; // phase only exists when a tick clock runs
        if (turnsActive && phase === TURN_PHASES.PLANNING) {
            const q = turns.queueAction(npcEntityId, actionName, clean, 'npc');
            if (q?.success) {
                return { actionName, queued: true, queueId: q.queueId, success: true };
            }
            if (q?.code === 'TURNS_DISABLED') {
                // Defensive: phase said planning but the clock is gone — treat as non-turn.
            } else {
                // PLANNING_CLOSED / QUEUE_FULL / ENTITY_NOT_FOUND / ACTION_NOT_FOUND.
                // The round runner records this outcome under the LLM tool name
                // (via _recordImmediateOutcome on every action path, success and
                // failure alike) so it is named the way the agent called it.
                return { actionName, queued: false, success: false, detail: q?.error || q?.code || 'queue rejected' };
            }
        }

        // The LLM response landed OUTSIDE the planning window (e.g. it resolved
        // in the resolution/settle phase, or even a later round) in a world
        // where the turn system IS running. Spec §5.8: a late NPC response
        // must make the NPC SILENT this round — never bypass the turn system
        // with an immediate execution. Only TURNS_DISABLED / no-turn worlds
        // may fall through to the immediate pipeline.
        if (turnsActive) {
            const detail = 'planning window closed';
            Logger.info(`[LLMAgent] ${npcEntityId}: LLM response landed in phase "${phase}" — planning window closed, action "${actionName}" dropped (no immediate execution in a turn world).`);
            // Recorded by the round runner under the LLM tool name.
            return { actionName, queued: false, success: false, detail };
        }

        // Immediate fallback (non-turn worlds/tests only).
        try {
            const exec = this.worldStateController?.executeAction?.(actionName, npcEntityId, clean);
            if (exec?.success) {
                return { actionName, queued: false, success: true, detail: 'executed immediately' };
            }
            // Recorded by the round runner under the LLM tool name.
            return { actionName, queued: false, success: false, detail: exec?.error || 'execution failed' };
        } catch (err) {
            // Recorded by the round runner under the LLM tool name.
            return { actionName, queued: false, success: false, detail: err?.message || String(err) };
        }
    }

    /**
     * Dispatches one validated toApproach call. Approach is NOT a new action:
     * it is the registered `move` action aimed at the target's live coordinates
     * (resolved in _prevalidateApproach). Reusing the registry action keeps
     * movement data-driven and preserves everything about `move` for free:
     * the requirement, the deltaSpatial consequence (one step capped by speed
     * and by the distance to the target), the broadcast, and the queue-while
     * planning / immediate-fallback semantics. The NPC gets the identical turn
     * effect, but under the tool name it understands (toApproach) in its
     * transcript.
     *
     * @param {string} npcEntityId
     * @param {Object} params - { targetX, targetY } from _prevalidateApproach.
     * @returns {{ actionName: string, queued: boolean, queueId: string|undefined, success: boolean, detail: string|undefined }}
     * @private
     */
    _dispatchApproach(npcEntityId, params) {
        const dispatch = this._dispatchAction(npcEntityId, 'move', {
            targetX: params.targetX,
            targetY: params.targetY
        });
        return {
            actionName: 'toApproach',
            queued: dispatch.queued,
            queueId: dispatch.queueId,
            success: dispatch.success,
            detail: dispatch.queued
                ? `move queued toward target (targetX=${params.targetX}, targetY=${params.targetY})`
                : (dispatch.success ? 'executed immediately' : (dispatch.detail || 'execution failed'))
        };
    }

    /**
     * Pre-execution validation for one use_door call:
     *   - `door` must be a bounded, non-empty string (a name, never an id);
     *   - the door must be a connection of the room the NPC is IN — the room's
     *     own `connections` keys are the allowlist (SEC-4: model output is only
     *     ever matched against data, never used to build a destination), and the
     *     model can never name a room, so it can never route an entity through a
     *     door that is not under its own feet;
     *   - the NPC must be able to execute the registered `crossDoor` action right
     *     now (the same capability gate as execute_action / toApproach);
     *   - the NPC must be standing within the action's declared reach of that
     *     door (see the reach check below — the world enforces the same rule).
     *
     * Only the door name travels onward to the dispatcher: the world decides
     * where the entity ends up, and the outcome line reads the room back from it
     * (see _dispatchDoor).
     *
     * @param {string} npcEntityId
     * @param {Object} args - Parsed tool arguments ({ door }).
     * @returns {{ ok: true, params: { door: string } } | { ok: false, error: string }}
     * @private
     */
    _prevalidateDoor(npcEntityId, args) {
        if (!args || typeof args !== 'object') {
            return { ok: false, error: 'malformed tool arguments' };
        }
        if (args.__malformed) {
            return { ok: false, error: args.__malformed };
        }

        const door = args.door;
        if (typeof door !== 'string' || door.trim() === '') {
            return { ok: false, error: 'missing "door"' };
        }
        if (door.length > DOOR_NAME_MAX_LENGTH) {
            return { ok: false, error: `door name too long (${DOOR_NAME_MAX_LENGTH} chars max)` };
        }

        const self = this.worldStateController?.getEntity?.(npcEntityId);
        if (!self) return { ok: false, error: 'actor entity not found' };

        const rooms = this.worldStateController?.getRooms?.() || {};
        const room = self.location ? rooms[self.location] : null;
        if (!room) return { ok: false, error: 'your current room is not in the world' };

        const connections = room.connections || {};
        if (!Object.hasOwn(connections, door)) {
            const here = Object.keys(connections);
            return {
                ok: false,
                error: here.length > 0
                    ? `no door "${door}" in your room (doors here: ${here.join(', ')})`
                    : `no door "${door}" in your room (this room has no doors)`
            };
        }

        // Capability gate: the NPC must be able to execute crossDoor right now.
        const actions = this.worldStateController?.getActionsForEntity?.(npcEntityId) || {};
        const canExecute = actions[CROSS_DOOR_ACTION]?.canExecute;
        if (!Array.isArray(canExecute) || canExecute.length === 0) {
            return { ok: false, error: `${CROSS_DOOR_ACTION} not executable right now (insufficient movement stats)` };
        }

        // Reach: the world refuses a crossing from anywhere but the door itself
        // (DoorTraversalHandler), and the same verdict is asked HERE so the model
        // learns it while it still holds the action — a rejected pre-validation
        // costs no world action, a rejected crossing does. Both numbers come from
        // the world (door geometry + the action's declared range), never from the
        // model, so a door can never be reached by naming a coordinate.
        const reach = measureDoorReach({
            worldStateController: this.worldStateController,
            entity: self,
            door,
            actionName: CROSS_DOOR_ACTION
        });
        if (reach && !reach.reachable) {
            return {
                ok: false,
                error: `"${door}" is ${Math.round(reach.distance)} units away — walk to its position first (reach ${reach.reach})`
            };
        }

        return { ok: true, params: { door } };
    }

    /**
     * Dispatches one validated use_door call as the registered `crossDoor`
     * action (queued during planning, immediate only in non-turn worlds — the
     * same rule as every other world action, so a crossing never overtakes the
     * turn barrier).
     *
     * The outcome line names the rooms the WORLD reports, never the model's
     * expectation. A queued crossing has not happened yet (it lands at the
     * resolution phase), so it is reported as queued and claims no destination —
     * the round that follows reads its room from the world again anyway.
     *
     * @param {string} npcEntityId
     * @param {{ door: string }} params - From _prevalidateDoor.
     * @returns {{ actionName: string, queued: boolean, queueId?: string, success: boolean, detail: string }}
     * @private
     */
    _dispatchDoor(npcEntityId, params) {
        const fromRoomName = this._roomName(this.worldStateController?.getEntity?.(npcEntityId));
        const dispatch = this._dispatchAction(npcEntityId, CROSS_DOOR_ACTION, { door: params.door });

        let detail;
        if (!dispatch.success) {
            detail = dispatch.detail || 'crossing failed';
        } else if (dispatch.queued) {
            detail = `crossDoor queued through "${params.door}"`;
        } else {
            const toRoomName = this._roomName(this.worldStateController?.getEntity?.(npcEntityId));
            detail = `crossed "${params.door}": "${fromRoomName}" -> "${toRoomName}"`;
        }

        return {
            actionName: 'use_door',
            queued: dispatch.queued,
            queueId: dispatch.queueId,
            success: dispatch.success,
            detail
        };
    }

    /**
     * Pre-execution validation for one craft call. The recipe registry is the
     * ONLY source of recipe ids (mirrors _prevalidateAction): unknown recipe
     * ids, malformed args, a component that is not on the acting NPC, and a
     * named ingredient multiset that differs from the recipe's inputs (or an
     * entity that does not hold the required types, across its components,
     * in the needed counts) are all rejected before dispatch. The model
     * never invents recipes.
     * @param {string} npcEntityId
     * @param {Object} args - Parsed craft tool args:
     *   { recipeId: string, ingredients: Array<{type: string, quantity: number}>, componentId: string }.
     * @returns {{ ok: boolean, error?: string, params?: { recipeId: string, componentId: string, itemIds: string[] } }}
     * @private
     */
    _prevalidateCraft(npcEntityId, args) {
        if (!args || typeof args !== 'object') {
            return { ok: false, error: 'malformed tool arguments' };
        }
        if (args.__malformed) {
            return { ok: false, error: args.__malformed };
        }

        const recipeId = args.recipeId;
        if (typeof recipeId !== 'string' || recipeId.trim() === '') {
            return { ok: false, error: 'missing "recipeId"' };
        }

        // The recipe registry is the live source of truth (BUG-018 parity):
        // the model may only craft a recipe id the registry knows.
        const registry = this.worldStateController?.getCraftingRecipes?.() || [];
        if (!Array.isArray(registry)) {
            return { ok: false, error: 'no crafting recipes available' };
        }
        const recipe = registry.find(r => r && r.id === recipeId);
        if (!recipe) {
            return { ok: false, error: `unknown recipe "${recipeId}"` };
        }

        const componentId = args.componentId;
        if (typeof componentId !== 'string' || componentId.trim() === '') {
            return { ok: false, error: 'missing "componentId"' };
        }
        if (!IdResolver.isCompId(componentId)) {
            return { ok: false, error: `invalid id format: componentId="${componentId}"` };
        }

        const self = this.worldStateController?.getEntity?.(npcEntityId);
        if (!self) {
            return { ok: false, error: 'actor entity not found' };
        }
        const component = (self.components || []).find(c => c && c.id === componentId);
        if (!component) {
            return { ok: false, error: `component "${componentId}" not found on entity "${npcEntityId}"` };
        }

        const ingredients = args.ingredients;
        if (!Array.isArray(ingredients) || ingredients.length === 0) {
            return {
                ok: false,
                error: 'ingredients must be a non-empty array of { type, quantity }'
            };
        }
        const named = {};
        for (const ingredient of ingredients) {
            if (!ingredient || typeof ingredient !== 'object') {
                return {
                    ok: false,
                    error: 'each ingredient must be an object with "type" and "quantity"'
                };
            }
            if (typeof ingredient.type !== 'string' || ingredient.type.trim() === '') {
                return { ok: false, error: 'invalid ingredient type (empty or not a string)' };
            }
            if (!Number.isInteger(ingredient.quantity) || ingredient.quantity < 1) {
                return { ok: false, error: 'invalid ingredient quantity (must be an integer >= 1)' };
            }
            named[ingredient.type] = (named[ingredient.type] || 0) + ingredient.quantity;
        }

        // Exact multiset against the recipe's inputs (checkExactInputs
        // semantics): a named type must appear at exactly the recipe's required
        // count, and no type outside the recipe may be named.
        const need = {};
        for (const input of recipe.inputs || []) {
            const t = input && input.type;
            if (typeof t === 'string' && Number.isInteger(input.quantity) && input.quantity > 0) {
                need[t] = (need[t] || 0) + input.quantity;
            }
        }
        if (Object.keys(need).length === 0) {
            return { ok: false, error: `recipe "${recipeId}" has no valid inputs (malformed recipe)` };
        }
        const problems = [];
        for (const type in need) {
            const have = named[type] || 0;
            if (have === 0) {
                problems.push(`missing ${type} x${need[type]}`);
            } else if (have !== need[type]) {
                problems.push(`${type} x${have} given, recipe needs x${need[type]}`);
            }
        }
        for (const type in named) {
            if (!(type in need)) {
                problems.push(`extra ${type} x${named[type]} (not in recipe "${recipeId}")`);
            }
        }
        if (problems.length > 0) {
            return {
                ok: false,
                error: `ingredients do not match recipe "${recipeId}": ${problems.join('; ')}`
            };
        }

        // The ENTITY must hold at least the required count of each type,
        // across ALL of its components (cross-component crafting): the named
        // component only receives the outputs. Only items hosted directly on
        // entity components count — nested items (host = a container item
        // ID) are not consumable, mirroring the transaction's validation.
        const itemsByHost = this.worldStateController?.getEntityItems?.(npcEntityId) || {};
        const entityCompIds = new Set((self.components || []).map(c => c && c.id));
        const topLevel = [];
        for (const [host, list] of Object.entries(itemsByHost)) {
            if (!entityCompIds.has(host)) {
                continue;
            }
            for (const item of list || []) {
                if (item && typeof item.type === 'string') {
                    topLevel.push(item);
                }
            }
        }
        for (const type in need) {
            const held = topLevel.filter(item => item.type === type).length;
            if (held < need[type]) {
                return {
                    ok: false,
                    error: `entity "${npcEntityId}" does not hold ${type} x${need[type]} (holds x${held})`
                };
            }
        }

        // Pick the concrete instances to consume: the first `need[type]`
        // items of each type, walking the entity's components in entity
        // order (deterministic). All ids come from getEntityItems, so they
        // are typed item-… ids; crafting consumes exactly this multiset,
        // no more, no less.
        const itemIds = [];
        for (const type in need) {
            let remaining = need[type];
            for (const comp of self.components || []) {
                if (remaining === 0) {
                    break;
                }
                const matching = (itemsByHost[comp.id] || []).filter(item => item && item.type === type);
                for (const item of matching) {
                    if (remaining === 0) {
                        break;
                    }
                    itemIds.push(item.id);
                    remaining -= 1;
                }
            }
        }

        return {
            ok: true,
            params: { recipeId, componentId, itemIds }
        };
    }

    /**
     * Dispatches one validated craft call: the turn-gate mirror of
     * _dispatchApproach. In a turn world, a response that lands outside the
     * planning window is SILENT for that round (no immediate execution)
     * — spec §5.8. Outside the planning window in a turn world, or in a
     * non-turn world, the real transaction runs via facade.craftItems
     * (which re-validates and performs the consume/produce). The NPC gets the
     * outcome under the tool name it understood (craft) in its transcript.
     *
     * @param {string} npcEntityId
     * @param {Object} params - { recipeId, componentId, itemIds } from _prevalidateCraft.
     * @returns {{ recipeId: string, queued: boolean, success: boolean, detail: string }}
     * @private
     */
    _dispatchCraft(npcEntityId, params) {
        const turns = this.turnSystemController;
        const phase = turns?.getRoundState?.()?.phase;
        const turnsActive = turns && phase !== undefined;
        if (turnsActive && phase === TURN_PHASES.PLANNING) {
            // The real transaction is NOT queued by the turn system (crafting
            // is not a registry action); it runs as an immediate transaction
            // while planning, and is recorded under the tool name by the round
            // runner — same shape as toApproach's immediate fallback, but with
            // no queue entry.
            return this._executeCraftImmediate(npcEntityId, params);
        }
        if (turnsActive) {
            const detail = 'planning window closed';
            Logger.info(`[LLMAgent] ${npcEntityId}: LLM response landed in phase "${phase}" — planning window closed, craft "${params.recipeId}" dropped (no immediate execution in a turn world).`);
            // Recorded by the round runner under the LLM tool name.
            return { recipeId: params.recipeId, queued: false, success: false, detail };
        }

        // Immediate fallback (non-turn worlds / tests only).
        return this._executeCraftImmediate(npcEntityId, params);
    }

    /**
     * Runs the craft transaction on the turn (or non-turn) path: delegates to
     * facade.craftItems, which re-validates (instance checks, exact multiset,
     * volume pre-check) and performs the consume/produce, then formats the
     * outcome for the agent transcript.
     * @param {string} npcEntityId
     * @param {Object} params - { recipeId, componentId, itemIds }.
     * @returns {{ recipeId: string, queued: boolean, success: boolean, detail: string }}
     * @private
     */
    _executeCraftImmediate(npcEntityId, params) {
        try {
            const exec = this.worldStateController?.craftItems?.(
                npcEntityId,
                params.recipeId,
                params.componentId,
                params.itemIds
            );
            if (exec?.success) {
                return {
                    recipeId: params.recipeId,
                    queued: false,
                    success: true,
                    detail: `crafted ${params.recipeId} (consumed [${params.itemIds.join(', ')}], produced ${exec.produced ? exec.produced.length : 0} item${exec.produced && exec.produced.length === 1 ? '' : 's'})`
                };
            }
            return {
                recipeId: params.recipeId,
                queued: false,
                success: false,
                detail: exec?.message || exec?.error || 'craft failed'
            };
        } catch (err) {
            return {
                recipeId: params.recipeId,
                queued: false,
                success: false,
                detail: err?.message || String(err)
            };
        }
    }

    /**
     * The items one component of the NPC hosts DIRECTLY. Items nested inside a
     * container item are not part of this set (they are not equippable) — the
     * same restriction the craft tool applies to its ingredients.
     * @param {string} npcEntityId
     * @param {string} componentId
     * @returns {Array<{ id: string, type: string }>}
     * @private
     */
    _itemsOn(npcEntityId, componentId) {
        const items = this.worldStateController?.getEntityItems?.(npcEntityId)?.[componentId];
        return Array.isArray(items)
            ? items.filter(item => item && typeof item.id === 'string' && typeof item.type === 'string')
            : [];
    }

    /**
     * Pre-execution validation for one equip_item call:
     *   - `itemType` is a bounded, non-empty string and `componentId` a comp-…
     *     id belonging to the ACTING NPC (the model never aims at another
     *     body's part);
     *   - that component must actually carry an item of the named type — the
     *     entity's own inventory is the allowlist (SEC-4: model output is only
     *     ever matched against world data) and the SERVER resolves which
     *     instance, exactly as the craft tool resolves its ingredients. The
     *     model never sees item ids, so it could not name one;
     *   - an item already equipped (or worn) is rejected here, so the model
     *     learns the idempotent case while it still holds the action.
     *
     * The world's gates are deliberately NOT re-implemented here: the clothing
     * fit rule (`wear.minVolume` of free volume — WearLogic) and the
     * strength-to-mass equip gate answer through the dispatch, so the failure
     * text the model reads is the world's own, not a second copy of the rule.
     *
     * @param {string} npcEntityId
     * @param {Object} args - Parsed equip_item args ({ itemType, componentId }).
     * @returns {{ ok: true, params: { itemId: string, itemType: string, componentId: string, wearable: boolean } } | { ok: false, error: string }}
     * @private
     */
    _prevalidateEquip(npcEntityId, args) {
        if (!args || typeof args !== 'object') {
            return { ok: false, error: 'malformed tool arguments' };
        }
        if (args.__malformed) {
            return { ok: false, error: args.__malformed };
        }

        const itemType = args.itemType;
        if (typeof itemType !== 'string' || itemType.trim() === '') {
            return { ok: false, error: 'missing "itemType"' };
        }
        if (itemType.length > ITEM_TYPE_MAX_LENGTH) {
            return { ok: false, error: `itemType too long (${ITEM_TYPE_MAX_LENGTH} chars max)` };
        }

        const componentId = args.componentId;
        if (typeof componentId !== 'string' || componentId.trim() === '') {
            return { ok: false, error: 'missing "componentId"' };
        }
        if (!IdResolver.isCompId(componentId)) {
            return { ok: false, error: `invalid id format: componentId="${componentId}"` };
        }

        const self = this.worldStateController?.getEntity?.(npcEntityId);
        if (!self) return { ok: false, error: 'actor entity not found' };
        if (!(self.components || []).some(c => c && c.id === componentId)) {
            return { ok: false, error: `component "${componentId}" not found on entity "${npcEntityId}"` };
        }

        const hosted = this._itemsOn(npcEntityId, componentId);
        const carried = hosted.find(item => item.type === itemType);
        if (!carried) {
            return {
                ok: false,
                error: hosted.length > 0
                    ? `no "${itemType}" carried on ${componentId} (it holds: ${hosted.map(item => item.type).join(', ')})`
                    : `no "${itemType}" carried on ${componentId} (that component carries nothing)`
            };
        }

        const already = (this.worldStateController?.getEquippedItems?.(npcEntityId) || [])
            .find(eq => eq && eq.itemId === carried.id);
        if (already) {
            return { ok: false, error: `"${itemType}" is already equipped on ${already.componentId}` };
        }

        return {
            ok: true,
            params: {
                itemId: carried.id,
                itemType,
                componentId,
                wearable: getWearMinVolume(this.worldStateController, itemType) !== null
            }
        };
    }

    /**
     * Dispatches one validated equip call under the craft tool's turn
     * discipline: equipping is a self transaction, not a registered action, so
     * it is never queued onto the turn system — it runs while the planning
     * window is open and is dropped in any other phase of a turn world, so an
     * equip never overtakes the turn barrier. In a non-turn world it runs
     * immediately.
     * @param {string} npcEntityId
     * @param {Object} params - From _prevalidateEquip.
     * @returns {{ itemId: string, itemType: string, componentId: string, wearable: boolean, queued: boolean, success: boolean, detail: string }}
     * @private
     */
    _dispatchEquip(npcEntityId, params) {
        const turns = this.turnSystemController;
        const phase = turns?.getRoundState?.()?.phase;
        const turnsActive = turns && phase !== undefined;
        if (turnsActive && phase === TURN_PHASES.PLANNING) {
            return this._executeEquip(npcEntityId, params);
        }
        if (turnsActive) {
            const detail = 'planning window closed';
            Logger.info(`[LLMAgent] ${npcEntityId}: LLM response landed in phase "${phase}" — planning window closed, equip "${params.itemType}" dropped (no immediate execution in a turn world).`);
            return { ...params, queued: false, success: false, detail };
        }
        // Immediate fallback (non-turn worlds / tests only).
        return this._executeEquip(npcEntityId, params);
    }

    /**
     * Runs the equip transaction: a wearable type knocks on the clothes
     * feature's own door (facade.wearItem, which applies the fit rule),
     * anything else on the plain holding-cost equip (facade.equipItem). This
     * method chooses the door and reports the world's words back — it holds no
     * rule of its own.
     * @param {string} npcEntityId
     * @param {Object} params - From _prevalidateEquip.
     * @returns {{ itemId: string, itemType: string, componentId: string, wearable: boolean, queued: boolean, success: boolean, detail: string }}
     * @private
     */
    _executeEquip(npcEntityId, params) {
        const base = { ...params, queued: false };
        try {
            const exec = params.wearable
                ? this.worldStateController?.wearItem?.(npcEntityId, params.itemId, params.componentId)
                : this.worldStateController?.equipItem?.(npcEntityId, params.itemId, params.itemType, params.componentId);
            if (exec?.success) {
                // The world's own line when it has one (wearItem names the
                // component type); the controller's otherwise.
                return {
                    ...base,
                    success: true,
                    detail: exec.message
                        || (params.wearable
                            ? `wore "${params.itemType}" on ${params.componentId}`
                            : `equipped "${params.itemType}" on ${params.componentId}`)
                };
            }
            return { ...base, success: false, detail: exec?.message || exec?.error || 'equip failed' };
        } catch (err) {
            return { ...base, success: false, detail: err?.message || String(err) };
        }
    }

    /**
     * Pre-execution validation for one unequip_item call: a bounded item type
     * the NPC actually has equipped. The equipped set IS the allowlist, and it
     * contains what the NPC is WEARING (the clothes feature stores a worn item
     * as an equipped entry), which is why one tool takes both a knife and a
     * shirt off. When the type is not in the set, the error names what is, so
     * the model can correct the call instead of guessing.
     * @param {string} npcEntityId
     * @param {Object} args - Parsed unequip_item args ({ itemType }).
     * @returns {{ ok: true, params: { eqId: string, itemId: string, itemType: string, componentId: string, wearable: boolean } } | { ok: false, error: string }}
     * @private
     */
    _prevalidateUnequip(npcEntityId, args) {
        if (!args || typeof args !== 'object') {
            return { ok: false, error: 'malformed tool arguments' };
        }
        if (args.__malformed) {
            return { ok: false, error: args.__malformed };
        }

        const itemType = args.itemType;
        if (typeof itemType !== 'string' || itemType.trim() === '') {
            return { ok: false, error: 'missing "itemType"' };
        }
        if (itemType.length > ITEM_TYPE_MAX_LENGTH) {
            return { ok: false, error: `itemType too long (${ITEM_TYPE_MAX_LENGTH} chars max)` };
        }

        const equipped = (this.worldStateController?.getEquippedItems?.(npcEntityId) || [])
            .filter(eq => eq && typeof eq.itemType === 'string');
        const entry = equipped.find(eq => eq.itemType === itemType);
        if (!entry) {
            return {
                ok: false,
                error: equipped.length > 0
                    ? `nothing equipped of type "${itemType}" (equipped: ${equipped.map(eq => eq.itemType).join(', ')})`
                    : `nothing equipped of type "${itemType}" (nothing is equipped)`
            };
        }

        return {
            ok: true,
            params: {
                // eqId, never itemId: the typed equipped-id is what the world
                // looks up first, and it names this instance unambiguously when
                // the same type is equipped twice.
                eqId: entry.eqId,
                itemId: entry.itemId,
                itemType,
                componentId: entry.componentId,
                wearable: getWearMinVolume(this.worldStateController, itemType) !== null
            }
        };
    }

    /**
     * Dispatches one validated unequip call with the same turn discipline as
     * _dispatchEquip (a self transaction: run while planning is open, dropped
     * in any other turn phase, immediate outside a turn world).
     * @param {string} npcEntityId
     * @param {Object} params - From _prevalidateUnequip.
     * @returns {{ itemId: string, itemType: string, componentId: string, wearable: boolean, queued: boolean, success: boolean, detail: string }}
     * @private
     */
    _dispatchUnequip(npcEntityId, params) {
        const turns = this.turnSystemController;
        const phase = turns?.getRoundState?.()?.phase;
        const turnsActive = turns && phase !== undefined;
        if (turnsActive && phase === TURN_PHASES.PLANNING) {
            return this._executeUnequip(npcEntityId, params);
        }
        if (turnsActive) {
            const detail = 'planning window closed';
            Logger.info(`[LLMAgent] ${npcEntityId}: LLM response landed in phase "${phase}" — planning window closed, unequip "${params.itemType}" dropped (no immediate execution in a turn world).`);
            return { ...params, queued: false, success: false, detail };
        }
        // Immediate fallback (non-turn worlds / tests only).
        return this._executeUnequip(npcEntityId, params);
    }

    /**
     * Runs the unequip transaction (facade.unequipItem, keyed by the typed
     * eqId). Taking clothing off is this same call: a worn item is an equipped
     * entry, so the world reverses its carrying cost and drops the entry — and
     * the broadcast re-derives the worn list for the clients.
     * @param {string} npcEntityId
     * @param {Object} params - From _prevalidateUnequip.
     * @returns {{ itemId: string, itemType: string, componentId: string, wearable: boolean, queued: boolean, success: boolean, detail: string }}
     * @private
     */
    _executeUnequip(npcEntityId, params) {
        const base = { ...params, queued: false };
        try {
            const exec = this.worldStateController?.unequipItem?.(npcEntityId, params.eqId);
            if (exec?.success) {
                return {
                    ...base,
                    success: true,
                    detail: exec.message
                        || (params.wearable
                            ? `took "${params.itemType}" off ${params.componentId}`
                            : `unequipped "${params.itemType}" from ${params.componentId}`)
                };
            }
            return { ...base, success: false, detail: exec?.message || exec?.error || 'unequip failed' };
        } catch (err) {
            return { ...base, success: false, detail: err?.message || String(err) };
        }
    }

    /**
     * Pre-execution validation for one move_item call, against the live world
     * (the model only names a type + two of its own comp-…; the server resolves
     * the concrete instance — SEC-4, the entity's inventory is the allow-list):
     *   - `itemType` a bounded, non-empty string; `fromComponentId` and
     *     `toComponentId` comp-… ids belonging to the ACTING NPC (a move is a
     *     self-transaction, so no other body's part can be named);
     *   - the two components are the NPC's own, and distinct from each other.
     *   - the NPC actually holds an item of that type on the source. Resolution
     *     is "equipped-on-source wins": an equipped entry on the source is the
     *     unambiguous, move-safe one (a moved carried copy without its equipped
     *     entry would strand a stale one); it falls back to the directly-carried
     *     copy on the source.
     *   - same-component is a no-op, rejected with a clear "already on" hint.
     *   - destination volume (carried moves) and fit/strength (equipped moves)
     *     are NOT re-checked here: they come back from the world's own doors
     *     (facade.moveItemInEntity / facade.transferEquip), so the failure the
     *     model reads is the world's word — single source of truth.
     * @param {string} npcEntityId
     * @param {Object} args - parsed move_item args ({ itemType, fromComponentId,
     *   toComponentId }).
     * @returns {{ ok: true, params: { itemId, itemType, fromComponentId, toComponentId, kind } } | { ok: false, error }}
     * @private
     */
    _prevalidateMoveItem(npcEntityId, args) {
        if (!args || typeof args !== 'object') {
            return { ok: false, error: 'malformed tool arguments' };
        }
        if (args.__malformed) {
            return { ok: false, error: args.__malformed };
        }

        const itemType = args.itemType;
        if (typeof itemType !== 'string' || itemType.trim() === '') {
            return { ok: false, error: 'missing "itemType"' };
        }
        if (itemType.length > ITEM_TYPE_MAX_LENGTH) {
            return { ok: false, error: `itemType too long (${ITEM_TYPE_MAX_LENGTH} chars max)` };
        }

        const fromComponentId = args.fromComponentId;
        if (typeof fromComponentId !== 'string' || fromComponentId.trim() === '') {
            return { ok: false, error: 'missing "fromComponentId"' };
        }
        if (!IdResolver.isCompId(fromComponentId)) {
            return { ok: false, error: `invalid id format: fromComponentId="${fromComponentId}"` };
        }

        const toComponentId = args.toComponentId;
        if (typeof toComponentId !== 'string' || toComponentId.trim() === '') {
            return { ok: false, error: 'missing "toComponentId"' };
        }
        if (!IdResolver.isCompId(toComponentId)) {
            return { ok: false, error: `invalid id format: toComponentId="${toComponentId}"` };
        }

        const self = this.worldStateController?.getEntity?.(npcEntityId);
        if (!self) return { ok: false, error: 'actor entity not found' };
        const ownComponents = (self.components || []).map(c => c && c.id);
        if (!ownComponents.includes(fromComponentId)) {
            return { ok: false, error: `component "${fromComponentId}" not found on entity "${npcEntityId}"` };
        }
        if (!ownComponents.includes(toComponentId)) {
            return { ok: false, error: `component "${toComponentId}" not found on entity "${npcEntityId}"` };
        }

        // Resolve the source instance: an equipped entry on the source wins (it
        // is the unambiguous, move-safe one — an equipped item also lives in
        // `entity.items`, so picking a carried copy first would strand a stale
        // equipped entry); otherwise the directly-carried copy on the source.
        const equippedEntry = (this.worldStateController?.getEquippedItems?.(npcEntityId) || [])
            .find(eq => eq && eq.itemType === itemType && eq.componentId === fromComponentId);
        if (equippedEntry) {
            if (fromComponentId === toComponentId) {
                return {
                    ok: false,
                    error: `"${itemType}" is already on ${fromComponentId} — name a different destination`
                };
            }
            return {
                ok: true,
                params: {
                    itemId: equippedEntry.itemId,
                    itemType,
                    fromComponentId,
                    toComponentId,
                    kind: 'equipped'
                }
            };
        }

        const hosted = this._itemsOn(npcEntityId, fromComponentId);
        const carried = hosted.find(item => item.type === itemType);
        if (!carried) {
            return {
                ok: false,
                error: hosted.length > 0
                    ? `no "${itemType}" carried on ${fromComponentId} (it holds: ${hosted.map(item => item.type).join(', ')})`
                    : `no "${itemType}" carried on ${fromComponentId} (that component carries nothing)`
            };
        }
        if (fromComponentId === toComponentId) {
            return {
                ok: false,
                error: `"${itemType}" is already on ${fromComponentId} — name a different destination`
            };
        }

        return {
            ok: true,
            params: {
                itemId: carried.id,
                itemType,
                fromComponentId,
                toComponentId,
                kind: 'carried'
            }
        };
    }

    /**
     * Dispatches one validated move under the craft/equip turn discipline: a move
     * is a self-transaction (no external action), so it is never queued onto the
     * turn system — it runs only in a turn world's planning window, is dropped in
     * every other phase (mirroring `_dispatchEquip` / `_dispatchUnequip`), and runs immediately in non-
     * turn worlds.
     * @param {string} npcEntityId
     * @param {Object} params - From _prevalidateMoveItem
     * @returns {{ itemId, itemType, fromComponentId, toComponentId, kind, queued, success, detail }}
     * @private
     */
    _dispatchMoveItem(npcEntityId, params) {
        const turns = this.turnSystemController;
        const phase = turns?.getRoundState?.()?.phase;
        const turnsActive = turns && phase !== undefined;
        if (turnsActive && phase === TURN_PHASES.PLANNING) {
            return this._executeMoveItem(npcEntityId, params);
        }
        if (turnsActive) {
            const detail = 'planning window closed';
            Logger.info(`[LLMAgent] ${npcEntityId}: LLM response landed in phase "${phase}" — planning window closed, move "${params.itemType}" dropped (no immediate execution in a turn world).`);
            return { ...params, queued: false, success: false, detail };
        }
        // Immediate fallback (non-turn worlds / tests only).
        return this._executeMoveItem(npcEntityId, params);
    }

    /**
     * Runs the move transaction. An equipped item goes through the world's hand-
     * over-hand swap door (facade.transferEquip: unequip + re-equip under the fit
     * rule, with rollback if the new component rejects it). Everything else goes
     * through the plain in-entity move (facade.moveItemInEntity). This method
     * only chooses the door and reports the world's own word; it owns no rules
     * of its own.
     * @param {string} npcEntityId
     * @param {Object} params - From _prevalidateMoveItem
     * @returns {{ itemId, itemType, fromComponentId, toComponentId, kind, queued, success, detail }}
     * @private
     */
    _executeMoveItem(npcEntityId, params) {
        const base = { ...params, queued: false };
        try {
            const exec = params.kind === 'equipped'
                ? this.worldStateController?.transferEquip?.(
                    npcEntityId, params.itemId, params.itemType,
                    params.fromComponentId, params.toComponentId
                )
                : this.worldStateController?.moveItemInEntity?.(
                    npcEntityId, params.itemId, params.toComponentId, npcEntityId
                );
            if (exec?.success) {
                return {
                    ...base,
                    success: true,
                    detail: exec.message
                        || (params.kind === 'equipped'
                            ? `moved "${params.itemType}" from ${params.fromComponentId} to ${params.toComponentId} (re-equipped)`
                            : `moved "${params.itemType}" from ${params.fromComponentId} to ${params.toComponentId}`)
                };
            }
            return {
                ...base,
                success: false,
                detail: exec?.message || exec?.error || (params.kind === 'equipped' ? 'transferEquip failed' : 'moveItemInEntity failed')
            };
        } catch (err) {
            return { ...base, success: false, detail: err?.message || String(err) };
        }
    }

    /**
     * Capture Point B (spec §4.2): records an immediate outcome for the NPC
     * agent's short-term memory. Used for pre-validation failures, queue
     * rejections, and late-LLM-response drops. Best-effort — must never throw.
     *
     * `targetEntityId` is carried so the agent's own memory names who it acted
     * on ("cut on Tree", rendered by `LlmContextController`). The real outcomes
     * of a turn world are recorded by TurnSystem resolution, which already
     * carries the target; this is the dispatch-time half, which used to write
     * `null` and left the section unable to say who was hit.
     *
     * @param {string} npcEntityId - the acting NPC's entity id
     * @param {Object} outcome
     * @param {string} outcome.actionName - the name the agent called it by
     * @param {boolean} outcome.success
     * @param {string} outcome.detail
     * @param {string|null} [outcome.targetEntityId] - who it was aimed at, if anything
     * @private
     */
    /**
     * The round open right now, as the turn system stores it — the round an
     * outcome recorded during this agent's turn belongs to.
     * @returns {number|null} null when no turn system answers (never 0)
     * @private
     */
    _openRoundNow() {
        try {
            const round = this.turnSystemController?.getRoundState?.()?.roundNumber;
            return Number.isInteger(round) ? round : null;
        } catch {
            // why: a throwing turn system is a broken seam — the outcome loses its
            // round stamp rather than being filed under a round it did not happen
            // in.
            return null;
        }
    }

    _recordImmediateOutcome(npcEntityId, { actionName, success, detail, targetEntityId = null }) {
        const fb = this._feedbackController;
        if (!fb || typeof fb.record !== 'function') return;
        try {
            fb.record(npcEntityId, {
                // The round the agent is planning in. The planning barrier holds a
                // round open until every roster agent settles, so this cannot drift
                // mid-turn — and it is the round these outcomes belong to. Never a
                // placeholder 0: an outcome filed under round 0 would be delivered
                // to an agent several rounds later
                // (wiki/decisions/round-scoped-context.md).
                round: this._openRoundNow(),
                actionName,
                componentId: null,
                targetEntityId,
                queued: false,
                success,
                detail: String(detail),
                atTick: this.turnSystemController?._currentTick?.() ?? 0
            });
        } catch (_) { /* why: best-effort — must not break the agent round */ }
    }

    /**
     * The entity an action call was aimed at, from its arguments (tool args or
     * executeAction params), or null when it aims at nothing (a spatial move,
     * a craft, a chat line).
     *
     * Component-targeted actions (punch / cut / shoot — the ones the context
     * tells the model to aim with a `target comp: comp-…` id) name the part,
     * not the entity, so the owner is looked up through the facade. Null-safe
     * on malformed input by construction: only string ids are considered.
     *
     * @param {Object|null|undefined} source - tool args or dispatch params
     * @returns {string|null}
     * @private
     */
    _targetEntityIdOf(source) {
        if (!source || typeof source !== 'object') return null;
        if (typeof source.targetEntityId === 'string' && source.targetEntityId !== '') {
            return source.targetEntityId;
        }
        if (typeof source.targetComponentId !== 'string' || source.targetComponentId === '') return null;
        return this.worldStateController?.getComponent?.(source.targetComponentId)?.entityId ?? null;
    }

    /**
     * Sends one chat line for the NPC — the room is FORCED to the entity's
     * current location (the model cannot choose to talk in another room,
     * spec §6.2/§6.5).
     *
     * @private
     */
    _dispatchSpeak(entity, displayName, text) {
        // Route through the facade's sendRoomChat choke point (NOT the raw
        // roomChatController): that is the single place a chat line becomes
        // observable for perception — it also marks the room dirty, so the
        // NPC's own utterance surfaces in the room's perception feed (same
        // line the player sees in the chat panel, same speaker attribution).
        //
        // The call MUST stay bound to the facade: the method reads `this.
        // roomChatController` internally, and detaching it (const f =
        // facade.sendRoomChat; f(...)) loses `this` (undefined in strict
        // mode) and throws — the 2026-10-21 chat-loss incident.
        const facade = this.worldStateController;
        if (typeof facade?.sendRoomChat !== 'function' || !entity?.location) {
            return { success: false, code: 'ROOM_CHAT_UNAVAILABLE', error: 'room chat layer is not available' };
        }
        return facade.sendRoomChat({
            roomId: entity.location,
            speakerName: displayName,
            speakerEntityId: entity.id,
            text
        });
    }

    // =========================================================================
    // INSTINCT DISPATCH (spec §2.5, §2.4)
    // =========================================================================

    /**
     * Dispatches one use_instinct tool call: expands the instinct into ordered
     * steps, pre-validates and dispatches each step via the existing pipeline.
     * A failed step aborts remaining steps (spec §2.4).
     *
     * @param {string} npcEntityId - The NPC's typed entity ID.
     * @param {Object} entry - The parsed instinct call { id, args: { instinct, targetEntityId? } }.
     * @param {number} round - The turn round number.
     * @param {Object} result - The runRound result object (actions pushed here).
     * @returns {Promise<{ actions: Array<Object>, actionable: boolean, detail?: string }>}
     * @private
     */
    async _dispatchInstinct(npcEntityId, entry, round, result) {
        const instinctId = entry.args?.instinctId;
        if (!instinctId || typeof instinctId !== 'string') {
            const detail = 'missing or invalid instinct id';
            result.actions.push({ actionName: 'use_instinct', success: false, detail, instinct: null });
            return { actions: [{ actionName: 'use_instinct', success: false, detail, instinct: null }], actionable: false, detail };
        }

        const fullName = `use_instinct(${instinctId})`;

        // Expand the instinct
        let expanded;
        try {
            expanded = this.instinctController.expand(npcEntityId, instinctId, {
                targetEntityId: entry.args?.targetEntityId
            });
        } catch (err) {
            const detail = err?.message || 'expansion failed';
            return { actions: [{ actionName: fullName, success: false, detail, instinct: instinctId }], actionable: true, detail };
        }

        if (!expanded.ok) {
            const detail = expanded.error || `expansion failed (${expanded.code})`;
            return { actions: [{ actionName: fullName, success: false, detail, instinct: instinctId }], actionable: true, detail };
        }

        // Dispatch each step in order
        const actions = [];
        let actionable = false;

        for (const step of expanded.steps) {
            const stepFullName = `use_instinct(${instinctId}):${step.actionName}`;

            // Pre-validate
            const validation = this._prevalidateAction(npcEntityId, step);
            if (!validation.ok) {
                const stepEntry = { actionName: stepFullName, success: false, detail: validation.error, instinct: instinctId };
                actions.push(stepEntry);
                actionable = true;
                break; // Abort remaining steps (spec §2.4)
            }

            // Dispatch
            const dispatch = this._dispatchAction(npcEntityId, step.actionName, validation.params);
            const stepEntry = {
                actionName: stepFullName,
                queued: dispatch.queued,
                queueId: dispatch.queueId,
                success: dispatch.success,
                detail: dispatch.detail,
                instinct: instinctId
            };
            actions.push(stepEntry);

            if (!dispatch.success) {
                actionable = true;
                break; // Abort remaining steps (spec §2.4)
            }
        }

        return { actions, actionable, detail: expanded.ok ? null : 'steps aborted' };
    }
    // =========================================================================
    // ROUND GROUPS + FEEDBACK / HELPERS (spec §6.5)
    // =========================================================================

    /**
     * Builds one "group" — the transcript entry for one LLM call in the
     * in-round agent loop (spec §6.5). One entry per LLM call (up to
     * LLM_AGENT_MAX_ITERATIONS groups per round), so the FULL loop replays
     * next round, not just the last message: the sanitized assistant call
     * plus one tool result per tool call that call made.
     * @private
     */
    _buildRoundGroup(assistantMessage, parsed, result, ctx) {
        const results = [];

        // execute_action: one result entry per call, in call order.
        (parsed.actions || []).forEach((call, idx) => {
            const entry = (result.actions || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: (entry && !entry.success) ? entry.detail : undefined
            });
        });

        // toApproach: one result entry per call, in call order. The detail
        // ("move queued toward target (x=…,y=…)" / "executed immediately")
        // is the outcome the model must be replayed (spec §6.5.6); kept even
        // on success, unlike the failure-only details of the other tools.
        (parsed.approaches || []).forEach((call, idx) => {
            const entry = (result.approaches || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: entry ? entry.detail : undefined
            });
        });

        // use_door: one result entry per call, in call order. Like toApproach,
        // the detail names the outcome ("crossed right_door -> The Eastern
        // Corridor") and is kept on success — the model must be replayed which
        // room it is standing in now.
        (parsed.doors || []).forEach((call, idx) => {
            const entry = (result.doors || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: entry ? entry.detail : undefined
            });
        });

        // speak_in_room: one result entry per call, in call order.
        (parsed.speaks || []).forEach((call, idx) => {
            const entry = (ctx.speakResults || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: (entry && !entry.success) ? entry.detail : undefined
            });
        });

        // use_instinct: one result entry per call (aggregated over its steps
        // — any failed step fails the whole instinct).
        (parsed.instincts || []).forEach((call, idx) => {
            const entry = (ctx.instinctResults || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: entry ? entry.detail : undefined
            });
        });

        // craft: one result entry per call, in call order. The detail
        // ("planning window closed" / "crafted X (consumed [...], produced n)")
        // is the outcome the model must be replayed, kept even on success
        // (same convention as toApproach).
        (parsed.crafts || []).forEach((call, idx) => {
            const entry = (result.crafts || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: entry ? entry.detail : undefined
            });
        });

        // equip_item / unequip_item: one result entry per call, in call order,
        // detail kept on success — the model must be replayed what it is
        // wearing now ("wore T-Shirt on ..."), same convention as use_door.
        (parsed.equips || []).forEach((call, idx) => {
            const entry = (result.equips || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: entry ? entry.detail : undefined
            });
        });

        (parsed.unequips || []).forEach((call, idx) => {
            const entry = (result.unequips || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: entry ? entry.detail : undefined
            });
        });

        // move_item: one result entry per call, in call order, detail on
        // success — the model must be replayed where the item now sits, same
        // convention as use_door.
        (parsed.moves || []).forEach((call, idx) => {
            const entry = (result.moves || [])[idx];
            results.push({
                id: call.id,
                success: entry ? Boolean(entry.success) : false,
                detail: entry ? entry.detail : undefined
            });
        });

        // get_actions / get_instincts / get_crafts: the discovery payloads
        // (payloadMap is built in runRound for this call).
        (parsed.discoveries || []).forEach(entry => {
            const p = (ctx.payloadMap || {})[entry.id];
            results.push({
                id: entry.id,
                success: p ? Boolean(p.success) : false,
                detail: (p && !p.success) ? p.error : undefined,
                list: (p && p.list) ? p.list : undefined
            });
        });

        const hasContent =
            (assistantMessage && typeof assistantMessage.content === 'string' && assistantMessage.content.length > 0);
        const toolCalls =
            (assistantMessage && Array.isArray(assistantMessage.tool_calls)) ? assistantMessage.tool_calls : [];
        const replay = {
            role: 'assistant',
            content: hasContent ? assistantMessage.content : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        };
        // Pass the model's reasoning_content through on replay (reasoning
        // models on an OpenAI-compatible endpoint expect their reasoning
        // history back; the LLMController does the same for fresh turns).
        if (assistantMessage && typeof assistantMessage.reasoning_content === 'string') {
            replay.reasoning_content = assistantMessage.reasoning_content;
        }
        return { assistant: replay, results };
    }

    /**
     * Builds the in-round retry continuation for the conversation (spec
     * §6.3.6 / §6.5): the assistant's previous tool-call message, one
     * tool-role result per call (in call order), and a user nudge. Re-attaching
     * the assistant message keeps the payload a valid multi-turn conversation
     * (assistant → tool results); without it the tool_call_id bindings are
     * orphaned and the model never sees its own failed call. runRound appends
     * this array to `messages` in place before the next chatFull.
     * @param {Object} group - The round group for one in-round LLM call: { assistant, results }.
     * @private
     */
    _buildFeedbackMessages(group) {
        const results = Array.isArray(group?.results) ? group.results : [];
        const messages = [];
        // Re-attach the assistant's previous tool-call message so the payload
        // stays a valid multi-turn conversation (assistant → tool results).
        const assistant = (group && group.assistant) ? group.assistant : null;
        const hasContent = assistant
            && typeof assistant.content === 'string'
            && assistant.content.length > 0;
        const toolCalls = assistant
            && Array.isArray(assistant.tool_calls)
            ? assistant.tool_calls
            : [];
        if (hasContent || toolCalls.length > 0) {
            const replay = { role: 'assistant', content: hasContent ? assistant.content : null };
            if (toolCalls.length > 0) replay.tool_calls = toolCalls;
            if (assistant
                && typeof assistant.reasoning_content === 'string') {
                replay.reasoning_content = assistant.reasoning_content;
            }
            messages.push(replay);
        }
        for (let i = 0; i < results.length; i += 1) {
            const r = results[i];
            messages.push({
                role: 'tool',
                tool_call_id: (typeof r.id === 'string' && r.id !== '')
                    ? r.id
                    : `call-feedback-${i}`,
                // Consistent with _transcriptFor (cross-round replay): a failed
                // call surfaces { error }; a discovery success (get_actions /
                // get_instincts) surfaces the formatted list in `list` — the
                // result the model reads to choose a concrete call.
                content: JSON.stringify(
                    {
                        success: Boolean(r.success),
                        ...(r.detail ? { error: r.detail } : {}),
                        ...(r.list ? { list: r.list } : {})
                    }
                )
            });
        }
        const failed = results.filter(r => !r.success);
        const message = failed.length > 0
            ? `One or more calls failed (${failed.map(r => (r.detail ? r.detail : 'no result')).join('; ')}). Retry with a corrected call, or call the done tool when your work is done.`
            : `Tool results are above. Continue acting this round, or call the done tool when you are finished.`;
        messages.push({ role: 'user', content: message });
        return messages;
    }
    /**
     * Minimal identity line used when the context layer is unavailable.
     * @private
     */
    _minimalContextLine(entity) {
        return `=== YOUR STATE ===\nName: ${entity.name || 'NPC'}\nRoom: ${this._roomName(entity)}\n(no detailed context available this round)`;
    }

    /**
     * Room display name for the NPC's current room (best-effort).
     * @private
     */
    _roomName(entity) {
        const rooms = this.worldStateController?.getRooms?.() || {};
        const room = entity?.location ? rooms[entity.location] : null;
        return room?.name || entity?.location || 'unknown';
    }

    /**
     * Positive integer coercion with fallback.
     * @private
     */
    _asPositiveInt(value, fallback) {
        return (Number.isInteger(value) && value > 0) ? value : fallback;
    }

    /**
     * Detects degenerate LLM output: repetition loops instead of language.
     * Two shapes, both observed in the wild (the scaffold-loop incident ran
     * on shape 2, which the first version of this check missed):
     *   - a 2-4 char unit repeated 10+ times (emoji loops, "abc" x 20);
     *   - a 5-40 char unit repeated 5+ times - the 24-char scaffold loop
     *     (function/parameter close tags, each on its own line, x 40):
     *     the unit is too long for a short-unit scan, so the garbage
     *     slipped past, was stored in the transcript, and re-primed the
     *     model on the next round.
     * Scans for an exact run (a window equal to the unit repeated), not
     * fuzzy similarity: false positives on real prose are near-zero, and a
     * false positive only costs one silent round (the model's words are
     * dropped, nothing is executed).
     * @private
     * @param {string} text
     * @returns {boolean}
     */
    _isDegenerate(text) {
        if (typeof text !== 'string' || text.length < 20) return false;
        // Shape 1: a 2-4 char unit repeated 10+ times consecutively.
        for (let len = 2; len <= 4; len += 1) {
            if (this._hasRepeatingUnit(text, len, 10)) return true;
        }
        // Shape 2: a 5-40 char unit repeated 5+ times consecutively.
        for (let len = 5; len <= 40; len += 1) {
            if (this._hasRepeatingUnit(text, len, 5)) return true;
        }
        return false;
    }

    /**
     * True when `text` contains `reps` consecutive copies of some
     * `len`-char unit (an exact run - a window equal to the unit repeated).
     * @private
     * @param {string} text
     * @param {number} len - Unit length in chars.
     * @param {number} reps - Consecutive copies required.
     * @returns {boolean}
     */
    _hasRepeatingUnit(text, len, reps) {
        const span = len * reps;
        if (text.length < span) return false;
        for (let i = 0; i + span <= text.length; i += 1) {
            const unit = text.slice(i, i + len);
            if (text.slice(i, i + span) === unit.repeat(reps)) return true;
        }
        return false;
    }

    /**
     * True when assistant text carries literal function-call markup - the
     * XML-style scaffold (function / parameter / think tags) that small
     * models leak into the content stream when a native tool call fails to
     * materialize (the exact shape of the scaffold-loop incident). Caught
     * by the sanitizer before the content can be stored in the transcript.
     * The pattern is assembled by concatenation so this source line never
     * contains a literal close tag (the agent transport treats those as
     * delimiters and mangles payloads that carry them).
     * @private
     * @param {string} text
     * @returns {boolean}
     */
    _hasToolScaffold(text) {
        return /<\/?\s*(?:function|parameter)\b| think|<\/think>/i.test(text);
    }

    /**
     * Transcript hygiene - the structural fix the pi harness makes natively
     * (its openai-completions adapter keeps assistant content a plain string
     * and never lets a broken response become history). Here: if the
     * assistant message's content is degenerate or carries tool-call
     * scaffold markup, replace it with a neutral placeholder BEFORE it is
     * replayed to a retry or stored for the next round - otherwise the model
     * is re-primed by its own broken output (self-reinfection). Clean
     * content, including plain prose, passes through untouched.
     * @private
     * @param {Object|null} message - The raw choices[0].message from chatFull.
     * @returns {Object|null} A sanitized copy, or the original when clean.
     */
    _sanitizeAssistantMessage(message) {
        if (!message || typeof message.content !== 'string') return message;
        if (this._isDegenerate(message.content) || this._hasToolScaffold(message.content)) {
            const copy = { ...message };
            copy.content = '(invalid response discarded)';
            return copy;
        }
        return message;
    }

    /**
     * Resolves the LLM config for one live NPC entity: the entity's own
     * `npcConfig` (set at spawn, carrying per-entity personality/caps for
     * dynamically-spawned cards) merged over the static `data/mods/core-npcs/npcs.json`
     * registry entry for its blueprint, with the live values taking
     * precedence.
     *
     * WHY live-config precedence: the static registry is keyed by *blueprint*,
     * so N entities of the same blueprint (the card droids, all `m1Droid`)
     * would share one entry and lose their per-card personality. Merging the
     * live `npcConfig` over it is what gives each card its own identity.
     * For registry NPCs the merge is a no-op: their live `npcConfig` (built
     * from the same registry entry at spawn) mirrors the registry, so every
     * existing prompt renders byte-identically — the regression the test suite
     * pins.
     * `ai` is handled separately by `hasDeterministicBrain` (which reads
     * `entity.npcConfig.ai` directly) and is never part of the prompt config.
     * @private
     * @param {Object|undefined} entity
     * @returns {Object}
     */
    _resolveNpcConfig(entity) {
        const npcConfig = (entity && typeof entity.npcConfig === 'object' && entity.npcConfig !== null)
            ? entity.npcConfig
            : {};
        const registry = this._npcRegistry || {};
        const byBlueprint = (registry && typeof registry[entity?.blueprint] === 'object' && registry[entity.blueprint] !== null)
            ? registry[entity.blueprint]
            : {};
        const out = { ...byBlueprint };
        for (const [key, value] of Object.entries(npcConfig)) {
            if (value !== undefined && value !== null) {
                out[key] = value;
            }
        }
        return out;
    }

    /**
     * Loads + validates data/mods/core-npcs/npcs.json. Tolerant of a missing file (Feature C
     * ships before Feature D creates it) and of malformed entries.
     * @private
     * @returns {Object<string, Object>}
     */
    _loadNpcRegistry() {
        const raw = DataLoader.loadRegistry(REGISTRY_KINDS.NPCS);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            Logger.info('[LLMAgent] No NPC registry (data/mods/core-npcs/npcs.json) — the agent has no configured NPCs (no-op until Feature D).');
            return {};
        }

        const registry = {};
        let count = 0;
        for (const [blueprint, entry] of Object.entries(raw)) {
            if (!entry || typeof entry !== 'object') {
                Logger.warn(`[LLMAgent] npcs.json: entry "${blueprint}" is malformed — skipped.`);
                continue;
            }
            if (typeof entry.displayName !== 'string' || typeof entry.personality !== 'string') {
                Logger.warn(`[LLMAgent] npcs.json: entry "${blueprint}" lacks displayName/personality — skipped.`);
                continue;
            }
            const registryEntry = {
                displayName: entry.displayName,
                room: typeof entry.room === 'string' ? entry.room : null,
                personality: entry.personality,
                initialItems: Array.isArray(entry.initialItems) ? entry.initialItems : [],
                maxWorldActionsPerRound: Number.isInteger(entry.maxWorldActionsPerRound) ? entry.maxWorldActionsPerRound : DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND,
                maxChatMessagesPerRound: Number.isInteger(entry.maxChatMessagesPerRound) ? entry.maxChatMessagesPerRound : DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND
            };
            // Preserve the optional objective only when present (non-empty
            // string) so existing entries keep the exact registry shape they
            // had before this feature (their prompts stay byte-identical).
            if (typeof entry.objective === 'string' && entry.objective.trim() !== '') {
                registryEntry.objective = entry.objective;
            }
            registry[blueprint] = registryEntry;
            count++;
        }
        if (count === 0) {
            Logger.info('[LLMAgent] NPC registry loaded with 0 valid entries — the agent has no configured NPCs (no-op until Feature D).');
        } else {
            Logger.info(`[LLMAgent] NPC registry loaded: ${count} blueprint(s).`);
        }
        return registry;
    }
}

export default LLMAgentController;

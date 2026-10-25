/**
 * LLMAgentController — the LLM "agent" that lets NPCs act on the world.
 *
 * Feature C (spec §6.3): the model proposes, the world disposes. This
 * controller orchestrates ONE agent round per NPC per turn round:
 *   1. guard (entity exists + isNPC) — graceful 'NPC_GONE' otherwise;
 *   2. build the world context via LlmContextController (Feature B);
 *   3. call LLMController.chatFull with the generated tool set
 *      (execute_action + toApproach, plus speak_in_room when chat is enabled
 *      and use_instinct when instincts exist), tool_choice "auto", and a
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
import { CHAT_MESSAGE_MAX_LENGTH } from '../../utils/Constants.js';
import { TURN_PHASES } from '../../../shared/TurnPhases.js';
import { formatActionList, formatInstinctList } from './LlmContextController.js';

/** Hard cap on the agent's conversation memory per NPC (rounds). */
const TRANSCRIPT_ROUNDS = 2;
/** Default per-round world-action cap (spec §6.5); npcs.json may override. */
const DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND = 2;
/** Default per-round chat cap (spec §6.5); npcs.json may override. */
const DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND = 1;
/** Per-call LLM timeout budget (spec §6.5 default 4500 ms − no turn deadline exists in spec v2; the budget
 * bounds the LLM call itself, so every agent promise settles). Set 10× (45000 ms)
 * because local models are slow enough that 4.5 s is below the p95 response time. */
const LLM_ROUND_TIMEOUT_MS = 45000;
/** Per-call token cap: 10× the original 512. Local reasoning models count
 * their thinking tokens against this budget, and 512 sat below the p95 of
 * "reasoning + action" — rounds died mid-reasoning with finishReason "length"
 * and no tool call (the Minako reasoning-truncation incident). 5120 gives
 * the thinking budget real headroom; the outer bound on a round is the
 * timeout, not this cap (see LLM_ROUND_TIMEOUT_MS). */
const LLM_ROUND_MAX_TOKENS = 5120;
/**
 * Per-call sampling temperature — deliberately below the global 0.7 default
 * (LLMController.DEFAULT_TEMPERATURE): a protocol-B round is a constrained
 * choice (one of a small fixed tool set, or silence) and 0.7 is the drift
 * zone where small local models started looping (the scaffold-loop incident
 * ran at 0.7). See spec §6.5.
 */
const LLM_ROUND_TEMPERATURE = 0.5;
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
const LLM_AGENT_MAX_ITERATIONS = 5;

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
         * NPC registry (data/entities/npcs.json, spec §7.1): key = blueprint name,
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

        /** @private {Map<string, Array>} npcEntityId → last N round transcripts. */
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

            // 4. Conversation: transcript replay (last ≤2 rounds) + fresh context.
            const messages = [
                ...this._transcriptFor(npcEntityId),
                { role: 'user', content: contextText }
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
                max_tokens: LLM_ROUND_MAX_TOKENS
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
            // round (see _transcriptFor / _getLastTranscriptRound).
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
                    this._storeTranscript(npcEntityId, round, { groups, note: code, error: code });
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
                        this._recordImmediateOutcome(npcEntityId, String(call.args.actionName), false, detail);
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateAction(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.actions.push({ actionName: String(call.args.actionName), success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, String(call.args.actionName), false, validation.error);
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
                    this._recordImmediateOutcome(
                        npcEntityId,
                        dispatch.actionName,
                        dispatch.success,
                        dispatch.detail || (dispatch.queued ? 'queued' : 'executed')
                    );
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
                        this._recordImmediateOutcome(npcEntityId, 'speak_in_room', false, reason);
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
                        this._recordImmediateOutcome(npcEntityId, 'speak_in_room', true, `said "${spokenShort}"`);
                    } else {
                        const reason = sendResult.error || sendResult.code;
                        result.chat = { sent: false, reason };
                        speakResults.push({ id: callId, success: false, detail: reason });
                        this._recordImmediateOutcome(npcEntityId, 'speak_in_room', false, reason);
                    }
                }

                // Dispatch approach calls (toApproach tool): world-action intent
                // resolved to the registered move action (server-side coordinates
                // from the target's live spatial position).
                for (const call of parsed.approaches) {
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.approaches.push({ id: call.id, actionName: 'toApproach', success: false, detail });
                        this._recordImmediateOutcome(npcEntityId, 'toApproach', false, detail);
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateApproach(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.approaches.push({ id: call.id, actionName: 'toApproach', success: false, detail: validation.error });
                        this._recordImmediateOutcome(npcEntityId, 'toApproach', false, validation.error);
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
                    this._recordImmediateOutcome(
                        npcEntityId,
                        'toApproach',
                        dispatch.success,
                        dispatch.detail || (dispatch.queued ? 'queued' : 'executed')
                    );
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'execution failed' };
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
                        this._recordImmediateOutcome(
                            npcEntityId,
                            'use_instinct',
                            instinctOk,
                            instinctOk
                                ? (iid ? `executed ${iid}` : 'executed')
                                : (instinctResult.detail || 'instinct failed')
                        );
                        if (instinctResult.actionable && !actionableFailure) {
                            actionableFailure = { call: entry, error: instinctResult.detail || 'instinct failed' };
                        }
                    }
                }

                // 8. Discovery payloads: get_actions / get_instincts return
                //    the formatted list directly — the tool result IS the list
                //    (one per call, built from the live registry / instinct
                //    list, filtered as requested).
                const actionData = this.llmContextController
                    && typeof this.llmContextController.getActionData === 'function'
                    ? this.llmContextController.getActionData(npcEntityId)
                    : { entries: [], notExecutable: [] };
                const payloadMap = {};
                for (const discovery of parsed.discoveries) {
                    const list = discovery.kind === 'get_actions'
                        ? formatActionList(actionData.entries, actionData.notExecutable, discovery.args.filter)
                        : formatInstinctList(instincts, discovery.args.filter);
                    payloadMap[discovery.id] = { success: true, list };
                }

                // 9. This LLM call is one group of the in-round agent loop
                //    (spec §6.5); the full loop is what replays next round.
                //    The assistant message is the SANITIZED one (degenerate /
                //    scaffold content was replaced by a neutral placeholder in
                //    the parser), so the stored group cannot re-prime the next
                //    round (BUG-007).
                const group = this._buildRoundGroup(assistantMessage, parsed, result, {
                    speakResults,
                    instinctResults,
                    payloadMap
                });
                groups.push(group);

                // 10. Stop conditions (each ends the round — the loop IS the
                //     agent, not a retry mechanism).
                const hasTools =
                    parsed.actions.length > 0 ||
                    parsed.speaks.length > 0 ||
                    parsed.approaches.length > 0 ||
                    parsed.instincts.length > 0 ||
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
                    this._storeTranscript(npcEntityId, round, { groups, note });
                    return result;
                }

                if (parsed.done && !actionableFailure) {
                    // The agent declared its work complete with the done tool
                    // (spec §6.5.6).
                    result.done = true;
                    result.note = 'done';
                    this._storeTranscript(npcEntityId, round, { groups, note: 'done' });
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
                    this._storeTranscript(npcEntityId, round, { groups, note: result.note });
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
                note: result.note || 'loop ended without return'
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
     * hardcoded (BUG-018): the `get_actions` / `get_instincts` tools are the
     * model's ONLY source of executable options; `execute_action` carries no
     * actionName enum (the registry is the live list, not the tool list);
     * `toApproach` is a fixed intent tool that dispatches the registered
     * move action toward the target's live coordinates; `use_instinct` is
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
                description: 'Execute one world action with your own body. Only use action names the get_actions tool returned — those are the ONLY executable options this round.',
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
                        itemId: { type: 'string', description: 'item-… item to drop.' },
                        targetX: { type: 'number', description: 'Target x in room coordinates (move/dash/drop).' },
                        targetY: { type: 'number', description: 'Target y in room coordinates (move/dash/drop).' },
                        targetRoomId: { type: 'string', description: 'Room to move to through a door.' }
                    },
                    required: ['actionName']
                }
            }
        };

        const toApproach = {
            type: 'function',
            function: {
                name: 'toApproach',
                description: 'Move toward another droid in the current room as far as your movement stat allows. Pass only the target entity id (ent-…); the server resolves its live coordinates. It does not cross rooms — to travel between rooms use execute_action move with a targetRoomId.',
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

        // Order: discovery tools first (read at round start), action tools,
        // chat, instincts, and the round-end done tool last.
        const tools = [getActions, getInstincts, executeAction, toApproach];
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
            '- Start each round with get_actions (and get_instincts when instincts exist): that is the ONLY source of executable options — issue execute_action / toApproach / use_instinct only with names the discovery calls returned.',
            '- You may call toApproach { targetEntityId: "ent-..." } to move toward an entity in your current room as far as possible this round (one full move step, capped by your movement stat). Name only the target — the server resolves where it is. It does not cross rooms: travel between rooms with move (targetRoomId).',
            ...(maxChat > 0 ? ['- Keep chat messages under 25 words, in character, no fourth-wall breaks.'] : []),
            '',
            'How you respond:',
            '- Act only through the available tools — the tool calls ARE your content. Never write JSON, code, XML, or tool-call markup in your message text.',
            sayLine + '- If nothing is worth doing or saying this round, call the done tool (or respond with no tool call at all — silence is allowed and counts as a finished round).'
        ].join('\n');
    }

    // =========================================================================
    // TRANSCRIPT (last ≤2 rounds per NPC — replayed as history)
    // =========================================================================

    /**
     * Returns the replayable message history for the LLM: for each stored
     * round, every group (one per in-round LLM call — the agent loop, spec
     * §6.5) with its assistant tool-call message, followed by one tool-role
     * result per call. Legacy entries ({ assistant, results? } / { error })
     * are still playable as single-call history. Follows the relaxed
     * _validateMessages contract (assistant content: null + tool_calls;
     * tool messages: content + tool_call_id).
     * @private
     */
    _transcriptFor(npcEntityId) {
        const rounds = this._transcripts.get(npcEntityId) || [];
        const messages = [];
        for (const entry of rounds) {
            if (!entry || typeof entry !== 'object') continue;
            // One group per in-round LLM call (spec §6.5); legacy entries
            // (error / guard stops) are treated as single-call history.
            const groups = (entry.groups && Array.isArray(entry.groups))
                ? entry.groups
                : (entry.assistant ? [entry] : []);
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
     * Appends one round to the NPC's transcript (capped at 2 rounds). Entry
     * shapes (spec §6.5): { groups: [...], note? } — the in-round agent
     * loop (one group per LLM call, each { assistant, results }) plus the
     * note explaining why the round ended (done, no response,
     * prose-ignored, degenerated, iterations exhausted, LLM error code) —
     * or the legacy { assistant?, results?, note?, error? } (guard stops /
     * early error). Replay via _transcriptFor; inspector via
     * _getLastTranscriptRound.
     * @private
     */
    _storeTranscript(npcEntityId, round, entry) {
        const rounds = this._transcripts.get(npcEntityId) || [];
        rounds.push({ round, ...entry });
        this._transcripts.set(npcEntityId, rounds.slice(-TRANSCRIPT_ROUNDS));
    }

    // =========================================================================
    // AGENT VIEW — public inspector (dev tab, GET /llm/agent/:entityId)
    //
    // Reuses the EXACT round-runner logic (_resolveNpcConfig, _buildTools,
    // _buildSystemPrompt, _safeGenerateInstincts, llmContextController.
    // buildContext) so the view is byte-identical to what the LLM receives in
    // a live round. Read-only: never mutates round state.
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
     *   transcript: { round, groups: Array|undefined, assistant: { content, tool_calls, reasoning_content },
     *     toolResults: Array, note: string|null }|null,
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
            transcript: null,
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

        // Same bounded sectioned context as the round runner.
        try {
            const ctx = this.llmContextController?.buildContext
                ? this.llmContextController.buildContext(entityId, { instincts, ...options })
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

        // Last replayable transcript round (if any).
        try {
            out.transcript = this._getLastTranscriptRound(entityId);
        } catch (err) {
            out.transcript = null;
        }

        return out;
    }

    /**
     * Most recently stored transcript round for an NPC, normalized for client
     * display: round number, the last group's assistant message + tool
     * results, the full `groups` array (one entry per LLM call, each
     * { assistant, results } — the in-round agent loop), and the note
     * explaining why the round ended (done, prose-ignored, LLM error code,
     * ...). Legacy entries ({ assistant, results } / { error }) normalize the
     * same way. null when no round has been stored yet. @private
     */
    _getLastTranscriptRound(entityId) {
        const rounds = Array.from((this._transcripts?.get(entityId)) || []);
        for (let i = rounds.length - 1; i >= 0; i -= 1) {
            const entry = rounds[i];
            if (!entry || typeof entry !== 'object') continue;
            const group = (entry.groups && Array.isArray(entry.groups))
                ? entry.groups[entry.groups.length - 1]
                : (entry.assistant ? entry : null);
            if (!group) continue;
            const assistant = group.assistant;
            return {
                round: (typeof entry.round === 'number') ? entry.round : null,
                assistant: {
                    content: (assistant && typeof assistant.content === 'string') ? assistant.content : null,
                    tool_calls: (assistant && Array.isArray(assistant.tool_calls)) ? assistant.tool_calls : null,
                    reasoning_content: (assistant && typeof assistant.reasoning_content === 'string') ? assistant.reasoning_content : null
                },
                toolResults: Array.isArray(group.results) ? group.results : [],
                groups: (entry.groups && Array.isArray(entry.groups)) ? entry.groups : null,
                note: (typeof entry.note === 'string') ? entry.note : null
            };
        }
        return null;
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
     * @returns {{ speaks: Array<{id: string, args: Object}>, actions: Array<{id: string, args: Object}>, instincts: Array<{id: string, args: Object}>, approaches: Array<{id: string, args: Object}>, discoveries: Array<{id: string, kind: string, args: Object}>, done: boolean, prose: string|null }}
     * @private
     */
    _parseToolCalls(message) {
        const speaks = [];
        const actions = [];
        const instincts = [];
        const approaches = [];
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
            } else if (name === LLM_AGENT_DONE_TOOL_NAME) {
                done = true;
            }
            // Unknown tool names: ignored (the schema is closed; the model is
            // told "respond ONLY with tool calls" from the known set).
        }
        return { speaks, actions, instincts, approaches, discoveries, done, prose };
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
     *     goes through move's targetRoomId);
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
                error: 'target not in your room — travel through a door (move with targetRoomId) first'
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
     * Capture Point B (spec §4.2): records an immediate outcome for the NPC
     * agent's short-term memory. Used for pre-validation failures, queue
     * rejections, and late-LLM-response drops. Best-effort — must never throw.
     * @private
     */
    _recordImmediateOutcome(npcEntityId, actionName, success, detail) {
        const fb = this._feedbackController;
        if (!fb || typeof fb.record !== 'function') return;
        try {
            fb.record(npcEntityId, {
                round: 0, // unknown at dispatch time; TurnSystem resolution will overwrite with the real round
                actionName,
                componentId: null,
                targetEntityId: null,
                queued: false,
                success,
                detail: String(detail),
                atTick: this.turnSystemController?._currentTick?.() ?? 0
            });
        } catch (_) { /* best-effort — must not break the agent round */ }
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
        // mode) and throws — the 2026-10-21 Minako chat-loss incident.
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

        // get_actions / get_instincts: the discovery payloads (payloadMap is
        // built in runRound for this call).
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
     * dynamically-spawned cards) merged over the static `data/entities/npcs.json`
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
     * Loads + validates data/entities/npcs.json. Tolerant of a missing file (Feature C
     * ships before Feature D creates it) and of malformed entries.
     * @private
     * @returns {Object<string, Object>}
     */
    _loadNpcRegistry() {
        const raw = DataLoader.loadJsonSafe('data/entities/npcs.json', {});
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            Logger.info('[LLMAgent] No NPC registry (data/entities/npcs.json) — the agent has no configured NPCs (no-op until Feature D).');
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

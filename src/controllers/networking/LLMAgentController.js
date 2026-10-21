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
 *   6. AT MOST ONE retry with the failure fed back as a tool-role result;
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
/** Per-call token cap: tool-call rounds are short (spec §6.5). */
const LLM_ROUND_MAX_TOKENS = 512;
/**
 * Per-call sampling temperature — deliberately below the global 0.7 default
 * (LLMController.DEFAULT_TEMPERATURE): a protocol-B round is a constrained
 * choice (one of a small fixed tool set, or silence) and 0.7 is the drift
 * zone where small local models started looping (the scaffold-loop incident
 * ran at 0.7). See spec §6.5.
 */
const LLM_ROUND_TEMPERATURE = 0.5;
/**
 * Agent-loop iteration budget: the initial call PLUS AT MOST ONE retry
 * (spec §6.3 step 6 — "AT MOST ONE retry with the failure fed back as a
 * tool-role result"), i.e. at most 2 chatFull calls per round.
 * @constant
 */
const LLM_AGENT_MAX_ITERATIONS = 2;

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
     *   error: string|null
     * }>}
     */
    async runRound(npcEntityId, round) {
        const result = {
            entityId: npcEntityId,
            round,
            iterations: 0,
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
            /** Stable id for a speak tool_call (the model sometimes omits id). */
            const speakCallId = (call, index) =>
                (typeof call?.id === 'string' && call.id !== '')
                    ? call.id
                    : `call-${npcEntityId}-${round}-${index}`;

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
                    this._storeTranscript(npcEntityId, round, { error: code });
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
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateAction(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.actions.push({ actionName: String(call.args.actionName), success: false, detail: validation.error });
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
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'execution failed' };
                    }
                }

                for (const call of parsed.speaks) {
                    const callId = speakCallId(call, speakResults.length);
                    const text = call.args?.message;
                    if (sentChats >= maxChat || typeof text !== 'string' || text.trim() === '' || text.length > CHAT_MESSAGE_MAX_LENGTH) {
                        const reason = sentChats >= maxChat
                            ? `max chat messages per round reached (${maxChat})`
                            : 'invalid message text';
                        result.chat = { sent: false, reason };
                        speakResults.push({ id: callId, success: false, detail: reason });
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
                    } else {
                        const reason = sendResult.error || sendResult.code;
                        result.chat = { sent: false, reason };
                        speakResults.push({ id: callId, success: false, detail: reason });
                    }
                }

                // Dispatch approach calls (toApproach tool): world-action intent
                // resolved to the registered move action (server-side coordinates
                // from the target's live spatial position).
                for (const call of parsed.approaches) {
                    if (executedActions >= maxActions) {
                        const detail = `max world actions per round reached (${maxActions})`;
                        result.approaches.push({ id: call.id, actionName: 'toApproach', success: false, detail });
                        if (!actionableFailure) actionableFailure = { call, error: detail };
                        continue;
                    }

                    const validation = this._prevalidateApproach(npcEntityId, call.args);
                    if (!validation.ok) {
                        result.approaches.push({ id: call.id, actionName: 'toApproach', success: false, detail: validation.error });
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
                    if (!dispatch.success && !actionableFailure) {
                        actionableFailure = { call, error: dispatch.detail || 'execution failed' };
                    }
                }

                // 7. Dispatch instinct calls (use_instinct tool).
                if (this.instinctController && parsed.instincts && parsed.instincts.length > 0) {
                    for (const entry of parsed.instincts) {
                        const instinctResult = await this._dispatchInstinct(npcEntityId, entry, round, result);
                        result.actions.push(...instinctResult.actions);
                        if (instinctResult.actionable && !actionableFailure) {
                            actionableFailure = { call: entry, error: instinctResult.detail || 'instinct failed' };
                        }
                    }
                }

                // No tool calls (actions / speaks / approaches) extracted and
                // no actionable failure: PROTOCOL B — the content is NEVER
                // interpreted. The JSON-in-content fallback of the mixed
                // protocol is gone: a model obeying BOTH a "ONE JSON object"
                // prompt and the native tool list at once is exactly how the
                // scaffold-loop incident happened (spec §6.4). Prose-only is
                // "the model chose silence" (spec §6.3): the round completes,
                // no retry is burned, nothing is dispatched.
                if (parsed.actions.length === 0 && parsed.speaks.length === 0 && parsed.approaches.length === 0 && !actionableFailure) {
                    const content = parsed.prose;
                    if (content === null) {
                        result.chat = { sent: false, reason: 'no response' };
                        this._storeTranscript(npcEntityId, round, {
                            assistant: assistantMessage,
                            results: [],
                            note: 'no response'
                        });
                        return result;
                    }
                    // The sanitizer already replaced degenerate / scaffold
                    // content with a neutral placeholder in `assistantMessage`,
                    // so the stored transcript cannot re-prime the next round.
                    // (Tested against the RAW content: the placeholder itself
                    // is not a repetition loop.)
                    const rawContent = typeof full.message?.content === 'string' ? full.message.content : '';
                    const degenerated = this._isDegenerate(rawContent);
                    const note = degenerated ? 'degenerated' : 'prose-ignored';
                    Logger.warn(`[LLMAgent] round ${round}: ${displayName} — LLM output ${note} (content discarded, NPC silent this round).`);
                    result.chat = { sent: false, reason: note };
                    this._storeTranscript(npcEntityId, round, {
                        assistant: assistantMessage,
                        results: [],
                        note
                    });
                    return result;
                }

                // 6. Retry (at most one): feed the failure back as tool-role
                //    results + a user nudge, then call chatFull again.
                if (actionableFailure && iteration < LLM_AGENT_MAX_ITERATIONS) {
                    Logger.info(`[LLMAgent] round ${round}: ${displayName} — retrying after failure: ${actionableFailure.error}`);
                    const feedback = this._buildFeedbackMessages(messages, assistantMessage, parsed, result);
                    messages.push(...feedback);
                    continue;
                }

                // No retry (success, or retry already spent).
                this._storeTranscript(npcEntityId, round, {
                    assistant: assistantMessage,
                    results: [
                        ...parsed.actions.map(call => {
                            const a = result.actions.find(x => x.actionName === String(call.args.actionName) && !x.__replayed);
                            return {
                                id: call.id,
                                success: a ? a.success : false,
                                detail: a?.detail
                            };
                        }),
                        ...parsed.approaches.map(call => {
                            const a = result.approaches.find(x => x.id === call.id);
                            return {
                                id: call.id,
                                success: a ? a.success : false,
                                detail: a?.detail
                            };
                        }),
                        ...speakResults
                    ]
                });
                return result;
            }

            // Unreachable: the loop returns on iteration 2.
            this._storeTranscript(npcEntityId, round, { error: 'iterations exhausted' });
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
     * Builds the tool OpenAI schema. The `execute_action` actionName enum +
     * descriptions are generated from the live action registry (the same
     * `data/systems/actions.json` the rest of the world runs on); `toApproach`
     * is a fixed intent tool that dispatches the registered `move` action
     * toward the target's live coordinates.
     * @param {Object} [opts]
     * @param {boolean} [opts.includeChat=true] - Whether to include the speak_in_room tool.
     * @param {Array<Object>} [opts.instincts] - Generated instincts for this round (if non-empty, adds use_instinct tool).
     * @returns {Array<Object>}
     */
    _buildTools({ includeChat = true, instincts = [] } = {}) {
        const registry = this.worldStateController?.actionController?.getRegistry?.() || {};
        const actionNames = Object.keys(registry);

        const executeAction = {
            type: 'function',
            function: {
                name: 'execute_action',
                description: 'Execute one world action with your own body. Only use action names marked executable in your context.',
                parameters: {
                    type: 'object',
                    properties: {
                        actionName: {
                            type: 'string',
                            enum: actionNames,
                            description: 'The action to perform (see YOUR ACTIONS in the context for descriptions).'
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
                description: 'Move toward the given entity as far as possible in this round (one full move step, capped by your movement stat). Works only while you share the target\'s room; to reach another room first move through a door (move with a targetRoomId).',
                parameters: {
                    type: 'object',
                    properties: {
                        targetEntityId: {
                            type: 'string',
                            description: 'The ent-* ID of the entity to approach (same-room only).'
                        }
                    },
                    required: ['targetEntityId']
                }
            }
        };

        const tools = [executeAction, toApproach];

        // Add use_instinct tool only when instincts are generated (spec §2.5)
        if (instincts && instincts.length > 0) {
            const instinctNames = instincts.map(i => i.name);
            tools.push({
                type: 'function',
                function: {
                    name: 'use_instinct',
                    description: 'Perform a whole behavior at once: the server executes the instinct\'s action sequence for you. See the YOUR INSTINCTS section of the context.',
                    parameters: {
                        type: 'object',
                        properties: {
                            instinct: {
                                type: 'string',
                                enum: instinctNames,
                                description: 'The instinct to perform (see YOUR INSTINCTS in the context).'
                            },
                            targetEntityId: { type: 'string', description: 'ent-… entity the instinct acts on; default: nearest entity in your room.' }
                        },
                        required: ['instinct']
                    }
                }
            });
        }

        if (includeChat) {
            tools.push({
                type: 'function',
                function: {
                    name: 'speak_in_room',
                    description: 'Say something in the chat of the room you are currently in.',
                    parameters: {
                        type: 'object',
                        properties: {
                            message: { type: 'string', maxLength: CHAT_MESSAGE_MAX_LENGTH, description: 'The line to say (max 200 characters).' }
                        },
                        required: ['message']
                    }
                }
            });
        }
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
            ? `- Execute at most ${maxActions} world action(s) and send at most ${maxChat} chat message(s) per round.`
            : `- Execute at most ${maxActions} world action(s) per round. You MUST NOT use the speak_in_room tool or produce any chat output. Your ONLY output must be world actions.`;

        const actionRule = objective
            ? '- Only use actions listed under "executable now" in the context. If you cannot complete your objective this round, take the action that best advances it (e.g., move toward your nearest target). Only stay silent when no action serves your objective.'
            : '- Only use actions listed under "executable now" in the context. If none fit your goals, stay silent.';

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
            '- You may call toApproach { targetEntityId: "ent-..." } to move toward an entity in your current room as far as possible this round (one full move step, capped by your movement stat). Name only the target — the server resolves where it is. It does not cross rooms: travel between rooms with move (targetRoomId).',
            ...(maxChat > 0 ? ['- Keep chat messages under 25 words, in character, no fourth-wall breaks.'] : []),
            '',
            'How you respond:',
            '- Act only through the available tools. Never write JSON, code, XML, or tool-call markup in your message text.',
            sayLine + '- If nothing is worth doing or saying this round, respond with no tool call and no text. Silence is allowed.'
        ].join('\n');
    }

    // =========================================================================
    // TRANSCRIPT (last ≤2 rounds per NPC — replayed as history)
    // =========================================================================

    /**
     * Returns the replayable message history: for each stored round, the
     * assistant tool-call message followed by one tool-role result per call.
     * Follows the relaxed _validateMessages contract (assistant content:null
     * + tool_calls; tool messages with content + tool_call_id).
     * @private
     */
    _transcriptFor(npcEntityId) {
        const rounds = this._transcripts.get(npcEntityId) || [];
        const messages = [];
        for (const entry of rounds) {
            if (!entry || !entry.assistant) continue;
            const assistantMessage = entry.assistant;
            const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
            // A replayed assistant message must keep either content or tool_calls.
            const hasContent = typeof assistantMessage.content === 'string' && assistantMessage.content.length > 0;
            if (hasContent || toolCalls.length > 0) {
                const replay = {
                    role: 'assistant',
                    content: hasContent ? assistantMessage.content : null,
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                };
                // Re-send the model's own reasoning_content when the
                // provider produced one: reasoning models served through an
                // OpenAI-compatible endpoint (the DeepSeek/Qwen family -
                // the local stack this world runs on) expect their
                // reasoning replayed in multi-turn; pi's openai-completions
                // adapter handles this same model class the same way (it
                // even injects an empty reasoning_content when the compat
                // table asks for it). Only what the model actually said is
                // passed through.
                if (typeof assistantMessage.reasoning_content === 'string') {
                    replay.reasoning_content = assistantMessage.reasoning_content;
                }
                messages.push(replay);
            }
            const results = Array.isArray(entry.results) ? entry.results : [];
            // Per-tool-name occurrence counters — the fallback id must match
            // the one stored at dispatch time (speakCallId indexes within the
            // same tool's call list, not the full tool_calls array).
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
                    tool_call_id: typeof call?.id === 'string' && call.id !== ''
                        ? call.id
                        : `call-${npcEntityId}-${entry.round}-${occurrence}`,
                    content: JSON.stringify({ success: Boolean(r.success), ...(r.detail ? { error: r.detail } : {}) })
                });
            }
        }
        return messages;
    }

    /**
     * Appends one round to the NPC's transcript (capped at 2 rounds).
     * @private
     */
    _storeTranscript(npcEntityId, round, entry) {
        const rounds = this._transcripts.get(npcEntityId) || [];
        rounds.push({ round, ...entry });
        this._transcripts.set(npcEntityId, rounds.slice(-TRANSCRIPT_ROUNDS));
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
     * @returns {{ speaks: Array<{id: string, args: Object}>, actions: Array<{id: string, args: Object}>, instincts: Array<{id: string, args: Object}>, approaches: Array<{id: string, args: Object}>, prose: string|null }}
     * @private
     */
    _parseToolCalls(message) {
        const speaks = [];
        const actions = [];
        const instincts = [];
        const approaches = [];
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
            // Unknown tool names: ignored (the schema is closed; the model is
            // told "respond ONLY with tool calls" from the known set).
        }
        return { speaks, actions, instincts, approaches, prose };
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
                // PLANNING_CLOSED / QUEUE_FULL / ENTITY_NOT_FOUND / ACTION_NOT_FOUND
                // Capture Point B (spec §4.2): immediate failure recording so the NPC
                // agent knows its action was rejected BEFORE resolution.
                this._recordImmediateOutcome(npcEntityId, actionName, false, q?.error || q?.code || 'queue rejected');
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
            this._recordImmediateOutcome(npcEntityId, actionName, false, detail);
            return { actionName, queued: false, success: false, detail };
        }

        // Immediate fallback (non-turn worlds/tests only).
        try {
            const exec = this.worldStateController?.executeAction?.(actionName, npcEntityId, clean);
            if (exec?.success) {
                return { actionName, queued: false, success: true, detail: 'executed immediately' };
            }
            this._recordImmediateOutcome(npcEntityId, actionName, false, exec?.error || 'execution failed');
            return { actionName, queued: false, success: false, detail: exec?.error || 'execution failed' };
        } catch (err) {
            this._recordImmediateOutcome(npcEntityId, actionName, false, err?.message || String(err));
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
        const instinctName = entry.args?.instinct;
        if (!instinctName || typeof instinctName !== 'string') {
            const detail = 'missing or invalid instinct name';
            result.actions.push({ actionName: 'use_instinct', success: false, detail, instinct: null });
            return { actions: [{ actionName: 'use_instinct', success: false, detail, instinct: null }], actionable: false, detail };
        }

        const fullName = `use_instinct(${instinctName})`;

        // Expand the instinct
        let expanded;
        try {
            expanded = this.instinctController.expand(npcEntityId, instinctName, {
                targetEntityId: entry.args?.targetEntityId
            });
        } catch (err) {
            const detail = err?.message || 'expansion failed';
            return { actions: [{ actionName: fullName, success: false, detail, instinct: instinctName }], actionable: true, detail };
        }

        if (!expanded.ok) {
            const detail = expanded.error || `expansion failed (${expanded.code})`;
            return { actions: [{ actionName: fullName, success: false, detail, instinct: instinctName }], actionable: true, detail };
        }

        // Dispatch each step in order
        const actions = [];
        let actionable = false;

        for (const step of expanded.steps) {
            const stepFullName = `use_instinct(${instinctName}):${step.actionName}`;

            // Pre-validate
            const validation = this._prevalidateAction(npcEntityId, step);
            if (!validation.ok) {
                const entry = { actionName: stepFullName, success: false, detail: validation.error, instinct: instinctName };
                actions.push(entry);
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
                instinct: instinctName
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
    // FEEDBACK / HELPERS
    // =========================================================================

    /**
     * Builds the retry-feedback tail of the conversation: the assistant's
     * tool-call message + one tool-role result per call + a user nudge
     * (spec §6.3.6).
     * @private
     */
    _buildFeedbackMessages(baseMessages, assistantMessage, parsed, result) {
        const toolCalls = Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : [];
        const feedback = [];

        const hasContent = typeof assistantMessage?.content === 'string' && assistantMessage.content.length > 0;
        if (hasContent || toolCalls.length > 0) {
            const replay = {
                role: 'assistant',
                content: hasContent ? assistantMessage.content : null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
            };
            // Same reasoning_content pass-through as _transcriptFor (the
            // in-round retry is a multi-turn continuation too).
            if (typeof assistantMessage?.reasoning_content === 'string') {
                replay.reasoning_content = assistantMessage.reasoning_content;
            }
            feedback.push(replay);
        }

        for (const call of toolCalls) {
            const fn = call?.function;
            const name = fn?.name;
            // The Parsed entry (from _parseToolCalls) carries the parsed args;
            // the raw assistant tool_call only has function.arguments (a JSON
            // string) — matching by id keeps the feedback faithful.
            const parsedEntry = call?.id
                ? [...(parsed.actions || []), ...(parsed.speaks || []), ...(parsed.instincts || []), ...(parsed.approaches || [])].find(p => p.id === call.id)
                : null;
            const actionName = parsedEntry ? String(parsedEntry.args?.actionName ?? '') : '';
            const instinctName = parsedEntry?.args?.instinct || null;
            let payload;
            if (name === 'speak_in_room') {
                payload = result.chat.sent
                    ? { success: true }
                    : { success: false, error: result.chat.reason || 'chat failed' };
            } else if (name === 'execute_action') {
                const matched = actionName
                    ? result.actions.find(a => a.actionName === actionName)
                    : null;
                payload = matched
                    ? { success: matched.success, ...(matched.detail ? { error: matched.detail } : {}) }
                    : { success: false, error: 'not dispatched' };
            } else if (name === 'toApproach') {
                const matched = result.approaches ? result.approaches.find(a => a.id === call.id || a.actionName === 'toApproach') : null;
                payload = matched
                    ? { success: matched.success, ...(matched.detail ? { error: matched.detail } : {}) }
                    : { success: false, error: 'not dispatched' };
            } else if (name === 'use_instinct') {
                // Aggregate over the call's steps: all success → true; else first failure
                const instinctActions = result.actions.filter(a => a.instinct === instinctName && a.actionName.startsWith(`use_instinct(${instinctName})`));
                const failed = instinctActions.find(a => !a.success);
                if (instinctActions.length === 0) {
                    payload = { success: false, error: 'not dispatched' };
                } else if (failed) {
                    payload = { success: false, error: failed.detail || 'instinct failed' };
                } else {
                    payload = { success: true };
                }
            } else {
                payload = { success: false, error: `unknown tool "${name}"` };
            }
            feedback.push({
                role: 'tool',
                tool_call_id: typeof call?.id === 'string' && call.id !== '' ? call.id : `call-${feedback.length}`,
                content: JSON.stringify(payload)
            });
        }

        const failures = [
            ...result.actions.filter(a => !a.success).map(a => `${a.actionName}: ${a.detail}`),
            ...result.approaches.filter(a => !a.success).map(a => `${a.actionName}: ${a.detail}`),
            ...(result.chat.sent === false && result.chat.reason && result.chat.reason !== 'prose-only' ? [`chat: ${result.chat.reason}`] : [])
        ];
        const summary = failures.length > 0 ? failures.join('; ') : 'previous call failed';
        feedback.push({
            role: 'user',
            content: `Your last action failed: ${summary}. Adjust parameters or pick a different action; you may also just talk.`
        });

        return feedback;
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

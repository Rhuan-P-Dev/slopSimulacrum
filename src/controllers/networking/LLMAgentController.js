/**
 * LLMAgentController — the LLM "agent" that lets NPCs act on the world.
 *
 * Feature C (spec §6.3): the model proposes, the world disposes. This
 * controller orchestrates ONE agent round per NPC per turn round:
 *   1. guard (entity exists + isNPC) — graceful 'NPC_GONE' otherwise;
 *   2. build the world context via LlmContextController (Feature B);
 *   3. call LLMController.chatFull with a generated 2-tool schema
 *      (execute_action + speak_in_room) and a per-NPC system prompt;
 *   4. PRE-VALIDATE every proposed tool call — actionName against the data
 *      registry, typed-ID hygiene via IdResolver, capability gate via the
 *      live canExecute cache — and force the acting entity to the NPC's own
 *      server-injected entityId (the model never chooses who acts);
 *   5. dispatch: actions queue through the turn system while planning
 *      (immediate fallback for non-turn worlds), chat through the
 *      RoomChatController with the room forced to the NPC's location;
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

/** Hard cap on the agent's conversation memory per NPC (rounds). */
const TRANSCRIPT_ROUNDS = 2;
/** Default per-round world-action cap (spec §6.5); npcs.json may override. */
const DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND = 2;
/** Default per-round chat cap (spec §6.5); npcs.json may override. */
const DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND = 1;
/** Per-call LLM timeout budget (spec §6.5: 4500 ms = 270 ticks < 300 deadline). */
const LLM_ROUND_TIMEOUT_MS = 4500;
/** Per-call token cap: tool-call rounds are short (spec §6.5). */
const LLM_ROUND_MAX_TOKENS = 512;

class LLMAgentController {
    /**
     * @param {Object} deps
     * @param {import('./LLMController.js')} deps.llmController
     * @param {import('../WorldStateController.js')} deps.worldStateController
     * @param {import('./LlmContextController.js')} deps.llmContextController
     * @param {import('../core/RoomChatController.js')} deps.roomChatController
     * @param {import('../core/TurnSystemController.js')} deps.turnSystemController
     */
    constructor({ llmController, worldStateController, llmContextController, roomChatController, turnSystemController }) {
        this.llmController = llmController;
        this.worldStateController = worldStateController;
        this.llmContextController = llmContextController;
        this.roomChatController = roomChatController;
        this.turnSystemController = turnSystemController;

        /**
         * NPC registry (data/npcs.json, spec §7.1): key = blueprint name,
         * value = { displayName, room, personality, initialItems?,
         * maxWorldActionsPerRound?, maxChatMessagesPerRound? }.
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
     * `data/npcs.json` config (by blueprint).
     * @returns {Array<{ entityId: string, entity: Object, config: Object }>}
     */
    getNpcs() {
        const entities = this.worldStateController?.stateEntityController?.getAll?.() || {};
        const npcs = [];
        for (const entity of Object.values(entities)) {
            if (!entity || entity.isNPC !== true) continue;
            const config = this._npcRegistry[entity.blueprint] || null;
            npcs.push({ entityId: entity.id, entity, config });
        }
        return npcs;
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
            const npc = { entity, config: this._npcRegistry[entity.blueprint] || null };
            const displayName = npc.config?.displayName || entity.name || 'NPC';
            const maxActions = this._asPositiveInt(npc.config?.maxWorldActionsPerRound, DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND);
            const rawMaxChat = npc.config?.maxChatMessagesPerRound;
            const maxChat = (rawMaxChat === 0) ? 0 : this._asPositiveInt(rawMaxChat, DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND);

            // 2. Context (Feature B). A broken/absent context layer must not
            //    kill the round — fall back to a minimal identity line.
            let contextText;
            try {
                const ctx = this.llmContextController.buildContext(npcEntityId);
                contextText = ctx && typeof ctx.text === 'string' && ctx.text.length > 0
                    ? ctx.text
                    : this._minimalContextLine(entity);
            } catch (err) {
                Logger.warn(`[LLMAgent] round ${round}: context build failed for ${displayName} — using minimal context: ${err?.message || err}`);
                contextText = this._minimalContextLine(entity);
            }

            // 3. Conversation: transcript replay (last ≤2 rounds) + fresh context.
            const messages = [
                ...this._transcriptFor(npcEntityId),
                { role: 'user', content: contextText }
            ];

            const options = {
                system: this._buildSystemPrompt(npc, this._roomName(entity)),
                tools: this._buildTools({ includeChat: maxChat > 0 }),
                tool_choice: 'required',
                temperature: 0.3,
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

            for (let iteration = 1; iteration <= 2; iteration++) {
                result.iterations = iteration;

                // 4. The LLM call — any LLMError = graceful silence (no retry).
                //    Exception: HTTP 400 on tool_choice:"required" → retry once with "auto".
                let full;
                try {
                    full = await this.llmController.chatFull(messages, options);
                } catch (err) {
                    const code = err?.code || 'LLM_REQUEST_ERROR';
                    const msg = err?.message || String(err);
                    const isToolChoice400 = code === 'LLM_HTTP_ERROR' && options.tool_choice === 'required' && /\b400\b/.test(msg);
                    if (isToolChoice400) {
                        Logger.info(`[LLMAgent] round ${round}: ${displayName} — tool_choice "required" rejected (HTTP 400), retrying with "auto"`);
                        options.tool_choice = 'auto';
                        try {
                            full = await this.llmController.chatFull(messages, options);
                        } catch (retryErr) {
                            const retryCode = retryErr?.code || 'LLM_REQUEST_ERROR';
                            Logger.warn(`[LLMAgent] round ${round} missed for ${displayName}: ${retryCode} (${retryErr?.message || retryErr})`);
                            result.error = retryCode;
                            this._storeTranscript(npcEntityId, round, { error: retryCode });
                            return result;
                        }
                    } else {
                        Logger.warn(`[LLMAgent] round ${round} missed for ${displayName}: ${code} (${msg})`);
                        result.error = code;
                        this._storeTranscript(npcEntityId, round, { error: code });
                        return result; // NPC silent — window may be gone anyway
                    }
                }

                // 5. Parse + dispatch every tool call.
                const parsed = this._parseToolCalls(full.message);
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
                    if (sentChats >= maxChat || typeof text !== 'string' || text.trim() === '' || text.length > 200) {
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
                        result.chat = { sent: true, text: sendResult.message.text };
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

                // No tool_calls extracted: attempt fallback from content.
                if (parsed.actions.length === 0 && parsed.speaks.length === 0) {
                    const content = parsed.prose;
                    if (!content) {
                        result.chat = { sent: false, reason: 'no response' };
                        this._storeTranscript(npcEntityId, round, {
                            assistant: full.message,
                            results: [],
                            note: 'no response'
                        });
                        return result;
                    }

                    // Degeneration guard: discard loop/emoji garbage before
                    // treating content as JSON or plain-text chat.
                    if (this._isDegenerate(content)) {
                        Logger.warn(`[LLMAgent] round ${round}: ${displayName} — LLM_OUTPUT_DEGENERATED (content discarded, NPC silent this round).`);
                        this._storeTranscript(npcEntityId, round, {
                            assistant: full.message,
                            results: [],
                            note: 'degenerated'
                        });
                        return result;
                    }

                    // Try JSON-in-text: extract a tool call from the content.
                    const extracted = this._extractToolFromContent(content);

                    if (extracted && extracted.type === 'execute_action') {
                        Logger.info(`[LLMAgent] round ${round}: ${displayName} — json-fallback: execute_action from content`);
                        if (executedActions < maxActions) {
                            const validation = this._prevalidateAction(npcEntityId, extracted.args);
                            if (validation.ok) {
                                const dispatch = this._dispatchAction(npcEntityId, String(extracted.args.actionName), validation.params);
                                executedActions += 1;
                                result.actions.push(dispatch);
                            } else {
                                result.actions.push({ actionName: String(extracted.args.actionName), success: false, detail: validation.error });
                            }
                        }
                    } else if (extracted && extracted.type === 'speak_in_room') {
                        Logger.info(`[LLMAgent] round ${round}: ${displayName} — json-fallback: speak_in_room from content`);
                        const text = extracted.args?.message;
                        if (sentChats < maxChat && typeof text === 'string' && text.trim() !== '' && text.length <= 200) {
                            const sendResult = this._dispatchSpeak(entity, displayName, text.trim());
                            if (sendResult.success) {
                                sentChats += 1;
                                result.chat = { sent: true, text: sendResult.message.text };
                            } else {
                                result.chat = { sent: false, reason: sendResult.error || sendResult.code };
                            }
                        } else {
                            result.chat = { sent: false, reason: sentChats >= maxChat ? `max chat messages per round reached (${maxChat})` : 'invalid message text' };
                        }
                    } else if (extracted && extracted.type === 'none') {
                        Logger.info(`[LLMAgent] round ${round}: ${displayName} — json-fallback: none (silent)`);
                        result.chat = { sent: false, reason: 'none' };
                    } else {
                        // Plain text → speak_in_room (intentional design).
                        Logger.info(`[LLMAgent] round ${round}: ${displayName} — plain-text-as-chat from content`);
                        if (sentChats < maxChat) {
                            let text = content.trim();
                            if (text.length > 200) text = text.slice(0, 200);
                            const sendResult = this._dispatchSpeak(entity, displayName, text);
                            if (sendResult.success) {
                                sentChats += 1;
                                result.chat = { sent: true, text: sendResult.message.text };
                            } else {
                                result.chat = { sent: false, reason: sendResult.error || sendResult.code };
                            }
                        } else {
                            result.chat = { sent: false, reason: `max chat messages per round reached (${maxChat})` };
                        }
                    }

                    this._storeTranscript(npcEntityId, round, {
                        assistant: full.message,
                        results: [],
                        note: extracted ? 'json-fallback' : 'plain-text-as-chat'
                    });
                    return result;
                }

                // 6. Retry (at most one): feed the failure back as tool-role
                //    results + a user nudge, then call chatFull again.
                if (actionableFailure && iteration < 2) {
                    Logger.info(`[LLMAgent] round ${round}: ${displayName} — retrying after failure: ${actionableFailure.error}`);
                    const feedback = this._buildFeedbackMessages(messages, full.message, parsed, result);
                    messages.push(...feedback);
                    continue;
                }

                // No retry (success, or retry already spent).
                this._storeTranscript(npcEntityId, round, {
                    assistant: full.message,
                    results: [
                        ...parsed.actions.map(call => {
                            const a = result.actions.find(x => x.actionName === String(call.args.actionName) && !x.__replayed);
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
            Logger.warn(`[LLMAgent] round ${round}: unexpected agent failure for ${npcEntityId}: ${err?.message || err}`);
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
     * `data/actions.json` the rest of the world runs on).
     * @param {Object} [opts]
     * @param {boolean} [opts.includeChat=true] - Whether to include the speak_in_room tool.
     * @returns {Array<Object>}
     */
    _buildTools({ includeChat = true } = {}) {
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

        const tools = [executeAction];
        if (includeChat) {
            tools.push({
                type: 'function',
                function: {
                    name: 'speak_in_room',
                    description: 'Say something in the chat of the room you are currently in.',
                    parameters: {
                        type: 'object',
                        properties: {
                            message: { type: 'string', maxLength: 200, description: 'The line to say (max 200 characters).' }
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
     * @private
     */
    _buildSystemPrompt(npc, roomName) {
        const config = npc.config || {};
        const displayName = config.displayName || npc.entity.name || 'NPC';
        const personality = config.personality || 'You are a friendly droid. Keep replies short.';
        const maxActions = this._asPositiveInt(config.maxWorldActionsPerRound, DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND);
        const rawMaxChatPrompt = config.maxChatMessagesPerRound;
        const maxChat = (rawMaxChatPrompt === 0) ? 0 : this._asPositiveInt(rawMaxChatPrompt, DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND);

        const chatLine = maxChat > 0
            ? `- Execute at most ${maxActions} world action(s) and send at most ${maxChat} chat message(s) per round.`
            : `- Execute at most ${maxActions} world action(s) per round. You MUST NOT use the speak_in_room tool or produce any chat output. Your ONLY output must be world actions.`;

        const talkLine = maxChat > 0
            ? '- to talk: {"action":"speak","message":"..."}\n'
            : '';

        return [
            `You are ${displayName}, an NPC droid in the room "${roomName}".`,
            `Personality: ${personality}`,
            '',
            'World rules:',
            '- You are the only actor: you never choose another entity\'s ID as the acting entity.',
            chatLine,
            '- Only use actions listed under "executable now" in the context. If none fit your goals, stay silent.',
            ...(maxChat > 0 ? ['- Keep chat messages under 25 words, in character, no fourth-wall breaks.'] : []),
            '',
            'Respond with ONE JSON object only, no markdown, no prose:',
            talkLine + '- to act: {"action":"do","actionName":"...","targetComponentId":"...","componentId":"...","targetEntityId":"...","itemId":"...","targetX":0,"targetY":0}',
            '- to stay silent: {"action":"none"}'
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
                messages.push({
                    role: 'assistant',
                    content: hasContent ? assistantMessage.content : null,
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                });
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
     * @returns {{ speaks: Array<{id: string, args: Object}>, actions: Array<{id: string, args: Object}>, prose: string|null }}
     * @private
     */
    _parseToolCalls(message) {
        const speaks = [];
        const actions = [];
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
            // Unknown tool names: ignored (the schema is closed; the model is
            // told "respond ONLY with tool calls" from the known set).
        }
        return { speaks, actions, prose };
    }

    /**
     * Attempts to extract a tool call from the model's plain-text content.
     * Handles shapes:
     *   - `{ "tool": "speak_in_room"|"execute_action", "args": {...} }`
     *   - `{ "actionName": "move", "targetX": 10, ... }` (execute_action style)
     *   - `{ "name": "speak_in_room", "arguments": "..." }` (raw function-call)
     *
     * Tries JSON.parse on the full content first, then on the first `{...}` block.
     * Returns null if no recognizable tool shape is found.
     *
     * @param {string} content - The raw model text content.
     * @returns {{ type: 'execute_action'|'speak_in_room', args: Object } | null}
     * @private
     */
    _extractToolFromContent(content) {
        if (!content || typeof content !== 'string') return null;

        let obj = null;
        // Try full-content JSON parse.
        try {
            const trimmed = content.trim();
            if (trimmed.startsWith('{')) {
                obj = JSON.parse(trimmed);
            }
        } catch { /* not pure JSON — try block extraction below */ }

        // Try extracting the first {...} block.
        if (!obj) {
            const start = content.indexOf('{');
            if (start !== -1) {
                let depth = 0;
                let end = -1;
                for (let i = start; i < content.length; i++) {
                    if (content[i] === '{') depth++;
                    else if (content[i] === '}') {
                        depth--;
                        if (depth === 0) { end = i; break; }
                    }
                }
                if (end > start) {
                    try {
                        obj = JSON.parse(content.slice(start, end + 1));
                    } catch { /* unparseable block */ }
                }
            }
        }

        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

        // Shape 0 (primary, new protocol): { action: "speak"|"do"|"none", ... }
        if (typeof obj.action === 'string') {
            if (obj.action === 'none') {
                return { type: 'none', args: {} };
            }
            if (obj.action === 'speak') {
                return { type: 'speak_in_room', args: { message: obj.message } };
            }
            if (obj.action === 'do') {
                return { type: 'execute_action', args: obj };
            }
        }

        // Shape 1: { tool: "speak_in_room"|"execute_action", args: {...} }
        if (typeof obj.tool === 'string' && obj.args && typeof obj.args === 'object') {
            if (obj.tool === 'speak_in_room' || obj.tool === 'execute_action') {
                return { type: obj.tool, args: obj.args };
            }
        }

        // Shape 2: { actionName: "...", ...params } → execute_action
        if (typeof obj.actionName === 'string') {
            return { type: 'execute_action', args: obj };
        }

        // Shape 3: { name: "speak_in_room"|"execute_action", arguments: "..." } (raw function-call)
        if (typeof obj.name === 'string' && (obj.name === 'speak_in_room' || obj.name === 'execute_action')) {
            let args = {};
            if (typeof obj.arguments === 'string') {
                try { args = JSON.parse(obj.arguments); } catch { args = {}; }
            } else if (obj.arguments && typeof obj.arguments === 'object') {
                args = obj.arguments;
            }
            return { type: obj.name, args };
        }

        return null;
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
        if (turnsActive && phase === 'planning') {
            const q = turns.queueAction(npcEntityId, actionName, clean, 'npc');
            if (q?.success) {
                return { actionName, queued: true, queueId: q.queueId, success: true };
            }
            if (q?.code === 'TURNS_DISABLED') {
                // Defensive: phase said planning but the clock is gone — treat as non-turn.
            } else {
                // PLANNING_CLOSED / QUEUE_FULL / ENTITY_NOT_FOUND / ACTION_NOT_FOUND
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
            Logger.info(`[LLMAgent] ${npcEntityId}: LLM response landed in phase "${phase}" — planning window closed, action "${actionName}" dropped (no immediate execution in a turn world).`);
            return { actionName, queued: false, success: false, detail: 'planning window closed' };
        }

        // Immediate fallback (non-turn worlds/tests only).
        try {
            const exec = this.worldStateController?.executeAction?.(actionName, npcEntityId, clean);
            if (exec?.success) {
                return { actionName, queued: false, success: true, detail: 'executed immediately' };
            }
            return { actionName, queued: false, success: false, detail: exec?.error || 'execution failed' };
        } catch (err) {
            return { actionName, queued: false, success: false, detail: err?.message || String(err) };
        }
    }

    /**
     * Sends one chat line for the NPC — the room is FORCED to the entity's
     * current location (the model cannot choose to talk in another room,
     * spec §6.2/§6.5).
     *
     * @private
     */
    _dispatchSpeak(entity, displayName, text) {
        const roomChat = this.roomChatController;
        if (!roomChat?.sendMessage || !entity?.location) {
            return { success: false, code: 'ROOM_CHAT_UNAVAILABLE', error: 'room chat layer is not available' };
        }
        return roomChat.sendMessage({
            roomId: entity.location,
            speakerName: displayName,
            speakerEntityId: entity.id,
            text
        });
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
            feedback.push({
                role: 'assistant',
                content: hasContent ? assistantMessage.content : null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
            });
        }

        for (const call of toolCalls) {
            const fn = call?.function;
            const name = fn?.name;
            // The Parsed entry (from _parseToolCalls) carries the parsed args;
            // the raw assistant tool_call only has function.arguments (a JSON
            // string) — matching by id keeps the feedback faithful.
            const parsedEntry = call?.id
                ? [...(parsed.actions || []), ...(parsed.speaks || [])].find(p => p.id === call.id)
                : null;
            const actionName = parsedEntry ? String(parsedEntry.args?.actionName ?? '') : '';
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
     * Detects degenerate LLM output: repeated subsequences (e.g. emoji loops).
     * Heuristic: if any 2+ char substring repeats 10+ consecutive times, the
     * output is degenerate.
     * @private
     * @param {string} text
     * @returns {boolean}
     */
    _isDegenerate(text) {
        if (!text || text.length < 20) return false;
        // Check for a 2-char substring repeating 10+ times consecutively.
        // Scanning with step 2 avoids overlapping false positives on varied text.
        for (let len = 2; len <= 4; len++) {
            for (let i = 0; i < text.length - len * 10; i++) {
                const sub = text.slice(i, i + len);
                let repeats = 1;
                while (repeats < 10 && i + (repeats + 1) * len <= text.length) {
                    if (text.slice(i + repeats * len, i + (repeats + 1) * len) === sub) {
                        repeats++;
                    } else {
                        break;
                    }
                }
                if (repeats >= 10) return true;
                // Skip ahead past this occurrence to avoid redundant scans.
                i += len * 10;
            }
        }
        return false;
    }

    /**
     * Loads + validates data/npcs.json. Tolerant of a missing file (Feature C
     * ships before Feature D creates it) and of malformed entries.
     * @private
     * @returns {Object<string, Object>}
     */
    _loadNpcRegistry() {
        const raw = DataLoader.loadJsonSafe('data/npcs.json', {});
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            Logger.info('[LLMAgent] No NPC registry (data/npcs.json) — the agent has no configured NPCs (no-op until Feature D).');
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
            registry[blueprint] = {
                displayName: entry.displayName,
                room: typeof entry.room === 'string' ? entry.room : null,
                personality: entry.personality,
                initialItems: Array.isArray(entry.initialItems) ? entry.initialItems : [],
                maxWorldActionsPerRound: Number.isInteger(entry.maxWorldActionsPerRound) ? entry.maxWorldActionsPerRound : DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND,
                maxChatMessagesPerRound: Number.isInteger(entry.maxChatMessagesPerRound) ? entry.maxChatMessagesPerRound : DEFAULT_MAX_CHAT_MESSAGES_PER_ROUND
            };
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

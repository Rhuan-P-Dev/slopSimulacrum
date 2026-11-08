import Logger from '../../utils/Logger.js';
import { LLMError } from '../../utils/CustomErrors.js';
import { requestJson } from '../../utils/HttpClient.js';
import {
    LLM_DEFAULT_ENDPOINT,
    LLM_DEFAULT_MODEL,
    LLM_DEFAULT_TEMPERATURE,
    LLM_DEFAULT_MAX_TOKENS,
    LLM_DEFAULT_TIMEOUT_MS,
    LLM_LOG_TRUNCATION_CHARS
} from '../../utils/Constants.js';

/** How deep the cause projection walks before stopping (guards a cyclic chain). */
const MAX_CAUSE_DEPTH = 2;
/** How many sibling errors of an `AggregateError` are logged. */
const MAX_AGGREGATE_CAUSES = 3;
/** Socket fields that identify *which* endpoint failed. */
const CAUSE_SOCKET_FIELDS = ['syscall', 'address', 'port'];

/**
 * Projects one link of an error chain into JSON-safe log detail (OBS-1).
 *
 * `fetch` rejects with a bare `TypeError: fetch failed` for *every* transport
 * cause: connection refused, a socket reset mid-response, and the transport
 * header timeout (`UND_ERR_HEADERS_TIMEOUT`, which the Node client applies at
 * ~300s regardless of `LLM_TIMEOUT_MS`) all look identical at that level. Only
 * `error.cause` says which one happened, so the log line carries the projected
 * cause instead of the bare `fetch failed`.
 *
 * This shapes the LOG only. The thrown `LLMError.message` is the downstream
 * contract and stays byte-identical; the error object itself already carries
 * the cause.
 * @param {unknown} cause - a link of the chain (`error.cause`), any shape.
 * @param {number} depth - recursion depth; 0 is the direct cause.
 * @returns {Object|null} plain detail with the fields that exist, or null when
 *   this link says nothing (then nothing is added to the log).
 */
function projectErrorCause(cause, depth = 0) {
    if (!cause || typeof cause !== 'object' || depth > MAX_CAUSE_DEPTH) {
        return null;
    }

    const detail = {};
    if (typeof cause.name === 'string' && cause.name) detail.name = cause.name;
    if (typeof cause.code === 'string' && cause.code) detail.code = cause.code;
    if (typeof cause.message === 'string' && cause.message) {
        detail.message = cause.message.length > LLM_LOG_TRUNCATION_CHARS
            ? `${cause.message.slice(0, LLM_LOG_TRUNCATION_CHARS)}...`
            : cause.message;
    }
    // Which socket failed: the answer when `localhost` resolves to ::1 while the
    // backend listens on IPv4 only (ECONNREFUSED on one family, not the other).
    for (const field of CAUSE_SOCKET_FIELDS) {
        if (cause[field] !== undefined && cause[field] !== null) detail[field] = cause[field];
    }

    // A happy-eyeballs failure wraps every attempt in an AggregateError
    // (`errors`); a transport timeout wraps its own reason in `cause`. Either
    // way, one more link is worth logging, capped by MAX_CAUSE_DEPTH.
    if (Array.isArray(cause.errors) && cause.errors.length > 0) {
        const reasons = cause.errors
            .slice(0, MAX_AGGREGATE_CAUSES)
            .map((nested) => projectErrorCause(nested, depth + 1))
            .filter(Boolean);
        if (reasons.length > 0) detail.causes = reasons;
    } else {
        const nested = projectErrorCause(cause.cause, depth + 1);
        if (nested) detail.causes = nested;
    }

    return Object.keys(detail).length > 0 ? detail : null;
}

/**
 * LLMController handles all communication with the Large Language Model backend.
 * It abstracts the HTTP requests and ensures that the communication follows
 * the OpenAI Chat Completion pattern.
 *
 * Transport: {@link module:utils/HttpClient.requestJson} — a `node:http` /
 * `node:https` JSON client behind a fetch-shaped call — injected through the
 * constructor. `globalThis.fetch` is deliberately NOT used here: it caps a
 * non-streaming response at ~300s with no knob, which silently overrode
 * `LLM_TIMEOUT_MS`. There is still no LLM SDK (`wiki/decisions/llm-transport.md`).
 *
 * Design Decision: By centralizing LLM communication in this controller, we ensure
 * a single source of truth for the API schema and simplify the process of
 * switching LLM providers or updating the API version.
 *
 * Feature C (spec §6.1) — full-message return contract:
 *   - `chatFull(messages, options)` is the primary public method. It returns the
 *     COMPLETE first choice: `{ content, toolCalls, finishReason, message }`.
 *     A response whose `message.content` is `null` but carries a non-empty
 *     `tool_calls` array is VALID (this was the pre-fix `LLM_PARSE_ERROR` bug).
 *   - `chat(messages, options)` is now a string projection over `chatFull`:
 *     it returns `content` when it is a string, and keeps today's exact
 *     behavior otherwise (tool-only or empty response → `LLM_PARSE_ERROR`),
 *     so the `/chat` endpoint contract is 100% unchanged.
 *   - `options.timeout_ms` (positive number) overrides REQUEST_TIMEOUT_MS
 *     per call — the NPC agent needs a 4.5 s budget (spec §6.5); `/chat`
 *     keeps the env default (30 s).
 *   - `_validateMessages` is relaxed for agent multi-turn replay (spec §6.1.4):
 *     `tool` role is allowed (requires non-empty `content` + `tool_call_id`),
 *     and `assistant` may carry `content: null` iff `tool_calls` is non-empty.
 *
 * ---------------------------------------------------------------------------
 * ENVIRONMENT CONFIGURATION (all optional; safe defaults for local dev)
 * ---------------------------------------------------------------------------
 *   LLM_ENDPOINT    Base URL of the OpenAI-compatible chat-completions endpoint.
 *                   Default: http://127.0.0.1:20003/v1/chat/completions
 *
 *   LLM_API_KEY     Optional bearer token. When set, requests are sent with
 *                   `Authorization: Bearer <key>`. When unset, no
 *                   Authorization header is sent (local / auth-free model).
 *                   Default: (none)
 *
 *   LLM_MODEL       Default model id used when a call does not override
 *                   `options.model`.
 *                   Default: gpt-3.5-turbo
 *
 *   LLM_TIMEOUT_MS  Request timeout for a single LLM call, in milliseconds.
 *                   Values that are not positive finite numbers fall back to
 *                   the default.
 *                   Default: 30000
 *
 *                   This budget is the real ceiling: the transport applies no
 *                   separate header cutoff and its one deadline is the signal
 *                   built from this value (`src/utils/HttpClient.js`). Under
 *                   Node's global `fetch` it was not — anything above ~300s was
 *                   cut off by the transport at 300s and arrived as
 *                   `LLM_REQUEST_ERROR` / `fetch failed`, never `LLM_TIMEOUT`.
 *
 * ---------------------------------------------------------------------------
 * FAILURE LOGGING
 * ---------------------------------------------------------------------------
 * A transport failure is logged with its cause as structured context, because
 * `fetch failed` on its own does not say whether the backend refused the
 * connection, reset it mid-response, or hit the transport header timeout.
 * `LLM_TIMEOUT` (our own budget, `LLM_TIMEOUT_MS`) and `LLM_HTTP_ERROR` (a
 * status the backend returned) are separate branches and are logged as before.
 * ---------------------------------------------------------------------------
 *
 * Values are read from process.env at request time (cheap getters), so the
 * controller never captures a stale environment at construction.
 * ---------------------------------------------------------------------------
 */
class LLMController {
    /**
     * @param {Object} [options]
     * @param {Function} [options.transport] - the fetch-shaped JSON transport
     *   `(url, init) => Promise<{ ok, status, statusText, json, text }>`. Defaults
     *   to {@link module:utils/HttpClient.requestJson}. Tests inject a fake here
     *   instead of patching `globalThis.fetch`, which the seam no longer calls.
     */
    constructor({ transport = requestJson } = {}) {
        this._transport = transport;
    }

    /**
     * Configuration getters.
     *
     * These are intentionally `get`-style statics (not constants): they resolve
     * from process.env on each read so the controller honors environment
     * configuration without losing the previous public names (LLM_ENDPOINT,
     * DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS).
     */
    static get LLM_ENDPOINT() {
        return process.env.LLM_ENDPOINT || LLM_DEFAULT_ENDPOINT;
    }

    static get LLM_API_KEY() {
        return process.env.LLM_API_KEY || null;
    }

    static get DEFAULT_MODEL() {
        return process.env.LLM_MODEL || LLM_DEFAULT_MODEL;
    }

    static get DEFAULT_TEMPERATURE() {
        return LLM_DEFAULT_TEMPERATURE;
    }

    static get DEFAULT_MAX_TOKENS() {
        return LLM_DEFAULT_MAX_TOKENS;
    }

    static get REQUEST_TIMEOUT_MS() {
        const raw = Number(process.env.LLM_TIMEOUT_MS);
        return Number.isFinite(raw) && raw > 0 ? raw : LLM_DEFAULT_TIMEOUT_MS;
    }

    /**
     * Sends a prompt to the LLM and returns the generated response content.
     *
     * String projection over {@link chatFull}: the `/chat` endpoint contract is
     * preserved exactly — a plain call sends no tools, so a tool-only response
     * is genuinely malformed here (spec §6.1.2).
     *
     * @param {Array<{role: string, content: string}>} messages - An array of message objects.
     * @param {Object} [options] - Optional parameters to override defaults (see chatFull).
     * @returns {Promise<string>} The content of the LLM response.
     * @throws {Error} If the request messages are invalid.
     * @throws {LLMError} If the request fails, with `code` one of:
     *   `LLM_TIMEOUT`, `LLM_HTTP_ERROR`, `LLM_PARSE_ERROR`, `LLM_REQUEST_ERROR`.
     */
    async chat(messages, options = {}) {
        const full = await this.chatFull(messages, options);

        if (typeof full.content === 'string') {
            return full.content;
        }

        // A plain /chat call sends no tools: a tool-only (or empty) response
        // is malformed for this contract — today's behavior, preserved.
        if (full.toolCalls.length > 0) {
            Logger.error('[LLMController] chat() received a tool-call-only response on a call that sends no tools — treating as malformed.');
            throw new LLMError(
                'LLMController: Received a tool-call response on a chat() call that sends no tools.',
                'LLM_PARSE_ERROR'
            );
        }

        Logger.error('[LLMController] Malformed response from LLM backend');
        throw new LLMError(
            'LLMController: Received malformed response from LLM backend. Expected choices[0].message.content.',
            'LLM_PARSE_ERROR'
        );
    }

    /**
     * Sends a prompt to the LLM and returns the FULL first-choice message
     * (spec §6.1.1) — the building block for tool-calling agent flows.
     *
     * Valid ⇔ `choices[0].message` exists AND (`typeof message.content ===
     * 'string'` OR `message.tool_calls` is a non-empty array). This is the
     * pre-fix bug fix: a tool-call response with `content: null` resolves
     * instead of throwing `LLM_PARSE_ERROR`.
     *
     * @param {Array<Object>} messages - Conversation messages. Allowed roles:
     *   `system`, `user`, `assistant`, `tool` (agent multi-turn replay, §6.1.4).
     * @param {Object} [options]
     * @param {string} [options.model] - The model ID to use.
     * @param {number|null} [options.temperature] - Sampling temperature
     *   (0.0 to 2.0). `null` is an explicit opt-out: the field is not sent
     *   and the provider's own default applies (absent still means the
     *   seam's DEFAULT_TEMPERATURE). The card-relationship judgment sends
     *   `null` because on its reasoning backend the sampling is the
     *   provider's to own (wiki/decisions/card-user-relationship.md).
     * @param {number} [options.max_tokens] - Maximum number of tokens to generate.
     * @param {string} [options.system] - Optional system prompt. When provided,
     *   it is prepended to the conversation as the first `{ role: 'system' }`
     *   message.
     * @param {Array<Object>} [options.tools] - OpenAI-compatible `tools`
     *   definitions, included in the payload verbatim when present.
     * @param {string|Object} [options.tool_choice] - `tool_choice` directive,
     *   included verbatim when provided.
     * @param {number} [options.timeout_ms] - Per-call timeout override in ms
     *   (positive finite number). The NPC agent passes 450000 ms (7.5 min; LLM_ROUND_TIMEOUT_MS in
     *   LLMAgentController) because a full local-model reasoning turn can take tens of seconds.
     *   Absent/invalid → `REQUEST_TIMEOUT_MS` (env default).
     * @param {boolean} [options.thinkingEnabled] - Reasoning switch, sent as the
     *   chat-template kwarg `chat_template_kwargs: { enable_thinking: <boolean> }`
     *   (the spelling llama.cpp and vLLM honour). Absent means the payload does not
     *   mention reasoning at all, so a caller with no opinion keeps the server's own
     *   default, and a server that does not know the field is never sent one. Only
     *   `true` / `false` are sent; see the note at the assembly site for why `false`
     *   must not be tested for truthiness.
     * @returns {Promise<{
     *   content: string|null,
     *   toolCalls: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>,
     *   finishReason: string|null,
     *   message: Object
     * }>}
     *   `message` is the raw `choices[0].message` (for tool-role replay).
     * @throws {Error} If the request messages are invalid.
     * @throws {LLMError} `LLM_TIMEOUT` | `LLM_HTTP_ERROR` | `LLM_PARSE_ERROR` | `LLM_REQUEST_ERROR`.
     */
    async chatFull(messages, options = {}) {
        this._validateMessages(messages);

        // When a system prompt is supplied, prepend it as the first message.
        // (Kept separate from `messages` so callers can pass a plain history.)
        let finalMessages = messages;
        if (typeof options.system === 'string' && options.system.length > 0) {
            finalMessages = [{ role: 'system', content: options.system }, ...messages];
        }

        const payload = {
            model: options.model || LLMController.DEFAULT_MODEL,
            messages: finalMessages,
            max_tokens: options.max_tokens || LLMController.DEFAULT_MAX_TOKENS,
            stream: false
        };
        // Sampling temperature. Absent means the seam's own default; an
        // explicit `null` is the opt-out — the field is left off the payload
        // entirely, so the provider's own default applies (the same
        // absent-versus-explicit distinction as the thinking switch below).
        if (options.temperature !== null) {
            payload.temperature = options.temperature !== undefined
                ? options.temperature
                : LLMController.DEFAULT_TEMPERATURE;
        }

        // Optional agentic parameters (OpenAI-compatible passthrough).
        if (Array.isArray(options.tools) && options.tools.length > 0) {
            payload.tools = options.tools;
        }
        if (options.tool_choice !== undefined) {
            payload.tool_choice = options.tool_choice;
        }

        // The reasoning switch. Sent only when the caller states a boolean: `false`
        // IS the instruction ("do not reason, answer directly"), so a truthiness
        // test would drop exactly the case the caller asked for; an absent option
        // stays absent, which is how the other prompt kinds (room chat, body design)
        // keep sending the body they send today. Measured on the llama.cpp Qwen3
        // backend this repo runs: this kwarg is the only spelling that actually
        // stops the model reasoning - `reasoning_effort` and a `thinking` kwarg are
        // both accepted with a 200 and silently ignored. See
        // wiki/decisions/llm-agent-thinking.md.
        if (typeof options.thinkingEnabled === 'boolean') {
            payload.chat_template_kwargs = { enable_thinking: options.thinkingEnabled };
        }

        const timeoutMs = this._resolveTimeoutMs(options.timeout_ms);
        const { message, finishReason } = await this._executeRequest(payload, timeoutMs);

        // Normalize tool_calls to the documented contract shape.
        const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
            .filter(tc => tc && typeof tc === 'object' && tc.function && typeof tc.function === 'object')
            .map(tc => ({
                id: typeof tc.id === 'string' ? tc.id : '',
                type: typeof tc.type === 'string' ? tc.type : 'function',
                function: {
                    name: typeof tc.function.name === 'string' ? tc.function.name : '',
                    arguments: typeof tc.function.arguments === 'string'
                        ? tc.function.arguments
                        : JSON.stringify(tc.function.arguments ?? {})
                }
            }));

        return {
            content: typeof message.content === 'string' ? message.content : null,
            toolCalls,
            finishReason,
            message
        };
    }

    /**
     * Resolves the per-call timeout: a positive finite number (or numeric
     * string) wins; anything else falls back to the env-driven default.
     * @private
     * @param {number|string|undefined} value
     * @returns {number}
     */
    _resolveTimeoutMs(value) {
        const num = typeof value === 'string' ? Number(value) : value;
        if (typeof num === 'number' && Number.isFinite(num) && num > 0) {
            return num;
        }
        return LLMController.REQUEST_TIMEOUT_MS;
    }

    /**
     * Internal method to execute the HTTP request with timeout and structured
     * error handling.
     * @private
     * @param {Object} payload - The request body.
     * @param {number} timeoutMs - Resolved timeout in ms.
     * @returns {Promise<{ message: Object, finishReason: string|null }>}
     */
    async _executeRequest(payload, timeoutMs) {
        const timeout = timeoutMs;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const headers = {
            'Content-Type': 'application/json'
        };
        const apiKey = LLMController.LLM_API_KEY;
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        try {
            Logger.debug(`[LLMController] Request payload:\n${JSON.stringify(payload, null, 2)}`);

            // CR E-5 (bounded external call): the caller's signal is this call's
            // only deadline, and the transport is built to honor it — unlike
            // globalThis.fetch, see src/utils/HttpClient.js.
            const response = await this._transport(LLMController.LLM_ENDPOINT, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!response.ok) {
                let detail = '';
                try {
                    const bodyText = await response.text();
                    detail = bodyText.length > LLM_LOG_TRUNCATION_CHARS ? `${bodyText.slice(0, LLM_LOG_TRUNCATION_CHARS)}...` : bodyText;
                } catch {
                    // Non-text or already-consumed error body: ignore.
                }
                const detailSuffix = detail ? ` — ${detail}` : '';
                Logger.error(`[LLMController] API error: ${response.status} ${response.statusText}${detailSuffix}`);
                throw new LLMError(
                    `LLM API error: HTTP ${response.status} ${response.statusText}${detailSuffix}`,
                    'LLM_HTTP_ERROR'
                );
            }

            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                Logger.error('[LLMController] Malformed JSON response from LLM backend');
                throw new LLMError(
                    'LLM returned a malformed (non-JSON) response.',
                    'LLM_PARSE_ERROR',
                    parseError
                );
            }

            const choice = data && Array.isArray(data.choices) && data.choices.length > 0 ? data.choices[0] : null;
            const rawMessage = choice && typeof choice.message === 'object' && choice.message !== null ? choice.message : null;
            Logger.debug(`[LLMController] Response (message + finishReason):\n${JSON.stringify({ message: rawMessage, finishReason: choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null }, null, 2)}`);

            return this._extractResponse(data);

        } catch (error) {
            // Re-throw structured LLM errors from above unchanged.
            if (error instanceof LLMError) {
                throw error;
            }
            if (error.name === 'AbortError') {
                Logger.error(`[LLMController] Request timed out after ${timeout}ms`);
                throw new LLMError(`LLM request timed out after ${timeout}ms`, 'LLM_TIMEOUT');
            }
            Logger.error(`[LLMController] Communication failure: ${error.message}`, projectErrorCause(error.cause));
            throw new LLMError(`LLM communication failure: ${error.message}`, 'LLM_REQUEST_ERROR', error);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Validates the request messages array (spec §6.1.4 — relaxed for agent
     * multi-turn replay):
     *   - allowed roles: system, user, assistant, tool;
     *   - system/user: non-empty string `content` (as before);
     *   - assistant: `content` may be `null`/absent IFF `tool_calls` is a
     *     non-empty array (the model's tool-call turn);
     *   - tool: non-empty string `content` AND a `tool_call_id` string.
     * @private
     */
    _validateMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            Logger.warn('[LLMController] Empty or invalid messages array');
            throw new Error('LLMController: "messages" must be a non-empty array.');
        }

        const allowedRoles = ['system', 'user', 'assistant', 'tool'];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg || typeof msg !== 'object') {
                Logger.warn(`[LLMController] Message at index ${i} is not an object`);
                throw new Error(`LLMController: Message at index ${i} must be an object.`);
            }

            if (!allowedRoles.includes(msg.role)) {
                Logger.warn(`[LLMController] Invalid role "${msg.role}" at index ${i}`);
                throw new Error(`LLMController: Invalid role "${msg.role}" at index ${i}. Expected ${allowedRoles.join(', ')}.`);
            }

            if (msg.role === 'system' || msg.role === 'user') {
                if (typeof msg.content !== 'string' || msg.content.length === 0) {
                    Logger.warn(`[LLMController] Message at index ${i} missing role or content`);
                    throw new Error(`LLMController: Message at index ${i} must contain "role" and a non-empty string "content".`);
                }
                continue;
            }

            if (msg.role === 'assistant') {
                const content = msg.content;
                if (content !== null && content !== undefined && typeof content !== 'string') {
                    throw new Error(`LLMController: Assistant message at index ${i} must have a string (or null) "content".`);
                }
                const hasContent = typeof content === 'string' && content.length > 0;
                const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
                if (!hasContent && !hasToolCalls) {
                    throw new Error(`LLMController: Assistant message at index ${i} must contain a non-empty "content" or a non-empty "tool_calls" array.`);
                }
                continue;
            }

            // role === 'tool'
            if (typeof msg.content !== 'string' || msg.content.length === 0) {
                throw new Error(`LLMController: Tool message at index ${i} must contain a non-empty string "content".`);
            }
            if (typeof msg.tool_call_id !== 'string' || msg.tool_call_id.length === 0) {
                throw new Error(`LLMController: Tool message at index ${i} must contain a "tool_call_id" string.`);
            }
        }
    }

    /**
     * Validates the LLM response schema and extracts the FULL first-choice
     * message (replaces the old `_validateAndExtractContent`, spec §6.1.3).
     *
     * Valid ⇔ `data.choices[0].message` exists AND (`typeof message.content ===
     * 'string'` OR `Array.isArray(message.tool_calls) && length > 0`).
     *
     * @private
     * @param {Object} data - Parsed JSON response.
     * @returns {{ message: Object, finishReason: string|null }}
     * @throws {LLMError} `LLM_PARSE_ERROR` for anything else (same code + log
     *   as before the fix).
     */
    _extractResponse(data) {
        const choice = (data && Array.isArray(data.choices) && data.choices.length > 0)
            ? data.choices[0]
            : null;
        const message = choice && typeof choice.message === 'object' && choice.message !== null
            ? choice.message
            : null;

        if (!message) {
            Logger.error('[LLMController] Malformed response from LLM backend');
            throw new LLMError(
                'LLMController: Received malformed response from LLM backend. Expected choices[0].message.',
                'LLM_PARSE_ERROR'
            );
        }

        const hasContent = typeof message.content === 'string';
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        if (!hasContent && !hasToolCalls) {
            Logger.error('[LLMController] Malformed response from LLM backend');
            throw new LLMError(
                'LLMController: Received malformed response from LLM backend. Expected choices[0].message.content or a non-empty tool_calls array.',
                'LLM_PARSE_ERROR'
            );
        }

        return {
            message,
            finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null
        };
    }
}

export default LLMController;

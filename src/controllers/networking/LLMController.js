import Logger from '../../utils/Logger.js';
import { LLMError } from '../../utils/CustomErrors.js';
import {
    LLM_DEFAULT_ENDPOINT,
    LLM_DEFAULT_MODEL,
    LLM_DEFAULT_TEMPERATURE,
    LLM_DEFAULT_MAX_TOKENS,
    LLM_DEFAULT_TIMEOUT_MS,
    LLM_LOG_TRUNCATION_CHARS
} from '../../utils/Constants.js';

/**
 * LLMController handles all communication with the Large Language Model backend.
 * It abstracts the HTTP requests and ensures that the communication follows
 * the OpenAI Chat Completion pattern.
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
 * Values are read from process.env at request time (cheap getters), so the
 * controller never captures a stale environment at construction.
 * ---------------------------------------------------------------------------
 */
class LLMController {
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
     * @param {number} [options.temperature] - Sampling temperature (0.0 to 2.0).
     * @param {number} [options.max_tokens] - Maximum number of tokens to generate.
     * @param {string} [options.system] - Optional system prompt. When provided,
     *   it is prepended to the conversation as the first `{ role: 'system' }`
     *   message.
     * @param {Array<Object>} [options.tools] - OpenAI-compatible `tools`
     *   definitions, included in the payload verbatim when present.
     * @param {string|Object} [options.tool_choice] - `tool_choice` directive,
     *   included verbatim when provided.
     * @param {number} [options.timeout_ms] - Per-call timeout override in ms
     *   (positive finite number). The NPC agent uses 4500 (spec §6.5).
     *   Absent/invalid → `REQUEST_TIMEOUT_MS` (env default).
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
            temperature: options.temperature !== undefined ? options.temperature : LLMController.DEFAULT_TEMPERATURE,
            max_tokens: options.max_tokens || LLMController.DEFAULT_MAX_TOKENS,
            stream: false
        };

        // Optional agentic parameters (OpenAI-compatible passthrough).
        if (Array.isArray(options.tools) && options.tools.length > 0) {
            payload.tools = options.tools;
        }
        if (options.tool_choice !== undefined) {
            payload.tool_choice = options.tool_choice;
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

            const response = await fetch(LLMController.LLM_ENDPOINT, {
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
            Logger.error(`[LLMController] Communication failure: ${error.message}`);
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

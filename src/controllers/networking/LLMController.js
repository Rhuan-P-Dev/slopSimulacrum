import Logger from '../../utils/Logger.js';
import { LLMError } from '../../utils/CustomErrors.js';

/**
 * LLMController handles all communication with the Large Language Model backend.
 * It abstracts the HTTP requests and ensures that the communication follows
 * the OpenAI Chat Completion pattern.
 *
 * Design Decision: By centralizing LLM communication in this controller, we ensure
 * a single source of truth for the API schema and simplify the process of
 * switching LLM providers or updating the API version.
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
        return process.env.LLM_ENDPOINT || 'http://127.0.0.1:20003/v1/chat/completions';
    }

    static get LLM_API_KEY() {
        return process.env.LLM_API_KEY || null;
    }

    static get DEFAULT_MODEL() {
        return process.env.LLM_MODEL || 'gpt-3.5-turbo';
    }

    static get DEFAULT_TEMPERATURE() {
        return 0.7;
    }

    static get DEFAULT_MAX_TOKENS() {
        return 2048;
    }

    static get REQUEST_TIMEOUT_MS() {
        const raw = Number(process.env.LLM_TIMEOUT_MS);
        return Number.isFinite(raw) && raw > 0 ? raw : 30000;
    }

    /**
     * Sends a prompt to the LLM and returns the generated response.
     *
     * @param {Array<{role: string, content: string}>} messages - An array of message objects.
     * @param {Object} [options] - Optional parameters to override defaults.
     * @param {string} [options.model] - The model ID to use.
     * @param {number} [options.temperature] - Sampling temperature (0.0 to 2.0).
     * @param {number} [options.max_tokens] - Maximum number of tokens to generate.
     * @param {string} [options.system] - Optional system prompt. When provided,
     *   it is prepended to the conversation as the first `{ role: 'system' }`
     *   message (turns this isolated chat into a directed one).
     * @param {Array<Object>} [options.tools] - Optional array of tool/function
     *   definitions in the OpenAI-compatible `tools` format. Included in the
     *   request payload verbatim when present (non-empty array).
     * @param {string|Object} [options.tool_choice] - Optional `tool_choice`
     *   directive (e.g. 'auto', 'none', or a specific tool reference). Included
     *   in the payload verbatim when provided.
     * @returns {Promise<string>} The content of the LLM response.
     * @throws {Error} If the request messages are invalid.
     * @throws {LLMError} If the request fails, with `code` one of:
     *   `LLM_TIMEOUT`, `LLM_HTTP_ERROR`, `LLM_PARSE_ERROR`, `LLM_REQUEST_ERROR`.
     */
    async chat(messages, options = {}) {
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

        return await this._executeRequest(payload);
    }

    /**
     * Internal method to execute the HTTP request with timeout and structured
     * error handling.
     * @private
     */
    async _executeRequest(payload) {
        const timeoutMs = LLMController.REQUEST_TIMEOUT_MS;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const headers = {
            'Content-Type': 'application/json'
        };
        const apiKey = LLMController.LLM_API_KEY;
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        try {
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
                    detail = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
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

            return this._validateAndExtractContent(data);

        } catch (error) {
            // Re-throw structured LLM errors from above unchanged.
            if (error instanceof LLMError) {
                throw error;
            }
            if (error.name === 'AbortError') {
                Logger.error(`[LLMController] Request timed out after ${timeoutMs}ms`);
                throw new LLMError(`LLM request timed out after ${timeoutMs}ms`, 'LLM_TIMEOUT');
            }
            Logger.error(`[LLMController] Communication failure: ${error.message}`);
            throw new LLMError(`LLM communication failure: ${error.message}`, 'LLM_REQUEST_ERROR', error);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Validates that the request messages array is correctly formatted.
     * @private
     */
    _validateMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            Logger.warn('[LLMController] Empty or invalid messages array');
            throw new Error('LLMController: "messages" must be a non-empty array.');
        }

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg.role || !msg.content) {
                Logger.warn(`[LLMController] Message at index ${i} missing role or content`);
                throw new Error(`LLMController: Message at index ${i} must contain "role" and "content".`);
            }
            if (!['system', 'user', 'assistant'].includes(msg.role)) {
                Logger.warn(`[LLMController] Invalid role "${msg.role}" at index ${i}`);
                throw new Error(`LLMController: Invalid role "${msg.role}" at index ${i}. Expected system, user, or assistant.`);
            }
        }
    }

    /**
     * Validates the LLM response schema and extracts the content string.
     * @private
     */
    _validateAndExtractContent(data) {
        if (
            data &&
            Array.isArray(data.choices) &&
            data.choices.length > 0 &&
            data.choices[0].message &&
            typeof data.choices[0].message.content === 'string'
        ) {
            return data.choices[0].message.content;
        }
        Logger.error('[LLMController] Malformed response from LLM backend');
        throw new LLMError(
            'LLMController: Received malformed response from LLM backend. Expected choices[0].message.content.',
            'LLM_PARSE_ERROR'
        );
    }
}

export default LLMController;

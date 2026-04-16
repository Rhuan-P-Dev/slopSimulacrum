/**
 * LLMController handles all communication with the Large Language Model backend.
 * It abstracts the HTTP requests and ensures that the communication follows 
 * the OpenAI Chat Completion pattern.
 * 
 * Design Decision: By centralizing LLM communication in this controller, we ensure
 * a single source of truth for the API schema and simplify the process of 
 * switching LLM providers or updating the API version.
 */
class LLMController {
    /**
     * Configuration constants to avoid magic numbers.
     */
    static LLM_ENDPOINT = 'http://127.0.0.1:20003/v1/chat/completions';
    static DEFAULT_MODEL = 'gpt-3.5-turbo';
    static DEFAULT_TEMPERATURE = 0.7;
    static DEFAULT_MAX_TOKENS = 2048;
    static REQUEST_TIMEOUT_MS = 30000; // 30 seconds timeout for reliability

    /**
     * Sends a prompt to the LLM and returns the generated response.
     * 
     * @param {Array<{role: string, content: string}>} messages - An array of message objects.
     * @param {Object} [options] - Optional parameters to override defaults.
     * @param {string} [options.model] - The model ID to use.
     * @param {number} [options.temperature] - Sampling temperature (0.0 to 2.0).
     * @param {number} [options.max_tokens] - Maximum number of tokens to generate.
     * @returns {Promise<string>} The content of the LLM response.
     * @throws {Error} If the request fails, times out, or returns a malformed response.
     */
    async chat(messages, options = {}) {
        this._validateMessages(messages);

        const payload = {
            model: options.model || LLMController.DEFAULT_MODEL,
            messages: messages,
            temperature: options.temperature !== undefined ? options.temperature : LLMController.DEFAULT_TEMPERATURE,
            max_tokens: options.max_tokens || LLMController.DEFAULT_MAX_TOKENS,
            stream: false
        };

        return await this._executeRequest(payload);
    }

    /**
     * Internal method to execute the HTTP request with timeout and error handling.
     * @private
     */
    async _executeRequest(payload) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), LLMController.REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(LLMController.LLM_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return this._validateAndExtractContent(data);

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('LLM request timed out after ' + LLMController.REQUEST_TIMEOUT_MS + 'ms');
            }
            throw new Error(`LLM Communication Failure: ${error.message}`);
        }
    }

    /**
     * Validates that the request messages array is correctly formatted.
     * @private
     */
    _validateMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new Error('LLMController: "messages" must be a non-empty array.');
        }

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg.role || !msg.content) {
                throw new Error(`LLMController: Message at index ${i} must contain "role" and "content".` || 'Invalid message format');
            }
            if (!['system', 'user', 'assistant'].includes(msg.role)) {
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
        throw new Error('LLMController: Received malformed response from LLM backend. Expected choices[0].message.content.');
    }
}

export default LLMController;

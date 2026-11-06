/**
 * LLMController.chatFull contract tests (Feature C, spec §6.1 / §6.8).
 *
 * No real network: the controller's transport is injected per-test
 * (`new LLMController({ transport })`). The seam no longer calls
 * `globalThis.fetch` — it goes through `src/utils/HttpClient.js` (`node:http`),
 * whose own behavior is pinned by `test/unit/HttpClient.test.js`. The injected
 * fake keeps the fetch shape `(url, init) => { ok, status, statusText, json, text }`,
 * so payload assertions are unchanged.
 *
 * Covers the spec §6.8 checklist items owned by LLMController:
 *   - chatFull on a tool-call response (content:null) RESOLVES with
 *     content:null + parsed toolCalls (the pre-fix bug threw LLM_PARSE_ERROR);
 *   - chat() with a plain content response → identical string as before
 *     (the /chat endpoint contract is preserved);
 *   - chat() with a tool-only response on a no-tools call → LLM_PARSE_ERROR;
 *   - _validateMessages accepts the agent multi-turn shape (assistant
 *     content:null + tool_calls; tool role with content + tool_call_id) and
 *     still rejects role:'tool' without content;
 *   - structured errors: LLM_TIMEOUT (AbortError), LLM_HTTP_ERROR (5xx).
 *
 * @module test/unit/LLMController.chatFull
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import LLMController from '../../src/controllers/networking/LLMController.js';
import Logger from '../../src/utils/Logger.js';
import { LLM_LOG_TRUNCATION_CHARS } from '../../src/utils/Constants.js';

/** Builds a Response-like object from a JSON payload. */
function jsonResponse(data, { status = 200, statusText = 'OK' } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        json: async () => data,
        text: async () => JSON.stringify(data)
    };
}

/**
 * A controller whose outbound call is `handler` (fetch-shaped).
 * @param {Function} handler - `(url, init) => Promise<ResponseLike>`.
 * @returns {LLMController}
 */
function controllerWithTransport(handler) {
    return new LLMController({ transport: handler });
}

/** A controller whose transport rejects with `error`. */
function controllerRejecting(error) {
    return controllerWithTransport(vi.fn().mockRejectedValue(error));
}

/** A controller whose transport resolves with `data` as a 200 JSON response. */
function controllerReturning(data, init) {
    return controllerWithTransport(vi.fn().mockResolvedValue(jsonResponse(data, init)));
}

/** A standard tool-call response (content:null, one execute_action call). */
const TOOL_CALL_RESPONSE = {
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: 'call_abc123',
                type: 'function',
                function: {
                    name: 'execute_action',
                    arguments: '{"actionName":"selfHeal"}'
                }
            }]
        }
    }]
};

const PLAIN_RESPONSE = {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello world' } }]
};

describe('LLMController.chatFull (Feature C, spec §6.1)', () => {
    it('resolves a tool-call response (content:null) with parsed toolCalls — the pre-fix bug', async () => {
        const transport = vi.fn().mockResolvedValue(jsonResponse(TOOL_CALL_RESPONSE));

        const result = await controllerWithTransport(transport).chatFull(
            [{ role: 'user', content: 'go' }],
            { tools: [{ type: 'function', function: { name: 'execute_action', parameters: {} } }], tool_choice: 'auto' }
        );

        // The contract: full message, content:null preserved, tool calls normalized.
        expect(result.content).toBeNull();
        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toEqual({
            id: 'call_abc123',
            type: 'function',
            function: { name: 'execute_action', arguments: '{"actionName":"selfHeal"}' }
        });
        // `message` is the raw choices[0].message (for tool-role replay).
        expect(result.message.tool_calls).toHaveLength(1);

        // tools / tool_choice pass through verbatim in the payload.
        const payload = JSON.parse(transport.mock.calls[0][1].body);
        expect(payload.tools).toHaveLength(1);
        expect(payload.tool_choice).toBe('auto');
        expect(payload.stream).toBe(false);
    });

    it('hands the transport a signal — the caller budget is the only deadline (CR E-5)', async () => {
        const transport = vi.fn().mockResolvedValue(jsonResponse(PLAIN_RESPONSE));

        await controllerWithTransport(transport).chatFull([{ role: 'user', content: 'go' }]);

        const [, init] = transport.mock.calls[0];
        expect(init.signal).toBeTruthy();
        expect(init.signal.aborted).toBe(false);
        // The node:http client sets no timeout of its own; nothing else may bound
        // the call either (wiki/decisions/llm-transport.md).
        expect(init).not.toHaveProperty('headersTimeout');
        expect(init).not.toHaveProperty('bodyTimeout');
    });

    // The reasoning switch. The kwarg spelling is the one llama.cpp honours;
    // `reasoning_effort` and a `thinking` kwarg are accepted with a 200 and ignored,
    // which is why nothing else is sent (wiki/decisions/llm-agent-thinking.md).
    it('thinkingEnabled:false reaches the wire as enable_thinking false — false IS the instruction', async () => {
        const transport = vi.fn().mockResolvedValue(jsonResponse(PLAIN_RESPONSE));

        await controllerWithTransport(transport).chatFull([{ role: 'user', content: 'go' }], { thinkingEnabled: false });

        const payload = JSON.parse(transport.mock.calls[0][1].body);
        expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    it('thinkingEnabled:true reaches the wire as enable_thinking true', async () => {
        const transport = vi.fn().mockResolvedValue(jsonResponse(PLAIN_RESPONSE));

        await controllerWithTransport(transport).chatFull([{ role: 'user', content: 'go' }], { thinkingEnabled: true });

        const payload = JSON.parse(transport.mock.calls[0][1].body);
        expect(payload.chat_template_kwargs).toEqual({ enable_thinking: true });
    });

    it('absent thinkingEnabled: no chat_template_kwargs at all, so the other prompt kinds are byte-unchanged', async () => {
        const transport = vi.fn().mockResolvedValue(jsonResponse(PLAIN_RESPONSE));
        const llm = controllerWithTransport(transport);

        // Room chat and agent-body-design send no opinion on reasoning; a server
        // that does not know the field must never be sent one.
        await llm.chatFull([{ role: 'user', content: 'go' }], { tool_choice: 'auto' });
        await llm.chat([{ role: 'user', content: 'go' }]);

        for (const call of transport.mock.calls) {
            expect(JSON.parse(call[1].body)).not.toHaveProperty('chat_template_kwargs');
        }
    });

    it('a non-boolean thinkingEnabled is not sent — no value is invented for a caller bug', async () => {
        const transport = vi.fn().mockResolvedValue(jsonResponse(PLAIN_RESPONSE));

        // "false" as a string is not the boolean false; sending {enable_thinking:
        // "false"} would depend on how the server coerces it. Same shape as the
        // existing `tools` handling: a value of the wrong type is simply not sent.
        await controllerWithTransport(transport).chatFull([{ role: 'user', content: 'go' }], { thinkingEnabled: 'false' });

        const payload = JSON.parse(transport.mock.calls[0][1].body);
        expect(payload).not.toHaveProperty('chat_template_kwargs');
    });

    it('resolves a plain content response with the content string and empty toolCalls', async () => {
        const result = await controllerReturning(PLAIN_RESPONSE).chatFull([{ role: 'user', content: 'hi' }]);

        expect(result.content).toBe('hello world');
        expect(result.toolCalls).toEqual([]);
        expect(result.finishReason).toBe('stop');
    });

    it('chat() with a plain content response → identical string (the /chat contract is preserved)', async () => {
        const response = await controllerReturning(PLAIN_RESPONSE).chat([{ role: 'user', content: 'hi' }]);

        expect(response).toBe('hello world');
    });

    it('chat() with a tool-only response on a no-tools call → LLM_PARSE_ERROR (preserved behavior)', async () => {
        await expect(controllerReturning(TOOL_CALL_RESPONSE).chat([{ role: 'user', content: 'hi' }]))
            .rejects.toMatchObject({ code: 'LLM_PARSE_ERROR' });
    });

    it('throws LLM_PARSE_ERROR for a response with neither content nor tool_calls', async () => {
        await expect(controllerReturning({
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }]
        }).chatFull([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ code: 'LLM_PARSE_ERROR' });
    });

    it('maps an HTTP 500 to LLM_HTTP_ERROR', async () => {
        await expect(controllerReturning({}, { status: 500, statusText: 'Internal Server Error' })
            .chatFull([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ code: 'LLM_HTTP_ERROR' });
    });

    it('maps an AbortError to LLM_TIMEOUT', async () => {
        const abortError = new Error('Aborted');
        abortError.name = 'AbortError';

        await expect(controllerRejecting(abortError).chatFull([{ role: 'user', content: 'hi' }], { timeout_ms: 1 }))
            .rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
    });
});

describe('LLMController transport failure logging (OBS-1)', () => {
    let errorSpy;

    beforeEach(() => {
        errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** Runs one call over a transport that rejects with `error`, and returns its error. */
    async function failWith(error) {
        return controllerRejecting(error).chatFull([{ role: 'user', content: 'hi' }]).catch((thrown) => thrown);
    }

    /** The context object the failure line was logged with. */
    function loggedContext() {
        const call = errorSpy.mock.calls.find(([message]) =>
            message.startsWith('[LLMController] Communication failure'));
        return call && call[1];
    }

    it('logs the transport header timeout that "fetch failed" is hiding', async () => {
        const headersTimeout = new Error('Headers Timeout Error');
        headersTimeout.name = 'HeadersTimeoutError';
        headersTimeout.code = 'UND_ERR_HEADERS_TIMEOUT';
        const boom = new TypeError('fetch failed', { cause: headersTimeout });

        const error = await failWith(boom);

        // Downstream contract untouched: same code, same message, cause still attached.
        expect(error).toMatchObject({
            code: 'LLM_REQUEST_ERROR',
            message: 'LLM communication failure: fetch failed'
        });
        expect(error.cause).toBe(boom);
        // The log line says what actually happened, not just "fetch failed".
        expect(errorSpy).toHaveBeenCalledWith(
            '[LLMController] Communication failure: fetch failed',
            { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT', message: 'Headers Timeout Error' }
        );
    });

    it('logs which address refused when the attempts were wrapped in an AggregateError', async () => {
        const refused = (address) => {
            const err = new Error(`connect ECONNREFUSED ${address}:6030`);
            err.code = 'ECONNREFUSED';
            err.syscall = 'connect';
            err.address = address;
            err.port = 6030;
            return err;
        };
        const aggregate = new AggregateError([refused('::1'), refused('127.0.0.1')], 'All connections failed');

        await failWith(new TypeError('fetch failed', { cause: aggregate }));

        expect(loggedContext()).toMatchObject({
            name: 'AggregateError',
            causes: [
                { code: 'ECONNREFUSED', syscall: 'connect', address: '::1', port: 6030 },
                { code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 6030 }
            ]
        });
    });

    it('adds no context when the error carries no cause', async () => {
        await failWith(new TypeError('fetch failed'));

        expect(loggedContext()).toBe(null);
    });

    it('truncates a cause message to the log truncation budget', async () => {
        const noisy = new Error('x'.repeat(LLM_LOG_TRUNCATION_CHARS + 100));
        noisy.name = 'NoisyError';

        await failWith(new TypeError('fetch failed', { cause: noisy }));

        const { message } = loggedContext();
        expect(message.length).toBeLessThanOrEqual(LLM_LOG_TRUNCATION_CHARS + 3);
        expect(message.endsWith('...')).toBe(true);
    });
});

describe('LLMController._validateMessages (spec §6.1.4 — agent multi-turn)', () => {
    const llm = new LLMController();

    it('accepts assistant content:null + tool_calls and tool-role results', () => {
        expect(() => llm._validateMessages([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_action', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' }
        ])).not.toThrow();
    });

    it('accepts assistant with plain content (no tool_calls)', () => {
        expect(() => llm._validateMessages([
            { role: 'assistant', content: 'just talking' }
        ])).not.toThrow();
    });

    it('still rejects role:tool without a non-empty content', () => {
        expect(() => llm._validateMessages([
            { role: 'tool', tool_call_id: 'c1', content: '' }
        ])).toThrow(/tool message.*non-empty string "content"/i);
    });

    it('rejects role:tool without a tool_call_id', () => {
        expect(() => llm._validateMessages([
            { role: 'tool', content: 'ok' }
        ])).toThrow(/tool_call_id/);
    });

    it('rejects an assistant message with neither content nor tool_calls', () => {
        expect(() => llm._validateMessages([
            { role: 'assistant', content: null }
        ])).toThrow(/assistant message.*non-empty "content" or a non-empty "tool_calls"/i);
    });

    it('rejects an unknown role', () => {
        expect(() => llm._validateMessages([
            { role: 'function', content: 'x' }
        ])).toThrow(/Invalid role/);
    });
});

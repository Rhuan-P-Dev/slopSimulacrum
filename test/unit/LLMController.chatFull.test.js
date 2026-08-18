/**
 * LLMController.chatFull contract tests (Feature C, spec §6.1 / §6.8).
 *
 * No real network: `globalThis.fetch` is stubbed per-test via vi.stubGlobal.
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

import { describe, it, expect, afterEach, vi } from 'vitest';
import LLMController from '../../src/controllers/networking/LLMController.js';

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
    const llm = new LLMController();

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves a tool-call response (content:null) with parsed toolCalls — the pre-fix bug', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TOOL_CALL_RESPONSE));
        vi.stubGlobal('fetch', fetchMock);

        const result = await llm.chatFull(
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
        const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(payload.tools).toHaveLength(1);
        expect(payload.tool_choice).toBe('auto');
        expect(payload.stream).toBe(false);
    });

    it('resolves a plain content response with the content string and empty toolCalls', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PLAIN_RESPONSE)));

        const result = await llm.chatFull([{ role: 'user', content: 'hi' }]);
        expect(result.content).toBe('hello world');
        expect(result.toolCalls).toEqual([]);
        expect(result.finishReason).toBe('stop');
    });

    it('chat() with a plain content response → identical string (the /chat contract is preserved)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PLAIN_RESPONSE)));

        const response = await llm.chat([{ role: 'user', content: 'hi' }]);
        expect(response).toBe('hello world');
    });

    it('chat() with a tool-only response on a no-tools call → LLM_PARSE_ERROR (preserved behavior)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(TOOL_CALL_RESPONSE)));

        await expect(llm.chat([{ role: 'user', content: 'hi' }]))
            .rejects.toMatchObject({ code: 'LLM_PARSE_ERROR' });
    });

    it('throws LLM_PARSE_ERROR for a response with neither content nor tool_calls', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }]
        })));

        await expect(llm.chatFull([{ role: 'user', content: 'hi' }]))
            .rejects.toMatchObject({ code: 'LLM_PARSE_ERROR' });
    });

    it('maps an HTTP 500 to LLM_HTTP_ERROR', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 500, statusText: 'Internal Server Error' })));

        await expect(llm.chatFull([{ role: 'user', content: 'hi' }]))
            .rejects.toMatchObject({ code: 'LLM_HTTP_ERROR' });
    });

    it('maps an AbortError to LLM_TIMEOUT', async () => {
        const abortError = new Error('Aborted');
        abortError.name = 'AbortError';
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

        await expect(llm.chatFull([{ role: 'user', content: 'hi' }], { timeout_ms: 1 }))
            .rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
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

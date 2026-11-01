/**
 * The thinking gate of the NPC agent round (LLM_AGENT_THINKING_ENABLED).
 *
 * What is pinned here is the *decision*, not the plumbing: the round always
 * states a boolean (so the server never decides by itself), off is the default
 * (an unset variable is `false`, not "no opinion"), the reading is the relaxed
 * one shared with KILLER_LLM_DRONE_ENABLED ("true" after trim and case-folding,
 * so "1" does not count), and the variable is read per round rather than cached
 * at import, which is what lets an operator flip it between rounds.
 *
 * The wire half - `thinkingEnabled` becoming `chat_template_kwargs.enable_thinking`
 * - is pinned in LLMController.chatFull.test.js, where the payload is built.
 *
 * No network: llmController is a stub that captures the issued options and
 * answers with prose only, so the round settles after one iteration without
 * dispatching anything (same harness shape as KillerLlmDronePrompt.test.js).
 *
 * @module test/unit/LLMAgentThinking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';
import LLMController from '../../src/controllers/networking/LLMController.js';

const GATE_VAR = 'LLM_AGENT_THINKING_ENABLED';
const AMBIENT = process.env[GATE_VAR];

const NPC_ID = 'npc-thinking-1';
const ROOM_ID = 'start_room';

/** An LLM-routed NPC: no `ai` block, so hasDeterministicBrain() is false. */
const NPC_ENTITY = {
    id: NPC_ID,
    name: 'Thinking Droid',
    blueprint: 'smallBallDroid',
    isNPC: true,
    location: ROOM_ID,
    spatial: { x: 10, y: 10 },
    npcConfig: {
        personality: 'A droid that does whatever the LLM tells it.',
        ai: null
    }
};

function makeWorld(entity) {
    return {
        getEntity: (id) => (id === entity.id ? entity : null),
        getRooms: () => ({ [ROOM_ID]: { name: 'Main Room' } }),
        actionController: { getRegistry: () => ({}) },
        stateEntityController: { getAll: () => ({ [entity.id]: entity }) },
        getActionsForEntity: () => ({}),
        executeAction: () => ({ success: true })
    };
}

/**
 * An agent whose LLM call records the options it was issued.
 * With `useRealLLM`, the collaborator is the real LLMController instead, so the
 * round runs all the way to fetch (see the wire test, which stubs fetch itself).
 */
function makeAgent(world, { useRealLLM = false } = {}) {
    const calls = [];
    const capturingLLM = {
        chatFull: async (messages, options) => {
            calls.push({ messages, options });
            return {
                content: 'Standing still.',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: 'Standing still.' }
            };
        }
    };
    const agent = new LLMAgentController({
        llmController: useRealLLM ? new LLMController() : capturingLLM,
        worldStateController: world,
        llmContextController: { buildContext: () => ({ text: '=== ROOM ===\nMain Room' }) },
        roomChatController: {
            sendMessage: (args) => ({ success: true, message: { id: 'chat-1', roomId: args.roomId, text: args.text } })
        },
        turnSystemController: {
            getRoundState: () => ({ phase: 'planning', roundNumber: 0 }),
            queueAction: () => ({ success: true, queueId: 'q-1' })
        }
    });
    return { agent, calls };
}

/** Runs one round with `value` as the variable (undefined leaves it unset). */
async function runWithGate(value) {
    if (value === undefined) {
        delete process.env[GATE_VAR];
    } else {
        process.env[GATE_VAR] = value;
    }
    const { agent, calls } = makeAgent(makeWorld(NPC_ENTITY));
    const result = await agent.runRound(NPC_ID, 0);
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(1);
    return calls[0].options;
}

describe(`LLMAgentController - thinking gate (${GATE_VAR})`, () => {
    beforeEach(() => {
        delete process.env[GATE_VAR];
    });

    afterEach(() => {
        delete process.env[GATE_VAR];
        if (AMBIENT !== undefined) {
            process.env[GATE_VAR] = AMBIENT;
        }
    });

    it('unset: the round says enable_thinking false, and never leaves reasoning to the server', async () => {
        const options = await runWithGate(undefined);

        // A boolean, not undefined: "off by default" is an instruction the round
        // states, so a server whose own default is "think" cannot reintroduce it.
        expect(options.thinkingEnabled).toBe(false);
    });

    it('empty string and a stray value: still off (only the word "true" turns it on)', async () => {
        expect((await runWithGate('')).thinkingEnabled).toBe(false);
        expect((await runWithGate('1')).thinkingEnabled).toBe(false);
        expect((await runWithGate('yes')).thinkingEnabled).toBe(false);
        expect((await runWithGate('on')).thinkingEnabled).toBe(false);
    });

    it('"true" in any case or padding: on (the relaxed isEnvFlagOn reading)', async () => {
        expect((await runWithGate('true')).thinkingEnabled).toBe(true);
        expect((await runWithGate('TRUE')).thinkingEnabled).toBe(true);
        expect((await runWithGate(' True ')).thinkingEnabled).toBe(true);
    });

    it('"false" says false explicitly - the same wire value as unset, from the other direction', async () => {
        const options = await runWithGate('false');

        expect(options.thinkingEnabled).toBe(false);
    });

    it('read per round, not cached: flipping the variable changes the next call of the same agent', async () => {
        process.env[GATE_VAR] = 'true';
        const { agent, calls } = makeAgent(makeWorld(NPC_ENTITY));

        await agent.runRound(NPC_ID, 0);
        process.env[GATE_VAR] = 'false';
        await agent.runRound(NPC_ID, 1);

        // If the gate were resolved at import (a module-level const), the second
        // call would still carry true.
        expect(calls.map((c) => c.options.thinkingEnabled)).toEqual([true, false]);
    });

    it('reaches the wire: a round over a real LLMController bodies the kwarg (fetch captured)', async () => {
        // The seam the option-level pins cannot see: between the round's options
        // and the HTTP body sits LLMController, which could drop the field. Stubbed
        // at fetch, so this is the whole path offline - round, options, payload.
        const bodies = [];
        const fetchStub = async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Standing still.' } }]
                }),
                text: async () => '{}'
            };
        };
        const realFetch = globalThis.fetch;
        globalThis.fetch = fetchStub;
        try {
            const { agent } = makeAgent(makeWorld(NPC_ENTITY), { useRealLLM: true });

            process.env[GATE_VAR] = 'false';
            await agent.runRound(NPC_ID, 0);
            process.env[GATE_VAR] = 'true';
            await agent.runRound(NPC_ID, 1);
        } finally {
            globalThis.fetch = realFetch;
        }

        expect(bodies).toHaveLength(2);
        expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
        expect(bodies[1].chat_template_kwargs).toEqual({ enable_thinking: true });
    });

    it('the rest of the round options are untouched by the gate', async () => {
        const off = await runWithGate(undefined);
        const on = await runWithGate('true');

        // The gate adds one field; temperature, timeout and the token cap stay as
        // they are, including the 51200 cap sized for a round that thinks.
        expect(off.tool_choice).toBe('auto');
        expect(on.tool_choice).toBe('auto');
        expect(off.temperature).toBe(on.temperature);
        expect(off.timeout_ms).toBe(on.timeout_ms);
        expect(off.max_tokens).toBe(on.max_tokens);
    });
});

/**
 * LLMAgentController unit tests (Feature C, spec §6.3 / §6.8).
 *
 * Everything external is mocked (no composition root, no data files, no
 * network): the LLM controller is a stub whose chatFull() is scripted per
 * test, and the world facade / room chat / turn system are hand-built
 * objects exposing only the surface the agent reads.
 *
 * Covers the spec §6.8 checklist items owned by the agent:
 *   - execute_action call → action QUEUED on the turn system with the NPC's
 *     server-injected entityId (the model's claimed actor is ignored);
 *   - unknown actionName ('fly') → exactly one retry, the error in history,
 *     2 iterations, no world mutation;
 *   - chatFull rejects with LLM_TIMEOUT → runRound resolves
 *     { error:'LLM_TIMEOUT' }, no throw, nothing queued;
 *   - prose-only response → chat { sent:false, reason:'prose-only' }, the
 *     retry is NOT burned (iterations stays 1);
 *   - capability gate (canExecute empty) → 'action not executable right now';
 *   - ID hygiene: a comp- argument with the wrong prefix → 'invalid id format';
 *   - speak_in_room → roomChatController.sendMessage with the room FORCED to
 *     the entity's location;
 *   - malformed tool arguments JSON → pre-validation failure, not a crash.
 *
 * @module test/unit/LLMAgentController
 */

import { describe, it, expect, beforeEach } from 'vitest';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';

// =========================================================================
// Mocks
// =========================================================================

const NPC_ID = 'ent-npc-0001';
const NPC = {
    id: NPC_ID,
    name: 'Bolt',
    // Deliberately NOT a key of data/npcs.json (Feature D created that file
    // with 'merchantDroid'): these tests exercise the entity-name FALLBACK
    // path (config === null → displayName falls back to entity.name).
    blueprint: 'unregisteredDroid',
    isNPC: true,
    location: 'room-main',
    spatial: { x: 50, y: 50 }
};

const ACTION_REGISTRY = {
    selfHeal: { description: 'self-repair', requirements: [] },
    cut: { description: 'slice with knife', range: 50, requirements: [] },
    move: { description: 'walk', requirements: [] }
};

function makeWorld({ canExecute = {}, executeResult } = {}) {
    const executeCalls = [];
    return {
        executeCalls,
        getEntity: (id) => (id === NPC_ID ? NPC : null),
        getRooms: () => ({ 'room-main': { name: 'Main Room' } }),
        actionController: { getRegistry: () => ACTION_REGISTRY },
        stateEntityController: { getAll: () => ({ [NPC_ID]: NPC }) },
        getActionsForEntity: (id) => {
            // Only the NPC is modeled; unknown entities have no capabilities.
            if (id !== NPC_ID) return {};
            const out = {};
            for (const name of Object.keys(ACTION_REGISTRY)) {
                out[name] = { canExecute: canExecute[name] || [] };
            }
            return out;
        },
        executeAction: (actionName, entityId, params) => {
            executeCalls.push({ actionName, entityId, params });
            return executeResult ?? { success: true };
        }
    };
}

function makeRoomChat() {
    const sent = [];
    return {
        sent,
        sendMessage: (args) => {
            sent.push(args);
            return { success: true, message: { id: 'chat-1', roomId: args.roomId, text: args.text } };
        }
    };
}

function makeTurns({ phase = 'planning', queueResult } = {}) {
    const queued = [];
    return {
        queued,
        getRoundState: () => ({ phase, roundNumber: 0 }),
        queueAction: (entityId, actionName, params, source) => {
            queued.push({ entityId, actionName, params, source });
            return queueResult ?? { success: true, queueId: `q-${queued.length}` };
        }
    };
}

/** Builds an agent with a scripted chatFull. */
function makeAgent({ world, roomChat, turns, chatFullImpl, calls } = {}) {
    const llmStub = { chatFull: async (messages, options) => chatFullImpl(messages, options) };
    const agent = new LLMAgentController({
        llmController: llmStub,
        worldStateController: world ?? makeWorld(),
        llmContextController: { buildContext: () => ({ text: '=== ROOM ===\nMain Room' }) },
        roomChatController: roomChat ?? makeRoomChat(),
        turnSystemController: turns ?? makeTurns()
    });
    return { agent, calls: calls ?? [] };
}

/** Builds a raw assistant message with the given tool calls. */
function toolMessage(calls, content = null) {
    return {
        role: 'assistant',
        content,
        tool_calls: calls.map((c, i) => ({
            id: `call_${i + 1}`,
            type: 'function',
            function: { name: c.name, arguments: c.args }
        }))
    };
}

// =========================================================================
// Tests
// =========================================================================

describe('LLMAgentController.runRound (Feature C, spec §6.8)', () => {
    it('queues an execute_action on the turn system with the NPC server-injected entityId', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'execute_action', args: '{"actionName":"selfHeal","entityId":"ent-SOMEONE-ELSE"}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        // Queued exactly once, actor = the NPC (the model's "ent-SOMEONE-ELSE" is discarded).
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].entityId).toBe(NPC_ID);
        expect(turns.queued[0].actionName).toBe('selfHeal');
        expect(turns.queued[0].params.entityId).toBeUndefined(); // actor rides the 2nd queueAction arg
        expect(turns.queued[0].source).toBe('npc');
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toMatchObject({ actionName: 'selfHeal', queued: true, success: true });
        expect(result.error).toBeNull();
        expect(result.iterations).toBe(1);
    });

    it('unknown actionName → exactly one retry with the error in history, 2 iterations, no mutation', async () => {
        const world = makeWorld();
        const turns = makeTurns();
        const seenMessages = [];
        let call = 0;
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                call += 1;
                seenMessages.push(messages);
                // First call: bogus action. Second call: the model gives up and talks.
                return call === 1
                    ? { content: null, toolCalls: [], finishReason: 'tool_calls', message: toolMessage([{ name: 'execute_action', args: '{"actionName":"fly"}' }]) }
                    : { content: 'Fine, I shall wait.', toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: 'Fine, I shall wait.' } };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(call).toBe(2);
        expect(result.iterations).toBe(2);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toMatchObject({ actionName: 'fly', success: false });
        expect(result.actions[0].detail).toBe('unknown action "fly"');

        // The retry's conversation carries the failure as tool-role feedback.
        const retryMessages = seenMessages[1];
        const assistantMsg = retryMessages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeTruthy();
        expect(assistantMsg.content).toBeNull();
        const toolMsg = retryMessages.find(m => m.role === 'tool');
        expect(toolMsg).toBeTruthy();
        const toolPayload = JSON.parse(toolMsg.content);
        expect(toolPayload).toEqual({ success: false, error: 'unknown action "fly"' });
        expect(toolMsg.tool_call_id).toBe('call_1');

        // No world mutation, nothing queued.
        expect(world.executeCalls).toHaveLength(0);
        expect(turns.queued).toHaveLength(0);
    });

    it('LLM_TIMEOUT → resolves with error LLM_TIMEOUT, no throw, nothing queued', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: async () => {
                const err = new Error('LLM request timed out after 4500ms');
                err.code = 'LLM_TIMEOUT';
                throw err;
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.error).toBe('LLM_TIMEOUT');
        expect(result.iterations).toBe(1);
        expect(result.actions).toHaveLength(0);
        expect(world.executeCalls).toHaveLength(0);
        expect(turns.queued).toHaveLength(0);
    });

    it('plain-text response → treated as speak_in_room (plain-text-as-chat)', async () => {
        const roomChat = makeRoomChat();
        const seen = [];
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: (messages) => {
                seen.push(messages.length);
                return {
                    content: 'Greetings, traveler!',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: 'Greetings, traveler!' }
                };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(seen).toHaveLength(1); // exactly one chatFull call
        expect(result.iterations).toBe(1);
        expect(result.chat).toEqual({ sent: true, text: 'Greetings, traveler!' });
        expect(roomChat.sent).toHaveLength(1);
        expect(roomChat.sent[0].text).toBe('Greetings, traveler!');
        expect(result.error).toBeNull();
    });

    it('plain-text response with >200 chars → truncated to 200', async () => {
        const roomChat = makeRoomChat();
        // Use varied text to avoid triggering the degeneration check.
        const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(5).trim();
        // Ensure it's over 200 chars and not degenerate.
        const text = longText.length > 200 ? longText : longText + 'x'.repeat(50);
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content: longText,
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: longText }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.chat.sent).toBe(true);
        expect(result.chat.text).toHaveLength(200);
        expect(roomChat.sent[0].text).toHaveLength(200);
    });

    it('content with JSON tool (speak_in_room shape) → dispatches speak_in_room (json-fallback)', async () => {
        const roomChat = makeRoomChat();
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content: '{"tool":"speak_in_room","args":{"message":"Hello there!"}}',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: '{"tool":"speak_in_room","args":{"message":"Hello there!"}}' }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.chat).toEqual({ sent: true, text: 'Hello there!' });
        expect(roomChat.sent).toHaveLength(1);
        expect(roomChat.sent[0].text).toBe('Hello there!');
        expect(result.error).toBeNull();
    });

    it('content with JSON tool (execute_action actionName shape) → dispatches action (json-fallback)', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: '{"actionName":"selfHeal"}',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: '{"actionName":"selfHeal"}' }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('selfHeal');
        expect(turns.queued[0].entityId).toBe(NPC_ID);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toMatchObject({ actionName: 'selfHeal', queued: true, success: true });
        expect(result.error).toBeNull();
    });

    it('content with JSON in surrounding text (first {...} block) → dispatches speak_in_room', async () => {
        const roomChat = makeRoomChat();
        const content = 'Sure! Here is my action:\n{"tool":"speak_in_room","args":{"message":"Hey!"}}\nDone.';
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content,
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.chat).toEqual({ sent: true, text: 'Hey!' });
        expect(roomChat.sent).toHaveLength(1);
    });

    it('plain-text with maxChat reached → silent', async () => {
        // Simulate: the NPC already sent its one chat message this round.
        // We do this by having the LLM return TWO separate rounds of plain text,
        // but since runRound only processes one LLM call, we use a world with
        // maxChatMessagesPerRound = 1 and mock the chat layer to fail on 2nd call.
        // Instead, we directly test: if sentChats >= maxChat, the text is dropped.
        // The simplest way: make roomChat.sendMessage fail (simulate cap reached).
        const roomChat = {
            sent: [],
            sendMessage: () => ({ success: false, code: 'CHAT_LIMIT', error: 'max chat messages per round reached (1)' })
        };
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content: 'I should be silent.',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: 'I should be silent.' }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.chat.sent).toBe(false);
        expect(result.chat.reason).toBe('max chat messages per round reached (1)');
        expect(roomChat.sent).toHaveLength(0);
        expect(result.error).toBeNull();
    });

    it('tool_choice "required" rejected with HTTP 400 → retries once with "auto"', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        let callCount = 0;
        const seenOptions = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages, options) => {
                callCount += 1;
                seenOptions.push(options.tool_choice);
                if (callCount === 1) {
                    const err = new Error('LLM API error: HTTP 400 Bad Request — tool_choice "required" not supported');
                    err.code = 'LLM_HTTP_ERROR';
                    throw err;
                }
                // Second call with "auto" succeeds with a tool call.
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: toolMessage([{ name: 'execute_action', args: '{"actionName":"selfHeal"}' }])
                };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(callCount).toBe(2);
        expect(seenOptions[0]).toBe('required');
        expect(seenOptions[1]).toBe('auto');
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('selfHeal');
        expect(result.error).toBeNull();
    });

    it('capability gate: canExecute empty → rejected, no dispatch', async () => {
        // 'cut' exists in the registry but the NPC has no equipped knife right now.
        // The mock is stateless (same answer on retry) — the spec allows the
        // agent one retry, so BOTH attempts are rejected identically.
        const world = makeWorld({ canExecute: { cut: [] } });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'execute_action', args: '{"actionName":"cut","targetComponentId":"comp-target-1"}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        for (const a of result.actions) {
            expect(a.actionName).toBe('cut');
            expect(a.detail).toBe('action not executable right now: cut');
        }
        expect(result.actions.length).toBeGreaterThanOrEqual(1);
        expect(turns.queued).toHaveLength(0);
        expect(world.executeCalls).toHaveLength(0);
    });

    it('ID hygiene: a wrong-prefix comp- argument is rejected before dispatch', async () => {
        const world = makeWorld({ canExecute: { move: ['comp-x'] } });
        const { agent } = makeAgent({
            world,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'execute_action', args: '{"actionName":"move","targetComponentId":"ent-wrong-prefix"}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.actions[0].detail).toBe('invalid id format: targetComponentId="ent-wrong-prefix"');
    });

    it('speak_in_room → chat sent via roomChatController with the room FORCED to the entity location', async () => {
        const roomChat = makeRoomChat();
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'speak_in_room', args: '{"message":"Welcome, traveler."}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.chat).toEqual({ sent: true, text: 'Welcome, traveler.' });
        expect(roomChat.sent).toHaveLength(1);
        expect(roomChat.sent[0].roomId).toBe(NPC.location);
        expect(roomChat.sent[0].speakerName).toBe(NPC.name); // unregistered blueprint → falls back to entity name
        expect(roomChat.sent[0].speakerEntityId).toBe(NPC_ID);
    });

    it('malformed tool arguments JSON → pre-validation failure, not a crash', async () => {
        const world = makeWorld();
        const { agent } = makeAgent({
            world,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'execute_action', args: '{"actionName": oops-not-json' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.actions[0].detail).toBe('malformed tool arguments');
        expect(world.executeCalls).toHaveLength(0);
    });

    it('entity missing / not an NPC → graceful NPC_GONE, no LLM call', async () => {
        let called = 0;
        const { agent } = makeAgent({
            chatFullImpl: () => { called += 1; return { content: 'x', toolCalls: [], finishReason: 'stop', message: { content: 'x' } }; }
        });

        const result = await agent.runRound('ent-ghost', 0);

        expect(result.error).toBe('NPC_GONE');
        expect(called).toBe(0);
    });

    it('getNpcs() discovers only isNPC:true entities, joined with the registry by blueprint', () => {
        const other = { id: 'ent-player-1', name: 'Player', blueprint: 'smallBallDroid', isNPC: false, location: 'room-main' };
        const world = makeWorld();
        world.stateEntityController.getAll = () => ({ [NPC_ID]: NPC, 'ent-player-1': other });
        const agent = new LLMAgentController({
            llmController: { chatFull: async () => ({}) },
            worldStateController: world,
            llmContextController: {},
            roomChatController: null,
            turnSystemController: null
        });
        agent._npcRegistry = { unregisteredDroid: { displayName: 'Bolt', personality: 'chatty' } };

        const npcs = agent.getNpcs();
        expect(npcs).toHaveLength(1);
        expect(npcs[0].entityId).toBe(NPC_ID);
        expect(npcs[0].config.displayName).toBe('Bolt');
    });

    // =========================================================================
    // JSON-in-text protocol (new primary shape)
    // =========================================================================

    it('{"action":"speak","message":"..."} → dispatches speak_in_room', async () => {
        const roomChat = makeRoomChat();
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content: '{"action":"speak","message":"Hello from JSON!"}',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: '{"action":"speak","message":"Hello from JSON!"}' }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);
        expect(result.chat).toEqual({ sent: true, text: 'Hello from JSON!' });
        expect(roomChat.sent).toHaveLength(1);
        expect(roomChat.sent[0].text).toBe('Hello from JSON!');
        expect(result.error).toBeNull();
    });

    it('{"action":"do","actionName":"selfHeal"} → dispatches execute_action', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: '{"action":"do","actionName":"selfHeal"}',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: '{"action":"do","actionName":"selfHeal"}' }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('selfHeal');
        expect(turns.queued[0].entityId).toBe(NPC_ID);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toMatchObject({ actionName: 'selfHeal', queued: true, success: true });
        expect(result.error).toBeNull();
    });

    it('{"action":"none"} → NPC silent, nothing dispatched', async () => {
        const roomChat = makeRoomChat();
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            roomChat,
            chatFullImpl: () => ({
                content: '{"action":"none"}',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: '{"action":"none"}' }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);
        expect(result.chat.sent).toBe(false);
        expect(result.chat.reason).toBe('none');
        expect(result.actions).toHaveLength(0);
        expect(roomChat.sent).toHaveLength(0);
        expect(turns.queued).toHaveLength(0);
        expect(result.error).toBeNull();
    });

    // =========================================================================
    // Degeneration detection
    // =========================================================================

    it('degenerated emoji loop (🧽🧼×100) → discarded, NPC silent, nothing sent', async () => {
        const roomChat = makeRoomChat();
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const degenerated = '🧽🧼'.repeat(100); // 200 chars of emoji loop
        const { agent } = makeAgent({
            world,
            turns,
            roomChat,
            chatFullImpl: () => ({
                content: degenerated,
                toolCalls: [],
                finishReason: 'length',
                message: { role: 'assistant', content: degenerated }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);
        expect(result.chat.sent).toBe(false);
        expect(result.actions).toHaveLength(0);
        expect(roomChat.sent).toHaveLength(0); // NOTHING sent to chat
        expect(turns.queued).toHaveLength(0);
        expect(world.executeCalls).toHaveLength(0);
        expect(result.error).toBeNull(); // not an error, just silent
    });

    it('degenerated 3-char repeat (abcabc×20) → discarded', async () => {
        const roomChat = makeRoomChat();
        const degenerated = 'abc'.repeat(20); // 60 chars
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content: degenerated,
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: degenerated }
            })
        });

        const result = await agent.runRound(NPC_ID, 0);
        expect(result.chat.sent).toBe(false);
        expect(roomChat.sent).toHaveLength(0);
    });

    // =========================================================================
    // Request options: temperature + max_tokens
    // =========================================================================

    it('agent request uses temperature=0.3 and max_tokens=512', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const seenOptions = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages, options) => {
                seenOptions.push(options);
                return {
                    content: '{"action":"speak","message":"ok"}',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: '{"action":"speak","message":"ok"}' }
                };
            }
        });

        await agent.runRound(NPC_ID, 0);
        expect(seenOptions).toHaveLength(1);
        expect(seenOptions[0].temperature).toBe(0.3);
        expect(seenOptions[0].max_tokens).toBe(512);
    });
});

// =========================================================================
// AI system: Deterministic AI guard (spec §9.2)
// =========================================================================

describe('LLMAgentController.runRound — DETERMINISTIC_AI guard (spec §9.2)', () => {
    it('NPC with npcConfig.ai.behavior → returns error DETERMINISTIC_AI, chatFull not called, nothing queued', async () => {
        const npcWithAi = {
            ...NPC,
            id: NPC_ID,
            npcConfig: { personality: 'Rogue', ai: { behavior: 'chase_attack' } }
        };
        const world = makeWorld();
        world.getEntity = () => npcWithAi;

        let chatCalled = false;
        let queuedCount = 0;
        world.turnSystemController = {
            queueAction: () => { queuedCount++; return { success: true }; },
            getRoundState: () => ({ phase: 'planning' })
        };

        const { agent } = makeAgent({
            world,
            chatFullImpl: () => { chatCalled = true; return {}; }
        });

        const result = await agent.runRound(NPC_ID, 5);

        expect(result.error).toBe('DETERMINISTIC_AI');
        expect(chatCalled).toBe(false);
        expect(world.executeCalls).toHaveLength(0);
        expect(queuedCount).toBe(0); // nothing should be queued via LLM path
    });

    it('NPC without ai → LLM flow intact (regression)', async () => {
        const npcWithoutAi = { ...NPC, npcConfig: { personality: 'Passive' } };
        const world = makeWorld();
        world.getEntity = () => npcWithoutAi;

        let chatCalled = false;
        const { agent } = makeAgent({
            world,
            chatFullImpl: () => { chatCalled = true; return { content: 'Hello', toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: 'Hello' } }; }
        });

        const result = await agent.runRound(NPC_ID, 5);

        expect(result.error).toBeNull();
        expect(chatCalled).toBe(true);
    });
});

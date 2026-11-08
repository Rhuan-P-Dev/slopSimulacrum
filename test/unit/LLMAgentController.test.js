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
 *   - PROTOCOL B: prose-only responses are NEVER interpreted — the JSON-\n *     in-content fallback is gone (spec §6.4), the model chose silence (spec
 *     §6.3), and the retry is NOT burned (iterations stays 1);
 *   - degenerate / tool-scaffold responses → content replaced by a neutral
 *     placeholder before storage (never re-primed), nothing dispatched;
 *   - capability gate (canExecute empty) → 'action not executable right now';
 *   - ID hygiene: a comp- argument with the wrong prefix → 'invalid id format';
 *   - speak_in_room → roomChatController.sendMessage with the room FORCED to
 *     the entity's location;
 *   - malformed tool arguments JSON → pre-validation failure, not a crash.
 *
 * @module test/unit/LLMAgentController
 */

import { describe, it, expect } from 'vitest';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';
import { LLM_AGENT_VIEW_HISTORY_ROUNDS, LLM_REPLAY_ROUNDS } from '../../src/utils/Constants.js';

// =========================================================================
// Mocks
// =========================================================================

const NPC_ID = 'ent-npc-0001';
const NPC = {
    id: NPC_ID,
    name: 'Bolt',
    // Deliberately NOT a key of data/mods/core-npcs/npcs.json (Feature D created that file
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
    move: { description: 'walk', requirements: [] },
    // range 50 is the reach rule of the crossDoor action: the droid must stand
    // within 50 units of the door. The agent's use_door pre-validation reads it
    // from the registry, exactly as the world does.
    crossDoor: { description: 'walk through a door into the room beyond', range: 50, requirements: [] }
};

function makeWorld({ canExecute = {}, executeResult, target = null, rooms = null } = {}) {
    const executeCalls = [];
    return {
        executeCalls,
        getEntity: (id) => (id === NPC_ID ? NPC : (target && id === target.id ? target : null)),
        getRooms: () => rooms || { 'room-main': { name: 'Main Room' } },
        actionController: { getRegistry: () => ACTION_REGISTRY },
        getActionRegistry: () => ACTION_REGISTRY,
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

/** Builds an agent with a scripted chatFull.
 *
 *  The mock world may pre-supply `sendRoomChat`; when it doesn't, makeAgent
 *  patches in the facade contract — a `sendRoomChat` that delegates to the
 *  roomChat mock (mirroring how the real WSC choke point works, including the
 *  NPC speak path: worldStateController.sendRoomChat → roomChatController). A
 *  no-op `_markPerceptionDirty` stands in for the real perception dirty mark
 *  (not exercised here; the perception tests cover that seam).
 */
function makeAgent({ world, roomChat, turns, chatFullImpl, calls } = {}) {
    const llmStub = { chatFull: async (messages, options) => chatFullImpl(messages, options) };
    const effectiveRoomChat = roomChat ?? makeRoomChat();
    const effectiveWorld = world ?? makeWorld();
    if (typeof effectiveWorld.sendRoomChat !== 'function') {
        effectiveWorld.sendRoomChat = effectiveRoomChat.sendMessage;
        effectiveWorld._markPerceptionDirty = () => {};
    }
    const agent = new LLMAgentController({
        llmController: llmStub,
        worldStateController: effectiveWorld,
        llmContextController: { buildContext: () => ({ text: '=== ROOM ===\nMain Room' }) },
        roomChatController: effectiveRoomChat,
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
                message: toolMessage([{ name: 'execute_action', args: '{"actionName":"selfHeal","entityId":"ent-SOMEONE-ELSE"}' }, { name: 'done', args: '{}' }])
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

    // Capture Point B (spec §4.2): the round runner records every dispatched
    // outcome to the agent feedback controller, named the way the agent called
    // it (registry action name for execute_action; tool name for the others),
    // so the context's RECENT TOOLS section stays truthful about what happened
    // this round — success and failure.
    it('records a successful execute_action to the feedback controller, named as called (spec §4.2)', async () => {
        const recorded = [];
        const fb = { record: (entityId, outcome) => recorded.push({ entityId, outcome }) };
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([
                    { name: 'execute_action', args: '{"actionName":"selfHeal"}' },
                    { name: 'done', args: '{}' }
                ])
            })
        });
        agent.setFeedbackController(fb);

        await agent.runRound(NPC_ID, 0);

        expect(recorded).toHaveLength(1);
        expect(recorded[0].entityId).toBe(NPC_ID);
        expect(recorded[0].outcome).toMatchObject({
            actionName: 'selfHeal',
            success: true
        });
    });

    it('records a failed execute_action (unknown action) to the feedback controller, named as called; the single retry records nothing (spec §4.2)', async () => {
        const recorded = [];
        const fb = { record: (entityId, outcome) => recorded.push({ entityId, outcome }) };
        const world = makeWorld();
        const turns = makeTurns();
        let call = 0;
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => {
                call += 1;
                return call === 1
                    ? {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: toolMessage([
                            { name: 'execute_action', args: '{"actionName":"fly"}' },
                            { name: 'done', args: '{}' }
                        ])
                      }
                    : {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: toolMessage([{ name: 'done', args: '{}' }])
                      };
            }
        });
        agent.setFeedbackController(fb);

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.iterations).toBe(2); // one failure feed-back, then done
        expect(recorded).toHaveLength(1);
        expect(recorded[0].entityId).toBe(NPC_ID);
        expect(recorded[0].outcome).toMatchObject({
            actionName: 'fly',
            success: false
        });
    });

    it('records speak_in_room to the feedback controller under the tool name (success) (spec §4.2)', async () => {
        const recorded = [];
        const fb = { record: (entityId, outcome) => recorded.push({ entityId, outcome }) };
        const world = makeWorld();
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([
                    { name: 'speak_in_room', args: '{"message":"Hello, there!"}' },
                    { name: 'done', args: '{}' }
                ])
            })
        });
        agent.setFeedbackController(fb);

        await agent.runRound(NPC_ID, 0);

        expect(recorded).toHaveLength(1);
        expect(recorded[0].entityId).toBe(NPC_ID);
        expect(recorded[0].outcome).toMatchObject({
            actionName: 'speak_in_room',
            success: true
        });
        expect(recorded[0].outcome.detail).toContain('Hello, there!');
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
                const err = new Error('LLM request timed out after 45000ms');
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

    it('PROTOCOL B: plain-text response → ignored, nothing dispatched, no retry', async () => {
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

        expect(seen).toHaveLength(1); // exactly one chatFull call — the retry is not burned
        expect(result.iterations).toBe(1);
        expect(result.chat).toEqual({ sent: false, reason: 'prose-ignored' });
        expect(roomChat.sent).toHaveLength(0); // prose is never sent to chat (no plain-text-as-chat)
        expect(result.error).toBeNull();
    });

    it('PROTOCOL B: long plain-text response → ignored (no truncation, no dispatch)', async () => {
        const roomChat = makeRoomChat();
        // Use varied text to avoid triggering the degeneration check.
        const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(5).trim();
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

        expect(result.chat.sent).toBe(false);
        expect(result.chat.reason).toBe('prose-ignored');
        expect(roomChat.sent).toHaveLength(0);
    });

    it('PROTOCOL B: content with a JSON tool shape → ignored (no json-fallback)', async () => {
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

        // The dual-protocol era interpreted this as a speak; protocol B never
        // does: no tool call means silence (spec §6.3).
        expect(result.chat.sent).toBe(false);
        expect(result.chat.reason).toBe('prose-ignored');
        expect(roomChat.sent).toHaveLength(0);
        expect(result.error).toBeNull();
    });

    it('PROTOCOL B: content with a JSON execute_action shape → ignored (no action from text)', async () => {
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

        expect(turns.queued).toHaveLength(0); // never executed from content
        expect(result.actions).toHaveLength(0);
        expect(result.chat.sent).toBe(false);
        expect(result.error).toBeNull();
    });

    it('PROTOCOL B: JSON buried in prose → ignored (never parsed out of text)', async () => {
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

        expect(result.chat.sent).toBe(false);
        expect(roomChat.sent).toHaveLength(0);
    });

    it('PROTOCOL B: prose with maxChat reached → still just ignored (chat layer never touched)', async () => {
        // Even when the chat layer would reject a send (cap reached), the
        // prose is discarded before it ever reaches the chat layer.
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
        expect(result.chat.reason).toBe('prose-ignored');
        expect(roomChat.sent).toHaveLength(0);
        expect(result.error).toBeNull();
    });

    it('agent request uses tool_choice "auto", temperature 0.5, max_tokens=51200 (10× reasoning headroom — PROTOCOL B)', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        const seenOptions = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages, options) => {
                seenOptions.push(options);
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: toolMessage([{ name: 'execute_action', args: '{"actionName":"selfHeal"}' }, { name: 'done', args: '{}' }])
                };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(seenOptions).toHaveLength(1);
        expect(seenOptions[0].tool_choice).toBe('auto'); // never "required" (spec §6.2)
        expect(seenOptions[0].temperature).toBe(0.5);
        expect(seenOptions[0].max_tokens).toBe(51200); // 10× the previous 5120 (100× the original 512): thinking tokens count against this budget
        expect(turns.queued).toHaveLength(1);
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

    it('speak_in_room → chat sent via the worldStateController facade (sendRoomChat) with the room FORCED to the entity location', async () => {
        const roomChat = makeRoomChat();
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'speak_in_room', args: '{"message":"Welcome, traveler."}' }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.chat).toEqual({ sent: true, text: 'Welcome, traveler.' });
        expect(roomChat.sent).toHaveLength(1);
        expect(roomChat.sent[0].roomId).toBe(NPC.location);
        expect(roomChat.sent[0].speakerName).toBe(NPC.name); // unregistered blueprint → falls back to entity name
        expect(roomChat.sent[0].speakerEntityId).toBe(NPC_ID);
    });

    it('speak: the facade sendRoomChat is called BOUND (production shape is this-dependent — 2026-10-21 regression)', async () => {
        const roomChat = makeRoomChat();
        const world = makeWorld();
        // Production shape: a real METHOD that reads `this.roomChatController`
        // (exactly like WorldStateController.sendRoomChat) — NOT an arrow
        // function. If _dispatchSpeak detaches it (const f =
        // facade.sendRoomChat; f(...)), that read runs with `this === undefined`
        // (strict mode) and the round dies with AGENT_INTERNAL_ERROR — the
        // exact shape of the chat-loss incident (the player route calls
        // the method bound and worked; only the NPC path detached it).
        world.sendRoomChat = function (args) {
            if (!this.roomChatController) {
                return { success: false, code: 'ROOM_CHAT_UNAVAILABLE', error: 'not wired' };
            }
            return this.roomChatController.sendMessage(args);
        };
        world.roomChatController = roomChat;
        const { agent } = makeAgent({
            world,
            roomChat,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'speak_in_room', args: '{"message":"h-hello..."}' }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.error).toBeNull(); // a detached call would have thrown here
        expect(result.chat).toEqual({ sent: true, text: 'h-hello...' });
        expect(roomChat.sent).toHaveLength(1);
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
    // Legacy JSON-in-text shapes — PROTOCOL B: all ignored (never dispatched)
    // =========================================================================

    it('legacy {"action":"speak","message":"..."} → ignored (prose, not a tool call)', async () => {
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
        expect(result.chat.sent).toBe(false);
        expect(result.chat.reason).toBe('prose-ignored');
        expect(roomChat.sent).toHaveLength(0);
        expect(result.error).toBeNull();
    });

    it('legacy {"action":"do","actionName":"selfHeal"} → ignored (no action from text)', async () => {
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
        expect(turns.queued).toHaveLength(0);
        expect(result.actions).toHaveLength(0);
        expect(result.chat.sent).toBe(false);
        expect(result.error).toBeNull();
    });

    it('legacy {"action":"none"} → NPC silent, nothing dispatched', async () => {
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
        expect(result.chat.reason).toBe('prose-ignored');
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
    // Transcript hygiene (the structural fix pi makes natively)
    // =========================================================================

    it('scaffold loop (24-char tag unit x40 — the incident shape) → discarded AND sanitized in the transcript given to the next round', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        // Built by concatenation so this test source never carries a literal
        // closing tag (the agent transport treats those as delimiters and
        // mangles payloads that carry them — the same bug as the incident).
        const unit = '<' + '/parameter' + '>\n' + '<' + '/function' + '>\n';
        const degenerated = unit.repeat(40); // 960 chars: 24-char unit x40
        let callCount = 0;
        const seenMessages = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                callCount += 1;
                seenMessages.push(JSON.parse(JSON.stringify(messages)));
                if (callCount === 1) {
                    // Round 1: the model loops on the scaffold, no tool calls.
                    return {
                        content: degenerated,
                        toolCalls: [],
                        finishReason: 'length',
                        message: { role: 'assistant', content: degenerated }
                    };
                }
                // Round 2 (next tick): the model recovers and acts (done ends
                // the in-round loop at the single queued action).
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: toolMessage([{ name: 'execute_action', args: '{"actionName":"selfHeal"}' }, { name: 'done', args: '{}' }])
                };
            }
        });

        const r1 = await agent.runRound(NPC_ID, 0);
        expect(r1.chat).toEqual({ sent: false, reason: 'degenerated' });
        expect(r1.actions).toHaveLength(0);
        expect(turns.queued).toHaveLength(0);

        const r2 = await agent.runRound(NPC_ID, 1);
        expect(r2.actions).toHaveLength(1);
        expect(turns.queued).toHaveLength(1);

        // The round-2 request must carry the placeholder, NOT the loop:
        const round2 = seenMessages[1];
        const assistant = round2.find(m => m.role === 'assistant');
        expect(assistant).toBeTruthy();
        expect(assistant.content).toBe('(invalid response discarded)');
        expect(JSON.stringify(round2).includes('/parameter')).toBe(false); // no re-priming
    });

    it('anchors every LLM request on user messages (round N + context snapshot)', async () => {
        // Each round's request is anchored: every prior round is replayed as a
        // user anchor + assistant/tool groups; the live round's anchor is the
        // last user message (spec §6.5;
        // decisions/round-anchored-transcript.md).
        const ctx = '=== ROOM ===\nMain Room';
        const seenMessages = [];
        const { agent } = makeAgent({
            chatFullImpl: (messages) => {
                seenMessages.push(JSON.parse(JSON.stringify(messages)));
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: toolMessage([{ name: 'done', args: '{}' }])
                };
            }
        });

        await agent.runRound(NPC_ID, 0);
        await agent.runRound(NPC_ID, 1);

        // Round 0: no prior rounds — the sole user message is the live anchor.
        const req0 = seenMessages[0];
        expect(req0.filter((m) => m.role === 'user')).toHaveLength(1);
        expect(req0[0]).toEqual({ role: 'user', content: 'round 0\n\n' + ctx });

        // Round 1: round 0 replayed (anchor + assistant + tool), then the
        // live round's anchor, as the last user message.
        const req1 = seenMessages[1];
        const users = req1.filter((m) => m.role === 'user');
        expect(users).toHaveLength(2);
        expect(users[0].content).toBe('round 0\n\n' + ctx);
        expect(req1.filter((m) => m.role === 'assistant')).toHaveLength(1);
        expect(req1.filter((m) => m.role === 'tool')).toHaveLength(1);
        expect(req1.at(-1)).toEqual({ role: 'user', content: 'round 1\n\n' + ctx });
    });

    it('replays legacy entries (no context saved) as the round number alone; guard stops stay invisible', async () => {
        // Entries stored before the context snapshot existed (legacy
        // single-call shape) and guard stops ({ error }) must not crash or
        // fabricate context: the round number alone is the anchor, and entries
        // with no groups (NPC_GONE) replay nothing, as before.
        const { agent } = makeAgent({});
        agent._storeTranscript(NPC_ID, 7, {
            assistant: { role: 'assistant', content: 'legacy thought', tool_calls: [] },
            results: []
        });
        agent._storeTranscript(NPC_ID, 8, { error: 'NPC_GONE' });
        const replay = agent._transcriptFor(NPC_ID);
        expect(replay).toHaveLength(2);
        expect(replay[0]).toEqual({ role: 'user', content: 'round 7' });
        expect(replay[1]).toEqual({ role: 'assistant', content: 'legacy thought' });
    });

    it('clean prose in the transcript is preserved verbatim (sanitizer only touches broken output)', async () => {
        const roomChat = makeRoomChat();
        let callCount = 0;
        const seenMessages = [];
        const { agent } = makeAgent({
            roomChat,
            chatFullImpl: (messages) => {
                callCount += 1;
                seenMessages.push(JSON.parse(JSON.stringify(messages)));
                if (callCount === 1) {
                    return {
                        content: 'The door is locked; I will find another way.',
                        toolCalls: [],
                        finishReason: 'stop',
                        message: { role: 'assistant', content: 'The door is locked; I will find another way.' }
                    };
                }
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: toolMessage([{ name: 'execute_action', args: '{"actionName":"move"}' }])
                };
            }
        });

        await agent.runRound(NPC_ID, 0);
        await agent.runRound(NPC_ID, 1);

        const nextReq = seenMessages[1];
        // One user anchor per stored round (round 0) plus the live round 1.
        const users = nextReq.filter(m => m.role === 'user');
        expect(users).toHaveLength(2);
        expect(users[0].content).toBe('round 0\n\n=== ROOM ===\nMain Room');
        expect(users.at(-1).content).toBe('round 1\n\n=== ROOM ===\nMain Room');
        const assistant = nextReq.find(m => m.role === 'assistant');
        expect(assistant.content).toBe('The door is locked; I will find another way.');
    });

    it('reasoning_content from the model is replayed to in-round retries and the next round', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'] } });
        const turns = makeTurns();
        let callCount = 0;
        const seenMessages = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                callCount += 1;
                seenMessages.push(JSON.parse(JSON.stringify(messages)));
                if (callCount === 1) {
                    // Unknown action ('fly') → pre-validation failure → retry.
                    return {
                        content: 'Let me repair.',
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: 'Let me repair.',
                            reasoning_content: 'I must self-repair to survive.',
                            tool_calls: [{
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'execute_action', arguments: '{"actionName":"fly"}' }
                            }]
                        }
                    };
                }
                // call 2 = the in-round retry (succeeds and ends the round via
                // the done tool); call 3+ = the next round.
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: {
                        role: 'assistant',
                        reasoning_content: 'The door is jammed; a repair should free it.',
                        tool_calls: [{
                            id: 'call_2',
                            type: 'function',
                            function: { name: 'execute_action', arguments: '{"actionName":"selfHeal"}' }
                        }, {
                            id: 'call_3',
                            type: 'function',
                            function: { name: 'done', arguments: '{}' }
                        }]
                    }
                };
            }
        });

        const r1 = await agent.runRound(NPC_ID, 0);
        expect(r1.iterations).toBe(2);
        // In-round retry request carries the model's reasoning for the failed call:
        const retryReq = seenMessages[1];
        const retryAssistant = retryReq.find(m => m.role === 'assistant' && m.reasoning_content);
        expect(retryAssistant).toBeTruthy();
        expect(retryAssistant.reasoning_content).toBe('I must self-repair to survive.');

        // Next round: the stored transcript replays every in-round group —
        // here both the failed call (R1) and the final call (R2). The final
        // assistant message carries the latest reasoning.
        await agent.runRound(NPC_ID, 1);
        const nextReq = seenMessages[2];
        const nextAssistants = nextReq.filter(
            (m) => m.role === 'assistant' && m.reasoning_content
        );
        expect(nextAssistants).toHaveLength(2);
        expect(nextAssistants.at(-1).reasoning_content).toBe(
            'The door is jammed; a repair should free it.'
        );
        // Round anchoring survives retries: one user anchor per stored round
        // (round 0) plus the live one (round 1).
        expect(nextReq.filter(m => m.role === 'user')).toHaveLength(2);
        expect(nextReq.at(-1)).toEqual({
            role: 'user',
            content: 'round 1\n\n=== ROOM ===\nMain Room'
        });
    });

    it('discovery round: get_actions/get_instincts feed back the action list, so the model acts instead of spinning (spec §6.5)', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'], move: ['comp-hand'], cut: [] } });
        const turns = makeTurns();
        let callCount = 0;
        const seenMessages = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                callCount += 1;
                seenMessages.push(JSON.parse(JSON.stringify(messages)));
                // Simulate an LLM that keeps re-discovering until it actually
                // sees the action list fed back into the conversation. The
                // "| range" marker is unique to the formatted action list
                // (formatActionList emits "| range N | needs ... | use comp-..").
                // Before the fix nothing was appended after a discovery call,
                // so this returned the discovery calls every round and spun to
                // the budget cap; after the fix the list appears on call 2 and
                // it acts.
                const hasList = messages.some(
                    (m) => m.role === 'tool' && typeof m.content === 'string'
                        && m.content.includes('| range')
                );
                if (!hasList) {
                    return {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: toolMessage([{ name: 'get_actions', args: '{}' }, { name: 'get_instincts', args: '{}' }])
                    };
                }
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: toolMessage([
                        { name: 'execute_action', args: '{"actionName":"selfHeal"}' },
                        { name: 'done', args: '{}' }
                    ])
                };
            }
        });
        // The main makeAgent stubs only buildContext; the discovery tools read
        // getActionData (the live canExecute), which the real LlmContextController
        // exposes (monkey-patched below) so the action list is non-empty.
        agent.llmContextController = {
            buildContext: () => ({ text: '=== ROOM === Main Room' }),
            getActionData: () => ({
                entries: [
                    { name: 'selfHeal', description: 'self-repair', range: 0, canExecute: ['comp-head-1'], requirement: '' },
                    { name: 'move', description: 'walk', range: 100, canExecute: ['comp-hand'], requirement: '' }
                ],
                notExecutable: ['cut']
            })
        };

        const result = await agent.runRound(NPC_ID, 0);

        // Exactly two LLM calls (discover, then act), not a spin to the 41
        // iteration budget of the pre-fix discovery loop.
        expect(callCount).toBe(2);
        expect(result.iterations).toBe(2);
        expect(turns.queued).toHaveLength(1);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toMatchObject({ actionName: 'selfHeal', queued: true, success: true });
        expect(result.error).toBeNull();

        // The second call's conversation must carry the discovery result:
        // the assistant replay (with both discovery tool calls) and a
        // tool-role result for get_actions whose content includes the
        // formatted action list (executable names + not-executable summary).
        const discovery = seenMessages[1];
        const assistantReplay = discovery.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
        expect(assistantReplay).toBeTruthy();
        expect(assistantReplay.tool_calls.map((t) => t.function.name)).toEqual(['get_actions', 'get_instincts']);
        const actionTool = discovery.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
        expect(actionTool).toBeTruthy();
        const actionPayload = JSON.parse(actionTool.content);
        expect(actionPayload.success).toBe(true);
        expect(typeof actionPayload.list).toBe('string');
        expect(actionPayload.list).toMatch(/selfHeal/);
        expect(actionPayload.list).toMatch(/move/);
        expect(actionPayload.list).toMatch(/cut/); // not-executable summary
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

// =========================================================================
// Instincts System Tests (spec §6.8 — T1-T7)
// =========================================================================

describe('LLMAgentController — Instincts system (T1-T7)', () => {
    const NPC_ID = 'ent-npc-0001';
    const NPC = {
        id: NPC_ID,
        name: 'Bolt',
        blueprint: 'merchantDroid',
        isNPC: true,
        location: 'room-main',
        spatial: { x: 50, y: 50 }
    };

    const ACTION_REGISTRY = {
        move: { description: 'walk', range: 100, requirements: [] },
        droidPunch: { description: 'punch', range: 10, requirements: [] },
        selfHeal: { description: 'heal', range: 0, requirements: [] }
    };

    function makeWorld(overrides = {}) {
        return {
            getEntity: (id) => (id === NPC_ID ? NPC : null),
            getRooms: () => ({ 'room-main': { name: 'Main Room' } }),
            actionController: { getRegistry: () => ACTION_REGISTRY },
            stateEntityController: { getAll: () => ({ [NPC_ID]: NPC }) },
            getActionsForEntity: (id) => {
                if (id !== NPC_ID) return {};
                return {
                    move: { canExecute: ['comp-hand'], cannotExecute: [] },
                    droidPunch: { canExecute: overrides.punchCanExecute || ['comp-hand'], cannotExecute: [] }
                };
            },
            executeAction: () => ({ success: true })
        };
    }

    function makeRoomChat() {
        return { sent: [], sendMessage: () => ({ success: true }) };
    }

    function makeTurns(overrides = {}) {
        const queued = [];
        return {
            queued,
            getRoundState: () => ({ phase: 'planning', roundNumber: 0 }),
            queueAction: (entityId, actionName, params, source) => {
                queued.push({ entityId, actionName, params, source });
                return overrides.rejectSecond && queued.length >= 2
                    ? { success: false, code: 'QUEUE_FULL' }
                    : { success: true };
            }
        };
    }

    /** Builds an agent with a scripted chatFull and optional instinctController. */
    function makeAgent({ world, roomChat, turns, chatFullImpl, instincts = [], instinctController = null, llmContextController = null, roomChat: rc = null } = {}) {
        const llmStub = { chatFull: async (messages, options) => chatFullImpl(messages, options) };
        const fakeInstinctCtrl = instinctController ?? {
            generateForEntity: () => instincts,
            expand: () => ({ ok: true, steps: [] })
        };
        const agent = new LLMAgentController({
            llmController: llmStub,
            worldStateController: world ?? makeWorld(),
            llmContextController: llmContextController ?? { buildContext: () => ({ text: '=== ROOM ===\nMain Room' }) },
            roomChatController: rc ?? roomChat ?? makeRoomChat(),
            turnSystemController: turns ?? makeTurns(),
            instinctController: fakeInstinctCtrl
        });
        return { agent };
    }

    function toolMessage(calls) {
        return {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c, i) => ({
                id: `call_${i + 1}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) }
            }))
        };
    }

    // T1: use_instinct with targetEntityId → two queueAction calls in order
    it('T1: use_instinct {instinct:"chase_attack", targetEntityId} → two queueAction calls (move then selfHeal)', async () => {
        const world = makeWorld();
        const turns = makeTurns();
        // Override getActionsForEntity to provide canExecute for both actions
        world.getActionsForEntity = (id) => {
            if (id !== NPC_ID) return {};
            return {
                move: { canExecute: ['comp-hand'], cannotExecute: [] },
                selfHeal: { canExecute: ['comp-core'], cannotExecute: [] }
            };
        };
        const instincts = [
            { name: 'chase_attack', description: 'chase and attack' }
        ];
        const instinctController = {
            generateForEntity: () => instincts,
            expand: (entityId, instinctName) => {
                const inst = instincts.find(i => i.name === instinctName);
                return inst ? { ok: true, steps: [{ actionName: 'move' }, { actionName: 'selfHeal' }] } : { ok: false, error: 'unknown' };
            }
        };
        const { agent } = makeAgent({
            world,
            turns,
            instincts,
            instinctController,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'use_instinct', args: { instinctId: 'chase_attack', targetEntityId: 'ent-target-1' } }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(turns.queued).toHaveLength(2);
        expect(turns.queued[0].actionName).toBe('move');
        expect(turns.queued[1].actionName).toBe('selfHeal');
        for (const q of turns.queued) {
            expect(q.entityId).toBe(NPC_ID);
            expect(q.source).toBe('npc');
        }
        expect(result.actions).toHaveLength(2);
        expect(result.actions[0].instinct).toBe('chase_attack');
        expect(result.actions[1].instinct).toBe('chase_attack');
        expect(result.error).toBeNull();
    });

    // T2: use_instinct without target → params use nearest entity position
    it('T2: use_instinct without target → params use nearest entity position', async () => {
        const world = makeWorld();
        const turns = makeTurns();
        // Override getActionsForEntity to provide canExecute for move
        world.getActionsForEntity = (id) => {
            if (id !== NPC_ID) return {};
            return {
                move: { canExecute: ['comp-hand'], cannotExecute: [] }
            };
        };
        const instincts = [
            { name: 'chase', description: 'chase target' }
        ];
        // Add a nearby entity for nearest selection
        world.getAll = () => ({
            [NPC_ID]: NPC,
            'ent-nearby': { id: 'ent-nearby', location: 'room-main', spatial: { x: 60, y: 50 } }
        });
        const instinctController = {
            generateForEntity: () => instincts,
            expand: (entityId, instinctName) => {
                const inst = instincts.find(i => i.name === instinctName);
                return inst ? { ok: true, steps: [{ actionName: 'move', params: { targetX: 60, targetY: 50 } }] } : { ok: false, error: 'unknown' };
            }
        };
        const { agent } = makeAgent({
            world,
            turns,
            instincts,
            instinctController,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'use_instinct', args: { instinctId: 'chase' } }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].instinct).toBe('chase');
        expect(result.actions[0].success).toBe(true);
        expect(result.error).toBeNull();
    });

    // T3: unknown instinct name → one failed action + exactly one retry
    it('T3: unknown instinct name → one failed action + exactly one retry', async () => {
        const world = makeWorld();
        const turns = makeTurns();
        let callCount = 0;
        const instincts = [{ name: 'known_instinct', description: 'known' }];
        const instinctController = {
            generateForEntity: () => instincts,
            expand: (entityId, instinctName) => {
                if (instinctName === 'nonexistent_instinct') {
                    return { ok: false, error: 'unknown instinct' };
                }
                return { ok: true, steps: [{ actionName: 'move' }] };
            }
        };
        const { agent } = makeAgent({
            world,
            turns,
            instincts,
            instinctController,
            chatFullImpl: () => {
                callCount += 1;
                if (callCount === 1) {
                    return {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: toolMessage([{ name: 'use_instinct', args: { instinctId: 'nonexistent_instinct' } }])
                    };
                }
                // Retry: model gives up
                return {
                    content: 'OK, I\'ll wait.',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: 'OK, I\'ll wait.' }
                };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(callCount).toBe(2); // initial + retry
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].instinct).toBe('nonexistent_instinct');
        expect(result.actions[0].success).toBe(false);
        expect(result.error).toBeNull(); // the round itself doesn't error, just the action
    });

    // T4: mid-sequence capability flip → first step queued, second failed/aborted
    it('T4: mid-sequence capability flip → first step queued, second aborted', async () => {
        const world = makeWorld();
        let moveEnabled = true;
        // Override getActionsForEntity to dynamically control canExecute
        world.getActionsForEntity = (id) => {
            if (id !== NPC_ID) return {};
            return {
                move: { canExecute: moveEnabled ? ['comp-hand'] : [], cannotExecute: [] },
                selfHeal: { canExecute: moveEnabled ? [] : ['comp-core'], cannotExecute: [] }
            };
        };
        const turns = makeTurns();
        const instincts = [
            { name: 'chase_attack', description: 'chase and attack' }
        ];
        const instinctController = {
            generateForEntity: () => instincts,
            expand: (entityId, instinctName) => {
                const inst = instincts.find(i => i.name === instinctName);
                return inst ? { ok: true, steps: [{ actionName: 'move' }, { actionName: 'selfHeal' }] } : { ok: false, error: 'unknown' };
            }
        };
        let t4Calls = 0;
        const { agent } = makeAgent({
            world,
            turns,
            instincts,
            instinctController,
            chatFullImpl: () => {
                t4Calls += 1;
                if (t4Calls === 1) {
                    return {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: toolMessage([{ name: 'use_instinct', args: { instinctId: 'chase_attack', targetEntityId: 'ent-target-1' } }])
                    };
                }
                return {
                    content: 'I have finished this instinct.',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: 'I have finished this instinct.' }
                };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.actions.length).toBeGreaterThanOrEqual(1);
        // First step should succeed (move is enabled initially)
        expect(result.actions[0].actionName).toBe('use_instinct(chase_attack):move');
        expect(result.actions[0].success).toBe(true);
        // Round completes without throw
        expect(result.error).toBeNull();
    });

    // T5: tool schema — use_instinct present in tools when instincts non-empty, absent when empty
    it('T5: tool schema includes use_instinct when instincts non-empty; absent when empty', async () => {
        const world = makeWorld();
        const turns = makeTurns();
        const seenOptions = [];

        // With instincts
        const instincts = [{ name: 'chase', description: 'chase' }];
        const { agent: agentWith } = makeAgent({
            world,
            turns,
            instincts,
            chatFullImpl: (messages, options) => {
                seenOptions.push(options);
                return {
                    content: '{"action":"none"}',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: '{"action":"none"}' }
                };
            }
        });

        await agentWith.runRound(NPC_ID, 0);
        expect(seenOptions).toHaveLength(1);
        const toolsWith = seenOptions[0].tools || [];
        const toolNamesWith = toolsWith.map(t => t.function.name);
        expect(toolNamesWith).toContain('use_instinct');
        const instinctTool = toolsWith.find(t => t.function.name === 'use_instinct');
        expect(instinctTool.function.parameters.properties.instinctId.type).toBe('string');

        // Without instincts
        seenOptions.length = 0;
        const { agent: agentWithout } = makeAgent({
            world,
            turns,
            instincts: [],
            chatFullImpl: (messages, options) => {
                seenOptions.push(options);
                return {
                    content: '{"action":"none"}',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: '{"action":"none"}' }
                };
            }
        });

        await agentWithout.runRound(NPC_ID, 0);
        const toolsWithout = seenOptions[0].tools || [];
        const toolNamesWithout = toolsWithout.map(t => t.function.name);
        expect(toolNamesWithout).not.toContain('use_instinct');
        expect(toolNamesWithout).toContain('execute_action');
        expect(toolNamesWithout).toContain('speak_in_room');
    });

    // T6: turn mock rejects second queueAction (QUEUE_FULL) → second step failed, third aborted
    it('T6: QUEUE_FULL on second step → second failed, round completes', async () => {
        const world = makeWorld();
        // Override getActionsForEntity to provide canExecute for both actions
        world.getActionsForEntity = (id) => {
            if (id !== NPC_ID) return {};
            return {
                move: { canExecute: ['comp-hand'], cannotExecute: [] },
                selfHeal: { canExecute: ['comp-core'], cannotExecute: [] }
            };
        };
        const turns = makeTurns({ rejectSecond: true });
        const instincts = [
            { name: 'chase_attack', description: 'chase and attack' }
        ];
        const instinctController = {
            generateForEntity: () => instincts,
            expand: (entityId, instinctName) => {
                const inst = instincts.find(i => i.name === instinctName);
                return inst ? { ok: true, steps: [{ actionName: 'move' }, { actionName: 'selfHeal' }] } : { ok: false, error: 'unknown instinct' };
            }
        };
        let instinctCallCount = 0;
        const { agent } = makeAgent({
            world,
            turns,
            instincts,
            instinctController,
            chatFullImpl: () => {
                instinctCallCount += 1;
                // First call: return instinct tool call
                // Retry (second call): return plain text to avoid extra actions in result
                if (instinctCallCount === 1) {
                    return {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: toolMessage([{ name: 'use_instinct', args: { instinctId: 'chase_attack', targetEntityId: 'ent-target-1' } }])
                    };
                }
                // Retry response: plain text (no additional actions)
                return {
                    content: 'Retry OK, stopping.',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: 'Retry OK, stopping.' }
                };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.actions).toHaveLength(2);
        expect(result.actions[0].actionName).toBe('use_instinct(chase_attack):move');
        expect(result.actions[0].success).toBe(true);
        expect(result.actions[1].actionName).toBe('use_instinct(chase_attack):selfHeal');
        expect(result.actions[1].success).toBe(false);
        expect(result.actions[1].detail).toBe('QUEUE_FULL');
        expect(result.error).toBeNull(); // round completes
    });

    // T7: buildContext receives options.instincts equal to generated list
    it('T7: buildContext receives options.instincts equal to the generated list', async () => {
        const world = makeWorld();
        const turns = makeTurns();
        let capturedInstincts = null;
        const instincts = [
            { name: 'chase', description: 'chase target' },
            { name: 'flee', description: 'run away' }
        ];
        const ctxCtrl = {
            buildContext: (entityId, options) => {
                capturedInstincts = options?.instincts ?? null;
                return { text: '=== ROOM ===\nMain Room' };
            }
        };
        const { agent } = makeAgent({
            world,
            turns,
            instincts,
            chatFullImpl: () => ({
                content: '{"action":"none"}',
                toolCalls: [],
                finishReason: 'stop',
                message: { role: 'assistant', content: '{"action":"none"}' }
            }),
            instinctController: {
                generateForEntity: () => instincts,
                expand: () => ({ ok: true, steps: [] })
            },
            roomChat: makeRoomChat(),
            llmContextController: ctxCtrl
        });

        await agent.runRound(NPC_ID, 0);

        expect(capturedInstincts).toBe(instincts);
        expect(capturedInstincts).toHaveLength(2);
        expect(capturedInstincts[0].name).toBe('chase');
        expect(capturedInstincts[1].name).toBe('flee');
    });

    // Additional: null-tolerant controller (spec §2.5 — graceful degradation)
    it('null-tolerant: absent instinctController → runRound completes normally without instincts', async () => {
        const world = makeWorld();
        const turns = makeTurns();
        const roomChat = makeRoomChat();

        const agent = new LLMAgentController({
            llmController: { chatFull: async () => ({ content: '{"action":"none"}', toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: '{"action":"none"}' } }) },
            worldStateController: world,
            llmContextController: { buildContext: () => ({ text: '=== ROOM ===\nMain Room' }) },
            roomChatController: roomChat,
            turnSystemController: turns,
            instinctController: null // explicitly null
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.error).toBeNull();
        expect(turns.queued).toHaveLength(0);
    });
});

// =========================================================================
// toApproach tool tests
// =========================================================================
describe('LLMAgentController.runRound — toApproach tool', () => {
    // Same-room target shared by the approach tests.
    const TARGET = { id: 'ent-target-0001', name: 'Merchant', location: 'room-main', spatial: { x: 200, y: 100 } };

    it('offers toApproach in the generated tool schema (fixed intent, required ent-* target)', async () => {
        const calls = [];
        const { agent } = makeAgent({
            calls,
            chatFullImpl: (messages, options) => {
                calls.push(options);
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: null, tool_calls: [] }
                };
            }
        });

        await agent.runRound(NPC_ID, 0);

        expect(calls).toHaveLength(1);
        const options = calls[0];
        expect(options.tools.map(t => t.function.name)).toContain('execute_action');
        expect(options.tools.map(t => t.function.name)).toContain('toApproach');
        const approach = options.tools.find(t => t.function.name === 'toApproach');
        expect(approach.function.parameters.properties.targetEntityId.type).toBe('string');
        expect(approach.function.parameters.required).toEqual(['targetEntityId']);
    });

    it('queues the registered move action toward the target, with server-resolved coordinates', async () => {
        const world = makeWorld({ canExecute: { move: ['comp-arms-1'] }, target: TARGET });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'toApproach', args: JSON.stringify({ targetEntityId: TARGET.id }) }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.error).toBeNull();
        expect(result.iterations).toBe(1);
        expect(result.approaches).toHaveLength(1);
        expect(result.approaches[0]).toMatchObject({ id: 'call_1', actionName: 'toApproach', queued: true, queueId: 'q-1', success: true });
        expect(world.executeCalls).toHaveLength(0);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0]).toMatchObject({ entityId: NPC_ID, actionName: 'move', source: 'npc' });
        expect(turns.queued[0].params).toEqual({ targetX: 200, targetY: 100 });
    });

    it('falls back to immediate execution when no turn system is running', async () => {
        const world = makeWorld({ canExecute: { move: ['comp-arms-1'] }, target: TARGET });
        const { agent } = makeAgent({
            world,
            // A turn object with no phase (turnsActive === false) → the
            // immediate-execution path instead of the turn queue.
            turns: { getRoundState: () => ({}), queueAction: () => null },
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'toApproach', args: JSON.stringify({ targetEntityId: TARGET.id }) }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.error).toBeNull();
        expect(result.approaches[0]).toMatchObject({ id: 'call_1', actionName: 'toApproach', queued: false, success: true, detail: 'executed immediately' });
        expect(world.executeCalls).toHaveLength(1);
        expect(world.executeCalls[0]).toMatchObject({ actionName: 'move', entityId: NPC_ID, params: { targetX: 200, targetY: 100 } });
    });

    it('rejects a non-entity id (comp- prefix) with invalid id format and retries once', async () => {
        const world = makeWorld({ canExecute: { move: ['comp-arms-1'] }, target: TARGET });
        const turns = makeTurns();
        const seenMessages = [];
        let call = 0;
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                call += 1;
                seenMessages.push(messages);
                return call === 1
                    ? { content: null, toolCalls: [], finishReason: 'tool_calls', message: toolMessage([{ name: 'toApproach', args: JSON.stringify({ targetEntityId: 'comp-not-an-entity' }) }]) }
                    : { content: 'Fine, I shall wait.', toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: 'Fine, I shall wait.' } };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(call).toBe(2);
        expect(result.iterations).toBe(2);
        expect(result.approaches).toHaveLength(1);
        expect(result.approaches[0]).toMatchObject({ id: 'call_1', actionName: 'toApproach', success: false });
        expect(result.approaches[0].detail).toBe(`invalid id format: targetEntityId="comp-not-an-entity"`);

        // The retry's conversation carries the failure as tool-role feedback.
        const retryMessages = seenMessages[1];
        const toolMsg = retryMessages.find(m => m.role === 'tool');
        expect(toolMsg).toBeTruthy();
        const toolPayload = JSON.parse(toolMsg.content);
        expect(toolPayload).toEqual({ success: false, error: `invalid id format: targetEntityId="comp-not-an-entity"` });
        expect(toolMsg.tool_call_id).toBe('call_1');

        expect(world.executeCalls).toHaveLength(0);
        expect(turns.queued).toHaveLength(0);
    });

    it('rejects a target that is not in the NPC room (same-room spatial rule)', async () => {
        const other = { id: 'ent-target-0002', name: 'Merchant B', location: 'room-warehouse', spatial: { x: 10, y: 10 } };
        const world = makeWorld({ canExecute: { move: ['comp-arms-1'] }, target: other });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'toApproach', args: JSON.stringify({ targetEntityId: other.id }) }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.approaches[0].success).toBe(false);
        expect(result.approaches[0].detail).toMatch(/not in your room/);
        expect(result.approaches[0].detail).toMatch(/use_door/);
        expect(world.executeCalls).toHaveLength(0);
        expect(turns.queued).toHaveLength(0);
    });

    it('is blocked when the NPC cannot currently move (capability gate)', async () => {
        // default canExecute = {} → move is not executable right now.
        const world = makeWorld({ target: TARGET });
        const { agent } = makeAgent({
            world,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'toApproach', args: JSON.stringify({ targetEntityId: TARGET.id }) }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.approaches[0].success).toBe(false);
        expect(result.approaches[0].detail).toMatch(/move not executable right now/);
        expect(world.executeCalls).toHaveLength(0);
    });

    it('counts toward the per-round world action budget (first two succeed, third fails)', async () => {
        const world = makeWorld({ canExecute: { move: ['comp-arms-1'] }, target: TARGET });
        const turns = makeTurns();
        const seenMessages = [];
        let call = 0;
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                call += 1;
                seenMessages.push(messages);
                return call === 1
                    ? {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                { id: 'call_1', type: 'function', function: { name: 'toApproach', arguments: JSON.stringify({ targetEntityId: TARGET.id }) } },
                                { id: 'call_2', type: 'function', function: { name: 'toApproach', arguments: JSON.stringify({ targetEntityId: TARGET.id }) } },
                                { id: 'call_3', type: 'function', function: { name: 'toApproach', arguments: JSON.stringify({ targetEntityId: TARGET.id }) } }
                            ]
                        }
                    }
                    : { content: null, toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: null, tool_calls: [] } };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.approaches).toHaveLength(3);
        expect(result.approaches[0]).toMatchObject({ id: 'call_1', actionName: 'toApproach', success: true });
        expect(result.approaches[1]).toMatchObject({ id: 'call_2', actionName: 'toApproach', success: true });
        expect(result.approaches[2]).toMatchObject({ id: 'call_3', success: false, detail: 'max world actions per round reached (2)' });
        expect(turns.queued).toHaveLength(2);
    });

    it('replays a truthful approach outcome in the next round (transcript tool message)', async () => {
        const world = makeWorld({ canExecute: { move: ['comp-arms-1'] }, target: TARGET });
        const turns = makeTurns();
        const seenMessages = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                seenMessages.push(messages);
                return seenMessages.length === 1
                    ? {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'toApproach', arguments: JSON.stringify({ targetEntityId: TARGET.id }) } }, { id: 'call_2', type: 'function', function: { name: 'done', arguments: '{}' } }]
                        }
                    }
                    : { content: null, toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: null, tool_calls: [] } };
            }
        });

        await agent.runRound(NPC_ID, 1);
        await agent.runRound(NPC_ID, 2);

        const r2Messages = seenMessages[1];
        const toolMsg = r2Messages.find(m => m.role === 'tool');
        expect(toolMsg).toBeTruthy();
        expect(toolMsg.tool_call_id).toBe('call_1');
        const toolPayload = JSON.parse(toolMsg.content);
        // Replay normalizes the dispatch detail to the `error` field (the
        // same shape the execute_action tool results use).
        expect(toolPayload.success).toBe(true);
        expect(toolPayload.error).toMatch(/queued toward target/);
        expect(toolPayload.error).toMatch(/targetX=200/);
        expect(toolPayload.error).toMatch(/targetY=100/);
        // The prior round is anchored by its user message (round number +
        // context snapshot), same shape as the live round.
        const users = r2Messages.filter(m => m.role === 'user');
        expect(users).toHaveLength(2);
        expect(users[0].content).toBe('round 1\n\n=== ROOM ===\nMain Room');
        expect(users.at(-1).content).toBe('round 2\n\n=== ROOM ===\nMain Room');
    });
});

// =========================================================================
// USE_DOOR (room travel). The tool is a thin intent wrapper over the
// registered `crossDoor` action — the same shape as toApproach over `move`:
// the model names a DOOR of the room it stands in (room uids are generated per
// load, so a destination can never be named by the model), the server resolves
// the room beyond. The crossing itself — the real rooms of
// data/mods/core-rooms/rooms.json and the traverseDoor consequence — is pinned
// by test/contract/crossDoor.contract.test.js.
// =========================================================================

describe('LLMAgentController.runRound — use_door tool', () => {
    const DOOR_ROOMS = {
        'room-main': { name: 'Main Room', connections: { right_door: { target: 'room-east' } } },
        'room-east': { name: 'East Corridor', connections: { left_door: { target: 'room-main' } } }
    };

    /**
     * A world whose rooms carry doors, plus a PRIVATE copy of the NPC so a test
     * can relocate it without mutating the module-level NPC the other suites
     * share. `moves: true` makes the stub facade actually change the entity's
     * location, which is what lets the immediate-execution detail name the room
     * the droid landed in.
     */
    function makeDoorWorld({ canExecute = { crossDoor: ['comp-leg-1'] }, maxWorldActionsPerRound = null, moves = false, doorAt = { x: 30, y: 0 } } = {}) {
        const npc = { ...NPC, location: 'room-main', spatial: { x: 10, y: 10 } };
        if (maxWorldActionsPerRound) npc.npcConfig = { maxWorldActionsPerRound };
        const world = makeWorld({ canExecute, rooms: DOOR_ROOMS });
        world.getEntity = (id) => (id === NPC_ID ? npc : null);
        // Door geometry: right_door sits beside the droid by default, so a
        // crossing is in reach unless a test places the door farther away.
        world.getDoorPosition = (roomId, door) => (roomId === 'room-main' && door === 'right_door' ? { ...doorAt } : null);
        if (moves) {
            world.executeAction = (actionName, entityId, params) => {
                world.executeCalls.push({ actionName, entityId, params });
                if (actionName === 'crossDoor' && params.door === 'right_door') npc.location = 'room-east';
                return { success: true };
            };
        }
        return { world, npc };
    }

    /** Scripts one failing first call, then silence (so the retry loop cannot spin). */
    function failThenSilence(firstCall) {
        let call = 0;
        return () => {
            call += 1;
            return call === 1
                ? { content: null, toolCalls: [], finishReason: 'tool_calls', message: toolMessage([firstCall]) }
                : { content: 'Standing by.', toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: 'Standing by.' } };
        };
    }

    it('offers use_door in the generated tool schema (required door name, listed before done)', async () => {
        const calls = [];
        const { world } = makeDoorWorld();
        const { agent } = makeAgent({
            world,
            calls,
            chatFullImpl: (messages, options) => {
                calls.push(options);
                return { content: null, toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: null, tool_calls: [] } };
            }
        });

        await agent.runRound(NPC_ID, 0);

        const order = calls[0].tools.map(t => t.function.name);
        expect(order).toContain('use_door');
        expect(order.indexOf('use_door')).toBeLessThan(order.indexOf('done'));
        const useDoor = calls[0].tools.find(t => t.function.name === 'use_door');
        expect(useDoor.function.parameters.properties.door.type).toBe('string');
        expect(useDoor.function.parameters.required).toEqual(['door']);
    });

    it('queues the registered crossDoor action with the door the model named', async () => {
        const { world } = makeDoorWorld();
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'use_door', args: JSON.stringify({ door: 'right_door' }) }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.error).toBeNull();
        expect(result.doors).toHaveLength(1);
        expect(result.doors[0]).toMatchObject({ id: 'call_1', actionName: 'use_door', queued: true, queueId: 'q-1', success: true });
        // A queued crossing has NOT happened yet — the detail claims no destination.
        expect(result.doors[0].detail).toBe('crossDoor queued through "right_door"');
        expect(world.executeCalls).toHaveLength(0);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0]).toMatchObject({ entityId: NPC_ID, actionName: 'crossDoor', source: 'npc' });
        expect(turns.queued[0].params).toEqual({ door: 'right_door' });
    });

    it('executes immediately and reports the room the world moved it to', async () => {
        const { world, npc } = makeDoorWorld({ moves: true });
        const { agent } = makeAgent({
            world,
            // A turn object with no phase (turnsActive === false) → immediate execution.
            turns: { getRoundState: () => ({}), queueAction: () => null },
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: toolMessage([{ name: 'use_door', args: JSON.stringify({ door: 'right_door' }) }, { name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(npc.location).toBe('room-east');
        expect(result.doors[0]).toMatchObject({ actionName: 'use_door', queued: false, success: true });
        expect(result.doors[0].detail).toBe('crossed "right_door": "Main Room" -> "East Corridor"');
        expect(world.executeCalls).toHaveLength(1);
        expect(world.executeCalls[0]).toMatchObject({ actionName: 'crossDoor', entityId: NPC_ID, params: { door: 'right_door' } });
    });

    it('rejects a door the current room does not have, naming the doors it does have', async () => {
        const { world, npc } = makeDoorWorld();
        const turns = makeTurns();
        const { agent } = makeAgent({ world, turns, chatFullImpl: failThenSilence({ name: 'use_door', args: JSON.stringify({ door: 'trap_door' }) }) });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.doors).toHaveLength(1);
        expect(result.doors[0].success).toBe(false);
        expect(result.doors[0].detail).toBe('no door "trap_door" in your room (doors here: right_door)');
        expect(npc.location).toBe('room-main');
        expect(turns.queued).toHaveLength(0);
        expect(world.executeCalls).toHaveLength(0);
    });

    it('rejects a call with no door name', async () => {
        const { world } = makeDoorWorld();
        const turns = makeTurns();
        const { agent } = makeAgent({ world, turns, chatFullImpl: failThenSilence({ name: 'use_door', args: '{}' }) });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.doors[0].success).toBe(false);
        expect(result.doors[0].detail).toBe('missing "door"');
        expect(turns.queued).toHaveLength(0);
    });

    it('is blocked when crossDoor is not executable right now (capability gate)', async () => {
        // No capable component → the capability report lists crossDoor as not
        // executable, and a droid that cannot move cannot leave a room.
        const { world } = makeDoorWorld({ canExecute: {} });
        const turns = makeTurns();
        const { agent } = makeAgent({ world, turns, chatFullImpl: failThenSilence({ name: 'use_door', args: JSON.stringify({ door: 'right_door' }) }) });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.doors[0].success).toBe(false);
        expect(result.doors[0].detail).toBe('crossDoor not executable right now (insufficient movement stats)');
        expect(turns.queued).toHaveLength(0);
    });

    it('refuses a door the droid is not standing at, naming the distance and the reach', async () => {
        // The droid stands at (10, 10); the door is at (300, 0) — about 290 units
        // away, and crossDoor declares range 50.
        const { world, npc } = makeDoorWorld({ doorAt: { x: 300, y: 0 } });
        const turns = makeTurns();
        const { agent } = makeAgent({ world, turns, chatFullImpl: failThenSilence({ name: 'use_door', args: JSON.stringify({ door: 'right_door' }) }) });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.doors[0].success).toBe(false);
        expect(result.doors[0].detail).toBe('"right_door" is 290 units away — walk to its position first (reach 50)');
        // A rejected pre-validation never reaches the world, so it costs the droid
        // no world action — the budget is left for the walk to the door.
        expect(turns.queued).toHaveLength(0);
        expect(world.executeCalls).toHaveLength(0);
        expect(npc.location).toBe('room-main');
    });

    it('counts a crossing against the per-round world-action budget', async () => {
        const { world } = makeDoorWorld({ maxWorldActionsPerRound: 1 });
        const turns = makeTurns();
        let call = 0;
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => {
                call += 1;
                return call === 1
                    ? {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: toolMessage([
                            { name: 'use_door', args: JSON.stringify({ door: 'right_door' }) },
                            { name: 'use_door', args: JSON.stringify({ door: 'right_door' }) },
                            { name: 'done', args: '{}' }
                        ])
                    }
                    : { content: 'Enough.', toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: 'Enough.' } };
            }
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(result.doors).toHaveLength(2);
        expect(result.doors[0]).toMatchObject({ actionName: 'use_door', queued: true, success: true });
        expect(result.doors[1]).toMatchObject({ actionName: 'use_door', success: false, detail: 'max world actions per round reached (1)' });
        expect(turns.queued).toHaveLength(1);
    });
});

// =========================================================================
// CRAFTING (Feature C, spec §6.3 — data-driven recipe crafting via the
// `craft` tool + `get_crafts` discovery). Everything external is mocked as
// with the rest of the file: the LLM stub is scripted, and the world facade
// exposes getCraftingRecipes / getEntityItems / craftItems the way the real
// WorldStateController would. The model names ingredients by type+quantity
// and the destination componentId (the outputs' destination — inputs may
// be pooled on any of the entity's components); the server resolves the
// concrete item instances.
// =========================================================================

describe('crafting (craft + get_crafts tools)', () => {
    // The crafting NPC carries a hand component (the output component). It has
    // no `npcConfig`/registry entry (the unregisteredDroid fallback path), so
    // maxActions defaults to 2 (DEFAULT_MAX_WORLD_ACTIONS_PER_ROUND).
    const CRAFT_NPC_ID = NPC_ID;

    const CRAFT_RECIPES = [
        {
            id: 'knife_to_t1',
            name: 'T1 Assembly',
            description: 'Forge one knife into a T1 container weapon.',
            inputs: [{ type: 'knife', quantity: 1 }],
            outputs: [{ type: 't1', quantity: 1 }]
        },
        {
            id: 't1_to_coal',
            name: 'T1 to Coal',
            description: 'Salvage a T1 into a chunk of coal fuel.',
            inputs: [{ type: 't1', quantity: 1 }],
            outputs: [{ type: 'coal', quantity: 1 }]
        }
    ];

    function makeCraftWorld({ items = {}, recipes = CRAFT_RECIPES, craftItemsResult = null, maxActions = 2 } = {}) {
        const craftCalls = [];
        const npc = {
            ...NPC,
            components: [
                { id: 'comp-hand-1', type: 'hand' },
                { id: 'comp-core-1', type: 'centralBall' }
            ],
            npcConfig: { maxWorldActionsPerRound: maxActions }
        };
        const world = makeWorld({ canExecute: { selfHeal: [] } });
        world.getEntity = () => npc;
        world.getRooms = () => ({ 'room-main': { name: 'Main Room' } });
        world.getCraftingRecipes = () => recipes;
        world.getEntityItems = () => items;
        world.craftItems = (entityId, recipeId, componentId, itemIds) => {
            craftCalls.push({ entityId, recipeId, componentId, itemIds });
            if (craftItemsResult) {
                return craftItemsResult;
            }
            return {
                success: true,
                recipeId,
                consumed: [...itemIds],
                produced: [{ id: 'item-t1-1', type: 't1' }]
            };
        };
        world.__craftCalls = craftCalls;
        return world;
    }

    function craftArgs({ recipeId, ingredients, componentId, malformed } = {}) {
        // Return raw argument JSON for a well-formed craft call, or a broken
        // payload when `malformed` is requested.
        if (malformed) {
            return malformed;
        }
        return JSON.stringify({ recipeId, ingredients, componentId });
    }

    function craftMessage({ recipeId, ingredients, componentId, malformed, doneNote }) {
        const calls = [{
            name: 'craft',
            args: malformed ?? craftArgs({ recipeId, ingredients, componentId })
        }];
        if (doneNote !== undefined) {
            calls.push({ name: 'done', args: JSON.stringify({ note: doneNote }) });
        }
        return toolMessage(calls);
    }

    it('dispatches a valid craft: server resolves the ingredient instance and reports success (spec §6.3)', async () => {
        const world = makeCraftWorld({
            items: {
                'comp-hand-1': [
                    { id: 'item-knife-1', type: 'knife', hostVolume: 2 },
                    { id: 'item-knife-2', type: 'knife', hostVolume: 2 }
                ]
            },
            craftItemsResult: {
                success: true,
                recipeId: 'knife_to_t1',
                consumed: ['item-knife-1'],
                produced: [{ id: 'item-t1-1', type: 't1' }]
            }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: craftMessage({
                    recipeId: 'knife_to_t1',
                    ingredients: [{ type: 'knife', quantity: 1 }],
                    componentId: 'comp-hand-1',
                    doneNote: 'Forged a T1.'
                })
            })
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        // The server picked the first knife on comp-hand-1 to consume.
        const craftCalls = world.__craftCalls;
        expect(craftCalls).toHaveLength(1);
        expect(craftCalls[0]).toEqual({
            entityId: CRAFT_NPC_ID,
            recipeId: 'knife_to_t1',
            componentId: 'comp-hand-1',
            itemIds: ['item-knife-1']
        });

        expect(result.crafts).toHaveLength(1);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_to_t1', success: true });
        expect(result.crafts[0].detail).toBe(
            'crafted knife_to_t1 (consumed [item-knife-1], produced 1 item)'
        );
        expect(result.done).toBe(true);
        expect(result.note).toBe('done');
        expect(result.iterations).toBe(1);
        expect(result.error).toBeNull();
    });

    it('dispatches a multi-ingredient recipe with multiple input types', async () => {
        // Use a two-type recipe to exercise multi-type instance selection. We
        // override the recipe so it has two inputs.
        const twoInput = [
            {
                id: 'knife_generator',
                name: 'Knife Generator',
                description: 'Forge coal + knife into a generator.',
                inputs: [
                    { type: 'knife', quantity: 1 },
                    { type: 'coal', quantity: 2 }
                ],
                outputs: [{ type: 'knifeGenerator', quantity: 1 }]
            }
        ];
        const world = makeCraftWorld({
            recipes: twoInput,
            items: {
                'comp-hand-1': [
                    { id: 'item-knife-1', type: 'knife', hostVolume: 2 },
                    { id: 'item-coal-1', type: 'coal', hostVolume: 1 },
                    { id: 'item-coal-2', type: 'coal', hostVolume: 1 },
                    { id: 'item-coal-3', type: 'coal', hostVolume: 1 }
                ]
            }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: craftMessage({
                    recipeId: 'knife_generator',
                    ingredients: [{ type: 'knife', quantity: 1 }, { type: 'coal', quantity: 2 }],
                    componentId: 'comp-hand-1',
                    doneNote: 'Built the generator.'
                })
            })
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        expect(world.__craftCalls).toHaveLength(1);
        // First knife, then the two earliest coal instances.
        expect(world.__craftCalls[0].itemIds).toEqual(['item-knife-1', 'item-coal-1', 'item-coal-2']);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_generator', success: true });
    });

    it('crafts from split components: knife on comp-core-1, destination comp-hand-1 (cross-component)', async () => {
        const world = makeCraftWorld({
            // The knife is hosted on the centralBall (comp-core-1), while
            // the craft names the hand as the outputs' destination — inputs
            // may be pooled on any of the entity's components.
            items: {
                'comp-core-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }]
            }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 1 }],
                componentId: 'comp-hand-1'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        expect(world.__craftCalls).toHaveLength(1);
        expect(world.__craftCalls[0]).toEqual({
            entityId: CRAFT_NPC_ID,
            recipeId: 'knife_to_t1',
            componentId: 'comp-hand-1',
            itemIds: ['item-knife-1']
        });
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_to_t1', success: true });
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    // On the first LLM call, return `firstMessage`; on every later call
    // return a plain done (the model is shown the failure feedback and
    // gives up, exactly like the unknown-action parity test). This is a
    // deterministic "try once, then stop" stub so a rejected craft does not
    // spin the loop to the iteration budget.
    function tryOnceThenStop(firstMessage) {
        let n = 0;
        return () => {
            n += 1;
            if (n === 1) {
                return { content: null, toolCalls: [], finishReason: 'tool_calls', message: firstMessage };
            }
            return { content: null, toolCalls: [], finishReason: 'tool_calls', message: toolMessage([{ name: 'done', args: '{}' }]) };
        };
    }

    it('rejects an unknown recipe id and feeds the error back for one retry (spec §6.8 unknown-action parity)', async () => {
        const world = makeCraftWorld({
            items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'ghost_recipe',
                ingredients: [{ type: 'knife', quantity: 1 }],
                componentId: 'comp-hand-1'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        // Model tried the bad recipe once; pre-validation rejected it before
        // any dispatch, so craftItems was never called.
        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts).toHaveLength(1);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'ghost_recipe', success: false });
        expect(result.crafts[0].detail).toBe('unknown recipe "ghost_recipe"');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('rejects an ingredient multiset that does not match the recipe exactly (extra type)', async () => {
        const world = makeCraftWorld({
            items: {
                'comp-hand-1': [
                    { id: 'item-knife-1', type: 'knife', hostVolume: 2 },
                    { id: 'item-coal-1', type: 'coal', hostVolume: 1 }
                ]
            }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 1 }, { type: 'coal', quantity: 1 }],
                componentId: 'comp-hand-1'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        // Model tried once with a wrong multiset; rejected before dispatch.
        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts).toHaveLength(1);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_to_t1', success: false });
        expect(result.crafts[0].detail).toBe(
            'ingredients do not match recipe "knife_to_t1": extra coal x1 (not in recipe "knife_to_t1")'
        );
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('rejects a wrong ingredient quantity (over-supplied vs. under-supplied)', async () => {
        // Over-supplied: recipe needs knife x1, model says knife x3.
        const world = makeCraftWorld({
            items: {
                'comp-hand-1': [
                    { id: 'item-knife-1', type: 'knife', hostVolume: 2 },
                    { id: 'item-knife-2', type: 'knife', hostVolume: 2 },
                    { id: 'item-knife-3', type: 'knife', hostVolume: 2 }
                ]
            }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 3 }],
                componentId: 'comp-hand-1'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts).toHaveLength(1);
        expect(result.crafts[0].success).toBe(false);
        expect(result.crafts[0].detail).toBe(
            'ingredients do not match recipe "knife_to_t1": knife x3 given, recipe needs x1'
        );
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('rejects a component that is not owned by the acting NPC', async () => {
        const world = makeCraftWorld({
            items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 1 }],
                componentId: 'comp-ghost'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_to_t1', success: false });
        expect(result.crafts[0].detail).toBe('component "comp-ghost" not found on entity "ent-npc-0001"');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('rejects when the entity holds no knife on any component (entity-wide held check)', async () => {
        const world = makeCraftWorld({
            // The NPC holds coal on comp-hand-1 and nothing else — no
            // knife on any of the entity's components.
            items: { 'comp-hand-1': [{ id: 'item-coal-1', type: 'coal', hostVolume: 1 }] }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 1 }],
                componentId: 'comp-hand-1'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts[0].success).toBe(false);
        expect(result.crafts[0].detail).toBe('entity "ent-npc-0001" does not hold knife x1 (holds x0)');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('enforces comp- prefix on componentId (id hygiene)', async () => {
        const world = makeCraftWorld({
            items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 1 }],
                componentId: 'item-not-a-comp'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts[0].success).toBe(false);
        expect(result.crafts[0].detail).toBe('invalid id format: componentId="item-not-a-comp"');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('rejects malformed / missing craft arguments', async () => {
        const world = makeCraftWorld({
            items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(
                craftMessage({ recipeId: '', ingredients: [], componentId: 'comp-hand-1', malformed: 'not json at all' })
            )
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts[0].detail).toBe('malformed tool arguments');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('reports a real-world crafting failure from craftItems (e.g. insufficient volume)', async () => {
        const world = makeCraftWorld({
            items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] },
            craftItemsResult: {
                success: false,
                code: 'INSUFFICIENT_VOLUME',
                message: 'Component "comp-hand-1" has 0 free and the craft frees 2 entity-wide, but the outputs need 5.'
            }
        });
        const turns = makeTurns();
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 1 }],
                componentId: 'comp-hand-1'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        // Pre-validation passed, so the real transaction ran (once) and then
        // failed; the model gave up on retry.
        expect(world.__craftCalls).toHaveLength(1);
        expect(world.__craftCalls[0].itemIds).toEqual(['item-knife-1']);
        expect(result.crafts[0].success).toBe(false);
        expect(result.crafts[0].detail).toBe('Component "comp-hand-1" has 0 free and the craft frees 2 entity-wide, but the outputs need 5.');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('respects the turn gate: a craft arriving outside the planning window is dropped (spec §5.8)', async () => {
        const world = makeCraftWorld({
            items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const turns = makeTurns({ phase: 'resolution' });
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: tryOnceThenStop(craftMessage({
                recipeId: 'knife_to_t1',
                ingredients: [{ type: 'knife', quantity: 1 }],
                componentId: 'comp-hand-1'
            }))
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        // No immediate execution and no craftItems call in a closed window.
        expect(world.__craftCalls).toHaveLength(0);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_to_t1', success: false });
        expect(result.crafts[0].detail).toBe('planning window closed');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('counts craft as a world action against the per-round cap', async () => {
        const world = makeCraftWorld({
            maxActions: 1,
            items: {
                'comp-hand-1': [
                    { id: 'item-knife-1', type: 'knife', hostVolume: 2 },
                    { id: 'item-knife-2', type: 'knife', hostVolume: 2 }
                ]
            }
        });
        const turns = makeTurns();
        let callCount = 0;
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => {
                callCount += 1;
                // First response asks for two crafts (one will hit the cap);
                // once the model is fed the cap failure it gives up with done.
                if (callCount >= 2) {
                    return { content: null, toolCalls: [], finishReason: 'tool_calls', message: toolMessage([{ name: 'done', args: '{}' }]) };
                }
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: toolMessage([
                        { name: 'craft', args: JSON.stringify({ recipeId: 'knife_to_t1', ingredients: [{ type: 'knife', quantity: 1 }], componentId: 'comp-hand-1' }) },
                        { name: 'craft', args: JSON.stringify({ recipeId: 'knife_to_t1', ingredients: [{ type: 'knife', quantity: 1 }], componentId: 'comp-hand-1' }) }
                    ])
                };
            }
        });

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        // First craft succeeds and consumes the cap; second is rejected.
        expect(callCount).toBe(2);
        expect(world.__craftCalls).toHaveLength(1);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_to_t1', success: true });
        expect(result.crafts[1]).toMatchObject({ recipeId: 'knife_to_t1', success: false });
        expect(result.crafts[1].detail).toBe('max world actions per round reached (1)');
        expect(result.done).toBe(true);
        expect(result.iterations).toBe(2);
    });

    it('get_crafts discovery feeds the formatted craft list back, so the model crafts from it (spec §6.5)', async () => {
        const world = makeCraftWorld({
            items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife', hostVolume: 2 }] }
        });
        const turns = makeTurns();
        let callCount = 0;
        const seenMessages = [];
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: (messages) => {
                callCount += 1;
                seenMessages.push(JSON.parse(JSON.stringify(messages)));
                // The craft list (formatCraftList) emits '| need ... | gets ... |
                // on <comp>'. That marker is unique to the craft list.
                const hasList = messages.some(
                    (m) => m.role === 'tool' && typeof m.content === 'string'
                        && m.content.includes('| need')
                );
                if (!hasList) {
                    return { content: null, toolCalls: [], finishReason: 'tool_calls', message: toolMessage([{ name: 'get_crafts', args: '{}' }]) };
                }
                return { content: null, toolCalls: [], finishReason: 'tool_calls', message: craftMessage({ recipeId: 'knife_to_t1', ingredients: [{ type: 'knife', quantity: 1 }], componentId: 'comp-hand-1', doneNote: 'Built a T1.' }) };
            }
        });

        // Discovery reads getCraftData (the live craft registry) — the main
        // makeAgent stubs only buildContext, so monkey-patch getCraftData the
        // way the discovery test monkey-patches getActionData.
        agent.llmContextController = {
            buildContext: () => ({ text: '=== ROOM === Main Room' }),
            getCraftData: () => ({
                craftable: [
                    {
                        recipeId: 'knife_to_t1',
                        name: 'T1 Assembly',
                        description: 'Forge one knife into a T1 container weapon.',
                        needs: [{ type: 'knife', quantity: 1 }],
                        outputs: [{ type: 't1', quantity: 1 }],
                        componentId: 'comp-hand-1'
                    },
                    {
                        recipeId: 't1_to_coal',
                        name: 'T1 to Coal',
                        description: 'Salvage a T1 into a chunk of coal.',
                        needs: [{ type: 't1', quantity: 1 }],
                        outputs: [{ type: 'coal', quantity: 1 }],
                        componentId: 'comp-hand-1'
                    }
                ],
                notCraftable: []
            })
        };

        const result = await agent.runRound(CRAFT_NPC_ID, 0);

        // Two LLM calls (discover, then craft) — no spin to the budget cap.
        expect(callCount).toBe(2);
        expect(result.iterations).toBe(2);
        expect(world.__craftCalls).toHaveLength(1);
        expect(world.__craftCalls[0].itemIds).toEqual(['item-knife-1']);
        expect(result.crafts[0]).toMatchObject({ recipeId: 'knife_to_t1', success: true });
        expect(result.done).toBe(true);
        expect(result.error).toBeNull();

        // The second call's conversation must carry the craft discovery result:
        // a tool-role result for get_crafts whose content includes the formatted
        // craft list (craftable lines + not-craftable summary).
        const discovery = seenMessages[1];
        const assistantReplay = discovery.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
        expect(assistantReplay).toBeTruthy();
        expect(assistantReplay.tool_calls.map((t) => t.function.name)).toEqual(['get_crafts']);
        const craftTool = discovery.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
        expect(craftTool).toBeTruthy();
        const payload = JSON.parse(craftTool.content);
        expect(payload.success).toBe(true);
        expect(typeof payload.list).toBe('string');
        const list = payload.list;
        expect(list).toContain('- T1 Assembly (knife_to_t1)');
        expect(list).toContain('- T1 to Coal (t1_to_coal)');
        expect(list).toContain('| need knife x1 | gets t1 x1 | on comp-hand-1');
    });
});

// =========================================================================
// AGENT VIEW INSPECTOR — describeAgentView transcript history. The dev tab
// exposes EVERY stored round (capped by LLM_AGENT_VIEW_HISTORY_ROUNDS),
// each with all of its in-round LLM calls (the loop's subcalls) + per-call
// results. The model's replay stays at the last LLM_REPLAY_ROUNDS rounds
// (spec §6.5, raised from 2 per owner request) no matter how deep the
// inspector window is.
// =========================================================================

describe('describeAgentView — transcript history (all rounds + subcalls)', () => {

    it('exposes every stored round with all in-round LLM calls and per-call results', async () => {
        const world = makeWorld({ canExecute: { selfHeal: ['comp-head-1'], move: [], cut: [] } });
        const turns = makeTurns();
        let callCount = 0;
        const { agent } = makeAgent({
            world,
            turns,
            chatFullImpl: () => {
                callCount += 1;
                if (callCount === 1) {
                    // Round 1, call 1: a world action plus done (ends the round).
                    return {
                        content: 'I will fix myself.',
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: 'I will fix myself.',
                            tool_calls: [
                                { id: 'call_1', type: 'function', function: { name: 'execute_action', arguments: '{"actionName":"selfHeal"}' } },
                                { id: 'call_2', type: 'function', function: { name: 'done', arguments: '{}' } }
                            ]
                        }
                    };
                }
                if (callCount === 2) {
                    // Round 2, call 1: discovery only — the loop continues.
                    return {
                        content: null,
                        toolCalls: [],
                        finishReason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'get_actions', arguments: '{}' } }]
                        }
                    };
                }
                // Round 2, call 2: speak + done ends the round.
                return {
                    content: null,
                    toolCalls: [],
                    finishReason: 'tool_calls',
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            { id: 'call_4', type: 'function', function: { name: 'speak_in_room', arguments: '{"message":"round two here"}' } },
                            { id: 'call_5', type: 'function', function: { name: 'done', arguments: '{}' } }
                        ]
                    }
                };
            }
        });
        // get_actions reads the live action list from the context controller
        // (same monkey-patch as the discovery round test).
        agent.llmContextController = {
            buildContext: () => ({ text: '=== ROOM === Main Room' }),
            getActionData: () => ({
                entries: [
                    { name: 'selfHeal', description: 'self-repair', range: 0, canExecute: ['comp-head-1'], requirement: '' },
                    { name: 'move', description: 'walk', range: 100, canExecute: [], requirement: '' }
                ],
                notExecutable: []
            })
        };

        await agent.runRound(NPC_ID, 1);
        await agent.runRound(NPC_ID, 2);

        const view = agent.describeAgentView(NPC_ID);
        expect(view.transcriptRounds).toHaveLength(2);

        const r1 = view.transcriptRounds[0];
        expect(r1.round).toBe(1);
        expect(r1.note).toBe('done');
        expect(r1.error).toBeNull();
        expect(r1.groups).toHaveLength(1);
        expect(r1.groups[0].content).toBe('I will fix myself.');
        expect(r1.groups[0].tool_calls.map((c) => c.function.name)).toEqual(['execute_action', 'done']);
        expect(r1.groups[0].results).toHaveLength(1);
        expect(r1.groups[0].results[0].success).toBe(true);

        const r2 = view.transcriptRounds[1];
        expect(r2.round).toBe(2);
        expect(r2.note).toBe('done');
        expect(r2.groups).toHaveLength(2);
        expect(r2.groups[0].tool_calls.map((c) => c.function.name)).toEqual(['get_actions']);
        expect(r2.groups[0].results).toHaveLength(1);
        expect(r2.groups[0].results[0].success).toBe(true);
        expect(r2.groups[0].results[0].list).toContain('selfHeal');
        expect(r2.groups[1].tool_calls.map((c) => c.function.name)).toEqual(['speak_in_room', 'done']);
        expect(r2.groups[1].results[0].success).toBe(true);
        // Context snapshot exposed (decisions/round-anchored-transcript.md):
        // the dev tab shows what each round saw — the live buildContext
        // stub for this describe, not the global default.
        expect(r1.context).toBe('=== ROOM === Main Room');
        expect(r2.context).toBe('=== ROOM === Main Room');
    });

    it('caps the transcript buffer at LLM_AGENT_VIEW_HISTORY_ROUNDS while the replay stays at the last LLM_REPLAY_ROUNDS rounds (spec §6.5)', () => {
        const CAP = LLM_AGENT_VIEW_HISTORY_ROUNDS;
        const REPLAY = LLM_REPLAY_ROUNDS;
        const { agent } = makeAgent({
            chatFullImpl: () => ({
                content: 'unused', toolCalls: [], finishReason: 'stop',
                message: { role: 'assistant', content: 'unused' }
            })
        });

        // The buffer is filled directly rather than by running CAP+2 real
        // rounds. With both windows at 10000 (owner request, 2026-11-01) the
        // old shape ran 10002 rounds through context + tools + instincts to
        // prove a slice - minutes of suite time. What is pinned here is the
        // window mechanics; the round runner's use of the replay tail is pinned
        // by the round tests above, at a depth that costs nothing.
        for (let r = 1; r <= CAP + 2; r += 1) {
            const callId = `call-${r}`;
            agent._storeTranscript(NPC_ID, r, {
                note: 'done',
                groups: [{
                    assistant: {
                        role: 'assistant',
                        content: `thought ${r}`,
                        tool_calls: [{ id: callId, type: 'function', function: { name: 'done', arguments: '{}' } }]
                    },
                    results: [{ id: callId, success: true }]
                }]
            });
        }

        // The buffer cap is the only memory bound an NPC has: rounds 1 and 2 are
        // gone, the tail is the newest, the inspector sees exactly CAP.
        const view = agent.describeAgentView(NPC_ID);
        expect(view.transcriptRounds).toHaveLength(CAP);
        expect(view.transcriptRounds[0].round).toBe(3);
        expect(view.transcriptRounds[CAP - 1].round).toBe(CAP + 2);

        // The replay is the tail of that SAME buffer (spec §6.5), oldest
        // first: one user anchor + one assistant + one tool message per stored
        // round. It is a COUNT, not a size budget - nothing here is shed by
        // length - and REPLAY > CAP can only ever return what is stored.
        const replay = agent._transcriptFor(NPC_ID);
        const userReplays = replay.filter((m) => m.role === 'user');
        const assistantReplays = replay.filter((m) => m.role === 'assistant');
        const toolReplays = replay.filter((m) => m.role === 'tool');
        const expected = Math.min(REPLAY, CAP);
        expect(assistantReplays).toHaveLength(expected);
        expect(toolReplays).toHaveLength(expected);
        // Round anchoring: one user message per stored round. These legacy
        // entries carry no context snapshot, so the anchor is the round number
        // alone.
        expect(userReplays).toHaveLength(expected);
        expect(userReplays[0].content).toBe(`round ${CAP + 2 - (expected - 1)}`);
        expect(userReplays.at(-1).content).toBe(`round ${CAP + 2}`);
        expect(assistantReplays[0].content).toBe(`thought ${CAP + 2 - (expected - 1)}`);
        expect(assistantReplays.at(-1).content).toBe(`thought ${CAP + 2}`);
    });
});

// =========================================================================
// describeAgentView.lastRequest — the request exactly as it went out
// =========================================================================

describe('describeAgentView.lastRequest — exactly what was sent to the LLM', () => {

    /**
     * An agent whose mock provider records every request it is handed. The clone
     * is taken at hand-off: runRound appends to that very array after the call
     * returns, so holding the reference would record the future instead of what
     * was sent.
     */
    function recordingAgent() {
        const sent = [];
        let call = 0;
        const { agent } = makeAgent({
            world: makeWorld({ canExecute: { selfHeal: ['comp-head-1'], move: [], cut: [] } }),
            turns: makeTurns(),
            chatFullImpl: (messages) => {
                sent.push(structuredClone(messages));
                call += 1;
                // Two calls per round: a discovery call, then done. The
                // discovery call keeps the loop running, so the second request
                // of the round carries the first call's feedback.
                const name = call % 2 === 1 ? 'get_actions' : 'done';
                const message = toolMessage([{ name, args: '{}' }]);
                return { content: message.content, toolCalls: [], finishReason: 'tool_calls', message };
            }
        });
        // get_actions needs the discovery surface (same patch as the discovery test).
        agent.llmContextController = {
            buildContext: () => ({ text: '=== ROOM === Main Room' }),
            getActionData: () => ({
                entries: [{ name: 'move', description: 'walk', range: 100, canExecute: [], requirement: '' }],
                notExecutable: []
            })
        };
        return { agent, sent };
    }

    it('is null before anything has been sent, and for an unknown agent', async () => {
        const { agent, sent } = recordingAgent();
        expect(agent.describeAgentView(NPC_ID).lastRequest).toBeNull();
        await agent.runRound(NPC_ID, 1);
        expect(sent).toHaveLength(2);
        expect(agent.describeAgentView('ent-never-seen-0000').lastRequest).toBeNull();
    });

    it('equals, message for message, the array the provider received last', async () => {
        const { agent, sent } = recordingAgent();
        await agent.runRound(NPC_ID, 1);
        await agent.runRound(NPC_ID, 2);
        await agent.runRound(NPC_ID, 3);

        const view = agent.describeAgentView(NPC_ID);
        expect(view.lastRequest.round).toBe(3);
        // The pin. Round 3 sent two requests; the LAST one carried the replay of
        // rounds 1 and 2, the `round 3` anchor, and the feedback of the first
        // call. Rebuilt from stored state, it must be the array itself — the
        // inspector is not allowed to show a story about the prompt.
        expect(view.lastRequest.messages).toEqual(sent.at(-1));
        // Non-triviality of the pin above: replay of two rounds, the anchor, and
        // the in-round feedback (assistant + tool result + nudge) must all be in
        // there — a one-message array would satisfy an empty comparison.
        expect(sent.at(-1).length).toBeGreaterThan(6);
        expect(sent.at(-1).filter((m) => m.role === 'tool').length).toBeGreaterThanOrEqual(3);
    });

    it('replays the earlier rounds and anchors the one that was sent', async () => {
        const { agent } = recordingAgent();
        await agent.runRound(NPC_ID, 1);
        await agent.runRound(NPC_ID, 2);

        const messages = agent.describeAgentView(NPC_ID).lastRequest.messages;
        const users = messages.filter((m) => m.role === 'user');
        // One anchor per replayed round plus the nudge the loop appended inside
        // round 2 — and the anchors are the round-anchored form, delimiters kept.
        expect(users[0].content).toBe('round 1\n\n=== ROOM === Main Room');
        expect(users[1].content).toBe('round 2\n\n=== ROOM === Main Room');
        // system and tools ride along, recomputed at view time.
        const view = agent.describeAgentView(NPC_ID);
        expect(view.lastRequest.system).toBe(view.systemPrompt);
        expect(Array.isArray(view.lastRequest.tools)).toBe(true);
        expect(view.lastRequest.tools.length).toBeGreaterThan(0);
    });
});

// =========================================================================
// EQUIP / UNEQUIP (the equip_item and unequip_item tools). One pair covers
// carried gear AND clothing: a worn item IS an equipped entry (WearLogic), so
// the equip tool dispatches a wearable type through the clothes fit rule and
// the unequip tool takes it off with the same call that removes a knife.
// =========================================================================

describe('equip_item / unequip_item tools (gear and clothing, one pair)', () => {
    // The item registry shape WearLogic reads: only the t-shirt declares
    // `wear.minVolume`, so only the t-shirt is wearable.
    const EQUIP_ITEM_DEFS = {
        knife: { name: 'Knife' },
        tshirt: { name: 'T-Shirt', wear: { minVolume: 2 } }
    };

    /**
     * A world whose NPC carries a knife and a t-shirt on comp-hand-1, with the
     * three facade doors recorded so the routing (which door was knocked on,
     * with which resolved instance) is what the assertions read.
     */
    function makeEquipWorld({
        items = { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife' }, { id: 'item-tshirt-1', type: 'tshirt' }] },
        equipped = [],
        maxActions = 2,
        equipResult = { success: true },
        wearResult = null,
        unequipResult = { success: true }
    } = {}) {
        const npc = {
            ...NPC,
            components: [{ id: 'comp-hand-1', type: 'hand' }, { id: 'comp-core-1', type: 'centralBall' }],
            npcConfig: { maxWorldActionsPerRound: maxActions }
        };
        const world = makeWorld();
        world.getEntity = () => npc;
        world.getItemRegistry = () => EQUIP_ITEM_DEFS;
        world.getEntityItems = () => items;

        // The equipped set is mutable state: unequipping drops the entry, so a
        // test can assert the clothing really came off.
        const worn = [...equipped];
        world.getEquippedItems = () => worn.map((eq) => ({ ...eq }));
        const equipCalls = [];
        const wearCalls = [];
        const unequipCalls = [];
        world.equipItem = (entityId, itemId, itemType, componentId) => {
            equipCalls.push({ entityId, itemId, itemType, componentId });
            return equipResult;
        };
        world.wearItem = (entityId, itemId, componentId) => {
            wearCalls.push({ entityId, itemId, componentId });
            return wearResult ?? {
                success: true,
                message: `Wore "T-Shirt" on Hand (${componentId}).`
            };
        };
        world.unequipItem = (entityId, lookupId) => {
            unequipCalls.push({ entityId, lookupId });
            const idx = worn.findIndex((eq) => eq.eqId === lookupId || eq.itemId === lookupId);
            if (idx >= 0) worn.splice(idx, 1);
            return unequipResult;
        };
        world.__equipCalls = equipCalls;
        world.__wearCalls = wearCalls;
        world.__unequipCalls = unequipCalls;
        return world;
    }

    /** One equip_item / unequip_item call, then done (the round ends at once). */
    function equipMessage(name, args, doneNote = 'Done.') {
        return toolMessage([
            { name, args: JSON.stringify(args) },
            { name: 'done', args: JSON.stringify({ note: doneNote }) }
        ]);
    }

    async function runEquip(world, message, turns = makeTurns()) {
        const { agent } = makeAgent({ world, turns, chatFullImpl: () => ({
            content: null, toolCalls: [], finishReason: 'tool_calls', message
        }) });
        return { agent, result: await agent.runRound(NPC_ID, 0) };
    }

    it('equips a carried knife through the holding-cost door (facade.equipItem)', async () => {
        const world = makeEquipWorld();
        const { result } = await runEquip(world, equipMessage('equip_item', {
            itemType: 'knife',
            componentId: 'comp-hand-1'
        }));

        // The server resolved WHICH knife (the model never names an item id):
        // the first carried instance of the type on that component.
        expect(world.__equipCalls).toEqual([{
            entityId: NPC_ID,
            itemId: 'item-knife-1',
            itemType: 'knife',
            componentId: 'comp-hand-1'
        }]);
        expect(world.__wearCalls).toHaveLength(0);
        expect(result.equips).toHaveLength(1);
        expect(result.equips[0]).toMatchObject({
            itemType: 'knife',
            itemId: 'item-knife-1',
            componentId: 'comp-hand-1',
            wearable: false,
            success: true
        });
        expect(result.equips[0].detail).toBe('equipped "knife" on comp-hand-1');
        expect(result.done).toBe(true);
    });

    it('wears a carried t-shirt through the clothes fit rule (facade.wearItem, never equipItem)', async () => {
        const world = makeEquipWorld();
        const { result } = await runEquip(world, equipMessage('equip_item', {
            itemType: 'tshirt',
            componentId: 'comp-hand-1'
        }));

        // The one tool the agent has for gear is also the clothing tool: a
        // wearable type goes to WearLogic (which owns the free-volume fit), and
        // NOT to the plain equip — otherwise the fit rule would be bypassed.
        expect(world.__wearCalls).toEqual([{
            entityId: NPC_ID,
            itemId: 'item-tshirt-1',
            componentId: 'comp-hand-1'
        }]);
        expect(world.__equipCalls).toHaveLength(0);
        expect(result.equips[0]).toMatchObject({
            itemType: 'tshirt',
            itemId: 'item-tshirt-1',
            wearable: true,
            success: true
        });
        // The world's own line is what the model gets back.
        expect(result.equips[0].detail).toBe('Wore "T-Shirt" on Hand (comp-hand-1).');
    });

    it('takes a WORN t-shirt off with unequip_item (a worn item is an equipped entry)', async () => {
        const world = makeEquipWorld({
            equipped: [{ eqId: 'eq-tshirt-1', itemId: 'item-tshirt-1', itemType: 'tshirt', componentId: 'comp-hand-1' }]
        });
        const { result } = await runEquip(world, equipMessage('unequip_item', { itemType: 'tshirt' }));

        // Keyed by the typed eqId, which names the instance unambiguously.
        expect(world.__unequipCalls).toEqual([{ entityId: NPC_ID, lookupId: 'eq-tshirt-1' }]);
        expect(result.unequips[0]).toMatchObject({
            itemType: 'tshirt',
            itemId: 'item-tshirt-1',
            componentId: 'comp-hand-1',
            wearable: true,
            success: true
        });
        expect(result.unequips[0].detail).toBe('took "tshirt" off comp-hand-1');
        expect(world.getEquippedItems(NPC_ID)).toHaveLength(0);
    });

    it('rejects a type the named component does not carry — no world call', async () => {
        const world = makeEquipWorld({ items: { 'comp-hand-1': [{ id: 'item-knife-1', type: 'knife' }] } });
        const { result } = await runEquip(world, equipMessage('equip_item', {
            itemType: 'tshirt',
            componentId: 'comp-hand-1'
        }));

        expect(world.__wearCalls).toHaveLength(0);
        expect(world.__equipCalls).toHaveLength(0);
        expect(result.equips[0]).toMatchObject({ itemType: 'tshirt', success: false });
        expect(result.equips[0].detail).toBe(
            'no "tshirt" carried on comp-hand-1 (it holds: knife)'
        );
    });

    it('rejects a component that is not the NPC\'s own, and a non comp- id', async () => {
        const foreign = makeEquipWorld();
        const foreignRun = await runEquip(foreign, equipMessage('equip_item', {
            itemType: 'knife',
            componentId: 'comp-ghost-9'
        }));
        expect(foreignRun.result.equips[0].detail).toBe(
            'component "comp-ghost-9" not found on entity "ent-npc-0001"'
        );
        expect(foreign.__equipCalls).toHaveLength(0);

        const untyped = makeEquipWorld();
        const untypedRun = await runEquip(untyped, equipMessage('equip_item', {
            itemType: 'knife',
            componentId: 'hand-1'
        }));
        expect(untypedRun.result.equips[0].detail).toBe('invalid id format: componentId="hand-1"');
        expect(untyped.__equipCalls).toHaveLength(0);
    });

    it('rejects re-wearing what is already worn (idempotent, before the world is asked)', async () => {
        const world = makeEquipWorld({
            equipped: [{ eqId: 'eq-tshirt-1', itemId: 'item-tshirt-1', itemType: 'tshirt', componentId: 'comp-hand-1' }]
        });
        const { result } = await runEquip(world, equipMessage('equip_item', {
            itemType: 'tshirt',
            componentId: 'comp-hand-1'
        }));

        expect(world.__wearCalls).toHaveLength(0);
        expect(result.equips[0]).toMatchObject({ itemType: 'tshirt', success: false });
        expect(result.equips[0].detail).toBe('"tshirt" is already equipped on comp-hand-1');
    });

    it('names what IS equipped when unequip_item asks for a type that is not', async () => {
        const world = makeEquipWorld({
            equipped: [
                { eqId: 'eq-knife-1', itemId: 'item-knife-1', itemType: 'knife', componentId: 'comp-hand-1' },
                { eqId: 'eq-tshirt-1', itemId: 'item-tshirt-1', itemType: 'tshirt', componentId: 'comp-core-1' }
            ]
        });
        const { result } = await runEquip(world, equipMessage('unequip_item', { itemType: 'axe' }));

        expect(world.__unequipCalls).toHaveLength(0);
        expect(result.unequips[0]).toMatchObject({ itemType: 'axe', success: false });
        expect(result.unequips[0].detail).toBe(
            'nothing equipped of type "axe" (equipped: knife, tshirt)'
        );
    });

    it('counts equip and unequip against the per-round world-action budget', async () => {
        const world = makeEquipWorld({ maxActions: 1 });
        const twoEquips = toolMessage([
            { name: 'equip_item', args: JSON.stringify({ itemType: 'knife', componentId: 'comp-hand-1' }) },
            { name: 'equip_item', args: JSON.stringify({ itemType: 'tshirt', componentId: 'comp-hand-1' }) }
        ]);
        // One call with both equip calls in it, then done — so the round ends
        // on the capped second call instead of spinning on it.
        let calls = 0;
        const { agent } = makeAgent({
            world,
            turns: makeTurns(),
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: (calls += 1) === 1 ? twoEquips : toolMessage([{ name: 'done', args: '{}' }])
            })
        });

        const result = await agent.runRound(NPC_ID, 0);

        expect(world.__equipCalls).toHaveLength(1);
        expect(world.__wearCalls).toHaveLength(0);
        expect(result.equips).toHaveLength(2);
        expect(result.equips[1]).toMatchObject({
            itemType: 'tshirt',
            success: false,
            detail: 'max world actions per round reached (1)'
        });
    });

    it('drops both calls outside the planning window of a turn world (no immediate execution)', async () => {
        const world = makeEquipWorld({
            equipped: [{ eqId: 'eq-knife-1', itemId: 'item-knife-1', itemType: 'knife', componentId: 'comp-hand-1' }]
        });
        const { result } = await runEquip(world, toolMessage([
            { name: 'equip_item', args: JSON.stringify({ itemType: 'tshirt', componentId: 'comp-hand-1' }) },
            { name: 'unequip_item', args: JSON.stringify({ itemType: 'knife' }) }
        ]), makeTurns({ phase: 'resolution' }));

        expect(world.__wearCalls).toHaveLength(0);
        expect(world.__unequipCalls).toHaveLength(0);
        expect(result.equips[0]).toMatchObject({ success: false, detail: 'planning window closed' });
        expect(result.unequips[0]).toMatchObject({ success: false, detail: 'planning window closed' });
    });

    it('offers equip_item and unequip_item to the model, clothing included in their descriptions', () => {
        const tools = makeAgent({ world: makeEquipWorld() }).agent._buildTools();
        const equip = tools.find((t) => t.function.name === 'equip_item');
        const unequip = tools.find((t) => t.function.name === 'unequip_item');

        expect(equip.function.parameters.required).toEqual(['itemType', 'componentId']);
        expect(unequip.function.parameters.required).toEqual(['itemType']);
        // The user-facing contract of this change: the item tools ARE the
        // clothing tools, so a model that only ever dresses itself needs no
        // second pair.
        expect(equip.function.description).toMatch(/CLOTHING/i);
        expect(unequip.function.description).toMatch(/CLOTHING/i);
    });

    it('replays the world\'s own outcome line to the model next round', async () => {
        const world = makeEquipWorld();
        const { agent } = makeAgent({
            world,
            turns: makeTurns(),
            chatFullImpl: () => ({
                content: null,
                toolCalls: [],
                finishReason: 'tool_calls',
                message: equipMessage('equip_item', { itemType: 'tshirt', componentId: 'comp-hand-1' })
            })
        });
        await agent.runRound(NPC_ID, 0);

        const rounds = agent.describeAgentView(NPC_ID).transcriptRounds;
        const results = rounds[0].groups[0].results;
        expect(results[0]).toMatchObject({ success: true, detail: 'Wore "T-Shirt" on Hand (comp-hand-1).' });
    });
});

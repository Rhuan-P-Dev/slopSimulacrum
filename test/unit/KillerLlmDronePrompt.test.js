/**
 * LLMAgentController._buildSystemPrompt — objective rendering and the
 * byte-identical no-objective regression guard
 * (design spec §6.2 / §9.2, plans/killer_llm_drone_design.md).
 *
 * Convention (mirrors test/unit/LLMAgentController.test.js): everything external
 * is mocked (hand-built facade stubs + a scripted chatFull). The agent is
 * constructed with a DataLoader mock serving a fixture data/entities/npcs.json whose
 * entries are verbatim copies of the production registry entries this test
 * was written against (the killerLlmDrone entry WITH an objective; the
 * historical smallBallDroid "Rogue Droid" entry WITHOUT one — that entry was
 * later removed from the shipped data/entities/npcs.json, so the fixture keeps the
 * no-objective regression guard independent of the live registry). The system
 * prompt is captured from the `options` object of the LLM call `runRound`
 * issues — exactly what the production model receives.
 *
 * The scripted LLM answer is prose only (no tool calls), so each round
 * completes after a single iteration without dispatching anything.
 *
 * @module test/unit/KillerLlmDronePrompt
 */

import { describe, it, expect, vi } from 'vitest';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';

const DRONE_ID = 'ent-drone-0001';
const ROGUE_ID = 'ent-rogue-0001';
const ROOM_ID = 'room-main';
const ROOM_NAME = 'Main Room';

/**
 * The exact objective string as persisted in the production registry entry
 * (data/entities/npcs.json → killerLlmDrone). The rendering assertion compares against
 * this constant, so the Objective: line must carry the data's string verbatim.
 */
const DRONE_OBJECTIVE = 'Attack all other entities: each round, strike the nearest entity you can reach; when nothing is in range, move toward the nearest one. Never help, never idle while a target is reachable.';

// =========================================================================
// Fixture registry (verbatim copies of the production data/entities/npcs.json entries
// this test was written against — the live file no longer carries the
// smallBallDroid "Rogue Droid" entry, which was removed from the world)
// =========================================================================

const FIXTURE_NPCS = {
    killerLlmDrone: {
        displayName: 'Killer LLM Drone',
        room: 'start_room',
        personality: 'A cold, relentless hunter. It does not hesitate, does not warn, and does not stop.',
        objective: DRONE_OBJECTIVE,
        maxWorldActionsPerRound: 2,
        maxChatMessagesPerRound: 0,
        envGate: 'KILLER_LLM_DRONE_ENABLED',
        initialItems: [
            { item: 't1', count: 1, equip: true, contents: [{ item: 'knife', count: 10 }] },
            { item: 'knife', count: 1, equip: true }
        ]
    },
    smallBallDroid: {
        displayName: 'Rogue Droid',
        room: 'start_room',
        personality: 'A rogue combat droid that hunts anything that moves in its room.',
        ai: { behavior: 'chase_attack' }
    }
};

// =========================================================================
// Top-level DataLoader mock (hoisted by vitest)
// =========================================================================

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');
    const realDefault = actual.default || {};

    return {
        default: {
            loadJsonSafe(path, defaultValue) {
                if (path === 'data/entities/npcs.json') {
                    return FIXTURE_NPCS;
                }
                // Delegate all other paths to the real DataLoader
                if (realDefault.loadJsonSafe) {
                    return realDefault.loadJsonSafe(path, defaultValue);
                }
                return defaultValue;
            }
        }
    };
});

/**
 * The current PROTOCOL B no-objective system prompt, rendered for the
 * fixture smallBallDroid registry entry (verbatim copy of the historical
 * production entry — no objective → default caps 2/1) in room "Main Room".
 * This is the byte-identical regression target: any template change that
 * affects objective-less NPCs must fail this test.
 *
 * PROTOCOL B (spec §6.2/§6.3/§6.4): the native tool call is the ONLY
 * response protocol — no JSON-in-content block, and tool_choice is "auto"
 * (never "required": the dual mode that produced the scaffold-loop
 * incident). Silence is legal.
 */
const NO_OBJECTIVE_PROMPT = [
    `You are Rogue Droid, an NPC droid in the room "${ROOM_NAME}".`,
    'Personality: A rogue combat droid that hunts anything that moves in its room.',
    '',
    'World rules:',
    "- You are the only actor: you never choose another entity's ID as the acting entity.",
    '- Execute at most 2 world action(s) and send at most 1 chat message(s) per round.',
    '- Only use actions listed under "executable now" in the context. If none fit your goals, stay silent.',
    '- You may call use_instinct to perform a whole behavior (e.g. chase and attack) in one call; it is preferred over chaining execute_action calls for the same intent.',
    '- You may call toApproach { targetEntityId: "ent-..." } to move toward an entity in your current room as far as possible this round (one full move step, capped by your movement stat). Name only the target — the server resolves where it is. It does not cross rooms: travel between rooms with move (targetRoomId).',
    '- Keep chat messages under 25 words, in character, no fourth-wall breaks.',
    '',
    'How you respond:',
    '- Act only through the available tools. Never write JSON, code, XML, or tool-call markup in your message text.',
    '- To say something, call the speak_in_room tool with your line as the "message" argument.\n- If nothing is worth doing or saying this round, respond with no tool call and no text. Silence is allowed.'
].join('\n');

/**
 * The LLM-routed drone exactly as _spawnNpcs persists it: the objective plus
 * the action-only caps, and ai: null (no deterministic brain — so
 * runRound's routing guard takes the LLM path for this entity).
 */
const DRONE_ENTITY = {
    id: DRONE_ID,
    name: 'Killer LLM Drone',
    blueprint: 'killerLlmDrone',
    isNPC: true,
    location: ROOM_ID,
    spatial: { x: 50, y: 50 },
    npcConfig: {
        personality: 'A cold, relentless hunter. It does not hesitate, does not warn, and does not stop.',
        objective: DRONE_OBJECTIVE,
        maxWorldActionsPerRound: 2,
        maxChatMessagesPerRound: 0,
        ai: null
    }
};

/**
 * Test double for a LLM-routed NPC whose registry entry declares no objective:
 * the entity carries no deterministic brain (ai: null) so runRound takes the
 * LLM path, while the prompt itself is rendered from the (fixture) registry
 * entry (smallBallDroid — no objective, default caps).
 */
const ROGUE_ENTITY = {
    id: ROGUE_ID,
    name: 'Rogue Droid',
    blueprint: 'smallBallDroid',
    isNPC: true,
    location: ROOM_ID,
    spatial: { x: 50, y: 50 },
    npcConfig: {
        personality: 'A rogue combat droid that hunts anything that moves in its room.',
        ai: null
    }
};

function makeWorld(entity) {
    return {
        getEntity: (id) => (id === entity.id ? entity : null),
        getRooms: () => ({ [ROOM_ID]: { name: ROOM_NAME } }),
        actionController: { getRegistry: () => ({}) },
        stateEntityController: { getAll: () => ({ [entity.id]: entity }) },
        getActionsForEntity: () => ({}),
        executeAction: () => ({ success: true })
    };
}

/**
 * Builds an agent whose scripted chatFull captures the issued options and
 * answers with prose only (no tool calls) — the round completes after one
 * iteration without dispatching anything.
 */
function makeAgent(world) {
    const calls = [];
    const agent = new LLMAgentController({
        llmController: {
            chatFull: async (messages, options) => {
                calls.push({ messages, options });
                return {
                    content: 'Standing still, watching.',
                    toolCalls: [],
                    finishReason: 'stop',
                    message: { role: 'assistant', content: 'Standing still, watching.' }
                };
            }
        },
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

describe('LLMAgentController._buildSystemPrompt — objective rendering (design spec §6.2)', () => {
    it('with an objective: the system prompt carries the Objective: line and the advance-instead-of-silence rule', async () => {
        const { agent, calls } = makeAgent(makeWorld(DRONE_ENTITY));

        const result = await agent.runRound(DRONE_ID, 0);

        expect(result.error).toBeNull();
        expect(calls).toHaveLength(1);
        const system = calls[0].options.system;
        expect(system).toContain(`Objective: ${DRONE_OBJECTIVE}`);
        expect(system).toContain(
            '- Only use actions listed under "executable now" in the context. '
            + 'If you cannot complete your objective this round, take the action that best advances it (e.g., move toward your nearest target). '
            + 'Only stay silent when no action serves your objective.'
        );
        // The legacy idle rule is replaced by the advance rule, not duplicated.
        expect(system).not.toContain('If none fit your goals, stay silent.');
    });

    it('with an objective and chat cap 0: the action-only prompt line applies and speak_in_room is not offered', async () => {
        const { agent, calls } = makeAgent(makeWorld(DRONE_ENTITY));

        const result = await agent.runRound(DRONE_ID, 0);

        expect(result.error).toBeNull();
        // Action-only: the single prose answer cannot be chat for this agent.
        expect(result.chat).toMatchObject({ sent: false });

        const system = calls[0].options.system;
        expect(system).toContain(
            '- Execute at most 2 world action(s) per round. '
            + 'You MUST NOT use the speak_in_room tool or produce any chat output. Your ONLY output must be world actions.'
        );
        expect(system).not.toContain('to talk');
        const toolNames = calls[0].options.tools.map((t) => t.function.name);
        expect(toolNames).toContain('execute_action');
        expect(toolNames).not.toContain('speak_in_room');
    });

    it('without an objective: the system prompt is byte-identical to the PROTOCOL B template (regression guard)', async () => {
        const { agent, calls } = makeAgent(makeWorld(ROGUE_ENTITY));

        const result = await agent.runRound(ROGUE_ID, 0);

        expect(result.error).toBeNull();
        expect(calls).toHaveLength(1);
        // Exact equality: no Objective: line, silence-allowed tail (protocol B),
        // no JSON-in-content protocol, no forced tool choice.
        expect(calls[0].options.system).toBe(NO_OBJECTIVE_PROMPT);
        expect(calls[0].options.tool_choice).toBe('auto');
    });
});

/**
 * LLMAgentController._buildSystemPrompt — the universal Purpose line, the
 * card-declared Objective line, the section layout, and the byte-identical
 * no-objective regression guard (design spec §6.2 / §9.2,
 * plans/killer_llm_drone_design.md; the template's kind, version and
 * universal purpose: wiki/decisions/agent-system-prompt.md).
 *
 * Convention (mirrors test/unit/LLMAgentController.test.js): everything external
 * is mocked (hand-built facade stubs + a scripted chatFull). The agent is
 * constructed with a DataLoader mock serving a fixture data/mods/core-npcs/npcs.json whose
 * entries are verbatim copies of the production registry entries this test
 * was written against (the killerLlmDrone entry WITH an objective; the
 * historical smallBallDroid "Rogue Droid" entry WITHOUT one — that entry was
 * later removed from the shipped data/mods/core-npcs/npcs.json, so the fixture keeps the
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
import LLMAgentController, { PROMPT_KIND, PROMPT_VERSION, UNIVERSAL_PURPOSE } from '../../src/controllers/networking/LLMAgentController.js';

const DRONE_ID = 'ent-drone-0001';
const ROGUE_ID = 'ent-rogue-0001';
const ROOM_ID = 'room-main';
const ROOM_NAME = 'Main Room';

/**
 * The exact objective string as persisted in the production registry entry
 * (data/mods/core-npcs/npcs.json → killerLlmDrone). The rendering assertion compares against
 * this constant, so the Objective: line must carry the data's string verbatim.
 */
const DRONE_OBJECTIVE = 'Attack all other entities: each round, strike the nearest entity you can reach; when nothing is in range, move toward the nearest one. Never help, never idle while a target is reachable.';

// =========================================================================
// Fixture registry (verbatim copies of the production data/mods/core-npcs/npcs.json entries
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

/**
 * The fixture content served for one data path, or `undefined` to fall through to
 * the real seam.
 * @param {string} relativePath
 * @returns {Object|undefined}
 */
function fixtureFor(relativePath) {
    if (relativePath === 'data/mods/core-npcs/npcs.json') return FIXTURE_NPCS;
    return undefined;
}

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');

    // SUBCLASS, never enumerate. Static methods are non-enumerable, so spreading the
    // real seam copies nothing, and a method this mock forgot is not an error - it is
    // a world silently built from nothing. Inheriting keeps every seam method working
    // including ones added later, and the real loadRegistry already routes through the
    // overridden loadJsonSafe below.
    return {
        ...actual,
        default: class FixtureDataLoader extends actual.default {
            // The ModLoader reads package manifests and content with the throwing
            // variant, so both read paths must serve the fixtures.
            static loadJson(relativePath) {
                const fixture = fixtureFor(relativePath);
                return fixture !== undefined ? fixture : super.loadJson(relativePath);
            }

            static loadJsonSafe(relativePath, defaultValue) {
                const fixture = fixtureFor(relativePath);
                return fixture !== undefined ? fixture : super.loadJsonSafe(relativePath, defaultValue);
            }
        }
    };
});

/**
 * The agent-round v1.0.0 system prompt for the fixture smallBallDroid registry
 * entry (verbatim copy of the historical production entry — no objective →
 * default caps 2/1) in room "Main Room". This is the byte-identical
 * regression target: any template change that affects objective-less NPCs
 * must fail this test (or bump PROMPT_VERSION and update this target in the
 * same commit).
 *
 * PROTOCOL B (spec §6.2/§6.3/§6.4): the native tool call is the ONLY
 * response protocol — no JSON-in-content block, and tool_choice is "auto"
 * (never "required": the dual mode that produced the scaffold-loop
 * incident). Silence is legal.
 *
 * (The mixed-mode prompt this file briefly rendered — "Respond with ONE
 * JSON object", "to talk", '"action":"speak"' — is what caused the
 * scaffold-loop incident; it must never come back.)
 */
const NO_OBJECTIVE_PROMPT = [
    `You are Rogue Droid, an NPC droid in the room "${ROOM_NAME}".`,
    'Personality: A rogue combat droid that hunts anything that moves in its room.',
    `Purpose: ${UNIVERSAL_PURPOSE}`,
    '',
    'World rules:',
    "- You are the only actor: you never choose another entity's ID as the acting entity.",
    '- You may issue at most 2 world action call(s) and send at most 1 chat message(s) this round.',
    '- Advance your purpose this round: take the action that best serves it (e.g., move toward an entity with toApproach, or use_instinct for a whole behavior). Stop the round when no action serves it.',
    '',
    'Your tools:',
    '- Discover: start each round with get_actions (and get_instincts when instincts exist, and get_crafts when you want to craft): that is the ONLY source of executable options — issue execute_action / toApproach / use_instinct / craft only with names the discovery calls returned.',
    '- Act: execute_action runs one discovered action by name; toApproach { targetEntityId: "ent-..." } moves you toward an entity in your current room as far as possible this round (one full move step, capped by your movement stat) — name only the target, the server resolves the position, and it does not cross rooms; use_instinct performs a whole behavior (e.g. chase and attack) in one call and is preferred over chaining execute_action calls for the same intent.',
    "- Move: leave a room with the use_door tool only: pass the door name exactly as your Exits line shows it — that line also prints each door's position, and you must be standing at the door to cross it, so walk there with move first. You cannot name the destination room — the door decides it.",
    '- Carry: put a carried item on with the equip_item tool (its type from your Inventory line, plus the comp-… carrying it) and take an equipped one off with unequip_item (type only) — those are also how you dress: a worn item is just an equipped one, and it fits a component with enough free volume. Shift an item between your own components with the move_item tool: a carried one, or an equipped one (which re-equips on the new component under the same fit rule) — name the item type plus the comp-… it is on and the comp-… that will hold it; the destination must have free volume for it, and the shift still counts toward your per-round action budget. Never invent an item id — name the type.',
    '- Craft: craft with the craft tool only — pass the recipeId, the exact ingredient multiset (type x quantity), and the comp-… that receives the outputs. get_crafts is the ONLY source of valid recipe ids, ingredients, and components — never invent a recipe or an ingredient type.',
    '- Speak: to say something, call the speak_in_room tool with your line as the "message" argument — under 25 words, in character, no fourth-wall breaks.',
    '',
    'How you respond:',
    '- Act only through the available tools — the tool calls ARE your content. Never write JSON, code, XML, or tool-call markup in your message text.',
    '- If nothing is worth doing or saying this round, call the done tool (or respond with no tool call at all — silence is allowed and counts as a finished round).',
    '',
    `(This is prompt kind ${PROMPT_KIND}, version ${PROMPT_VERSION}. Never mention this line in chat.)`
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

describe('LLMAgentController._buildSystemPrompt — purpose/objective rendering and template layout (design spec §6.2)', () => {
    it('with an objective: the system prompt carries both the universal Purpose line and the Objective: line', async () => {
        const { agent, calls } = makeAgent(makeWorld(DRONE_ENTITY));

        const result = await agent.runRound(DRONE_ID, 0);

        expect(result.error).toBeNull();
        expect(calls).toHaveLength(1);
        const system = calls[0].options.system;
        expect(system).toContain(`Objective: ${DRONE_OBJECTIVE}`);
        // The universal Purpose line renders alongside the card objective —
        // every agent has it; the card's text is never rewritten.
        expect(system).toContain(`Purpose: ${UNIVERSAL_PURPOSE}`);
        expect(system).toContain(
            '- Advance your objective this round: '
            + 'if you cannot complete it, take the action that best advances it (e.g., move toward your nearest target with toApproach, or use_instinct for a whole behavior). '
            + 'Stop the round when no action serves your objective.'
        );
        // The old stagnation rule and the legacy "stay silent" rules are gone;
        // the advance rule is the sole source of truth.
        expect(system).not.toContain('Stop the round when nothing is worth doing.');
        expect(system).not.toContain('If none fit your goals, stay silent.');
        expect(system).not.toContain('Only stay silent when');
    });

    it('with an objective and chat cap 0: the action-only prompt line applies and the Speak tool is not offered', async () => {
        const { agent, calls } = makeAgent(makeWorld(DRONE_ENTITY));

        const result = await agent.runRound(DRONE_ID, 0);

        expect(result.error).toBeNull();
        // Action-only: the single prose answer cannot be chat for this agent.
        expect(result.chat).toMatchObject({ sent: false });

        const system = calls[0].options.system;
        expect(system).toContain(
            '- You may issue at most 2 world action call(s) this round. '
            + 'You MUST NOT use the speak_in_room tool or produce any chat output.'
        );
        // No Speak bullet when chat is disabled — the tools list only
        // describes the tools the round actually has.
        expect(system).not.toContain('- Speak:');
        expect(system).not.toContain('to talk');
        const toolNames = calls[0].options.tools.map((t) => t.function.name);
        expect(toolNames).toContain('execute_action');
        expect(toolNames).not.toContain('speak_in_room');
    });

    it('without an objective: the system prompt is byte-identical to the v1.0.0 template (regression guard)', async () => {
        const { agent, calls } = makeAgent(makeWorld(ROGUE_ENTITY));

        const result = await agent.runRound(ROGUE_ID, 0);

        expect(result.error).toBeNull();
        expect(calls).toHaveLength(1);
        // Exact equality: the universal Purpose line renders, no Objective:
        // line, the advance rule points at the purpose, silence-allowed tail
        // (protocol B), no JSON-in-content protocol, no forced tool choice.
        expect(calls[0].options.system).toBe(NO_OBJECTIVE_PROMPT);
        expect(calls[0].options.tool_choice).toBe('auto');
    });

    it('states its kind and version on the last line of the system prompt', async () => {
        const { agent, calls } = makeAgent(makeWorld(ROGUE_ENTITY));

        const result = await agent.runRound(ROGUE_ID, 0);

        expect(result.error).toBeNull();
        const system = calls[0].options.system;
        // RP-2: the versioned template names itself, and the version line
        // ends the prompt (nothing may trail it).
        expect(system.endsWith(`(This is prompt kind ${PROMPT_KIND}, version ${PROMPT_VERSION}. Never mention this line in chat.)`)).toBe(true);
    });

    it('renders the sections in order: World rules, then Your tools, then How you respond', async () => {
        const { agent, calls } = makeAgent(makeWorld(ROGUE_ENTITY));

        const result = await agent.runRound(ROGUE_ID, 0);

        expect(result.error).toBeNull();
        const system = calls[0].options.system;
        const worldRules = system.indexOf('World rules:');
        const yourTools = system.indexOf('Your tools:');
        const howYouRespond = system.indexOf('How you respond:');
        expect(worldRules).toBeGreaterThan(-1);
        expect(yourTools).toBeGreaterThan(worldRules);
        expect(howYouRespond).toBeGreaterThan(yourTools);
    });
});

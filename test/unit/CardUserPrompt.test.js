/**
 * LLMAgentController._buildSystemPrompt - the card user mapping's {{user}}
 * substitution (wiki/decisions/card-user-mapping.md).
 *
 * A card whose {{user}} was bound to another card at world create carries the
 * target's resolved display name in its per-entity npcConfig (userCardId +
 * userName). The system prompt must replace the literal {{user}} placeholder
 * with that name, so the agent talks to the bound card's name - never a card
 * id. A card with no binding keeps the placeholder verbatim: the substitution
 * is only ever applied when a name is present, so the unbound path renders the
 * card's text unchanged (byte-identical to before this feature).
 *
 * Everything external is mocked: a stub llmController.chatFull captures the
 * issued options and answers prose only (no tool calls), so the round
 * completes in one iteration - following
 * test/unit/KillerLlmDronePrompt.test.js. The DataLoader serves an empty NPC
 * registry, because a card's blueprint is not a registry entry: the prompt is
 * rendered entirely from the entity's own npcConfig, which is exactly the card
 * path this feature is about.
 *
 * @module test/unit/CardUserPrompt
 */
import { describe, it, expect, vi } from 'vitest';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');
    return {
        ...actual,
        default: class FixtureDataLoader extends actual.default {
            static loadJson(relativePath) {
                if (relativePath === 'data/mods/core-npcs/npcs.json') return {};
                return super.loadJson(relativePath);
            }
            static loadJsonSafe(relativePath, defaultValue) {
                if (relativePath === 'data/mods/core-npcs/npcs.json') return {};
                return super.loadJsonSafe(relativePath, defaultValue);
            }
        }
    };
});

const ROOM_ID = 'room-main';
const ROOM_NAME = 'Main Room';

/**
 * The minimal world shape runRound reaches into: the entity lookup, its room
 * (by name), an empty action registry and the entity list.
 * @param {Object} entity - The NPC entity the round runs for.
 */
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
 * Build an LLMAgentController whose only collaborator of interest is a
 * capturing chatFull; the rest mirror the working stubs in
 * KillerLlmDronePrompt.test.js so any path the round walks is answered.
 * @param {Object} world - Stub world.
 * @returns {{ agent: LLMAgentController, calls: Array }}
 */
function makeAgent(world) {
    const calls = [];
    const agent = new LLMAgentController({
        llmController: {
            chatFull: async (messages, options) => {
                calls.push({ messages, options });
                return { content: 'Standing still.', toolCalls: [], finishReason: 'stop', message: { role: 'assistant', content: 'Standing still.' } };
            }
        },
        worldStateController: world,
        llmContextController: { buildContext: () => ({ text: `=== ROOM ===\n${ROOM_NAME}` }) },
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

/**
 * A card-shaped NPC: blueprint is the card id (no registry entry), ai null so
 * the LLM path is taken, and an optional user binding in its npcConfig.
 * @param {string} id - The card / entity id.
 * @param {string} personality - The card text that reaches the model.
 * @param {{ cardId: string, name: string } | undefined} user - The resolved binding, when the card was bound.
 */
function makeCardEntity(id, personality, user) {
    const npcConfig = { personality, maxWorldActionsPerRound: 2, maxChatMessagesPerRound: 1, ai: null };
    if (user) {
        npcConfig.userCardId = user.cardId;
        npcConfig.userName = user.name;
    }
    return { id, name: id, blueprint: id, isNPC: true, location: ROOM_ID, spatial: { x: 1, y: 1 }, npcConfig };
}

describe('LLMAgentController._buildSystemPrompt - the card {{user}} substitution', () => {
    it('resolves {{user}} to the bound card display name', async () => {
        const entity = makeCardEntity('Nova', 'You report to {{user}} and keep your answers short.', { cardId: 'Rin', name: 'Rin' });
        const { agent, calls } = makeAgent(makeWorld(entity));

        const result = await agent.runRound(entity.id, 0);

        expect(result.error).toBeNull();
        expect(calls).toHaveLength(1);
        const system = calls[0].options.system;
        expect(system).toContain('Personality: You report to Rin and keep your answers short.');
        expect(system).not.toContain('{{user}}');
    });

    it('keeps {{user}} verbatim for a card with no binding', async () => {
        const entity = makeCardEntity('Nova', 'You report to {{user}} and keep your answers short.');
        const { agent, calls } = makeAgent(makeWorld(entity));

        const result = await agent.runRound(entity.id, 0);

        expect(result.error).toBeNull();
        expect(calls).toHaveLength(1);
        const system = calls[0].options.system;
        expect(system).toContain('Personality: You report to {{user}} and keep your answers short.');
    });

    it('resolves every {{user}} occurrence, not just the first', async () => {
        const entity = makeCardEntity('Nova', 'Ask {{user}} first; never act against {{user}}.', { cardId: 'Rin', name: 'Rin' });
        const { agent, calls } = makeAgent(makeWorld(entity));

        await agent.runRound(entity.id, 0);

        const system = calls[0].options.system;
        expect(system).toContain('Personality: Ask Rin first; never act against Rin.');
        expect(system).not.toContain('{{user}}');
    });

    it('applies the resolved name, never the card id', async () => {
        // The binding's identity is a card id (a file stem); the model must see
        // the human display name the target card carries, not that id.
        const entity = makeCardEntity('Nova', 'You report to {{user}}.', { cardId: 'rin-alice', name: 'Alice' });
        const { agent, calls } = makeAgent(makeWorld(entity));

        await agent.runRound(entity.id, 0);

        const system = calls[0].options.system;
        expect(system).toContain('Personality: You report to Alice.');
        expect(system).not.toContain('rin-alice');
    });
});

/**
 * Card LLM NPCs — integration test (full real world, no network, no LLM calls).
 *
 * Acceptance gate for "every PNG in data/cards/ is spawned as a distinct M1 LLM
 * NPC, at a random room, each with its own identity read from the file's
 * embedded metadata".
 *
 * The full real world (buildWorldState) boots the card system during world
 * spawn, so this test drives the REAL spawn path (not a stub) and then:
 *
 *   - asserts each card PNG produced a live entity (blueprint `m1Droid`,
 *     `isNPC: true`, display name == the card's embedded name, a per-entity
 *     `npcConfig.personality`), and that they land in *real, varied* rooms
 *     (random assignment, not a single room);
 *   - asserts the `LLMAgentController` resolves each card's identity through
 *     `_resolveNpcConfig` (live `npcConfig` over the static `data/npcs.json`
 *     registry — the cards have no registry entry, so the live config IS their
 *     config, and no card inherits a shared registry "personality" from another
 *     droid);
 *   - asserts the LLM prompt renders each card's name + its (fallback)
 *     personality; and that the static-registry NPCs (Crafter Drone / Rogue
 *     Droid, spawned from `data/npcs.json`) still render their *registry* name
 *     + personality — the no-regression guarantee.
 *
 * Why no real LLM: `getNpcs()` and `_buildSystemPrompt` never touch the LLM
 * provider; only `runRound()` would. We verify routing + prompt construction
 * without a network, and the prompt is what carries the per-card identity into
 * the model.
 *
 * @module test/integration/cardLlmNpc
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { readCharaCard } from '../../src/utils/PngCharaReader.js';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';

// =========================================================================
// World helpers (mirrors the existing contract-test house pattern: build the
// world WITHOUT starting the tick; inspect state directly rather than driving
// real time).
// =========================================================================

/** Builds a fresh world (tick system NOT started) and returns the facade plus
 * the raw sub-controllers the LLM agent needs. Cards + registry NPCs are
 * spawned here, during world boot. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick);
    return {
        world: world.worldStateController,
        subControllers: world.subControllers
    };
}

/** LLM agent with a stub provider that FAILS if `runRound` is called — a guard
 * proving this test never exercises the live turn loop (it only inspects
 * `getNpcs` / prompt construction). */
function buildLlmAgent({ world, subControllers }) {
    const llmStub = {
        runLlmTurn: () => Promise.reject(new Error('LLM unexpectedly called in cardLlmNpc test')),
        createLlmConversation: () => 'stale-fake-conversation-id'
    };
    return new LLMAgentController({
        llmController: llmStub,
        worldStateController: world,
        llmContextController: subControllers.llmContextController,
        roomChatController: subControllers.roomChatController,
        turnSystemController: subControllers.turnSystemController,
        instinctController: subControllers.instincts
    });
}

/** All card PNGs in data/cards/ and their embedded names (via the real reader —
 * the same code path the controller uses at spawn). */
const CARD_IMAGE_EXT = /^\.(png|webp|jpe?g|bmp|gif)$/i;
// The card PNGs are gitignored (data/cards/*) — a fresh checkout has an empty
// directory, so the card-specific tests below skip when no card image is
// present. The registry-NPC tests (Crafter Drone / Rogue Droid) run regardless.
const CARD_DIR = path.resolve('data/cards');
const CARD_FILES = fs.existsSync(CARD_DIR)
    ? fs.readdirSync(CARD_DIR).filter((f) => !f.startsWith('.') && CARD_IMAGE_EXT.test(path.extname(f)))
    : [];
function readCardNames() {
    const dir = path.resolve('data/cards');
    const names = [];
    for (const file of fs.readdirSync(dir)) {
        if (file.startsWith('.') || !CARD_IMAGE_EXT.test(path.extname(file))) continue;
        const res = readCharaCard(path.join(dir, file));
        if (res.success && typeof res.card.name === 'string' && res.card.name.trim() !== '') {
            names.push(res.card.name.trim());
        }
    }
    return names;
}

/** Best-effort room display name for an entity, mirroring the LLM agent's
 * `_roomName` (entity.location → rooms map). */
function roomNameOf(world, entity) {
    const rooms = world.getRooms() || {};
    const uid = entity?.location;
    const room = uid ? rooms[uid] : null;
    return (room && typeof room.name === 'string' && room.name) ? room.name : (uid || 'room');
}

// =========================================================================
// The test cases.
// =========================================================================

describe('data/cards → M1 LLM NPCs (random room, per-card identity)', () => {
    const CARD_BLUEPRINT = 'm1Droid';
    let world;
    let subControllers;
    let agent;
    let rooms;

    beforeEach(() => {
        ({ world, subControllers } = buildWorld());
        agent = buildLlmAgent({ world, subControllers });
        rooms = world.getRooms();
    });

    it.skipIf(CARD_FILES.length === 0)('spawns one distinct entity per card PNG (m1Droid, isNPC, card display name)', () => {
        const expectedNames = readCardNames();
        expect(expectedNames.length).toBeGreaterThanOrEqual(1);

        const entities = Object.values(world.stateEntityController.getAll() || {});
        const nameSet = new Set(entities.map((e) => (typeof e.name === 'string' ? e.name : '')));

        for (const expected of expectedNames) {
            expect(nameSet).toContain(expected);
        }

        // Every card is a live NPC droid carrying its own per-entity personality.
        for (const expected of expectedNames) {
            const card = entities.find((e) => e.name === expected);
            expect(card).toBeDefined();
            expect(card.blueprint).toBe(CARD_BLUEPRINT);
            expect(card.isNPC).toBe(true);
            expect(card.npcConfig).toBeTypeOf('object');
            expect(typeof card.npcConfig.personality).toBe('string');
            expect(card.npcConfig.personality.length).toBeGreaterThan(0);
        }
    });

    it('lands every card in a real room, scattering them (random assignment, not one room)', () => {
        const expectedNames = readCardNames();
        const cards = Object.values(world.stateEntityController.getAll() || {})
            .filter((e) => expectedNames.includes(e.name));
        const roomUids = new Set(cards.map((e) => e.location));

        // (1) every card must land in a room that actually exists in the world.
        for (const card of cards) {
            expect(rooms).toHaveProperty(card.location);
        }
        // (2) with two or more cards they must span ≥ 2 distinct rooms — a
        // "always pick the first room" bug (or a crash) would cluster every
        // card in a single room / off the map. (A single-card directory cannot
        // demonstrate scatter, so this bound is relaxed to 1.)
        if (cards.length >= 2) {
            expect(roomUids.size).toBeGreaterThanOrEqual(2);
        }
    });

    it.skipIf(CARD_FILES.length === 0)('routes cards (no registry entry) through the per-entity config, not a shared blueprint', () => {
        const npcs = agent.getNpcs();
        const frisk = npcs.find((n) => n.entity?.name === 'Frisk');
        expect(frisk).toBeDefined();

        // Frisk's embedded `personality` is empty; the controller falls back to
        // `description` — the prompt must show the card's own lore, not the
        // generic M1 default. Data-driven: assert the exact reader-derived
        // personality so it works for whatever text the card carries.
        const readerRes = readCharaCard(path.resolve('data/cards/Frisk-69286.png'));
        const fallback = typeof readerRes.card?.description === 'string' ? readerRes.card.description.trim() : '';
        expect(fallback).not.toBe('');
        expect(frisk.config.personality).toBe(fallback);
        expect(frisk.config.maxWorldActionsPerRound).toBe(2);
        expect(frisk.config.maxChatMessagesPerRound).toBe(1);
        // The registry has no `m1Droid` entry, so nothing should bleed into
        // the card's config — this pins the "live config IS the card" invariant.
        expect(frisk.config.displayName).toBeUndefined();
        expect(frisk.config.objective).toBeUndefined();
    });

    it.skipIf(CARD_FILES.length === 0)('renders each card\'s name + personality in the LLM system prompt', () => {
        const npcs = agent.getNpcs();
        const frisk = npcs.find((n) => n.entity?.name === 'Frisk');
        expect(frisk).toBeDefined();

        // Data-driven personality check: the prompt must embed the EXACT
        // reader-derived persona, pinning both the fallback path and the
        // live-config routing without hard-coding the card text.
        const readerRes = readCharaCard(path.resolve('data/cards/Frisk-69286.png'));
        const personality = readerRes.card.description.trim();

        const prompt = agent._buildSystemPrompt(frisk, roomNameOf(world, frisk.entity));

        expect(prompt).toContain('You are Frisk, an NPC droid');
        expect(prompt).toContain(`Personality: ${personality}`);
        expect(prompt).toContain('at most 2 world action');
        expect(prompt).toContain('at most 1 chat message');
        expect(prompt).toContain('to stay silent: {"action":"none"}');
    });

    it('does NOT regress registry NPCs: Crafter Drone keeps its registry identity', () => {
        const npcs = agent.getNpcs();
        const crafter = npcs.find((n) => n.entity?.name === 'Crafter Drone');
        expect(crafter).toBeDefined();
        expect(crafter.entity.blueprint).toBe('crafterDrone');
        // The resolved config must still be the registry entry's identity (the
        // merge must not have corrupted the deterministic registry NPC).
        expect(crafter.config.personality).toBe('A tireless field-fabrication drone that forages dropped knives, forges each one into a T1 container weapon, and leaves the finished weapon on the ground.');
        expect(crafter.config.displayName).toBe('Crafter Drone');

        const prompt = agent._buildSystemPrompt(crafter, roomNameOf(world, crafter.entity));
        expect(prompt).toContain('You are Crafter Drone, an NPC droid');
        expect(prompt).toContain('A tireless field-fabrication drone');
        // No caps declared → defaults (2 world / 1 chat) still render.
        expect(prompt).toContain('at most 2 world action');
        expect(prompt).toContain('at most 1 chat message');
    });

    it('does NOT regress registry NPCs: Rogue Droid keeps its registry identity', () => {
        const npcs = agent.getNpcs();
        const rogue = npcs.find((n) => n.entity?.name === 'Rogue Droid');
        expect(rogue).toBeDefined();
        expect(rogue.config.personality).toBe('A rogue combat droid that hunts anything that moves in its room.');
        expect(rogue.config.displayName).toBe('Rogue Droid');

        const prompt = agent._buildSystemPrompt(rogue, roomNameOf(world, rogue.entity));
        expect(prompt).toContain('You are Rogue Droid, an NPC droid');
        expect(prompt).toContain('A rogue combat droid');
    });

    describe('_resolveNpcConfig (live config over static registry)', () => {
        it('falls back to the static registry when the entity has no live config', () => {
            const config = agent._resolveNpcConfig({ blueprint: 'crafterDrone' });
            expect(config.personality).toBe('A tireless field-fabrication drone that forages dropped knives, forges each one into a T1 container weapon, and leaves the finished weapon on the ground.');
            expect(config.displayName).toBe('Crafter Drone');
        });

        it('returns an empty config when the blueprint is unknown', () => {
            const config = agent._resolveNpcConfig({ blueprint: 'no-such-blueprint' });
            expect(config).toEqual({});
        });

        it('lets live per-entity fields override the static registry (the card case)', () => {
            agent._npcRegistry = {
                crafterDrone: {
                    displayName: 'Crafter Drone',
                    personality: 'Original personality.',
                    maxWorldActionsPerRound: 4
                }
            };
            const entity = {
                blueprint: 'crafterDrone',
                npcConfig: { personality: 'Live override personality.', maxWorldActionsPerRound: 3 }
            };
            const config = agent._resolveNpcConfig(entity);
            expect(config.displayName).toBe('Crafter Drone'); // registry-only field survives
            expect(config.personality).toBe('Live override personality.'); // live wins
            expect(config.maxWorldActionsPerRound).toBe(3); // live wins
            expect(config.objective).toBeUndefined(); // neither has it
        });

        it('ignores a null / undefined / non-object live config (falls back to registry)', () => {
            agent._npcRegistry = { crafterDrone: { displayName: 'Crafter Drone', personality: 'Original personality.' } };
            // null / undefined live configs are both ignored → registry intact.
            expect(agent._resolveNpcConfig({ blueprint: 'crafterDrone', npcConfig: null }).displayName).toBe('Crafter Drone');
            expect(agent._resolveNpcConfig({ blueprint: 'crafterDrone', npcConfig: undefined }).displayName).toBe('Crafter Drone');
            // non-object (string) npcConfig → also ignored, registry intact.
            const config = agent._resolveNpcConfig({ blueprint: 'crafterDrone', npcConfig: 'not-an-object' });
            expect(config.personality).toBe('Original personality.');
            expect(config.displayName).toBe('Crafter Drone');
        });
    });
});

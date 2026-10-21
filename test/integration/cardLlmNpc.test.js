/**
 * Card LLM NPCs — integration test (full real world, no network, no LLM calls).
 *
 * Acceptance gate for "every PNG in data/cards/ is spawned as a distinct M1 LLM
 * NPC, ALWAYS in the first room (world-definition order), each with its own
 * identity read from the file's embedded metadata".
 *
 * The full real world (buildWorldState) boots the card system during world
 * spawn, so this test drives the REAL spawn path (not a stub) and then:
 *
 *   - asserts each card PNG produced a live entity (blueprint `m1Droid`,
 *     `isNPC: true`, display name == the card's embedded name, a per-entity
 *     `npcConfig.personality`), and that they ALL land in the *first* room
 *     (deterministic: the first spawnable room in world-definition order);
 *   - asserts the `LLMAgentController` resolves each card's identity through
 *     `_resolveNpcConfig` (live `npcConfig` over the static `data/entities/npcs.json`
 *     registry — the cards have no registry entry, so the live config IS their
 *     config, and no card inherits a shared registry "personality" from another
 *     droid);
 *   - asserts the LLM prompt renders each card's name + its (fallback)
 *     personality; and that the static registry lookup (`_resolveNpcConfig`)
 *     still falls back to a registry entry's name + personality for a
 *     blueprint without a live config (the `killerLlmDrone` entry — env-gated,
 *     so it is NOT spawned in this test world, but the registry lookup needs
 *     no spawn) — the no-regression guarantee.
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
// present. The registry-lookup test (killerLlmDrone) runs regardless.
const CARD_DIR = path.resolve('data/cards');
const CARD_FILES = fs.existsSync(CARD_DIR)
    ? fs.readdirSync(CARD_DIR).filter((f) => !f.startsWith('.') && CARD_IMAGE_EXT.test(path.extname(f)))
    : [];
function readCardNames() {
    const dir = path.resolve('data/cards');
    const names = [];
    // data/cards is gitignored — a fresh checkout has no directory at all,
    // so guard the scan (same existsSync pattern as CARD_FILES above).
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const file of files) {
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

describe('data/cards → M1 LLM NPCs (first room, per-card identity)', () => {
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

    it.skipIf(CARD_FILES.length === 0)('lands EVERY card in the FIRST room (world-definition order — deterministic, no scatter)', () => {
        const expectedNames = readCardNames();
        const cards = Object.values(world.stateEntityController.getAll() || {})
            .filter((e) => expectedNames.includes(e.name));
        expect(cards.length).toBeGreaterThanOrEqual(1);

        // The first spawnable room in world-definition order: the rooms map is
        // keyed in rooms.json insertion order (UUIDs are non-numeric, so
        // object key order IS insertion order), so the first key with numeric
        // width/height is exactly what pickFirstSpawnRoom picks.
        const firstSpawnable = Object.values(rooms).find(
            (r) => typeof r.width === 'number' && typeof r.height === 'number'
        );
        expect(firstSpawnable).toBeDefined();

        for (const card of cards) {
            // (1) the room must exist in the world and (2) be EXACTLY the
            // first one — a regression to random scattering (or a crash) would
            // put some card in a different room / off the map.
            expect(rooms).toHaveProperty(card.location);
            expect(rooms[card.location]?.name).toBe(firstSpawnable.name);
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
        // PROTOCOL B: native tool calls are the only output protocol — silence
        // is legal, and there is no JSON-in-content protocol.
        expect(prompt).toContain('If nothing is worth doing or saying this round, respond with no tool call and no text. Silence is allowed.');
        expect(prompt).not.toContain('Respond with ONE JSON object');
        expect(prompt).not.toContain('"action":"speak"');
    });

    describe('_resolveNpcConfig (live config over static registry)', () => {
        it('falls back to the static registry when the entity has no live config', () => {
            // The live registry's only remaining entry (the crafterDrone
            // "Crafter Drone" entry was removed from the world) is the
            // env-gated killerLlmDrone — registry lookup has no env gate, so
            // the fallback resolves it even though it is not spawned here.
            const config = agent._resolveNpcConfig({ blueprint: 'killerLlmDrone' });
            expect(config.personality).toBe('A cold, relentless hunter. It does not hesitate, does not warn, and does not stop.');
            expect(config.displayName).toBe('Killer LLM Drone');
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

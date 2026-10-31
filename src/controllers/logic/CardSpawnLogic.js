/**
 * CardSpawnLogic — FASE 7 (facade logic extraction — phase 2).
 *
 * Card-droid (image-card) system (data-driven, see wiki/subMDs/data/cards.md).
 *
 * Every image file dropped into `data/cards/` becomes a living LLM-routed M1
 * droid: the filesystem listing is the source of truth for which cards exist
 * (drop a PNG, get a droid). The character identity — name, personality,
 * backstory, per-round caps — is *embedded in the PNG's metadata side channel
 * as base64 JSON* (Chub.ai/botbooru `chara_card_v2` spec); it is pulled out of
 * the file at spawn time via `readCharaCard()`, not read from a static JSON
 * registry. Cards are ALWAYS spawned in the FIRST room (in world-definition
 * order — `start_room` in the default world) at a uniformly-random point
 * inside it — in contrast to `_spawnNpcs`, which pins each registry NPC at
 * its home-room center. Each card spawns with its own saved body (a blueprint
 * keyed by the card's display name, created via the "Create Agent Body" Save
 * action) when one exists in the world, otherwise the generic M1 blueprint.
 *
 * Extracted verbatim from WorldStateController (changes: `this.` became
 * `facade.` and the methods became plain functions; the module-level card
 * constants moved here with the code that owns them). `readCardFiles` is the
 * one function that never touched the facade — its `_facade` parameter is
 * kept (unused) purely for uniform delegator call shape, per the repo's
 * `argsIgnorePattern: "^_"` convention. The facade keeps a thin
 * delegator method per extracted method so instance-level spies/mocks and
 * direct calls keep working. Narrow-deps rule (mirrors
 * consequences/DropItemHandler.js): `facade` is the WorldStateController
 * instance and each function only uses the members named in its JSDoc.
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../utils/Logger.js';
import { readCharaCard } from '../../utils/PngCharaReader.js';

const CARD_BLUEPRINT = 'm1Droid';
const CARD_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/**
 * Default profile applied to every card when the embedded payload is missing
 * or leaves a field blank (e.g. a blank `personality`). Combat-capable (t1 +
 * knife, matching the killer drone's LLM-combat loadout) and long-lived (coal
 * fuel so the M1's energy battery never drains to 0 before the coal does).
 * The payload's `name`/`personality`/`description` override these defaults
 * where present; otherwise the fallbacks apply. `ai` is deliberately absent,
 * so `hasDeterministicBrain` returns false and the per-round dispatcher hands
 * the card to the LLM agent.
 */
const CARD_DEFAULT_PROFILE = {
    personality: 'You are a friendly M1 field droid who wanders a scrap world. Observe, help when asked, and keep replies short and in character.',
    maxWorldActionsPerRound: 2,
    maxChatMessagesPerRound: 1,
    initialItems: [
        // Clothes feature: every card droid spawns wearing a human t-shirt
        // (WearLogic — pure volume fit: the first component with at least
        // wear.minVolume of free volume, the body core in practice).
        // Declared first so it lands before the bulkier items.
        { item: 'tshirt', count: 1, wear: true },
        { item: 'coal', count: 20 },
        { item: 't1', count: 1, equip: true, contents: [{ item: 'knife', count: 10 }] },
        { item: 'knife', count: 2, equip: true }
    ]
};

/**
 * Spawns every image file in `data/cards/` as a distinct LLM-routed M1 droid,
 * always in the first room (in world-definition order) at a uniformly-random
 * point inside it.
 *
 * WHY a dedicated path (not reusing the `data/mods/core-npcs/npcs.json` registry):
 * a card's identity is per-file — it lives embedded in each PNG's metadata
 * (`readCharaCard`), so there is no static registry entry keyed by blueprint
 * for it. Two cards share the `m1Droid` blueprint yet must keep distinct
 * personalities; the per-entity `npcConfig` (set here) is what carries that
 * identity into the LLM prompt (the LLM agent merges it over the registry,
 * live values winning — see `LLMAgentController._resolveNpcConfig`).
 * Hence each card is an `isNPC` entity with no deterministic `ai` block, so
 * `hasDeterministicBrain` is false and the shared LLM agent loop drives it,
 * exactly like the killer LLM drone but with a personality pulled from the
 * file rather than a registry string.
 *
 * Graceful degradation: the filesystem listing is the source of truth for
 * which cards exist; a file that is not a PNG or carries no character
 * payload is logged and skipped, so one bad file never derails the whole
 * population or fails boot.
 *
 * `options.only` narrows the listing to a chosen set of card ids. This is what
 * "create world" uses: the operator picks which cards populate the world
 * instead of taking everything in `data/cards/`. Filtering the *listing* (and
 * not iterating the request) keeps the spawn order the same one boot uses -
 * `readCardFiles()` order - so a chosen subset spawns in the same relative
 * order as the full set would (`CR D-1`: the population must not depend on the
 * order the browser happened to send the checkboxes in).
 * @private
 * @param {{ only?: string[] }} [options] - `only`: card ids to spawn (absent ->
 *   every card file).
 * @returns {{ total: number, spawned: number, entities: Array<{cardId: string, entityId: string}> }}
 */
function spawnCards(facade, options = {}) {
    const all = facade._readCardFiles();
    let cardFiles = all;
    if (Array.isArray(options.only)) {
        const chosen = new Set(options.only);
        cardFiles = all.filter((cardFile) => chosen.has(cardFile.cardId));
    }
    if (cardFiles.length === 0) {
        Logger.info('[WorldStateController] No card files to spawn in data/cards/.');
        return { total: 0, spawned: 0, entities: [] };
    }
    const entities = [];
    for (const cardFile of cardFiles) {
        const entityId = facade._spawnSingleCard(cardFile);
        if (entityId !== null) entities.push({ cardId: cardFile.cardId, entityId });
    }
    Logger.info(`[WorldStateController] ${entities.length}/${cardFiles.length} card NPC(s) spawned from data/cards/ (generic blueprint ${CARD_BLUEPRINT} - or a card's own saved body when one exists).`);
    return { total: cardFiles.length, spawned: entities.length, entities };
}

/**
 * Lists the image files that are candidate cards, keyed by a stable stem
 * (filename minus extension) used for logging and as the display-name
 * fallback when a payload is missing.
 * @private
 * @returns {Array<{fullPath: string, cardId: string}>}
 */
function readCardFiles(_facade) {
    const dir = path.resolve('data/cards');
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        Logger.info('[WorldStateController] data/cards/ not present — nothing to spawn.');
        return [];
    }
    const files = [];
    for (const name of names) {
        if (!CARD_IMAGE_EXTS.has(path.extname(name).toLowerCase())) continue;
        const cardId = path.basename(name, path.extname(name));
        if (!cardId) continue;
        files.push({ fullPath: path.resolve(dir, name), cardId });
    }
    return files;
}

/**
 * Reads a single card PNG and spawns it as an M1 LLM NPC, using the card's
 * own saved body (a blueprint keyed by its display name) when one exists,
 * otherwise the generic M1 blueprint. The embedded
 * character payload defines the identity (name, personality, backstory,
 * caps); a missing/corrupt payload degrades to the default profile and the
 * file stem as the display name, so the entity still spawns (never fails).
 * @private
 * @param {{fullPath: string, cardId: string}} cardFile
 * @returns {string|null} the spawned entity id, or null when nothing
 *     could be spawned from this file.
 */
function spawnSingleCard(facade, cardFile) {
    const payload = readCharaCard(cardFile.fullPath);
    const card = payload.success ? payload.card : null;
    const displayName = (card && typeof card.name === 'string' && card.name.trim() !== '')
        ? card.name.trim()
        : cardFile.cardId;

    const blueprint = blueprintForCard(facade, displayName);

    const profile = facade._buildCardProfile(card);
    const room = facade._pickFirstSpawnRoom();
    if (!room) {
        Logger.warn(`[WorldStateController] card "${displayName}" has no spawnable rooms — skipped.`);
        return null;
    }
    const { x, y } = facade._roomRandomPoint(room);
    const npcConfig = {
        personality: profile.personality,
        maxWorldActionsPerRound: profile.maxWorldActionsPerRound,
        maxChatMessagesPerRound: profile.maxChatMessagesPerRound
        // No deterministic `ai` block: the entity is routed to the LLM
        // agent (hasDeterministicBrain is false). The per-entity
        // personality/caps above are what the LLM prompt renders.
    };
    try {
        const entityId = facade.stateEntityController.spawnEntity(blueprint, room.uid, {
            isNPC: true,
            name: displayName,
            npcConfig
        });
        if (!entityId) {
            Logger.warn(`[WorldStateController] card "${displayName}" spawnEntity returned no id — skipped.`);
            return null;
        }
        facade.stateEntityController.updateEntitySpatial(entityId, { x, y });
        facade._applyInitialItems(entityId, { ...profile, displayName });
        Logger.info(`[WorldStateController] card "${displayName}" (${cardFile.cardId}) spawned as ${entityId} in room "${room.name}" (${x}, ${y}).`);
        return entityId;
    } catch (error) {
        Logger.error(`[WorldStateController] card "${displayName}" spawn failed: ${error.message}`);
        return null;
    }
}

/**
 * Merges the embedded card payload over the default card profile.
 *
 * The payload's `personality` field (a Chub.ai card field) is the primary
 * personality. Many cards leave it blank and keep the character lore in
 * `description` instead — in that case the full `description` is used as
 * the personality so the LLM prompt still carries the character's identity
 * and backstory (rather than the generic droid fallback). Caps and the
 * loadout come from the default profile (cards have no per-round tuning
 * data in their embedded payload).
 * @private
 * @param {{name?: string, personality?: string, description?: string}|null} card
 * @returns {{personality: string, maxWorldActionsPerRound: number, maxChatMessagesPerRound: number, initialItems: Array}}
 */
function buildCardProfile(facade, card) {
    const personality = (card && typeof card.personality === 'string' && card.personality.trim() !== '')
        ? card.personality.trim()
        : (card && typeof card.description === 'string' && card.description.trim() !== '')
            ? card.description.trim()
            : CARD_DEFAULT_PROFILE.personality;
    return {
        ...CARD_DEFAULT_PROFILE,
        personality
    };
}

/**
 * Picks the FIRST spawnable room (numeric width/height) in world-definition
 * order — the insertion order of the rooms map, which mirrors rooms.json
 * (start_room first in the default world). Deterministic on purpose: every
 * card lands where the world starts (design decision 2026-10-21, superseding
 * the old uniformly-random room pick; cardLlmNpc.test.js locks this in).
 * @private
 * @returns {{uid: string, name: string, width: number, height: number}|null}
 */
function pickFirstSpawnRoom(facade) {
    const all = facade.roomsController.getAll() || {};
    for (const uid of Object.keys(all)) {
        const room = all[uid];
        if (room && typeof room.width === 'number' && typeof room.height === 'number') {
            return { uid, name: room.name, width: room.width, height: room.height };
        }
    }
    return null;
}

/**
 * A uniformly-random in-room point, in the same room-local coordinate
 * frame the deterministic NPC spawn uses (center = width/2, height/2).
 * @private
 * @param {{uid: string, name: string, width: number, height: number}} room
 * @returns {{x: number, y: number}}
 */
function roomRandomPoint(facade, room) {
    const width = Math.max(1, Math.floor(room.width));
    const height = Math.max(1, Math.floor(room.height));
    return {
        x: Math.floor(Math.random() * width),
        y: Math.floor(Math.random() * height)
    };
}

/**
 * Blueprint to spawn a given card with: the card's own saved body (a blueprint
 * keyed by the card's display name, created via the "Create Agent Body" Save
 * action in the dev tab) when one exists, otherwise the generic M1 blueprint.
 * The key is the trimmed card display name (same derivation as
 * AgentBodyController.cardName), so a saved body is matched exactly by name.
 * When the facade has no entityController (e.g. a light test double), it falls
 * back to the generic blueprint so spawning never fails.
 * @private
 * @param {WorldStateController} facade
 * @param {string} displayName
 * @returns {string}
 */
function blueprintForCard(facade, displayName) {
    if (displayName && typeof displayName === 'string') {
        const blueprints =
            (facade.entityController && typeof facade.entityController.getBlueprints === 'function')
                ? (facade.entityController.getBlueprints() || {})
                : {};
        if (Object.prototype.hasOwnProperty.call(blueprints, displayName)) {
            return displayName;
        }
    }
    return CARD_BLUEPRINT;
}

export { spawnCards, readCardFiles, spawnSingleCard, buildCardProfile, pickFirstSpawnRoom, roomRandomPoint, blueprintForCard };

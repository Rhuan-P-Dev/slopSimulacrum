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
 * registry. Cards are spawned at a uniformly-random room and a uniformly-random
 * point inside that room — in contrast to `_spawnNpcs`, which pins each registry
 * NPC at its home-room center.
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
        { item: 'coal', count: 20 },
        { item: 't1', count: 1, equip: true, contents: [{ item: 'knife', count: 10 }] },
        { item: 'knife', count: 2, equip: true }
    ]
};

/**
 * Spawns every image file in `data/cards/` as a distinct LLM-routed M1 droid,
 * at a uniformly-random room and a uniformly-random point inside it.
 *
 * WHY a dedicated path (not reusing the `data/npcs.json` registry):
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
 * @private
 */
function spawnCards(facade) {
    const cardFiles = facade._readCardFiles();
    if (cardFiles.length === 0) {
        Logger.info('[WorldStateController] No card files in data/cards/ — nothing to spawn.');
        return;
    }
    let spawned = 0;
    for (const cardFile of cardFiles) {
        if (facade._spawnSingleCard(cardFile) !== null) spawned++;
    }
    Logger.info(`[WorldStateController] ${spawned}/${cardFiles.length} card NPC(s) spawned from data/cards/ (blueprint ${CARD_BLUEPRINT}).`);
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
 * Reads a single card PNG and spawns it as an M1 LLM NPC. The embedded
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

    const profile = facade._buildCardProfile(card);
    const room = facade._pickRandomRoom();
    if (!room) {
        Logger.warn(`[WorldStateController] card "${displayName}" has no rooms to pick from — skipped.`);
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
        const entityId = facade.stateEntityController.spawnEntity(CARD_BLUEPRINT, room.uid, {
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
 * Picks a uniformly-random, spawnable room (numeric width/height) from the
 * live room set. Spawn position is a spawn-time property (not a runtime
 * toggle), so the random pick happens once, at boot.
 * @private
 * @returns {{uid: string, name: string, width: number, height: number}|null}
 */
function pickRandomRoom(facade) {
    const all = facade.roomsController.getAll() || {};
    const valid = Object.keys(all).filter((uid) => {
        const room = all[uid];
        return room && typeof room.width === 'number' && typeof room.height === 'number';
    });
    if (valid.length === 0) return null;
    const uid = valid[Math.floor(Math.random() * valid.length)];
    const room = all[uid];
    return { uid, name: room.name, width: room.width, height: room.height };
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

export { spawnCards, readCardFiles, spawnSingleCard, buildCardProfile, pickRandomRoom, roomRandomPoint };

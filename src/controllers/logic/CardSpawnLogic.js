/**
 * CardSpawnLogic — PHASE 7 (facade logic extraction — phase 2).
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
 *
 * On top of spawning, `spawnCards` also carries the card user mapping's
 * JUDGED-relationship attachment (wiki/decisions/card-user-relationship-context.md):
 * `attachBoundUserRelationships` reads each bound source's sidecar (freshness
 * through the data seam, `CardRelationshipStore.readFreshCardUserRelationship`
 * — the same persona-hash rule the judgment command applies) and writes the
 * verdict into the target's npcConfig, where the agent's system prompt renders
 * it (`LLMAgentController._buildSystemPrompt`). It is a per-spawn fact, like
 * the binding itself: the sidecar stays the single source of truth on disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../utils/Logger.js';
import { readCharaCard } from '../../utils/PngCharaReader.js';
import { CARD_IMAGE_EXTS } from '../../utils/CardImageTypes.js';
import { readFreshCardUserRelationship } from '../../utils/CardRelationshipStore.js';

const CARD_BLUEPRINT = 'm1Droid';

/**
 * The card directory (the source of truth for which cards exist). Resolved
 * once at module load — the repository root is the process cwd (AGENTS.md
 * stack: no bundler, `node src/server.js`), so the relative resolve is stable.
 */
const CARD_DIR = path.resolve('data/cards');

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
 *
 * `options.users` is the card user mapping (`wiki/decisions/card-user-mapping.md`):
 * a validated `{ [cardId]: cardId }` object binding some cards' `{{user}}`
 * placeholder to another card, so the bound card's agent thinks its user is the
 * target card. Each target's display name is resolved once here and handed to
 * the spawn (see `resolveUserNames`); absent it is boot behavior (no binding).
 * When any binding lands on a spawned card the report carries a `users` object
 * (source card id -> `{ cardId, name }` of the bound target) so the caller can
 * confirm what was applied; when none land the key is absent, keeping the
 * report shape byte-identical to before for an unbound world.
 *
 * On top of the binding, the judged `{{user}}` relationship of every bound
 * SOURCE card that also spawned is attached to the TARGET card's per-entity
 * npcConfig (`userRelationships`, see `attachBoundUserRelationships` and
 * wiki/decisions/card-user-relationship-context.md): the target's agent is the
 * card the source's `{{user}}` was rewritten to, so it is the one that should
 * know which droids treat it as their user, and how they regard it. Only
 * FRESH sidecars attach (the same persona-hash rule the judgment applies);
 * a card never judged, judged stale, or missing simply attaches nothing.
 * @private
 * @param {{ only?: string[], users?: Object<string, string> }} [options] -
 *   `only`: card ids to spawn (absent -> every card file). `users`: the
 *   validated user mapping (absent -> no binding).
 * @returns {{ total: number, spawned: number, entities: Array<{cardId: string, entityId: string}>, users?: Object<string, {cardId: string, name: string}> }}
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
    const userByName = resolveUserNames(facade, all, options.users);
    const entities = [];
    const appliedUsers = {};
    for (const cardFile of cardFiles) {
        const user = userByName ? (userByName.get(cardFile.cardId) || null) : null;
        const entityId = facade._spawnSingleCard(cardFile, user);
        if (entityId !== null) {
            entities.push({ cardId: cardFile.cardId, entityId });
            if (user) appliedUsers[cardFile.cardId] = { cardId: user.cardId, name: user.name };
        }
    }
    if (userByName) {
        attachBoundUserRelationships(facade, all, userByName, entities);
    }
    Logger.info(`[WorldStateController] ${entities.length}/${cardFiles.length} card NPC(s) spawned from data/cards/ (generic blueprint ${CARD_BLUEPRINT} - or a card's own saved body when one exists).`);
    const report = { total: cardFiles.length, spawned: entities.length, entities };
    if (Object.keys(appliedUsers).length > 0) report.users = appliedUsers;
    return report;
}

/**
 * Resolves the display names of the cards a user mapping points at.
 *
 * `users` is the validated `{ [cardId]: cardId }` binding (`WorldRecreateLogic`
 * owns that validation): the key is the card whose `{{user}}` is rewritten, the
 * value is the card it becomes. This returns a map of source card id to
 * `{ cardId, name }` for the target, where `name` is the target card's display
 * name read from its embedded payload - or the target card id itself when the
 * payload is missing or unreadable, so one bad file never aborts the world (the
 * same graceful degradation a spawn applies).
 *
 * Each distinct target is read at most once per call: a mapping that points many
 * cards at the same target reads that target's PNG once, not once per source.
 * This runs only at world creation (never per round), so the reads stay off the
 * hot path (`CR PERF-4`).
 * @private
 * @param {WorldStateController} _facade - unused; kept for the uniform call shape.
 * @param {Array<{fullPath: string, cardId: string}>} all - the full card listing.
 * @param {Object<string, string>|undefined} users - the validated user mapping.
 * @returns {Map<string, {cardId: string, name: string}>|null} source -> target,
 *   or null when there is no mapping.
 */
function resolveUserNames(_facade, all, users) {
    if (!users || typeof users !== 'object' || Array.isArray(users)) return null;
    const fullPathById = new Map(all.map((file) => [file.cardId, file.fullPath]));
    const targetByName = new Map();
    for (const targetId of Object.values(users)) {
        if (targetByName.has(targetId)) continue;
        let name = targetId;
        const fullPath = fullPathById.get(targetId);
        if (fullPath) {
            const payload = readCharaCard(fullPath);
            const card = payload.success ? payload.card : null;
            if (card && typeof card.name === 'string' && card.name.trim() !== '') name = card.name.trim();
        } else {
            Logger.warn(`[WorldStateController] user mapping target "${targetId}" has no card file - using the id as the name.`);
        }
        targetByName.set(targetId, { cardId: targetId, name });
    }
    const bySource = new Map();
    for (const [sourceId, targetId] of Object.entries(users)) bySource.set(sourceId, targetByName.get(targetId));
    return bySource;
}

/**
 * Attaches the judged `{{user}}` relationship of every bound source card to
 * the spawned target card it was bound to
 * (wiki/decisions/card-user-relationship-context.md).
 *
 * Run once, after the spawn loop, only when a user mapping was given. For
 * each binding whose source AND target both spawned: the source's sidecar is
 * read through the data seam and accepted only when it is FRESH (current
 * version, persona hash still matching the source card on disk, well-formed
 * relationship — the exact rule the judgment command applies to its own
 * records, shared from `CardRelationshipStore`). The verdict — the source's
 * display name plus the label and summary the LLM judged — is written into
 * the TARGET's per-entity npcConfig as `userRelationships` (an array, because
 * several sources may bind to one target), and the agent's system prompt
 * renders it (`LLMAgentController._buildSystemPrompt`).
 *
 * The read of the source's PNG is at most one extra per bound source, and
 * this runs only at world creation (never per round), so it stays off the
 * hot path (`CR PERF-4`). Every degradation is silent-and-skip, matching the
 * spawn's own: an unreadable source payload, a stale or missing sidecar, or a
 * facade without a stateEntityController (a light test double) simply
 * attaches nothing — one bad card never derails the population, and a world
 * without judgments is byte-identical to before this feature (CHG-8).
 * @private
 * @param {WorldStateController} facade
 * @param {Array<{fullPath: string, cardId: string}>} all - the full card listing.
 * @param {Map<string, {cardId: string, name: string}>} userByName - source -> target (from `resolveUserNames`).
 * @param {Array<{cardId: string, entityId: string}>} entities - the spawned cards.
 * @returns {void}
 */
function attachBoundUserRelationships(facade, all, userByName, entities) {
    if (userByName.size === 0) return;
    const stateEntities = facade.stateEntityController;
    if (!stateEntities || typeof stateEntities.getEntity !== 'function') {
        return; // a light double that does not hold entities: nothing to attach to
    }
    const fullPathById = new Map(all.map((file) => [file.cardId, file.fullPath]));
    const spawned = new Map(entities.map((entry) => [entry.cardId, entry]));
    const byTarget = new Map(); // target card id -> attached relationships (in binding order)
    for (const [sourceId, target] of userByName) {
        const source = spawned.get(sourceId);
        const targetEntry = spawned.get(target.cardId);
        if (!source || !targetEntry) continue; // only both-present pairs carry a fact
        const fullPath = fullPathById.get(sourceId);
        if (!fullPath) continue;
        const payload = readCharaCard(fullPath);
        const card = payload.success ? payload.card : null;
        const rel = readFreshCardUserRelationship(CARD_DIR, sourceId, card);
        if (!rel) continue; // never judged, stale, or malformed: no attachment
        const sourceEntity = stateEntities.getEntity(source.entityId);
        const name = (sourceEntity && typeof sourceEntity.name === 'string' && sourceEntity.name.trim() !== '')
            ? sourceEntity.name.trim()
            : sourceId;
        const list = byTarget.get(target.cardId) || [];
        list.push({ cardId: sourceId, name, label: rel.label, summary: rel.summary });
        byTarget.set(target.cardId, list);
    }
    for (const [targetCardId, list] of byTarget) {
        const entry = spawned.get(targetCardId);
        const entity = stateEntities.getEntity(entry.entityId);
        if (!entity || !entity.npcConfig) continue;
        entity.npcConfig = { ...entity.npcConfig, userRelationships: list };
        Logger.info(
            `[WorldStateController] card "${targetCardId}" carries the judged {{user}} relationship of ${list.map((r) => `"${r.name}"`).join(', ')} (bound to it at world create).`
        );
    }
}

/**
 * Lists the image files that are candidate cards, keyed by a stable stem
 * (filename minus extension) used for logging and as the display-name
 * fallback when a payload is missing.
 * @private
 * @returns {Array<{fullPath: string, cardId: string}>}
 */
function readCardFiles(_facade) {
    const dir = CARD_DIR;
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
 * @param {{cardId: string, name: string}|null} [user] - the card this one's
 *   `{{user}}` is bound to (id + resolved display name); absent -> no binding.
 * @returns {string|null} the spawned entity id, or null when nothing
 *     could be spawned from this file.
 */
function spawnSingleCard(facade, cardFile, user = null) {
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
    // Card user mapping (wiki/decisions/card-user-mapping.md): when this card's
    // `{{user}}` is bound to another card, remember the bound card id and its
    // resolved display name so the agent prompt can substitute the placeholder
    // (`LLMAgentController._buildSystemPrompt`).
    if (user) {
        npcConfig.userCardId = user.cardId;
        npcConfig.userName = user.name;
    }
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

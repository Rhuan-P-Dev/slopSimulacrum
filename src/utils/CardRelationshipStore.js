/**
 * CardRelationshipStore — the file seam for the card's {{user}}-relationship
 * sidecar (CR B-3: this is one of the DATA_SEAM_FS_FILES in eslint.config.js —
 * the only files in the tree that may import `fs`; nothing outside the seam
 * touches the disk).
 *
 * A judged relationship is persisted NEXT TO the card's image file as
 * `<card stem>.user-relationship.json` inside `data/cards/` (for example
 * `Connie Maheswaran-75538.user-relationship.json` next to the image of the
 * same stem). The card file itself is never written — the repository's
 * language policy
 * (AGENTS.md, "Language policy (hard rule)") forbids touching card files — and
 * the world definition (`data/mods/`) is untouched (CR B-2). The sidecar is
 * derived data: the owner is the judgment feature
 * (`CardUserRelationshipController`), which decides when a sidecar is stale and
 * deletes it; this store is dumb byte I/O with an atomic write.
 *
 * The sidecar's shape (versioned per P-1 — `SIDECAR_VERSION` is bumped when the
 * shape changes; a record with an unknown version is not served, not migrated):
 *
 *   {
 *     "version": 1,
 *     "cardId": "connie-maheswaran-75538",
 *     "name": "Connie Maheswaran",
 *     "personaHash": "<sha-256 hex>",
 *     "judgedAt": "2026-07-20T12:00:00.000Z",
 *     "relationship": { "label": "...", "summary": "..." }
 *   }
 *
 * Writes are atomic (tmp file + rename, P-3): an interrupted judgment never
 * leaves a half-written sidecar that a later read could take for a verdict.
 *
 * The store also owns the sidecar's FRESHNESS contract — `personaHashFor`,
 * `effectivePersonaFor` and `effectiveCardName` — because the hash is part of
 * the record's shape, and two consumers must agree on it exactly:
 * the judgment command (`CardUserRelationshipController`, which writes and
 * serves) and the world-create spawn (`CardSpawnLogic`, which reads it to
 * attach the judged relationship to a card's bound target,
 * wiki/decisions/card-user-relationship-context.md). Both compose the same
 * helpers defined here, so a rule change lands in one place (CHG-2).
 *
 * @module src/utils/CardRelationshipStore
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Logger from './Logger.js';
import { CARD_IMAGE_EXTS } from './CardImageTypes.js';

/** The sidecar file-name suffix (the card stem precedes it). */
export const SIDECAR_SUFFIX = '.user-relationship.json';

/** The current sidecar record version (P-1). Bump, never edit in place. */
export const SIDECAR_VERSION = 1;

/**
 * Pure file-name mapping (no disk): the sidecar name for a card file name.
 * 'Connie Maheswaran-75538.png' -> 'Connie Maheswaran-75538.user-relationship.json'
 * @param {string} cardFileName
 * @returns {string}
 */
export function sidecarNameFor(cardFileName) {
    const stem = path.basename(cardFileName, path.extname(cardFileName));
    return `${stem}${SIDECAR_SUFFIX}`;
}

/**
 * The full sidecar path for a card file inside a directory.
 * @param {string} cardDir
 * @param {string} cardFileName
 * @returns {string}
 */
export function sidecarPathFor(cardDir, cardFileName) {
    return path.join(cardDir, sidecarNameFor(cardFileName));
}

/**
 * List the card (PNG) file names in a directory (base names only). A missing
 * directory yields an empty list (the world simply has no cards yet — the
 * spawn path degrades the same way, `CardSpawnLogic.readCardFiles`).
 * @param {string} cardDir
 * @returns {Array<string>}
 */
export function listCardFileNames(cardDir) {
    let names;
    try {
        names = fs.readdirSync(cardDir);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }
    return names.filter((n) => typeof n === 'string' && CARD_IMAGE_EXTS.has(path.extname(n).toLowerCase()));
}

/**
 * List the sidecar file names in a directory (base names only). A missing
 * directory yields an empty list.
 * @param {string} cardDir
 * @returns {Array<string>}
 */
export function listCardUserRelationshipFileNames(cardDir) {
    let names;
    try {
        names = fs.readdirSync(cardDir);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }
    return names.filter((n) => typeof n === 'string' && n.endsWith(SIDECAR_SUFFIX));
}

/**
 * Read a sidecar record. A missing file yields `null` (no judgment yet — the
 * normal state). A present but unreadable/corrupt file yields `null` as well,
 * with a warning (OBS-1/OBS-3): a sidecar is derived data, so a damaged one is
 * degraded to "no judgment", never served, never fatal (P-7 — it is deleted
 * later by the judgment command if it belongs to a card whose persona moved on).
 * @param {string} fullPath
 * @returns {Object|null}
 */
export function readCardUserRelationshipFile(fullPath) {
    let raw;
    try {
        raw = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return null;
        }
        Logger.warn(`CardRelationshipStore: unreadable sidecar ${fullPath}: ${err && err.message}`);
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (err) {
        Logger.warn(`CardRelationshipStore: corrupt sidecar ${fullPath}: ${err && err.message}`);
        return null;
    }
}

/**
 * Write (or rewrite) a sidecar record atomically (tmp + rename, P-3). The
 * record is serialized with a trailing newline, the repository's JSON data-file
 * convention.
 * @param {string} fullPath
 * @param {Object} record - The sidecar record (see the module header).
 * @returns {void}
 */
export function writeCardUserRelationshipFile(fullPath, record) {
    const tmpPath = `${fullPath}.tmp`;
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    try {
        fs.writeFileSync(tmpPath, serialized, 'utf8');
        fs.renameSync(tmpPath, fullPath);
    } catch (err) {
        // An interrupted write must not leave a tmp file behind (P-3).
        try {
            fs.unlinkSync(tmpPath);
        } catch {
            // The tmp file is already gone (the rename may have succeeded, or
            // the write failed before it existed); there is nothing to clean.
        }
        throw err;
    }
}

/**
 * Delete a sidecar file. A missing file is not an error (it is already gone) —
 * the call returns whether a file was actually removed.
 * @param {string} fullPath
 * @returns {boolean}
 */
export function deleteCardUserRelationshipFile(fullPath) {
    try {
        fs.unlinkSync(fullPath);
        return true;
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return false;
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Freshness contract (shared by the judge and the spawn — see module header)
// ---------------------------------------------------------------------------

/**
 * The persona hash a sidecar carries: the sha-256 of the card's display name
 * and its effective persona, joined by a newline (the record's `personaHash`).
 * It is the staleness test — a sidecar is fresh when this still matches the
 * card on disk, and the two consumers (judge, spawn) compute it identically.
 * @param {string} name - the card's display name (see `effectiveCardName`)
 * @param {string} persona - the effective persona (see `effectivePersonaFor`)
 * @returns {string} hex digest
 */
export function personaHashFor(name, persona) {
    return crypto.createHash('sha256').update(`${name}\n${persona}`, 'utf8').digest('hex');
}

/**
 * A card's effective persona — the exact precedence the spawn renders into
 * the NPC (`CardSpawnLogic.buildCardProfile`): a non-empty `personality` wins,
 * then `description`, each trimmed. It deliberately stops at the empty string
 * and never falls back to the spawn's default text: the default is spawn-
 * owned and carries no `{{user}}` token, so a card that reaches it has nothing
 * to judge or to hash against (CHG-7 — it is not duplicated here).
 * @param {{personality?: string, description?: string}|null|undefined} card
 * @returns {string}
 */
export function effectivePersonaFor(card) {
    if (!card) return '';
    if (typeof card.personality === 'string' && card.personality.trim() !== '') {
        return card.personality.trim();
    }
    if (typeof card.description === 'string' && card.description.trim() !== '') {
        return card.description.trim();
    }
    return '';
}

/**
 * The display name the judgment and the sidecar use: the card's trimmed
 * `name` from its payload, or the card id (the file stem) when the payload
 * has none — the same derivation the spawn uses for the entity's name, so
 * the hash input and the world's name agree on one card (CHG-2).
 * @param {{name?: string}|null|undefined} card
 * @param {string} cardId
 * @returns {string}
 */
export function effectiveCardName(card, cardId) {
    const name = card && typeof card.name === 'string' ? card.name.trim() : '';
    return name !== '' ? name : cardId;
}

/**
 * The full sidecar path for a card by its id (the file stem, no extension)
 * — the lookup the spawn uses, which knows the id but not the file name
 * (a card id IS its stem, by construction of `readCardFiles`).
 * @param {string} cardDir
 * @param {string} cardId
 * @returns {string}
 */
export function sidecarPathForId(cardDir, cardId) {
    return path.join(cardDir, `${cardId}${SIDECAR_SUFFIX}`);
}

/**
 * Read a card's judged relationship only when it is still FRESH — the
 * freshness rule the judgment command applies to its own records (P-1):
 * the record exists, carries the current `SIDECAR_VERSION`, its
 * `personaHash` still matches the card on disk (name + effective persona),
 * and its `relationship` is well-formed (a non-empty label and a non-empty
 * summary). Anything else degrades to `null` — a missing file is the normal
 * state (no judgment yet), and a stale or malformed record is treated as
 * "no judgment", never served and never fatal (P-7).
 * @param {string} cardDir
 * @param {string} cardId
 * @param {{name?: string, personality?: string, description?: string}|null} card -
 *   the card's embedded payload (null when the file is unreadable).
 * @returns {{cardId: string, name: string, label: string, summary: string, judgedAt: string|null}|null}
 */
export function readFreshCardUserRelationship(cardDir, cardId, card) {
    const record = readCardUserRelationshipFile(sidecarPathForId(cardDir, cardId));
    if (!record || record.version !== SIDECAR_VERSION) return null;
    const name = effectiveCardName(card, cardId);
    if (typeof record.personaHash !== 'string' || record.personaHash !== personaHashFor(name, effectivePersonaFor(card))) {
        return null;
    }
    const rel = record.relationship;
    if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return null;
    if (typeof rel.label !== 'string' || rel.label.trim() === '') return null;
    if (typeof rel.summary !== 'string' || rel.summary.trim() === '') return null;
    return {
        cardId: typeof record.cardId === 'string' && record.cardId !== '' ? record.cardId : cardId,
        name: typeof record.name === 'string' && record.name.trim() !== '' ? record.name : name,
        label: rel.label,
        summary: rel.summary,
        judgedAt: typeof record.judgedAt === 'string' ? record.judgedAt : null
    };
}

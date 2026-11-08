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
 * @module src/utils/CardRelationshipStore
 */

import fs from 'node:fs';
import path from 'node:path';
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

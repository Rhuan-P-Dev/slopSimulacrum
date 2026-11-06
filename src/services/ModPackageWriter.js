/**
 * ModPackageWriter — puts the bytes of ONE data-only mod package on disk.
 *
 * OWNS: the package directory (`data/mods/<id>/`), its `mod.json` manifest and one
 * `<kind>.json` per declared kind, the id rules that decide whether a name may
 * become a directory at all, and the timestamped backup of every file an overwrite
 * replaces.
 *
 * WHAT THIS DOES NOT DO. It reads nothing about the live world, it validates
 * nothing about the definitions inside the content (that is
 * `WorldProposalValidator`, and behind it the same `CompositionClassifier` the plan
 * uses), and it does not enable, order or apply anything — `ModService` owns those,
 * and a definition swap still only happens at the round boundary
 * (`wiki/decisions/mod-system.md`, decision 4). Writing a package and changing the
 * world are two separate acts, and keeping them in two modules is what lets an
 * operator write a package from a running world without the world moving.
 *
 * EVERY DISK TOUCH GOES THROUGH THE DATA SEAM (`CR B-3`): `DataLoader.saveJson`
 * (atomic tmp-then-rename, `P-3`), `DataLoader.copyFile` (backups),
 * `DataLoader.ensureDir` (the directory, added to the seam for exactly this
 * reason). This module imports no `fs`.
 *
 * AN ID IS A PATH SEGMENT HERE, SO IT IS CHECKED BEFORE ANY PATH IS BUILT
 * (`SEC-7`): `MOD_ID_PATTERN` is one conservative segment, and the reserved
 * `core-` prefix is refused. A package written by this module is therefore always
 * a drop-in next to the shipped content, never the shipped content itself.
 *
 * UNSAFE KEYS REFUSE THE WRITE BEFORE THE FILE IS WRITTEN. `__proto__`,
 * `constructor` and `prototype` are not data (`ModLoader` refuses the whole package
 * when it finds one); catching it here turns "the rescan rejected it later" into a
 * named error at the moment of the write.
 *
 * @module ModPackageWriter
 */

import DataLoader from '../utils/DataLoader.js';
import Logger from '../utils/Logger.js';
import { GameError } from '../utils/CustomErrors.js';
import { isRegistryKind, REGISTRY_KIND_LIST } from '../../shared/RegistryKinds.js';
import {
    MANIFEST_FILE,
    MOD_BASE_DIR,
    MOD_ID_PATTERN,
    OFFICIAL_ID_PREFIX
} from './ModLoader.js';

/** Keys that are never data, at any depth (`ModLoader` UNSAFE_KEYS, same rule). */
const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** Machine-readable codes for everything this module refuses. */
export const PACKAGE_WRITE_ERROR_CODES = Object.freeze({
    ID_INVALID: 'MOD_PACKAGE_ID_INVALID',
    ID_RESERVED: 'MOD_PACKAGE_RESERVED_ID',
    CONTENT_INVALID: 'MOD_PACKAGE_CONTENT_INVALID',
    KIND_UNKNOWN: 'MOD_PACKAGE_KIND_UNKNOWN',
    KIND_EMPTY: 'MOD_PACKAGE_KIND_EMPTY',
    UNSAFE_KEY: 'MOD_PACKAGE_UNSAFE_KEY',
    TOO_LARGE: 'MOD_PACKAGE_TOO_LARGE'
});

/** The manifest version a written package carries when none is given. */
export const DEFAULT_PACKAGE_VERSION = '1.0.0';

/**
 * The ceiling on what one write may put on disk. A package is a definition set, not
 * a log (`P-8`); a proposal this big is a defect of the caller, not a large world.
 * Named here because this is the module that pays for it (`A-7`, `SEC-2`).
 */
export const MAX_PACKAGE_BYTES = 200_000;

/**
 * True when `value` is a plain object — the only shape that is a registry patch.
 * Arrays and `null` are values, not patches (`ModLoader.mergeRegistryPatch` says
 * the same thing from the other side).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The first unsafe key anywhere in `value`, or null when there is none.
 * @param {unknown} value
 * @param {string} at - the location being walked, for the error message
 * @returns {string|null}
 */
function findUnsafeKey(value, at) {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const hit = findUnsafeKey(value[i], `${at}[${i}]`);
            if (hit) return hit;
        }
        return null;
    }
    if (!isPlainObject(value)) return null;
    for (const [key, child] of Object.entries(value)) {
        if (UNSAFE_KEYS.includes(key)) return `${at}/${key}`;
        const hit = findUnsafeKey(child, `${at}/${key}`);
        if (hit) return hit;
    }
    return null;
}

export class ModPackageWriter {
    /**
     * @param {Object} [options]
     * @param {typeof DataLoader} [options.dataLoader] - The data seam (injectable so
     *   a test can watch the writes; it is still the seam, not a fake filesystem).
     * @param {string} [options.baseDir] - Where packages live, relative to the
     *   project root. Defaults to the real `data/mods`.
     * @param {() => number} [options.backupStamp] - Backup suffix (`D-1`: a test
     *   that asserts a backup path asks for the clock, it does not read it).
     */
    constructor({ dataLoader = DataLoader, baseDir = MOD_BASE_DIR, backupStamp = null } = {}) {
        this.dataLoader = dataLoader;
        this.baseDir = baseDir;
        this.backupStamp = backupStamp ?? (() => Date.now());
    }

    /**
     * The package directory, relative to the project root. Only ever called with an
     * id that passed `_assertPackageId`.
     * @param {string} id
     * @returns {string}
     */
    packageDir(id) {
        return `${this.baseDir}/${id}`;
    }

    /**
     * The manifest of an installed package, or null when it has none / cannot be read.
     * Read through the seam, so "does this package exist" never needs an `fs` call.
     * @param {string} id - A package id (already validated by the caller).
     * @returns {Object|null}
     */
    readManifest(id) {
        const manifestPath = `${this.packageDir(id)}/${MANIFEST_FILE}`;
        if (!this.dataLoader.exists(manifestPath)) return null;
        const manifest = this.dataLoader.loadJsonSafe(manifestPath, null);
        return isPlainObject(manifest) ? manifest : null;
    }

    /**
     * True when a package directory with this id already holds a manifest.
     * @param {string} id
     * @returns {boolean}
     */
    exists(id) {
        return this.readManifest(id) !== null;
    }

    /**
     * Write (or rewrite) one package: the manifest plus one file per declared kind.
     *
     * The whole write is validated BEFORE the first byte, so a package that fails a
     * rule leaves nothing half-written. Files are written kind by kind, each atomically
     * (`P-3`); a package is a set of files, and an interrupted write is a package the
     * rescan rejects whole (`MOD_CONTENT_UNREADABLE`) rather than a world that boots
     * half a definition — the same failure model the loader already reports.
     *
     * An overwrite backs up every file it replaces first, so a re-write of the same
     * package is undoable by hand (the precedent is `AgentBodyController.saveDesign`).
     *
     * @param {Object} packageSpec
     * @param {string} packageSpec.id - Package id, one `MOD_ID_PATTERN` segment, not `core-*`.
     * @param {string} [packageSpec.version] - Manifest version.
     * @param {string} [packageSpec.description] - What the package is for (manifest prose).
     * @param {Object.<string, Object>} packageSpec.content - kind id -> the definitions that kind receives.
     * @returns {{ saved: true, packageId: string, dir: string, version: string, description: string,
     *   content: Array<string>, files: Array<string>, created: boolean, overwritten: Array<string>,
     *   backups: Array<string> }}
     * @throws {GameError} one of `PACKAGE_WRITE_ERROR_CODES`.
     */
    writePackage(packageSpec = {}) {
        const { id, version = DEFAULT_PACKAGE_VERSION, description = '', content } = packageSpec;
        this._assertPackageId(id);
        const normalizedContent = this._assertContent(id, content);
        const kinds = REGISTRY_KIND_LIST.filter((kind) => kind in normalizedContent);

        const previous = this.readManifest(id);
        const payload = {};
        let bytes = 0;
        for (const kind of kinds) {
            const serialized = JSON.stringify(normalizedContent[kind], null, 2) + '\n';
            bytes += serialized.length;
            payload[kind] = normalizedContent[kind];
        }
        if (bytes > MAX_PACKAGE_BYTES) {
            throw new GameError(
                `ModPackageWriter: package "${id}" would write ${bytes} bytes, over the ${MAX_PACKAGE_BYTES} limit`,
                PACKAGE_WRITE_ERROR_CODES.TOO_LARGE
            );
        }

        this.dataLoader.ensureDir(this.packageDir(id));

        const files = [];
        const backups = [];
        const overwritten = [];
        for (const kind of kinds) {
            const target = `${this.packageDir(id)}/${kind}.json`;
            if (this.dataLoader.exists(target)) {
                overwritten.push(kind);
                const backupPath = `${target}.bak-${this.backupStamp()}`;
                this.dataLoader.copyFile(target, backupPath);
                backups.push(backupPath);
            }
            this.dataLoader.saveJson(target, payload[kind]);
            files.push(target);
        }

        const manifest = { id, version, content: kinds };
        if (typeof description === 'string' && description.trim().length > 0) {
            manifest.description = description.trim();
        }
        this.dataLoader.saveJson(`${this.packageDir(id)}/${MANIFEST_FILE}`, manifest);
        files.push(`${this.packageDir(id)}/${MANIFEST_FILE}`);

        Logger.info(
            `[ModPackageWriter] package "${id}" written: ${kinds.length} kind(s), `
            + `${files.length} file(s)${overwritten.length ? `, ${overwritten.length} overwritten (backed up)` : ''}`
            + `; not applied — the world still runs its current definition`
        );

        return Object.freeze({
            saved: true,
            packageId: id,
            dir: this.packageDir(id),
            version: manifest.version,
            description: manifest.description ?? '',
            content: kinds,
            files,
            created: previous === null,
            overwritten,
            backups
        });
    }

    // ================================================================
    // Validation of the write contract (not of the definitions)
    // ================================================================

    /**
     * A package id is one conservative path segment and never an official one.
     * @private
     * @param {unknown} id
     * @throws {GameError} ID_INVALID | ID_RESERVED
     */
    _assertPackageId(id) {
        if (typeof id !== 'string' || !MOD_ID_PATTERN.test(id)) {
            throw new GameError(
                `ModPackageWriter: "${id}" is not a package id (one lowercase segment of letters, digits, dot, dash or underscore, 1-64 chars)`,
                PACKAGE_WRITE_ERROR_CODES.ID_INVALID
            );
        }
        if (id.startsWith(OFFICIAL_ID_PREFIX)) {
            throw new GameError(
                `ModPackageWriter: "${id}" claims the reserved "${OFFICIAL_ID_PREFIX}" prefix — shipped content is never written here`,
                PACKAGE_WRITE_ERROR_CODES.ID_RESERVED
            );
        }
    }

    /**
     * Narrow the content into a clone the writer owns: every key a known kind, every
     * kind a non-empty plain object of definitions, no unsafe key anywhere, and
     * JSON-serializable.
     *
     * The clone is not politeness: the caller keeps its object, and a writer that
     * mutates what it was handed would be a surprise at the proposal site (`A-6`).
     * @private
     * @param {string} id - named in every error
     * @param {unknown} content
     * @returns {Object.<string, Object>}
     * @throws {GameError} CONTENT_INVALID | KIND_UNKNOWN | KIND_EMPTY | UNSAFE_KEY
     */
    _assertContent(id, content) {
        if (!isPlainObject(content) || Object.keys(content).length === 0) {
            throw new GameError(
                `ModPackageWriter: package "${id}" needs a content object of { kind: definitions }`,
                PACKAGE_WRITE_ERROR_CODES.CONTENT_INVALID
            );
        }
        const cloned = {};
        for (const [kind, definitions] of Object.entries(content)) {
            if (!isRegistryKind(kind)) {
                throw new GameError(
                    `ModPackageWriter: package "${id}" declares "${kind}", which is not a registry kind`,
                    PACKAGE_WRITE_ERROR_CODES.KIND_UNKNOWN
                );
            }
            if (!isPlainObject(definitions) || Object.keys(definitions).length === 0) {
                throw new GameError(
                    `ModPackageWriter: kind "${kind}" in package "${id}" must hold at least one definition`,
                    PACKAGE_WRITE_ERROR_CODES.KIND_EMPTY
                );
            }
            const unsafe = findUnsafeKey(definitions, kind);
            if (unsafe) {
                throw new GameError(
                    `ModPackageWriter: package "${id}" carries the non-data key "${unsafe}"`,
                    PACKAGE_WRITE_ERROR_CODES.UNSAFE_KEY
                );
            }
            try {
                cloned[kind] = structuredClone(definitions);
            } catch (error) {
                throw new GameError(
                    `ModPackageWriter: kind "${kind}" in package "${id}" is not JSON-serializable`,
                    PACKAGE_WRITE_ERROR_CODES.CONTENT_INVALID,
                    error
                );
            }
        }
        return cloned;
    }
}

export default ModPackageWriter;

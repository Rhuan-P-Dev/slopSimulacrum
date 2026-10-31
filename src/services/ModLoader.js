/**
 * ModLoader — discovers mod packages, validates their manifests, and builds a
 * candidate world definition from them.
 *
 * WHAT A MOD IS. A directory under `data/mods/` holding a `mod.json` manifest
 * and, for every registry it contributes, a `<kind>.json` file whose contents
 * merge into that registry. A mod is DATA ONLY: no code is read, imported or
 * executed anywhere in this module (`wiki/decisions/mod-system.md`, decision 1).
 *
 * WHAT THIS COMPUTES AND NOTHING ELSE. Discovery, validation, ordering and
 * merge. It does not talk to the `RegistryStore`, does not write files, and does
 * not know what a round is. The pipeline that applies a candidate (validate ->
 * swap at the round boundary -> rescan -> broadcast) is a separate change, and
 * keeping this module free of that is what makes the merge logic testable
 * without a world.
 *
 * FAILURES ARE REPORTED, NEVER THROWN AT THE WORLD. A mod whose manifest is
 * broken, or whose content file is not JSON, is REJECTED and named in
 * `invalid[]`; the other mods still load. That is the model decision 6 chose:
 * the world always builds, and `GET /api/mods/:id/report` says what is missing.
 * A throw here would mean one bad directory in `data/mods/` can brick a server,
 * which is the failure mode the decision exists to remove.
 *
 * DETERMINISM. Directory listing is sorted, kinds are iterated in
 * `REGISTRY_KIND_LIST` order (never in manifest order), and mods are ordered by
 * ascending `loadOrder` with ties broken by id. Two runs over the same
 * directories produce byte-identical output (`D-*`).
 *
 * @module ModLoader
 */

import DataLoader from '../utils/DataLoader.js';
import Logger from '../utils/Logger.js';
import { GameError } from '../utils/CustomErrors.js';
import { REGISTRY_KIND_LIST, isRegistryKind } from '../../shared/RegistryKinds.js';

/** Where mod packages live, relative to the project root. */
export const MOD_BASE_DIR = 'data/mods';

/** The manifest file every mod package holds. */
export const MANIFEST_FILE = 'mod.json';

/**
 * A mod id is ONE path segment of a conservative alphabet. A slash, a dot-dot
 * segment or an absolute path is refused before any path is built from it
 * (`SEC-7`): the id comes from a file somebody else wrote.
 */
export const MOD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Reserved prefix. A mod whose id starts with it is OFFICIAL — shipped in this
 * repository. Official-ness is DERIVED from the id and never read from the
 * manifest, because a manifest is user content and cannot be trusted to
 * describe its own privileges (`decision 2`).
 */
export const OFFICIAL_ID_PREFIX = 'core-';

/** Load order applied to a mod the state file says nothing about. */
export const DEFAULT_LOAD_ORDER = 1000;

/** Stable machine-readable codes for everything this module can reject. */
export const MOD_ERROR_CODES = Object.freeze({
    MANIFEST_INVALID: 'MOD_MANIFEST_INVALID',
    MANIFEST_MISSING: 'MOD_MANIFEST_MISSING',
    CONTENT_UNREADABLE: 'MOD_CONTENT_UNREADABLE',
    CONTENT_KIND_UNKNOWN: 'MOD_CONTENT_KIND_UNKNOWN',
    ID_INVALID: 'MOD_ID_INVALID',
    ID_DIR_MISMATCH: 'MOD_ID_DIR_MISMATCH',
    RESERVED_ID: 'MOD_RESERVED_ID'
});

/**
 * The reserved prefix is a privilege, so a manifest may not lie about it. What
 * makes an id rejected (rather than merely reported) is a non-official package
 * claiming the prefix; that is reported as RESERVED_ID by the caller that knows
 * the repository's own ids, and `official` is always recomputed here.
 * @param {string} id
 * @returns {boolean}
 */
export function isOfficialModId(id) {
    return typeof id === 'string' && id.startsWith(OFFICIAL_ID_PREFIX);
}

/**
 * Narrow one parsed manifest into the shape the loader uses, or throw a
 * `GameError` carrying a `MOD_*` code.
 *
 * Field narrowing happens ONCE, here (`T-1`, `T-2`): everything downstream may
 * assume `id`, `version` and `content` are what they claim to be.
 *
 * @param {unknown} raw - Parsed `mod.json`.
 * @param {string} dirName - The directory the manifest was found in.
 * @returns {{ id: string, version: string, content: Array<string>, official: boolean }}
 * @throws {GameError} MOD_ID_INVALID | MOD_ID_DIR_MISMATCH | MOD_MANIFEST_INVALID
 */
export function parseManifest(raw, dirName) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new GameError(`${MANIFEST_FILE} must be a JSON object`, MOD_ERROR_CODES.MANIFEST_INVALID);
    }
    const { id, version, content } = raw;

    if (typeof id !== 'string' || !MOD_ID_PATTERN.test(id)) {
        throw new GameError(
            `mod id "${String(id)}" is not a single conservative path segment`,
            MOD_ERROR_CODES.ID_INVALID
        );
    }
    // The directory IS the id. Allowing a manifest to name a different one would
    // mean building paths from untrusted content, and would let two directories
    // claim the same identity.
    if (id !== dirName) {
        throw new GameError(
            `mod id "${id}" does not match its directory "${dirName}"`,
            MOD_ERROR_CODES.ID_DIR_MISMATCH
        );
    }
    if (typeof version !== 'string' || version.trim() === '') {
        throw new GameError(
            `mod "${id}" has no version string`,
            MOD_ERROR_CODES.MANIFEST_INVALID
        );
    }

    const contentList = Array.isArray(content) ? content : [];
    for (const kind of contentList) {
        if (!isRegistryKind(kind)) {
            // The whole vocabulary, not a "did you mean": kind ids are inherited from
            // the data file ids, so the concept rarely matches the name (entity
            // blueprints are the `npcs` kind) and no spelling distance closes that gap.
            // This message is read once, by a human installing a package, and naming the
            // ids is the shortest road to the right one.
            throw new GameError(
                `mod "${id}" declares content kind "${String(kind)}", which is not a registry kind. `
                + `Registry kinds: ${REGISTRY_KIND_LIST.join(', ')} (see GET /mods/kinds).`,
                MOD_ERROR_CODES.CONTENT_KIND_UNKNOWN
            );
        }
    }
    // Declared kinds are deduplicated and put in vocabulary order, so the merge
    // order does not depend on how the manifest happened to be written.
    const kinds = REGISTRY_KIND_LIST.filter((kind) => contentList.includes(kind));

    return Object.freeze({
        id,
        version,
        content: Object.freeze(kinds),
        // Derived, never trusted from the manifest (decision 2).
        official: isOfficialModId(id)
    });
}

/**
 * Order mods for loading: ascending `loadOrder`, ties broken by id so the order
 * is total (`D-*`). The state file is user-writable and can put two mods at the
 * same order; that must not make the world depend on `fs` readdir order.
 * @param {Array<{ manifest: { id: string }, loadOrder: number }>} mods
 * @returns {Array} A new array, sorted.
 */
export function sortModsForLoad(mods) {
    return [...mods].sort((a, b) => (a.loadOrder - b.loadOrder) || a.manifest.id.localeCompare(b.manifest.id));
}

/**
 * Field-level deep merge of one mod's patch onto an accumulated registry.
 *
 * Plain objects merge recursively; anything else (array, scalar, null) REPLACES.
 * So a mod that ships `{"knife": {"materials": {...}}}` changes the knife's
 * materials and keeps every other field of the knife, and a mod that ships
 * `{"knife": null}` removes it. No patch-op language (`decision 5`).
 *
 * @param {Object} target - Accumulated content (mutated; it is the candidate).
 * @param {Object} patch - What the mod declares for this kind.
 * @returns {Array<string>} The top-level keys this patch touched.
 */
export function mergeRegistryPatch(target, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return [];
    const touched = [];
    for (const [key, value] of Object.entries(patch)) {
        if (key.startsWith('_')) continue; // `_comment`-style metadata, as in the shipped files
        touched.push(key);
        const existing = target[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            // `existing` is this pipeline's own object (every first contribution is
            // deep-cloned in), so merging into it in place cannot corrupt a source.
            mergeNested(existing, value);
        } else {
            target[key] = deepClone(value);
        }
    }
    return touched;
}

/**
 * The only shape that merges: a plain object. Arrays are values (a mod replaces
 * a list, it does not append to one), and `null` is a value too — which is how a
 * mod deletes a definition.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursive half of `mergeRegistryPatch`: merges below the top-level key without
 * the metadata-skip rule (a `_`-prefixed key inside a definition is data, not a
 * file header).
 * @param {Object} target
 * @param {Object} patch
 */
function mergeNested(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        const existing = target[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            mergeNested(existing, value);
        } else {
            target[key] = deepClone(value);
        }
    }
}

/**
 * Structured copy so a candidate never aliases a parsed file the caller may
 * still hold (`T-8`: what is handed to the store is this pipeline's own object).
 * @param {any} value
 * @returns {any}
 */
function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(deepClone);
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item);
    return out;
}

export class ModLoader {
    /**
     * @param {Object} [options]
     * @param {string} [options.baseDir] - Where to look for packages (relative to
     *   the project root). Defaults to `data/mods`.
     * @param {Object.<string, {enabled?: boolean, loadOrder?: number}>} [options.state]
     *   Per-mod state (`data/mods/loadorder.json`). A mod absent from it is
     *   enabled at `DEFAULT_LOAD_ORDER`: installing a directory is what installs a
     *   mod, and the state file only ever overrides.
     */
    constructor(options = {}) {
        this.baseDir = options.baseDir ?? MOD_BASE_DIR;
        this.state = options.state ?? {};
    }

    /**
     * Look at `baseDir` and classify every entry.
     *
     * Returns the mods that loaded (`discovered`), the ones that did not
     * (`invalid`, each with a code and a reason), and nothing else. Applying
     * nothing is deliberate: the caller decides when a candidate becomes the
     * world (`POST /api/mods/rescan` calls this and changes nothing).
     * @returns {{ discovered: Array<Object>, invalid: Array<{ dir: string, code: string, message: string }> }}
     */
    discover() {
        const discovered = [];
        const invalid = [];

        for (const entry of DataLoader.listDir(this.baseDir)) {
            if (!entry.isDirectory || entry.name.startsWith('.')) continue;
            // Belt over the SEC-7 rule: a directory entry whose name is not a safe
            // segment can never be addressed, whatever its manifest claims.
            if (!MOD_ID_PATTERN.test(entry.name)) {
                invalid.push({
                    dir: entry.name,
                    code: MOD_ERROR_CODES.ID_INVALID,
                    message: `directory name "${entry.name}" is not a mod id`
                });
                continue;
            }

            const manifestPath = `${this.baseDir}/${entry.name}/${MANIFEST_FILE}`;
            let manifest;
            try {
                manifest = parseManifest(DataLoader.loadJson(manifestPath), entry.name);
            } catch (error) {
                invalid.push({
                    dir: entry.name,
                    code: error.code || MOD_ERROR_CODES.MANIFEST_INVALID,
                    message: error.message
                });
                continue;
            }

            // No duplicate-id check: a manifest's id must equal its directory
            // (parseManifest), and directories are unique by construction, so one
            // identity can only be claimed once. A guard here would be unreachable.
            const state = this.state[manifest.id] ?? {};
            discovered.push({
                manifest,
                dir: entry.name,
                enabled: state.enabled !== false,
                loadOrder: typeof state.loadOrder === 'number' ? state.loadOrder : DEFAULT_LOAD_ORDER
            });
        }

        return { discovered: sortModsForLoad(discovered), invalid };
    }

    /**
     * Build the candidate world definition from a discovered mod list.
     *
     * Only ENABLED mods contribute. For each kind, mods apply in load order and
     * each one deep-merges onto what came before, last writer winning per
     * top-level key (`decision 5`). Every key a later mod overwrote is recorded
     * in `shadowed` with both owners — shadowing is reported, never silent.
     *
     * A content file that cannot be read, or is not a JSON object, does not stop
     * the build: that one mod contributes nothing for that kind and is named in
     * `invalid`. The alternative — throwing — is a missing file bricking the world.
     *
     * @param {Array<Object>} [mods] - Result of `discover()` when omitted.
     * @returns {{ registries: Object.<string, Object>, providers: Object.<string, Array<string>>, shadowed: Array<Object>, invalid: Array<Object> }}
     */
    build(mods) {
        const modList = mods ?? this.discover().discovered;
        const registries = {};
        const providers = {};
        const shadowed = [];
        const invalid = [];

        for (const kind of REGISTRY_KIND_LIST) {
            registries[kind] = {};
            providers[kind] = [];
        }

        for (const mod of sortModsForLoad(modList)) {
            if (mod.enabled === false) continue;
            for (const kind of mod.manifest.content) {
                const contentPath = `${this.baseDir}/${mod.dir}/${kind}.json`;
                let patch;
                try {
                    patch = DataLoader.loadJson(contentPath);
                } catch (error) {
                    invalid.push({
                        dir: mod.dir,
                        modId: mod.manifest.id,
                        kind,
                        code: MOD_ERROR_CODES.CONTENT_UNREADABLE,
                        message: error.message
                    });
                    continue;
                }
                if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
                    invalid.push({
                        dir: mod.dir,
                        modId: mod.manifest.id,
                        kind,
                        code: MOD_ERROR_CODES.CONTENT_UNREADABLE,
                        message: `${contentPath} is not a JSON object`
                    });
                    continue;
                }

                const target = registries[kind];
                const previousOwners = {};
                for (const key of Object.keys(patch)) {
                    if (key in target) previousOwners[key] = providers[kind].at(-1) ?? null;
                }
                providers[kind].push(mod.manifest.id);
                for (const key of mergeRegistryPatch(target, patch)) {
                    if (previousOwners[key] && previousOwners[key] !== mod.manifest.id) {
                        shadowed.push({
                            kind,
                            key,
                            from: previousOwners[key],
                            to: mod.manifest.id
                        });
                    }
                }
            }
        }

        if (shadowed.length > 0) {
            Logger.info(`[ModLoader] ${shadowed.length} definition(s) shadowed by load order`);
        }
        return { registries, providers, shadowed, invalid };
    }
}

export default ModLoader;

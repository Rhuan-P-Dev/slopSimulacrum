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
 * the world always builds, and `GET /mods/:id/report` says what is missing.
 * A throw here would mean one bad directory in `data/mods/` can brick a server,
 * which is the failure mode the decision exists to remove.
 *
 * AN UNSAFE KEY REFUSES THE WHOLE PACKAGE. `__proto__`, `constructor` and `prototype` are
 * not data and never become definitions (`UNSAFE_KEYS` below). A content file that carries
 * one is a defect of the package, not of that one file, so the package contributes nothing
 * and every one of its kinds is named in `invalid` — half-installing a package somebody
 * poisoned would ship the half that was not refused.
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

/**
 * Keys that are never a definition, and never data.
 *
 * WHY THESE THREE. `JSON.parse` creates an OWN enumerable `__proto__` key, so a mod file can
 * carry one, and `target["__proto__"]` then answers `Object.prototype` instead of
 * `undefined`. A recursive merge that asks "does this key already exist, and is it an
 * object?" therefore gets "yes" — and merges into the ancestor of every object in the
 * process. A package of pure data would change program-wide semantics without executing a
 * line of code, which is exactly what `wiki/decisions/mod-system.md` decision 1 promises is
 * impossible. `constructor` and `prototype` are refused with it because they reach the same
 * objects by other routes.
 *
 * THE CHECK IS ON THE KEY, NOT ON THE VALUE. Hardening `isPlainObject` instead does not
 * work: `Object.getPrototypeOf(Object.prototype)` is `null`, so the intuitive "a plain
 * object is one whose prototype is `Object.prototype` or `null`" test still accepts
 * `Object.prototype`, and the recursion walks straight into it.
 *
 * This is not a generalisation of the metadata skip. `mergeRegistryPatch` drops top-level
 * `_`-prefixed keys for `_comment`-style headers, which happened to reject a top-level
 * `__proto__` by coincidence; `mergeNested` drops that rule on purpose, because a `_`-prefixed
 * key inside a definition is data. This guard is the rule; the metadata skip is not one.
 */
const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** Stable machine-readable codes for everything this module can reject. */
export const MOD_ERROR_CODES = Object.freeze({
    MANIFEST_INVALID: 'MOD_MANIFEST_INVALID',
    MANIFEST_MISSING: 'MOD_MANIFEST_MISSING',
    CONTENT_UNREADABLE: 'MOD_CONTENT_UNREADABLE',
    CONTENT_KIND_UNKNOWN: 'MOD_CONTENT_KIND_UNKNOWN',
    ID_INVALID: 'MOD_ID_INVALID',
    ID_DIR_MISMATCH: 'MOD_ID_DIR_MISMATCH',
    RESERVED_ID: 'MOD_RESERVED_ID',
    // `requires` written wrong (a field of the manifest, so the manifest codes cover it):
    REQUIRES_INVALID: 'MOD_REQUIRES_INVALID',
    REQUIRES_SELF: 'MOD_REQUIRES_SELF',
    // `requires` written right but not satisfiable in this install (a state of the world,
    // not of the file, so they are reported and never fatal):
    REQUIREMENT_HELD: 'MOD_REQUIREMENT_HELD',
    REQUIREMENT_UNMET: 'MOD_REQUIREMENT_UNMET',
    REQUIREMENT_MISSING: 'MOD_REQUIREMENT_MISSING',
    REQUIREMENT_DISABLED: 'MOD_REQUIREMENT_DISABLED',
    REQUIREMENT_BLOCKED: 'MOD_REQUIREMENT_BLOCKED',
    // A content file carrying a key that is never data (`UNSAFE_KEYS`). Not a parse failure:
    // the file is readable and is valid JSON, which is what makes it worth naming.
    UNSAFE_KEY: 'MOD_UNSAFE_KEY',
    // Reordering the stack (`ModService.moveMod`). All three are a conflict with the shape of
    // the install, not with the request: the packages are readable and the move is well
    // formed, the stack simply will not take it.
    MOVE_DIRECTION_INVALID: 'MOD_MOVE_DIRECTION_INVALID',
    MOVE_AT_EDGE: 'MOD_MOVE_AT_EDGE',
    MOVE_BREAKS_REQUIRES: 'MOD_MOVE_BREAKS_REQUIRES'
});

/**
 * How many unsafe-key findings one build reports. A poisoned file can carry thousands, and a
 * report that grows with the payload is not a report (`A-7`); when the cap is hit the
 * message says so instead of going quiet.
 */
const MAX_UNSAFE_KEY_REPORTS = 10;

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
 * @returns {{ id: string, version: string, content: Array<string>, requires: Array<string>,
 *   description: string, official: boolean }}
 * @throws {GameError} MOD_ID_INVALID | MOD_ID_DIR_MISMATCH | MOD_MANIFEST_INVALID
 */
export function parseManifest(raw, dirName) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new GameError(`${MANIFEST_FILE} must be a JSON object`, MOD_ERROR_CODES.MANIFEST_INVALID);
    }
    const { id, version, content, requires, description } = raw;

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

    const summary = parseDescription(description, id);

    return Object.freeze({
        id,
        version,
        content: Object.freeze(kinds),
        // The author's own sentence about the package. Prose, not a load-bearing field:
        // absent means "nobody wrote one", which the operator is told rather than shown
        // as a blank hole. A present value is narrowed to a string here, because past
        // this point it becomes a text node in somebody's browser.
        description: summary,
        // Package ids this package's content references definitions from. Declared by the
        // author, narrowed here, and the only input to `resolveRequirements`.
        requires: Object.freeze(parseRequires(requires, id)),
        // Derived, never trusted from the manifest (decision 2).
        official: isOfficialModId(id)
    });
}

/**
 * Narrow `description` to a string, or say why it cannot be one.
 *
 * Absent stays absent-as-nothing (`''`): the manifest is one file per package and a
 * package that only moves data files need no blurb. A present non-string is a manifest
 * bug and is rejected at the one place fields are narrowed (`T-1`), instead of arriving
 * downstream as `[object Object]`.
 *
 * @param {unknown} description - The declared field.
 * @param {string} id - The package it was written in, for the message.
 * @returns {string}
 * @throws {GameError} MOD_MANIFEST_INVALID
 */
function parseDescription(description, id) {
    if (description === undefined || description === null) return '';
    if (typeof description !== 'string') {
        throw new GameError(
            `mod "${id}" has a "description" that is not a string`,
            MOD_ERROR_CODES.MANIFEST_INVALID
        );
    }
    return description.trim();
}

/**
 * Narrow `requires` to a sorted, deduplicated list of mod ids.
 *
 * Absent means "requires nothing", which is the common case and must stay writable as
 * nothing at all - a manifest is one file per package and every required field is one more
 * thing an author gets wrong.
 *
 * @param {unknown} requires - The declared field.
 * @param {string} id - The requiring package, for the self-reference check.
 * @returns {Array<string>}
 * @throws {GameError} MOD_MANIFEST_INVALID | MOD_REQUIRES_INVALID | MOD_REQUIRES_SELF
 */
function parseRequires(requires, id) {
    if (requires === undefined) return [];
    if (!Array.isArray(requires)) {
        throw new GameError(
            `mod "${id}" has a "requires" that is not an array of mod ids`,
            MOD_ERROR_CODES.MANIFEST_INVALID
        );
    }
    for (const dep of requires) {
        if (typeof dep !== 'string' || !MOD_ID_PATTERN.test(dep)) {
            throw new GameError(
                `mod "${id}" requires "${String(dep)}", which is not a mod id`,
                MOD_ERROR_CODES.REQUIRES_INVALID
            );
        }
        // A package requiring itself is not a dependency, it is a typo - and it is the one
        // cycle that can never be satisfied by anything else being enabled.
        if (dep === id) {
            throw new GameError(`mod "${id}" requires itself`, MOD_ERROR_CODES.REQUIRES_SELF);
        }
    }
    // Sorted, not manifest order: what contributes must not depend on how the file happens
    // to be written (`D-*`).
    return [...new Set(requires)].sort();
}

/**
 * Decide which discovered packages may contribute, from their declared `requires`.
 *
 * A requirement is satisfied when the required package is installed, enabled, and itself
 * contributing - so disabling one package cascades to whatever references its definitions,
 * which is the honest answer and the one that keeps the world buildable. A disabled
 * package's dependents are reported, not silently dropped.
 *
 * The fixpoint starts from "everything is satisfied" and only ever removes, on purpose:
 * two packages that require each other and are both installed and enabled stay satisfied,
 * exactly as they should - mutual requirement is normal here (`core-components` and
 * `core-internal-components` reference each other's definitions), so a cycle is not an
 * error and must not be treated as one. Only a requirement that cannot be met - not
 * installed, or disabled, or blocked through the chain - removes a package.
 *
 * Entries get `blocked: null` or `blocked: { code, message }`; the array is returned for
 * chaining.
 * @param {Array<{ manifest: { id: string, requires: Array<string> }, enabled: boolean }>} discovered
 * @returns {Array<Object>} the same entries, each with `blocked` set
 */
export function resolveRequirements(discovered) {
    const byId = new Map(discovered.map((mod) => [mod.manifest.id, mod]));
    // Start satisfied; disabled packages start not. Iterating to a stable state over this
    // monotone removal is the fixpoint, and it terminates: each pass can only turn
    // satisfied into unsatisfied, never the reverse.
    const contributing = new Map(
        discovered.map((mod) => [mod.manifest.id, mod.enabled !== false])
    );
    /** @type {Map<string, { code: string, message: string }>} first reason wins, for the report */
    const reasons = new Map();

    let changed = true;
    while (changed) {
        changed = false;
        for (const mod of discovered) {
            if (!contributing.get(mod.manifest.id)) continue;
            for (const dep of mod.manifest.requires) {
                const required = byId.get(dep);
                if (!required) {
                    reasons.set(mod.manifest.id, {
                        code: MOD_ERROR_CODES.REQUIREMENT_MISSING,
                        message: `requires "${dep}", which is not installed`
                    });
                } else if (!contributing.get(dep)) {
                    // The sentence leads with the closest break - that is what the operator
                    // acts on - and keeps the root cause in parentheses, so the chain is
                    // still readable without being the headline.
                    const requiredReason = reasons.get(dep);
                    reasons.set(mod.manifest.id, requiredReason
                        ? {
                            code: MOD_ERROR_CODES.REQUIREMENT_BLOCKED,
                            message: `requires "${dep}", which cannot contribute (${requiredReason.message})`
                        }
                        : {
                            code: MOD_ERROR_CODES.REQUIREMENT_DISABLED,
                            message: `requires "${dep}", which is disabled`
                        });
                } else {
                    continue;
                }
                contributing.set(mod.manifest.id, false);
                changed = true;
                break;
            }
        }
    }

    // `blocked` names a requirement that cannot be met. A package that is simply disabled
    // is not blocked - `enabled: false` already says what happened, and a second word for
    // the same fact is how a report starts disagreeing with itself.
    for (const mod of discovered) {
        mod.blocked = reasons.get(mod.manifest.id) ?? null;
    }
    return discovered;
}

/**
 * The packages that may contribute: enabled, and with every requirement met.
 * @param {Array<Object>} discovered
 * @returns {Array<Object>}
 */
export function contributingMods(discovered) {
    return discovered.filter((mod) => mod.enabled !== false && !mod.blocked);
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
 * Is this key one that must never be written, read as an existing object, or cloned?
 * @param {unknown} key
 * @returns {boolean}
 */
function isUnsafeKey(key) {
    return typeof key === 'string' && UNSAFE_KEYS.includes(key);
}

/**
 * Walk one parsed content file and name every unsafe key it carries, before any of it is
 * merged. This is the edge (`SEC-2`): the file is user content, and the merge below is the
 * mechanism an unsafe key would exploit.
 *
 * Iterative rather than recursive — this walks a file nobody has validated, and a recursive
 * descent here would add a stack-overflow surface of its own — and breadth-first, so when the
 * cap is reached it drops the deepest findings and the operator is shown the shallowest, most
 * likely deliberate ones first. A finding is the key plus its location, with `$` as the file
 * root, so `$.knife.detail.__proto__` names the definition that hid it. Findings are capped at
 * `MAX_UNSAFE_KEY_REPORTS` and `truncated` says so.
 *
 * @param {unknown} value - Parsed `<kind>.json`.
 * @returns {{ found: Array<{ key: string, at: string }>, truncated: boolean }}
 */
function findUnsafeKeys(value) {
    const found = [];
    const queue = [{ node: value, at: '$' }];
    while (queue.length > 0) {
        const { node, at } = queue.shift();
        if (node === null || typeof node !== 'object') continue;
        for (const key of Object.keys(node)) {
            // Never read `node[key]` for these: reading `__proto__` is how a merge gets
            // `Object.prototype` in the first place.
            if (isUnsafeKey(key)) {
                if (found.length >= MAX_UNSAFE_KEY_REPORTS) return { found, truncated: true };
                found.push({ key, at: `${at}.${key}` });
                continue;
            }
            const child = node[key];
            if (child !== null && typeof child === 'object') {
                queue.push({ node: child, at: `${at}.${key}` });
            }
        }
    }
    return { found, truncated: false };
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
        if (isUnsafeKey(key)) continue;    // never a definition: see UNSAFE_KEYS
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
        if (isUnsafeKey(key)) continue; // `target[key]` answers a prototype, not `undefined`
        const existing = target[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            mergeNested(existing, value);
        } else {
            target[key] = deepClone(value);
        }
    }
}

/**
 * Why a package was refused for an unsafe key, in one line.
 *
 * The kind that carries the key names where it is; a clean kind of the same package names
 * the file that did it, so no kind of a refused package reads as silently accepted.
 * @param {string} modId
 * @param {Object} entry - The kind being reported (`{ kind, scan? }`).
 * @param {Array<Object>} poisoned - The kinds of that package which carried a key.
 * @returns {string}
 */
function unsafePackageMessage(modId, entry, poisoned) {
    const located = (item) => `${item.kind}.json: ${item.scan.found.map((hit) => hit.at).join(', ')}`;
    if (entry.scan) {
        const more = entry.scan.truncated ? ' (further occurrences not listed)' : '';
        return `unsafe key at ${entry.scan.found.map((hit) => hit.at).join(', ')}${more}; `
            + `package "${modId}" is skipped entirely`;
    }
    return `package "${modId}" is skipped entirely: ${poisoned.map(located).join('; ')}`;
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
    for (const [key, item] of Object.entries(value)) {
        if (isUnsafeKey(key)) continue; // assigning it would SET the clone's prototype
        out[key] = deepClone(item);
    }
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
     * world (`POST /mods/rescan` calls this and changes nothing).
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
                loadOrder: typeof state.loadOrder === 'number' ? state.loadOrder : DEFAULT_LOAD_ORDER,
                // Set by resolveRequirements below: null, or the requirement that cannot be
                // met. Written here so every entry has the field, whatever resolved it.
                blocked: null
            });
        }

        // Requirements are resolved over the full set, after sorting, so the answer does not
        // depend on readdir order.
        return { discovered: resolveRequirements(sortModsForLoad(discovered)), invalid };
    }

    /**
     * Read and classify one package's content files WITHOUT merging any of them.
     *
     * Reading is separated from merging because a refusal decided after the merge cannot be
     * undone: `mergeRegistryPatch` mutates the accumulated candidate in place. So every file
     * of the package is read first, and only a package with nothing refused is merged.
     *
     * Each entry is one kind, in manifest (vocabulary) order: `{ kind, patch }` when usable,
     * `{ kind, defect }` when it cannot be read or is not a JSON object, and
     * `{ kind, patch, scan }` when it carries an unsafe key.
     * @param {Object} mod - A discovered package.
     * @returns {Array<Object>} one entry per content kind.
     */
    _readPackage(mod) {
        const entries = [];
        for (const kind of mod.manifest.content) {
            const contentPath = `${this.baseDir}/${mod.dir}/${kind}.json`;
            let patch;
            try {
                patch = DataLoader.loadJson(contentPath);
            } catch (error) {
                entries.push({
                    kind,
                    defect: { code: MOD_ERROR_CODES.CONTENT_UNREADABLE, message: error.message }
                });
                continue;
            }
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
                entries.push({
                    kind,
                    defect: {
                        code: MOD_ERROR_CODES.CONTENT_UNREADABLE,
                        message: `${contentPath} is not a JSON object`
                    }
                });
                continue;
            }
            const scan = findUnsafeKeys(patch);
            entries.push(scan.found.length > 0 ? { kind, patch, scan } : { kind, patch });
        }
        return entries;
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
     * A package whose `requires` cannot be met contributes nothing either, and is named in
     * `blocked` with the requirement that broke: shipping half a package set is how a world
     * gets content that references definitions nobody provides.
     *
     * A content file carrying an unsafe key (`UNSAFE_KEYS`) refuses its whole package: the
     * key is a property of the package, not of the one file, and shipping the other half is
     * shipping what the poisoned half was meant to drag in. Every kind of that package is
     * named in `invalid`, and each finding is listed in `unsafeKeys` with its location.
     *
     * @param {Array<Object>} [mods] - Result of `discover()` when omitted.
     * @returns {{ registries: Object.<string, Object>, providers: Object.<string, Array<string>>, shadowed: Array<Object>, invalid: Array<Object>, blocked: Array<Object>, unsafeKeys: Array<Object> }}
     */
    build(mods) {
        const modList = mods ?? this.discover().discovered;
        const registries = {};
        const providers = {};
        const shadowed = [];
        const invalid = [];
        // Every unsafe key found, one entry per finding, in mod order then kind order.
        const unsafeKeys = [];
        // Requirement-blocked only. A package the operator switched off is not blocked and
        // does not belong in a report named after a failure - `enabled: false` is the record
        // of that decision.
        const blocked = modList.filter((mod) => mod.blocked).map((mod) => ({
            modId: mod.manifest.id,
            dir: mod.dir,
            code: mod.blocked.code,
            message: `${mod.manifest.id} ${mod.blocked.message}`,
            requires: mod.manifest.requires
        }));

        for (const kind of REGISTRY_KIND_LIST) {
            registries[kind] = {};
            providers[kind] = [];
        }

        for (const mod of sortModsForLoad(modList)) {
            // `enabled === false` is the operator's decision; `blocked` is the consequence of
            // a `requires` this install cannot satisfy. Either one keeps the content out.
            if (mod.enabled === false || mod.blocked) continue;

            const entries = this._readPackage(mod);
            const poisoned = entries.filter((entry) => entry.scan);
            if (poisoned.length > 0) {
                for (const entry of poisoned) {
                    for (const hit of entry.scan.found) {
                        unsafeKeys.push({
                            modId: mod.manifest.id,
                            dir: mod.dir,
                            kind: entry.kind,
                            key: hit.key,
                            at: hit.at
                        });
                    }
                }
                // One entry per kind of the refused package. A kind of it that is perfectly
                // fine contributed nothing either, and a silence here would read as an install.
                for (const entry of entries) {
                    if (entry.defect) {
                        invalid.push({
                            dir: mod.dir,
                            modId: mod.manifest.id,
                            kind: entry.kind,
                            ...entry.defect
                        });
                        continue;
                    }
                    invalid.push({
                        dir: mod.dir,
                        modId: mod.manifest.id,
                        kind: entry.kind,
                        code: MOD_ERROR_CODES.UNSAFE_KEY,
                        message: unsafePackageMessage(mod.manifest.id, entry, poisoned)
                    });
                }
                continue;
            }

            for (const entry of entries) {
                if (entry.defect) {
                    invalid.push({
                        dir: mod.dir,
                        modId: mod.manifest.id,
                        kind: entry.kind,
                        ...entry.defect
                    });
                    continue;
                }
                const { kind, patch } = entry;
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
        for (const entry of blocked) {
            Logger.warn(`[ModLoader] mod "${entry.modId}" contributes nothing: ${entry.message}`);
        }
        for (const entry of unsafeKeys) {
            Logger.warn(
                `[ModLoader] mod "${entry.modId}" refused: unsafe key "${entry.key}" at ${entry.at} ` +
                `(${entry.kind}) - a key of this name is never world data`
            );
        }
        return { registries, providers, shadowed, invalid, blocked, unsafeKeys };
    }
}

export default ModLoader;

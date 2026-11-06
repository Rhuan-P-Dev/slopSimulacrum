/**
 * RegistryStore — the owner of the live world definition.
 *
 * WHY THIS EXISTS. The world is built from one JSON registry per kind
 * (`shared/RegistryKinds.js`). Until now each
 * reader named a *path* (`'data/mods/core-components/components.json'`) and captured the
 * parsed object at construction time. That made the world definition immutable
 * in practice: swapping the data underneath a running server would leave the
 * six controllers that captured `actionRegistry` (and every controller that
 * pre-assembles derived state) serving the old world while the routes served
 * the new one. A half-applied world definition is worse than a restart,
 * because nothing reports it.
 *
 * WHAT THIS IS. One holder per registry kind, created once, read by kind, and
 * swapped as a single atomic step. The holder object identity NEVER changes:
 * `read(kind)` returns the same object for the life of the process, and
 * `replace()` changes its *contents* in one step. Construction-time readers
 * that captured `store.read(KIND)` therefore observe a swap without knowing
 * about it, which is the whole point of the identity rule.
 *
 * WHAT MUTATES IT. Only `replace()`, called by the mod pipeline at the round
 * boundary (`TurnSystemController._roundStart()`). This is deliberate mutation
 * with a single writer, not ambient mutation: `CODE_RULES.md` T-8 freezes
 * read-only tables precisely so that mutation is impossible to miss, and here
 * mutation is the contract, so the mutation site is one named method.
 *
 * WHAT THIS IS NOT. It is not a cache of file contents (the data seam reads
 * files; this holds their parsed result), it is not the world state (entities
 * live in their own controllers), and it does no I/O at all: the composition
 * root parses and hands the values over. That keeps this module testable
 * without a filesystem and keeps `B-3` undisturbed.
 *
 * @module RegistryStore
 */

import Logger from '../utils/Logger.js';
import DataLoader from '../utils/DataLoader.js';
import { GameError } from '../utils/CustomErrors.js';
import { REGISTRY_KIND_LIST, isRegistryKind } from '../../shared/RegistryKinds.js';

/**
 * Read one registry from a store when a store was injected, and from the data
 * seam when it was not.
 *
 * Controllers that pre-load a registry at construction take their collaborators
 * null-tolerantly (a hand-built facade in a test omits them), and this is the
 * same idiom applied to world definition: the production composition passes the
 * live `RegistryStore`, a test passes nothing and gets the same content read
 * from the file. The two are equivalent at boot; they differ the moment a mod
 * swaps a registry, which is exactly why the store is the one true source.
 *
 * @param {RegistryStore|null|undefined} registries - The injected store, if any.
 * @param {string} kind - A registry kind from `shared/RegistryKinds.js`.
 * @param {any} defaultValue - Seam fallback when the source is unreadable.
 * @returns {any} The registry content.
 */
export function readRegistryFrom(registries, kind, defaultValue = {}) {
    return registries ? registries.read(kind) : DataLoader.loadRegistry(kind, defaultValue);
}

/**
 * The top-level JSON shape every registry has. Verified against every shipped
 * registry: each is a plain object (never an array, never a scalar), which is
 * what makes the identity-preserving swap possible.
 * @param {unknown} value
 * @returns {boolean}
 */
function isRegistryShape(value) {
    return typeof value === 'object' && !Array.isArray(value);
}

/**
 * A registry whose source is absent, empty or `null` is an EMPTY part of the
 * world, not a broken one: that is how "this mod is disabled" is expressed.
 * Anything that is not a plain object (an array, a scalar, a string) is a
 * defect and throws, because reading it as empty would silently discard the
 * definitions somebody wrote.
 * @param {string} kind - the kind being installed, for the error message.
 * @param {unknown} content
 * @returns {Object} the content to hold.
 */
function normalizeRegistryContent(kind, content) {
    if (content === null || content === undefined) return {};
    if (!isRegistryShape(content)) {
        throw new GameError(
            `RegistryStore: content for kind "${kind}" must be a plain object`,
            'REGISTRY_CONTENT_INVALID'
        );
    }
    return content;
}

export class RegistryStore {
    /** @type {Map<string, Object>} kind -> the live holder object (identity never changes). */
    #holders = new Map();

    /** @type {number} Bumped once per accepted swap; the "which world am I running" counter. */
    #version = 1;

    /**
     * @param {Object.<string, Object>} initialRegistries - Parsed content per kind.
     *   A kind that is absent becomes an empty registry (`{}`): the world boots
     *   with that part missing and the mod report names it, rather than throwing.
     * @throws {GameError} REGISTRY_CONTENT_INVALID - a kind's content is not a
     *   plain object, or an unknown kind was handed over (a kind nobody can read).
     */
    constructor(initialRegistries = {}) {
        for (const [kind, content] of Object.entries(initialRegistries)) {
            if (!isRegistryKind(kind)) {
                throw new GameError(
                    `RegistryStore: unknown registry kind "${kind}"`,
                    'REGISTRY_KIND_UNKNOWN'
                );
            }
            this.#holders.set(kind, normalizeRegistryContent(kind, content));
        }
        for (const kind of REGISTRY_KIND_LIST) {
            if (!this.#holders.has(kind)) this.#holders.set(kind, {});
        }
    }

    /**
     * The live registry for one kind. The returned object is the holder, not a
     * copy: it is the same reference for the life of the process, and its
     * contents change only inside `replace()`.
     * @param {string} kind
     * @returns {Object} the live registry content.
     * @throws {GameError} REGISTRY_KIND_UNKNOWN - the kind is not in the vocabulary.
     */
    read(kind) {
        if (!isRegistryKind(kind)) {
            throw new GameError(
                `RegistryStore: unknown registry kind "${kind}"`,
                'REGISTRY_KIND_UNKNOWN'
            );
        }
        return this.#holders.get(kind);
    }

    /**
     * True when a kind has content (non-empty). Readers that degrade when a
     * part of the world is missing use this instead of testing truthiness.
     * @param {string} kind
     * @returns {boolean}
     */
    has(kind) {
        return Object.keys(this.read(kind)).length > 0;
    }

    /**
     * The swap counter. Two reads with the same version saw the same world
     * definition; it is what a report or a log line cites.
     * @returns {number}
     */
    version() {
        return this.#version;
    }

    /**
     * Definition counts per kind, for the mod list and for logs. Cheap: one
     * `Object.keys` per kind, no copies.
     * @returns {Object.<string, number>}
     */
    definitionCounts() {
        const counts = {};
        for (const kind of REGISTRY_KIND_LIST) {
            counts[kind] = Object.keys(this.#holders.get(kind)).length;
        }
        return counts;
    }

    /**
     * Atomically installs a new world definition.
     *
     * The swap is all-or-nothing per call: the candidate is validated in full
     * BEFORE anything is touched, so a candidate with one bad kind leaves every
     * registry exactly as it was. Nothing in the world is ever half-swapped.
     *
     * Every accepted swap is one version. There is no "it was already like
     * that" detection: content arrives freshly parsed from JSON every time, so
     * an identity comparison would never fire and a deep comparison would be
     * paid for on every apply. The version counts accepted swaps, which is what
     * a log line or a mod report needs to cite.
     *
     * @param {Object.<string, Object>} candidate - New content per kind. Kinds
     *   absent from the candidate keep their current content. `null` empties
     *   that registry, which is what disabling its mod looks like.
     * @returns {{ version: number, swappedKinds: Array<string> }} the new
     *   version and the kinds written by this swap.
     * @throws {GameError} REGISTRY_CANDIDATE_INVALID - the candidate is not a
     *   plain object, or one of its kinds has content that is neither a plain
     *   object nor null.
     * @throws {GameError} REGISTRY_KIND_UNKNOWN - the candidate carries a kind
     *   nobody can read.
     */
    replace(candidate = {}) {
        if (!isRegistryShape(candidate)) {
            throw new GameError(
                'RegistryStore.replace: candidate must be a plain object of kind -> content',
                'REGISTRY_CANDIDATE_INVALID'
            );
        }
        // Narrow the whole candidate before writing any of it. A throw here
        // means nothing in the world was touched.
        const resolved = {};
        for (const [kind, content] of Object.entries(candidate)) {
            if (!isRegistryKind(kind)) {
                throw new GameError(
                    `RegistryStore.replace: unknown registry kind "${kind}"`,
                    'REGISTRY_KIND_UNKNOWN'
                );
            }
            resolved[kind] = normalizeRegistryContent(kind, content);
        }

        const swappedKinds = Object.keys(resolved);
        if (swappedKinds.length === 0) {
            Logger.debug('[RegistryStore] replace accepted with nothing to swap');
            return { version: this.#version, swappedKinds };
        }

        for (const [kind, content] of Object.entries(resolved)) {
            const holder = this.#holders.get(kind);
            // The identity-preserving swap: empty the holder, then fill it with
            // the new definitions. Readers holding this reference see the new
            // world without being told, which is the contract of `read()`.
            for (const key of Object.keys(holder)) delete holder[key];
            Object.assign(holder, content);
        }

        this.#version += 1;
        Logger.info(
            `[RegistryStore] swapped to version ${this.#version}: ${swappedKinds.join(', ')}`
        );
        return { version: this.#version, swappedKinds };
    }
}

export default RegistryStore;

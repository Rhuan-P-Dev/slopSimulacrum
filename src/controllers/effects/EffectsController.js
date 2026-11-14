/**
 * EffectsController — layer-0 data owner of the effect DEFINITIONS (registry kind
 * `effects`, `data/mods/core-effects/effects.json`).
 *
 * WHAT THIS OWNS. The reading and the narrowing of effect definitions: what an
 * effect is called, what it targets, how long it lasts, how repeat applications
 * stack, and which operations it performs at application and per round. It is the
 * edge that `CR T-1`/`CR T-2` demand — a definition is validated once, here, and
 * nothing downstream re-checks that an op id exists or that `params.trait` is a
 * string.
 *
 * THE SHAPE IS COPIED FROM THE WORLD-RULES LAYER, deliberately
 * (`src/controllers/worldRules/WorldRulesController.js`): a static configuration
 * owner that never throws, because "nothing extra happens" is a complete world.
 * A missing or unreadable file means NO effects defined; an unknown rule key is
 * ignored; a malformed entry disables THAT entry with a warning and leaves the
 * rest live; a definition with an unknown operation id is disabled the same way.
 *
 * THE LINE BETWEEN A TYPO AND A BUG. A definition naming an operation this server
 * does not know is a DATA fault: disabled with a warning naming the id, so one
 * character in a third-party mod is never a crash vector. An operation that
 * passed this validation and then reaches the engine with no adapter is a CODE
 * fault and throws (`EffectEngine`), because that one is our bug and hiding it
 * would cost a debugging session.
 *
 * LIVE, NOT BOOT-TIME. Definitions are read from the injected `RegistryStore` when
 * one exists (and from the data seam when not), and the validated set is cached
 * against the store's version — the same idiom `ConsequenceDispatcher` uses for
 * its recipe cache. So a mod apply at the round boundary re-validates the effects
 * file without a restart, and the warnings for a newly-broken entry fire once per
 * swap rather than per read.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. No live instances (that is
 * `EffectEngine`), no applying of anything, no reading of world state, and no
 * `getAll()` folded into the world-state broadcast: static configuration stays out
 * of the mutable-world aggregate, the exclusion every other config owner observes
 * (`CraftingController`, `KnowledgeController`, `RoomChatController`,
 * `WorldRulesController`). It also never touches the filesystem — `readRegistryFrom`
 * is the seam (`CR B-3`).
 *
 * @module src/controllers/effects/EffectsController
 */

import Logger from '../../utils/Logger.js';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';
import { readRegistryFrom } from '../../services/RegistryStore.js';
import {
    EFFECT_REVERT,
    EFFECT_STACKING,
    EFFECT_TARGETS,
    DEFAULT_EFFECT_DURATION_ROUNDS,
    DEFAULT_EFFECT_REVERT,
    DEFAULT_EFFECT_STACKING,
    DEFAULT_EFFECT_TARGET,
    isEffectRevertMode,
    isEffectStacking,
    isEffectTarget,
} from '../../../shared/EffectVocabulary.js';
import { validateEffectOperation } from './EffectOperationSpecs.js';
import {
    MAX_EFFECT_DEFINITIONS,
    MAX_EFFECT_DURATION_ROUNDS,
    MAX_EFFECT_OPERATIONS,
    MAX_EFFECT_STACKS,
} from '../../utils/Constants.js';

/** Cap on a display name, so a mod cannot ship a paragraph as a label (`CR SEC-2`). */
const MAX_EFFECT_NAME_CHARS = 80;
/** Cap on the prose fragment ("is burning"), which reaches the round prose. */
const MAX_EFFECT_PHRASE_CHARS = 80;

/**
 * The top-level keys of the file that are NOT effect definitions. `version` is the
 * schema marker of this registry (`CR P-1`); `_`-prefixed keys are the house's
 * metadata convention (`_comment`).
 * @type {ReadonlySet<string>}
 */
const NON_DEFINITION_KEYS = new Set(['version']);

class EffectsController {
    /**
     * @param {Object} [options]
     * @param {import('../../services/RegistryStore.js').RegistryStore|null} [options.registries]
     *   The live world definition. Null reads the data seam (hand-built tests).
     */
    constructor({ registries = null } = {}) {
        this._registries = registries ?? null;
        /** @type {Object.<string, Object>|null} validated definitions, keyed by store version. */
        this._definitions = null;
        /** @type {number} the store version `this._definitions` was built from. */
        this._builtFromVersion = -1;
        // A boot-time read so the summary line is honest and a broken shipped file
        // is loud before the first effect is ever asked for.
        this._current();
    }

    // =========================================================================
    // PUBLIC READERS (null-tolerant, defensive by construction)
    // =========================================================================

    /**
     * The validated definition of one effect.
     * @param {string} effectId
     * @returns {Object|null} a frozen definition, or null when no such effect is live.
     */
    getDefinition(effectId) {
        if (typeof effectId !== 'string' || effectId === '') return null;
        // Frozen all the way down, so a caller cannot mutate the live definition
        // (`CR T-8`) — no copy is needed and a copy would only hide that fact.
        return this._current()[effectId] ?? null;
    }

    /**
     * True when an effect id is defined and live right now (a mod may have removed
     * it since boot, hence the version-aware check rather than a boot snapshot).
     * @param {string} effectId
     * @returns {boolean}
     */
    has(effectId) {
        return this.getDefinition(effectId) !== null;
    }

    /** Every live effect id, in file order. */
    definitionIds() {
        return Object.keys(this._current());
    }

    /**
     * One line per live effect for the operator console, the log summary and the
     * LLM context. Built from the same validated set `getDefinition` returns, so a
     * listed effect is always applicable (`CR T-1`).
     * @returns {Array<{id: string, name: string, phrase: string|null, durationRounds: number, target: string}>}
     */
    definitionSummaries() {
        return Object.values(this._current()).map((definition) => ({
            id: definition.id,
            name: definition.name,
            phrase: definition.phrase,
            durationRounds: definition.durationRounds,
            target: definition.target,
        }));
    }

    /** How many effect definitions are live. */
    count() {
        return Object.keys(this._current()).length;
    }

    // =========================================================================
    // VALIDATION + CACHE
    // =========================================================================

    /**
     * The validated definitions, rebuilt when the store has moved since the last
     * build. One `version()` read per call is the whole invalidation cost.
     * @returns {Object.<string, Object>}
     * @private
     */
    _current() {
        const version = this._registries ? this._registries.version() : 0;
        if (this._definitions !== null && this._builtFromVersion === version) {
            return this._definitions;
        }
        this._definitions = this._validate(readRegistryFrom(this._registries, REGISTRY_KINDS.EFFECTS));
        this._builtFromVersion = version;
        return this._definitions;
    }

    /**
     * Narrow the raw registry into frozen definitions. Never throws: every defect
     * is reported and skipped, and the surviving entries stay live.
     * @param {unknown} rawRegistry
     * @returns {Object.<string, Object>}
     * @private
     */
    _validate(rawRegistry) {
        const validated = {};
        if (rawRegistry === null || rawRegistry === undefined) {
            Logger.warn('[EffectsController] effects registry is absent - no effects are defined.');
            this._logSummary(validated);
            return validated;
        }
        if (typeof rawRegistry !== 'object' || Array.isArray(rawRegistry)) {
            Logger.warn(`[EffectsController] effects registry has unexpected type (${typeof rawRegistry}) - no effects are defined.`);
            this._logSummary(validated);
            return validated;
        }
        const ids = Object.keys(rawRegistry).filter((key) => !key.startsWith('_') && !NON_DEFINITION_KEYS.has(key));
        if (ids.length > MAX_EFFECT_DEFINITIONS) {
            Logger.warn(`[EffectsController] effects registry declares ${ids.length} entries, over the cap of ${MAX_EFFECT_DEFINITIONS} - only the first ${MAX_EFFECT_DEFINITIONS} are read.`);
        }
        for (const id of ids.slice(0, MAX_EFFECT_DEFINITIONS)) {
            const errors = [];
            const definition = this._validateEntry(id, rawRegistry[id], errors);
            if (errors.length > 0) {
                Logger.warn(`[EffectsController] effect "${id}" is disabled: ${errors.join('; ')}`);
                continue;
            }
            validated[id] = definition;
        }
        this._logSummary(validated);
        return validated;
    }

    /**
     * Validate and normalise one entry.
     * @param {string} id
     * @param {unknown} raw
     * @param {string[]} errors - accumulated, caller reports them.
     * @returns {Object|null} the frozen definition, or null when `errors` is non-empty.
     * @private
     */
    _validateEntry(id, raw, errors) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push('an effect must be an object');
            return null;
        }

        const target = raw.target === undefined ? DEFAULT_EFFECT_TARGET : raw.target;
        if (!isEffectTarget(target)) {
            errors.push(`target "${String(target)}" is not one of ${Object.values(EFFECT_TARGETS).join(', ')}`);
        }

        const durationRounds = raw.durationRounds === undefined
            ? DEFAULT_EFFECT_DURATION_ROUNDS
            : raw.durationRounds;
        if (typeof durationRounds !== 'number' || !Number.isInteger(durationRounds)
            || durationRounds < 0 || durationRounds > MAX_EFFECT_DURATION_ROUNDS) {
            errors.push(`durationRounds must be an integer between 0 and ${MAX_EFFECT_DURATION_ROUNDS} (0 means "until removed")`);
        }

        const stacking = raw.stacking === undefined ? DEFAULT_EFFECT_STACKING : raw.stacking;
        if (!isEffectStacking(stacking)) {
            errors.push(`stacking "${String(stacking)}" is not one of ${Object.values(EFFECT_STACKING).join(', ')}`);
        }

        let maxStacks = null;
        if (stacking === EFFECT_STACKING.CAPPED) {
            maxStacks = raw.maxStacks;
            if (typeof maxStacks !== 'number' || !Number.isInteger(maxStacks)
                || maxStacks < 1 || maxStacks > MAX_EFFECT_STACKS) {
                errors.push(`stacking "capped" needs an integer maxStacks between 1 and ${MAX_EFFECT_STACKS}`);
            }
        } else if (raw.maxStacks !== undefined) {
            errors.push(`maxStacks is only meaningful when stacking is "capped"`);
        }

        const revert = raw.revert === undefined ? DEFAULT_EFFECT_REVERT : raw.revert;
        if (!isEffectRevertMode(revert)) {
            errors.push(`revert "${String(revert)}" is not one of ${Object.values(EFFECT_REVERT).join(', ')}`);
        }

        const operations = this._validateOperationList(raw.operations, 'operations', errors);
        const perRound = this._validateOperationList(raw.perRound, 'perRound', errors);
        if (operations.length + perRound.length > MAX_EFFECT_OPERATIONS) {
            errors.push(`an effect declares ${operations.length + perRound.length} operations, over the cap of ${MAX_EFFECT_OPERATIONS}`);
        }

        const name = this._validateLabel(raw.name, 'name', id, MAX_EFFECT_NAME_CHARS, errors);
        const prose = raw.phrase === undefined && raw.prose === undefined ? null : raw.prose;
        if (prose !== null && (!prose || typeof prose !== 'object' || Array.isArray(prose))) {
            errors.push('prose must be an object with an optional "phrase"');
        }
        const phrase = (prose && typeof prose === 'object' && prose.phrase !== undefined)
            ? this._validateLabel(prose.phrase, 'prose.phrase', id, MAX_EFFECT_PHRASE_CHARS, errors)
            : null;

        if (errors.length > 0) return null;

        return Object.freeze({
            id,
            name,
            phrase,
            target,
            durationRounds,
            stacking,
            maxStacks,
            revert,
            operations: Object.freeze(operations.map(freezeOperation)),
            perRound: Object.freeze(perRound.map(freezeOperation)),
        });
    }

    /**
     * Validate one of the two operation lists. An absent list is empty (an effect
     * that applies nothing and ticks something is legitimate, and vice versa).
     * @private
     */
    _validateOperationList(rawList, label, errors) {
        if (rawList === undefined || rawList === null) return [];
        if (!Array.isArray(rawList)) {
            errors.push(`${label} must be an array of operations`);
            return [];
        }
        const operations = [];
        for (let i = 0; i < rawList.length; i++) {
            const entry = rawList[i];
            const entryErrors = validateEffectOperation(entry, `${label}[${i}]`);
            if (entryErrors.length > 0) {
                errors.push(...entryErrors);
                continue;
            }
            operations.push({ op: entry.op, params: { ...(entry.params ?? {}) } });
        }
        return operations;
    }

    /**
     * A display label: optional, non-empty, bounded. Absent folds to the effect id,
     * which is always available and never lies about being a name.
     * @private
     */
    _validateLabel(rawLabel, field, id, maxChars, errors) {
        if (rawLabel === undefined || rawLabel === null) return id;
        if (typeof rawLabel !== 'string' || rawLabel.trim() === '') {
            errors.push(`${field} must be a non-empty string`);
            return id;
        }
        if (rawLabel.length > maxChars) {
            errors.push(`${field} is longer than ${maxChars} characters`);
            return id;
        }
        return rawLabel;
    }

    /** @private */
    _logSummary(definitions) {
        const count = Object.keys(definitions).length;
        Logger.info(`[EffectsController] Initialized with ${count} effect definition(s)` +
            (count > 0 ? `: ${Object.keys(definitions).join(', ')}` : ''));
    }
}

/**
 * Freeze one normalised operation deeply. `params` values are scalars by the spec's
 * own law, so a one-level freeze plus the spread in `_validateOperationList` covers it.
 * @param {{op: string, params: Object}} operation
 * @returns {Object}
 */
function freezeOperation(operation) {
    return Object.freeze({ op: operation.op, params: Object.freeze({ ...operation.params }) });
}

export default EffectsController;

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
// The SHAPE law (target, duration, stacking, revert, operations, label caps) is
// `EffectDefinitionRules` - shared with the design pipeline's effects stage. Only the
// cap on HOW MANY definitions this file may hold stays here, because that limit is about
// reading a registry, not about what one effect is.
import { validateEffectDefinitionEntry } from './EffectDefinitionRules.js';
import { MAX_EFFECT_DEFINITIONS } from '../../utils/Constants.js';

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
        /**
         * @type {Object.<string, Object>} definitions registered at runtime, by id.
         *
         * MEMORY-ONLY, exactly like `create_room` and `spawn_world_object`
         * (wiki/decisions/world-structure-authoring.md): a restart rebuilds `effects`
         * from the packages and these are gone. Keeping one is a separate, explicit
         * write through `ModPackageWriter` -> `POST /mods/apply`, never a side effect
         * of registering — the same judgment-only contract the system-authoring tab
         * settled on. They live HERE rather than in a sibling module so there is one
         * read path to the definitions, not two that must agree.
         */
        this._runtime = {};
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
     * The effects a body is BORN with: every live definition declaring this blueprint.
     *
     * Read from the live, validated set rather than the raw registry, so an entry a mod
     * shipped malformed is never applied. Declaration order is the file's order, which is
     * the order the effects land on the body - an author can therefore state which of two
     * effects on the same stat wins.
     *
     * @param {string} blueprintKey - the blueprint the entity was built from
     * @returns {string[]} the effect ids, in declaration order (empty when none declare it)
     */
    effectsDeclaredFor(blueprintKey) {
        if (typeof blueprintKey !== 'string' || blueprintKey === '') return [];
        const definitions = this._current();
        return Object.keys(definitions)
            .filter((id) => definitions[id].appliesTo === blueprintKey);
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
        if (this._definitions === null || this._builtFromVersion !== version) {
            this._definitions = this._validate(readRegistryFrom(this._registries, REGISTRY_KINDS.EFFECTS));
            this._builtFromVersion = version;
            // A packaged definition of the same id has just arrived: it wins, and the
            // runtime one is dropped rather than shadowing content nobody maintains. The
            // reverse — a stale overlay entry outliving the mod that superseded it — is
            // the bug this line exists to prevent, and it is pinned by a test.
            for (const id of Object.keys(this._runtime)) {
                if (Object.prototype.hasOwnProperty.call(this._definitions, id)) {
                    delete this._runtime[id];
                    Logger.info(`[EffectsController] runtime effect "${id}" is superseded by the packaged definition`);
                }
            }
        }
        // The merge runs on the CACHED path too. Registering a definition does not move
        // the store version, so a merge placed only in the rebuild branch would leave a
        // freshly-registered effect invisible until the next mod swap.
        return Object.keys(this._runtime).length > 0
            ? { ...this._definitions, ...this._runtime }
            : this._definitions;
    }

    /**
     * Add an effect definition to the LIVE world, for the rest of this session.
     *
     * Validated by the same law as a packaged entry — one law, two sources
     * (`CR T-2`) — and refused with the reasons rather than half-stored. It is NOT
     * written to disk: the caller is told, in the result, what writing it durably
     * would take, the way the agent-body design answers with `appliesVia`.
     *
     * @param {string} id - the effect id to define
     * @param {Object} rawDefinition - one entry in the `effects` registry shape
     * @returns {{ ok: boolean, errors?: string[], code?: string, appliesVia: string }}
     */
    registerRuntimeDefinition(id, rawDefinition) {
        const appliesVia = 'POST /mods/apply (after authoring an "effects" package)';
        if (typeof id !== 'string' || id === '' || id.startsWith('_') || NON_DEFINITION_KEYS.has(id)) {
            return { ok: false, code: 'EFFECT_ID_INVALID', errors: ['"id" must be a non-empty effect id'], appliesVia };
        }
        if (this.getDefinition(id)) {
            return { ok: false, code: 'EFFECT_ALREADY_DEFINED',
                errors: [`"${id}" is already defined; register a different id`], appliesVia };
        }
        const errors = [];
        const definition = this._validateEntry(id, { ...(rawDefinition ?? {}), id: undefined }, errors);
        if (errors.length > 0 || definition === null) {
            return { ok: false, code: 'EFFECT_DEFINITION_INVALID', errors, appliesVia };
        }
        this._runtime[id] = definition;
        Logger.info(`[EffectsController] registered runtime effect "${id}" `
            + '(memory only - a restart rebuilds effects from the packages)');
        return { ok: true, appliesVia };
    }

    /**
     * The ids that came from a runtime registration rather than a package. Reported so
     * no reader mistakes a session-only definition for shipped content.
     * @returns {string[]}
     */
    runtimeDefinitionIds() {
        // Runs the same version-aware path as every other reader, so it can never report
        // an entry the supersede sweep has already dropped - a reader that disagrees with
        // `getDefinition` about what is live is a bug report waiting to be written.
        this._current();
        return Object.keys(this._runtime);
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
        // The law itself lives in `EffectDefinitionRules`, because the LAST stage of the
        // agent-body design authors entries of this same registry kind and must be held to
        // the same text. A copy of the shape in the design pipeline is a design that
        // drifts from what boot accepts (`CR T-1`).
        return validateEffectDefinitionEntry(id, raw, errors);
    }

    /** @private */
    _logSummary(definitions) {
        const count = Object.keys(definitions).length;
        Logger.info(`[EffectsController] Initialized with ${count} effect definition(s)` +
            (count > 0 ? `: ${Object.keys(definitions).join(', ')}` : ''));
    }
}

export default EffectsController;

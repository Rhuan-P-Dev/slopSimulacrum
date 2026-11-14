/**
 * EffectVocabulary — Shared, environment-agnostic vocabulary of the effects layer.
 *
 * SINGLE SOURCE OF TRUTH for the words an effect definition is written with: the
 * operation ids an effect may perform, what an effect may target, how repeat
 * applications stack, and how an effect ends. Like `shared/RegistryKinds.js` and
 * `shared/StatVocabulary.js`, these strings are a wire contract: they appear in
 * `effects.json`, in the operator's `apply_effect` params, in the engine's log
 * lines and in the client's projection of a live effect.
 *
 * WHY THE OPERATION SET IS CLOSED (the load-bearing decision). An effect declares
 * work by NAMING an operation from this table — never by carrying code, an
 * expression, or a condition tree. Every op id is an adapter over an executor that
 * already exists in the consequence layer (`src/controllers/consequences/`), so a
 * mutation keeps exactly one implementation in the codebase (`CR B-2`) and a mod
 * stays a data-only package (`AGENTS.md`). The alternative — an evaluator inside
 * effect definitions — would put a language where the repository has an allowlist,
 * and `CR SEC-4` treats model- or data-authored code as an injection class.
 *
 * Adding an operation is therefore three edits in one commit: an id here, an
 * adapter in the engine's operation table, and a fixture case in the effects unit
 * suite. An op id that is not in this table is a BOOT failure naming the id
 * (`CR T-4`), never a silent skip at apply time.
 *
 * WHAT THIS MODULE DOES NOT OWN. The effect *definitions* (the registry kind
 * `effects`, read by `src/controllers/effects/EffectsController.js`), the live
 * instances (`src/controllers/effects/EffectEngine.js`), and the parameter shape
 * each operation accepts — that is each executor's contract, validated by the
 * engine's operation table, not duplicated here.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same ES module can
 * be imported by the Node server and by the browser (served via `/shared/`).
 *
 * @module EffectVocabulary
 */

/**
 * The operations an effect may perform. Each value is the op id; the engine maps
 * it to the executor that already applies it.
 *
 * The names are the EFFECT layer's own, deliberately cleaner than the consequence
 * type they adapt. Two are worth stating where they differ, because the mapping is
 * the only place the old name survives: `statDelta` adapts the consequence type
 * `updateComponentStatDelta`, and `emitEvent` adapts `triggerEvent`.
 *
 * @type {Object.<string, string>}
 */
export const EFFECT_OPERATIONS = Object.freeze({
    // ---- the base: what a body IS, per stat / condition / flag ----
    STAT_DELTA: 'statDelta',
    STAT_SET: 'statSet',
    ADD_CONDITION: 'addCondition',
    REMOVE_CONDITION: 'removeCondition',
    GRANT_FLAG: 'grantFlag',
    // ---- matter ----
    DAMAGE_COMPONENT: 'damageComponent',
    DAMAGE_RANDOM_COMPONENTS: 'damageRandomComponents',
    DROP_MATERIAL_CHUNK: 'dropMaterialChunk',
    // ---- space ----
    MOVE_BY: 'moveBy',
    MOVE_TO: 'moveTo',
    TRAVERSE_DOOR: 'traverseDoor',
    // ---- the body's parts ----
    ADD_COMPONENT: 'addComponent',
    REMOVE_COMPONENT: 'removeComponent',
    // ---- record only: never a mutation of world state ----
    LOG: 'log',
    EMIT_EVENT: 'emitEvent',
});

/**
 * The op ids whose application CAN be undone, because the engine can name what
 * changed and write its inverse through the same choke point.
 *
 * Everything absent here is **record-only on expiry**: the effect's bookkeeping
 * ends and the world keeps what happened. Undoing damage would be healing nobody
 * asked for, and un-dropping a chunk would move matter the room already has.
 * `CR E-1`'s honesty applies backwards in time too — a revert must say what it
 * does not undo rather than pretend to rewind.
 *
 * The spatial moves are absent on purpose: a position revert is only sound while
 * the origin is still valid, and the room may have moved underneath the effect.
 * They revert only when the engine captured a prior position that still resolves,
 * which is a per-instance decision, not a property of the op.
 *
 * @type {ReadonlySet<string>}
 */
export const REVERSIBLE_EFFECT_OPERATIONS = Object.freeze(new Set([
    EFFECT_OPERATIONS.STAT_DELTA,
    EFFECT_OPERATIONS.STAT_SET,
    EFFECT_OPERATIONS.ADD_CONDITION,
    EFFECT_OPERATIONS.REMOVE_CONDITION,
    EFFECT_OPERATIONS.GRANT_FLAG,
]));

/**
 * What an effect is aimed at.
 *
 * `COMPONENT` is one resolved component; `ENTITY` is an entity, and which of its
 * parts a given operation lands on is decided by the engine the same way the
 * durable-stat tracker already decides it — every component of that entity that
 * carries the field the operation names. The op set never invents a part.
 *
 * @type {Object.<string, string>}
 */
export const EFFECT_TARGETS = Object.freeze({
    ENTITY: 'entity',
    COMPONENT: 'component',
});

/**
 * How a repeat application of the SAME effect on the SAME target behaves.
 *
 * `REFRESH` is the shipped default and the behaviour the grab debuff has always
 * had: the effect's own contribution is lifted, re-applied at full strength and
 * the expiry pushed out, so a repeated hit does not stack and does not disturb
 * any other live effect on the same stat.
 *
 * @type {Object.<string, string>}
 */
export const EFFECT_STACKING = Object.freeze({
    REFRESH: 'refresh',
    INDEPENDENT: 'independent',
    STRONGEST: 'strongest',
    CAPPED: 'capped',
});

/**
 * How an effect ends when its duration runs out.
 *
 * `AUTO` reverts every reversible operation of that effect (and leaves the
 * record-only ones alone — the effect stops, the world keeps what happened).
 * `NONE` ends the bookkeeping and changes nothing else.
 *
 * @type {Object.<string, string>}
 */
export const EFFECT_REVERT = Object.freeze({
    AUTO: 'auto',
    NONE: 'none',
});

/** The default applied when a definition does not state `stacking`. Named, not inline (`CR API-5`). */
export const DEFAULT_EFFECT_STACKING = EFFECT_STACKING.REFRESH;
/** The default applied when a definition does not state `revert`. */
export const DEFAULT_EFFECT_REVERT = EFFECT_REVERT.AUTO;
/** The default applied when a definition does not state `target`. */
export const DEFAULT_EFFECT_TARGET = EFFECT_TARGETS.ENTITY;
/** A duration of 0 means "until removed", and is the default when the field is absent. */
export const DEFAULT_EFFECT_DURATION_ROUNDS = 0;

/**
 * True when `value` is an operation id this engine knows how to perform.
 * Every boundary uses this before trusting an op id from data, a mod package or a
 * request body (`CR T-1`, `CR T-2`).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEffectOperation(value) {
    return typeof value === 'string' && Object.values(EFFECT_OPERATIONS).includes(value);
}

/** True when the operation named by `value` can be undone on expiry. */
export function isReversibleEffectOperation(value) {
    return REVERSIBLE_EFFECT_OPERATIONS.has(value);
}

/** True when `value` is an effect target selector. */
export function isEffectTarget(value) {
    return typeof value === 'string' && Object.values(EFFECT_TARGETS).includes(value);
}

/** True when `value` is a stacking mode. */
export function isEffectStacking(value) {
    return typeof value === 'string' && Object.values(EFFECT_STACKING).includes(value);
}

/** True when `value` is a revert mode. */
export function isEffectRevertMode(value) {
    return typeof value === 'string' && Object.values(EFFECT_REVERT).includes(value);
}

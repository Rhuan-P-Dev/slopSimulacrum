/**
 * EffectDefinitionRules — the shape law of ONE effect definition, as pure functions.
 *
 * WHY THIS IS NOT INSIDE `EffectsController`. The same shape is authored from two
 * places: an `effects` package on disk, and the last stage of the agent-body design
 * pipeline, which writes a body's inborn effects into the same registry kind
 * (`wiki/decisions/agent-body-design.md`). A design validated by a copy of the law is
 * a design that drifts from the law - the stage accepts what boot then refuses, and the
 * author learns about it at the next swap. So the law lives here, has one implementation,
 * and both readers call it (`CR T-1`, `CR T-2`).
 *
 * WHAT IT DOES NOT DECIDE. Whether an effect id collides with a packaged definition,
 * which effect is applicable to which body, and what an operation DOES - those belong to
 * `EffectsController` (the definition owner) and to `EffectEngine` (the executor owner)
 * respectively. This module answers exactly one question: is this value a well-formed
 * effect definition, and what is the frozen normalised form of it.
 *
 * IT NEVER THROWS. Like both of its callers, a malformed entry is reported through the
 * accumulated `errors` array and yields `null`; "nothing extra happens" is a complete
 * world, and one bad key in a third-party package is not a crash vector.
 *
 * @module src/controllers/effects/EffectDefinitionRules
 */

import {
    EFFECT_TARGETS,
    EFFECT_STACKING,
    EFFECT_REVERT,
    DEFAULT_EFFECT_TARGET,
    DEFAULT_EFFECT_STACKING,
    DEFAULT_EFFECT_REVERT,
    DEFAULT_EFFECT_DURATION_ROUNDS,
    isEffectTarget,
    isEffectStacking,
    isEffectRevertMode,
} from '../../../shared/EffectVocabulary.js';
import { validateEffectOperation } from './EffectOperationSpecs.js';
import {
    MAX_EFFECT_DURATION_ROUNDS,
    MAX_EFFECT_OPERATIONS,
    MAX_EFFECT_STACKS,
} from '../../utils/Constants.js';

/**
 * Caps on a display name, so a design or a mod cannot ship a paragraph as a label
 * (`CR SEC-2`). Exported because the design stage quotes them to the model in its own
 * prompt, and a limit the prompt states wrong is a limit the model keeps breaking.
 */
export const MAX_EFFECT_NAME_CHARS = 80;
/** Cap on the prose fragment ("is burning"), which reaches the round prose. */
export const MAX_EFFECT_PHRASE_CHARS = 80;

/**
 * Validate one entry of the `effects` registry.
 *
 * @param {string} id - the registry key, which is also the effect id
 * @param {unknown} raw - the authored value
 * @param {string[]} errors - accumulated; the caller reports them
 * @returns {Object|null} the frozen definition, or null when `errors` is non-empty
 */
export function validateEffectDefinitionEntry(id, raw, errors) {
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

    const operations = validateEffectOperationList(raw.operations, 'operations', errors);
    const perRound = validateEffectOperationList(raw.perRound, 'perRound', errors);
    if (operations.length + perRound.length > MAX_EFFECT_OPERATIONS) {
        errors.push(`an effect declares ${operations.length + perRound.length} operations, over the cap of ${MAX_EFFECT_OPERATIONS}`);
    }

    // WHICH BODY WAS BORN WITH THIS, if any. Stamped by the agent-body save (the server
    // knows which blueprint it is writing; the model does not get to claim a body), and
    // hand-authorable by a mod that ships an effect for a body it also ships. Read at spawn
    // by `InbornEffects`, which applies every effect declaring this entity's blueprint.
    const appliesTo = raw.appliesTo === undefined ? null : raw.appliesTo;
    if (appliesTo !== null && (typeof appliesTo !== 'string' || appliesTo.trim() === '' || appliesTo.length > MAX_EFFECT_NAME_CHARS)) {
        errors.push(`appliesTo must be a non-empty blueprint key of at most ${MAX_EFFECT_NAME_CHARS} characters`);
    }

    const name = validateEffectLabel(raw.name, 'name', id, MAX_EFFECT_NAME_CHARS, errors);
    const prose = raw.phrase === undefined && raw.prose === undefined ? null : raw.prose;
    if (prose !== null && (!prose || typeof prose !== 'object' || Array.isArray(prose))) {
        errors.push('prose must be an object with an optional "phrase"');
    }
    const phrase = (prose && typeof prose === 'object' && prose.phrase !== undefined)
        ? validateEffectLabel(prose.phrase, 'prose.phrase', id, MAX_EFFECT_PHRASE_CHARS, errors)
        : null;

    if (errors.length > 0) return null;

    return Object.freeze({
        id,
        name,
        phrase,
        appliesTo,
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
 * Validate one of the two operation lists. An absent list is empty (an effect that
 * applies nothing and ticks something is legitimate, and vice versa).
 * @param {unknown} rawList
 * @param {string} label - where the list sits, for the error text
 * @param {string[]} errors
 * @returns {Array<{op: string, params: Object}>}
 */
export function validateEffectOperationList(rawList, label, errors) {
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
 * A display label: optional, non-empty, bounded. Absent folds to the effect id, which
 * is always available and never lies about being a name.
 * @param {unknown} rawLabel
 * @param {string} field
 * @param {string} id
 * @param {number} maxChars
 * @param {string[]} errors
 * @returns {string}
 */
export function validateEffectLabel(rawLabel, field, id, maxChars, errors) {
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

/**
 * Freeze one normalised operation deeply. `params` values are scalars by the spec's own
 * law, so a one-level freeze plus the spread in `validateEffectOperationList` covers it.
 * @param {{op: string, params: Object}} operation
 * @returns {Readonly<{op: string, params: Readonly<Object>}>}
 */
export function freezeOperation(operation) {
    return Object.freeze({ op: operation.op, params: Object.freeze({ ...operation.params }) });
}

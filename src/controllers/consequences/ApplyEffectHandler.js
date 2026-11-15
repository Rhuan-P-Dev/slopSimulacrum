/**
 * ApplyEffectHandler — the `applyEffect` consequence type: any action, weapon, item
 * or machine in the data can inflict an effect, either by NAMING one from the
 * `effects` registry or by CARRYING one authored for this verb alone.
 *
 * WHY IT IS A CONSEQUENCE AND NOT A NEW MECHANISM. The consequence layer is already
 * the vocabulary of "what happens when a verb resolves" (`CR B-2`), and the effect
 * engine is already the owner of "what happens to a body over time". This module is
 * the one line between them, and it mutates nothing itself — it resolves the target
 * kind and hands the application to the engine, so a burn inflicted by a flamethrower
 * and a burn applied by the operator console are the same instance of the same
 * effect, with the same expiry and the same revert.
 *
 * DATA SHAPE (in an action's `consequences` entry) — `effectId` OR `effect`, never
 * both, because an author silently overriding the row they also named is the kind of
 * ambiguity a data file should refuse:
 *   { "type": "applyEffect", "target": "target",
 *     "params": { "effectId": "burning", "rounds": 2 } }
 *   { "type": "applyEffect", "target": "target",
 *     "params": { "effect": { "name": "Frostbite", "target": "component",
 *       "durationRounds": 3,
 *       "operations": [{ "op": "statDelta",
 *         "params": { "trait": "Physical", "stat": "existence", "value": -0.1 } }] } } }
 * `target` follows the dispatcher's existing law (`self` | `target` | `entity`), and
 * `rounds` is optional on both forms — absent means the effect's own declared duration,
 * present means a whole number the engine can actually honour (`0` ..
 * `MAX_EFFECT_DURATION_ROUNDS`), refused here rather than quietly ignored.
 *
 * THE CARRIED EFFECT IS TRANSIENT. It runs through `EffectEngine.applyDefinition`,
 * lives exactly as long as its instances, and is never written to the `effects`
 * registry: hitting something with a verb must not define a global type as a side
 * effect (`wiki/decisions/effects-system.md`). It is still validated by the registry's
 * own law (`EffectDefinitionRules`) before it reaches the engine — one shape, one law
 * (`CR T-1`) — under a synthetic id, `inline:<action name>`, which is what shows up in
 * the NPC context and what `removeEffects({ effectId })` can name.
 *
 * WHAT THIS MODULE DOES NOT DO. No defaulting to a made-up effect when the id is
 * unknown (a silent no-op would report a successful hit that did nothing), no
 * duration invention, no direct stat writes — those are the engine's, and the engine's
 * are adapters over the executors that already exist — and no placeholder resolution:
 * effect parameters are literal (`EffectOperationSpecs`), so a value that still carries
 * an unresolved `:token` is refused rather than written as a condition or a stat name.
 *
 * @module src/controllers/consequences/ApplyEffectHandler
 */

import Logger from '../../utils/Logger.js';
import { isCompId } from '../../utils/IdResolver.js';
import { EFFECT_TARGETS } from '../../../shared/EffectVocabulary.js';
import { validateInlineEffectDefinition } from '../effects/EffectDefinitionRules.js';
import { MAX_EFFECT_DURATION_ROUNDS } from '../../utils/Constants.js';

/** The id a carried (`params.effect`) application runs under: prefix + action name. */
const INLINE_EFFECT_ID_PREFIX = 'inline:';

/**
 * Apply an effect to the resolved target — by registry id, or from the definition the
 * action carries.
 *
 * @param {string|null} targetId - the component or entity id the dispatcher resolved
 * @param {Object} params - `{ effectId }` or `{ effect }`, plus optional `rounds`
 * @param {Object} context - the action context (used for the log line and the inline id)
 * @param {Object} worldStateController - the facade; the engine hangs off it
 * @returns {{ success: boolean, message: string, data: null|Object }}
 */
export function handleApplyEffect(targetId, params, context, worldStateController) {
    const effectId = typeof params?.effectId === 'string' && params.effectId !== ''
        ? params.effectId
        : null;
    const authored = params?.effect === undefined || params.effect === null ? null : params.effect;
    if (!effectId && !authored) {
        return refused('applyEffect needs params.effectId (an id from the "effects" registry) '
            + 'or params.effect (an effect definition authored for this action)');
    }
    if (effectId && authored) {
        return refused(`applyEffect names "${effectId}" and also carries its own effect: `
            + 'pass effectId OR effect, never both');
    }
    if (!targetId) {
        return refused(`applyEffect "${effectId ?? describeAuthored(params)}" has no resolved target`);
    }
    const engine = worldStateController?.effectEngine ?? null;
    if (!engine) {
        Logger.warn('[ApplyEffectHandler] no effect engine wired - the effect was NOT applied');
        return refused('no effect engine wired');
    }

    const roundsError = checkRoundsOverride(params?.rounds);
    if (roundsError) return refused(roundsError);

    const actionName = typeof context?.actionName === 'string' && context.actionName !== ''
        ? context.actionName
        : 'unknown';
    const pending = {
        target: {
            kind: isCompId(targetId) ? EFFECT_TARGETS.COMPONENT : EFFECT_TARGETS.ENTITY,
            id: targetId,
        },
        targetId,
        actionName,
        // Absent rounds are the effect's own declared duration, on both forms.
        options: {
            rounds: typeof params.rounds === 'number' ? params.rounds : undefined,
            source: `consequence:${actionName}`,
        },
    };

    if (effectId) {
        return applyToTarget(engine.apply(effectId, pending.target, pending.options), effectId, targetId);
    }
    return applyCarriedEffect(engine, params, pending);
}

/**
 * The carried form: validate the definition the action authored under the law the
 * registry itself runs, refuse with the rules it broke, and hand the frozen result to
 * the engine's transient entry point.
 * @param {Object} engine - `worldStateController.effectEngine`
 * @param {Object} params - the consequence params (`effect` is the authored definition)
 * @param {Object} pending - the resolved application: target, targetId, actionName, options
 * @returns {{ success: boolean, message: string, data: null|Object }}
 */
function applyCarriedEffect(engine, params, pending) {
    const errors = [];
    const definition = validateInlineEffectDefinition(
        `${INLINE_EFFECT_ID_PREFIX}${pending.actionName}`, params.effect, errors);
    if (!definition) {
        return refused(`the effect "${describeAuthored(params)}" this action carries is not a `
            + `well-formed effect definition: ${errors.join('; ')}`);
    }
    return applyToTarget(
        engine.applyDefinition(definition, pending.target, pending.options),
        definition.id,
        pending.targetId,
    );
}

/**
 * One refusal shape for every way this consequence can not land (`CR H-2`): the hit
 * reports as a hit that did nothing, never as a hit that did something.
 * @param {string} message
 * @returns {{ success: boolean, message: string, data: null }}
 */
function refused(message) {
    return { success: false, message, data: null };
}

/**
 * The optional `rounds` override, checked where the action writes it instead of where it
 * is honoured. The engine's own rule is "a number I cannot use means no override", so a
 * typo in the action — an unresolved `"50/2"`, a fractional `2.5`, a `1e9`, a `-1` —
 * becomes a duration the author never wrote (and `1e9` is an instance that outlives the
 * world it was applied in). A bad number in an action is a typo, and a typo is refused
 * with the number in the message (`wiki/decisions/failure-over-silence.md`).
 * @param {unknown} rounds - `params.rounds`; absent when the effect declares its own length
 * @returns {string|null} the reason to refuse, or null when the override is usable
 */
function checkRoundsOverride(rounds) {
    if (rounds === undefined || rounds === null) return null;
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > MAX_EFFECT_DURATION_ROUNDS) {
        const shown = typeof rounds === 'number' ? String(rounds) : `a ${typeof rounds}`;
        return 'applyEffect rounds must be a whole number of rounds between 0 and '
            + `${MAX_EFFECT_DURATION_ROUNDS} (0 means "until removed"); got ${shown}`;
    }
    return null;
}

/**
 * The engine's answer translated for the dispatcher, with the same honesty about a
 * refusal: a hit whose effect did not land must not look like a hit that did.
 * @param {{ ok: boolean, instanceIds?: string[], error?: string, code?: string }} result
 * @param {string} effectId - the registry id, or the synthetic inline id
 * @param {string} targetId
 * @returns {{ success: boolean, message: string, data: null|Object }}
 */
function applyToTarget(result, effectId, targetId) {
    if (!result.ok) {
        Logger.warn(`[ApplyEffectHandler] "${effectId}" on ${targetId} refused (${result.code}): ${result.error}`);
        return refused(`applyEffect "${effectId}" refused: ${result.error}`);
    }
    return {
        success: true,
        message: `effect "${effectId}" applied to ${targetId}`,
        data: { effectId, targetId, instanceIds: result.instanceIds },
    };
}

/**
 * How to call a carried effect in a message when it never got a definition: the label
 * the author gave it, and the inline prefix when they gave none.
 * @param {Object} params
 * @returns {string}
 */
function describeAuthored(params) {
    const name = params?.effect?.name;
    return typeof name === 'string' && name.trim() !== '' ? name : 'the carried effect';
}

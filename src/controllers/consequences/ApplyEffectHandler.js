/**
 * ApplyEffectHandler — the `applyEffect` consequence type: any action, weapon, item
 * or machine in the data can inflict an effect from the `effects` registry.
 *
 * WHY IT IS A CONSEQUENCE AND NOT A NEW MECHANISM. The consequence layer is already
 * the vocabulary of "what happens when a verb resolves" (`CR B-2`), and the effect
 * engine is already the owner of "what happens to a body over time". This module is
 * the one line between them, and it mutates nothing itself — it resolves the target
 * kind and hands the application to the engine, so a burn inflicted by a flamethrower
 * and a burn applied by the operator console are the same instance of the same
 * effect, with the same expiry and the same revert.
 *
 * DATA SHAPE (in an action's `consequences` entry):
 *   { "type": "applyEffect", "target": "target",
 *     "params": { "effectId": "burning", "rounds": 2 } }
 * `target` follows the dispatcher's existing law (`self` | `target` | `entity`), and
 * `rounds` is optional — absent means the effect's own declared duration.
 *
 * WHAT THIS MODULE DOES NOT DO. No defaulting to a made-up effect when the id is
 * unknown (a silent no-op would report a successful hit that did nothing), no
 * duration invention, and no direct stat writes — those are the engine's, and the
 * engine's are adapters over the executors that already exist.
 *
 * @module src/controllers/consequences/ApplyEffectHandler
 */

import Logger from '../../utils/Logger.js';
import { isCompId } from '../../utils/IdResolver.js';
import { EFFECT_TARGETS } from '../../../shared/EffectVocabulary.js';

/**
 * Apply an effect from the `effects` registry to the resolved target.
 *
 * @param {string|null} targetId - the component or entity id the dispatcher resolved
 * @param {Object} params - `{ effectId, rounds? }`
 * @param {Object} context - the action context (used only for the log line)
 * @param {Object} worldStateController - the facade; the engine hangs off it
 * @returns {{ success: boolean, message: string, data: null|Object }}
 */
export function handleApplyEffect(targetId, params, context, worldStateController) {
    const effectId = typeof params?.effectId === 'string' ? params.effectId : null;
    if (!effectId) {
        return { success: false, message: 'applyEffect needs params.effectId (an id from the "effects" registry)', data: null };
    }
    if (!targetId) {
        return { success: false, message: `applyEffect "${effectId}" has no resolved target`, data: null };
    }
    const engine = worldStateController?.effectEngine ?? null;
    if (!engine) {
        Logger.warn('[ApplyEffectHandler] no effect engine wired - the effect was NOT applied');
        return { success: false, message: 'no effect engine wired', data: null };
    }

    const result = engine.apply(effectId,
        { kind: isCompId(targetId) ? EFFECT_TARGETS.COMPONENT : EFFECT_TARGETS.ENTITY, id: targetId },
        { rounds: typeof params.rounds === 'number' ? params.rounds : undefined,
            source: `consequence:${context?.actionName ?? 'unknown'}` });

    if (!result.ok) {
        // The reason is reported rather than swallowed: a hit whose effect did not
        // land must not look like a hit that did.
        Logger.warn(`[ApplyEffectHandler] "${effectId}" on ${targetId} refused (${result.code}): ${result.error}`);
        return { success: false, message: `applyEffect "${effectId}" refused: ${result.error}`, data: null };
    }
    return {
        success: true,
        message: `effect "${effectId}" applied to ${targetId}`,
        data: { effectId, targetId, instanceIds: result.instanceIds },
    };
}

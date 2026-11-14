/**
 * InbornEffects — what a body does by being what it is, applied at spawn.
 *
 * THE CLAIM LIVES IN THE DATA. A designed body's blueprint entry carries
 * `inbornEffects: [effectId, ...]` — the ids of the effect definitions that shipped in
 * the same mod package (`wiki/decisions/agent-body-design.md`,
 * `wiki/decisions/effects-system.md`). This module reads that claim and applies it, and
 * is the only path from "the blueprint says so" to "the engine has an instance".
 *
 * WHY RE-APPLIED AT EVERY SPAWN RATHER THAN PERSISTED. An inborn effect is not a fact
 * about a run; it is a fact about a BODY. So it is not saved — the same consequence the
 * effect layer already accepted for save/load (a restart does not restore live effects),
 * and it makes the world self-healing: boot, recreate, or a card re-spawned after being
 * eliminated, and the body arrives with what it was designed to carry, with no stored
 * state to drift out of sync.
 *
 * THE ROUND IS NOT PUBLISHED AT SPAWN, and that is the right clock. An instance applied
 * while no round exists has no expiry round and lasts until removed — which is precisely
 * "as long as this body stands" (`durationRounds: 0`, what the design stage is told to
 * write). An inborn effect is not a timer that runs out; the body ending is what ends it.
 *
 * A REFUSAL IS LOGGED, NEVER THROWN. Spawn is the one moment the world cannot afford to
 * fail half-way: an effect whose operations find no carrier in this body (no part holds
 * the stat) is a definition that over-promise, and the honest outcome is the body without
 * that effect plus a warning naming it — not an entity that never arrived.
 *
 * @module src/controllers/effects/InbornEffects.js
 */

import Logger from '../../utils/Logger.js';

/**
 * Apply one entity's inborn effects to it, now.
 *
 * THE IDS ARE HANDED IN, not looked up here. What declares an effect's body is the effect
 * itself (`appliesTo`, validated by `EffectDefinitionRules`), and the definition owner is
 * what reads that - so this module only performs the applications, and cannot drift from
 * the narrowed, validated set (`CR T-1`).
 *
 * @param {Object} facade - the world facade; uses `effectEngine` only
 * @param {string} entityId - the entity that just arrived
 * @param {string[]} declaredIds - the effect ids this body was born with
 * @returns {{ applied: number, refused: number }}
 */
export function applyInbornEffects(facade, entityId, declaredIds = []) {
    const engine = facade.effectEngine ?? null;
    if (!engine) return { applied: 0, refused: 0 };
    const entity = facade.stateEntityController?.getEntity?.(entityId) ?? null;
    if (!entity || !Array.isArray(declaredIds) || declaredIds.length === 0) {
        return { applied: 0, refused: 0 };
    }

    let applied = 0;
    let refused = 0;
    for (const effectId of declaredIds) {
        const result = engine.apply(effectId, { kind: 'entity', id: entityId }, { source: 'inborn' });
        // `EFFECT_UNKNOWN` is the case a package gets wrong: the blueprint names an id no
        // `effects` entry defines. The engine already says it; the line here says WHICH
        // blueprint promised it.
        if (result.ok) {
            applied++;
        } else {
            refused++;
            Logger.warn(`[InbornEffects] "${effectId}" on blueprint "${entity.blueprint}" refused (${result.code}): ${result.error}`);
        }
    }
    return { applied, refused };
}

/**
 * itemBaseStats — the single home of two rules an item RECIPE answers:
 *   1. which numeric stat values a declared `traits` map carries (the "numeric
 *      leaf" rule, CR D-3: it used to live only inside
 *      EquippedItemStatsController._buildStatsFromTraits);
 *   2. which stat values the item carries BEFORE any instance exists —
 *      explicit recipe traits when they are authoritative, otherwise the stats
 *      derived from the item's matter.
 *
 * WHY a module: the equip flow (`HoldingCostController._seedDerivedStatsOnEquip`
 * + `EquippedItemStatsController.initializeStats`) and the read-only Knowledge
 * codex (`KnowledgeController`) both need the same answer, and a second copy of
 * the precedence would let them drift — the codex would then advertise an action
 * the engine will not offer. This module holds the rule; both callers delegate.
 *
 * The matter step is injected (`deriveStats`), never re-implemented here:
 * `MaterialController.derive` is the single derivation authority for
 * matter → stats. This module is pure — no file I/O, no world state, no
 * per-instance values (the caller decides which definition to ask about).
 *
 * @module itemBaseStats
 */

import Logger from './Logger.js';

/**
 * The existence value the equip flow establishes when nothing else declares it
 * (`EquippedItemStatsController.initializeStats` seeds `Physical.existence = 1`
 * so the wear lifecycle has a valid 0-1 reference). Mirrored here so the
 * read-only view scores the same baseline the instance starts life with.
 */
export const EXISTENCE_BASELINE = 1;

/**
 * Extracts the numeric leaves of a traits map: `{ [traitId]: { [stat]: number } }`,
 * dropping traits with no numeric leaf. Non-numeric entries are annotations and
 * seed nothing. Behavior-identical to the builder this rule was extracted from.
 * @param {Object} [traits] - A traits map (`form.traits` or legacy `traits`).
 * @returns {Object} Stats keyed by trait ('' shape when nothing is seedable).
 */
export function buildStatsFromTraits(traits) {
    if (!traits || typeof traits !== 'object') {
        return {};
    }

    const stats = {};
    for (const [traitId, traitData] of Object.entries(traits)) {
        if (typeof traitData !== 'object' || traitData === null || Array.isArray(traitData)) {
            continue;
        }

        stats[traitId] = {};
        for (const [statName, statValue] of Object.entries(traitData)) {
            if (typeof statValue === 'number') {
                stats[traitId][statName] = statValue;
            }
        }

        // If the trait has no numeric stats, remove the empty entry
        if (Object.keys(stats[traitId]).length === 0) {
            delete stats[traitId];
        }
    }

    return stats;
}

/**
 * True exactly when `buildStatsFromTraits` would produce a non-empty stats
 * object — i.e. when explicit recipe traits are AUTHORITATIVE and must suppress
 * the matter fallback. A map with no numeric leaf (or `{}`) seeds nothing and so
 * must not suppress derivation (the BUG-134 symptom class).
 * @param {Object} [traits] - A traits map.
 * @returns {boolean}
 */
export function hasSeedableTraitValues(traits) {
    return Object.keys(buildStatsFromTraits(traits)).length > 0;
}

/**
 * The stat values an item recipe carries before any instance exists — the same
 * precedence the equip flow establishes, read statically:
 *   explicit `form.traits` (then legacy `traits`) when numeric,
 *   else matter derivation over the recipe's composition,
 *   else nothing (an item with no materials and no traits carries no stats).
 * Either of the first two carries the existence baseline the equip flow seeds, so
 * a gate on `Physical.existence` scores the same here as it does on the instance.
 * @param {Object} itemDef - An inventory item definition (from the registry).
 * @param {Object} [deps]
 * @param {Function} [deps.deriveStats] - matter -> stats, the single authority
 *   (`(itemDef) => materialController.derive(itemDef)`). Absent or throwing
 *   yields no derived stats (warn + degrade, as the equip seeding does).
 * @returns {Object} Stats keyed by trait ({ } when the recipe carries none).
 */
export function resolveRecipeBaseStats(itemDef, { deriveStats } = {}) {
    if (!itemDef || typeof itemDef !== 'object' || Array.isArray(itemDef)) {
        return {};
    }

    // Explicit recipe traits outrank matter derivation (the equip flow never
    // clobbers them) — but only when they actually seed something.
    const explicit = itemDef.form?.traits ?? itemDef.traits;
    if (hasSeedableTraitValues(explicit)) {
        const stats = buildStatsFromTraits(explicit);
        // The equip flow seeds this baseline on EVERY path, explicit traits included
        // (`EquippedItemStatsController.initializeStats`), so a reader that left it
        // out would score an existence-gated action (`shootT1`) as unavailable while
        // the equipped instance has it - the drift this module exists to prevent.
        if (typeof stats.Physical?.existence !== 'number') {
            stats.Physical = { ...(stats.Physical || {}), existence: EXISTENCE_BASELINE };
        }
        return stats;
    }

    // No materials -> nothing to derive from (the equip seeding guards the same).
    if (!Array.isArray(itemDef.materials) || itemDef.materials.length === 0) {
        return {};
    }

    if (typeof deriveStats !== 'function') {
        return {};
    }

    let derived;
    try {
        derived = deriveStats(itemDef);
    } catch (error) {
        Logger.warn(`[itemBaseStats] Could not derive stats for an item recipe: ${error.message}`);
        return {};
    }

    if (!derived || typeof derived !== 'object' || Array.isArray(derived) || Object.keys(derived).length === 0) {
        return {};
    }

    const stats = structuredClone(derived);
    // Keep the existence baseline the instance would start with, so a
    // existence-gated requirement scores the same here as it does live.
    if (typeof stats.Physical?.existence !== 'number') {
        stats.Physical = { ...(stats.Physical || {}), existence: EXISTENCE_BASELINE };
    }
    return stats;
}

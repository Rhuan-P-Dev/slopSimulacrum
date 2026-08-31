/**
 * StatVocabulary — Shared, environment-agnostic trait/stat name vocabulary.
 *
 * SINGLE SOURCE OF TRUTH for the trait-group names and stat names that the
 * code side uses. The values MUST match the group keys and stat keys in
 * `data/traits.json` (e.g. "Physical", "durability"): world-state stat
 * maps, the requirement definitions in `data/actions.json`, and the
 * "trait.stat" flat keys used by the range resolver all key off exactly
 * these strings, so a spelling that drifts from the data files silently
 * breaks stat lookups and damage application.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same
 * ES module can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * @module StatVocabulary
 */

/**
 * Trait-group names as used in the world state and in `data/traits.json`.
 * @type {Object.<string, string>}
 */
export const TRAIT_GROUPS = {
    PHYSICAL: 'Physical',
    MOVEMENT: 'Movement',
    MANIPULATION: 'Manipulation',
};

/**
 * Stat names within trait groups, matching `data/traits.json` stat keys.
 * @type {Object.<string, string>}
 */
export const STAT_NAMES = {
    DURABILITY: 'durability',
    STRENGTH: 'strength',
    SHARPNESS: 'sharpness',
    VOLUME: 'volume',
};

/**
 * Builds the "trait.stat" flat-key form used in range expressions
 * (":Physical.strength"), stat maps, and world-state stat lookups
 * ("stats['Physical.durability']"). Centralizing it here keeps the flat-key
 * format reproducible instead of hand-joined in each call site.
 *
 * @param {string} trait - A trait-group name from TRAIT_GROUPS.
 * @param {string} stat - A stat name from STAT_NAMES.
 * @returns {string} The flat "trait.stat" key.
 */
export function flatKey(trait, stat) {
    return `${trait}.${stat}`;
}

/**
 * Durability boundary at which a component is BROKEN: the component-broke
 * pipeline fires when durability crosses from `old > 0` to `new <= 0`
 * (TriggerController spec).
 * @type {number}
 */
export const DURABILITY_BROKEN_AT = 0;

/**
 * Minimum durability at which a component is still USABLE by actors (NPC /
 * instinct targeting filters components below this).
 *
 * Deliberate gap with DURABILITY_BROKEN_AT: a component with fractional
 * durability 0 < dur < 1 is already broken (the broken boundary is crossed)
 * yet still passes the "usable" test used by targeting code. The existing
 * `dur >= 1` checks encode that gap; this constant names it rather than
 * papering over it.
 * @type {number}
 */
export const DURABILITY_USABLE_MIN = 1;

/**
 * Canonical mapping-key form for trait→stat derivation entries
 * (knowledge_viewer_spec.md §2, risk R3): "<TraitGroup>.<stat>".
 * Single definition shared by KnowledgeController._validateMappingEntries()
 * and MaterialController._validateMappingRegistry() so the two boot
 * validators can never disagree on key form.
 * Deliberately accepts any letters (does NOT restrict to the canonical
 * capitalized group names) — tightening that is a data-visible change.
 */
export const TRAIT_STAT_KEY_PATTERN = /^[A-Za-z]+\.[A-Za-z_]+$/;

/**
 * StatVocabulary — Shared, environment-agnostic trait/stat name vocabulary.
 *
 * SINGLE SOURCE OF TRUTH for the trait-group names, stat names, damage-channel
 * names, named-trait flag names, and transient condition names used by BOTH the
 * Node server and the browser. These strings form a WIRE CONTRACT: world-state
 * stat maps (the nested `stats[<group>][<stat>]` form and the flat
 * `stats['<group>.<stat>']` form), the requirement definitions in
 * `data/actions.json`, the derived-stat keys in `data/propertyTraitMapping.json`,
 * and the range expressions in `shared/RangeResolver.js` all key off exactly
 * these strings, so a spelling that drifts from the data files silently breaks
 * stat lookups and damage application. The data files under `data/*.json` must
 * match this vocabulary, never the other way around.
 *
 * The names below encode the recipe → derivation model
 * (see `wiki/basic_traits_and_stats_spec.md`):
 *   - MATTER-derived stats: `existence` (a 0–1 ratio of the matter that
 *     remains), the six channel resistances, `mass`, and `sharpness` (a
 *     depletable quality of the edge material);
 *   - FORM-derived stat: `volume` (size declared by the recipe);
 *   - FUNCTION stats, granted by internal components (organs): `strength`,
 *     `move`, `fine_controls`, `think_level`;
 *   - RESOURCE stat, seeded and charged by an organ: `energy` (the coal
 *     generator's battery — charge-only, no material source, single organ
 *     source);
 *   - named-trait FLAGS (gate and mark, never patch numbers): `flammable`,
 *     `conductive`, `corrosive`;
 *   - transient CONDITIONS (stored per instance): `burning`, `wet`, `corroded`;
 *   - DAMAGE CHANNELS: cut, impact, wear, heat, electricity, corrosion.
 *
 * A component is matter, shaped, and given function — every stat it has is
 * re-derived from exactly one of those three sources, so nothing a player can
 * see is without a cause. `existence` replaces the retired `durability` health
 * bar: there is now one store (matter), so save/load and client/server sync
 * cannot desynchronize.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same ES module
 * can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * @module StatVocabulary
 */

/**
 * Trait-group names as used in the world state and in the derived-stat keys.
 *
 * Groups are NAMESPACE labels for the `group.stat` wire keys. A stat's group is
 * independent of its derivation source: for example `strength` is a function
 * stat (granted by an organ) yet it lives in the `Physical` namespace because
 * that is the flat key the action/range layer resolves against.
 *
 * The retired `Spatial` group is gone — a component's positioning offsets moved
 * out of the stat contract into recipe form data (see the recipe model), so
 * position is no longer a stat.
 * @type {Object.<string, string>}
 */
export const TRAIT_GROUPS = {
    PHYSICAL: 'Physical',
    MOVEMENT: 'Movement',
    MANIPULATION: 'Manipulation',
    MIND: 'Mind',
};

/**
 * Stat names matching the derived stat set. Exactly one source per stat:
 *   - MATTER (from the composition): `existence`, the six channel
 *     resistances, `mass`, and a depletable `sharpness`;
 *   - FORM (from the recipe): `volume`;
 *   - FUNCTION (granted by an internal component): `strength`, `move`,
 *     `fine_controls`, `think_level`.
 *
 * Scale: 0–100 for every material property and every derived or organ-granted
 * stat (the existing convention across data files), EXCEPT `existence`, which
 * is a 0–1 ratio of remaining matter — a ratio, not a tuned quantity.
 * @type {Object.<string, string>}
 */
export const STAT_NAMES = {
    EXISTENCE: 'existence',
    CUT_RESISTANCE: 'cut_resistance',
    IMPACT_RESISTANCE: 'impact_resistance',
    WEAR_RESISTANCE: 'wear_resistance',
    HEAT_RESISTANCE: 'heat_resistance',
    ELECTRICITY_RESISTANCE: 'electricity_resistance',
    CORROSION_RESISTANCE: 'corrosion_resistance',
    MASS: 'mass',
    SHARPNESS: 'sharpness',
    VOLUME: 'volume',
    STRENGTH: 'strength',
    MOVE: 'move',
    FINE_CONTROLS: 'fine_controls',
    THINK_LEVEL: 'think_level',
    ENERGY: 'energy',
};

/**
 * Damage-channel names. Damage arrives with a channel and consumes matter one
 * material at a time, starting with the material least resistant to that
 * channel, so a cut is trivial on iron and fatal on a cable. The six channels
 * map one-to-one onto the six material properties in `data/materials.json` —
 * three as direct resistance, three as susceptibility inverted at conversion —
 * so no new material science is invented; the translation lives in
 * `data/propertyTraitMapping.json`, the single balance lever.
 * @type {Object.<string, string>}
 */
export const DAMAGE_CHANNELS = {
    CUT: 'cut',
    IMPACT: 'impact',
    WEAR: 'wear',
    HEAT: 'heat',
    ELECTRICITY: 'electricity',
    CORROSION: 'corrosion',
};

/**
 * Named-trait FLAG names. Flags gate and mark — they decide WHICH damage
 * channels and interactions apply to a component; they never add or multiply a
 * stat value (that would give a stat a second source and break derivation).
 *   - `flammable`, `conductive`: derived on read whenever a material property
 *     crosses a threshold declared in `data/propertyTraitMapping.json`;
 *   - `corrosive`: granted by a specific internal component (organ).
 * @type {Object.<string, string>}
 */
export const FLAG_NAMES = {
    FLAMMABLE: 'flammable',
    CONDUCTIVE: 'conductive',
    CORROSIVE: 'corrosive',
};

/**
 * Transient CONDITION names, stored per instance in world state. They are
 * *events that happened*, so they must survive save/load and be visible to the
 * client and the LLM context. Conditions apply damage over time: a `burning`
 * component loses matter to the heat channel; a `corroded` one loses matter to
 * the corrosion channel with no attacker at all; `wet` modulates how heat and
 * electricity channels interact with a component that holds moisture.
 * @type {Object.<string, string>}
 */
export const CONDITION_NAMES = {
    BURNING: 'burning',
    WET: 'wet',
    CORRODED: 'corroded',
};

/**
 * Builds the "trait.stat" flat-key form used in range expressions
 * (":Physical.strength"), derived-stat keys, and world-state stat lookups
 * ("stats['Physical.existence']"). Centralizing it here keeps the flat-key
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
 * Existence boundary at which a component is GONE: the ceased-to-exist pipeline
 * fires when existence crosses from `old > 0` to `new <= 0` (all matter
 * consumed). Existence is a 0–1 ratio of remaining matter, so the boundary
 * sits at 0 — replacing the retired `durability` health bar with the matter
 * store itself. When existence reaches zero the component is removed from its
 * entity and whatever matter still has shape drops as salvage.
 * @type {number}
 */
export const EXISTENCE_GONE_AT = 0;

/**
 * Minimum existence at which a component is still USABLE by actors (NPC /
 * instinct targeting filters components at or below this). Existence is a
 * 0–1 ratio, so a component stays usable for as long as any matter remains
 * (existence > 0). The gone and usable boundaries therefore coincide at 0, and
 * the retired `durability` stat's deliberate "broken-but-usable" gap no longer
 * applies — with one store there is no gap to encode.
 * @type {number}
 */
export const EXISTENCE_USABLE_MIN = 0;

/**
 * Canonical mapping-key form for trait→stat derivation entries
 * (wiki/subMDs/frontend/knowledge_viewer.md, risk R3): "<TraitGroup>.<stat>".
 * Single definition shared by KnowledgeController._validateMappingEntries()
 * and MaterialController._validateMappingRegistry() so the two boot
 * validators can never disagree on key form.
 * Deliberately accepts any letters (does NOT restrict to the canonical
 * capitalized group names) — tightening that is a data-visible change.
 */
export const TRAIT_STAT_KEY_PATTERN = /^[A-Za-z]+\.[A-Za-z_]+$/;

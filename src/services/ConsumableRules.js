/**
 * ConsumableRules — the shape of an item that can be EATEN (`wiki/decisions/consumable-items.md`).
 *
 * A consumable is an ordinary item that carries one extra block:
 *
 *   "consume": { "targetStat": "Physical.energy", "energyGain": 15 }
 *
 * The block is the WHOLE of the mechanic. Eating spends the item and moves
 * `energyGain` onto a whole-entity attribute, clamped at that attribute's own
 * `max` (`data/mods/core-entity-attributes/entityAttributes.json` is the ceiling
 * on every write, exactly as it is for the coal burner's
 * `consumeFuelGenerateStat` — same charge semantics, different trigger: the organ
 * burns fuel on a cadence, the `eat` action spends food on a decision).
 *
 * Why a block on the item and not a new registry kind: the item is what the actor
 * chose, the action (`eat`) is generic, and the number is a balance lever a mod
 * can move without code. A new kind would buy nothing — there is no second
 * registry to join (`CR NAME-3`, `wiki/decisions/consumable-items.md`).
 *
 * The rule is PURE (CR B-2) and read-only over the definition — it never touches
 * world state. Two thin readers over ONE implementation:
 *  - `parseConsumeBlock` THROWS on a malformed block, for the edge
 *    (`src/services/CompositionClassifier.js`): a definition whose block names
 *    nothing is quarantined, not shipped as dead data (`T-1`).
 *  - `resolveConsumable` returns `null` for absent OR malformed, for the hot path
 *    (the `eat` consequence). A world that is already running must answer "this is
 *    not food", never throw at a player (`CR ERR-3`); the malformed definition is
 *    already reported at boot by the classifier.
 *
 * @module ConsumableRules
 */

import { TRAIT_GROUPS, STAT_NAMES, flatKey, TRAIT_STAT_KEY_PATTERN } from '../../shared/StatVocabulary.js';

/** The item-definition key that carries the block. @type {string} */
export const CONSUME_KEY = 'consume';

/**
 * The whole-entity attributes a consumable may charge: the meters a body runs
 * down and refills. Energy is the life pool (0 eliminates); pleasure is a state,
 * never a death. Anything else — a component stat, a skill, an existence repair —
 * is a different mechanic and is refused here rather than invented later.
 * @type {ReadonlySet<string>}
 */
export const CONSUMABLE_TARGET_STATS = Object.freeze(new Set([
    flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.ENERGY),
    flatKey(TRAIT_GROUPS.PLEASURE, STAT_NAMES.PLEASURE)
]));

/**
 * The one implementation. Validates and normalizes a `consume` block.
 *
 * @param {unknown} block - The `consume` value as authored.
 * @param {string} label - Whose data this is, as it should read in the message
 *   ('Item "apple"').
 * @returns {{ traitId: string, statName: string, targetStat: string, energyGain: number }}
 * @throws {TypeError} When the block is present and malformed.
 */
function readConsume(block, label) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
        throw new TypeError(`${label}: "${CONSUME_KEY}" must be an object of the form { targetStat, energyGain }.`);
    }

    const targetStat = typeof block.targetStat === 'string' ? block.targetStat.trim() : '';
    if (!TRAIT_STAT_KEY_PATTERN.test(targetStat)) {
        throw new TypeError(`${label}: consume "${CONSUME_KEY}.targetStat" must be a "Group.stat" key (e.g. "Physical.energy").`);
    }
    if (!CONSUMABLE_TARGET_STATS.has(targetStat)) {
        throw new TypeError(`${label}: consume "${CONSUME_KEY}.targetStat" must be one of ${[...CONSUMABLE_TARGET_STATS].join(', ')} (a whole-entity resource).`);
    }

    const energyGain = block.energyGain;
    if (typeof energyGain !== 'number' || !Number.isFinite(energyGain) || energyGain <= 0) {
        throw new TypeError(`${label}: consume "${CONSUME_KEY}.energyGain" must be a positive finite number.`);
    }

    const dot = targetStat.indexOf('.');
    return {
        traitId: targetStat.slice(0, dot),
        statName: targetStat.slice(dot + 1),
        targetStat,
        energyGain
    };
}

/**
 * The edge reader: a normalized block, or `null` when the item declares none.
 * @param {unknown} itemDef - An item definition from the `inventoryItems` registry.
 * @param {string} [label] - Whose data this is, for the message.
 * @returns {{ traitId: string, statName: string, targetStat: string, energyGain: number }|null}
 * @throws {TypeError} When a block is present and malformed.
 */
export function parseConsumeBlock(itemDef, label) {
    if (!itemDef || typeof itemDef !== 'object' || itemDef[CONSUME_KEY] === undefined) return null;
    return readConsume(itemDef[CONSUME_KEY], label || 'Item');
}

/**
 * The hot-path reader: a normalized block for a real item definition, or `null`
 * when the item is absent, declares nothing, or declares it badly (a bad block is
 * the classifier's business, and a running world answers instead of throwing).
 * @param {unknown} itemDef - An item definition from the `inventoryItems` registry.
 * @returns {{ traitId: string, statName: string, targetStat: string, energyGain: number }|null}
 */
export function resolveConsumable(itemDef) {
    try {
        return parseConsumeBlock(itemDef, 'Item');
    } catch {
        return null;
    }
}

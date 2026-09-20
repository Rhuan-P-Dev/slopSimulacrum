/**
 * EntityAttributeData — client-side access to WHOLE-ENTITY attributes.
 *
 * Whole-entity attributes (e.g. the M1 droid's `Physical.energy`) live on the
 * ENTITY object in the broadcast world state — NOT on a component instance.
 *   - `entity.attributes[group][stat]`        -> the live per-stat value.
 *   - `entity.attributesConfig[group][stat]`  -> the declaration:
 *     { value, max, drainPerTurn }.
 *
 * This is distinct from the per-component stats that StatBarsManager reads
 * (those come from `state.components.instances`). Entity attributes are
 * seeded at spawn from data/entity_attributes.json (see the wiki doc) and are
 * the target of the coal-generator's fuel burn (which charges the host entity)
 * and the per-turn drain that kills the entity at 0.
 *
 * The display table (`ATTRIBUTE_DISPLAY`) is the single, data-driven source of
 * truth for which whole-entity attributes get a bar and how each is shown.
 * Adding a new visible attribute = add its declaration to the data file and a
 * single display entry here — no renderer changes.
 *
 * @module EntityAttributeData
 */
import { TRAIT_GROUPS } from '../../shared/StatVocabulary.js';

/**
 * Display configuration for the whole-entity attributes that get a bar.
 * Keys are flat "Group.stat" strings (TRAIT_GROUPS.PHYSICAL = 'Physical').
 *
 * `energy` — the M1 droid's life fuel: drained 1/turn, refilled by the coal
 * generator burning coal, and the entity dies when it hits 0. Amber is the
 * "power/fuel" hue (the same as the Movement trait).
 */
export const ATTRIBUTE_DISPLAY = Object.freeze({
    [`${TRAIT_GROUPS.PHYSICAL}.energy`]: {
        label: 'Energy',
        color: '#f59e0b',
        icon: '⚡',
    },
});

/**
 * Reads the live value of a whole-entity attribute.
 * @param {Object|null} entity - The entity object (or null).
 * @param {string} traitId - The trait group (e.g. 'Physical').
 * @param {string} statName - The stat key (e.g. 'energy').
 * @returns {number|null} The value, or null when absent.
 */
export function getEntityAttribute(entity, traitId, statName) {
    if (!entity || !entity.attributes) return null;
    const group = entity.attributes[traitId];
    return group ? group[statName] : null;
}

/**
 * Reads the declaration of a whole-entity attribute.
 * @param {Object|null} entity - The entity object (or null).
 * @param {string} traitId - The trait group.
 * @param {string} statName - The stat key.
 * @returns {?{value: number, max: number, drainPerTurn: number}}
 *     The declaration, or null when absent.
 */
export function getEntityAttributeConfig(entity, traitId, statName) {
    if (!entity || !entity.attributesConfig) return null;
    const group = entity.attributesConfig[traitId];
    return group ? group[statName] : null;
}

/**
 * Returns the full declaration map, or null when the entity has none.
 * @param {Object|null} entity - The entity object (or null).
 * @returns {Object|null} The `attributesConfig` map.
 */
export function getEntityAttributeDeclarations(entity) {
    if (!entity || !entity.attributesConfig) return null;
    return entity.attributesConfig;
}

/**
 * Builds the flat display-key for a trait/stat pair (matches ATTRIBUTE_DISPLAY).
 * @param {string} traitId - The trait group.
 * @param {string} statName - The stat key.
 * @returns {string} The "Group.stat" key.
 */
export function flatAttributeKey(traitId, statName) {
    return `${traitId}.${statName}`;
}

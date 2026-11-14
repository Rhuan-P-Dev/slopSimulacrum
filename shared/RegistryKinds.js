/**
 * RegistryKinds — Shared, environment-agnostic registry-kind vocabulary.
 *
 * SINGLE SOURCE OF TRUTH for the names of the world-definition registries
 * (the parsed contents of the world data files). Before this module, every
 * reader named a *path* (`'data/mods/core-components/components.json'`), which made the
 * filesystem the interface of the world definition: 49 references in `src/`
 * and 89 in `test/`, and no way to change what the world is made of while the
 * server runs.
 *
 * A *kind* is the stable name of one registry. A reader asks the
 * `RegistryStore` for a kind and never learns where the bytes came from —
 * which is what lets a mod package become the source of the same registry at
 * runtime (see `wiki/decisions/mod-system.md`).
 *
 * The kind names are a WIRE CONTRACT, in the sense used by
 * `shared/StatVocabulary.js`: they appear in mod manifests (`content` keys),
 * in the `GET /api/mods` payload and in the store's own errors. Renaming one
 * is a breaking change to every mod written against it.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same ES module
 * can be imported by the Node server and by the browser (served as a module
 * via the `/shared/` static route).
 *
 * @module RegistryKinds
 */

/**
 * The world-definition registry kinds. One kind per data file the world is
 * built from (`REGISTRY_KIND_COUNT` is asserted against it by the store
 * tests, so a kind added here without a source is a visible test failure
 * rather than a silently empty registry).
 *
 * @type {Object.<string, string>}
 */
export const REGISTRY_KINDS = Object.freeze({
    // The part family: how a component recipe, an organ, an item is defined.
    COMPONENTS: 'components',
    HOLDING_COST: 'holdingCost',
    INTERNAL_COMPONENTS: 'internalComponents',
    INVENTORY_ITEMS: 'inventoryItems',
    SENSITIVE_PARTS: 'sensitiveParts',
    TRAITS: 'traits',
    // The body family: blueprint = component tree, and its inhabitants.
    BLUEPRINTS: 'blueprints',
    ENTITY_ATTRIBUTES: 'entityAttributes',
    NPCS: 'npcs',
    // What a body wears at birth, by blueprint key (the same key a card's saved
    // body is stored under). The garment itself stays an `inventoryItems`
    // definition with a `wear.minVolume`; this registry only says who wears it,
    // and on which component (`src/controllers/logic/OutfitLogic.js`).
    OUTFITS: 'outfits',
    // Matter: its damage split, its chunk drops, its derived stats.
    MATERIALS: 'materials',
    MATERIAL_DAMAGE_TYPES: 'materialDamageTypes',
    MATERIAL_DROP_RATES: 'materialDropRates',
    PROPERTY_TRAIT_MAPPING: 'propertyTraitMapping',
    // The verb family: the verbs, the recipes, the machines, the synergy curves.
    ACTIONS: 'actions',
    CRAFTING: 'crafting',
    MACHINES: 'machines',
    SYNERGY: 'synergy',
    // The effect family: what a verb, a world law or a designed body does to a
    // body over time. An entry names operations from `shared/EffectVocabulary.js`;
    // the live instances are owned by `src/controllers/effects/EffectEngine.js`.
    EFFECTS: 'effects',
    // The world family: the map, the props, the world-level rules.
    ROOMS: 'rooms',
    WORLD: 'world',
    WORLD_OBJECTS: 'worldObjects',
    WORLD_RULES: 'worldRules',
});

/**
 * Every registry kind, in the order the composition root loads them.
 * Frozen so no caller can append a kind at runtime and skip validation.
 * @type {Array<string>}
 */
export const REGISTRY_KIND_LIST = Object.freeze(
    Object.values(REGISTRY_KINDS)
);

/**
 * How many registries the world definition consists of.
 * @type {number}
 */
export const REGISTRY_KIND_COUNT = REGISTRY_KIND_LIST.length;

/**
 * True when `kind` is a registry kind this codebase knows how to read.
 * The check every boundary uses before it trusts a kind from a manifest, a
 * request body or a store call (`T-1`, `T-2`).
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isRegistryKind(kind) {
    return typeof kind === 'string' && REGISTRY_KIND_LIST.includes(kind);
}

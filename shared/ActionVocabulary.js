/**
 * ActionVocabulary — Shared, environment-agnostic action-system vocabulary.
 *
 * SINGLE SOURCE OF TRUTH for the string literals that name the parts of the
 * action system: targeting types (how an action acquires its target),
 * component-binding roles (how component slots are filled in a resolved
 * action), action names (the exact keys of `data/actions.json`), and target
 * anchors. These strings appear in `data/actions.json` definitions, in
 * resolved action objects, and in comparisons across many controllers;
 * naming them once here stops the spellings from drifting between layers.
 *
 * Note: the string 'self_target' legitimately appears in BOTH
 * TARGETING_TYPES and BINDING_ROLES. It is a targetingType in
 * `data/actions.json` (the actor targets itself, no external target) and it
 * is also a binding role (a self-referencing component slot). The overlap is
 * intentional, not a conflict.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same
 * ES module can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * @module ActionVocabulary
 */

/**
 * Targeting types from `data/actions.json`: how an action resolves its
 * target — a point in space, a component, the actor itself, or nothing.
 * @type {Object.<string, string>}
 */
export const TARGETING_TYPES = {
    SPATIAL: 'spatial',
    COMPONENT: 'component',
    SELF_TARGET: 'self_target',
    NONE: 'none',
};

/**
 * Binding roles for the component slots of an action definition: the
 * "source" of an effect, its "target", a spatial reference, or a
 * self-referencing slot. 'self_target' intentionally overlaps with
 * TARGETING_TYPES.SELF_TARGET — see the module header.
 * @type {Object.<string, string>}
 */
export const BINDING_ROLES = {
    SOURCE: 'source',
    TARGET: 'target',
    SPATIAL: 'spatial',
    SELF_TARGET: 'self_target',
};

/**
 * Action names — the exact keys of `data/actions.json`. Used wherever code
 * names an action (NPC behavior strategies, instinct candidate lists,
 * capability entries) instead of re-typing the literal, so a rename in the
 * data file only has to happen in one place.
 * @type {Object.<string, string>}
 */
export const ACTION_NAMES = {
    MOVE: 'move',
    DASH: 'dash',
    PUNCH: 'droid punch',
    CUT: 'cut',
    SHOOT_T1: 'shootT1',
    SELF_HEAL: 'selfHeal',
    DROP_ITEM: 'dropItem',
    PICK_UP_ITEM: 'pickUpItem',
};

/**
 * Target anchors: named points an effect can originate from relative to a
 * component (e.g. the item currently held in the component's hand).
 * @type {Object.<string, string>}
 */
export const TARGET_ANCHORS = {
    EQUIPPED_ITEM: 'equippedItem',
};

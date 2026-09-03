/**
 * Utility functions and shared constants for NPC AI (predicate checks,
 * craft_loop configuration, and pure spatial helpers).
 *
 * @module npcAiUtils
 */

import { resolveRange } from '../../shared/RangeResolver.js';
import { ACTION_NAMES } from '../../shared/ActionVocabulary.js';
import { EXISTENCE_GONE_AT } from '../../shared/StatVocabulary.js';
import { PICK_UP_RANGE_FALLBACK } from './Constants.js';

/**
 * Resolves the pickup range (world-space units) used by the craft_loop
 * behavior's Stage C "in range → pick up" decision.
 *
 * WHY (single source of truth — see the "Shared Modules" contract in
 * wiki/map.md): the pickup range has exactly one definition — the
 * `pickUpItem` action in data/actions.json, resolved through the shared
 * RangeResolver with the shared PICK_UP_RANGE_FALLBACK for missing data.
 * This function follows the exact same resolution path as
 * PickUpItemHandler (registry lookup → resolver → fallback), so the brain's
 * in-range decision and the handler's validation derive from the same value
 * by construction and can no longer drift. The previous hardcoded
 * `PICK_RANGE = 100` was precisely that drift: after the handler became
 * data-driven (50), the brain kept issuing pickups the handler rejected.
 *
 * Only the facade's public API is used (no internal state of other
 * controllers): `getActionRegistry()` and — for string expressions — the
 * injected requirement resolver, the same access shape the handler uses.
 *
 * @param {Object} facade — world state facade (the injected
 *   WorldStateController public API)
 * @param {Object} entity — the acting entity (its id feeds the requirement
 *   values when the range is a string expression)
 * @returns {number} the resolved pickup range in world-space units
 */
export function resolvePickUpRange(facade, entity) {
    const actionRegistry = (facade && typeof facade.getActionRegistry === 'function')
        ? (facade.getActionRegistry() || {})
        : {};
    const pickUpAction = actionRegistry[ACTION_NAMES.PICK_UP_ITEM];
    const rangeExpression = pickUpAction?.range;

    let maxRange = PICK_UP_RANGE_FALLBACK;
    if (typeof rangeExpression === 'number') {
        maxRange = rangeExpression;
    } else if (typeof rangeExpression === 'string' && rangeExpression.trim() !== '') {
        const requirementValues = (facade && facade.actionController?.requirementResolver)
            ? facade.actionController.requirementResolver.resolveEntityRequirementValues(entity?.id)
            : {};
        maxRange = resolveRange(rangeExpression, requirementValues, PICK_UP_RANGE_FALLBACK);
    }
    return maxRange;
}

/**
 * Recipe id the craft_loop behavior uses to convert one foraged item into an
 * output item. Keep in sync with data/crafting.json.
 * @constant {string}
 */
export const RECIPE_ID = 'single_knife_to_t1';

/**
 * Item type the craft_loop behavior forages. Fallback used when the recipe
 * registry is unavailable; the behavior prefers the first input type of
 * RECIPE_ID so the recipe stays the single source of truth.
 * @constant {string}
 */
export const TARGET_ITEM_TYPE = 'knife';

/**
 * Item type produced by RECIPE_ID — what the drone drops on the ground after
 * crafting. Keep in sync with data/crafting.json / data/inventoryItems.json.
 * @constant {string}
 */
export const CRAFT_OUTPUT_TYPE = 't1';

/**
 * Determines whether the entity is driven by a deterministic NPC brain
 * (i.e., it has an `npcConfig.ai` object with a non-empty `behavior` string).
 *
 * When this returns `true`, the LLM agent path must skip the entity so the
 * deterministic AI brain handles it instead.
 *
 * @param {Object|undefined} entity — the game entity to inspect
 * @returns {boolean} `true` if the entity has a valid deterministic brain config
 */
export function hasDeterministicBrain(entity) {
    const ai = entity?.npcConfig?.ai;
    return typeof ai?.behavior === 'string' && ai.behavior !== '';
}

/**
 * Finds the nearest dropped item in a given room (Euclidean distance,
 * ascending-id tie-break — fully deterministic) and reports its distance.
 *
 * Single owner of the spatial guards: entries without a matching `roomId`,
 * or with non-finite coordinates, are skipped. The pickup-range rule
 * (resolvePickUpRange — the same data-driven pickUpItem range the
 * PickUpItemHandler validates against) is deliberately NOT part of this
 * helper — it is owned by the calling behavior (craft_loop), mirroring how
 * chase_attack applies its own attack range after selecting its nearest
 * target.
 *
 * Returns `{ item, distance }` for the nearest qualifying entry, or null
 * when no candidate exists (empty input, no items in the room, or no
 * finite-coordinate items in the room).
 *
 * Pure — does not mutate its inputs.
 *
 * @param {Object[]|null|undefined} droppedItems — dropped item entries
 *   (`{ id, x, y, roomId, itemType, ... }`)
 * @param {string} roomId — the room uid to restrict the search to
 * @param {number} x — the searching entity's x coordinate
 * @param {number} y — the searching entity's y coordinate
 * @returns {{ item: Object, distance: number }|null} the nearest qualifying
 *   entry with its Euclidean distance, or null
 */
export function findNearestDroppedItem(droppedItems, roomId, x, y) {
    if (!Array.isArray(droppedItems) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }

    let best = null;
    let bestDistance = Infinity;
    for (const item of droppedItems) {
        if (!item || item.roomId !== roomId) continue;
        if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;

        const d = Math.hypot(x - item.x, y - item.y);
        if (best === null
            || d < bestDistance
            || (d === bestDistance && String(item.id) < String(best.id))) {
            best = item;
            bestDistance = d;
        }
    }
    return best ? { item: best, distance: bestDistance } : null;
}

/**
 * Core targetability predicate — the SINGLE source of truth for "is this
 * component usable as a target?".
 *
 * WHY this lives here and NOT in `shared/` (see the "Shared Modules" contract
 * in wiki/map.md): `shared/` is the cross-layer wire-contract vocabulary — the
 * strings/numbers the browser and the Node server must agree on byte-for-byte.
 * Targetability is server-only game logic: both the deterministic brain
 * (NpcAIController) and the LLM context (LlmContextController) run on the Node
 * server, and "a component is targetable iff its existence is unknown or >
 * gone" is a gameplay decision, not a wire contract. Keeping it here leaves
 * `shared/` minimal while giving both consumers ONE identical rule they cannot
 * drift apart.
 *
 * The rule: a component is USABLE iff its existence is UNKNOWN (the injected
 * reader returned `undefined` — no authoritative stat; we must not hide a
 * healthy entity over a missing read) OR its existence is strictly greater than
 * EXISTENCE_GONE_AT (any matter still remains). A component whose existence has
 * reached 0 (gone) is not usable.
 *
 * The existence read is INJECTED (`readExistence`) so each consumer keeps its
 * own data-source adapter (the brain's flat-key fallback for test fixtures, the
 * LLM context's inline `getComponentStats()` read). The core rule is enforced
 * in exactly one place, so the brain and the LLM context can never disagree
 * about what is targetable.
 *
 * Pure — does not mutate its inputs.
 *
 * @param {Object} component — a component instance (shape is reader-specific)
 * @param {Function} readExistence — (component) => number|undefined; the
 *   consumer's data-source adapter for the component's existence
 * @returns {boolean} true when the component is a usable target
 */
export function isComponentUsable(component, readExistence) {
    const existence = (typeof readExistence === 'function') ? readExistence(component) : undefined;
    return (existence === undefined) || (existence > EXISTENCE_GONE_AT);
}

/**
 * Filters a list of components down to the USABLE ones (core targetability).
 *
 * WHY: both the deterministic brain and the LLM context need "the components of
 * an entity that can still be damaged" — this is the shared half of that notion.
 * The existence read is injected so each consumer keeps its own data-source
 * adapter; the rule (unknown or > EXISTENCE_GONE_AT) is enforced once here.
 * A non-array input degrades to an empty list (never crashes on a malformed
 * entity copy).
 *
 * Pure — does not mutate its inputs.
 *
 * @param {Object[]|null|undefined} components — component instances
 * @param {Function} readExistence — (component) => number|undefined
 * @returns {Object[]} the components that are usable targets
 */
export function filterUsableComponents(components, readExistence) {
    const list = Array.isArray(components) ? components : [];
    return list.filter(comp => isComponentUsable(comp, readExistence));
}

/**
 * Core entity targetability predicate: true iff the entity carries at least one
 * usable component (see isComponentUsable).
 *
 * WHY: this is the single decision both the deterministic brain
 * (NpcAIController._isViableTarget) and the LLM context
 * (LlmContextController._isViableTarget) reduce to, once they have selected
 * WHICH component list to read (live vs. snapshot is a consumer-local concern).
 * A component-less entity is never viable (an empty list yields false), which
 * is the "ghost is not a target" guarantee shared by both consumers.
 *
 * Pure — does not mutate its inputs.
 *
 * @param {Object[]|null|undefined} components — component instances
 * @param {Function} readExistence — (component) => number|undefined
 * @returns {boolean} true when at least one component is a usable target
 */
export function hasUsableComponent(components, readExistence) {
    return filterUsableComponents(components, readExistence).length > 0;
}

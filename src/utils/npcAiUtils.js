/**
 * Utility functions and shared constants for NPC AI (predicate checks,
 * craft_loop configuration, and pure spatial helpers).
 *
 * @module npcAiUtils
 */

/**
 * Maximum distance (world-space units) at which the craft_loop behavior picks
 * up a dropped item. Keep in sync with PickUpItemHandler.maxRange and the
 * dropItem action range in data/actions.json (both 100).
 * @constant {number}
 */
export const PICK_RANGE = 100;

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
 * (PICK_RANGE) is deliberately NOT part of this helper — it is owned by the
 * calling behavior (craft_loop), mirroring how chase_attack applies its own
 * attack range after selecting its nearest target.
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

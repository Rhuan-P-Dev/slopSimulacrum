/**
 * CraftingController — state controller owning the crafting recipe registry.
 *
 * Per the State Controller pattern (wiki/subMDs/controllers/controller_patterns.md §4),
 * this controller holds raw data and has NO cross-controller dependencies: it is
 * constructed by the composition root (src/composition/WorldComposition.js) with
 * the raw `data/crafting.json` content (loaded there via
 * `DataLoader.loadJsonSafe('data/crafting.json', {})` — project rule §5) plus the
 * item registry from `data/inventoryItems.json` for cross-validation of every
 * input/output item type (fail-fast at startup, never mid-game).
 *
 * Responsibility split (crafting design spec §2.1): this controller owns recipe
 * definitions and pure "do these items satisfy this recipe?" checks only. It
 * never touches entity/item state — all item mutation stays in InventoryManager,
 * orchestrated by the WorldStateController facade (`craftItems`).
 *
 * Deliberately has NO `getAll()`: the static recipe registry must stay out of
 * the full-state broadcast aggregation (same exclusion rule as RoomChatController).
 *
 * @module CraftingController
 */

import Logger from '../../utils/Logger.js';

class CraftingController {
    /**
     * @param {Object} recipeRegistry - Raw data from data/crafting.json: a plain
     *   object keyed by recipe ID (same convention as data/actions.json).
     * @param {Object} itemRegistry - Raw data from data/inventoryItems.json, used
     *   to validate that every recipe input/output type exists (fail-fast).
     */
    constructor(recipeRegistry, itemRegistry) {
        this._recipeRegistry = recipeRegistry || {};
        this._itemRegistry = itemRegistry || {};
        this._validateRecipeDefinitions();
        Logger.info(`[CraftingController] initialized with ${Object.keys(this._recipeRegistry).length} recipe(s)`);
    }

    /**
     * Validates the recipe registry before initialization proceeds (project rule §6).
     * Throws TypeError on: non-object registry; a recipe entry that is not an
     * object; a key that does not match the recipe's `id`; missing/non-string or
     * empty `id` or `name`; non-string `description`; empty or non-array
     * `inputs`/`outputs`; an entry that is not an object, with a missing or
     * non-string `type`, or a `quantity` that is not an integer ≥ 1; or a `type`
     * that does not exist in the item registry.
     * @private
     */
    _validateRecipeDefinitions() {
        const registry = this._recipeRegistry;
        if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
            throw new TypeError('Crafting recipe registry must be a plain object keyed by recipe ID.');
        }

        for (const [key, recipe] of Object.entries(registry)) {
            if (typeof recipe !== 'object' || recipe === null || Array.isArray(recipe)) {
                throw new TypeError(`Recipe "${key}" must be an object.`);
            }
            if (typeof recipe.id !== 'string' || recipe.id.length === 0) {
                throw new TypeError(`Recipe "${key}" has a missing or empty "id" (string).`);
            }
            if (key !== recipe.id) {
                throw new TypeError(`Recipe key "${key}" does not match its id field "${recipe.id}".`);
            }
            if (typeof recipe.name !== 'string' || recipe.name.length === 0) {
                throw new TypeError(`Recipe "${key}" has a missing or empty "name" (string).`);
            }
            if (recipe.description !== undefined && typeof recipe.description !== 'string') {
                throw new TypeError(`Recipe "${key}" has a non-string "description".`);
            }
            this._validateRecipeEntries(recipe, 'inputs');
            this._validateRecipeEntries(recipe, 'outputs');
        }
    }

    /**
     * Validates one of the recipe's item lists: must be a non-empty array whose
     * entries are `{ type: string (known item type), quantity: integer ≥ 1 }`.
     * @param {Object} recipe - The recipe being validated (for error context).
     * @param {'inputs'|'outputs'} field - Which list to validate.
     * @private
     */
    _validateRecipeEntries(recipe, field) {
        const entries = recipe[field];
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new TypeError(`Recipe "${recipe.id}" has a missing or empty "${field}" array.`);
        }
        for (const entry of entries) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                throw new TypeError(`Recipe "${recipe.id}" has a non-object "${field}" entry.`);
            }
            if (typeof entry.type !== 'string' || entry.type.length === 0) {
                throw new TypeError(`Recipe "${recipe.id}" has a "${field}" entry with a missing or non-string "type".`);
            }
            if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
                throw new TypeError(`Recipe "${recipe.id}" has a "${field}" entry with invalid "quantity" ${entry.quantity} (must be an integer ≥ 1).`);
            }
            if (!this._itemRegistry[entry.type]) {
                throw new TypeError(`Recipe "${recipe.id}" references unknown item type "${entry.type}" in "${field}".`);
            }
        }
    }

    /**
     * Returns all recipe definitions.
     * @returns {Array<Object>} Defensive deep copy of every recipe (array form,
     *   suitable for GET /crafting/recipes).
     */
    getRecipes() {
        return structuredClone(Object.values(this._recipeRegistry));
    }

    /**
     * Returns a single recipe definition by ID.
     * @param {string} recipeId - The recipe ID (key of data/crafting.json).
     * @returns {Object|null} Defensive deep copy of the recipe, or null if unknown.
     */
    getRecipe(recipeId) {
        const recipe = this._recipeRegistry[recipeId];
        return recipe ? structuredClone(recipe) : null;
    }

    /**
     * Checks whether a recipe ID exists in the registry.
     * @param {string} recipeId - The recipe ID.
     * @returns {boolean}
     */
    hasRecipe(recipeId) {
        return Object.prototype.hasOwnProperty.call(this._recipeRegistry, recipeId);
    }

    /**
     * Pure check: do the given items satisfy the recipe's inputs?
     * This method receives an already-filtered array (the caller is responsible
     * for selecting the items hosted on the crafting component) and only counts
     * occurrences of each required input type; extra item types are ignored.
     * @param {Array<Object>} componentItems - Item instances to count (each has a `type`).
     * @param {Object} recipe - A recipe (raw or deep-copied).
     * @returns {{ satisfied: boolean, missing: Array<{ type: string, have: number, need: number }> }}
     */
    checkRequirements(componentItems, recipe) {
        const counts = {};
        for (const item of componentItems) {
            if (item && typeof item.type === 'string') {
                counts[item.type] = (counts[item.type] || 0) + 1;
            }
        }

        const missing = [];
        let satisfied = true;
        for (const input of recipe.inputs) {
            const have = counts[input.type] || 0;
            if (have < input.quantity) {
                satisfied = false;
                missing.push({ type: input.type, have, need: input.quantity });
            }
        }

        return { satisfied, missing };
    }
}

export default CraftingController;

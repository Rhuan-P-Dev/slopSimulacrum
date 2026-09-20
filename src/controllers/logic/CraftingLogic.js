/**
 * CraftingLogic — FASE 6 (facade logic extraction).
 *
 * The synchronous craft transaction (POST /api/crafting/...): resolve
 * recipe/entity/component, validate input instances (duplicates, existence,
 * type, host, nested contents), exact multiset check, volume pre-check
 * BEFORE any mutation (no-item-loss guard, wiki/subMDs/systems/crafting_system.md
 * §7), consume inputs, produce outputs on the same component, broadcast.
 * Never throws — every failure returns a `code` the route maps to a status.
 *
 * Extracted verbatim from WorldStateController (only change: `this.` became
 * `facade.` and the methods became plain functions). The facade keeps a thin
 * delegator method per extracted method so instance-level spies/mocks and
 * direct calls keep working. Narrow-deps rule (mirrors
 * consequences/DropItemHandler.js): `facade` is the WorldStateController
 * instance and each function only uses the members named in its JSDoc.
 */

import DataLoader from '../../utils/DataLoader.js';
import Logger from '../../utils/Logger.js';
import { DEFAULT_ITEM_VOLUME } from '../../../shared/Defaults.js';

/**
 * Crafts a recipe: consumes the given item instances from a component and
 * produces the recipe's outputs on the SAME component. Pure UI-panel
 * feature: no world effect, no range, no room requirement, no turn
 * (crafting is deliberately NOT a registry action — it executes
 * synchronously outside the round system, like the other inventory ops).
 *
 * Volume is pre-checked BEFORE consumption (free + freed ≥ needed) so a
 * full component can never destroy inputs; with that guarantee and
 * single-threaded execution the consume→add sequence is atomic in effect
 * (item-loss prevention — the data-corruption class of BUG-008).
 *
 * Every item mutation goes through InventoryManager (single source of
 * truth); this method only orchestrates. Never throws — every failure
 * returns a `code` the route maps to a status:
 *   1. resolve recipe (_resolveCraftTarget)
 *                                           → RECIPE_NOT_FOUND
 *   2. resolve entity (_resolveCraftTarget)
 *                                           → ENTITY_NOT_FOUND
 *   3. component on the entity (_resolveCraftTarget)
 *                                           → COMPONENT_NOT_FOUND
 *   4. resolve each requested item (_validateCraftInputs: must exist,
 *      be typed `item-*`, be hosted on `componentId`, not appear twice
 *      in `itemIds`, and hold no nested items)
 *                                           → INVALID_ITEM
 *   5. item multiset exactly matches the recipe inputs
 *      (CraftingController.checkExactInputs)
 *                                           → INPUTS_MISMATCH
 *   6. volume pre-check (_precheckCraftVolume, before any mutation)
 *                                           → INSUFFICIENT_VOLUME
 *   7. remove each input item (_consumeCraftInputs, in order)
 *   8. add each output item (_produceCraftOutputs) on the same component
 *   9. broadcast (null-guarded, mirrors addItemToEntity)
 *  10. return { success, recipeId, consumed, produced }
 *
 * @param {string} entityId - Typed entity ID (ent-<uuid>).
 * @param {string} recipeId - Recipe ID from data/crafting.json.
 * @param {string} componentId - Typed component ID (comp-<uuid>) hosting the inputs AND receiving the outputs.
 * @param {string[]} itemIds - Exact item instance IDs (item-<uuid>) to consume; must exactly satisfy the recipe inputs.
 * @returns {{ success: boolean, code?: string, message?: string, recipeId?: string, consumed?: string[], produced?: Object[] }}
 */


function executeCraftTransaction(facade, entityId, recipeId, componentId, itemIds) {
    // DELIBERATELY SYNCHRONOUS: no await anywhere in this chain (steps
    // 1–10, including the helpers). Concurrent identical POSTs serialize
    // safely because each craft is a synchronous transaction; do NOT
    // introduce an await without re-evaluating that invariant.

    // 1–3. Resolve recipe, entity, and component.
    const target = facade._resolveCraftTarget(entityId, recipeId, componentId);
    if (!target.ok) {
        return { success: false, code: target.code, message: target.message };
    }
    const { recipe, entity } = target;

    // 4. Validate every requested item instance.
    const validated = facade._validateCraftInputs(recipe, entity, componentId, itemIds);
    if (!validated.ok) {
        return { success: false, code: validated.code, message: validated.message };
    }

    // 5. The multiset of item types must exactly match the recipe inputs.
    //    The controller is non-null here because the recipe was resolved
    //    from it in step 1.
    const { satisfied, missing } = facade.craftingController.checkExactInputs(validated.items, recipe);
    if (!satisfied) {
        // missing[0] is the first differing type (same order as the old
        // inline check) — the message text is unchanged.
        const first = missing[0];
        return { success: false, code: 'INPUTS_MISMATCH', message: `Craft inputs do not exactly match recipe "${recipeId}": ${first.type}: have ${first.have}, need ${first.need}.` };
    }

    // 6. Volume pre-check BEFORE any mutation (item-loss guard).
    const volume = facade._precheckCraftVolume(recipe, entity, componentId, validated.items);
    if (!volume.ok) {
        return { success: false, code: 'INSUFFICIENT_VOLUME', message: volume.message };
    }

    // 7. Consume the inputs (in the given order).
    const consumed = facade._consumeCraftInputs(entity, itemIds);
    if (!consumed.ok) {
        return { success: false, code: 'CRAFT_FAILED', message: consumed.message };
    }

    // 8. Produce the outputs on the SAME component.
    const produced = facade._produceCraftOutputs(recipe, entity, componentId);
    if (!produced.ok) {
        return { success: false, code: 'CRAFT_FAILED', message: produced.message };
    }

    // 9. Broadcast on success (null-guarded, exactly like addItemToEntity).
    if (facade._broadcastService) {
        facade._broadcastService.broadcast();
    }

    // 10.
    return { success: true, recipeId, consumed: [...itemIds], produced: produced.produced };
}

/**
 * Craft steps 1–3: resolve the recipe (from the injected
 * CraftingController), the entity, and the component on that entity.
 * @param {string} entityId
 * @param {string} recipeId
 * @param {string} componentId
 * @returns {{ok: true, recipe: Object, entity: Object, componentId: string} | {ok: false, code: string, message: string}}
 * @private
 */


function resolveCraftTarget(facade, entityId, recipeId, componentId) {
    // 1. Resolve the recipe (defensive copy; null when unknown). An
    //    unwired controller is a composition-root miswiring, not a
    //    normal runtime state — warn per call so it is never silent
    //    (same warn style as the not-found paths above).
    let recipe = null;
    if (facade.craftingController) {
        recipe = facade.craftingController.getRecipe(recipeId);
    } else {
        Logger.warn('[WorldStateController] craftingController is not wired (null); recipe lookups will fail — check the composition root (WorldComposition.js:158).');
    }
    if (!recipe) {
        return { ok: false, code: 'RECIPE_NOT_FOUND', message: `Recipe "${recipeId}" not found.` };
    }

    // 2. Resolve the entity (live reference — InventoryManager mutates it).
    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found for crafting.`);
        return { ok: false, code: 'ENTITY_NOT_FOUND', message: `Entity "${entityId}" not found.` };
    }

    // 3. The component must belong to this entity.
    const component = Array.isArray(entity.components)
        ? entity.components.find(c => c.id === componentId)
        : null;
    if (!component) {
        return { ok: false, code: 'COMPONENT_NOT_FOUND', message: `Component "${componentId}" not found on entity "${entityId}".` };
    }

    return { ok: true, recipe, entity, componentId };
}

/**
 * Craft step 4: validate every requested item instance. Early rejects,
 * in order: duplicate ID → existence → recipe-input type → host
 * component → nested contents.
 * @param {Object} recipe - The recipe (deep copy from CraftingController).
 * @param {Object} entity - The live entity.
 * @param {string} componentId
 * @param {string[]} itemIds
 * @returns {{ok: true, items: Array<Object>} | {ok: false, code: 'INVALID_ITEM', message: string}}
 * @private
 */


function validateCraftInputs(facade, recipe, entity, componentId, itemIds) {
    const entityId = entity.id;

    // Reject a duplicated ID BEFORE the per-item resolution loop: a
    // repeated ID cannot be consumed twice — the multiset check below
    // would count it once per occurrence, so a "satisfied" craft would
    // still remove only one instance while the caller believes both
    // were consumed. That is the item-loss class
    // wiki/subMDs/systems/crafting_system.md §7 exists to prevent.
    // Server-side by design: the route intentionally does not dedupe
    // itemIds (the explicit list stays the auditable request).
    const seenItemIds = new Set();
    for (const itemId of itemIds) {
        if (seenItemIds.has(itemId)) {
            return { ok: false, code: 'INVALID_ITEM', message: `Item ID "${itemId}" is listed more than once in itemIds; each item instance can only be consumed once.` };
        }
        seenItemIds.add(itemId);
    }

    // (per item) Each requested item must exist, be a recipe input
    // type, and be hosted on the crafting component (nested container
    // items are excluded naturally: their hostComponentId is a
    // container item ID).
    const items = [];
    for (const itemId of itemIds) {
        const item = facade.inventoryManager.getItem(entity, itemId);
        if (!item) {
            return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" not found on entity "${entityId}".` };
        }
        if (!facade._isRecipeInputType(recipe, item.type)) {
            return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" (type "${item.type}") is not an input of recipe "${recipe.id}".` };
        }
        if (item.hostComponentId !== componentId) {
            return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" is hosted on component "${item.hostComponentId}", not "${componentId}".` };
        }
        // A recipe input is consumed as a whole unit: removeItem cascades
        // to all descendants, so crafting an item that currently contains
        // nested items would silently destroy what it holds — the
        // item-loss class crafting_system.md §7 exists to prevent.
        // Containers with contents are rejected (the player must empty
        // them first). Public API only: collectNestedItems.
        if (facade.inventoryManager.collectNestedItems(entity, itemId).length > 0) {
            return { ok: false, code: 'INVALID_ITEM', message: `Item "${itemId}" contains nested items; empty it before crafting.` };
        }
        items.push(item);
    }

    return { ok: true, items };
}

/**
 * Craft step 6: volume pre-check BEFORE any mutation (item-loss guard).
 * The two sides measure different things, deliberately: `freed` is
 * INSTANCE-based (item.hostVolume ?? item.volume, the same unit
 * InventoryManager.getComponentVolume sums) because an item keeps the
 * footprint it was created with — data re-tuning never retro-changes
 * persisted items (cf. InventoryManager.resyncItemTraits) — so only the
 * stored footprints are what removal will actually free; `needed` is
 * DEFINITION-based via hostVolumeOf because NEW outputs pick up the
 * current definition footprint in InventoryManager.addItem. Computing
 * `freed` from the current definition would let a re-tuned definition
 * overstate the space a craft frees, admitting a consume that cannot
 * actually fit — the no-item-loss guarantee (crafting_system.md §7)
 * must hold under definition drift, so only `freed` is instance-based.
 * @param {Object} recipe - The recipe (deep copy from CraftingController).
 * @param {Object} entity - The live entity.
 * @param {string} componentId
 * @param {Array<Object>} items - The resolved input instances (step 4).
 * @returns {{ok: true} | {ok: false, message: string}}
 * @private
 */


function precheckCraftVolume(facade, recipe, entity, componentId, items) {
    const itemDefs = facade.inventoryManager.getItemDefinitions();
    const hostVolumeOf = (type) => {
        const def = itemDefs[type] || {};
        // recipe→derivation: the external footprint lives under form.externalVolume
        // (legacy top-level externalVolume is a fallback); the full volume lives under
        // form.volume. The footprint (what counts against a component's capacity) is the
        // external footprint when declared, else the full volume.
        // Deliberately NOT unified with getDefinitionFootprint (utils/definitionVolume.js):
        // its first two chain steps match, but its declared-volume fallback is the
        // DEFAULT_ITEM_VOLUME no-item-loss floor (an undeclared output must never read as a
        // zero-footprint item in a craft), while the helper falls back to
        // getDefinitionVolume (0 when undeclared). TODO: Refactor — revisit unifying the
        // external-footprint prefix once that fallback difference is reconciled.
        const external = (typeof def.form?.externalVolume === 'number')
            ? def.form.externalVolume
            : (typeof def.externalVolume === 'number' ? def.externalVolume : undefined);
        if (typeof external === 'number') return external;
        return (typeof def.form?.volume === 'number')
            ? def.form.volume
            : (typeof def.volume === 'number' ? def.volume : DEFAULT_ITEM_VOLUME);
    };
    const freed = items.reduce((sum, item) => sum + (item.hostVolume ?? item.volume ?? 0), 0);
    const needed = recipe.outputs.reduce((sum, output) => sum + hostVolumeOf(output.type) * output.quantity, 0);
    // Self-contained available-volume computation (does not rely on the InventoryManager
    // capacity check, which is intentionally non-enforcing). maxVolume comes from the
    // component definition's form.volume; usedVolume sums the items on the component.
    const componentDefs = DataLoader.loadJsonSafe('data/components.json', {});
    const comp = entity.components?.find(c => c.id === componentId);
    const compDef = comp ? (componentDefs[comp.type] || {}) : {};
    const maxVolume = (typeof compDef.form?.volume === 'number')
        ? compDef.form.volume
        : (typeof compDef.volume === 'number' ? compDef.volume : 0);
    const usedVolume = (entity.items || [])
        .filter(item => item.hostComponentId === componentId)
        .reduce((sum, item) => sum + (item.hostVolume ?? item.volume ?? 0), 0);
    const free = Math.max(0, maxVolume - usedVolume);
    if (free + freed < needed) {
        return { ok: false, message: `Component ${componentId} has ${free} free, gains ${freed}, needs ${needed}.` };
    }
    return { ok: true };
}

/**
 * Craft step 7: remove each input item (in the given order). A failure
 * here cannot be a volume issue (validated in step 6); any other
 * failure is a hard error and stops BEFORE producing anything.
 * @param {Object} entity - The live entity.
 * @param {string[]} itemIds
 * @returns {{ok: true} | {ok: false, message: string}}
 * @private
 */


function consumeCraftInputs(facade, entity, itemIds) {
    for (const itemId of itemIds) {
        const removed = facade.inventoryManager.removeItem(entity, itemId);
        if (!removed.success) {
            Logger.error(`[WorldStateController] Unexpected removal failure while crafting: ${removed.message}`);
            return { ok: false, message: removed.message };
        }
    }
    return { ok: true };
}

/**
 * Craft step 8: add each output item on the SAME component. Cannot fail
 * on volume: step 6 proved the final footprint fits, and prefixes of a
 * fitting total always fit. Output footprints come from the CURRENT
 * definitions (InventoryManager.addItem), not from persisted instances
 * — the outputs are brand-new items.
 * @param {Object} recipe - The recipe (deep copy from CraftingController).
 * @param {Object} entity - The live entity.
 * @param {string} componentId
 * @returns {{ok: true, produced: Array<Object>} | {ok: false, message: string}}
 * @private
 */


function produceCraftOutputs(facade, recipe, entity, componentId) {
    const produced = [];
    for (const output of recipe.outputs) {
        for (let i = 0; i < output.quantity; i++) {
            const added = facade.inventoryManager.addItem(entity, output.type, componentId, {
                componentController: facade.componentController
            });
            if (!added.success) {
                Logger.error(`[WorldStateController] Unexpected addition failure while crafting "${recipe.id}": ${added.message}`);
                return { ok: false, message: added.message };
            }
            produced.push(added.item);
        }
    }
    return { ok: true, produced };
}

/**
 * Checks whether an item type is one of the recipe's input types.
 * @param {Object} recipe - The recipe (deep copy from CraftingController).
 * @param {string} itemType - The item's type ID.
 * @returns {boolean}
 * @private
 */


function isRecipeInputType(facade, recipe, itemType) {
    return recipe.inputs.some(input => input.type === itemType);
}


export { executeCraftTransaction, resolveCraftTarget, validateCraftInputs, precheckCraftVolume, consumeCraftInputs, produceCraftOutputs, isRecipeInputType };

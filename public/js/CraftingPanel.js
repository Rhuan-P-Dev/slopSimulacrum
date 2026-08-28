/**
 * CraftingPanel
 * Client-side crafting overlay panel (crafting design spec §2.5/§4.7,
 * docs/crafting_design_spec.md). A pure UI-panel feature: no world entity,
 * no range/spatial validation, no turn consumed.
 *
 * Two zones:
 *   1. Available-items strip — item cards of the currently selected
 *      component (drag sources). The component resolves as: first ID from
 *      SelectionController (injected resolver), else the first component
 *      holding an item that matches any recipe input, else the first
 *      component holding any item.
 *   2. Recipe cards (CSS grid) — one card per recipe from
 *      GET /crafting/recipes; item display names/volumes resolve client-side
 *      from GET /inventory/registry (single source of truth).
 *
 * Drag & drop uses native HTML5 DnD (same API family as InventoryManager):
 *   - dragstart on an item card sets dataTransfer 'application/x-crafting-item'
 *   - dragover on a recipe card: always preventDefault; green --valid when
 *     the dragged item's type matches an UNSATISFIED input of that recipe,
 *     dimmed --invalid otherwise
 *   - drop appends the item to the client-local pending pool (deduped by
 *     item ID — an item is tracked exactly once, in exactly one recipe)
 *   - when all inputs of a card reach quantity the card gets --satisfied
 *     and the craft auto-executes (POST /crafting/:entityId/craft)
 *
 * The POST 200 body is used ONLY for an immediate "Crafted ✓" flash. The
 * authoritative inventory update arrives via the world-state-update
 * broadcast → refreshWorldAndActions() → refreshIfOpen(), so this panel
 * never applies manual inventory edits from the response.
 *
 * The pure pool/satisfaction/liveness/resolution logic is extracted as
 * named exports (addToPendingPool, removeFromPendingPool, clearPendingPool,
 * getPoolItemIds, getLiveItemIds, resolveCraftingComponent, prunePool,
 * prunePoolToComponent, pooledIdsKey, escapeHtml,
 * computeRecipeSatisfaction, selectCraftItemIds) and unit-tested without
 * any DOM (test/unit/CraftingPanel.test.js); the class below owns the DOM
 * wiring. Standing rule: every server-fetched map is defensive — guard
 * group values with Array.isArray before iteration. Every server-sourced
 * value is interpolated only through _escapeHtml; lookups by attribute use
 * dataset comparison, never selector interpolation.
 *
 * Logging: ClientLogger only (BUG-123 — no console.* on the client).
 *
 * @module CraftingPanel
 */
import ClientLogger from '/utils/ClientLogger.js';

/**
 * MIME type for dragged crafting items (custom, per the crafting design
 * spec — distinct from InventoryManager's 'text/plain' item moves).
 */
const CRAFTING_ITEM_MIME = 'application/x-crafting-item';

/**
 * Adds an item to a recipe's pending pool (pure, immutable).
 *
 * De-duplication rule: an item ID appears at most ONCE across the whole
 * pool (it can physically only be consumed by one craft), so adding an
 * ID that already exists anywhere returns the pool unchanged. Callers are
 * expected to only pass item types that are valid inputs of the target
 * recipe (the panel enforces that before calling).
 *
 * @param {Object} pool - Pending pool: { [recipeId]: { [itemType]: [itemId, ...] } }.
 * @param {string} recipeId - Recipe the item was dropped onto.
 * @param {string} itemType - The item's type ID (a recipe input type).
 * @param {string} itemId - The item instance's typed ID (item-uuid).
 * @returns {Object} A new pool object with the item added, or the same
 *   pool reference when the add is a no-op (empty args or duplicate ID).
 */
export function addToPendingPool(pool, recipeId, itemType, itemId) {
    if (!recipeId || !itemType || typeof itemId !== 'string' || itemId.length === 0) {
        return pool;
    }
    if (getPoolItemIds(pool).includes(itemId)) {
        return pool;
    }
    const recipePool = pool[recipeId] || {};
    const existing = recipePool[itemType] || [];
    return {
        ...pool,
        [recipeId]: {
            ...recipePool,
            [itemType]: [...existing, itemId]
        }
    };
}

/**
 * Removes a recipe's entries from the pending pool (pure, immutable).
 * Used after a successful craft: that recipe's pooled items were consumed,
 * while other recipes' in-progress pools are preserved.
 *
 * @param {Object} pool - The pending pool.
 * @param {string} recipeId - The recipe whose entries to remove.
 * @returns {Object} A new pool without that recipe, or the same reference
 *   when the recipe has no entries.
 */
export function removeFromPendingPool(pool, recipeId) {
    if (!recipeId || !(recipeId in (pool || {}))) {
        return pool;
    }
    const next = { ...pool };
    delete next[recipeId];
    return next;
}

/**
 * Clears the pending pool (pure).
 * @param {Object} _pool - The pending pool to clear.
 * @returns {Object} A fresh empty pool.
 */
export function clearPendingPool(_pool) {
    return {};
}

/**
 * Returns all pooled item IDs in insertion order (pure).
 * @param {Object} pool - The pending pool.
 * @returns {string[]} Flat list of item IDs across all recipes/types.
 */
export function getPoolItemIds(pool) {
    const ids = [];
    for (const byType of Object.values(pool || {})) {
        for (const itemIds of Object.values(byType || {})) {
            for (const id of itemIds) {
                ids.push(id);
            }
        }
    }
    return ids;
}

/**
 * Flattens the GET /inventory/:entityId items map into the list of live
 * item IDs. Written for the SERVER shape {componentId: [item, ...]}:
 * group keys are host component IDs but may also be container item IDs
 * (nested items, InventoryManager.getEntityItems) or '__unassigned__',
 * so only array-valued groups are walked and only string `id`s collected.
 * @param {Object|null} itemsByComponent
 * @returns {string[]}
 */
export function getLiveItemIds(itemsByComponent) {
    const ids = [];
    for (const items of Object.values(itemsByComponent ?? {})) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (item && typeof item.id === 'string') ids.push(item.id);
        }
    }
    return ids;
}

/**
 * Resolves which component the strip shows. ONLY entity-component IDs may
 * be returned: items-map group keys can be container item IDs (nested
 * items) or '__unassigned__', which must never be POSTed (the route
 * rejects non-comp- IDs).
 *   1) the selected component, if it is an entity component;
 *   2) the first entity component holding an item of any recipe-input type;
 *   3) the first entity component holding any item;
 *   4) the entity's first component; null if none.
 * @param {{selectedId: string|null, entityComponentIds: string[], itemsByComponent: Object|null, recipeInputTypes: string[]}} args
 * @returns {string|null}
 */
export function resolveCraftingComponent({ selectedId, entityComponentIds, itemsByComponent, recipeInputTypes }) {
    // 1) The selected component wins when it is an entity component
    //    (never a raw items-map group key).
    if (selectedId && entityComponentIds.includes(selectedId)) {
        return selectedId;
    }

    // 2) and 3) iterate the entity's components IN ORDER and look each key
    //    up in the items map — raw group keys (container item IDs,
    //    '__unassigned__') can never leak into the result, and the stable
    //    component order is preserved.
    const groups = itemsByComponent ?? {};
    const itemsOf = (compId) => {
        const items = groups[compId];
        return Array.isArray(items) ? items : [];
    };
    if (recipeInputTypes.length > 0) {
        const relevant = new Set(recipeInputTypes);
        for (const compId of entityComponentIds) {
            if (itemsOf(compId).some(item => item && relevant.has(item.type))) {
                return compId;
            }
        }
    }
    for (const compId of entityComponentIds) {
        if (itemsOf(compId).length > 0) {
            return compId;
        }
    }
    return entityComponentIds[0] ?? null;
}

/**
 * Shared entry-splicing mechanics for the two pool pruners (private, pure):
 * filters each type's ID list through keepIdFn, drops types and recipes
 * that become empty, and returns the SAME pool reference when nothing
 * changed (callers rely on that for cheap no-op refreshes).
 * @param {Object} pool - The pending pool.
 * @param {(id: string) => boolean} keepIdFn - Whether an ID survives.
 * @returns {Object} A new pruned pool, or the same reference when unchanged.
 */
function _pruneEntries(pool, keepIdFn) {
    const pruned = {};
    let changed = false;
    for (const [recipeId, byType] of Object.entries(pool || {})) {
        const recipeEntry = {};
        for (const [type, itemIds] of Object.entries(byType || {})) {
            const kept = itemIds.filter(keepIdFn);
            if (kept.length !== itemIds.length) changed = true;
            if (kept.length > 0) recipeEntry[type] = kept;
        }
        if (Object.keys(recipeEntry).length > 0) {
            pruned[recipeId] = recipeEntry;
        } else if (pool[recipeId]) {
            changed = true;
        }
    }
    return changed ? pruned : pool;
}

/**
 * Drops pooled items that no longer exist in the live inventory (pure).
 * Called on every broadcast refresh so the pool never references a
 * consumed/removed instance (e.g. after another client or an NPC mutated
 * the same component).
 *
 * @param {Object} pool - The pending pool.
 * @param {Iterable<string>} liveItemIds - Item IDs currently present in the
 *   entity's inventory (any component).
 * @returns {Object} A new pool with stale entries removed, or the same
 *   reference when nothing changed.
 */
export function prunePool(pool, liveItemIds) {
    const live = new Set(liveItemIds);
    return _pruneEntries(pool, (id) => live.has(id));
}

/**
 * Drops pool entries not hosted on the given component (pure). The pool is
 * bound to the strip component: a POST names exactly one component (server
 * contract, WorldStateController step 4), so entries from other components
 * can never be consumed together and would only produce guaranteed
 * INVALID_ITEM failures.
 * @param {Object} pool - The pending pool.
 * @param {Object|null} itemsByComponent - fresh GET /inventory map
 * @param {string|null} componentId - The strip component to bind to
 *   (null clears everything: with no resolvable component no valid POST
 *   is possible).
 * @returns {Object} (same reference when nothing changed)
 */
export function prunePoolToComponent(pool, itemsByComponent, componentId) {
    // An item's host is the items-map group key it appears under (array
    // groups only, same guards as getLiveItemIds).
    const hostOf = new Map();
    for (const [groupKey, items] of Object.entries(itemsByComponent ?? {})) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (item && typeof item.id === 'string') hostOf.set(item.id, groupKey);
        }
    }
    if (componentId === null) {
        return _pruneEntries(pool, () => false);
    }
    return _pruneEntries(pool, (id) => hostOf.get(id) === componentId);
}

/**
 * Deterministic string key of a recipe's pooled item IDs, sorted (pure).
 * Used by the auto-craft re-arm guard (_onDrop): a previously failed
 * recipe is re-armed only when its pooled ID set changed since the last
 * POST, so a persistently failing recipe does not receive a fresh POST on
 * every unrelated drop.
 * @param {Object} recipe - A recipe: { id, ... }.
 * @param {Object} pool - The pending pool.
 * @returns {string} Sorted pooled IDs joined by '\u0000' ('' when none).
 */
export function pooledIdsKey(recipe, pool) {
    const byType = (pool || {})[recipe?.id] || {};
    const ids = [];
    for (const itemIds of Object.values(byType)) {
        if (Array.isArray(itemIds)) ids.push(...itemIds);
    }
    return [...ids].sort().join('\u0000');
}

/**
 * Escapes a value for safe interpolation into HTML (pure): the five
 * metacharacters &, <, >, ", ' are mapped to entities in a single pass.
 * The entity values are written with \u0026 escapes (repo pattern, see
 * the old chained implementation) so the source survives tooling that
 * HTML-decodes raw entities.
 * @param {*} value - The value to escape (coerced with String()).
 * @returns {string}
 */
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({'&':'\u0026amp;','<':'\u0026lt;','>':'\u0026gt;','"':'\u0026quot;',"'":'\u0026#39;'}[ch]));
}

/**
 * Computes per-input satisfaction of a recipe from the pending pool (pure).
 *
 * `have` is the RAW pool count for the input's type (it may exceed
 * `need`; display code caps it, and selectCraftItemIds picks exactly the
 * required amount so the POST always matches the recipe multiset).
 *
 * @param {Object} recipe - A recipe: { id, name, description, inputs: [{type, quantity}], outputs }.
 * @param {Object} pool - The pending pool.
 * @returns {{
 *   satisfied: boolean,
 *   entries: Array<{ type: string, have: number, need: number, isMet: boolean }>,
 *   missing: Array<{ type: string, have: number, need: number, isMet: boolean }>
 * }} `satisfied` is true only when every input entry reaches its quantity;
 *   a recipe with no (valid) inputs is never satisfied (never auto-crafts).
 */
export function computeRecipeSatisfaction(recipe, pool) {
    const inputs = Array.isArray(recipe?.inputs) ? recipe.inputs : [];
    if (inputs.length === 0) {
        return { satisfied: false, entries: [], missing: [] };
    }
    const recipePool = (pool || {})[recipe.id] || {};
    const entries = [];
    for (const input of inputs) {
        const need = Number.isInteger(input.quantity) && input.quantity > 0 ? input.quantity : 0;
        const have = (recipePool[input.type] || []).length;
        const isMet = need > 0 && have >= need;
        entries.push({ type: input.type, have, need, isMet });
    }
    const satisfied = entries.every(e => e.isMet);
    return { satisfied, entries, missing: entries.filter(e => !e.isMet) };
}

/**
 * Selects the exact item IDs to POST for a recipe (pure).
 *
 * Returns one item per recipe-input unit in a deterministic order (recipe
 * input order; within a type, drop order). When a type appears in multiple
 * input entries, quantities are summed and the combined amount is taken
 * from the pool. Returns null when the pool cannot satisfy the recipe —
 * callers must never fire a craft in that case.
 *
 * @param {Object} recipe - The recipe to craft.
 * @param {Object} pool - The pending pool.
 * @returns {string[]|null} Exact multiset of item IDs matching the recipe
 *   inputs, or null when unsatisfied.
 */
export function selectCraftItemIds(recipe, pool) {
    const inputs = Array.isArray(recipe?.inputs) ? recipe.inputs : [];
    if (inputs.length === 0) {
        return null;
    }
    const recipePool = (pool || {})[recipe.id] || {};
    const takenByType = {};
    const itemIds = [];
    for (const input of inputs) {
        const available = recipePool[input.type] || [];
        // The entry's quantity is its own demand; usedSoFar only offsets the
        // index into the shared per-type pool (matters when a type appears in
        // multiple input entries — total demand is the sum of the entries).
        const usedSoFar = takenByType[input.type] || 0;
        const need = Number.isInteger(input.quantity) && input.quantity > 0 ? input.quantity : 0;
        if (usedSoFar + need > available.length) {
            return null;
        }
        for (let i = 0; i < need; i++) {
            itemIds.push(available[usedSoFar + i]);
        }
        takenByType[input.type] = usedSoFar + need;
    }
    return itemIds;
}

/**
 * Crafting panel overlay (design spec §2.5): an available-items strip bound
 * to the resolved component, a recipe-card grid with pooled input slots,
 * and auto-craft on satisfaction (drag & drop, or keyboard).
 *
 * ARIA contract (keyboard access): item cards are buttons
 * (role=button, tabindex=0; aria-pressed reflects the picked state;
 * Enter/Space picks the item, a second press or Escape cancels); recipe
 * cards are groups (role=group, tabindex=0; Enter/Space assigns the
 * picked item to that recipe and clears the pick; aria-label reports
 * "n/m inputs"); each card's status line is aria-live=polite so craft
 * results are announced to screen readers.
 */
export class CraftingPanel {
    /**
     * @param {Object} deps
     * @param {import('./WorldStateManager.js').WorldStateManager} deps.worldStateManager
     *   Source of the active droid, its components, and the current world state.
     * @param {() => (string|null)} deps.getSelectedComponentId - SelectionController-based
     *   resolver: returns the first selected component ID (comp-uuid) or null.
     */
    constructor(deps) {
        this._worldStateManager = deps.worldStateManager;
        this._getSelectedComponentId = deps.getSelectedComponentId || (() => null);

        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {boolean} */
        this._initialized = false;

        /** @private {Array<Object>} Recipes from GET /crafting/recipes */
        this._recipes = [];
        /** @private {Object<string, Object>} Item type definitions from GET /inventory/registry */
        this._itemRegistry = {};
        /** @private {Object<string, Array<Object>>} Top-level items per component for the current entity */
        this._items = {};
        /** @private {string|null} Entity the panel is currently showing */
        this._currentEntityId = null;
        /** @private {string|null} Component the available-items strip is showing */
        this._currentComponentId = null;

        /** @private {Object} Pending pool: { [recipeId]: { [itemType]: [itemIds] } } */
        this._pool = {};
        /** @private {string|null} Item ID currently being dragged */
        this._draggingItemId = null;
        /** @private {Set<string>} Recipes with a craft POST in flight */
        this._craftingRecipeIds = new Set();
        /** @private {Set<string>} Recipes whose last auto-craft failed (re-armed on new drops) */
        this._lastCraftFailed = new Set();
        /** @private {Object<string, Array<string>>} Last POSTed pooled-ID set per recipe (re-arm guard) */
        this._lastPostedSets = {};
        /** @private {string|null} Item ID picked via keyboard (Enter/Space on an item card) */
        this._pickedItemId = null;

        // Bound handlers — stable references across re-renders.
        this._onDragStart = this._onDragStart.bind(this);
        this._onDragEnd = this._onDragEnd.bind(this);
        this._onDragOver = this._onDragOver.bind(this);
        this._onDragLeave = this._onDragLeave.bind(this);
        this._onDrop = this._onDrop.bind(this);
        this._onItemKeydown = this._onItemKeydown.bind(this);
        this._onRecipeKeydown = this._onRecipeKeydown.bind(this);
    }

    /**
     * Overlay element (OverlayManager contract — used by _updateZIndex and
     * the header-drag initializer).
     * @returns {HTMLElement|null}
     */
    get overlay() {
        return this._overlay;
    }

    /**
     * Gets DOM references and wires the close button.
     * Missing panel degrades cleanly (no-op), matching the other panels.
     */
    init() {
        this._overlay = document.getElementById('crafting-overlay');
        this._content = document.getElementById('crafting-content');

        if (!this._overlay || !this._content) {
            ClientLogger.warn('CraftingPanel', ' Overlay or content element not found.');
            return;
        }

        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        this._initialized = true;
        ClientLogger.info('CraftingPanel', ' Initialized.');
    }

    /**
     * Shows the panel and (re)loads recipes, the item registry, and the
     * active entity's items, then renders both zones.
     * @param {*} _data - Unused; the panel fetches its own data
     *   (registered without a showData fetcher, like InventoryManager).
     */
    show(_data) {
        if (!this._overlay || !this._content) return;

        const droid = this._worldStateManager.getActiveDroid();
        const entityId = droid?.id || this._worldStateManager.getMyEntityId();

        if (!entityId) {
            this._content.innerHTML = this._renderEmptyState(
                '🔨',
                'No entity available. Wait for connection.'
            );
            this._overlay.style.display = 'block';
            return;
        }

        this._currentEntityId = entityId;
        this._overlay.style.display = 'block';
        this._loadAll(entityId);
        ClientLogger.info('CraftingPanel', ` Opening crafting panel for entity ${entityId}.`);
    }

    /**
     * Hides the panel and resets transient state (the pending pool is
     * client-local and never outlives the open panel).
     */
    hide() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
        this._pool = clearPendingPool(this._pool);
        this._draggingItemId = null;
        this._currentComponentId = null;
        this._lastCraftFailed.clear();
        this._lastPostedSets = {};
        this._pickedItemId = null;
        this._clearPickedCard();
    }

    /**
     * Toggles the panel.
     */
    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Re-renders when the panel is open. Called by App.refreshWorldAndActions()
     * after each world-state-update broadcast (the authoritative inventory
     * update path after a craft).
     *
     * Skipped while a craft POST is in flight or a drag is in progress —
     * tearing down the DOM in either case would break the request or the
     * native drag session; the next broadcast refreshes normally.
     */
    async refreshIfOpen() {
        if (!this._overlay || this._overlay.style.display !== 'block') return;
        if (this._craftingRecipeIds.size > 0) return;
        if (this._draggingItemId) return;
        if (!this._currentEntityId) return;

        try {
            await this._loadEntityItems(this._currentEntityId);
            this._prunePoolToLiveItems();
            if (this._overlay.style.display !== 'block') return; // closed meanwhile
            this._render();
        } catch (error) {
            ClientLogger.warn('CraftingPanel', ' Refresh after world-state-update failed:', error.message);
        }
    }

    // ==================== Data loading ====================

    /**
     * Loads recipes, item registry, and entity items in parallel, then
     * prunes the pool and renders. The whole body is guarded: a failed
     * load or render must not strand the overlay blank — every
     * world-state-update retries via refreshIfOpen().
     * @param {string} entityId - The entity to load items for.
     * @private
     */
    async _loadAll(entityId) {
        try {
            await Promise.all([
                this._loadRecipes(),
                this._loadItemRegistry(),
                this._loadEntityItems(entityId)
            ]);
            this._prunePoolToLiveItems();
            if (this._overlay.style.display !== 'block') return; // closed meanwhile
            this._render();
        } catch (error) {
            ClientLogger.warn('CraftingPanel', `Load/render failed, will retry on next update: ${error.message}`);
        }
    }

    /**
     * Loads recipe definitions from the server.
     * @returns {Promise<void>}
     * @private
     */
    async _loadRecipes() {
        try {
            const response = await fetch('/crafting/recipes');
            if (!response.ok) {
                ClientLogger.warn('CraftingPanel', ` Failed to load recipes. HTTP ${response.status} ${response.statusText}`);
                this._recipes = [];
                return;
            }
            const data = await response.json();
            this._recipes = Array.isArray(data.recipes) ? data.recipes : [];
            ClientLogger.info('CraftingPanel', ` Loaded ${this._recipes.length} recipe(s).`);
        } catch (error) {
            ClientLogger.error('CraftingPanel', ' Error loading recipes:', error);
            this._recipes = [];
        }
    }

    /**
     * Loads the item type registry (display names/volumes) — the same
     * endpoint InventoryManager uses; item data stays single-sourced.
     * @returns {Promise<void>}
     * @private
     */
    async _loadItemRegistry() {
        try {
            const response = await fetch('/inventory/registry');
            if (!response.ok) {
                ClientLogger.warn('CraftingPanel', ` Failed to load item registry. HTTP ${response.status} ${response.statusText}`);
                this._itemRegistry = {};
                return;
            }
            const data = await response.json();
            this._itemRegistry = data.registry || {};
        } catch (error) {
            ClientLogger.error('CraftingPanel', ' Error loading item registry:', error);
            this._itemRegistry = {};
        }
    }

    /**
     * Loads top-level items for the entity, grouped by component
     * (same endpoint/shape as InventoryManager._loadEntityItems).
     * @param {string} entityId - The entity ID.
     * @returns {Promise<void>}
     * @private
     */
    async _loadEntityItems(entityId) {
        try {
            const response = await fetch(`/inventory/${entityId}`);
            if (!response.ok) {
                ClientLogger.warn('CraftingPanel', ` Failed to load items for entity ${entityId}. HTTP ${response.status} ${response.statusText}`);
                this._items = {};
                return;
            }
            const data = await response.json();
            this._items = data.items || {};
        } catch (error) {
            ClientLogger.error('CraftingPanel', ` Error loading items for entity ${entityId}:`, error);
            this._items = {};
        }
    }

    // ==================== Component resolution ====================

    /**
     * Resolves which component the available-items strip shows — thin
     * wiring over the pure resolveCraftingComponent:
     *   1. The selected component ID (SelectionController) if it belongs to
     *      the active entity — crafting follows the selection model used by
     *      every other panel;
     *   2. Else the first entity component holding an item of a type that
     *      appears in any recipe input (the useful default);
     *   3. Else the first entity component holding any item;
     *   4. Else the entity's first component (so the strip can show a
     *      meaningful empty state); null if there is none.
     *
     * ONLY entity-component IDs can be returned: items-map group keys may
     * be container item IDs (nested items) or '__unassigned__', and those
     * must never be POSTed as the crafting component.
     * @returns {string|null}
     * @private
     */
    _resolveCraftingComponent() {
        const droid = this._worldStateManager?.getActiveDroid?.();
        return resolveCraftingComponent({
            selectedId: this._getSelectedComponentId?.() ?? null,
            entityComponentIds: droid
                ? (Array.isArray(droid.components)
                    ? droid.components.map((c) => (typeof c === 'string' ? c : c?.id ?? ''))
                    : []).filter(Boolean)
                : [],
            itemsByComponent: this._items,
            recipeInputTypes: this._recipes.flatMap((r) =>
                (Array.isArray(r?.inputs) ? r.inputs.map((i) => i?.type) : [])).filter(Boolean),
        });
    }

    /**
     * Finds an item instance by ID across all components of the current
     * entity (the strip only shows the resolved component, but resolving
     * across all makes drag validation robust to refresh timing).
     * @param {string} itemId - Item instance ID.
     * @returns {Object|null}
     * @private
     */
    _findItem(itemId) {
        for (const items of Object.values(this._items)) {
            for (const item of items) {
                if (item.id === itemId) return item;
            }
        }
        return null;
    }

    /**
     * Drops pooled items that no longer exist in the live inventory: the
     * live set is getLiveItemIds(this._items) — the flattened GET /inventory
     * items map (see its JSDoc for the shape rationale).
     * @private
     */
    _prunePoolToLiveItems() {
        this._pool = prunePool(this._pool, getLiveItemIds(this._items));
    }

    // ==================== Rendering ====================

    /**
     * Renders both zones (available-items strip + recipe cards) into
     * #crafting-content and re-attaches the DnD listeners.
     * @private
     */
    _render() {
        if (!this._content) return;

        const next = this._resolveCraftingComponent();
        if (next !== this._currentComponentId) {
            this._currentComponentId = next;
            // The strip moved: staged drops hosted on other components can
            // never join a valid single-component POST — drop them.
            this._pool = prunePoolToComponent(this._pool, this._items, next);
        }
        let html = this._renderAvailableItems();
        html += this._renderRecipeCards();
        this._content.innerHTML = html;
        this._attachDragAndDropListeners();
    }

    /**
     * Renders the available-items strip for the resolved component.
     * @returns {string} HTML.
     * @private
     */
    _renderAvailableItems() {
        const componentId = this._currentComponentId;
        const items = componentId ? (this._items[componentId] || []) : [];

        const stripHeader = componentId
            ? `<span class="crafting-strip-title">Drag source:</span>
                <span class="crafting-strip-component" title="${this._escapeHtml(componentId)}">${this._escapeHtml(this._componentLabel(componentId))}</span>`
            : '<span class="crafting-strip-hint">No component found on this entity.</span>';

        let cards = '';
        for (const item of items) {
            cards += this._renderItemCard(item);
        }
        if (items.length === 0) {
            cards = '<div class="crafting-strip-hint">No items to drag. Craft recipes appear below.</div>';
        }

        return `
            <div class="crafting-strip">
                <div class="crafting-strip-header">${stripHeader}</div>
                <div class="crafting-strip-items">${cards}</div>
            </div>`;
    }

    /**
     * Renders a single draggable item card (name + footprint badge).
     * @param {Object} item - Item instance { id, type, name, volume, externalVolume }.
     * @returns {string} HTML.
     * @private
     */
    _renderItemCard(item) {
        const name = item.name || this._itemRegistry[item.type]?.name || item.type;
        // Footprint on the host component (same rule as InventoryManager).
        const displayVolume = item.externalVolume ?? item.hostVolume ?? (item.volume || 0);
        return `
            <div class="crafting-item-card" draggable="true" tabindex="0" role="button"
                 data-item-id="${this._escapeHtml(item.id)}" data-item-type="${this._escapeHtml(item.type)}"
                 aria-label="${this._escapeHtml(`${name} (${displayVolume} volume) — Enter to pick up`)}"
                 aria-pressed="false">
                <span class="crafting-item-name">${this._escapeHtml(name)}</span>
                <span class="crafting-item-volume">${displayVolume}v</span>
            </div>`;
    }

    /**
     * Renders the recipe-card grid.
     * @returns {string} HTML.
     * @private
     */
    _renderRecipeCards() {
        if (this._recipes.length === 0) {
            return `<div class="crafting-recipes">
                <div class="crafting-empty">
                    <span class="crafting-empty-icon">🔨</span>
                    <em>No crafting recipes available.</em>
                </div>
            </div>`;
        }

        let cards = '';
        for (const recipe of this._recipes) {
            cards += this._renderRecipeCard(recipe);
        }
        return `<div class="crafting-recipes">${cards}</div>`;
    }

    /**
     * Renders one recipe card (spec §2.5 DOM structure). Slot counts and
     * the card's base state modifier are derived from the current pool so
     * re-renders (e.g. after a craft) stay consistent.
     * @param {Object} recipe - A recipe definition.
     * @returns {string} HTML.
     * @private
     */
    _renderRecipeCard(recipe) {
        const { satisfied, entries } = computeRecipeSatisfaction(recipe, this._pool);
        const baseState = satisfied ? 'crafting-card--satisfied' : 'crafting-card--idle';
        const metCount = entries.filter(e => e.isMet).length;

        let slots = '';
        for (const entry of entries) {
            const name = this._typeName(entry.type);
            slots += `
                <div class="crafting-slot" data-type="${this._escapeHtml(entry.type)}">
                    <span class="crafting-slot-label">${this._escapeHtml(name)} ×${entry.need} —
                        <span class="crafting-slot-count">${Math.min(entry.have, entry.need)}/${entry.need}</span>
                    </span>
                    <div class="crafting-slot-drop"></div>
                </div>`;
        }

        let outputs = '';
        for (const output of (recipe.outputs || [])) {
            outputs += `<span class="crafting-output-chip">${this._escapeHtml(this._typeName(output.type))} ×${output.quantity}</span>`;
        }

        return `
            <div class="crafting-recipe-card ${baseState}" data-recipe-id="${this._escapeHtml(recipe.id)}"
                 tabindex="0" role="group"
                 aria-label="${this._escapeHtml(`${recipe.name} — ${metCount}/${entries.length} inputs`)}">
                <div class="crafting-card-header">
                    <h4 class="crafting-card-name">${this._escapeHtml(recipe.name)}</h4>
                    <p class="crafting-card-desc">${this._escapeHtml(recipe.description || '')}</p>
                </div>
                <div class="crafting-slots">${slots}</div>
                <div class="crafting-outputs">${outputs}</div>
                <div class="crafting-status" aria-live="polite"></div>
            </div>`;
    }

    /**
     * Re-attaches DnD listeners after an innerHTML re-render (the old
     * elements — and their listeners — are gone).
     * @private
     */
    _attachDragAndDropListeners() {
        if (!this._content) return;

        for (const card of this._content.querySelectorAll('.crafting-item-card')) {
            card.addEventListener('dragstart', (e) => this._onDragStart(e, card));
            card.addEventListener('dragend', (e) => this._onDragEnd(e, card));
            card.addEventListener('keydown', (e) => this._onItemKeydown(e, card));
        }

        for (const card of this._content.querySelectorAll('.crafting-recipe-card')) {
            card.addEventListener('dragover', (e) => this._onDragOver(e, card));
            card.addEventListener('dragleave', (e) => this._onDragLeave(e, card));
            card.addEventListener('drop', (e) => this._onDrop(e, card));
            card.addEventListener('keydown', (e) => this._onRecipeKeydown(e, card));
        }
    }

    // ==================== Drag & drop (native HTML5) ====================

    /**
     * Drag start on an item card: publishes the item's typed ID on the
     * dataTransfer under the crafting MIME type and tracks the drag.
     * @param {DragEvent} e
     * @param {HTMLElement} itemCard
     * @private
     */
    _onDragStart(e, itemCard) {
        const itemId = itemCard.dataset.itemId;
        if (!itemId) return;
        this._draggingItemId = itemId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(CRAFTING_ITEM_MIME, itemId);
        itemCard.classList.add('crafting-item-card--dragging');
    }

    /**
     * Drag end: clears drag tracking and any highlight state.
     * @param {DragEvent} e
     * @param {HTMLElement} itemCard
     * @private
     */
    _onDragEnd(e, itemCard) {
        this._draggingItemId = null;
        itemCard.classList.remove('crafting-item-card--dragging');
        this._clearCardHighlights();
    }

    /**
     * Drag over a recipe card: always preventDefault (to allow the drop),
     * then color the card — --valid when the dragged item's type matches an
     * unsatisfied input of this recipe, --invalid otherwise.
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDragOver(e, card) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const itemId = this._draggingItemId;
        if (!itemId) return;
        const item = this._findItem(itemId);
        const recipe = this._recipes.find(r => r.id === card.dataset.recipeId);
        if (!item || !recipe) return;

        const { missing } = computeRecipeSatisfaction(recipe, this._pool);
        const matchesUnsatisfied = missing.some(m => m.type === item.type);

        card.classList.toggle('crafting-card--valid', matchesUnsatisfied);
        card.classList.toggle('crafting-card--invalid', !matchesUnsatisfied);
    }

    /**
     * Drag leave a recipe card: clears the highlight (ignored when moving
     * between the card's own child elements).
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDragLeave(e, card) {
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;
        card.classList.remove('crafting-card--valid', 'crafting-card--invalid');
    }

    /**
     * Assigns an item to a recipe's pending pool — the shared body of the
     * drag-drop and keyboard paths: validates the item exists and is an
     * input type of the recipe, pools it (deduped by item ID), applies the
     * re-arm guard, and re-derives the card state, which auto-fires the
     * craft when all inputs are satisfied. Invalid and duplicate
     * assignments are no-ops.
     * @param {string} itemId - The item instance ID to assign.
     * @param {string} recipeId - The target recipe ID.
     * @private
     */
    _assignItemToRecipe(itemId, recipeId) {
        const item = this._findItem(itemId);
        const recipe = this._recipes.find(r => r.id === recipeId);
        if (!item || !recipe) return;

        const isInputType = (recipe.inputs || []).some(input => input.type === item.type);
        if (!isInputType) return;

        const nextPool = addToPendingPool(this._pool, recipe.id, item.type, itemId);
        if (nextPool === this._pool) return; // duplicate — no-op

        this._pool = nextPool;
        // Re-arm a previously failed recipe for auto-craft ONLY when its
        // pooled ID set changed since the last POST: a persistently
        // failing recipe must not receive a fresh POST on every
        // unrelated drop, and prune-induced pool changes (liveness and
        // component binding) never re-arm — only real drops do.
        if (pooledIdsKey(recipe, nextPool) !== (this._lastPostedSets[recipe.id] ?? []).join('\u0000')) {
            this._lastCraftFailed.delete(recipe.id);
        }
        this._updateCardState(recipe.id, true);
    }

    /**
     * Drop on a recipe card: validates the dropped ID and delegates to
     * _assignItemToRecipe (drag path behavior is unchanged).
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDrop(e, card) {
        e.preventDefault();
        card.classList.remove('crafting-card--valid', 'crafting-card--invalid');

        const itemId = e.dataTransfer.getData(CRAFTING_ITEM_MIME) || this._draggingItemId;
        this._draggingItemId = null;
        if (!itemId) return;

        this._assignItemToRecipe(itemId, card.dataset.recipeId);
    }

    // ==================== Keyboard access (ARIA) ====================

    /**
     * Keyboard pick-up on an item card (role=button): Enter/Space picks
     * the item (a second press cancels); Escape cancels an active pick.
     * @param {KeyboardEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onItemKeydown(e, card) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Escape') return;
        e.preventDefault();
        const itemId = card.dataset.itemId;

        if (e.key === 'Escape') {
            if (this._pickedItemId === itemId) {
                this._pickedItemId = null;
                this._setPickedState(card, false);
            }
            return;
        }
        if (this._pickedItemId === itemId) {
            // Second press on the same item cancels the pick.
            this._pickedItemId = null;
            this._setPickedState(card, false);
            return;
        }
        // Pick this item: clear any previously picked card first.
        this._clearPickedCard();
        this._pickedItemId = itemId;
        this._setPickedState(card, true);
    }

    /**
     * Keyboard assignment on a recipe card (role=group): Enter/Space
     * assigns the currently picked item to this recipe, then clears the
     * pick.
     * @param {KeyboardEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onRecipeKeydown(e, card) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!this._pickedItemId) return;
        this._assignItemToRecipe(this._pickedItemId, card.dataset.recipeId);
        this._pickedItemId = null;
        this._clearPickedCard();
    }

    /**
     * Sets or clears the picked visual state on an item card
     * (highlight class + aria-pressed).
     * @param {HTMLElement} card
     * @param {boolean} picked
     * @private
     */
    _setPickedState(card, picked) {
        card.classList.toggle('crafting-picked', picked);
        card.setAttribute('aria-pressed', picked ? 'true' : 'false');
    }

    /**
     * Clears the picked highlight from any item card currently showing it.
     * @private
     */
    _clearPickedCard() {
        if (!this._content) return;
        const picked = Array.from(this._content.querySelectorAll('.crafting-item-card'))
            .find(c => c.classList.contains('crafting-picked'));
        if (picked) this._setPickedState(picked, false);
    }

    /**
     * Clears all --valid/--invalid highlight classes on recipe cards.
     * @private
     */
    _clearCardHighlights() {
        if (!this._content) return;
        for (const card of this._content.querySelectorAll('.crafting-recipe-card')) {
            card.classList.remove('crafting-card--valid', 'crafting-card--invalid');
        }
    }

    // ==================== Card state + crafting ====================

    /**
     * Re-derives a recipe card's slot counts and base state from the pool.
     * When autoCraft is true and the recipe just became fully satisfied
     * (fresh drop), the craft fires immediately.
     *
     * @param {string} recipeId - The recipe whose card to update.
     * @param {boolean} autoCraft - Whether a satisfied card should fire the craft.
     * @private
     */
    _updateCardState(recipeId, autoCraft) {
        if (!this._content) return;
        const card = this._findRecipeCard(recipeId);
        const recipe = this._recipes.find(r => r.id === recipeId);
        if (!card || !recipe) return;

        const { satisfied, entries } = computeRecipeSatisfaction(recipe, this._pool);

        for (const entry of entries) {
            const slot = Array.from(card.querySelectorAll('.crafting-slot'))
                .find(s => s.dataset.type === entry.type);
            const count = slot?.querySelector('.crafting-slot-count');
            if (count) {
                count.textContent = `${Math.min(entry.have, entry.need)}/${entry.need}`;
            }
        }

        card.classList.remove('crafting-card--valid', 'crafting-card--invalid');
        if (satisfied) {
            card.classList.add('crafting-card--satisfied');
            card.classList.remove('crafting-card--idle');
        } else {
            card.classList.add('crafting-card--idle');
            card.classList.remove('crafting-card--satisfied');
        }

        // Keep the group's ARIA label in sync with the pool (n/m inputs).
        // setAttribute stores the raw string — no HTML escaping needed.
        const metCount = entries.filter(en => en.isMet).length;
        card.setAttribute('aria-label', `${recipe.name} — ${metCount}/${entries.length} inputs`);

        if (autoCraft && satisfied && !this._lastCraftFailed.has(recipeId)) {
            this._craft(recipeId);
        }
    }

    /**
     * Executes the craft for a satisfied recipe:
     * POST /crafting/:entityId/craft with the pooled itemIds (in drop order,
     * exactly the recipe multiset) resolved to the strip's component and its
     * parent entity.
     *
     *   200  → "Crafted ✓" flash; the crafted recipe's pool entries are
     *          removed (its items were consumed) and the authoritative
     *          re-render comes from the world-state-update broadcast.
     *   4xx/5xx → the server message is shown in .crafting-status, the pool
     *          is KEPT so the player can retry (or close the panel).
     *
     * @param {string} recipeId - The recipe to craft.
     * @private
     */
    async _craft(recipeId) {
        const recipe = this._recipes.find(r => r.id === recipeId);
        if (!recipe) return;
        if (this._craftingRecipeIds.has(recipeId)) return;

        const itemIds = selectCraftItemIds(recipe, this._pool);
        if (!itemIds) return;
        // Record the exact set being POSTed (re-arm guard in _onDrop
        // compares against this).
        this._lastPostedSets[recipeId] = [...itemIds].sort();

        const entityId = this._currentEntityId;
        const componentId = this._currentComponentId;
        if (!entityId || !componentId) {
            this._setStatus(recipeId, 'No component available for crafting.', 'error');
            this._lastCraftFailed.add(recipeId);
            return;
        }

        this._craftingRecipeIds.add(recipeId);
        this._setStatus(recipeId, 'Crafting…', 'info');

        try {
            const response = await fetch(`/crafting/${entityId}/craft`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipeId, componentId, itemIds })
            });
            const result = await response.json().catch(() => ({}));

            if (response.ok && result.success) {
                this._lastCraftFailed.delete(recipeId);
                // Only this recipe's entries are consumed; other recipes'
                // in-progress pools survive. Stale entries (items consumed
                // elsewhere) are pruned on the next broadcast refresh.
                this._pool = removeFromPendingPool(this._pool, recipeId);
                this._setStatus(recipeId, 'Crafted ✓', 'crafted');
                this._updateCardState(recipeId, false);
                ClientLogger.info('CraftingPanel', ` Crafted ${recipeId} on ${componentId}: consumed ${itemIds.length} item(s).`);
            } else {
                // 4xx/5xx: surface the server message and keep the pool for retry.
                const message = result.message || result.error || `Crafting failed (HTTP ${response.status}).`;
                this._lastCraftFailed.add(recipeId);
                this._setStatus(recipeId, message, 'error');
                ClientLogger.error('CraftingPanel', ` Craft ${recipeId} failed (HTTP ${response.status}):`, message);
            }
        } catch (error) {
            this._lastCraftFailed.add(recipeId);
            this._setStatus(recipeId, 'Network error — craft not sent.', 'error');
            ClientLogger.error('CraftingPanel', ` Craft ${recipeId} network error:`, error);
        } finally {
            this._craftingRecipeIds.delete(recipeId);
        }
    }

    /**
     * Sets a recipe card's status line (idle | crafting… | crafted ✓ | error).
     * @param {string} recipeId - The recipe whose card to update.
     * @param {string} text - Status text.
     * @param {('info'|'error'|'crafted')} kind - Visual variant.
     * @private
     */
    _setStatus(recipeId, text, kind) {
        if (!this._content) return;
        const card = this._findRecipeCard(recipeId);
        const status = card?.querySelector('.crafting-status');
        if (!status) return;

        status.classList.remove('crafting-status--info', 'crafting-status--error', 'crafting-status--crafted');
        if (kind === 'error') status.classList.add('crafting-status--error');
        else if (kind === 'crafted') status.classList.add('crafting-status--crafted');
        else if (kind === 'info') status.classList.add('crafting-status--info');
        status.textContent = text;
    }

    // ==================== Small helpers ====================

    /**
     * Renders a generic centered empty state.
     * @param {string} icon - Emoji icon.
     * @param {string} message - Text.
     * @returns {string} HTML.
     * @private
     */
    _renderEmptyState(icon, message) {
        return `
            <div class="crafting-empty">
                <span class="crafting-empty-icon">${icon}</span>
                <em>${this._escapeHtml(message)}</em>
            </div>`;
    }

    /**
     * Human label for a component: its type (title-cased) when known,
     * else the raw ID.
     * @param {string} componentId - Component ID.
     * @returns {string}
     * @private
     */
    _componentLabel(componentId) {
        const state = this._worldStateManager.getState();
        const compData = state?.components?.instances?.[componentId];
        const type = compData?.type || compData?.entityComponentType;
        return type ? this._formatTypeName(type) : componentId;
    }

    /**
     * Display name for an item type (registry first, then the raw type).
     * @param {string} type - Item type ID.
     * @returns {string}
     * @private
     */
    _typeName(type) {
        return this._itemRegistry[type]?.name || this._formatTypeName(type);
    }

    /**
     * Title-cases a type/identifier string ("t1" → "T1", "cutting_arm" → "Cutting Arm").
     * @param {string} value - The raw value.
     * @returns {string}
     * @private
     */
    _formatTypeName(value) {
        return String(value)
            .replace(/[_-]+/g, ' ')
            .split(' ')
            .filter(Boolean)
            .map(w => w[0].toUpperCase() + w.slice(1))
            .join(' ');
    }

    /**
     * Finds a recipe card by its recipe ID. Dataset comparison (never
     * selector interpolation): dataset returns browser-decoded values, so
     * escaped attributes round-trip to the exact server string the
     * comparison expects.
     * @param {string} recipeId - The recipe whose card to find.
     * @returns {HTMLElement|null}
     * @private
     */
    _findRecipeCard(recipeId) {
        if (!this._content) return null;
        return Array.from(this._content.querySelectorAll('.crafting-recipe-card'))
            .find(c => c.dataset.recipeId === recipeId) || null;
    }

    /**
     * Escapes a string for safe interpolation into HTML (delegates to the
     * pure escapeHtml export).
     * @param {string} value - The value to escape.
     * @returns {string}
     * @private
     */
    _escapeHtml(value) {
        return escapeHtml(value);
    }
}

export default CraftingPanel;

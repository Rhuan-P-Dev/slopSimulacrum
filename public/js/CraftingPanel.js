/**
 * CraftingPanel
 * Client-side crafting overlay panel (crafting design spec §2.5/§4.7,
 * docs/crafting_design_spec.md). A pure UI-panel feature: no world entity,
 * no range/spatial validation, no turn consumed.
 *
 * Two zones:
 *   1. Available-items strip — one section per entity component that holds
 *      at least one top-level item (groupItemsByComponent over the GET
 *      /inventory/:entityId map). Sections are ordered by the entity's
 *      component order, each headed by the component's readable name (never
 *      a raw comp- ID) plus an item count, and holding that component's
 *      item cards. Container-keyed (nested) groups and __unassigned__ have
 *      no section — nested items must be moved out in the inventory UI first.
 *   2. Recipe cards (CSS grid) — one card per recipe from
 *      GET /crafting/recipes; item display names/volumes resolve client-side
 *      from GET /inventory/registry (single source of truth).
 *
 * Drag & drop uses native HTML5 DnD (same API family as InventoryManager):
 *   - dragstart on an item card sets dataTransfer 'application/x-crafting-item'
 *   - dragover on a recipe card: always preventDefault; green --valid when
 *     the dragged item's type matches an UNSATISFIED input of that recipe,
 *     dimmed --invalid otherwise
 *   - drop appends the item — together with the component that hosts it —
 *     to the client-local pending pool (deduped by item ID: one physical
 *     instance is proposed to at most one recipe)
 *   - when all inputs of a card are satisfied AND every pooled input is
 *     hosted on the same component, the craft auto-executes (POST
 *     /crafting/:entityId/craft naming that shared component); a satisfied
 *     pool split across hosts shows a "same component" hint and never POSTs
 *   - dragend/dragleave clear transient highlight classes (same hygiene as
 *     InventoryManager)
 *
 * The POST 200 body is used ONLY for an immediate "Crafted ✓" flash. The
 * authoritative inventory update arrives via the world-state-update
 * broadcast → refreshWorldAndActions() → refreshIfOpen(), so this panel
 * never applies manual inventory edits from the response.
 *
 * The pure grouping/naming/pool/satisfaction/host logic is extracted as
 * named exports (groupItemsByComponent, formatTypeName,
 * resolveComponentLabel, addToPendingPool, removeFromPendingPool,
 * clearPendingPool, getPoolItemIds, getLiveItemIds, prunePool,
 * pooledIdsKey, escapeHtml, computeRecipeSatisfaction, selectCraftItemIds,
 * getCraftableHost) and unit-tested without any DOM
 * (test/unit/CraftingPanel.test.js); the class below owns the DOM wiring.
 * Standing rule: every server-fetched map is defensive — guard group values
 * with Array.isArray before iteration. Every server-sourced value is
 * interpolated only through _escapeHtml; lookups by attribute use dataset
 * comparison, never selector interpolation. No raw comp- ID is ever
 * rendered as a user-facing label (resolveComponentLabel falls back to
 * "Unknown" instead).
 *
 * Logging: ClientLogger only (BUG-123 — no console.* on the client).
 *
 * @module CraftingPanel
 */
import ClientLogger from '/utils/ClientLogger.js';

/** dataTransfer MIME for dragging a crafting item card */
const CRAFTING_ITEM_MIME = 'application/x-crafting-item';

/**
 * Groups a fresh GET /inventory/:entityId map into the per-component strip
 * sections (pure): one `{componentId, items}` per NON-EMPTY entity component,
 * ordered by the entity's component order (the `entityComponentIds`
 * argument), never by items-map insertion order.
 *
 * The items map is keyed by the item's host: entity-component IDs (comp-…),
 * container item IDs (nested items), or `__unassigned__`. Only groups whose
 * key is one of the entity's own component IDs are returned — container-
 * keyed (nested) and unhosted items stay OUT of the crafting strip: their
 * host is not a component a craft request can name, so they must be moved
 * out in the inventory UI first.
 *
 * @param {Object|null} itemsByComponent - GET /inventory/:entityId map
 *   `{ [hostId]: [item, ...] }`.
 * @param {string[]} entityComponentIds - The entity's component IDs in
 *   entity order (stable strip order).
 * @returns {Array<{componentId: string, items: Array<Object>}>} One entry per
 *   non-empty entity-component group; items are filtered to well-formed
 *   entries (object with a string `id`), in their original order.
 */
export function groupItemsByComponent(itemsByComponent, entityComponentIds) {
    const groups = [];
    if (!Array.isArray(entityComponentIds)) return groups;
    const map = itemsByComponent ?? {};
    for (const componentId of entityComponentIds) {
        if (typeof componentId !== 'string' || componentId.length === 0) continue;
        const items = map[componentId];
        if (!Array.isArray(items)) continue;
        const valid = items.filter((it) => it && typeof it.id === 'string');
        if (valid.length > 0) {
            groups.push({ componentId, items: valid });
        }
    }
    return groups;
}

/**
 * Formats an identifier as a readable, human-friendly label (pure):
 * `snake_case`, `kebab-case` and camelCase boundaries are split into words
 * and each word is title-cased — the readable-name convention shared with
 * the inventory panel, extended so camelCase component types (`droidHead`
 * → "Droid Head") and simple ids (`t1` → "T1") both read naturally.
 *
 * @param {string} value - Raw type/identifier value (may be non-string;
 *   coerced).
 * @returns {string} Formatted label.
 */
export function formatTypeName(value) {
    return String(value)
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(' ')
        .filter(Boolean)
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Resolves the readable display name for a component (pure) — the group
 * header label. The component's own reference on the droid (which may carry
 * its `type` directly) wins, then the component stats store's `type` /
 * `entityComponentType` (the inventory panel's convention). The result is
 * NEVER a raw comp- ID: when no type can be resolved, "Unknown" is
 * returned instead (a raw-ID strip label was the reported defect).
 *
 * @param {string} componentId - The component to name.
 * @param {Array|null} entityComponents - The droid's `components` array
 *   (entries may be ID strings or `{id, type}` objects).
 * @param {Object|null} componentInstances - `state.components.instances` map.
 * @returns {string} The formatted readable name, or "Unknown".
 */
export function resolveComponentLabel(componentId, entityComponents, componentInstances) {
    let type = null;
    if (Array.isArray(entityComponents)) {
        const ref = entityComponents.find((c) =>
            (typeof c === 'string' ? c : (c && c.id)) === componentId);
        if (ref && typeof ref === 'object' && typeof ref.type === 'string' && ref.type) {
            type = ref.type;
        }
    }
    if (!type) {
        const inst = componentInstances?.[componentId];
        const candidate = inst?.type || inst?.entityComponentType;
        if (typeof candidate === 'string' && candidate.length > 0
            && candidate.toLowerCase() !== 'unknown') {
            type = candidate;
        }
    }
    return type ? formatTypeName(type) : 'Unknown';
}

/**
 * Pools an item into a recipe's pending set, recording the component that
 * hosts it (pure, immutable). Returns a NEW pool object with the entry
 * appended, or the SAME reference when the add is a no-op:
 *   - any empty/invalid argument (recipeId, itemType, a string itemId, a
 *     string host) — mirrors the "empty args → no-op" rule, and
 *   - the item ID is already pooled ANYWHERE (global dedupe): one physical
 *     instance is proposed to at most one recipe, so adding it again — to
 *     the same or a different recipe/type — is a no-op.
 *
 * @param {Object} pool - The pending pool `{ [recipeId]: { [itemType]: [{id, host}] } }`.
 * @param {string} recipeId - Target recipe ID.
 * @param {string} itemType - The item's type (must be one of the recipe's input types).
 * @param {string} itemId - The item instance ID to pool.
 * @param {string} host - The component that hosts the item (the group key it
 *   was dropped from); recorded per item so the shared craft host can be
 *   resolved later (getCraftableHost).
 * @returns {Object} The new pool, or the same reference (no-op).
 */
export function addToPendingPool(pool, recipeId, itemType, itemId, host) {
    if (!recipeId || !itemType ||
        typeof itemId !== 'string' || itemId.length === 0 ||
        typeof host !== 'string' || host.length === 0) {
        return pool;
    }
    // Global dedupe: one physical instance is proposed to at most one recipe.
    if (getPoolItemIds(pool).includes(itemId)) {
        return pool;
    }
    const recipePool = pool[recipeId] || {};
    const existing = recipePool[itemType] || [];
    return {
        ...pool,
        [recipeId]: {
            ...recipePool,
            [itemType]: [...existing, { id: itemId, host }]
        }
    };
}

/**
 * Removes all pooled entries for a recipe (pure, immutable). Called after a
 * successful craft: those items were consumed by the server. Returns a NEW
 * pool, or the SAME reference when the recipe had no pooled entries
 * (no-op).
 *
 * @param {Object} pool - The pending pool.
 * @param {string} recipeId - The recipe to clear.
 * @returns {Object} The new pool, or the same reference (no-op).
 */
export function removeFromPendingPool(pool, recipeId) {
    if (!recipeId || !pool[recipeId]) {
        return pool;
    }
    const next = { ...pool };
    delete next[recipeId];
    return next;
}

/**
 * Clears the entire pending pool (pure, immutable). Used when the panel is
 * closed/hidden: pending drops are never POSTed, so discarding them is
 * correct — the server inventory is untouched and will be re-fetched on the
 * next open. Returns a fresh empty object.
 *
 * @param {Object} _pool - The pending pool (unused; kept for a stable
 *   signature).
 * @returns {Object} A new empty pool.
 */
export function clearPendingPool(_pool) {
    return {};
}

/**
 * Flattens a pending pool to its pooled item IDs (pure). Used for the
 * global-dedupe check in addToPendingPool.
 *
 * @param {Object} pool - The pending pool.
 * @returns {string[]} Pooled item IDs.
 */
export function getPoolItemIds(pool) {
    const ids = [];
    for (const byType of Object.values(pool || {})) {
        for (const entries of Object.values(byType || {})) {
            if (!Array.isArray(entries)) continue;
            for (const e of entries) {
                if (e && typeof e.id === 'string') ids.push(e.id);
            }
        }
    }
    return ids;
}

/**
 * Flattens a fresh GET /inventory/:entityId map to its live item IDs
 * (pure). Guarded: skips non-array group values (defensive against a
 * malformed shape) and non-object / id-less entries; duplicates can
 * theoretically appear if an item is listed under multiple groups, and the
 * result preserves that.
 *
 * @param {Object|null} itemsByComponent - GET /inventory/:entityId map
 *   `{ [hostId]: [item, ...] }`.
 * @returns {string[]} Live item IDs.
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
 * Shared entry-splicing mechanics for pool pruning (private, pure):
 * filters each type's entry list through keepEntryFn, drops types and
 * recipes that become empty, and returns the SAME pool reference when
 * nothing changed (callers rely on that for cheap no-op refreshes).
 * @param {Object} pool - The pending pool.
 * @param {(entry: {id: string, host: string}) => boolean} keepEntryFn - Whether an entry survives.
 * @returns {Object} A new pruned pool, or the same reference when unchanged.
 */
function _pruneEntries(pool, keepEntryFn) {
    const pruned = {};
    let changed = false;
    for (const [recipeId, byType] of Object.entries(pool || {})) {
        const recipeEntry = {};
        for (const [type, entries] of Object.entries(byType || {})) {
            if (!Array.isArray(entries)) {
                changed = true;
                continue;
            }
            const kept = entries.filter(keepEntryFn);
            if (kept.length !== entries.length) changed = true;
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
 * Drops pool entries that are stale against the fresh GET /inventory map
 * (pure). An entry survives only when its item is still present AND still
 * hosted on the component recorded at drop time — the fresh map carries
 * both facts (its group key is the item's current host). Called on every
 * broadcast refresh so the pool never references a consumed/removed
 * instance, and never claims a host the item has since moved away from
 * (another client or an NPC may have moved the same component's inventory).
 *
 * @param {Object} pool - The pending pool.
 * @param {Object|null} itemsByComponent - Fresh GET /inventory/:entityId map.
 * @returns {Object} A new pool with stale entries removed, or the same
 *   reference when nothing changed.
 */
export function prunePool(pool, itemsByComponent) {
    const live = new Set(getLiveItemIds(itemsByComponent));
    const hostOf = new Map();
    for (const [groupKey, items] of Object.entries(itemsByComponent ?? {})) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (item && typeof item.id === 'string') hostOf.set(item.id, groupKey);
        }
    }
    return _pruneEntries(pool, (e) => live.has(e.id) && hostOf.get(e.id) === e.host);
}

/**
 * Order-insensitive fingerprint of a recipe's pooled item IDs (pure) — the
 * re-arm guard key: it tells _assignItemToRecipe whether a drop CHANGED the
 * set that a previously-failing (400) POST used, versus an unrelated
 * prune-induced change that must not re-arm the same request.
 * @param {Object} recipe - The recipe.
 * @param {Object} pool - The pending pool.
 * @returns {string} Sorted, NUL-joined item IDs; `''` when nothing is pooled.
 */
export function pooledIdsKey(recipe, pool) {
    const byType = (pool || {})[recipe?.id] || {};
    const ids = [];
    for (const entries of Object.values(byType)) {
        if (Array.isArray(entries)) {
            for (const e of entries) {
                if (e && typeof e.id === 'string') ids.push(e.id);
            }
        }
    }
    return [...ids].sort().join('\u0000');
}

/**
 * HTML-escapes a value for safe interpolation into markup (pure): the five
 * HTML-significant characters. Every server-sourced value that is
 * interpolated into HTML must pass through this (project standard).
 * @param {string|number} value - The value to escape.
 * @returns {string} The escaped string.
 */
export function escapeHtml(value) {
    // Replacements are built by concatenation so the source text never
    // contains a raw entity (tooling that HTML-decodes file content would
    // otherwise corrupt the replacement strings).
    return String(value)
        .replace(/&/g, '&' + 'amp;')
        .replace(/</g, '&' + 'lt;')
        .replace(/>/g, '&' + 'gt;')
        .replace(/"/g, '&' + 'quot;')
        .replace(/'/g, '&' + '#39;')
        .replace(/`/g, '&' + '#96;')
        .replace(/=/g, '&' + '#61;');
}

/**
 * Pure per-recipe satisfaction check against a pending pool.
 *
 * A recipe has `inputs: [{ type, quantity }]` (server-validated to be
 * unique per type). An input is met when the pool holds at least `quantity`
 * entries of that type (the display code caps the counter at the required
 * amount, and selectCraftItemIds picks exactly the required amount).
 *
 * Pinned semantics: a recipe with no inputs (server validation would
 * reject one; defensive here) is NEVER satisfied; an input with
 * `quantity <= 0` is NEVER met (a quantity of 0/undefined is treated as
 * "not required" only at validation time — the satisfaction model requires
 * a positive quantity, mirroring the server's "quantity must be positive"
 * rule, so a recipe can never be satisfied by zero items).
 *
 * @param {Object} recipe - The recipe with `inputs: [{ type, quantity }]`.
 * @param {Object} pool - The pending pool `{ [recipeId]: { [itemType]: [{id, host}] } }`.
 * @returns {{satisfied: boolean, entries: Array<{type: string, have: number, need: number, isMet: boolean}>, missing: Array<{type: string, have: number, need: number, isMet: boolean}>}}
 */
export function computeRecipeSatisfaction(recipe, pool) {
    const inputs = Array.isArray(recipe?.inputs) ? recipe.inputs : [];
    if (inputs.length === 0) {
        return { satisfied: false, entries: [], missing: [] };
    }
    const recipePool = (pool || {})[recipe.id] || {};
    const entries = [];
    for (const input of inputs) {
        const need = Number.isInteger(input.quantity) && input.quantity > 0
            ? input.quantity : 0;
        const have = (recipePool[input.type] || []).length;
        const isMet = need > 0 && have >= need;
        entries.push({ type: input.type, have, need, isMet });
    }
    const satisfied = entries.every((e) => e.isMet);
    return { satisfied, entries, missing: entries.filter((e) => !e.isMet) };
}

/**
 * Selects the exact item IDs to POST for a recipe, in drop order (pure).
 * Returns an array of item IDs that satisfies the recipe's EXACT multiset
 * (one entry per required unit of each input type), or null when the pool
 * cannot satisfy it — mirroring the server's exact-multiset rule
 * (over/under-supply is rejected, so we never send extra).
 *
 * The chosen set is the first `quantity` entries of each type in drop
 * order — the same set the UI would show as satisfied — which keeps the
 * POST deterministic for a given pool state.
 *
 * Pinned semantics: a recipe with no inputs (server validation would
 * reject one; defensive here) returns null (never a valid craft).
 *
 * @param {Object} recipe - The recipe with `inputs: [{ type, quantity }]`.
 * @param {Object} pool - The pending pool `{ [recipeId]: { [itemType]: [{id, host}] } }`.
 * @returns {string[]|null} Exact item IDs in drop order, or null when unsatisfied.
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
        const entries = recipePool[input.type] || [];
        // The entry's quantity is its own demand; usedSoFar only offsets the
        // index into the shared per-type pool (matters when a type appears in
        // multiple input entries — total demand is the sum of the entries).
        const usedSoFar = takenByType[input.type] || 0;
        const need = Number.isInteger(input.quantity) && input.quantity > 0
            ? input.quantity : 0;
        if (usedSoFar + need > entries.length) {
            return null;
        }
        for (let i = 0; i < need; i++) {
            const entry = entries[usedSoFar + i];
            itemIds.push(entry && entry.id);
        }
        takenByType[input.type] = usedSoFar + need;
    }
    return itemIds;
}

/**
 * Resolves the single component a satisfied recipe's craft can be POSTed to
 * (pure) — the shared-host auto-craft rule.
 *
 * Returns the one host when the pool can satisfy the recipe (exact
 * multiset, per selectCraftItemIds) AND every pooled entry of that recipe
 * is hosted on the same component; otherwise null. The POST contract names
 * exactly one component (the server rejects cross-host inputs), so a pool
 * split across hosts must never fire — the panel shows a "same component"
 * hint and keeps the pool instead.
 *
 * @param {Object} recipe - The recipe to craft.
 * @param {Object} pool - The pending pool.
 * @returns {string|null} The shared host component ID, or null when the
 *   recipe is unsatisfied, its inputs are split across hosts, or a pooled
 *   entry carries no usable host.
 */
export function getCraftableHost(recipe, pool) {
    if (!selectCraftItemIds(recipe, pool)) {
        return null; // unsatisfied (or malformed) — never a candidate
    }
    const recipePool = (pool || {})[recipe.id] || {};
    let host = null;
    for (const entries of Object.values(recipePool)) {
        if (!Array.isArray(entries)) return null;
        for (const e of entries) {
            const h = e && typeof e.host === 'string' ? e.host : '';
            if (h.length === 0) return null; // hostless entry can never be POSTed
            if (host === null) {
                host = h;
            } else if (host !== h) {
                return null; // inputs split across components
            }
        }
    }
    return host;
}

export class CraftingPanel {
    /**
     * @param {Object} deps
     * @param {import('./WorldStateManager.js').WorldStateManager} deps.worldStateManager
     *   Source of the active droid, its components (strip order + names),
     *   and the current world state.
     */
    constructor(deps) {
        this._worldStateManager = deps.worldStateManager;

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
        /** @private {Object<string, Array<Object>>} Items per group key for the current entity (fresh GET /inventory map) */
        this._items = {};
        /** @private {string|null} Entity the panel is currently showing */
        this._currentEntityId = null;
        /** @private {Array<{componentId: string, items: Array<Object>}>} Non-empty entity-component strip groups */
        this._groups = [];

        /** @private {Object} Pending pool: { [recipeId]: { [itemType]: [{id, host}] } } */
        this._pool = {};
        /** @private {Set<string>} Recipe IDs with an in-flight POST */
        this._craftingRecipeIds = new Set();
        /** @private {Map<string, string[]>} Last POSTed sorted ID set per recipe (re-arm guard) */
        this._lastPostedSets = new Map();
        /** @private {Set<string>} Recipes that received a 400/500 (re-arm guard) */
        this._lastCraftFailed = new Set();
        /** @private {string|null} Item card currently being dragged */
        this._draggingItemId = null;
        /** @private {HTMLElement|null} Item card currently "picked" via keyboard */
        this._pickedCard = null;
    }

    /**
     * Binds the panel to its overlay markup (idempotent).
     * @public
     */
    init() {
        if (this._initialized) return;
        this._overlay = document.getElementById('crafting-overlay');
        this._content = document.getElementById('crafting-content');
        if (!this._overlay || !this._content) {
            ClientLogger.error('CraftingPanel', ' Overlay or content element not found. Cannot init.');
            return;
        }

        const closeBtn = this._overlay.querySelector('.crafting-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.hide());

        this._initialized = true;
        this._overlay.style.display = 'none';
    }

    /**
     * Shows the overlay and (re)loads everything for the active droid.
     * (Registered without a showData fetcher, like InventoryManager.)
     * @public
     */
    show() {
        if (!this._initialized) {
            this.init();
        }
        if (!this._overlay) return;

        // Track which entity this panel instance is showing, so broadcast
        // refreshes only re-render for the same entity (never stale for a
        // different one).
        this._currentEntityId = this._worldStateManager?.getMyEntityId() ?? null;

        if (this._overlay.style.display === 'block') return;

        this._overlay.style.display = 'block';

        this._loadAll();
    }

    /**
     * Hides the overlay and discards the (never-POSTed) pending pool.
     * @public
     */
    hide() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
        // Pending drops were never POSTed; discarding is correct (the
        // server inventory is untouched and will be re-fetched next open).
        this._pool = clearPendingPool(this._pool);
        this._craftingRecipeIds.clear();
        this._lastPostedSets.clear();
        this._lastCraftFailed.clear();
        this._draggingItemId = null;
        this._clearPickedCard();
    }

    /**
     * Toggles the overlay.
     * @public
     */
    toggle() {
        if (this._overlay?.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Re-loads and re-renders when the panel is currently open. Wired into
     * App.refreshWorldAndActions() so every world-state-update broadcast
     * keeps the panel's inventory/cards in sync with the server
     * (authoritative inventory sync; the craft POST response is NOT used).
     * @public
     */
    refreshIfOpen() {
        if (this._initialized && this._overlay?.style.display === 'block') {
            this._currentEntityId = this._worldStateManager?.getMyEntityId() ?? null;
            if (this._currentEntityId) {
                this._loadAll();
            }
        }
    }

    /** @public {HTMLElement} The overlay element (OverlayManager contract). */
    get overlay() {
        return this._overlay;
    }

    // ==================== Data loading ====================

    /**
     * Loads recipes + registry + entity items in parallel, then prunes the
     * pool and renders both zones.
     * @private
     */
    async _loadAll() {
        if (!this._currentEntityId) return;
        const [recipes, registry] = await Promise.all([
            this._loadRecipes(),
            this._loadItemRegistry()
        ]);
        const items = await this._loadEntityItems(this._currentEntityId);

        // Only proceed if the panel is still open for the same entity —
        // a rapid hide/open or entity switch would otherwise render stale
        // data (async race).
        if (!this._initialized || this._overlay?.style.display !== 'block') return;
        if (this._currentEntityId !== this._worldStateManager?.getMyEntityId()) return;

        this._recipes = recipes;
        this._itemRegistry = registry || {};
        this._items = items || {};

        // Reconcile the pool against the fresh inventory before rendering:
        // drop entries whose item vanished OR moved (see prunePool).
        this._prunePoolToLiveItems();

        this._render();
    }

    /**
     * GET /crafting/recipes. Returns the recipes array (or [] on failure).
     * @private
     */
    async _loadRecipes() {
        try {
            const response = await fetch('/crafting/recipes');
            if (!response.ok) {
                throw new Error(`Failed to fetch recipes (HTTP ${response.status})`);
            }
            const data = await response.json();
            // Guarded: the server returns a plain array, but stay defensive
            // about the shape (no array methods on a malformed body).
            return Array.isArray(data) ? data : [];
        } catch (error) {
            ClientLogger.error('CraftingPanel', ' Failed to load crafting recipes:', error);
            return [];
        }
    }

    /**
     * GET /inventory/registry. Returns the item definitions map (or {} on
     * failure). Display names/volumes are client-side only (design spec
     * decision: not stored per item, not in the crafting schema).
     * @private
     */
    async _loadItemRegistry() {
        try {
            const response = await fetch('/inventory/registry');
            if (!response.ok) {
                throw new Error(`Failed to fetch item registry (HTTP ${response.status})`);
            }
            const data = await response.json();
            return (data && typeof data === 'object') ? data : {};
        } catch (error) {
            ClientLogger.error('CraftingPanel', ' Failed to load item registry:', error);
            return {};
        }
    }

    /**
     * GET /inventory/:entityId. Returns the items-by-component map
     * ({ [componentId]: [item, ...] }) or {} on failure.
     * @param {string} entityId - The entity whose inventory to load.
     * @returns {Promise<Object>}
     * @private
     */
    async _loadEntityItems(entityId) {
        try {
            const response = await fetch(`/inventory/${entityId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch inventory (HTTP ${response.status})`);
            }
            const data = await response.json();
            return (data && typeof data === 'object') ? data : {};
        } catch (error) {
            ClientLogger.error('CraftingPanel', ` Failed to load inventory for ${entityId}:`, error);
            return {};
        }
    }

    // ==================== Component resolution ====================

    /**
     * The active droid's component IDs in entity order — the stable strip
     * order. The entity's components may be ID strings or {id, type}
     * objects depending on the broadcast shape; only typed comp- IDs
     * survive.
     * @returns {string[]}
     * @private
     */
    _entityComponentIds() {
        const droid = this._worldStateManager?.getActiveDroid?.();
        if (!droid || !Array.isArray(droid.components)) return [];
        return droid.components
            .map((c) => (typeof c === 'string' ? c : (c && typeof c.id === 'string' ? c.id : '')))
            .filter(Boolean);
    }

    /**
     * Finds an item instance by ID across all groups of the current entity,
     * reporting the group key (the item's current host) it was found under.
     * The strip only shows entity-component groups, but resolving across
     * all groups makes drag validation robust to refresh timing.
     * @param {string} itemId - Item instance ID.
     * @returns {{item: Object, host: string}|null} The item and its host, or null.
     * @private
     */
    _findItem(itemId) {
        for (const [groupKey, items] of Object.entries(this._items ?? {})) {
            if (!Array.isArray(items)) continue;
            for (const item of items) {
                if (item && item.id === itemId) {
                    return { item, host: groupKey };
                }
            }
        }
        return null;
    }

    /**
     * Reconciles the pool against the fresh inventory map: entries whose
     * item vanished or whose host changed are dropped (see prunePool).
     * @private
     */
    _prunePoolToLiveItems() {
        this._pool = prunePool(this._pool, this._items);
    }

    // ==================== Rendering ====================

    /**
     * Renders both zones (per-component item groups + recipe cards) into
     * #crafting-content and re-attaches the DnD listeners.
     * @private
     */
    _render() {
        if (!this._content) return;
        this._groups = groupItemsByComponent(this._items, this._entityComponentIds());
        let html = this._renderComponentGroups();
        html += this._renderRecipeCards();
        this._content.innerHTML = html;
        this._attachDragAndDropListeners();
    }

    /**
     * Renders the available-items strip: one bordered section per
     * non-empty entity component — a header with the component's readable
     * name (+ a small item count) and that component's item cards. Nested
     * (container-hosted) and unhosted items have no section by
     * construction of groupItemsByComponent. All groups empty → the
     * existing empty-state hint.
     * @returns {string} HTML.
     * @private
     */
    _renderComponentGroups() {
        if (this._groups.length === 0) {
            return `
                <div class="crafting-groups">
                    <div class="crafting-strip-hint">No items to drag. Craft recipes appear below.</div>
                </div>`;
        }

        let sections = '';
        for (const { componentId, items } of this._groups) {
            const name = this._componentLabel(componentId);
            let cards = '';
            for (const item of items) {
                cards += this._renderItemCard(item);
            }
            sections += `
                <div class="crafting-group" data-comp-id="${this._escapeHtml(componentId)}"
                     role="group" aria-label="${this._escapeHtml(`Items on ${name}`)}">
                    <div class="crafting-group-header">
                        <span class="crafting-group-name">${this._escapeHtml(name)}</span>
                        <span class="crafting-group-count">${items.length} item${items.length === 1 ? '' : 's'}</span>
                    </div>
                    <div class="crafting-group-items">${cards}</div>
                </div>`;
        }
        return `<div class="crafting-groups">${sections}</div>`;
    }

    /**
     * Renders a single draggable item card (name + volume badge). Reuses
     * the inventory item-card look via the crafting- class family.
     * @param {Object} item - The item instance.
     * @returns {string} HTML.
     * @private
     */
    _renderItemCard(item) {
        const name = this._escapeHtml(item.name || this._itemRegistry[item.type]?.name || item.type);
        const volume = item.externalVolume ?? item.hostVolume ?? item.volume ?? 0;
        const isPicked = this._pickedCard && this._pickedCard.dataset.itemId === item.id;
        const base = this._pickedCard ? 'crafting-item-card crafting-item-card--picked' : 'crafting-item-card';
        return `
            <div class="${base}" data-item-id="${this._escapeHtml(item.id)}" data-item-type="${this._escapeHtml(item.type)}"
                 aria-label="${this._escapeHtml(`Item ${name}. Press Enter to pick, then choose a recipe.`)}"
                 aria-pressed="${isPicked ? 'true' : 'false'}"
                 tabindex="0" role="button"
                 draggable="true">
                <div class="crafting-item-name">${name}</div>
                <div class="crafting-item-volume">Vol: ${volume}</div>
            </div>`;
    }

    /**
     * Renders all recipe cards. Each card shows its inputs as drop slots
     * (with live pool counts) and its outputs as badges.
     * @returns {string} HTML.
     * @private
     */
    _renderRecipeCards() {
        if (this._recipes.length === 0) {
            return `
                <div class="crafting-empty">
                    <span class="crafting-empty-icon">🔨</span>
                    <em>No crafting recipes available.</em>
                </div>`;
        }
        let html = '<div class="crafting-recipes">';
        for (const recipe of this._recipes) {
            html += this._renderRecipeCard(recipe);
        }
        return html + '</div>';
    }

    /**
     * Renders a single recipe card with its input slots and outputs.
     * @param {Object} recipe - The recipe object.
     * @returns {string} HTML.
     * @private
     */
    _renderRecipeCard(recipe) {
        const { satisfied, entries } = computeRecipeSatisfaction(recipe, this._pool);
        const host = getCraftableHost(recipe, this._pool);
        const splitHost = satisfied && !host;
        // Satisfied but split across hosts: the craft is blocked and the
        // hint line explains why (a cross-host POST would only 400).
        const baseState = splitHost
            ? 'crafting-card--split-host'
            : (satisfied ? 'crafting-card--satisfied' : 'crafting-card--idle');
        const metCount = entries.filter((e) => e.isMet).length;

        let slots = '';
        for (const entry of entries) {
            const have = Math.min(entry.have, entry.need);
            const dropClass = entry.isMet ? '' : ' crafting-slot--drop';
            slots += `
                <div class="crafting-slot${dropClass}" data-type="${this._escapeHtml(entry.type)}">
                    <div class="crafting-slot-label">${this._escapeHtml(this._typeName(entry.type))}</div>
                    <div class="crafting-slot-count">${have}/${entry.need}</div>
                    <div class="crafting-slot-hint">Drop here</div>
                </div>`;
        }

        let outputs = '';
        for (const output of (recipe.outputs || [])) {
            outputs += `<span class="crafting-output-chip">${this._escapeHtml(this._typeName(output.type))} × ${output.quantity}</span>`;
        }

        const hint = splitHost ? 'Inputs must be on the same component.' : '';
        return `
            <div class="crafting-recipe-card ${baseState}" data-recipe-id="${this._escapeHtml(recipe.id)}"
                 tabindex="0" role="group"
                 aria-label="${this._escapeHtml(`${recipe.name} — ${metCount}/${entries.length} inputs${splitHost ? ' — inputs must be on the same component' : ''}`)}">
                <div class="crafting-card-header">
                    <h4 class="crafting-card-name">${this._escapeHtml(recipe.name)}</h4>
                    <p class="crafting-card-desc">${this._escapeHtml(recipe.description || '')}</p>
                </div>
                <div class="crafting-slots">${slots}</div>
                <div class="crafting-outputs">${outputs}</div>
                <div class="crafting-host-hint" role="status"${hint ? '' : ' hidden'}>${this._escapeHtml(hint)}</div>
                <div class="crafting-status" aria-live="polite"></div>
            </div>`;
    }

    // ==================== Drag & Drop ====================

    /**
     * Attaches drag/drop listeners to the rendered cards/slots.
     * @private
     */
    _attachDragAndDropListeners() {
        // Item cards: dragstart
        const itemCards = this._content.querySelectorAll('.crafting-item-card');
        itemCards.forEach((card) => {
            card.addEventListener('dragstart', (e) => this._onDragStart(e, card));
            card.addEventListener('dragend', (e) => this._onDragEnd(e, card));
            // Keyboard: pick / confirm (see _onItemCardKeydown)
            card.addEventListener('keydown', (e) => this._onItemCardKeydown(e, card));
        });

        // Recipe cards: drop targets
        const recipeCards = this._content.querySelectorAll('.crafting-recipe-card');
        recipeCards.forEach((card) => {
            card.addEventListener('dragover', (e) => this._onDragOver(e, card));
            card.addEventListener('dragleave', (e) => this._onDragLeave(e, card));
            card.addEventListener('drop', (e) => this._onDrop(e, card));
            // Keyboard: assign the picked item to this recipe (Enter/Space)
            card.addEventListener('keydown', (e) => this._onRecipeCardKeydown(e, card));
        });
    }

    /**
     * dragstart on an item card: set the item ID on dataTransfer and mark
     * the card as dragging.
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDragStart(e, card) {
        const itemId = card.dataset.itemId;
        if (!itemId) {
            e.preventDefault();
            return;
        }
        // dataTransfer is read-only during dragover; the ID is also kept on
        // the instance so _onDragOver can validate against the current
        // inventory (a stale/dragged-from-elsewhere ID is rejected).
        this._draggingItemId = itemId;
        e.dataTransfer.setData(CRAFTING_ITEM_MIME, itemId);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('crafting-item-card--dragging');
    }

    /**
     * dragend: clear the dragging flag and the transient card highlights.
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDragEnd(e, card) {
        card.classList.remove('crafting-item-card--dragging');
        this._draggingItemId = null;
        this._clearCardHighlights();
    }

    /**
     * dragover on a recipe card: always preventDefault (required to allow a
     * drop), then green-highlight when the dragged item type is one of the
     * card's UNSATISFIED inputs (a useful drop), dimmed otherwise.
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDragOver(e, card) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const itemId = this._draggingItemId;
        if (!itemId) return;
        // Validate against the CURRENT inventory (not just the ID being
        // dragged): a stale item that no longer exists is rejected.
        const item = this._findItem(itemId)?.item;
        const recipe = this._recipes.find((r) => r.id === card.dataset.recipeId);
        if (!item || !recipe) return;

        const { missing } = computeRecipeSatisfaction(recipe, this._pool);
        const matchesUnsatisfied = missing.some((m) => m.type === item.type);

        card.classList.toggle('crafting-card--valid', matchesUnsatisfied);
        card.classList.toggle('crafting-card--invalid', !matchesUnsatisfied);
    }

    /**
     * dragleave: remove transient highlights.
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDragLeave(e, card) {
        card.classList.remove('crafting-card--valid', 'crafting-card--invalid');
    }

    /**
     * drop on a recipe card: pool the dragged item (with its host) into the
     * recipe and re-derive card state (auto-craft if now satisfied).
     * @param {DragEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onDrop(e, card) {
        e.preventDefault();
        card.classList.remove('crafting-card--valid', 'crafting-card--invalid');
        this._draggingItemId = null;

        const itemId = e.dataTransfer.getData(CRAFTING_ITEM_MIME);
        if (!itemId) return;
        const recipeId = card.dataset.recipeId;
        if (!recipeId) return;

        this._assignItemToRecipe(itemId, recipeId);
    }

    // ==================== Keyboard access (ARIA) ====================

    /**
     * Item card keydown: Enter/Space "picks" the card (toggle). A picked
     * card is highlighted and announces itself; pressing again unpicks it.
     * @param {KeyboardEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onItemCardKeydown(e, card) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); // stop Space from scrolling the overlay
        this._setPickedCard(card, this._pickedCard !== card);
    }

    /**
     * Recipe card keydown: Enter/Space assigns the currently picked item to
     * this recipe (the keyboard equivalent of dropping), then unpicks the
     * source card. With no item picked this is a no-op (no error spam).
     * @param {KeyboardEvent} e
     * @param {HTMLElement} card
     * @private
     */
    _onRecipeCardKeydown(e, card) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!this._pickedCard) return;
        const itemId = this._pickedCard.dataset.itemId;
        const recipeId = card.dataset.recipeId;
        if (!itemId || !recipeId) return;
        this._assignItemToRecipe(itemId, recipeId);
        this._clearPickedCard();
    }

    /**
     * Sets or clears the keyboard "picked" item card (visual + aria-pressed).
     * @param {HTMLElement|null} card - The card to pick, or null to clear.
     * @param {boolean} picked - Whether the card is picked (true) or cleared (false).
     * @private
     */
    _setPickedCard(card, picked) {
        if (picked && card) {
            this._pickedCard = card;
            card.classList.add('crafting-item-card--picked');
            card.setAttribute('aria-pressed', 'true');
        } else {
            this._clearPickedCard();
        }
    }

    /**
     * Clears the keyboard "picked" state from whatever card is currently
     * picked (visual + aria-pressed).
     * @private
     */
    _clearPickedCard() {
        if (!this._pickedCard) return;
        this._pickedCard.classList.remove('crafting-item-card--picked');
        this._pickedCard.setAttribute('aria-pressed', 'false');
        this._pickedCard = null;
    }

    /**
     * Removes all transient recipe-card highlight classes (valid/invalid).
     * @private
     */
    _clearCardHighlights() {
        const cards = this._content?.querySelectorAll('.crafting-recipe-card');
        if (cards) {
            cards.forEach((c) => c.classList.remove('crafting-card--valid', 'crafting-card--invalid'));
        }
    }

    // ==================== Assignment / auto-craft ====================

    /**
     * Assigns an item to a recipe's pending pool — the shared body of the
     * drag-drop and keyboard paths: validates the item exists and is an
     * input type of the recipe, pools it together with the component that
     * hosts it (deduped by item ID), applies the re-arm guard, and
     * re-derives the card state, which auto-fires the craft when all
     * inputs are satisfied AND share one host. Invalid and duplicate
     * assignments are no-ops.
     * @param {string} itemId - The item instance ID to assign.
     * @param {string} recipeId - The target recipe ID.
     * @private
     */
    _assignItemToRecipe(itemId, recipeId) {
        const found = this._findItem(itemId);
        const item = found?.item;
        const recipe = this._recipes.find((r) => r.id === recipeId);
        if (!item || !recipe) return;

        const isInputType = (recipe.inputs || []).some((input) => input.type === item.type);
        if (!isInputType) return;

        const nextPool = addToPendingPool(this._pool, recipe.id, item.type, itemId, found.host);
        if (nextPool === this._pool) return; // duplicate — no-op

        this._pool = nextPool;
        // Re-arm a previously failed recipe for auto-craft ONLY when its
        // pooled ID set changed since the last POST: a persistently
        // failing recipe must not receive a fresh POST on every
        // unrelated drop, and prune-induced pool changes (liveness and
        // host changes) never re-arm — only real drops do.
        if (pooledIdsKey(recipe, nextPool) !== (this._lastPostedSets[recipe.id] ?? []).join('\u0000')) {
            this._lastCraftFailed.delete(recipe.id);
        }
        this._updateCardState(recipe.id, true);
    }

    /**
     * Re-derives a recipe card's slot counts, base state, and the
     * split-host hint from the pool. When autoCraft is true and the recipe
     * just became craftable — satisfied AND every pooled input hosted on
     * one shared host (a satisfied-but-split pool never fires) — the craft
     * fires immediately.
     *
     * @param {string} recipeId - The recipe whose card to update.
     * @param {boolean} autoCraft - Whether a craftable card should fire the craft.
     * @private
     */
    _updateCardState(recipeId, autoCraft) {
        if (!this._content) return;
        const card = this._findRecipeCard(recipeId);
        const recipe = this._recipes.find((r) => r.id === recipeId);
        if (!card || !recipe) return;

        const { satisfied, entries } = computeRecipeSatisfaction(recipe, this._pool);
        const host = getCraftableHost(recipe, this._pool);
        const splitHost = satisfied && !host;

        for (const entry of entries) {
            const slot = Array.from(card.querySelectorAll('.crafting-slot'))
                .find((s) => s.dataset.type === entry.type);
            const count = slot?.querySelector('.crafting-slot-count');
            if (count) {
                count.textContent = `${Math.min(entry.have, entry.need)}/${entry.need}`;
            }
        }

        card.classList.remove('crafting-card--valid', 'crafting-card--invalid', 'crafting-card--satisfied', 'crafting-card--split-host');
        card.classList.add(splitHost ? 'crafting-card--split-host'
            : (satisfied ? 'crafting-card--satisfied' : 'crafting-card--idle'));

        // The split-host hint lives on its own line (separate from the
        // transient .crafting-status) so a "Crafted ✓" flash or an error
        // message is never clobbered by state re-derivation.
        const hint = card.querySelector('.crafting-host-hint');
        if (hint) {
            if (splitHost) {
                hint.textContent = 'Inputs must be on the same component.';
                hint.removeAttribute('hidden');
            } else {
                hint.textContent = '';
                hint.setAttribute('hidden', '');
            }
        }

        // Keep the group's ARIA label in sync with the pool (n/m inputs);
        // the split-host condition is part of the accessible name.
        // setAttribute stores the raw string — no HTML escaping needed.
        const metCount = entries.filter((en) => en.isMet).length;
        card.setAttribute('aria-label',
            `${recipe.name} — ${metCount}/${entries.length} inputs` +
            (splitHost ? ' — inputs must be on the same component' : ''));

        if (autoCraft && host && !this._lastCraftFailed.has(recipeId)) {
            this._craft(recipeId);
        }
    }

    /**
     * Executes the craft for a satisfied recipe:
     * POST /crafting/:entityId/craft with the pooled itemIds (in drop order,
     * exactly the recipe multiset) named to the single component that hosts
     * ALL of them (the POST contract names one component; the server
     * rejects cross-host inputs).
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
        const recipe = this._recipes.find((r) => r.id === recipeId);
        if (!recipe) return;
        if (this._craftingRecipeIds.has(recipeId)) return;

        const itemIds = selectCraftItemIds(recipe, this._pool);
        if (!itemIds) return; // unsatisfied — must never fire
        // The shared host is the POST's componentId: present only when every
        // pooled input of the recipe lives on one component. A satisfied
        // pool split across hosts never POSTs (a cross-host request is a
        // guaranteed 400, and a failed craft must never lose items).
        const componentId = getCraftableHost(recipe, this._pool);
        if (!componentId) return;

        const entityId = this._currentEntityId;
        if (!entityId) {
            this._setStatus(recipeId, 'No entity available for crafting.', 'error');
            this._lastCraftFailed.add(recipeId);
            return;
        }

        // Record the exact set being POSTed (re-arm guard in
        // _assignItemToRecipe compares against this).
        this._lastPostedSets[recipeId] = [...itemIds].sort();

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
                // or moved elsewhere) are pruned on the next broadcast
                // refresh.
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

    // ==================== Status / helpers ====================

    /**
     * Shows a transient status message on a recipe card.
     * @param {string} recipeId
     * @param {string} message
     * @param {'info'|'error'|'crafted'} kind
     * @private
     */
    _setStatus(recipeId, message, kind) {
        const card = this._findRecipeCard(recipeId);
        if (!card) return;
        const status = card.querySelector('.crafting-status');
        if (!status) return;
        status.textContent = message;
        status.className = `crafting-status crafting-status--${kind}`;
    }

    /**
     * Renders the empty state (no entity / no items).
     * @returns {string} HTML.
     * @private
     */
    _renderEmptyState() {
        return `
            <div class="crafting-empty">
                <span class="crafting-empty-icon">🔨</span>
                <em>No items to drag. Craft recipes appear below.</em>
            </div>`;
    }

    /**
     * Finds a recipe card element by recipe ID.
     * @param {string} recipeId
     * @returns {HTMLElement|null}
     * @private
     */
    _findRecipeCard(recipeId) {
        if (!this._content) return null;
        return this._content.querySelector(`.crafting-recipe-card[data-recipe-id]`);
    }

    /**
     * Human label for a component: the readable formatted type resolved
     * from the droid's component references and the component stats store,
     * else "Unknown" — NEVER a raw comp- ID (the raw-ID strip label was
     * the reported defect).
     * @param {string} componentId - Component ID.
     * @returns {string}
     * @private
     */
    _componentLabel(componentId) {
        const wsm = this._worldStateManager;
        const droid = wsm?.getActiveDroid?.();
        const instances = wsm?.getState()?.components?.instances ?? {};
        return resolveComponentLabel(componentId, droid?.components ?? [], instances);
    }

    /**
     * Display name for an item type (registry first, then the formatted type).
     * @param {string} type - Item type ID.
     * @returns {string}
     * @private
     */
    _typeName(type) {
        return this._itemRegistry[type]?.name || formatTypeName(type);
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

/**
 * InventoryFilter — dependency-free, pure view-filter helpers for the client
 * inventory panel.
 *
 * The panel shows an entity's volume-bearing components and the items carried
 * in each (flat `itemsByHost` map: host id → array of item instances). These
 * helpers decide *which components are visible* and *which displayed names
 * matched*, purely — they never mutate the items, the map, or world state, and
 * they touch no DOM and perform no fetch. Containment is resolved the same way
 * the panel groups its tree (a child's `hostComponentId` polymorphically names
 * its parent — a component id for a top-level item, a container item id for a
 * nested one), so the subtree traversal here is the mirror of the render tree.
 *
 * This module is deliberately client-only and lives in `public/utils/` (not
 * `shared/`): the server resolves containment independently in
 * `src/utils/InventoryManager.js`, so a cross-layer contract is not required —
 * the same placement rationale as `ItemTree.js` and `MapGeometry.js`.
 *
 * @module InventoryFilter
 */

/**
 * Named match policy for the search filter. Call sites reference this constant
 * rather than carrying inline boolean flags, so the matching semantics have
 * exactly one definition (the search is a case-insensitive substring match,
 * not a whole-word match).
 * @type {{ caseSensitive: boolean, wholeWord: boolean }}
 */
export const SEARCH_MATCH_OPTIONS = Object.freeze({
    caseSensitive: false,
    wholeWord: false,
});

/**
 * Tests whether a display name matches a raw search query under the given
 * options. The raw query is trimmed first; a query that is empty after
 * trimming is treated as *no match* (the deactivation short-circuit lives in
 * `filterInventoryView`, which decides whether the search filter is active at
 * all). `null`/`undefined`/non-string names never match.
 * @param {string|null|undefined} name - The displayed name to test.
 * @param {string} rawQuery - The raw search query (may be untrimmed).
 * @param {{ caseSensitive?: boolean, wholeWord?: boolean }} [options] - Match
 *   policy; defaults to {@link SEARCH_MATCH_OPTIONS} (case-insensitive substring).
 * @returns {boolean} `true` when the name matches the (trimmed) query.
 */
export function matchesQuery(name, rawQuery, options = SEARCH_MATCH_OPTIONS) {
    if (typeof name !== 'string' || typeof rawQuery !== 'string') return false;
    const query = rawQuery.trim();
    if (query.length === 0) return false;

    if (options.wholeWord) {
        // Escape any regex metacharacters in the query, then require the whole
        // query to align to word boundaries in the name.
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const flags = options.caseSensitive ? '' : 'i';
        return new RegExp(`\\b${escaped}\\b`, flags).test(name);
    }

    const haystack = options.caseSensitive ? name : name.toLowerCase();
    const needle = options.caseSensitive ? query : query.toLowerCase();
    return haystack.includes(needle);
}

/**
 * Direct-containment test: does the given host currently carry at least one
 * item directly? A host "contains items" iff its bucket in `itemsByHost` is a
 * non-empty array. For this data model direct containment is provably
 * equivalent to transitive containment (the containment graph is a forest
 * rooted at components, so any item nested at any depth has a topmost
 * ancestor held directly by the root) — so the "contains item" filter maps
 * 1:1 to what a component card renders as its top-level content.
 * @param {Object<string, Array<Object>>|null|undefined} itemsByHost - The
 *   flat host → items map.
 * @param {string|null|undefined} hostId - The host id to test.
 * @returns {boolean} `true` iff `itemsByHost[hostId]` is an array of length > 0.
 *   A missing key or a non-array value yields `false`.
 */
export function hasDirectItems(itemsByHost, hostId) {
    if (!itemsByHost || typeof itemsByHost !== 'object' || !hostId) return false;
    const bucket = itemsByHost[hostId];
    return Array.isArray(bucket) && bucket.length > 0;
}

/**
 * Collects every item instance in the subtree under `rootId` (a component id
 * or a container item id): the direct children first, descending breadth-first
 * through any child that is itself a host (a container item with its own
 * bucket). A visited-set cycle guard guarantees termination even if the input
 * were ever cyclic (the server guarantees a forest; the guard is
 * graceful-degradation insurance, never a behavior change). `itemsByHost` is
 * never mutated.
 * @param {Object<string, Array<Object>>|null|undefined} itemsByHost - The flat
 *   host → items map.
 * @param {string|null|undefined} rootId - The subtree root (component or container item id).
 * @returns {Array<Object>} The item instances in the subtree (may be empty).
 */
function collectSubtreeItems(itemsByHost, rootId) {
    const result = [];
    if (!itemsByHost || typeof itemsByHost !== 'object' || !rootId) return result;
    const direct = itemsByHost[rootId];
    if (!Array.isArray(direct)) return result;

    const seen = new Set();
    const queue = direct.slice();
    while (queue.length > 0) {
        const item = queue.shift();
        if (!item || typeof item.id !== 'string') continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.push(item);
        const children = itemsByHost[item.id];
        if (Array.isArray(children)) {
            for (const child of children) queue.push(child);
        }
    }
    return result;
}

/**
 * Collects every item id in the subtree under `rootId` (see
 * {@link collectSubtreeItems} for the traversal and cycle-guard semantics).
 * @param {Object<string, Array<Object>>|null|undefined} itemsByHost - The flat
 *   host → items map.
 * @param {string|null|undefined} rootId - The subtree root (component or container item id).
 * @returns {Array<string>} The item ids in the subtree (may be empty). Missing
 *   root or non-array bucket yields an empty array.
 */
export function collectSubtreeItemIds(itemsByHost, rootId) {
    return collectSubtreeItems(itemsByHost, rootId).map((item) => item.id);
}

/**
 * Applies the two client view filters to a list of already-display-named
 * components and returns the visible subset plus the sets of matched ids.
 *
 * The filters combine as AND: a component is visible only if it passes every
 * active filter. An OFF toggle / empty query deactivates that filter, so an
 * inactive filter lets everything through.
 *
 * - **Contains item** (`containsItemOnly`): keep only components with at least
 *   one direct item.
 * - **Search** (`query`): keep a component when its own display name matches,
 *   OR any item in its subtree (any depth) matches — subtree matching (not
 *   direct-only) keeps a deep hit's whole ancestor chain visible.
 *
 * Component display names are supplied pre-resolved by the caller (the panel
 * formats them); an item's display name is `item.name || item.type` —
 * deliberately identical to the panel's display rule, so the search matches
 * exactly what is rendered.
 *
 * This function is pure: it does not mutate `components`, `itemsByHost`, or
 * any item, and it performs no DOM/fetch work.
 *
 * @param {{
 *   components: Array<{ id: string, name: string, [key: string]: any }>,
 *   itemsByHost: Object<string, Array<Object>>,
 *   containsItemOnly?: boolean,
 *   query?: string
 * }} params - The view input.
 * @returns {{
 *   components: Array<{ id: string, name: string, [key: string]: any }>,
 *   matchedComponentIds: Set<string>,
 *   matchedItemIds: Set<string>
 * }} `components` is the visible subset in input order. `matchedComponentIds`
 *   holds the ids of visible components whose own name matched; `matchedItemIds`
 *   holds the ids of items (at any depth) whose display name matched AND that
 *   lie in the subtree of a visible component (items under hidden components
 *   are excluded — they render nowhere). Both sets are empty when the query is
 *   inactive.
 */
export function filterInventoryView({
    components,
    itemsByHost,
    containsItemOnly = false,
    query = '',
} = {}) {
    const safeComponents = Array.isArray(components) ? components : [];
    const safeItemsByHost =
        itemsByHost && typeof itemsByHost === 'object' ? itemsByHost : {};

    const trimmedQuery = typeof query === 'string' ? query.trim() : '';
    const searchActive = trimmedQuery.length > 0;
    const toggleActive = containsItemOnly === true;

    const visible = [];
    const matchedComponentIds = new Set();
    const matchedItemIds = new Set();

    for (const comp of safeComponents) {
        if (!comp || typeof comp.id !== 'string') continue;

        // Contains-item filter: direct containment.
        if (toggleActive && !hasDirectItems(safeItemsByHost, comp.id)) {
            continue;
        }

        // Search filter: own name OR any subtree item name.
        if (searchActive) {
            const compMatches = matchesQuery(comp.name, query);
            let anyItemMatch = false;
            const subtreeItems = collectSubtreeItems(safeItemsByHost, comp.id);
            for (const item of subtreeItems) {
                // Mirrors the panel display rule (`item.name || item.type` in
                // _renderTreeItems) so search matches exactly what the user sees.
                const displayName = item.name || item.type;
                if (matchesQuery(displayName, query)) {
                    matchedItemIds.add(item.id);
                    anyItemMatch = true;
                }
            }
            if (!compMatches && !anyItemMatch) {
                continue;
            }
            if (compMatches) {
                matchedComponentIds.add(comp.id);
            }
        }

        visible.push(comp);
    }

    return {
        components: visible,
        // Both sets are empty when the query is inactive.
        matchedComponentIds: searchActive ? matchedComponentIds : new Set(),
        matchedItemIds: searchActive ? matchedItemIds : new Set(),
    };
}

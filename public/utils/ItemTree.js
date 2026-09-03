/**
 * ItemTree — pure, non-mutating helpers for the flat per-entity items model.
 *
 * The server stores every item — top-level or deeply nested — in ONE flat array
 * on `entity.items`. A child's `hostComponentId` polymorphically points at its
 * immediate parent: either a component ID (top-level item) or a container item
 * ID (nested item). These helpers recover that containment relationship from
 * the flat array WITHOUT mutating the (shared) item instances, which the
 * read-only inspection path must never write into.
 *
 * This module is intentionally dependency-free and pure so it is shared by
 * every client surface that needs the same child-grouping semantics (the
 * interactive InventoryManager and the read-only ComponentViewer) without
 * duplicating the grouping rule.
 *
 * @module ItemTree
 */

/**
 * HTML escape table. Built from char codes (not literal entities) so the
 * produced values survive any source-level entity decoding and always render
 * the correct entity for each of the five special characters.
 * @type {Object<string,string>}
 */
// NOTE: every value is built as '&' (code point 38) + the entity's ASCII name,
// e.g. '&' + 'lt;' -> '<' (which renders as '<'). The '&' prefix is
// constructed from a code point so these literal suffixes ('amp;', 'lt;', ...)
// contain no entity the source-level decoders could mangle, while the key
// characters stay plain raw chars.
const ESCAPE_MAP = {
    '&': String.fromCodePoint(38) + 'amp;',
    '<': String.fromCodePoint(38) + 'lt;',
    '>': String.fromCodePoint(38) + 'gt;',
    '"': String.fromCodePoint(38) + 'quot;',
    "'": String.fromCodePoint(38) + '#39;',
};

/**
 * Returns the direct children of a host: every flat item whose
 * `hostComponentId` equals `hostId` (a component ID or a container item ID).
 * Pure — neither `hostId` nor `allItems` is mutated.
 * @param {string} hostId - The host's ID (component ID or container item ID).
 * @param {Array<Object>} allItems - The entity's flat items array.
 * @returns {Array<Object>} The direct child items (may be an empty array).
 */
export function directChildrenOf(hostId, allItems) {
    if (!hostId || !Array.isArray(allItems)) return [];
    return allItems.filter((item) => item && item.hostComponentId === hostId);
}

/**
 * Escapes a value for safe HTML interpolation (the five special characters).
 * @param {*} value - Any value to escape.
 * @returns {string} The escaped string.
 */
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

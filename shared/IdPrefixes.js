/**
 * IdPrefixes — Shared, environment-agnostic typed-ID prefix vocabulary.
 *
 * SINGLE SOURCE OF TRUTH for the typed-ID family (BUG-107): every entity,
 * component, item, equipped item, action-queue entry, and chat message in
 * the system is addressed by a self-describing string built from one of
 * these prefixes plus a UUID (e.g. "ent-<uuid>", "comp-<uuid>",
 * "item-<uuid>", "eq-<uuid>", "q-<uuid>", "chat-<uuid>"). The prefix IS
 * the type: it lets both layers resolve an ID to its kind without a lookup,
 * which keeps client-server ID routing unambiguous.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same
 * ES module can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * @module IdPrefixes
 */

/**
 * Typed-ID prefixes. Each VALUE is the exact string prefix used to build
 * and recognize IDs of that type. Renaming a value is a protocol-level
 * change: persisted and in-flight IDs would stop parsing, so values only
 * change with a deliberate migration.
 * @type {Object.<string, string>}
 */
export const ID_PREFIXES = {
    ENTITY: 'ent-',
    COMPONENT: 'comp-',
    ITEM: 'item-',
    EQUIPPED: 'eq-',
    QUEUE: 'q-',
    CHAT: 'chat-',
};

/**
 * Length of each typed-ID prefix in characters. Derived from the values in
 * ID_PREFIXES; kept as an explicit map so call sites that need prefix
 * lengths don't each re-derive them from string lengths.
 * @type {Object.<string, number>}
 */
export const ID_PREFIX_LENGTHS = {
    ENTITY: 4,
    COMPONENT: 5,
    ITEM: 5,
    EQUIPPED: 3,
    QUEUE: 3,
    CHAT: 5,
};

/**
 * Returns true when `id` is a string that starts with `prefix`.
 * The typeof guard makes the check total: non-strings (undefined, numbers,
 * null) are rejected cleanly instead of throwing.
 *
 * @param {*} id - The value to test (strings only).
 * @param {string} prefix - A prefix string from ID_PREFIXES.
 * @returns {boolean} True when `id` is a string with that prefix.
 */
export function isPrefixed(id, prefix) {
    return typeof id === 'string' && id.startsWith(prefix);
}

/**
 * Removes `prefix` from the front of `id`, yielding the UUID portion.
 *
 * @param {string} id - A string known to start with `prefix`.
 * @param {string} prefix - A prefix string from ID_PREFIXES.
 * @returns {string} The id without its prefix.
 */
export function stripPrefix(id, prefix) {
    return id.slice(prefix.length);
}

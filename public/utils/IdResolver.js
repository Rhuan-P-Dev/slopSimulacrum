/**
 * IdResolver
 * Browser-compatible utility for typed ID detection and manipulation.
 * 
 * Typed ID Format:
 * - Entity IDs: "ent-<uuid>"
 * - Component IDs: "comp-<uuid>"
 * - Item IDs: "item-<uuid>"
 * - Equipped Item IDs: "eq-<uuid>"
 * 
 * This is a browser-compatible version of the server-side IdResolver.
 * It does NOT use Node.js modules (Logger, fs, etc.) — pure JavaScript.
 * 
 * @module IdResolver
 */
class IdResolver {
    /**
     * Prefix length for typed IDs (e.g., "ent-" = 4 characters).
     * @private
     * @readonly
     */
    static PREFIX_LENGTH = 4;

    /**
     * Checks if an ID is a typed entity ID (ent-*).
     * @param {string} id - The ID to check.
     * @returns {boolean}
     */
    static isEntityId(id) {
        return typeof id === 'string' && id.startsWith('ent-');
    }

    /**
     * Checks if an ID is a typed component ID (comp-*).
     * @param {string} id - The ID to check.
     * @returns {boolean}
     */
    static isCompId(id) {
        return typeof id === 'string' && id.startsWith('comp-');
    }

    /**
     * Checks if an ID is a typed item ID (item-*).
     * @param {string} id - The ID to check.
     * @returns {boolean}
     */
    static isItemId(id) {
        return typeof id === 'string' && id.startsWith('item-');
    }

    /**
     * Checks if an ID is a typed equipped item ID (eq-*).
     * @param {string} id - The ID to check.
     * @returns {boolean}
     */
    static isEquippedId(id) {
        return typeof id === 'string' && id.startsWith('eq-');
    }

    /**
     * Checks if any typed ID type matches.
     * @param {string} id - The ID to check.
     * @returns {boolean}
     */
    static isTypedId(id) {
        return IdResolver.isEntityId(id) || IdResolver.isCompId(id) || IdResolver.isItemId(id) || IdResolver.isEquippedId(id);
    }

    /**
     * Parses a typed ID and returns its type and UUID.
     * @param {string} id - The typed ID to parse.
     * @returns {{ type: 'ent'|'comp'|'item'|'eq', uid: string } | null}
     */
    static parseId(id) {
        if (typeof id !== 'string' || id.length === 0) {
            return null;
        }

        if (id.startsWith('ent-')) {
            return { type: 'ent', uid: id.slice(4) };
        }
        if (id.startsWith('comp-')) {
            return { type: 'comp', uid: id.slice(5) };
        }
        if (id.startsWith('item-')) {
            return { type: 'item', uid: id.slice(5) };
        }
        if (id.startsWith('eq-')) {
            return { type: 'eq', uid: id.slice(3) };
        }

        return null;
    }

    /**
     * Wraps a UUID with a type prefix.
     * @param {string} type - The type name ('ent', 'comp', 'item', 'eq').
     * @param {string} uid - The raw UUID.
     * @returns {string} Typed ID.
     */
    static wrapId(type, uid) {
        const prefixes = { ent: 'ent-', comp: 'comp-', item: 'item-', eq: 'eq-' };
        const prefix = prefixes[type];
        if (!prefix) {
            throw new TypeError(`Unknown ID type: "${type}". Must be one of: ent, comp, item, eq.`);
        }
        return `${prefix}${uid}`;
    }

    /**
     * Validates that all IDs in an array are valid typed component IDs.
     * @param {Array<string>} ids - Array of IDs to validate.
     * @returns {{ valid: boolean, invalid: string[] }}
     */
    static validateComponentIds(ids) {
        if (!Array.isArray(ids)) {
            return { valid: false, invalid: ['Expected an array of component IDs.'] };
        }

        const invalid = [];
        for (const id of ids) {
            if (typeof id === 'string' && id.startsWith('comp-')) continue;
            if (typeof id === 'object' && id !== null && typeof id.componentId === 'string' && id.componentId.startsWith('comp-')) continue;
            if (typeof id === 'string') invalid.push(id);
            else if (typeof id === 'object') invalid.push(id.componentId || id);
        }

        return { valid: invalid.length === 0, invalid };
    }

    /**
     * Extracts the UUID from a typed ID.
     * @param {string} typedId - The typed ID.
     * @returns {string|null} The UUID, or null if not typed.
     */
    static unwrapId(typedId) {
        const parsed = IdResolver.parseId(typedId);
        return parsed ? parsed.uid : null;
    }
}

export default IdResolver;
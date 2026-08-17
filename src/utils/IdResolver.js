import Logger from './Logger.js';

/**
 * IdResolver — Utility for parsing, validating, and resolving typed IDs.
 *
 * All IDs in the system are type-prefixed for unambiguous type identification:
 * - Entities: `ent-${uuid}`
 * - Components: `comp-${uuid}`
 * - Items (inventory): `item-${uuid}`
 * - Equipped Items: `eq-${uuid}`
 *
 * This enables the server to determine whether an incoming ID refers to
 * a component, item, or equipped item solely by parsing the prefix.
 *
 * @module IdResolver
 */

const ID_TYPE_PREFIXES = {
    ent: 'ent-',
    comp: 'comp-',
    item: 'item-',
    eq: 'eq-'
};

/**
 * Maps type names to their prefix strings.
 * @readonly
 * @type {Object<string, string>}
 */
export const ID_TYPE_PREFIXES_READONLY = { ...ID_TYPE_PREFIXES };

/**
 * Parses a typed ID and returns its type and UUID.
 * @param {string} id - The typed ID to parse (e.g., "comp-550e8400-e29b-41d4-a716-446655440000").
 * @returns {{ type: 'ent'|'comp'|'item'|'eq', uid: string } | null} Parsed result, or null if not a typed ID.
 */
export function parseId(id) {
    if (typeof id !== 'string' || id.length === 0) {
        return null;
    }

    for (const [type, prefix] of Object.entries(ID_TYPE_PREFIXES)) {
        if (id.startsWith(prefix)) {
            const uid = id.slice(prefix.length);
            return { type, uid };
        }
    }

    return null;
}

/**
 * Checks if an ID is a typed entity ID.
 * @param {string} id - The ID to check.
 * @returns {boolean}
 */
export function isEntityId(id) {
    return typeof id === 'string' && id.startsWith('ent-');
}

/**
 * Checks if an ID is a typed component ID.
 * @param {string} id - The ID to check.
 * @returns {boolean}
 */
export function isCompId(id) {
    return typeof id === 'string' && id.startsWith('comp-');
}

/**
 * Checks if an ID is a typed inventory item ID.
 * @param {string} id - The ID to check.
 * @returns {boolean}
 */
export function isItemId(id) {
    return typeof id === 'string' && id.startsWith('item-');
}

/**
 * Checks if an ID is a typed equipped item ID.
 * @param {string} id - The ID to check.
 * @returns {boolean}
 */
export function isEquippedId(id) {
    return typeof id === 'string' && id.startsWith('eq-');
}

/**
 * Checks if any of the typed ID type checks pass.
 * @param {string} id - The ID to check.
 * @returns {boolean}
 */
export function isTypedId(id) {
    return isEntityId(id) || isCompId(id) || isItemId(id) || isEquippedId(id);
}

/**
 * Finds a component in an entity by typed component ID.
 * @param {Object} entity - The entity object with a components array.
 * @param {string} typedId - The typed component ID (e.g., "comp-...").
 * @returns {{ type: 'comp', component: Object } | null}
 */
export function resolveComponent(entity, typedId) {
    if (typeof typedId !== 'string' || !typedId.startsWith('comp-')) {
        return null;
    }

    if (!entity?.components || !Array.isArray(entity.components)) {
        return null;
    }

    const component = entity.components.find(c => c.id === typedId);
    if (component) {
        return { type: 'comp', component };
    }

    Logger.warn(`[IdResolver] Component not found: "${typedId}" in entity "${entity.id}"`);
    return null;
}

/**
 * Finds an inventory item in an entity by typed item ID.
 * @param {Object} entity - The entity object with an items array.
 * @param {string} typedId - The typed item ID (e.g., "item-...").
 * @returns {{ type: 'item', item: Object } | null}
 */
export function resolveItem(entity, typedId) {
    if (typeof typedId !== 'string' || !typedId.startsWith('item-')) {
        return null;
    }

    if (!entity?.items || !Array.isArray(entity.items)) {
        return null;
    }

    const item = entity.items.find(i => i.id === typedId);
    if (item) {
        return { type: 'item', item };
    }

    Logger.warn(`[IdResolver] Item not found: "${typedId}" in entity "${entity.id}"`);
    return null;
}

/**
 * Finds an equipped item by typed equipped item ID.
 * @param {Object} entity - The entity object.
 * @param {string} typedId - The typed equipped item ID (e.g., "eq-...").
 * @param {Array} equippedItems - Array of equipped item objects (from HoldingCostController).
 * @returns {{ type: 'eq', equippedItem: Object } | null}
 */
export function resolveEquippedItem(entity, typedId, equippedItems) {
    if (typeof typedId !== 'string' || !typedId.startsWith('eq-')) {
        return null;
    }

    if (!equippedItems || !Array.isArray(equippedItems)) {
        return null;
    }

    const equippedItem = equippedItems.find(eq => eq.eqId === typedId);
    if (equippedItem) {
        return { type: 'eq', equippedItem };
    }

    Logger.warn(`[IdResolver] Equipped item not found: "${typedId}" for entity "${entity.id}"`);
    return null;
}

/**
 * Wraps a UUID with a type prefix.
 * @param {string} type - The type name ('ent', 'comp', 'item', 'eq').
 * @param {string} uid - The raw UUID.
 * @returns {string} Typed ID (e.g., "comp-550e8400-e29b-41d4-a716-446655440000").
 */
export function wrapId(type, uid) {
    const prefix = ID_TYPE_PREFIXES[type];
    if (!prefix) {
        throw new TypeError(`Unknown ID type: "${type}". Must be one of: ${Object.keys(ID_TYPE_PREFIXES).join(', ')}.`);
    }
    return `${prefix}${uid}`;
}

/**
 * Legacy (pre-typed) raw UUID format, e.g. "550e8400-e29b-41d4-a716-446655440000".
 * IDs generated before the typed ID migration carried no ent-/comp- prefix.
 * @type {RegExp}
 */
const LEGACY_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks if an ID looks like a legacy (pre-typed) entity ID (raw UUID format).
 * Consolidated from the duplicated `_isLegacyEntityId` helpers in
 * ActionController, RangeValidator and ComponentResolver.
 * @param {string} id - The ID to check.
 * @returns {boolean}
 */
export function isLegacyEntityId(id) {
    return typeof id === 'string' && LEGACY_UUID_REGEX.test(id);
}

/**
 * Checks if an ID looks like a legacy (pre-typed) component ID (raw UUID format).
 * Consolidated from the duplicated `_isLegacyCompId` helpers in
 * ActionController, ComponentResolver and ActionSelectController.
 * @param {string} id - The ID to check.
 * @returns {boolean}
 */
export function isLegacyCompId(id) {
    return typeof id === 'string' && LEGACY_UUID_REGEX.test(id);
}

/**
 * Unwraps a typed ID, extracting the type and UUID.
 * @param {string} typedId - The typed ID to unwrap.
 * @returns {{ type: string, uid: string } | null} Unwrapped result, or null if not typed.
 */
export function unwrapId(typedId) {
    return parseId(typedId);
}

/**
 * Validates that all IDs in an array are valid typed component IDs.
 * @param {Array<string>} ids - Array of IDs to validate.
 * @returns {{ valid: boolean, invalid: string[] }}
 */
export function validateComponentIds(ids) {
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

export default {
    parseId,
    isEntityId,
    isCompId,
    isItemId,
    isEquippedId,
    isTypedId,
    isLegacyEntityId,
    isLegacyCompId,
    resolveComponent,
    resolveItem,
    resolveEquippedItem,
    wrapId,
    unwrapId,
    validateComponentIds,
    ID_TYPE_PREFIXES: ID_TYPE_PREFIXES_READONLY
};
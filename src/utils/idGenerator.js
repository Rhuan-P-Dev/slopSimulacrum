import crypto from 'crypto';

/**
 * Generates a cryptographically strong unique identifier (UUID v4).
 * @returns {string} A unique random ID.
 */
export function generateUID() {
    return crypto.randomUUID();
}

/**
 * Generates a typed entity ID with 'ent-' prefix.
 * @returns {string} Typed entity ID (e.g., "ent-550e8400-e29b-41d4-a716-446655440000").
 */
export function generateEntityId() {
    return `ent-${crypto.randomUUID()}`;
}

/**
 * Generates a typed component ID with 'comp-' prefix.
 * @returns {string} Typed component ID (e.g., "comp-6ba7b810-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateCompId() {
    return `comp-${crypto.randomUUID()}`;
}

/**
 * Generates a typed inventory item ID with 'item-' prefix.
 * @returns {string} Typed item ID (e.g., "item-6ba7b811-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateItemId() {
    return `item-${crypto.randomUUID()}`;
}

/**
 * Generates a typed equipped item ID with 'eq-' prefix.
 * @returns {string} Typed equipped item ID (e.g., "eq-6ba7b812-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateEquippedId() {
    return `eq-${crypto.randomUUID()}`;
}

export default generateUID;
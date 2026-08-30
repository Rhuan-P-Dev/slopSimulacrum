import crypto from 'crypto';
import { ID_PREFIXES } from '../../shared/IdPrefixes.js';

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
    return `${ID_PREFIXES.ENTITY}${crypto.randomUUID()}`;
}

/**
 * Generates a typed component ID with 'comp-' prefix.
 * @returns {string} Typed component ID (e.g., "comp-6ba7b810-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateCompId() {
    return `${ID_PREFIXES.COMPONENT}${crypto.randomUUID()}`;
}

/**
 * Generates a typed inventory item ID with 'item-' prefix.
 * @returns {string} Typed item ID (e.g., "item-6ba7b811-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateItemId() {
    return `${ID_PREFIXES.ITEM}${crypto.randomUUID()}`;
}

/**
 * Generates a typed equipped item ID with 'eq-' prefix.
 * @returns {string} Typed equipped item ID (e.g., "eq-6ba7b812-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateEquippedId() {
    return `${ID_PREFIXES.EQUIPPED}${crypto.randomUUID()}`;
}

/**
 * Generates a typed turn-queue entry ID with 'q-' prefix.
 * Part of the typed-ID family (BUG-107 consistency) used by the turn system
 * (Feature A) to identify a queued action entry for cancel/listing.
 * @returns {string} Typed queue entry ID (e.g., "q-6ba7b813-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateQueueId() {
    return `${ID_PREFIXES.QUEUE}${crypto.randomUUID()}`;
}

/**
 * Generates a typed room-chat message ID with 'chat-' prefix.
 * Part of the typed-ID family (BUG-107 consistency) used by the room chat
 * backend (spec §7.3) to identify one chat message.
 * @returns {string} Typed chat message ID (e.g., "chat-6ba7b814-9dad-11d1-80b4-00c04fd430c8").
 */
export function generateChatId() {
    return `${ID_PREFIXES.CHAT}${crypto.randomUUID()}`;
}

export default generateUID;
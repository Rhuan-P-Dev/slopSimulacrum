/**
 * EventRingBuffer — Generic fixed-capacity ring buffer for event entries.
 *
 * Feature B (spec §4.1): reusable, trivially testable, not world-specific —
 * hence a plain util class rather than a controller. Entries are stored by
 * reference; readers receive defensive copies (snapshot on read).
 *
 * Generic in shape, but its only current consumer is the world-event log:
 * the defaults intentionally track the world-event constants
 * (WORLD_EVENTS_MAX_LIMIT / WORLD_EVENTS_RECENT_LIMIT) so callers need no
 * arguments in that consumer's context.
 *
 * @module EventRingBuffer
 */

import { WORLD_EVENTS_MAX_LIMIT, WORLD_EVENTS_RECENT_LIMIT } from './Constants.js';

export class EventRingBuffer {
    /**
     * @param {number} [capacity=WORLD_EVENTS_MAX_LIMIT] - Hard cap on stored
     *   entries. Oldest entries are evicted once the capacity is exceeded.
     */
    constructor(capacity = WORLD_EVENTS_MAX_LIMIT) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new TypeError(`EventRingBuffer: capacity must be a positive integer, got ${capacity}`);
        }
        /** @private {number} */
        this._capacity = capacity;
        /** @private {Array} */
        this._entries = [];
    }

    /**
     * Appends an entry, evicting the oldest one beyond the capacity.
     * @param {Object} entry - The event entry (stored by reference).
     * @returns {void}
     */
    push(entry) {
        if (entry === null || typeof entry !== 'object') {
            throw new TypeError('EventRingBuffer.push: entry must be an object');
        }
        this._entries.push(entry);
        if (this._entries.length > this._capacity) {
            this._entries.shift();
        }
    }

    /**
     * Returns all entries, oldest → newest, as defensive copies.
     * @returns {Array}
     */
    getAll() {
        return this._entries.map(entry => structuredClone(entry));
    }

    /**
     * Returns the last `limit` entries, oldest → newest, as defensive copies.
     * @param {number} [limit=WORLD_EVENTS_RECENT_LIMIT] - Maximum number of entries.
     * @returns {Array}
     */
    getRecent(limit = WORLD_EVENTS_RECENT_LIMIT) {
        if (!Number.isInteger(limit) || limit < 0) {
            throw new TypeError('EventRingBuffer.getRecent: limit must be a non-negative integer');
        }
        const start = Math.max(0, this._entries.length - limit);
        return this._entries.slice(start).map(entry => structuredClone(entry));
    }

    /**
     * Removes all entries.
     * @returns {void}
     */
    clear() {
        this._entries = [];
    }

    /**
     * Returns the entries for persistence (deep-copied).
     * @returns {Array}
     */
    serialize() {
        return this._entries.map(entry => structuredClone(entry));
    }

    /**
     * Restores entries from a serialized array (deep-copied; entries beyond
     * the capacity keep only the newest ones).
     * @param {Array} entries - Serialized entries (oldest → newest).
     * @returns {void}
     */
    restore(entries) {
        const list = Array.isArray(entries) ? entries : [];
        this._entries = list.slice(-this._capacity).map(entry => structuredClone(entry));
    }
}

export default EventRingBuffer;

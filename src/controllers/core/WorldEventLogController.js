/**
 * WorldEventLogController — State owner of the world event ring buffer.
 *
 * Feature B (spec §4.1): the action pipeline only wrote "what happened in
 * the world" to the server Logger. This controller keeps a bounded in-memory
 * log of the last N events so the LLM context (and future UIs) can surface
 * short-term world memory.
 *
 * Deliberately has NO getAll() — state controllers with getAll() are
 * aggregated into the world-state broadcast (see WorldStateController.getAll),
 * and the full-state payload must stay lean (spec §4.7: "no events key in the
 * broadcast"). Consumers read via getRecent().
 *
 * @module WorldEventLogController
 */

import EventRingBuffer from '../../utils/EventRingBuffer.js';
import { WORLD_EVENTS_MAX_LIMIT, WORLD_EVENTS_RECENT_LIMIT } from '../../utils/Constants.js';

class WorldEventLogController {
    /**
     * @param {number} [capacity=WORLD_EVENTS_MAX_LIMIT] - Maximum number of retained events.
     */
    constructor(capacity = WORLD_EVENTS_MAX_LIMIT) {
        /** @private {EventRingBuffer} */
        this._buffer = new EventRingBuffer(capacity);
    }

    /**
     * Records a world event. Stamps `ts` with the current time.
     *
     * @param {Object} event
     * @param {number|null} [event.tick] - World tick when the event happened (null pre-tick).
     * @param {string} event.action - Action name, e.g. 'droid punch', 'turn', 'dropItem'.
     * @param {string|null} [event.targetId] - Component/entity ID the event relates to.
     * @param {string} event.message - Human/LLM-readable sentence (placeholders already resolved).
     * @param {'info'|'warn'} [event.level='info'] - Severity.
     * @returns {void}
     */
    record(event) {
        if (!event || typeof event !== 'object') {
            throw new TypeError('WorldEventLogController.record: event must be an object');
        }
        if (typeof event.message !== 'string' || event.message.length === 0) {
            throw new TypeError('WorldEventLogController.record: event.message must be a non-empty string');
        }
        this._buffer.push({
            tick: typeof event.tick === 'number' ? event.tick : null,
            action: typeof event.action === 'string' && event.action ? event.action : 'action',
            targetId: typeof event.targetId === 'string' ? event.targetId : null,
            message: event.message,
            level: event.level === 'warn' ? 'warn' : 'info',
            ts: Date.now()
        });
    }

    /**
     * Returns the last `limit` events, oldest → newest, as defensive copies.
     * @param {number} [limit=WORLD_EVENTS_RECENT_LIMIT]
     * @returns {Array}
     */
    getRecent(limit = WORLD_EVENTS_RECENT_LIMIT) {
        return this._buffer.getRecent(limit);
    }

    /**
     * Returns the buffered events for persistence (schema v2 "events" section).
     * @returns {Array}
     */
    serialize() {
        return this._buffer.serialize();
    }

    /**
     * Restores buffered events from a snapshot.
     * @param {Array} entries
     * @returns {void}
     */
    restore(entries) {
        this._buffer.restore(entries);
    }
}

export default WorldEventLogController;

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
 * **Round-scoped delivery (`getEventsForRound`).** What belongs in an agent's
 * turn is one round of events, not "whatever this agent has not been shown
 * yet" (wiki/decisions/round-scoped-context.md). Every entry therefore carries
 * the `round` it was written in, stamped at write time from the turn system, and
 * the context reads `getRecentForRound(round)`. A backlog is impossible by
 * construction: an event written in a round the agent did not experience is
 * never delivered to it, so no per-agent cursor is needed and none is kept.
 * `getRecent()` stays the reader-independent tail for `GET /world-events`.
 *
 * `round: null` means the writing side had no turn system to ask (or a snapshot
 * predating the stamp). Unknown is never guessed — such an event is visible to
 * human readers and never enters a model's round. `sequence` stays on the entry
 * as the write-order key (persisted, so a restored ring keeps its ordering).
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
        /** @private {number} monotonic write sequence; the ordering key
         * (never resets — an id that can be reused is an id that will be). */
        this._sequence = 0;
        /** @private {WorldStateController|null} Injected post-construction: the
         * only reason this store can name the round an event belongs to. */
        this.worldStateController = null;
    }

    /**
     * Injects the world state facade, so writes can be stamped with the open
     * round (the same seam RoomChatController uses for the same purpose).
     * @param {Object} facade
     * @returns {void}
     */
    setWorldStateController(facade) {
        this.worldStateController = facade || null;
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
            ts: Date.now(),
            // Monotonic write sequence — the ordering key. The tick stays for
            // display provenance; it is NOT the ordering key (many events share
            // one tick, the same reason perception does not use it for cursors).
            sequence: ++this._sequence,
            // The round this event belongs to. Resolution runs while its own
            // round is still the open one, so the open round IS the round that
            // produced it (wiki/decisions/round-scoped-context.md).
            round: this._openRound()
        });
    }

    /**
     * The round open right now, as the turn system stores it. The composition
     * root publishes it at `facade.subControllers.turns`; `turnSystemController`
     * is the property the facade class itself holds, so both paths are read.
     * @returns {number|null} null when no turn system answers (never 0)
     * @private
     */
    _openRound() {
        try {
            const turns = this.worldStateController?.subControllers?.turns
                ?? this.worldStateController?.turnSystemController;
            const round = turns?.getRoundState?.()?.roundNumber;
            return Number.isInteger(round) ? round : null;
        } catch {
            // why: a throwing turn system is a broken seam, not a fact about the
            // world — the event loses its round stamp rather than inventing one.
            return null;
        }
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
     * The events written in ONE round, oldest → newest. Stateless: nothing is
     * consumed, so the agent's turn and `GET /world-events` ask the same
     * question of the same store without interfering.
     *
     * A round that is not a whole number, or is negative (`-1` = nothing has
     * resolved yet), returns nothing — the honest answer, never a tail of
     * someone else's history.
     *
     * @param {Object} [options]
     * @param {number} [options.round] - the round to deliver; rows stamped null
     *   are never delivered (their round is unknown)
     * @param {number} [options.limit=WORLD_EVENTS_RECENT_LIMIT] - tail cap
     * @returns {Array} the round's events, oldest → newest
     */
    getEventsForRound({ round, limit = WORLD_EVENTS_RECENT_LIMIT } = {}) {
        if (!Number.isInteger(round) || round < 0) return [];
        const fresh = this._buffer.getAll().filter(ev => ev.round === round);
        const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : WORLD_EVENTS_RECENT_LIMIT;
        return fresh.slice(-safeLimit);
    }

    /**
     * Drops every buffered event.
     *
     * Used when a new world is created in place: the log is what the old world
     * did, and `GET /world-events` answering with a dead world's history would
     * read as if it had just happened. The round counter is NOT touched - a
     * round number never goes backwards (`CR D-6`).
     * @returns {void}
     */
    clear() {
        this._buffer.clear();
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
        const list = Array.isArray(entries) ? entries : [];
        // A ring restored from a snapshot written before the sequence existed
        // has no ordering key; index order IS its write order, so numbering it
        // in place is the honest backfill. The counter then continues above the
        // restored high-water mark, so a restored event never collides with a
        // fresh one.
        // `round` is NOT backfilled: a snapshot written before the stamp existed
        // has no record of which round an event belongs to, and guessing would
        // put old history inside a live round. Unknown stays null — visible to
        // human readers, never fed to a model as part of a round.
        const normalized = list.map((entry, index) => (
            entry && typeof entry === 'object'
                ? {
                    ...entry,
                    sequence: Number.isInteger(entry.sequence) ? entry.sequence : index + 1,
                    round: Number.isInteger(entry.round) ? entry.round : null
                }
                : entry
        ));
        this._buffer.restore(normalized);
        this._sequence = normalized.reduce(
            (max, entry) => Math.max(max, Number.isInteger(entry?.sequence) ? entry.sequence : 0),
            this._sequence
        );
    }
}

export default WorldEventLogController;

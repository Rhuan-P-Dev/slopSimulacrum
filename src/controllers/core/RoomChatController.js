/**
 * RoomChatController — State owner of the per-room chat ring buffers.
 *
 * Feature D backend (spec §7.3), pulled forward to Feature C because the
 * `speak_in_room` tool needs a real target. One fixed-capacity ring buffer
 * per room (keyed by room UID — what `entity.location` holds), plus a single
 * global-emit broadcast (`room-chat-message` with the roomId in the payload;
 * the client filters by its focused room — no Socket.IO server rooms, spec
 * §7.3 delivery decision).
 *
 * Deliberately has NO getAll() — state controllers with getAll() are
 * aggregated into the world-state broadcast, and the full-state payload must
 * stay lean. Consumers read via getMessages() / the dedicated socket event /
 * GET /rooms/:roomId/chat.
 *
 * **Round-scoped delivery (`getMessagesForRound`).** What belongs in an agent's
 * turn is the speech of ONE round — not a tail of the conversation, and not
 * "whatever this agent has not been shown yet" (wiki/decisions/round-scoped-context.md).
 * Every message therefore carries the `round` it was said in, stamped at send
 * time from the turn system, and the context reads `getMessagesForRound(roomId,
 * round)`. Nothing is delivered late: a line said in a round the agent did not
 * experience is never shown to it, which is the owner's rule ("discard the
 * backlog") and the reason the per-agent cursor this store used to carry is
 * gone.
 *
 * A message whose round is unknown carries `round: null` — restored transcripts
 * written before the stamp existed, or a send while no turn system is wired.
 * Unknown is never guessed: such a line stays visible to every human reader
 * (`getMessages()`, `GET /rooms/:roomId/chat`) and is never handed to a model as
 * part of a round. The `sequence` stays on the entry as the send-order key
 * (ring order is send order; clients dedupe by it).
 *
 * @module RoomChatController
 */

import Logger from '../../utils/Logger.js';
import { generateChatId } from '../../utils/idGenerator.js';
import { ROOM_CHAT_HISTORY_LIMIT, CHAT_MESSAGE_MAX_LENGTH } from '../../utils/Constants.js';

class RoomChatController {
    /**
     * @param {number} [capacityPerRoom=ROOM_CHAT_HISTORY_LIMIT] - Hard cap on retained messages per room.
     * @param {number} [maxMessageChars=CHAT_MESSAGE_MAX_LENGTH] - Hard cap on one message's text.
     */
    constructor(capacityPerRoom = ROOM_CHAT_HISTORY_LIMIT, maxMessageChars = CHAT_MESSAGE_MAX_LENGTH) {
        /** @private {number} */
        this._capacityPerRoom = capacityPerRoom;
        /** @private {number} */
        this._maxMessageChars = maxMessageChars;
        /** @private {Object<string, Array>} roomId → message[] (oldest → newest). */
        this._rooms = {};
        /** @private {WorldStateController|null} Injected post-construction (room existence check). */
        this.worldStateController = null;
        /** @private {Object|null} WorldStateBroadcastService or test stub. */
        this._broadcaster = null;
        /** @private {number} monotonic send sequence; the ordering key (never resets) */
        this._sequence = 0;
    }

    /**
     * Injects the world state facade (room existence check).
     * @param {import('../WorldStateController.js')} facade
     */
    setWorldStateController(facade) {
        this.worldStateController = facade;
    }

    /**
     * Injects the broadcast service (WorldStateBroadcastService or a test stub).
     * @param {Object} broadcastService
     */
    setBroadcaster(broadcastService) {
        this._broadcaster = broadcastService;
    }

    /**
     * Sends one chat message to a room.
     *
     * @param {Object} args
     * @param {string} args.roomId - Room UID (what entity.location holds).
     * @param {string} [args.speakerName='Player'] - Display name of the speaker.
     * @param {string|null} [args.speakerEntityId=null] - Typed entity ID when the speaker is an entity.
     * @param {string} args.text - The line (non-empty, ≤ maxMessageChars).
     * @returns {Object} { success: true, message } | { success: false, code, error }
     *   codes: ROOM_NOT_FOUND | EMPTY_MESSAGE | MESSAGE_TOO_LONG
     */
    sendMessage({ roomId, speakerName = 'Player', speakerEntityId = null, text }) {
        if (!roomId || typeof roomId !== 'string') {
            return { success: false, code: 'ROOM_NOT_FOUND', error: 'A room ID is required.' };
        }
        if (this.worldStateController) {
            const rooms = this.worldStateController.getRooms?.() || {};
            if (!rooms[roomId]) {
                return { success: false, code: 'ROOM_NOT_FOUND', error: `Room "${roomId}" does not exist.` };
            }
        }

        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (trimmed.length === 0) {
            return { success: false, code: 'EMPTY_MESSAGE', error: 'Message must be a non-empty string.' };
        }
        if (trimmed.length > this._maxMessageChars) {
            return {
                success: false,
                code: 'MESSAGE_TOO_LONG',
                error: `Message exceeds ${this._maxMessageChars} characters (${trimmed.length}).`
            };
        }

        const tick = this.worldStateController?.tickSystem?.currentTick
            ?? (typeof this.worldStateController?.internalComponentController?.tickSystem?.currentTick === 'number'
                ? this.worldStateController.internalComponentController.tickSystem.currentTick
                : null);

        const message = {
            id: generateChatId(),
            roomId,
            speakerName: typeof speakerName === 'string' && speakerName.trim() !== '' ? speakerName : 'Player',
            speakerEntityId: typeof speakerEntityId === 'string' ? speakerEntityId : null,
            text: trimmed,
            tick,
            ts: Date.now(),
            // Monotonic send sequence — the ordering key. `tick` stays for
            // display; many messages share one tick, so it cannot order them.
            sequence: ++this._sequence,
            // The round this line was said in — the key that decides whether it
            // enters an agent's turn (see the class header). Spoken during a
            // round's planning, so the OPEN round is the one it belongs to.
            // null when no turn system answers: never backfilled, never guessed.
            round: this._openRound()
        };

        // Push to the per-room ring (evicting the oldest beyond capacity).
        const ring = this._rooms[roomId] || [];
        ring.push(message);
        if (ring.length > this._capacityPerRoom) {
            ring.shift();
        }
        this._rooms[roomId] = ring;

        // Global emit with the roomId in the payload (spec §7.3 delivery decision).
        if (this._broadcaster?.broadcastRoomChatMessage) {
            try {
                this._broadcaster.broadcastRoomChatMessage(message);
            } catch (err) {
                Logger.warn(`[RoomChat] room-chat-message broadcast failed: ${err?.message || err}`);
            }
        }

        return { success: true, message };
    }

    /**
     * Returns a room's messages, oldest → newest, as defensive copies.
     * @param {string} roomId - Room UID.
     * @param {number} [limit=ROOM_CHAT_HISTORY_LIMIT] - Maximum number of messages (last `limit`).
     * @returns {Array}
     */
    getMessages(roomId, limit = ROOM_CHAT_HISTORY_LIMIT) {
        const ring = this._rooms[roomId];
        if (!ring || ring.length === 0) return [];
        const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : this._capacityPerRoom;
        const start = Math.max(0, ring.length - safeLimit);
        return ring.slice(start).map(entry => ({ ...entry }));
    }

    /**
     * The lines of ONE room said in ONE round, oldest → newest. Stateless: no
     * cursor, nothing consumed, so the agent's turn, the dev panel and any
     * future reader ask the same question and get the same answer.
     *
     * A round that is not a whole number returns nothing — including `-1`
     * ("nothing has resolved yet"), which is the honest answer rather than a
     * transcript the agent has not earned.
     *
     * @param {string} roomId - Room UID (what `entity.location` holds)
     * @param {Object} [options]
     * @param {number} [options.round] - the round to deliver; rows stamped null
     *   (round unknown) are never delivered
     * @param {number} [options.limit=ROOM_CHAT_HISTORY_LIMIT] - tail cap
     * @returns {Array} the round's messages, oldest → newest
     */
    getMessagesForRound(roomId, { round, limit = this._capacityPerRoom } = {}) {
        if (!roomId || !Number.isInteger(round) || round < 0) return [];
        const ring = this._rooms[roomId];
        if (!ring || ring.length === 0) return [];
        const fresh = ring.filter(entry => entry.round === round);
        const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : this._capacityPerRoom;
        return fresh.slice(-safeLimit).map(entry => ({ ...entry }));
    }

    /**
     * The round open right now, as the turn system stores it — the round a
     * message sent this instant belongs to. The composition root publishes the
     * turn system at `facade.subControllers.turns`; `turnSystemController` is
     * the property the facade class holds, so both paths are read.
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
            // why: a turn system that throws is a broken seam, not a fact about
            // the conversation — the line loses its round stamp rather than
            // inventing one or losing the send.
            return null;
        }
    }

    /**
     * Drops every room's chat history.
     *
     * Used when a new world is created in place: a transcript belongs to the
     * speakers who said it, and an empty world with the dead world's
     * conversation in the chat panel is a lie the client would keep telling
     * until it was reloaded.
     * @returns {void}
     */
    clear() {
        this._rooms = {};
    }

    /**
     * Returns the complete chat store for persistence (schema v2 "roomChat"
     * section — added by Feature D; the section is additive on v2).
     * @returns {Object<string, Array>}
     */
    serialize() {
        const store = {};
        for (const [roomId, ring] of Object.entries(this._rooms)) {
            if (ring.length > 0) {
                store[roomId] = ring.map(entry => ({ ...entry }));
            }
        }
        return store;
    }

    /**
     * Restores the chat store from a snapshot. Malformed input is tolerated
     * (resets to empty) — chat is ephemeral memory, never fatal.
     * @param {Object<string, Array>} store
     */
    restore(store) {
        if (!store || typeof store !== 'object' || Array.isArray(store)) {
            this._rooms = {};
            return;
        }
        const rooms = {};
        for (const [roomId, ring] of Object.entries(store)) {
            if (Array.isArray(ring)) {
                rooms[roomId] = ring
                    .filter(entry => entry && typeof entry === 'object' && typeof entry.text === 'string')
                    .slice(-this._capacityPerRoom)
                    .map(entry => ({ ...entry }));
            }
        }
        // A transcript saved before the sequence existed has no ordering key;
        // ring order IS send order, so numbering it in place is the honest
        // backfill. The counter then continues above the restored high-water
        // mark, so a restored line never collides with a fresh one.
        for (const ring of Object.values(rooms)) {
            for (const entry of ring) {
                if (!Number.isInteger(entry.sequence)) entry.sequence = this._sequence + 1;
                this._sequence = Math.max(this._sequence, entry.sequence);
                // The round stamp is NOT backfilled: a snapshot predating it has
                // no record of which round said what, and guessing would put
                // old speech inside a live round. Unknown stays null — the
                // client still shows it, no agent is fed it.
                if (!Number.isInteger(entry.round)) entry.round = null;
            }
        }
        this._rooms = rooms;
        Logger.info(`[RoomChat] Restored chat store (${Object.keys(rooms).length} rooms).`);
    }
}

export default RoomChatController;

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
 * @module RoomChatController
 */

import Logger from '../../utils/Logger.js';
import { generateChatId } from '../../utils/idGenerator.js';

class RoomChatController {
    /**
     * @param {number} [capacityPerRoom=50] - Hard cap on retained messages per room.
     * @param {number} [maxMessageChars=200] - Hard cap on one message's text.
     */
    constructor(capacityPerRoom = 50, maxMessageChars = 200) {
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
            ts: Date.now()
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
     * @param {number} [limit=50] - Maximum number of messages (last `limit`).
     * @returns {Array}
     */
    getMessages(roomId, limit = 50) {
        const ring = this._rooms[roomId];
        if (!ring || ring.length === 0) return [];
        const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : this._capacityPerRoom;
        const start = Math.max(0, ring.length - safeLimit);
        return ring.slice(start).map(entry => ({ ...entry }));
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
        this._rooms = rooms;
        Logger.info(`[RoomChat] Restored chat store (${Object.keys(rooms).length} rooms).`);
    }
}

export default RoomChatController;

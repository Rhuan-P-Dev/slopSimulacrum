/**
 * RoundProseController — the "give me round N, give me prose" reader.
 *
 * Why it exists: perception keeps a per-room ring of delta entries, each
 * stamped with its own tick and carrying a one-line human summary
 * (buildDeltaSummary); the turn system keeps, per round, the tick window in
 * which the round ran (startTick..endTick, endTick null while the round is
 * live). This controller crosses those two reader sources: round prose = the
 * room deltas whose tick falls in the round's window, assembled into one
 * flowing paragraph per room, plus a one-line round summary (buildRoundProse).
 *
 * Contract (same family as PerceptionController / RoomChatController):
 *   - pure reader: never mutates world state, never owns a tick (the tick
 *     clock is the turn system's; the reader only queries it);
 *   - reads through the facade's public read wrappers only (`getRooms`,
 *     `getPerceptionDeltasForRoom`) plus the facade's direct `turnSystemController`
 *     property (`getRoundWindow`);
 *   - no `getAll()` — this is a reader's derived view, not world state, so it
 *     must never appear in the full-state broadcast aggregate (see the comments
 *     on perceptionController / roomChatController in WorldComposition.js);
 *   - null-tolerant: an unwired facade or unwired turn system yields `null`
 *     (routes respond 503 / 404, never 500).
 *
 * History is recent-only, by design: a round is reconstructable only while its
 * entries still live in the per-room perception rings (PERCEPTION_MAX_LIMIT per
 * room, oldest evicted first) AND the turn system still holds the round
 * window (ROUND_PROSE_HISTORY_LIMIT, in memory, cleared on reset/restore).
 * Beyond both horizons the reader returns `null` — "out of recent history", not
 * an error.
 *
 * @module RoundProseController
 */

import { PERCEPTION_MAX_LIMIT } from '../../utils/Constants.js';
import { buildRoomProse, buildRoundProse } from '../../utils/RoundProseBuilder.js';

/**
 * Inclusive [startTick, endTick] filter over a room's perception entries
 * (oldest → newest, already in prose order).
 * @param {Array|null} entries
 * @param {{ startTick: number, endTick: number }} window
 * @returns {Array}
 */
function entriesInRange(entries, window) {
    if (!Array.isArray(entries) || !window) {
        return [];
    }
    if (!Number.isFinite(window.startTick) || !Number.isFinite(window.endTick)) {
        return [];
    }
    return entries.filter(
        (entry) =>
            entry &&
            Number.isFinite(entry.tick) &&
            entry.tick >= window.startTick &&
            entry.tick <= window.endTick
    );
}

class RoundProseController {
    constructor() {
        /** @private {import('../../controllers/WorldStateController.js')|null} Root facade, injected post-construction. */
        this._worldStateController = null;
    }

    /**
     * Post-construction DI (same convention as PerceptionController /
     * RoomChatController).
     * @param {import('../../controllers/WorldStateController.js')|null} facade
     */
    setWorldStateController(facade) {
        if (facade && typeof facade === 'object') {
            this._worldStateController = facade;
        }
    }

    /**
     * One round, as prose, across all rooms.
     * @param {number} round - non-negative round number
     * @returns {null|{ round: number, live: boolean, startTick: number, endTick: number, summary: string, entryCount: number, rooms: {[roomId]: {name: string, text: string, entryCount: number}} }}
     *         `null` when the reader is unwired or the round is unknown / out
     *         of the recent-history window. A live round is returned (live:
     *         true, endTick = current tick at read time).
     */
    getRoundProse(round) {
        const facade = this._worldStateController;
        const turns = facade ? facade.turnSystemController : null;
        const window = turns ? turns.getRoundWindow(round) : null;
        if (!window) {
            return null;
        }
        const rooms = this._collectRoundRooms(facade, window);
        return {
            round: window.round,
            live: window.live,
            startTick: window.startTick,
            endTick: window.endTick,
            ...buildRoundProse({
                round: window.round,
                live: window.live,
                startTick: window.startTick,
                endTick: window.endTick,
                rooms
            })
        };
    }

    /**
     * One room, as prose, for one round. Logical room name or uid accepted;
     * resolution mirrors the WSC read wrapper so a route-level 404 matches
     * what the read path would resolve.
     * @param {string} roomId
     * @param {number} round
     * @returns {null|{ round: number, live: boolean, startTick: number, endTick: number, roomId: string, room: string, entryCount: number, text: string }}
     */
    getRoomProse(roomId, round) {
        const facade = this._worldStateController;
        const turns = facade ? facade.turnSystemController : null;
        const window = turns ? turns.getRoundWindow(round) : null;
        if (!window) {
            return null;
        }
        const rooms = facade.getRooms?.() ?? {};
        const resolved = this._resolveRoom(rooms, facade, roomId);
        if (!resolved) {
            return null;
        }
        const entries = entriesInRange(
            facade.getPerceptionDeltasForRoom(resolved.uid, { limit: PERCEPTION_MAX_LIMIT }),
            window
        );
        return {
            round: window.round,
            live: window.live,
            startTick: window.startTick,
            endTick: window.endTick,
            roomId,
            room: resolved.name,
            entryCount: entries.length,
            text: buildRoomProse({ entries, roomName: resolved.name })
        };
    }

    /** { uid, name } or null; same resolution the WSC read wrapper performs. */
    _resolveRoom(rooms, facade, roomId) {
        if (!rooms || typeof roomId !== 'string' || roomId === '') {
            return null;
        }
        if (Object.prototype.hasOwnProperty.call(rooms, roomId)) {
            return { uid: roomId, name: rooms[roomId].name ?? roomId };
        }
        const uid =
            facade && typeof facade.getRoomUidByLogicalId === 'function'
                ? facade.getRoomUidByLogicalId(roomId)
                : null;
        if (uid && Object.prototype.hasOwnProperty.call(rooms, uid)) {
            return { uid, name: rooms[uid].name ?? uid };
        }
        return null;
    }

    /** All rooms of the world with at least one entry in the round window. */
    _collectRoundRooms(facade, window) {
        const rooms = facade.getRooms?.() ?? {};
        const out = {};
        for (const [roomId, room] of Object.entries(rooms)) {
            const name = room.name ?? roomId;
            const entries = entriesInRange(
                facade.getPerceptionDeltasForRoom(roomId, { limit: PERCEPTION_MAX_LIMIT }),
                window
            );
            if (entries.length === 0) {
                continue;
            }
            out[roomId] = {
                name,
                text: buildRoomProse({ entries, roomName: name }),
                entryCount: entries.length
            };
        }
        return out;
    }
}

export default RoundProseController;

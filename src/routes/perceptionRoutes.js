/**
 * perceptionRoutes — REST surface for the perception system (wiki/subMDs/systems/perception_system.md).
 *
 * The perception controller is a *pure observer* (it never mutates world state).
 * It is a per-room delta stream: the root controller (WorldStateController)
 * marks each room "dirty" at every mutation site and the perception controller
 * lazily flushes the diff (current vs last-seen snapshot) on first read.
 * These routes expose that stream.
 *
 * Endpoints:
 *   GET  /perception/:roomId?limit=100
 *     → 200 { success: true, roomId, kind, deltas: [ { tick, sinceTick, ts, roomId,
 *           kind, counts, summary, entities: { appeared, despawned, moved, statChanges },
 *           items: { added, removed }, dropped: { added, removed, moved },
 *           components: { added, removed, changed }, internal, equipped } ] }
 *       — the most recent up-to-`limit` delta entries for the room, oldest →
 *       newest. The room is flushed (dirty → diff/baseline) before being read
 *       so the list always reflects the *current* state. The first time a room
 *       is read it is a `kind: "baseline"` entry (the room's initial contents).
 *       404 when the room is unknown (logical names accepted via the WSC wrapper).
 *   GET  /perception/agent/:entityId?limit=100
 *     → 200 { success: true, entityId, deltas: [ … ] }
 *       — the "WHAT CHANGED SINCE YOUR LAST OBSERVATION" window for the *agent*:
 *       up to `limit` delta entries from ALL rooms, oldest → newest, covering
 *       the ticks since the agent's last confirmed observation. This is the
 *       exact shape LlmContextController consumes for its "WHAT CHANGED" context
 *       section. The agent cursor is advanced by this call (standard observer
 *       semantics — see the perception controller module header). 404 when the
 *       entity is absent; 400 when the ID is malformed.
 *   POST /perception/agent/:entityId
 *     → 200 { success: true, entityId }
 *       — explicitly records that `entityId` observed the world at the current
 *       tick (advances the agent cursor WITHOUT reading a delta). Used by the
 *       player-UI polling path / tests that want to control the cursor without
 *       taking a window. 404 when the entity is absent; 400 when the ID is
 *       malformed.
 *
 * All reads go through the *root controller's public read wrappers*
 * (`worldStateController.getPerceptionDeltasForRoom / getAgentPerception /
 * recordAgentObservation`), never the perception controller directly — this
 * keeps the route at the facade's public API (single source of truth rule) and
 * lets the facade resolve logical room names and supply the tick.
 *
 * @module perceptionRoutes
 */

import { sendRouteError } from '../utils/routeError.js';
import IdResolver from '../utils/IdResolver.js';
import { PERCEPTION_MAX_LIMIT } from '../utils/Constants.js';

/**
 * Normalizes and clamps a positive integer query param to the range
 * `[1, PERCEPTION_MAX_LIMIT]`, defaulting to PERCEPTION_MAX_LIMIT.
 * @param {*} raw
 * @returns {number}
 */
function resolveLimit(raw, fallback = PERCEPTION_MAX_LIMIT) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
        return Math.min(parsed, PERCEPTION_MAX_LIMIT);
    }
    return fallback;
}

/**
 * 404 when the given room (logical or UID) is not in the world.
 * @param {import('express').Response} res
 * @param {Object} worldStateController
 * @param {string} roomId
 */
function respondRoomNotFound(res, worldStateController, roomId) {
    res.status(404).json({
        success: false,
        message: `Room "${roomId}" not found in the world.`
    });
}

/**
 * 404/400 for an unknown or malformed entity ID.
 * @param {import('express').Response} res
 * @param {Object} worldStateController
 * @param {string} entityId
 * @param {string} reason - "invalid" | "not found"
 */
function respondEntityError(res, worldStateController, entityId, reason) {
    if (reason === 'invalid') {
        res.status(400).json({ success: false, message: `Invalid entity ID "${entityId}".` });
        return;
    }
    res.status(404).json({
        success: false,
        message: `Entity "${entityId}" not found in the world.`
    });
}

/**
 * True when the room (logical name or UID) exists in the world.
 * Mirrors the WSC wrapper's resolution so the 404 path matches what the
 * read path would have resolved.
 * @returns {boolean}
 */
function roomExists(worldStateController, roomId) {
    if (!roomId) return false;
    const rooms = worldStateController.getRooms?.() ?? {};
    if (Object.prototype.hasOwnProperty.call(rooms, roomId)) return true;
    const uid = worldStateController.getRoomUidByLogicalId?.(roomId);
    return Boolean(uid && Object.prototype.hasOwnProperty.call(rooms, uid));
}

/**
 * Registers perception routes with the given Express router.
 * @param {import('express').Router} router - Express router instance.
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.worldStateController - World state controller instance.
 */
export function register(router, { worldStateController }) {
    /**
     * GET /perception/:roomId?limit=100
     * The most recent up-to-`limit` room delta entries, oldest → newest.
     * Room logical names accepted (resolved by the WSC wrapper). 404 when
     * unknown.
     */
    router.get('/perception/:roomId', (req, res) => {
        const { roomId } = req.params;
        if (!roomId) {
            respondRoomNotFound(res, worldStateController, roomId);
            return;
        }
        if (!roomExists(worldStateController, roomId)) {
            respondRoomNotFound(res, worldStateController, roomId);
            return;
        }
        try {
            const limit = resolveLimit(req.query.limit);
            const deltas = worldStateController.getPerceptionDeltasForRoom(roomId, { limit });
            res.json({
                success: true,
                roomId,
                kind: deltas.length ? deltas[deltas.length - 1].kind : null,
                deltas
            });
        } catch (error) {
            sendRouteError(res, error);
        }
    });

    /**
     * GET /perception/agent/:entityId?limit=100
     * The agent's "WHAT CHANGED SINCE YOUR LAST OBSERVATION" window (all rooms,
     * oldest → newest). Advances the agent cursor. 404 when the entity is
     * absent; 400 when the ID is malformed.
     */
    router.get('/perception/agent/:entityId', (req, res) => {
        const { entityId } = req.params;
        if (!entityId) {
            respondEntityError(res, worldStateController, entityId, 'invalid');
            return;
        }
        if (!IdResolver.isEntityId(entityId)) {
            respondEntityError(res, worldStateController, entityId, 'invalid');
            return;
        }
        if (!worldStateController.getEntity?.(entityId)) {
            respondEntityError(res, worldStateController, entityId, 'not found');
            return;
        }
        try {
            const limit = resolveLimit(req.query.limit);
            const deltas = worldStateController.getAgentPerception(entityId, { limit });
            res.json({
                success: true,
                entityId,
                deltas
            });
        } catch (error) {
            sendRouteError(res, error);
        }
    });

    /**
     * POST /perception/agent/:entityId
     * Explicitly records that the agent observed the world (advances the agent
     * cursor without reading a delta). 404 when the entity is absent; 400 when
     * the ID is malformed.
     */
    router.post('/perception/agent/:entityId', (req, res) => {
        const { entityId } = req.params;
        if (!entityId) {
            respondEntityError(res, worldStateController, entityId, 'invalid');
            return;
        }
        if (!IdResolver.isEntityId(entityId)) {
            respondEntityError(res, worldStateController, entityId, 'invalid');
            return;
        }
        if (!worldStateController.getEntity?.(entityId)) {
            respondEntityError(res, worldStateController, entityId, 'not found');
            return;
        }
        try {
            worldStateController.recordAgentObservation?.(entityId);
            res.json({ success: true, entityId });
        } catch (error) {
            sendRouteError(res, error);
        }
    });
}

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
 *   GET  /perception/round/:roundNumber
 *     → 200 { success: true, round, live, startTick, endTick, summary, entryCount,
 *       rooms: { [roomId]: { name, text, entryCount } } }
 *       — round N in natural prose: every room-delta entry that landed inside
 *       the round's tick window (startTick..endTick, inclusive), joined per
 *       room into one flowing paragraph, plus a one-line round summary.
 *       A live round's `endTick` is the current tick as of the read. Recent-
 *       history only: round windows are in-memory turn bookkeeping and the
 *       perception rings keep the last PERCEPTION_MAX_LIMIT entries per room
 *       — 400 on malformed round, 404 on unknown/evicted round, 503 when the
 *       reader is unwired.
 *   GET  /perception/round/:roundNumber/byRoom/:roomId
 *     → 200 { success: true, round, live, startTick, endTick, roomId, room,
 *       entryCount, text }
 *       — one room's prose for a round. Logical names or uids accepted for
 *       the room (resolved by the reader, same path as /perception/:roomId).
 *       Same recent-history contract.
 *   GET  /perception/rounds/:from/:to
 *     → 200 { success: true, from, to, rounds: [ { round, observed: true,
 *       live, startTick, endTick, summary, entryCount, rooms } | { round,
 *       observed: false } ] }
 *       — inclusive range of rounds, one row per requested round, ascending.
 *       Observed rounds carry the single-round shape; evicted rounds (outside
 *       the in-memory reader horizon, ROUND_PROSE_HISTORY_LIMIT) come back with
 *       `observed: false` (partial result, never a 404 — a range may span an
 *       evicted gap). 400 for malformed bounds, `from > to`, or `to` beyond
 *       the current round (named in the message); 503 when the reader is
 *       unwired.
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
 * Parses a non-negative integer from a route param.
 * @param {*} raw
 * @returns {number|null}
 */
function parseRoundNumber(raw) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 404 for a round that is not in the recent-history window (unknown round or
 * window evicted by the in-memory horizon).
 * @param {import('express').Response} res
 * @param {number} round
 */
function respondRoundNotFound(res, round) {
    res.status(404).json({
        success: false,
        message: `Round ${round} was not observed (out of the recent-history window).`
    });
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
            sendRouteError(error, res, '/perception/:roomId GET');
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
            sendRouteError(error, res, '/perception/agent/:entityId GET');
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
            sendRouteError(error, res, '/perception/agent/:entityId POST');
        }
    });

    /**
     * GET /perception/round/:roundNumber
     * Round N in natural prose: every room delta entry inside the round's tick
     * window (startTick..endTick, inclusive), per room as one flowing
     * paragraph + a one-line round summary. A live round reads "so far"
     * (its endTick is the current tick as of the read). Recent-history only:
     * round windows are in-memory turn bookkeeping and the perception rings
     * keep the last PERCEPTION_MAX_LIMIT entries per room — 400 on malformed
     * round, 404 on unknown/evicted round, 503 when the reader is unwired.
     */
    router.get('/perception/round/:roundNumber', (req, res) => {
        const rawRound = req.params.roundNumber;
        const round = parseRoundNumber(rawRound);
        if (round === null) {
            return res.status(400).json({
                success: false,
                message: `Invalid round number "${rawRound}". Use a non-negative integer.`
            });
        }
        const reader = worldStateController.roundProseController;
        if (!reader) {
            return res.status(503).json({ error: 'Round prose reader is not available.' });
        }
        try {
            const data = reader.getRoundProse(round);
            if (!data) {
                return respondRoundNotFound(res, round);
            }
            return res.json({ success: true, ...data });
        } catch (error) {
            sendRouteError(error, res, '/perception/round/:roundNumber GET');
        }
    });

    /**
     * GET /perception/round/:roundNumber/byRoom/:roomId
     * One room's prose for a round (logical name or uid accepted, resolved by
     * the reader, same path as /perception/:roomId). Same recent-history and
     * 4xx/503 contract as the full-round endpoint.
     */
    router.get('/perception/round/:roundNumber/byRoom/:roomId', (req, res) => {
        const rawRound = req.params.roundNumber;
        const round = parseRoundNumber(rawRound);
        if (round === null) {
            return res.status(400).json({
                success: false,
                message: `Invalid round number "${rawRound}". Use a non-negative integer.`
            });
        }
        if (!roomExists(worldStateController, req.params.roomId)) {
            return respondRoomNotFound(res, worldStateController, req.params.roomId);
        }
        const reader = worldStateController.roundProseController;
        if (!reader) {
            return res.status(503).json({ error: 'Round prose reader is not available.' });
        }
        try {
            const data = reader.getRoomProse(req.params.roomId, round);
            if (!data) {
                return respondRoundNotFound(res, round);
            }
            return res.json({ success: true, ...data });
        } catch (error) {
            sendRouteError(error, res, '/perception/round/:roundNumber/byRoom/:roomId GET');
        }
    });

    /**
     * GET /perception/rounds/:from/:to
     *
     * Inclusive range of rounds as prose — the range view of
     * /perception/round/:roundNumber. One row per requested round number
     * (ascending): observed rounds carry the single-round shape (`observed:
     * true`); rounds evicted from the in-memory reader horizon
     * (ROUND_PROSE_HISTORY_LIMIT) return `{ round, observed: false }`. The
     * range itself never 404s — a gap inside the range is partial data,
     * reported per row. Bounds are validated here (the edge, T-1): non-negative
     * integers, `from <= to`, `to <= current round`; 400 with a field-level
     * message on violation (the current round named in the `to` case), 503
     * when the reader is unwired.
     */
    router.get('/perception/rounds/:from/:to', (req, res) => {
        const from = parseRoundNumber(req.params.from);
        const to = parseRoundNumber(req.params.to);
        if (from === null || to === null) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_RANGE_BOUNDS',
                message: 'from and to must be non-negative integers.'
            });
        }
        if (from > to) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_RANGE_BOUNDS',
                message: `from (${from}) is greater than to (${to}).`
            });
        }
        const reader = worldStateController.roundProseController;
        if (!reader) {
            return res.status(503).json({ error: 'Round prose reader is not available.' });
        }
        const turns = worldStateController.turnSystemController;
        const currentRound = turns ? turns.getRoundState().roundNumber : null;
        if (currentRound === null || to > currentRound) {
            return res.status(400).json({
                success: false,
                code: 'TO_EXCEEDS_CURRENT',
                message: `to (${to}) exceeds the current round (${currentRound}).`
            });
        }
        try {
            const data = reader.getRoundRangeProse(from, to);
            if (!data) {
                return res.status(503).json({ error: 'Round prose reader is not available.' });
            }
            return res.json({ success: true, from, to, rounds: data.rounds });
        } catch (error) {
            sendRouteError(error, res, '/perception/rounds/:from/:to GET');
        }
    });
}

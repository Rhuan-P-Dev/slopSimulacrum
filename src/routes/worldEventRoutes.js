/**
 * worldEventRoutes — REST surface for the world event log.
 *
 * Follows the standard `register(router, { deps })` shape (BUG-069): deps
 * are injected, no request-scope side channels.
 *
 * Endpoints:
 *   GET /world-events?limit=50[&entityId=ent-…]
 *     → 200 { events: [ …oldest → newest… ] }
 *
 * Each event keeps its lean shape ({ tick, action, targetId, message, level,
 * ts }) and gains an additive `context` object describing the requesting
 * entity's current room (spec "better text & vision"): room identity,
 * description, size, the entity's position, other same-room entities with
 * positions, dropped items with positions, and resolved exits. `context` is
 * null when no entity/room can be resolved, so the endpoint stays backward
 * compatible with consumers that ignore the field.
 *
 * @module worldEventRoutes
 */

import Logger from '../utils/Logger.js';
import IdResolver from '../utils/IdResolver.js';
import {
    WORLD_EVENTS_MAX_LIMIT,
    CONTEXT_MAX_ENTITIES,
    CONTEXT_MAX_DROPPED_ITEMS,
    CONTEXT_MAX_EXITS
} from '../utils/Constants.js';
import { resolveRoomExits } from '../utils/ContextResolution.js';

/**
 * Caps for the enriched event context. Derived from the single-sourced
 * spatial caps in Constants.js (shared with LlmContextController.BUDGET) so
 * the LLM text layer and the frontend event panel agree on how much spatial
 * detail to surface. Kept under the local name CONTEXT_CAPS so the rest of
 * buildEventContext is unchanged.
 */
const CONTEXT_CAPS = {
    maxEntities: CONTEXT_MAX_ENTITIES,
    maxDroppedItems: CONTEXT_MAX_DROPPED_ITEMS,
    maxExits: CONTEXT_MAX_EXITS
};

/**
 * Builds the enriched room context for one entity's current room, or null when
 * the entity or its room cannot be resolved. Reads only through the facade's
 * public API (getEntity, getRooms, getEntities, getDroppedItemsByRoom).
 * @param {Object} worldStateController
 * @param {string} entityId
 * @returns {Object|null}
 */
function buildEventContext(worldStateController, entityId) {
    const entity = worldStateController.getEntity(entityId);
    const roomUid = entity?.location;
    if (!entity || !roomUid) return null;

    const rooms = worldStateController.getRooms() || {};
    const room = rooms[roomUid];
    if (!room) return null;

    // Other same-room entities (excluding the requesting entity), with positions.
    const entities = Object.values(worldStateController.getEntities() || {})
        .filter(e => e.id !== entity.id && e.location === roomUid)
        .slice(0, CONTEXT_CAPS.maxEntities)
        .map(e => ({
            name: e.name || 'Droid',
            x: typeof e.spatial?.x === 'number' ? e.spatial.x : null,
            y: typeof e.spatial?.y === 'number' ? e.spatial.y : null
        }));

    // Dropped items in the current room, with positions.
    const droppedItems = Object.values(worldStateController.getDroppedItemsByRoom(roomUid) || {})
        .slice(0, CONTEXT_CAPS.maxDroppedItems)
        .map(it => ({
            name: it.name || it.itemType || 'item',
            x: it.x,
            y: it.y
        }));

    // Exits: which door leads to which room (target UID resolved to a name).
    const exits = resolveRoomExits(rooms, room, CONTEXT_CAPS.maxExits);

    return {
        roomId: roomUid,
        roomName: room.name || roomUid,
        roomDescription: room.description || '',
        roomWidth: room.width,
        roomHeight: room.height,
        playerPosition: (entity.spatial?.x != null && entity.spatial?.y != null)
            ? { x: entity.spatial.x, y: entity.spatial.y }
            : null,
        entities,
        droppedItems,
        exits
    };
}

/**
 * Registers world event routes with the given Express router.
 * @param {import('express').Router} router - Express router instance.
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.worldStateController - World state controller instance.
 */
export function register(router, { worldStateController }) {
    /**
     * GET /world-events?limit=50[&entityId=ent-…]
     * Returns the most recent world events, oldest → newest, each optionally
     * enriched with a `context` object for the requesting entity's room.
     */
    router.get('/world-events', (req, res) => {
        const limitParam = Number.parseInt(req.query.limit, 10);
        const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, WORLD_EVENTS_MAX_LIMIT) : WORLD_EVENTS_MAX_LIMIT;

        try {
            // Optional typed entity ID: malformed → 400 (consistent with llmRoutes).
            const entityId = req.query.entityId;
            if (entityId !== undefined && entityId !== '' && !IdResolver.isEntityId(entityId)) {
                return res.status(400).json({
                    error: `Invalid entityId: "${entityId}". Expected typed ID format "ent-<uuid>".`
                });
            }

            const events = worldStateController.getRecentEvents(limit);

            // Build the context once per request (the room does not change
            // across the batch) and attach it to every event.
            const context = entityId ? buildEventContext(worldStateController, entityId) : null;
            const enriched = (Array.isArray(events) ? events : []).map(ev => ({ ...ev, context }));

            res.json({ events: enriched });
        } catch (error) {
            Logger.error('/world-events endpoint error', { error: error.message });
            res.status(500).json({ error: 'Internal Server Error', details: error.message });
        }
    });
}

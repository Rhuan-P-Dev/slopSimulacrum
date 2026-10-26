/**
 * LLM API Routes
 *
 * Feature B (spec §4.4): GET /llm/context composes the token-budgeted,
 * sectioned narrative the LLM layer reads the world with.
 *
 * @module routes/llmRoutes
 */
import { sendRouteError } from '../utils/routeError.js';
import IdResolver from '../utils/IdResolver.js';
import { ID_PREFIXES } from '../../shared/IdPrefixes.js';

/**
 * Parses a non-negative integer query parameter, or null if absent/invalid.
 * @param {string|undefined} value
 * @returns {number|null}
 */
function parseNonNegativeInt(value) {
    if (value === undefined || value === null || value === '') return null;
    if (!/^\d+$/.test(String(value))) return NaN;
    return Number(value);
}

/**
 * Registers LLM routes with the given Express router.
 *
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export function register(router, { worldStateController }) {
    /**
     * GET /llm/context?entityId=ent-...[&maxEntities=8&maxEvents=20&maxChat=10]
     *
     * Builds the LLM-readable world context for one entity (spec §4.3/§4.4):
     * a bounded sectioned narrative plus a structured mirror and render stats.
     * No rate limit: in-memory reads only, and the LLM-facing path is
     * server-internal.
     */
    router.get('/llm/context', (req, res) => {
        try {
            const { entityId, maxEntities, maxEvents, maxChat } = req.query;

            // entityId: required + typed ID check (spec: malformed → 400)
            if (!entityId) {
                return res.status(400).json({ error: 'entityId query parameter is required.' });
            }
            if (!IdResolver.isEntityId(entityId)) {
                return res.status(400).json({
                    error: `Invalid entityId: "${entityId}". Expected typed ID format "${ID_PREFIXES.ENTITY}<uuid>".`
                });
            }

            // Optional numeric overrides: non-numeric → 400 (spec §4.4)
            const options = {};
            for (const [key, value] of [['maxEntities', maxEntities], ['maxEvents', maxEvents], ['maxChat', maxChat]]) {
                if (value === undefined) continue;
                const n = parseNonNegativeInt(value);
                if (Number.isNaN(n)) {
                    return res.status(400).json({ error: `Invalid ${key}: must be a non-negative integer.` });
                }
                options[key] = n;
            }

            const entity = worldStateController.getEntity(entityId);
            if (!entity) {
                return res.status(404).json({ error: 'ENTITY_NOT_FOUND' });
            }

            const { text, data, stats } = worldStateController.llmContextController.buildContext(entityId, options);

            const rooms = worldStateController.getRooms();
            const room = entity.location ? rooms[entity.location] : null;

            return res.json({
                entityId,
                room: room ? { id: entity.location, name: room.name } : { id: null, name: null },
                text,
                data,
                stats
            });
        } catch (error) {
            sendRouteError(error, res, '/llm/context');
        }
    });

    /**
     * GET /llm/agent/:entityId
     *  
     * Dev-inspector snapshot (the "Agent View" tab). Returns, for one entity,
     * exactly what the LLM agent would receive in a live round — resolved NPC
     * config, system prompt, full tool set, sectioned context (narrative + data
     * + render stats), live action registry, generated instincts, and the full
     * inspector transcript history (every stored round — capped by
     * LLM_AGENT_VIEW_HISTORY_ROUNDS — with all in-round LLM calls and
     * per-call results). Read-only; in-memory reads only, no rate limit.
     */
    router.get('/llm/agent/:entityId', (req, res) => {
        try {
            const entityId = req.params.entityId;

            // Same typed-ID validation as /llm/context.
            if (!entityId) {
                return res.status(400).json({ error: 'entityId is required.' });
            }
            if (!IdResolver.isEntityId(entityId)) {
                return res.status(400).json({
                    error: `Invalid entityId: "${entityId}". Expected typed ID format "${ID_PREFIXES.ENTITY}<uuid>".`
                });
            }

            const entity = worldStateController.getEntity(entityId);
            if (!entity) {
                return res.status(404).json({ error: 'ENTITY_NOT_FOUND' });
            }

            // The agent controller is attached to the facade at boot (server.js).
            const agent = worldStateController.llmAgentController;
            if (!agent || typeof agent.describeAgentView !== 'function') {
                return res.status(503).json({
                    error: 'LLM agent controller not wired yet — the inspector needs the agent instance.'
                });
            }

            // Optional context overrides (same parsing as /llm/context).
            const options = {};
            const raw = {
                maxEntities: req.query.maxEntities,
                maxEvents: req.query.maxEvents,
                maxChat: req.query.maxChat
            };
            for (const [key, value] of Object.entries(raw)) {
                if (value === undefined) continue;
                const n = parseNonNegativeInt(value);
                if (Number.isNaN(n)) {
                    return res.status(400).json({ error: `Invalid ${key}: must be a non-negative integer.` });
                }
                options[key] = n;
            }

            return res.json(agent.describeAgentView(entityId, options));
        } catch (error) {
            sendRouteError(error, res, '/llm/agent/:entityId');
        }
    });
}

/**
 * turnRoutes — REST surface for the turn system (Feature A, spec §5.4).
 *
 * Follows the standard `register(router, { deps })` shape (BUG-069): deps are
 * injected, no request-scope side channels.
 *
 * Endpoints:
 *   GET    /turns/state                 → { turns: <getRoundState()> }
 *   GET    /turns/queue/:entityId       → { entityId, phase, queue: [...] }
 *   DELETE /turns/queue/:entityId/:queueId → { success, removed }
 *   POST   /turns/ready/:entityId       → { success, alreadySignaled, closed, barrier }
 *
 * Rule-level outcomes (unknown entity, missing queue entry, ...) follow the
 * project's "rule failure = 200 { success:false }" contract; only malformed
 * IDs are 400.
 *
 * @module turnRoutes
 */

import Logger from '../utils/Logger.js';
import IdResolver from '../utils/IdResolver.js';
import { ID_PREFIXES, isPrefixed } from '../../shared/IdPrefixes.js';

/**
 * Registers turn-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance.
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.worldStateController - World state controller instance.
 */
export function register(router, { worldStateController }) {
	const getTurns = () => worldStateController.turnSystemController;

	/**
	 * GET /turns/state
	 * Returns the live round state (phase, round, initiative order, queues).
	 */
	router.get('/turns/state', (req, res) => {
		try {
			const turns = getTurns();
			if (!turns) {
				return res.status(503).json({ error: 'Turn system is not available.' });
			}
			res.json({ turns: turns.getRoundState() });
		} catch (error) {
			Logger.error('/turns/state endpoint error', { error: error.message });
			res.status(500).json({ error: 'Internal Server Error', details: error.message });
		}
	});

	/**
	 * GET /turns/queue/:entityId
	 * Lists the queued actions for one entity.
	 */
	router.get('/turns/queue/:entityId', (req, res) => {
		try {
			const { entityId } = req.params;
			if (!IdResolver.isEntityId(entityId)) {
				return res.status(400).json({ error: `Invalid entityId "${entityId}". Expected typed ID format "${ID_PREFIXES.ENTITY}<uuid>".` });
			}

			const turns = getTurns();
			if (!turns) {
				return res.status(503).json({ error: 'Turn system is not available.' });
			}

			const state = turns.getRoundState();
			res.json({
				entityId,
				phase: state.phase,
				queue: turns.getQueuedActions(entityId)
			});
		} catch (error) {
			Logger.error('/turns/queue endpoint error', { error: error.message });
			res.status(500).json({ error: 'Internal Server Error', details: error.message });
		}
	});

	/**
	 * DELETE /turns/queue/:entityId/:queueId
	 * Removes one queued entry. Only the owner entity's own entries are
	 * addressable; a missing queueId → { success: false } (200, not 404).
	 */
	router.delete('/turns/queue/:entityId/:queueId', (req, res) => {
		try {
			const { entityId, queueId } = req.params;
			if (!IdResolver.isEntityId(entityId)) {
				return res.status(400).json({ error: `Invalid entityId "${entityId}". Expected typed ID format "${ID_PREFIXES.ENTITY}<uuid>".` });
			}
			if (!isPrefixed(queueId, ID_PREFIXES.QUEUE)) {
				return res.status(400).json({ error: `Invalid queueId "${queueId}". Expected typed ID format "${ID_PREFIXES.QUEUE}<uuid>".` });
			}

			const turns = getTurns();
			if (!turns) {
				return res.status(503).json({ error: 'Turn system is not available.' });
			}

			const result = turns.cancelAction(entityId, queueId);
			res.json(result);
		} catch (error) {
			Logger.error('/turns/queue DELETE endpoint error', { error: error.message });
			res.status(500).json({ error: 'Internal Server Error', details: error.message });
		}
	});

	/**
	 * POST /turns/ready/:entityId
	 * Signals plan-complete for one entity (two-phase barrier). Rule-level
	 * outcomes (unknown entity, out-of-round, turns disabled, ...) follow the
	 * 200 { success:false, code, error } contract; only a malformed ID is 400.
	 */
	router.post('/turns/ready/:entityId', (req, res) => {
		try {
			const { entityId } = req.params;
			if (!IdResolver.isEntityId(entityId)) {
				return res.status(400).json({ error: `Invalid entityId "${entityId}". Expected typed ID format "ent-<uuid>".` });
			}

			const turns = getTurns();
			if (!turns) {
				return res.status(503).json({ error: 'Turn system is not available.' });
			}

			const result = turns.signalPlanComplete(entityId, 'player');
			res.json(result);
		} catch (error) {
			Logger.error('/turns/ready endpoint error', { error: error.message });
			res.status(500).json({ error: 'Internal Server Error', details: error.message });
		}
	});
}

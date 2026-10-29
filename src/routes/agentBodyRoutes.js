/**
 * agentBodyRoutes — the "Create Agent Body" dev feature (RP-1 prompt kind
 * `agent-body-design`, implemented in src/controllers/networking/AgentBodyController.js;
 * see wiki/decisions/agent-body-design.md).
 *
 * GET    /agent-body/cards          -> { cards: [{cardId, name, description, personality}] }
 * POST   /agent-body/create         -> { card, body, meta }
 *         body: { cardId: string (1..128 chars, no extension) }
 * POST   /agent-body/save           -> { saved, blueprintId, newComponents,
 *         blueprintWritten, blueprintOverwritten, backups }
 *         body: { blueprintId, rationale, structure, components? } (a design object)
 *
 * Errors (CR H-1/H-2 — every error has a machine-readable `code` in the
 * `{ error: { code, message } }` envelope):
 *   400 { code: 'CARD_ID_REQUIRED' }             cardId missing / wrong type
 *   400 { code: 'SAVE_PAYLOAD_INVALID' }         save body missing / not an object
 *   404 { code: 'CARD_NOT_FOUND' }               no card PNG with that id
 *   422 { code: 'BODY_DESIGN_INVALID' }          model output / saved design failed validation
 *   502 { code: LLM_ERROR_CODES.* }              provider failure (create only)
 *   503 { code: 'AGENT_BODY_CONTROLLER_NOT_WIRED' } feature not built (boot-order guard)
 *
 * Cost guard (SEC-9): at most 20 designs per minute per IP (create) — one LLM call
 * per POST, same rate-limit shape as /llm/chat. Save has its own budget (20 per
 * minute per IP) since it writes data files, though it makes no LLM call.
 *
 * @module src/routes/agentBodyRoutes
 */

import { CardNotFoundError, DesignValidationError } from '../controllers/networking/AgentBodyController.js';
import { LLMError } from '../utils/CustomErrors.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import { sendRouteError } from '../utils/routeError.js';

const designRouteLimiter = createRateLimiter({
	windowMs: 60000,
	max: 20,
	name: 'agent-body-route'
});

const saveRouteLimiter = createRateLimiter({
	windowMs: 60000,
	max: 20,
	name: 'agent-body-save-route'
});

export function register(router, { worldStateController }) {

	/**
	 * Resolves the designer from the facade, or emits a 503 when it is absent
	 * (boot-order guard, same shape as the /llm routes).
	 *
	 * @param {import('express').Request} req - unused; kept for signature symmetry.
	 * @param {import('express').Response} res
	 * @returns {AgentBodyController|null}
	 *
	 */
	function designerOrError(req, res) {
		void req;
		const designer = worldStateController?.agentBodyController;
		if (!designer || typeof designer.designBody !== 'function') {
			res.status(503).json({
				error: {
					code: 'AGENT_BODY_CONTROLLER_NOT_WIRED',
					message: 'The agent body controller is not wired to this server'
				}
			});
			return;
		}
		return designer;
	}

	router.get('/agent-body/cards', (req, res) => {
		void req;
		try {
			const designer = designerOrError(req, res);
			if (!designer) {
				return;
			}
			res.json({ cards: designer.listCards() });
		} catch (error) {
			sendRouteError(error, res, '/agent-body/cards');
		}
	});

	router.post('/agent-body/create', designRouteLimiter, async (req, res) => {
		try {
			const designer = designerOrError(req, res);
			if (!designer) {
				return;
			}
			const cardId = (typeof req.body.cardId === 'string') ? req.body.cardId.trim() : '';
			if (cardId.length === 0 || cardId.length > 128) {
				res.status(400).json({
					error: {
						code: 'CARD_ID_REQUIRED',
						message: 'POST /agent-body/create requires a "cardId" string (1-128 chars) in the JSON body'
					}
				});
				return;
			}
			try {
				const result = await designer.designBody(cardId);
				res.json(result);
				return;
			} catch (designError) {
				if (designError instanceof CardNotFoundError) {
					res.status(404).json({
						error: {
							code: designError.code,
							message: designError.message
						}
					});
					return;
				}
				if (designError instanceof DesignValidationError) {
					res.status(422).json({
						error: {
							code: designError.code,
							message: "The model's design failed validation for this card: " + designError.errors.join('; ')
						}
					});
					return;
				}
				if (designError instanceof LLMError) {
					res.status(502).json({
						error: {
							code: designError.code,
							message: 'The LLM call for this body design failed; try again when the provider is reachable'
						}
					});
					return;
				}
				sendRouteError(designError, res, '/agent-body/create');
			}
		} catch (error) {
			sendRouteError(error, res, '/agent-body/create');
		}
	});

	router.post('/agent-body/save', saveRouteLimiter, async (req, res) => {
		try {
			const designer = designerOrError(req, res);
			if (!designer) {
				return;
			}
			const body = req.body;
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				res.status(400).json({
					error: {
						code: 'SAVE_PAYLOAD_INVALID',
						message: 'POST /agent-body/save requires a JSON object design (blueprintId, rationale, structure, components?) in the body'
					}
				});
				return;
			}
			try {
				const result = await designer.saveDesign(body);
				res.json(result);
				return;
			} catch (designError) {
				if (designError instanceof DesignValidationError) {
					res.status(422).json({
						error: {
							code: designError.code,
							message: 'The saved design failed validation: ' + designError.errors.join('; ')
						}
					});
					return;
				}
				sendRouteError(designError, res, '/agent-body/save');
			}
		} catch (error) {
			sendRouteError(error, res, '/agent-body/save');
		}
	});
}

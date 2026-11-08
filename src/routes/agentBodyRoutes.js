/**
 * agentBodyRoutes — the "Create Agent Body" dev feature (RP-1 prompt kind
 * `agent-body-design`, implemented in src/controllers/networking/AgentBodyController.js;
 * see wiki/decisions/agent-body-design.md).
 *
 * GET    /agent-body/cards                -> { cards: [{cardId, name, description, personality}] }
 * GET    /agent-body/cards/user-relationships -> { relationships: { [cardId]: { label, summary, judgedAt } } }
 *                                           the judged {{user}} relationship per card, read from the
 *                                           sidecar next to each PNG (fresh ones only — a replaced
 *                                           card's stale verdict is not served).
 * GET    /agent-body/cards/:cardId/image  -> binary image body (image/png, image/jpeg, ...); the card
 *                                           art, served to the Cards screen's <img>. 400 when the
 *                                           path segment is missing or over 128 chars, 404
 *                                           CARD_NOT_FOUND when no card file has that stem.
 * POST   /agent-body/cards/:cardId/user-relationship -> { card, relationship, judgedAt, meta }
 *         one LLM call (the fifth prompt kind, `card-user-relationship`, RP-1) judging which
 *         relationship the card's character has with its {{user}}; the verdict is persisted as a
 *         sidecar next to the card's PNG (never into the PNG — the repository's language policy —
 *         and never into the world definition). 422 CARD_USER_TOKEN_ABSENT when the card's
 *         effective persona carries no {{user}} token; 422 CARD_NOT_READABLE when the card
 *         file exists but carries no usable character payload; 422 RELATIONSHIP_JUDGMENT_INVALID
 *         when the model's answer fails validation.
 * POST   /agent-body/create         -> { card, body, meta }
 *         body: { cardId: string (1..128 chars, no extension) }
 * POST   /agent-body/save           -> { saved, packageId, dir, version, content, created,
 *         backups, blueprintId, newComponents, newItems, outfitWritten, blueprintWritten,
 *         overlapsOfficial, applied: false, appliesVia, scanned }
 *         body: { blueprintId, rationale, structure, components?, garments?, outfit? }
 *   The save writes ONE data-only mod package (`data/mods/body-<slug>/`) and nothing
 *   else: the official `core-*` files are never touched, and applying is a separate act
 *   (`POST /mods/apply`), so the answer says `applied: false` rather than implying the
 *   world moved. The route rescans after the write so `GET /mods` can speak about the new
 *   package without another click (same shape as `/system/write`).
 *
 * Errors (CR H-1/H-2 — every error has a machine-readable `code` in the
 * `{ error: { code, message } }` envelope):
 *   400 { code: 'CARD_ID_REQUIRED' }             cardId missing / wrong type
 *   400 { code: 'SAVE_PAYLOAD_INVALID' }         save body missing / not an object
 *   404 { code: 'CARD_NOT_FOUND' }               no card PNG with that id
 *   422 { code: 'BODY_DESIGN_INVALID' }          model output / saved design failed validation,
 *                                                or its name yields no package id
 *   422 { code: 'CARD_USER_TOKEN_ABSENT' }       judge only: the card's effective persona has no
 *                                                {{user}} token, so there is no relationship to judge
 *   422 { code: 'CARD_NOT_READABLE' }            judge only: the card file exists but carries no
 *                                               usable character payload (a data mistake the operator can fix)
 *   422 { code: 'RELATIONSHIP_JUDGMENT_INVALID' } judge only: the model's judgment failed validation
 *   422 { code: MOD_PACKAGE_* }                  the writer refused the package (id, kind,
 *                                                size, non-data key)
 *   502 { code: LLM_ERROR_CODES.* }              provider failure (create and judge)
 *   503 { code: 'AGENT_BODY_CONTROLLER_NOT_WIRED' } feature not built (boot-order guard)
 *   503 { code: 'CARD_USER_RELATIONSHIP_CONTROLLER_NOT_WIRED' } judge/list not built (boot-order guard)
 *
 * Cost guard (SEC-9): at most 20 designs per minute per IP (create) — one LLM call
 * per POST, same rate-limit shape as /llm/chat. Save has its own budget (20 per
 * minute per IP) since it writes data files, though it makes no LLM call. The
 * judge route has its own budget as well (20 per minute per IP): one LLM call
 * per POST, answered by a small JSON object by contract.
 *
 * @module src/routes/agentBodyRoutes
 */

import { CardNotFoundError, DesignValidationError, MAX_CARD_ID_LENGTH } from '../controllers/networking/AgentBodyController.js';
import {
	CardNotFoundError as RelationshipCardNotFoundError,
	CardNotReadableError,
	CardUserTokenAbsentError,
	RelationshipJudgmentError
} from '../controllers/networking/CardUserRelationshipController.js';
import { PACKAGE_WRITE_ERROR_CODES } from '../services/ModPackageWriter.js';
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

const relationshipRouteLimiter = createRateLimiter({
	windowMs: 60000,
	max: 20,
	name: 'card-user-relationship-route'
});

/**
 * Every code the package writer can refuse with. The list is taken from the writer, so a
 * code added there is answered here too instead of falling through to a 500 (`CR H-2`).
 */
const PACKAGE_ERROR_CODES = Object.freeze(Object.values(PACKAGE_WRITE_ERROR_CODES));

/**
 * The per-card image is an asset, not a JSON answer: the bytes go straight out
 * with the image `Content-Type` and `Content-Length`. `Cache-Control: no-store`
 * because a card's art can change on disk (the user drops a new file) and a
 * stale cached <img> would then lie about what the card says.
 */
function serveCardImage(designer, cardId, res) {
	try {
		const { bytes, mimeType } = designer.readCardImage(cardId);
		res.set('Content-Type', mimeType);
		res.set('Content-Length', String(bytes.length));
		res.set('Cache-Control', 'no-store');
		res.send(bytes);
	} catch (error) {
		if (error instanceof CardNotFoundError) {
			res.status(404).json({
				error: {
					code: error.code,
					message: error.message
				}
			});
			return;
		}
		sendRouteError(error, res, '/agent-body/cards/:cardId/image');
	}
}

export function register(router, { worldStateController, modService }) {

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

	/**
	 * Resolves the relationship judge from the facade, or emits a 503 when it
	 * is absent (boot-order guard, same shape as the /llm routes).
	 *
	 * @param {import('express').Request} req - unused; kept for signature symmetry.
	 * @param {import('express').Response} res
	 * @returns {import('../controllers/networking/CardUserRelationshipController.js').default|null}
	 */
	function relationshipControllerOrError(req, res) {
		void req;
		const judge = worldStateController?.cardUserRelationshipController;
		if (!judge || typeof judge.judgeCardUserRelationship !== 'function') {
			res.status(503).json({
				error: {
					code: 'CARD_USER_RELATIONSHIP_CONTROLLER_NOT_WIRED',
					message: 'The card user-relationship controller is not wired to this server'
				}
			});
			return null;
		}
		return judge;
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

	/**
	 * The judged {{user}} relationship per card (read-only; the sidecar is
	 * written by the POST below, never here — CR API-1). A card whose persona
	 * moved on since its judgment has no entry: the stale sidecar is not
	 * served (the controller checks the persona hash).
	 */
	router.get('/agent-body/cards/user-relationships', (req, res) => {
		void req;
		try {
			const judge = relationshipControllerOrError(req, res);
			if (!judge) {
				return;
			}
			res.json({ relationships: judge.listCardUserRelationships() });
		} catch (error) {
			sendRouteError(error, res, '/agent-body/cards/user-relationships');
		}
	});

	/**
	 * The card art itself (its PNG/JPEG/WebP file under data/cards/), served to
	 * the Cards screen's <img> — one per card, fetched by the browser. The stem
	 * is matched against the on-disk listing, so a traversal in the request is
	 * just a non-match (SEC-7); the bytes are read by the seam (B-3), never from
	 * a path built out of the raw request.
	 */
	router.get('/agent-body/cards/:cardId/image', (req, res) => {
		const cardId = (typeof req.params?.cardId === 'string') ? req.params.cardId : '';
		// A missing or absurdly long segment is not a card id (CR E-7: caller
		// mistake -> 4xx); it stays out of a 404 echo. The listing match is what
		// actually decides 200 vs 404.
		if (cardId.length === 0 || cardId.length > MAX_CARD_ID_LENGTH) {
			res.status(400).json({
				error: {
					code: 'CARD_ID_REQUIRED',
					message: 'GET /agent-body/cards/:cardId/image requires a "cardId" path segment (1-' + MAX_CARD_ID_LENGTH + ' chars, no extension)'
				}
			});
			return;
		}
		const designer = designerOrError(req, res);
		if (!designer) {
			return;
		}
		serveCardImage(designer, cardId, res);
	});

	/**
	 * Judge one card's relationship with its {{user}}: one LLM call (prompt
	 * kind `card-user-relationship`, the fifth, RP-1) whose verdict is written
	 * as a sidecar next to the card's image. The judge's cost guard is the
	 * limiter on this route (SEC-9); the provider timeout is the LLM seam's.
	 * The segment is used raw, exactly like the sibling image route: a stem
	 * with surrounding whitespace is a legitimate card id, so no trim.
	 */
	router.post('/agent-body/cards/:cardId/user-relationship', relationshipRouteLimiter, async (req, res) => {
		const cardId = (typeof req.params?.cardId === 'string') ? req.params.cardId : '';
		if (cardId.length === 0 || cardId.length > MAX_CARD_ID_LENGTH) {
			res.status(400).json({
				error: {
					code: 'CARD_ID_REQUIRED',
					message: 'POST /agent-body/cards/:cardId/user-relationship requires a "cardId" path segment (1-' + MAX_CARD_ID_LENGTH + ' chars, no extension)'
				}
			});
			return;
		}
		try {
			const judge = relationshipControllerOrError(req, res);
			if (!judge) {
				return;
			}
			const result = await judge.judgeCardUserRelationship(cardId);
			res.json(result);
		} catch (judgeError) {
			if (judgeError instanceof RelationshipCardNotFoundError) {
				res.status(404).json({
					error: {
						code: judgeError.code,
						message: judgeError.message
					}
				});
				return;
			}
			if (judgeError instanceof CardUserTokenAbsentError) {
				res.status(422).json({
					error: {
						code: judgeError.code,
						message: judgeError.message
					}
				});
				return;
			}
			if (judgeError instanceof CardNotReadableError) {
				res.status(422).json({
					error: {
						code: judgeError.code,
						message: judgeError.message
					}
				});
				return;
			}
			if (judgeError instanceof RelationshipJudgmentError) {
				res.status(422).json({
					error: {
						code: judgeError.code,
						message: judgeError.message
					}
				});
				return;
			}
			if (judgeError instanceof LLMError) {
				res.status(502).json({
					error: {
						code: judgeError.code,
						message: 'The LLM call for this relationship judgment failed; try again when the provider is reachable'
					}
				});
				return;
			}
			sendRouteError(judgeError, res, '/agent-body/cards/:cardId/user-relationship');
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
				// The package directory changed, so what the mod service believes is installed
				// is stale. A rescan reads disk and mutates nothing — it is what lets the Mods
				// panel show the new row without another click.
				const scan = typeof modService?.rescan === 'function' ? modService.rescan() : null;
				res.json({
					...result,
					// Writing a package and changing the world are two acts. The body lands at
					// the next apply, never here.
					applied: false,
					appliesVia: 'POST /mods/apply',
					scanned: scan
						? { installed: scan.mods.length, rejected: scan.invalid.length }
						: null
				});
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
				if (designError?.code && PACKAGE_ERROR_CODES.includes(designError.code)) {
					res.status(422).json({
						error: { code: designError.code, message: designError.message }
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

/**
 * Mods API routes — what is installed, and what applying it would change.
 *
 * The read side answers over the package directory (`data/mods/`) and changes nothing:
 * `apply` is a separate change (the round boundary), and the reason `plan` exists at all is
 * that an operator can ask it repeatedly with no consequence
 * (`wiki/decisions/mod-system.md`, decision 6).
 *
 * The write side (enable, disable, move) writes the state file and queues the swap. None of
 * them changes the world in the request either — that happens at the round boundary — which
 * is why all three answer `pending` and name the moment.
 *
 * WHY POST FOR A READ. `POST /mods/rescan` and `POST /mods/plan` trigger a disk
 * scan rather than serve a cached answer, and rescan updates this service's view of
 * what is installed. They are safe and idempotent (the same disk gives the same
 * answer), so a client may retry them; POST is used because they are actions with a
 * result, not because they write to the world.
 *
 * The only injected dependency is the `ModService` (`src/services/ModService.js`),
 * which owns the loader and the live store. The routes shape nothing: they call and
 * send, and hand any throw to the shared error helper (`CR H-2`, `CR H-5`).
 *
 * @module routes/modRoutes
 */
import { sendRouteError, sendRouteErrorBody } from '../utils/routeError.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

/**
 * Enable, disable and move are writes (they persist `data/mods/loadorder.json`), so they are
 * rate limited like the other write routes (`CR SEC-2`). The budget is an operator's, not
 * a client's: toggling a package set a few dozen times a minute is already unusual.
 */
const writeLimiter = createRateLimiter({
	windowMs: 60000,
	max: 30,
	name: 'mod-write-route'
});

/** Domain error code -> HTTP status. Anything unmapped stays a 500. */
const ERROR_STATUS = {
	MOD_NOT_FOUND: 404,
	MOD_ID_INVALID: 400,
	// The request is well-formed and the package exists; the install will not allow it.
	// 409 because the conflict is with the state of the world, not with the request body
	// (which is what 400 would claim).
	MOD_REQUIREMENT_HELD: 409,
	MOD_REQUIREMENT_UNMET: 409,
	// The stack will not take the move: the package is already at that end, or the move would
	// compose it above something it requires. Both conflict with the shape of the install.
	MOD_MOVE_AT_EDGE: 409,
	MOD_MOVE_BREAKS_REQUIRES: 409,
	// The body did not say `up` or `down`. This one IS about the request.
	MOD_MOVE_DIRECTION_INVALID: 400,
	// The candidate the packages on disk describe cannot be installed as-is. Not a bad
	 // request - a package set the world will not take.
	REGISTRY_CANDIDATE_INVALID: 409
};

/**
 * Registers mod-package routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {import('../services/ModService.js').ModService} deps.modService
 *   The package manager view of the world.
 */
export function register(router, { modService }) {
	/**
	 * GET /mods
	 * The installed packages and what the world currently runs.
	 * `{ scanned, mods: [{ id, version, official, enabled, loadOrder, content, requires,
	 *    description, blocked }], invalid: [{ dir, code, message }],
	 *    live: { version, definitionCounts } }`
	 * `official` is derived from the reserved `core-` prefix, so this is the line
	 * between shipped content and somebody else's package. `description` is the manifest's
	 * own sentence about what the package is for, and `requires` the ids it will not load
	 * without: both are read off the manifest, and both are what an operator needs next to
	 * the id to tell 22 packages apart.
	 */
	router.get('/mods', (req, res) => {
		try {
			res.json(modService.list());
		} catch (error) {
			sendRouteError(error, res, '/mods');
		}
	});

	/**
	 * GET /mods/kinds
	 * The vocabulary a manifest's `content` array is written in:
	 * `{ kinds: [{ kind, file, coreDir, liveCount }] }`. Kind ids are data file ids,
	 * so this is where a mod author learns that entity blueprints are the `npcs` kind
	 * (the file is `entities.json`), and what each kind currently holds.
	 */
	router.get('/mods/kinds', (req, res) => {
		try {
			res.json({ kinds: modService.kinds() });
		} catch (error) {
			sendRouteError(error, res, '/mods/kinds');
		}
	});

	/**
	 * POST /mods/rescan
	 * Read the package directory again. Installs nothing, applies nothing.
	 * Same envelope as GET /mods, with `scanned: true`.
	 */
	router.post('/mods/rescan', (req, res) => {
		try {
			const result = modService.rescan();
			res.json({ ...result, live: modService.liveView() });
		} catch (error) {
			sendRouteError(error, res, '/mods/rescan');
		}
	});

	/**
	 * POST /mods/plan
	 * What an apply of the packages on disk would change, per registry kind, against
	 * the definition the world is running. `applied` is always false; `fromVersion`
	 * is the store version the plan was computed against, so a caller can tell
	 * whether the world moved since.
	 * `{ applied: false, fromVersion, kinds: [{ kind, added, removed, changed,
	 *    addedCount, removedCount, changedCount, unchanged, truncated, providers }],
	 *    quarantine: [{ kind, key, scope, reason }], shadowed, invalid }`
	 * The `kinds` diff is the candidate that survives composition; `quarantine` lists what
	 * was dropped and why, in the words of the owner whose rule it broke. A definition
	 * appears in one or the other, never both.
	 */
	router.post('/mods/plan', (req, res) => {
		try {
			res.json({ plan: modService.plan() });
		} catch (error) {
			sendRouteError(error, res, '/mods/plan');
		}
	});

	/**
	 * POST /mods/apply
	 * Ask for the packages on disk to become the world's definition now.
	 *
	 * There is one apply mechanism, and this is not a second one: it queues the same
	 * change and calls the same swap the round boundary calls. What it adds is the
	 * gate. If a round is open, the answer is `{ applied: false, pending: true,
	 * appliesAt: 'round-boundary', reason: 'ROUND_ACTIVE' }` - the ask stands and the
	 * swap happens at the boundary that is already coming, because a definition that
	 * changes mid-round is a different world than the one the round's agents are
	 * reading (`CR D-6`). If no round is open, the swap happens here and `report`
	 * carries the version, the kinds written and what was quarantined for cause.
	 *
	 * `applied: false` is therefore not a failure. The client shows `appliesAt`.
	 */
	router.post('/mods/apply', writeLimiter, (req, res) => {
		try {
			res.json({ success: true, ...modService.requestApply() });
		} catch (error) {
			const status = ERROR_STATUS[error?.code];
			if (status) {
				sendRouteErrorBody(
					error,
					res,
					'POST /mods/apply',
					{ success: false, error: error.code, message: error.message },
					status
				);
				return;
			}
			sendRouteError(error, res, '/mods/apply');
		}
	});

	/**
	 * GET /mods/:id/files
	 * The package's own files as they are on disk: `{ id, dir, manifest, files:
	 * [{ name, kind, json, content }] }`, where `kind` is the registry a JSON file
	 * feeds (`entities.json` -> `entities`) and null when it feeds none. Non-JSON
	 * files are listed by name with `content: null`. An unknown id is a 404.
	 */
	router.get('/mods/:id/files', (req, res) => {
		try {
			res.json(modService.packageFiles(req.params.id));
		} catch (error) {
			const status = ERROR_STATUS[error?.code];
			if (status) {
				sendRouteErrorBody(
					error,
					res,
					'GET /mods/:id/files',
					{ success: false, error: error.code, message: error.message },
					status
				);
				return;
			}
			sendRouteError(error, res, '/mods/:id/files');
		}
	});

	/**
	 * POST /mods/:id/enable and POST /mods/:id/disable
	 * Ask for an installed package to be in or out of the world.
	 *
	 * `{ success: true, id, enabled, pending, appliesAt }`. The change is written to
	 * `data/mods/loadorder.json` and queued; the world swaps its definition at the next
	 * round boundary, so `pending: true` is the normal answer and `appliesAt` says when.
	 * This is not a failure and not a delay to poll away — on a server whose turn loop is
	 * stopped the change stays pending until a round opens, and the file already says what
	 * the next boot will do.
	 *
	 * Idempotent (`CR H-3`): enabling an enabled package answers the same and queues no new
	 * work. An unknown id is a 404 `MOD_NOT_FOUND` — a typo must not create state for a
	 * package that does not exist.
	 */
	const toggle = (routeLabel, enabled) => (req, res) => {
		try {
			const result = enabled
				? modService.enable(req.params.id)
				: modService.disable(req.params.id);
			res.json({ success: true, ...result });
		} catch (error) {
			const status = ERROR_STATUS[error?.code];
			if (status) {
				sendRouteErrorBody(
					error,
					res,
					routeLabel,
					{ success: false, error: error.code, message: error.message },
					status
				);
				return;
			}
			sendRouteError(error, res, routeLabel);
		}
	};

	router.post('/mods/:id/enable', writeLimiter, toggle('POST /mods/:id/enable', true));
	router.post('/mods/:id/disable', writeLimiter, toggle('POST /mods/:id/disable', false));

	/**
	 * POST /mods/:id/move   body: { direction: 'up' | 'down' }
	 * One slot in the stack, in the direction the launcher draws it: `up` composes earlier and
	 * so LOSES a shared key, `down` composes last and wins it (the panel's ordinal gutter is the
	 * same numbering — position 1 is the top).
	 *
	 * `{ success: true, id, moved, direction, rank, total, loadOrder, previousLoadOrder,
	 * pending, appliesAt, shadowChanged, shadowChangedTruncated }`. `shadowChanged` names the
	 * keys whose OWNER the move changed — the only consequence worth reading after a reorder —
	 * and is capped at 50 with `shadowChangedTruncated` saying so.
	 *
	 * `409 MOD_MOVE_AT_EDGE` when the package is already at that end, and `409
	 * MOD_MOVE_BREAKS_REQUIRES` when the move would compose it above a package it requires;
	 * both carry `mod`, `requires`, `from`, `to` where they apply. `400
	 * MOD_MOVE_DIRECTION_INVALID` for any other body. Like enable/disable the change is written
	 * and queued, so `pending: true` is the normal answer.
	 */
	router.post('/mods/:id/move', writeLimiter, (req, res) => {
		try {
			res.json({ success: true, ...modService.moveMod(req.params.id, req.body?.direction) });
		} catch (error) {
			const status = ERROR_STATUS[error?.code];
			if (status) {
				// `mod`/`requires`/`from`/`to` are set by the service on the refusals that have
				// something specific to say, and only the ones actually set travel (an `undefined`
				// in a JSON body is dropped anyway, but a route that invents fields the service
				// never set would describe a shape that does not exist). The client needs the
				// package id and the positions to explain a refusal; a message alone makes it parse
				// prose back out.
				const conflict = {};
				for (const field of ['mod', 'requires', 'from', 'to']) {
					if (error[field] !== undefined) conflict[field] = error[field];
				}
				sendRouteErrorBody(
					error,
					res,
					'POST /mods/:id/move',
					{ success: false, error: error.code, message: error.message, ...conflict },
					status
				);
				return;
			}
			sendRouteError(error, res, 'POST /mods/:id/move');
		}
	});
}

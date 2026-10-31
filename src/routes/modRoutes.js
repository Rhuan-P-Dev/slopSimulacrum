/**
 * Mods API routes — what is installed, and what applying it would change.
 *
 * Three read-only endpoints over the package directory (`data/mods/`). None of
 * them changes the world: `apply` is a separate change (the round boundary), and the
 * reason `plan` exists at all is that an operator can ask it repeatedly with no
 * consequence (`wiki/decisions/mod-system.md`, decision 6).
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
 * Enable and disable are writes (they persist `data/mods/loadorder.json`), so they are
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
	MOD_ID_INVALID: 400
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
	 * `{ scanned, mods: [{ id, version, official, enabled, loadOrder, content }],
	 *    invalid: [{ dir, code, message }], live: { version, definitionCounts } }`
	 * `official` is derived from the reserved `core-` prefix, so this is the line
	 * between shipped content and somebody else's package.
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
}

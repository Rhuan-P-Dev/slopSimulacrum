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
import { sendRouteError } from '../utils/routeError.js';

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
}

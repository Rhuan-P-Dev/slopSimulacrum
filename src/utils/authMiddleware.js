import Logger from './Logger.js';

/**
 * Auth middleware — transport-level hardening gate for the API surface.
 *
 * Behavior:
 *   - When `process.env.REQUIRE_AUTH !== 'true'` (default, local development),
 *     the middleware is a pass-through and every request is allowed. This keeps
 *     the game usable out-of-the-box on a trusted local network with zero config.
 *   - When `process.env.REQUIRE_AUTH === 'true'` (production), every request must
 *     carry an `Authorization: Bearer <token>` header where `<token>` exactly
 *     equals `process.env.API_TOKEN`. Missing or wrong tokens are rejected with
 *     a 401 structured response.
 *
 * Design notes:
 *   - This is deliberately a single-shared-secret bearer gate, not a full
 *     identity/JWT system. It exists to stop unauthenticated access when the
 *     server is exposed beyond localhost. It does not manage per-user identity.
 *   - Env is read at request time so a restart-free change to REQUIRE_AUTH is
 *     respected; both values are cheap to read per request.
 *   - When REQUIRE_AUTH is on but API_TOKEN is unset we FAIL CLOSED (401) rather
 *     than silently opening the door — a misconfigured production server must not
 *     become accidentally public.
 *
 * Failure response:
 *   401 { success: false, error: { code: 'UNAUTHORIZED', message } }
 */
function authMiddleware(req, res, next) {
	// Local development / single-user mode: no auth required.
	if (process.env.REQUIRE_AUTH !== 'true') {
		return next();
	}

	const expectedToken = process.env.API_TOKEN;
	if (!expectedToken) {
		// Misconfiguration: auth requested but no token defined. Fail closed.
		Logger.error('[authMiddleware] REQUIRE_AUTH is "true" but API_TOKEN is not set — failing closed');
		return res.status(401).json({
			success: false,
			error: {
				code: 'UNAUTHORIZED',
				message: 'Server is misconfigured: authentication is required but no API token is configured.'
			}
		});
	}

	const header = req.headers['authorization'] || '';
	const match = /^Bearer\s+(.+)$/i.exec(header);
	const provided = match ? match[1] : null;

	if (!provided || provided !== expectedToken) {
		Logger.warn('[authMiddleware] Rejected unauthenticated request', { path: req.path, method: req.method });
		return res.status(401).json({
			success: false,
			error: {
				code: 'UNAUTHORIZED',
				message: 'Missing or invalid Authorization Bearer token.'
			}
		});
	}

	return next();
}

export default authMiddleware;

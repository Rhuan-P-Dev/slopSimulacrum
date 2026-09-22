import Logger from './Logger.js';

/**
 * routeError — the single 500-response contract for the HTTP layer.
 *
 * Why this exists: every route module used to repeat the same try/catch and
 * echo `error.message` straight to the caller. Exception text carries internal
 * structure (file names, controller names, data file paths) and must not travel
 * to the network in a real deployment, but the `{ error, details }` shape is
 * depended on by the client error UI and pinned by tests
 * (test/unit/knowledgeRoutes.test.js, test/unit/materialRoutes.test.js).
 * The shape therefore stays byte-compatible outside production and is narrowed
 * in production, from exactly one place.
 *
 * `NODE_ENV` is read per call, like the auth gate does, so a process does not
 * have to be restarted with the right environment to be tested against both
 * shapes.
 *
 * @module routeError
 */

/**
 * True when exception detail may be sent to the caller.
 * @returns {boolean}
 */
function exposesDetail() {
    return process.env.NODE_ENV !== 'production';
}

/**
 * Log a route failure and answer with the 500 contract for this environment.
 * @param {unknown} error - caught value
 * @param {import('express').Response} res
 * @param {string} routeLabel - human route identifier, e.g. 'POST /inventory/:entityId/add'
 * @returns {import('express').Response}
 */
export function sendRouteError(error, res, routeLabel) {
    const detail = (error && error.message) ? error.message : 'unknown error';
    Logger.error(`${routeLabel} endpoint error`, { error: detail });

    const body = { error: 'Internal Server Error' };
    if (exposesDetail()) {
        body.details = detail;
    }
    return res.status(500).json(body);
}

/**
 * Terminal Express error handler for anything that escapes a route body
 * (rejected promises thrown by a wrapper, middleware failures).
 * Must be registered AFTER all routes. Four parameters are what make Express
 * treat this as an error handler - the unused `next` is required, not sloppy.
 * @param {unknown} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function serverErrorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }
    return sendRouteError(err, res, `${req.method} ${req.path}`);
}

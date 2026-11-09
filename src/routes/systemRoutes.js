/**
 * systemRoutes — the HTTP surface of "the System": the operator's wish in, the
 * conversation and the proposal out, and the one click that turns a proposal into a
 * package.
 *
 * GET  /system/history/:sessionId  -> { sessionId, messages, proposal, actions, updatedAt }
 * POST /system/chat                -> { sessionId, reply, proposal, actions, toolLog, meta }
 *      body: { sessionId?: string, message: string (1..4000 chars) }
 * POST /system/write               -> { saved, packageId, dir, files, content, added,
 *                                       overrides, backups, scanned, applied: false }
 *      body: { sessionId: string }
 * POST /system/execute             -> { executed, results: [{ operation, summary, status,
 *                                       error?, result? }] }  runs the live plan in order and
 *                          mutates the world now; an empty plan is 409
 *      body: { sessionId: string }
 * POST /system/clear               -> { sessionId, cleared }   discards the plan (no-op if none)
 *      body: { sessionId: string }
 * GET  /system/status/:sessionId   -> { sessionId, actions: [...], proposal }  read-only plan view
 *
 * WHY WRITE TAKES A sessionId AND NOT A PROPOSAL. The operator writes exactly what the
 * server validated, not what a client holds (`T-1`): the proposal lives in the session,
 * and the route re-validates it before a byte is written. A client cannot put an
 * arbitrary package on disk through this door — or through any other one.
 *
 * WHY WRITE DOES NOT APPLY. A package on disk and a world that uses it are two facts, and
 * the second one belongs to `POST /mods/apply` (`ModService.requestApply`): apply now when
 * no round is open, defer to the round boundary when one is (`wiki/decisions/mod-system.md`,
 * decision 4). One apply mechanism, two moments — this route does not add a third.
 *
 * Errors (`CR H-1/H-2` — every one carries a machine-readable `code` in the
 * `{ error: { code, message } }` envelope):
 *   400 { code: 'MESSAGE_REQUIRED' }                 message missing / wrong type / empty
 *   400 { code: 'MESSAGE_TOO_LONG' }                 over the named character cap
 *   400 { code: 'WRITE_PAYLOAD_INVALID' }            write body without a sessionId
 *   404 { code: 'SESSION_NOT_FOUND' }                unknown session
 *   409 { code: 'PROPOSAL_NOT_SET' }                 write asked with no proposal on the table
 *   409 { code: 'ACTIONS_NOT_SET' }                  execute asked with no plan on the table
 *   422 { code: 'PROPOSAL_INVALID' }                the proposal broke a rule (`fields` lists them)
 *   422 { code: 'MOD_PACKAGE_*' }                   the writer refused the package
 *   502 { code: LLM error code }                    provider failure
 *   503 { code: 'WORLD_AUTHORING_CONTROLLER_NOT_WIRED' } feature not built (boot-order guard)
 *
 * Cost guard (`SEC-9`): a chat turn is several provider calls, not one, so its budget is
 * tighter than `/llm/chat` — 10 per minute per IP. Write makes no provider call but does
 * write data files, so it carries its own 20 per minute.
 *
 * @module routes/systemRoutes
 */

import {
    SessionNotFoundError,
    ProposalNotSetError,
    ActionsNotSetError,
    SYSTEM_ERROR_CODES,
    MAX_MESSAGE_CHARS,
    PROMPT_KIND,
    PROMPT_VERSION
} from '../controllers/networking/WorldAuthoringController.js';
import { ProposalValidationError, PROPOSAL_ERROR_CODES } from '../services/WorldProposalValidator.js';
import { PACKAGE_WRITE_ERROR_CODES } from '../services/ModPackageWriter.js';
import { LLMError } from '../utils/CustomErrors.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import { sendRouteError } from '../utils/routeError.js';

/** One turn is several provider calls; the budget is per turn, not per token. */
const chatLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    name: 'system-chat-route'
});

/** Writes data files (no provider call). */
const writeLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    name: 'system-write-route'
});

/** Executes the live plan (no provider call, but it mutates the world). Tight budget. */
const executeLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 5,
    name: 'system-execute-route'
});

/**
 * Domain error code -> HTTP status. A proposal refusal is 422 (the request was well
 * formed, the content is not) — the same reading `modRoutes` gives a rejected candidate.
 * The codes come from the modules that raise them, never restated here.
 */
const ERROR_STATUS = {
    [PROPOSAL_ERROR_CODES.INVALID]: 422,
    [SYSTEM_ERROR_CODES.SESSION_NOT_FOUND]: 404,
    [SYSTEM_ERROR_CODES.PROPOSAL_NOT_SET]: 409,
    [SYSTEM_ERROR_CODES.ACTIONS_NOT_SET]: 409
};

/** Every code the writer can refuse with. */
const PACKAGE_ERROR_CODES = Object.freeze(Object.values(PACKAGE_WRITE_ERROR_CODES));

/**
 * Registers the System routes.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps
 * @param {Object} deps.worldStateController - the facade; it carries `worldAuthoringController`
 * @param {import('../services/ModService.js').ModService} deps.modService - the package view (rescan after a write)
 */
export function register(router, { worldStateController, modService }) {
    /**
     * The authoring controller off the facade, or a 503 when it is absent (boot-order
     * guard, the same shape as the agent-body and llm routes). The capability is named per
     * route: a guard that demands `handleChat` on the way to a write would answer 503 for
     * a controller that can write.
     * @param {import('express').Response} res
     * @param {string} capability - the method this route needs
     * @returns {import('../controllers/networking/WorldAuthoringController.js').WorldAuthoringController|null}
     */
    function authoringOrError(res, capability) {
        const authoring = worldStateController?.worldAuthoringController;
        if (!authoring || typeof authoring[capability] !== 'function') {
            res.status(503).json({
                error: {
                    code: 'WORLD_AUTHORING_CONTROLLER_NOT_WIRED',
                    message: 'The world authoring controller is not wired to this server'
                }
            });
            return null;
        }
        return authoring;
    }

    /**
     * One turn of the conversation.
     *
     * The proposal — when the turn produced one — is returned for the operator to read.
     * Nothing was written: `toolLog` says what the System read, `meta` says which prompt
     * and model answered, and the Write button is what follows.
     */
    router.post('/system/chat', chatLimiter, async (req, res) => {
        try {
            const authoring = authoringOrError(res, 'handleChat');
            if (!authoring) return;

            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const message = typeof body.message === 'string' ? body.message.trim() : '';
            if (typeof body.message !== 'string' || message.length === 0) {
                res.status(400).json({
                    error: {
                        code: 'MESSAGE_REQUIRED',
                        message: `POST /system/chat requires a "message" string (1-${MAX_MESSAGE_CHARS} chars) in the JSON body`
                    }
                });
                return;
            }
            if (message.length > MAX_MESSAGE_CHARS) {
                res.status(400).json({
                    error: {
                        code: 'MESSAGE_TOO_LONG',
                        message: `"message" is ${message.length} chars; ${MAX_MESSAGE_CHARS} is the cap`
                    }
                });
                return;
            }
            const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
                ? body.sessionId.trim()
                : null;

            const turn = await authoring.handleChat({ sessionId, message });
            // Named rather than spread: the wire contract stays readable at the call
            // site and a new controller field cannot leak onto it by accident. `actions`
            // is the session's live plan, so the plan card (Execute / Clear) paints after
            // the turn without a second round trip.
            res.json({
                sessionId: turn.sessionId,
                reply: turn.reply,
                proposal: turn.proposal,
                actions: turn.actions,
                toolLog: turn.toolLog,
                meta: { ...turn.meta, promptKind: PROMPT_KIND, promptVersion: PROMPT_VERSION }
            });
        } catch (error) {
            if (error instanceof LLMError) {
                res.status(502).json({
                    error: {
                        code: error.code,
                        message: 'The System could not reach the model for this turn; the conversation is unchanged'
                    }
                });
                return;
            }
            sendRouteError(error, res, '/system/chat');
        }
    });

    /**
     * What a session holds — the conversation and the proposal on the table. A reloaded
     * tab asks this before it sends anything, so an operator does not lose a thread they
     * were still reading.
     */
    router.get('/system/history/:sessionId', (req, res) => {
        try {
            const authoring = authoringOrError(res, 'getHistory');
            if (!authoring) return;
            res.json(authoring.getHistory(req.params.sessionId));
        } catch (error) {
            if (error instanceof SessionNotFoundError) {
                res.status(ERROR_STATUS[error.code] ?? 404).json({ error: { code: error.code, message: error.message } });
                return;
            }
            sendRouteError(error, res, '/system/history/:sessionId');
        }
    });

    /**
     * The operator's click: write this session's proposal as a package.
     *
     * Re-validated inside the controller before anything is written, then rescanned so
     * `GET /mods` answers about the new package without another click. Applying is a
     * separate act (`POST /mods/apply`), and the answer says so rather than implying the
     * world changed.
     */
    router.post('/system/write', writeLimiter, async (req, res) => {
        try {
            const authoring = authoringOrError(res, 'writeProposal');
            if (!authoring) return;

            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
            if (sessionId.length === 0) {
                res.status(400).json({
                    error: {
                        code: 'WRITE_PAYLOAD_INVALID',
                        message: 'POST /system/write requires a "sessionId" string in the JSON body'
                    }
                });
                return;
            }

            const report = await authoring.writeProposal(sessionId);
            // The package directory changed, so the service's view of what is installed is
            // stale. Rescanning is a disk read and mutates nothing (`ModService` never
            // changes the world) — it is what lets the Mods panel show the row immediately.
            const scan = typeof modService?.rescan === 'function' ? modService.rescan() : null;

            res.json({
                ...report,
                applied: false,
                appliesVia: 'POST /mods/apply',
                scanned: scan
                    ? { installed: scan.mods.length, rejected: scan.invalid.length }
                    : null
            });
        } catch (error) {
            if (error instanceof SessionNotFoundError || error instanceof ProposalNotSetError) {
                res.status(ERROR_STATUS[error.code] ?? 409).json({ error: { code: error.code, message: error.message } });
                return;
            }
            if (error instanceof ProposalValidationError) {
                res.status(422).json({
                    error: {
                        code: error.code,
                        message: 'The stored proposal no longer passes the rules: ' + error.errors.join('; '),
                        fields: error.errors
                    }
                });
                return;
            }
            if (error?.code && PACKAGE_ERROR_CODES.includes(error.code)) {
                res.status(422).json({ error: { code: error.code, message: error.message } });
                return;
            }
            sendRouteError(error, res, '/system/write');
        }
    });

    /**
     * The operator's click: run the live plan of actions, in order, against the running
     * world. This is what actually executes — a proposal is nothing until written (and
     * nothing changes the world until written AND applied); an action executes now, without
     * the round boundary. Mutates the world immediately. Each action is re-validated and
     * executed; a failure reports itself and the remaining actions still run. An empty
     * plan is 409 (nothing on the table to run).
     */
    router.post('/system/execute', executeLimiter, (req, res) => {
        try {
            const authoring = authoringOrError(res, 'executeActions');
            if (!authoring) return;

            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
            if (sessionId.length === 0) {
                res.status(400).json({
                    error: {
                        code: 'EXECUTE_PAYLOAD_INVALID',
                        message: 'POST /system/execute requires a "sessionId" string in the JSON body'
                    }
                });
                return;
            }

            const report = authoring.executeActions(sessionId);
            res.json(report);
        } catch (error) {
            if (error instanceof SessionNotFoundError || error instanceof ActionsNotSetError) {
                res.status(ERROR_STATUS[error.code] ?? 409).json({ error: { code: error.code, message: error.message } });
                return;
            }
            sendRouteError(error, res, '/system/execute');
        }
    });

    /**
     * Clears the plan of live actions without executing anything: a discard of the table.
     * A session with no plan is a harmless no-op (the operator may click it out of habit).
     */
    router.post('/system/clear', (req, res) => {
        try {
            const authoring = authoringOrError(res, 'clearPlan');
            if (!authoring) return;

            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
            if (sessionId.length === 0) {
                res.status(400).json({
                    error: {
                        code: 'CLEAR_PAYLOAD_INVALID',
                        message: 'POST /system/clear requires a "sessionId" string in the JSON body'
                    }
                });
                return;
            }

            const result = authoring.clearPlan(sessionId);
            // The controller already returns the wire shape ({ sessionId, cleared });
            // pass it through unchanged so `cleared` is the boolean the client reads.
            res.json(result);
        } catch (error) {
            if (error instanceof SessionNotFoundError) {
                res.status(ERROR_STATUS[error.code] ?? 404).json({ error: { code: error.code, message: error.message } });
                return;
            }
            sendRouteError(error, res, '/system/clear');
        }
    });

    /**
     * What is on the table: the live plan (empty when none) plus the proposal, if any.
     * A cheap, read-only read so the client can render its execute/clear buttons without
     * a write call. 404 for an unknown session.
     */
    router.get('/system/status/:sessionId', (req, res) => {
        try {
            const authoring = authoringOrError(res, 'getPlanStatus');
            if (!authoring) return;
            res.json(authoring.getPlanStatus(req.params.sessionId));
        } catch (error) {
            if (error instanceof SessionNotFoundError) {
                res.status(ERROR_STATUS[error.code] ?? 404).json({ error: { code: error.code, message: error.message } });
                return;
            }
            sendRouteError(error, res, '/system/status/' + req.params.sessionId);
        }
    });
}

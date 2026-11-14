/**
 * WorldAuthoringController — "the System" behind the System tab: it listens to what the
 * operator wants and authors the data-only mod package that would make it so.
 *
 * This is the fourth LLM prompt kind (`RP-1`), named **`system-authoring`** and versioned
 * (`RP-2`, `PROMPT_VERSION` below — a prompt change is a bump here, never an edit of the
 * prompt text somewhere else). It is judgment only: nothing reaches disk while the
 * conversation runs. A turn may end with a *proposal*, and the proposal becomes a package
 * only when the operator calls `writeProposal` — the click in the System tab — which
 * re-validates and writes through `ModPackageWriter`. Applying it is not this module's
 * business either: `ModService` swaps a definition at the round boundary and nowhere else
 * (`wiki/decisions/mod-system.md`, decision 4).
 *
 * HOW A TURN RUNS (an agent loop, the precedent being `LLMAgentController`):
 *   1. the operator's wish is appended to the session history,
 *   2. `LLMController.chatFull` is called with the tool set, `tool_choice: 'auto'`,
 *   3. every `tool_calls` entry is executed here and answered as a `tool` message,
 *   4. the loop repeats until the model answers with plain text or the iteration cap is
 *      reached,
 *   5. only the wish and the model's final sentence go into the history (see HISTORY
 *      below); the tool traffic goes to the caller as `toolLog`.
 *
 * WHY TOOLS AND NOT A DUMP OF THE WORLD IN THE PROMPT: the model has to *check* before it
 * cites a material, a component or an item id. Guessing an id is the failure mode this
 * whole feature would ship — read first, then propose, and a rejected proposal comes back
 * as the validator's own rule list so the model can correct it inside the same turn.
 *
 * HISTORY, and what it costs. The world runs for hours and this conversation is paid for
 * per message, so the policy is stated rather than incidental (`RP-3`): keep the last
 * `MAX_HISTORY_MESSAGES` messages (user wishes and assistant replies, alternating), drop
 * the oldest, and log every trim with how many were dropped. Tool traffic is never replayed
 * — an accepted proposal is remembered as one line, which is what the next turn needs to
 * know. Sessions live in memory only, bounded to `MAX_SESSIONS` (the oldest-used one is
 * evicted, `A-7`); a restart clears them, and the operator's packages on disk do not.
 *
 * WHAT IT DOES NOT DO. It never fetches the provider itself (`B-2` — `LLMController` is
 * the one seam), it never writes a file (`ModPackageWriter` does, through the data seam),
 * it never applies or enables anything (`ModService` does), and it never touches the
 * shipped `core-*` content, and it never authors `world` or `worldRules` (the kinds
 * `WorldProposalValidator` refuses). It does author the map — `rooms` and `worldObjects`
 * are content like any other, checked by the rules the world enforces at boot
 * (`WorldStructureRules`, `wiki/decisions/world-structure-authoring.md`).
 * Cancellation: the seam owns the one deadline for a provider call (`E-5`,
 * `wiki/decisions/llm-transport.md`), so this controller adds no second timeout knob —
 * exactly the stance `/llm/chat` and `AgentBodyController` take.
 *
 * @module WorldAuthoringController
 */

import crypto from 'crypto';
import { performance } from 'node:perf_hooks';
import Logger from '../../utils/Logger.js';
import { GameError } from '../../utils/CustomErrors.js';
import { REGISTRY_KIND_LIST } from '../../../shared/RegistryKinds.js';
import {
    validateProposal,
    ProposalValidationError,
    AUTHORABLE_KINDS,
    NON_AUTHORABLE_KINDS,
    PROPOSAL_LIMITS
} from '../../services/WorldProposalValidator.js';
import { LLM_DEFAULT_MAX_TOKENS } from '../../utils/Constants.js';
import { OPERATION_NAMES } from '../../services/WorldOperatorService.js';
// Imported for the model name only (`OBS-3` logs which model answered); the seam owns
// that resolution — env `LLM_MODEL` over the Constants default — and this module never
// calls it. `AgentBodyController` reads the same static for the same reason.
import LLMController from './LLMController.js';

/** The RP-1 prompt kind. */
export const PROMPT_KIND = 'system-authoring';
/** The RP-2 version of that prompt. Bump on any change to `_buildSystemPrompt`. */
export const PROMPT_VERSION = '2.2.0';

/**
 * Per-call token cap. 10x the global default, the same reasoning as
 * `LLM_AGENT_BODY_MAX_TOKENS`: a reasoning model spends its budget on thinking before it
 * spends any on the answer, and a small cap truncates the turn mid-reasoning (finishReason
 * "length"). The duration cap stays the seam's (`LLM_TIMEOUT_MS`) — no second knob.
 */
export const LLM_SYSTEM_AUTHORING_MAX_TOKENS = LLM_DEFAULT_MAX_TOKENS * 10;

/** Sampling: an author reads data and writes JSON, not prose. */
export const LLM_SYSTEM_AUTHORING_TEMPERATURE = 0.4;

/**
 * Provider calls one chat turn may make. Measured, not guessed: the first live run against
 * the configured model spent six calls reading registries one at a time and never reached a
 * proposal — a cap that stops a model before it can answer is a broken feature, not a
 * saving. This is room to read a handful of registries, propose, be refused once, fix it,
 * and still answer in prose. The per-turn cost guard is the route's rate limit (`SEC-9`).
 */
export const MAX_TOOL_ITERATIONS = 12;

/** Sessions held in memory at once (`A-7`). */
export const MAX_SESSIONS = 16;

/** Messages kept per session, wishes and replies (`RP-3`). */
export const MAX_HISTORY_MESSAGES = 24;

/** One operator message. */
export const MAX_MESSAGE_CHARS = 4000;

/** What one tool result may say. Beyond this the read is truncated, with a marker. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** Keys a `read_registry` listing returns before saying `truncated`. */
export const MAX_KEYS_PER_READ = 60;

/** Hits a `find_definitions` search returns before saying `truncated`. */
export const MAX_SEARCH_HITS = 25;

/**
 * Maximum live actions one session may hold in its plan before new ones are refused.
 * The plan is per-session and outlives a single turn (it runs only when the operator
 * clicks Execute), so it needs its own bound (`A-7`) beyond `MAX_TOOL_ITERATIONS`.
 */
export const MAX_ACTIONS_PER_SESSION = 64;

/** The tool names this controller answers. Anything else is a bad call, not a feature. */
const TOOL_NAMES = Object.freeze([
    'list_registries', 'read_registry', 'find_definitions', 'propose_mod',
    'list_entities', 'inspect_entity', 'list_rooms', 'propose_action'
]);

/** Codes this module raises (the route maps them to statuses). */
export const SYSTEM_ERROR_CODES = Object.freeze({
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    PROPOSAL_NOT_SET: 'PROPOSAL_NOT_SET',
    ACTION_NOT_SET: 'ACTION_NOT_SET'
});

/**
 * No session with that id. A client that lost its id gets a new one from the next
 * `handleChat`, not a silent restart of the conversation (`E-1`: expected failure, typed).
 */
export class SessionNotFoundError extends GameError {
    /** @param {string} sessionId */
    constructor(sessionId) {
        super(`No System session with id "${sessionId}"`, SYSTEM_ERROR_CODES.SESSION_NOT_FOUND);
        this.name = 'SessionNotFoundError';
    }
}

/**
 * The operator asked to write a package, but this session holds no proposal. Expected, so
 * it is a value the route answers with 409 — not a 500 for a click that came too early.
 */
export class ProposalNotSetError extends GameError {
    /** @param {string} sessionId */
    constructor(sessionId) {
        super(`Session "${sessionId}" has no proposal to write`, SYSTEM_ERROR_CODES.PROPOSAL_NOT_SET);
        this.name = 'ProposalNotSetError';
    }
}

/**
 * The operator asked to execute a plan, but this session holds no actions. Expected, so
 * it is a value the route answers with 409 — not a 500 for a click that came too early.
 */
export class ActionsNotSetError extends GameError {
    /** @param {string} sessionId */
    constructor(sessionId) {
        super(`Session "${sessionId}" has no actions to execute`, SYSTEM_ERROR_CODES.ACTION_NOT_SET);
        this.name = 'ActionsNotSetError';
    }
}

/**
 * @typedef {Object} AuthoringTurn
 * @property {string} sessionId
 * @property {string|null} reply - the model's final text, or null when it ran out of
 *   iterations without answering (the tool log says what it read).
 * @property {Object|null} proposal - the frozen proposal this turn produced, if any
 * @property {Array<Object>} actions - the live-action plan held for this session (run by
 *   the operator via `executeActions`); empty when none are on the table.
 * @property {Array<Object>} toolLog - one entry per tool call: name, args, ok, detail,
 *   result (the bounded JSON string the model was answered with), resultChars
 * @property {Object} meta - promptKind, promptVersion, model, iterations, latencyMs,
 *   finishReason, sessionMessages, systemPrompt
 */

export class WorldAuthoringController {
    /**
     * @param {Object} deps
     * @param {import('./LLMController.js').LLMController} deps.llmController - the LLM seam (`B-2`)
     * @param {import('../../services/RegistryStore.js').RegistryStore} deps.registryStore - the live definition the tools read
     * @param {import('../../services/ModPackageWriter.js').ModPackageWriter} deps.writer - the package writer (used only by `writeProposal`)
     * @param {import('../../services/WorldOperatorService.js').WorldOperatorService} deps.operatorService - the live-operator engine for the action plan (reads + executes the world)
     * @param {typeof validateProposal} [deps.validator] - injectable for tests
     * @param {string} [deps.model] - model id for the call and the report; absent means
     *   whatever the seam is configured with (env `LLM_MODEL`)
     * @param {() => string} [deps.nowIso] - `D-1`, `D-3`: the clock is not read directly
     */
    constructor({ llmController, registryStore, writer, operatorService, validator = validateProposal, model = null, nowIso = null }) {
        if (!llmController || typeof llmController.chatFull !== 'function') {
            throw new TypeError('WorldAuthoringController: llmController (with chatFull) is required');
        }
        if (!registryStore || typeof registryStore.read !== 'function') {
            throw new TypeError('WorldAuthoringController: registryStore is required');
        }
        if (!writer || typeof writer.writePackage !== 'function') {
            throw new TypeError('WorldAuthoringController: writer (with writePackage) is required');
        }
        // `operatorService` is the live-world half of the feature; the definition-authoring
        // flow does not need it, so it may be omitted (null-tolerance, the same pattern as
        // `modService`). When present it is validated; when absent the live-action methods
        // throw `OperatorServiceNotWiredError`, and the execute/clear routes answer 500 for
        // it (a 503 is only raised for a missing *authoring* controller, via `authoringOrError`).
        // In the shipped server the operator is always wired, so this path is unreachable.
        if (operatorService && typeof operatorService.validateAction !== 'function') {
            throw new TypeError('WorldAuthoringController: operatorService must expose validateAction/executeActions');
        }
        this.llmController = llmController;
        this.registryStore = registryStore;
        this.writer = writer;
        this.operatorService = operatorService ?? null;
        this.validator = validator;
        this.model = typeof model === 'string' && model.length > 0 ? model : null;
        this.nowIso = nowIso ?? (() => new Date().toISOString());
        /** @private {Map<string, {messages: Array<Object>, proposal: Object|null, actions: Array<Object>, updatedAt: string}>} */
        this._sessions = new Map();
    }

    /**
     * The live-world half (operator service) may be absent from a deployment that built
     * the authoring controller without it. Every live path fails loudly with one message,
     * never an obscure `TypeError`, and the routes/log answer "not wired" rather than a
     * blank 500. In the shipped server this always resolves to a real service.
     * @private
     * @returns {WorldOperatorService}
     */
    _requireOperator() {
        if (!this.operatorService) {
            const error = new Error(
                'WorldAuthoringController: the operator service (live-world actions) is not wired'
            );
            error.name = 'OperatorServiceNotWiredError';
            throw error;
        }
        return this.operatorService;
    }

    // ================================================================
    // Public surface
    // ================================================================

    /**
     * One turn of the conversation: read the world through tools, answer, maybe propose.
     *
     * @param {Object} input
     * @param {string} [input.sessionId] - an existing session; a new one is minted at the
     *   edge with `crypto.randomUUID()` when absent (`D-2`)
     * @param {string} input.message - the operator's wish, narrowed by the route
     * @returns {Promise<AuthoringTurn>}
     * @throws {import('../../utils/CustomErrors.js').LLMError} from the seam
     */
    async handleChat({ sessionId = null, message = '' } = {}) {
        const session = this._sessionFor(sessionId);
        const wish = String(message ?? '').trim();

        this._appendMessage(session, 'user', wish);
        const messages = [...session.messages];
        const toolLog = [];
        let reply = null;
        let iterations = 0;
        let finishReason = null;
        let lastModel = null;
        const startedAt = performance.now();

        while (iterations < MAX_TOOL_ITERATIONS) {
            iterations++;
            const sentAt = performance.now();
            const answer = await this.llmController.chatFull(messages, {
                // No model override: the seam's default is the configured one.
                model: this.model ?? undefined,
                system: this._buildSystemPrompt(),
                tools: this._buildTools(),
                // Never "required": a forced tool call is what turns a weak model into a
                // loop (the reason `LLMAgentController` settled on "auto" — and here, with
                // no world action to take, an answer in prose is always legal anyway).
                tool_choice: 'auto',
                temperature: LLM_SYSTEM_AUTHORING_TEMPERATURE,
                max_tokens: LLM_SYSTEM_AUTHORING_MAX_TOKENS
            });
            lastModel = answer?.model ?? lastModel;
            finishReason = answer?.finishReason ?? finishReason;
            const toolCalls = Array.isArray(answer?.toolCalls) ? answer.toolCalls : [];
            Logger.info('[WorldAuthoring] provider call', {
                promptKind: PROMPT_KIND,
                promptVersion: PROMPT_VERSION,
                iteration: iterations,
                finishReason,
                toolCallCount: toolCalls.length,
                contentChars: typeof answer?.content === 'string' ? answer.content.length : 0,
                latencyMs: Math.round(performance.now() - sentAt)
            });

            if (toolCalls.length === 0) {
                reply = typeof answer?.content === 'string' ? answer.content.trim() : '';
                messages.push({ role: 'assistant', content: reply });
                break;
            }

            // The assistant turn and its answers, in the order the protocol requires
            // (`LLMController._validateMessages`: assistant with tool_calls, then one
            // `tool` message per call id).
            messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
            for (const call of toolCalls) {
                const outcome = this._runTool(call, session, toolLog, MAX_TOOL_ITERATIONS - iterations);
                messages.push({ role: 'tool', tool_call_id: call.id ?? '', content: outcome.payload });
            }
        }

        const stoppedAtToolCap = reply === null;
        if (stoppedAtToolCap) {
            // The cap was reached with the model still working. Say so rather than
            // inventing a summary — an empty answer with the tool log is honest.
            Logger.warn(
                `[WorldAuthoring] turn stopped at the ${MAX_TOOL_ITERATIONS}-call cap `
                + `without an answer; ${toolLog.length} tool call(s) ran`
            );
        }

        // The model's answer, or an honest note that it stopped at the tool cap.
        this._appendMessage(session, 'assistant',
            reply ?? '(stopped after the tool-call limit without an answer.)');
        // One-line context markers for the next turn: what is already on the table.
        if (session.proposal) {
            session.messages.push({
                role: 'assistant',
                content: `[proposal on the table: ${session.proposal.packageId}, ${session.proposal.stats.kinds} kind(s), ${session.proposal.stats.definitions} definition(s), ${session.proposal.overrides.length} overriding]`
            });
        }
        if (session.actions.length > 0) {
            session.messages.push({
                role: 'assistant',
                content: `[actions on the table: ${session.actions.length}. The operator may Execute them (POST /system/execute — they mutate the world now) or Clear the plan. Tell the operator what each does.]`
            });
        }
        this._trim(session);
        session.updatedAt = this.nowIso();

        return Object.freeze({
            sessionId: session.id,
            reply,
            proposal: session.proposal,
            actions: Object.freeze(session.actions.map((action) => Object.freeze(action))),
            toolLog: Object.freeze(toolLog),
            meta: Object.freeze({
                promptKind: PROMPT_KIND,
                promptVersion: PROMPT_VERSION,
                model: lastModel ?? LLMController.DEFAULT_MODEL,
                iterations,
                finishReason,
                latencyMs: Math.round(performance.now() - startedAt),
                sessionMessages: session.messages.length,
                // The operator's client needs to know the difference between "the model had
                // nothing to say" and "the model ran out of budget".
                stoppedAtToolCap,
                // The prompt is the product of a judgment feature: the operator tunes it
                // from here (the same reason `agent-body-design` returns its prompt).
                systemPrompt: this._buildSystemPrompt()
            })
        });
    }

    /**
     * What the session holds: the conversation and the proposal on the table, if any.
     * @param {string} sessionId
     * @returns {{ sessionId: string, messages: Array<Object>, proposal: Object|null, updatedAt: string }}
     * @throws {SessionNotFoundError}
     */
    getHistory(sessionId) {
        const session = this._sessions.get(String(sessionId ?? ''));
        if (!session) throw new SessionNotFoundError(String(sessionId ?? ''));
        return Object.freeze({
            sessionId: session.id,
            messages: Object.freeze(session.messages.map((entry) => Object.freeze({ ...entry }))),
            proposal: session.proposal,
            actions: Object.freeze(session.actions.map((action) => Object.freeze(action))),
            updatedAt: session.updatedAt
        });
    }

    /**
     * What is on the table: the live plan (empty when none) and the proposal, if any.
     * A cheap, read-only read so the client can render its Execute/Clear buttons without
     * a write call (`GET /system/status`): the plan is per-session and outlives the turn
     * that proposed it, so a reloaded tab reads it back here as well as from the chat
     * response.
     * @param {string} sessionId
     * @returns {{ sessionId: string, actions: Array<Object>, proposal: Object|null, updatedAt: string }}
     * @throws {SessionNotFoundError}
     */
    getPlanStatus(sessionId) {
        const session = this._sessions.get(String(sessionId ?? ''));
        if (!session) throw new SessionNotFoundError(String(sessionId ?? ''));
        return Object.freeze({
            sessionId: session.id,
            actions: Object.freeze(session.actions.map((action) => Object.freeze(action))),
            proposal: session.proposal,
            updatedAt: session.updatedAt
        });
    }

    /**
     * The operator's discard (`POST /system/clear`): erase the session's plan without
     * executing anything. A discard never touches the world — nothing on the table has
     * been applied — and an empty plan is a harmless no-op (answered `cleared: false`
     * instead of a 409; the operator may click the button out of habit).
     * @param {string} sessionId
     * @returns {{ sessionId: string, cleared: boolean }} - `cleared` is true when at
     *   least one action left the table; false when the plan was already empty.
     * @throws {SessionNotFoundError}
     */
    clearPlan(sessionId) {
        const session = this._sessions.get(String(sessionId ?? ''));
        if (!session) throw new SessionNotFoundError(String(sessionId ?? ''));
        const cleared = session.actions.length > 0;
        session.actions = [];
        session.updatedAt = this.nowIso();
        return Object.freeze({ sessionId: session.id, cleared });
    }

    /**
     * The operator's click: turn this session's proposal into a package on disk.
     *
     * Re-validated, never trusted from the earlier answer (`T-1`): the live definition may
     * have moved (an apply, another operator's edit), and an override that was not there
     * when the model proposed must be reported now. The write is what it says — a package
     * in `data/mods/`, not a changed world. The caller (`systemRoutes`) rescans the package
     * directory and answers where it applies.
     *
     * @param {string} sessionId
     * @returns {Promise<Object>} the `ModPackageWriter` report, plus the proposal summary
     * @throws {SessionNotFoundError} | {ProposalNotSetError} | {ProposalValidationError}
     */
    async writeProposal(sessionId) {
        const session = this._sessions.get(String(sessionId ?? ''));
        if (!session) throw new SessionNotFoundError(String(sessionId ?? ''));
        if (!session.proposal) throw new ProposalNotSetError(session.id);

        const proposal = this.validator(session.proposal, { registryStore: this.registryStore });
        const report = await Promise.resolve(this.writer.writePackage({
            id: proposal.packageId,
            version: proposal.version,
            description: proposal.description,
            content: proposal.content
        }));

        // Remember it happened, in the conversation: the next wish is usually a refinement
        // of what was just written, and the model should know the package already exists.
        this._appendMessage(session, 'assistant', `[written: ${report.packageId} (${report.dir}) — ${report.content.join(', ')}; not applied yet]`);
        this._trim(session);
        session.updatedAt = this.nowIso();

        return Object.freeze({
            ...report,
            rationale: proposal.rationale,
            added: proposal.added,
            overrides: proposal.overrides
        });
    }

    /**
     * The operator's click to run the session's plan of live actions.
     *
     * Re-validates each action against the *current* world (`T-1`) — the world may have
     * moved between the propose (a chat turn) and the click. Executes in order; a failing
     * action is reported and the rest still runs. Clears the plan and records what
     * landed so the next turn knows. The mutation is immediate (unlike `writeProposal`,
     * which defers to the round boundary).
     *
     * @param {string} sessionId
     * @returns {{ executed: number, results: Array<{operation, summary, status, error?, result?}> }}
     * @throws {SessionNotFoundError} | {ActionsNotSetError}
     */
    executeActions(sessionId) {
        const session = this._sessions.get(String(sessionId ?? ''));
        if (!session) throw new SessionNotFoundError(String(sessionId ?? ''));
        if (session.actions.length === 0) throw new ActionsNotSetError(session.id);
        const operator = this._requireOperator();
        const report = operator.executeActions(session.actions);
        session.actions = [];

        // Remember it in the conversation: the next wish is usually a refinement of what
        // was just done, and the model should know which actions landed.
        this._appendMessage(session, 'assistant',
            `[executed ${report.executed} action(s): `
            + report.results.map((r) => `${r.status} (${r.summary ?? r.operation ?? 'no summary'})`).join('; ') + ']');
        this._trim(session);
        session.updatedAt = this.nowIso();

        return Object.freeze({
            executed: report.executed,
            results: Object.freeze(report.results.map((result) => Object.freeze(result)))
        });
    }

    /** How many sessions this process is holding. Read by the tests, and by nobody else. */
    sessionCount() {
        return this._sessions.size;
    }

    // ================================================================
    // Sessions
    // ================================================================

    /**
     * The session for `sessionId`, or a new one. The id is minted here because this is
     * the edge (`D-2`); a client that sends a non-existent id gets a fresh session rather
     * than an error, because a reloaded tab cannot know whether the server survived.
     * @private
     * @param {string|null} sessionId
     * @returns {{ id: string, messages: Array<Object>, proposal: Object|null, updatedAt: string }}
     */
    _sessionFor(sessionId) {
        const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : crypto.randomUUID();
        const existing = this._sessions.get(id);
        if (existing) {
            this._sessions.delete(id);
            this._sessions.set(id, existing);
            return existing;
        }
        const session = { id, messages: [], proposal: null, actions: [], updatedAt: this.nowIso() };
        this._sessions.set(id, session);
        // Oldest-used eviction, and a log line when it costs somebody their conversation.
        // `.keys()` and not `const [id] = this._sessions`: destructuring a Map yields its
        // first ENTRY (a `[key, value]` array), and `delete(array)` deletes nothing — an
        // eviction loop that never evicts is an out-of-memory loop (`A-7`, and the test
        // that found this one).
        while (this._sessions.size > MAX_SESSIONS) {
            const evictedId = this._sessions.keys().next().value;
            if (evictedId === undefined) break;
            this._sessions.delete(evictedId);
            Logger.warn(`[WorldAuthoring] session "${evictedId}" evicted (${MAX_SESSIONS} in memory)`);
        }
        return session;
    }

    /**
     * Append one message to the session history (`RP-3`: wishes and replies only).
     * @private
     * @param {Object} session
     * @param {'user'|'assistant'} role
     * @param {string} content
     */
    _appendMessage(session, role, content) {
        session.messages.push({ role, content });
    }

    /**
     * Keep the history inside `MAX_HISTORY_MESSAGES` by dropping the oldest.
     *
     * The policy is the boring one and it is stated in the log: keep system (rebuilt every
     * call, never stored), keep the newest messages, drop the oldest. The persona is never
     * silently dropped — there is no persona here, only the wish/reply alternation.
     * @private
     * @param {Object} session
     */
    _trim(session) {
        const dropped = session.messages.length - MAX_HISTORY_MESSAGES;
        if (dropped <= 0) return;
        session.messages.splice(0, dropped);
        Logger.info(`[WorldAuthoring] history trimmed for session "${session.id}": dropped ${dropped} oldest message(s)`);
    }

    // ================================================================
    // Tools
    // ================================================================

    /**
     * The tool set: three reads of the live definition and one terminal `propose_mod`.
     * Deliberately small (`B-6`) — the model that needs twenty tools is a design that has
     * not found its four yet.
     * @private
     * @returns {Array<Object>} OpenAI-compatible tool definitions
     */
    _buildTools() {
        const kindEnum = REGISTRY_KIND_LIST;
        return [
            {
                type: 'function',
                function: {
                    name: 'list_registries',
                    description: 'List every registry of the world definition with how many definitions it holds and whether this System may author into it. Call this before reading anything, so you read what matters.',
                    parameters: { type: 'object', properties: {}, required: [] }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'read_registry',
                    description: 'Read one registry. Without "key" it answers with the keys it holds; with "key" it answers with that one definition, exactly as the world reads it. Never cite an id you have not seen here.',
                    parameters: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: kindEnum, description: 'The registry kind to read.' },
                            key: { type: 'string', description: 'Optional: one definition key to fetch in full.' }
                        },
                        required: ['kind']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'find_definitions',
                    description: 'Search definition keys and values for a text fragment (case-insensitive substring), optionally within one kind. Answers with kind/key/name matches, not whole definitions.',
                    parameters: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: 'The fragment to look for.' },
                            kind: { type: 'string', enum: kindEnum, description: 'Optional: limit the search to one kind.' }
                        },
                        required: ['text']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'propose_mod',
                    description: 'Put a data-only mod package on the table. This is the only way to change the world from here, and it writes nothing: the operator reads the proposal and decides. A proposal that breaks a rule comes back with that rule list — fix it and propose again.',
                    parameters: {
                        type: 'object',
                        properties: {
                            packageId: {
                                type: 'string',
                                description: `A short lowercase slug (letters, digits, dash). The server owns the identity: it becomes "${PROPOSAL_LIMITS.PACKAGE_ID_PREFIX}<slug>".`
                            },
                            description: { type: 'string', description: 'One sentence for the manifest: what this package adds.' },
                            rationale: { type: 'string', description: 'Why this content answers what the operator asked, in the operator\'s terms.' },
                            content: {
                                type: 'object',
                                description: 'Registry kind -> { key: definition }. Only authorable kinds; ' + NON_AUTHORABLE_KINDS.join(', ') + ' are refused. For "rooms": the shape the rooms registry already uses, and a new key — an existing room is never rewritten by an apply. For "worldObjects": { name, blueprint, room, position }.',
                                additionalProperties: { type: 'object' }
                            }
                        },
                        required: ['packageId', 'description', 'content']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'list_entities',
                    description: 'List every LIVE entity in the world (not a definition): id, name, blueprint, room. Use it to find the entity you want to act on, then inspect_entity it.',
                    parameters: { type: 'object', properties: {}, required: [] }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'inspect_entity',
                    description: 'Read one LIVE entity: its components (with current stats, including Physical.existence), its organs, its items, and its room. This is how you target "this entity\'s Physical.existence". Call it after list_entities, before propose_action.',
                    parameters: {
                        type: 'object',
                        properties: {
                            entityId: { type: 'string', description: 'The entity id to read (from list_entities).' }
                        },
                        required: ['entityId']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'list_rooms',
                    description: 'List every LIVE room (id, name, width, height). Use it to name a valid target room for move_entity or place_machine.',
                    parameters: { type: 'object', properties: {}, required: [] }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'propose_action',
                    description: 'Propose a LIVE action for the operator to execute (POST /system/execute). Name an `operation` and free-form `params`; the server resolves ids and checks them against the running world. It writes nothing and executes nothing — the operator runs the whole plan with Execute. Rejections come back as a rule list; fix them and propose again. Available operations: ' + OPERATION_NAMES.join(', ') + '.',
                    parameters: {
                        type: 'object',
                        properties: {
                            operation: { type: 'string', enum: OPERATION_NAMES, description: 'Which live operation to request.' },
                            params: { type: 'object', description: 'The operation\'s free-form parameters. Their shape depends on the operation; the server validates them, so name the values precisely.' }
                        },
                        required: ['operation', 'params']
                    }
                }
            }
        ];
    }

    /**
     * Execute one tool call, record it in the log, and produce its `tool` message.
     *
     * Every failure is an ANSWER, not a throw: a model that gets "no such kind" as data
     * corrects itself, and one that gets a 500 does not exist in this conversation (`E-1`).
     * @private
     * @param {Object} call - `{ id, function: { name, arguments } }`
     * @param {Object} session
     * @param {Array<Object>} toolLog
     * @param {number} callsRemaining - provider calls left in this turn (told to the model:
     *   a budget it cannot see is a budget it will waste — the live run read every registry
     *   and never proposed)
     * @returns {{ payload: string, ok: boolean, detail: string }}
     */
    _runTool(call, session, toolLog, callsRemaining = 0) {
        const name = call?.function?.name ?? '';
        const args = this._parseArgs(call?.function?.arguments);

        if (!TOOL_NAMES.includes(name)) {
            return this._recordTool(toolLog, { name, args, ok: false, detail: 'unknown tool' },
                { error: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}.` }, callsRemaining);
        }

        try {
            if (name === 'list_registries') return this._recordTool(toolLog, { name, args, ok: true }, this._toolListRegistries(), callsRemaining);
            if (name === 'read_registry') return this._recordTool(toolLog, { name, args, ok: true }, this._toolReadRegistry(args), callsRemaining);
            if (name === 'find_definitions') return this._recordTool(toolLog, { name, args, ok: true }, this._toolFindDefinitions(args), callsRemaining);
            if (name === 'list_entities') return this._recordTool(toolLog, { name, args, ok: true }, this._toolListEntities(), callsRemaining);
            if (name === 'inspect_entity') return this._recordTool(toolLog, { name, args, ok: true }, this._toolInspectEntity(args), callsRemaining);
            if (name === 'list_rooms') return this._recordTool(toolLog, { name, args, ok: true }, this._toolListRooms(), callsRemaining);
            if (name === 'propose_action') {
                // An action is on the table only once the operator clicks Execute; the
                // refusal is the rule list, so the model corrects it inside this turn.
                const actionResult = this._toolProposeAction(args, session);
                const actionRejected = actionResult?.ok === false;
                return this._recordTool(toolLog, {
                    name,
                    args,
                    ok: !actionRejected,
                    detail: actionRejected ? (actionResult.errors ?? []).join('; ') : ''
                }, actionResult, callsRemaining);
            }
            // `propose_mod` answering is not the proposal being accepted: a refusal is a
            // result, and the operator's tool log must read "refused: <rules>", not "ok".
            const result = this._toolProposeMod(args, session);
            const rejected = result?.ok === false;
            return this._recordTool(toolLog, {
                name,
                args,
                ok: !rejected,
                detail: rejected ? (result.errors ?? []).join('; ') : ''
            }, result, callsRemaining);
        } catch (error) {
            const detail = error?.message ?? String(error);
            return this._recordTool(toolLog, { name, args, ok: false, detail }, { error: detail }, callsRemaining);
        }
    }

    /**
     * Serialise one tool result (bounded, `SEC-2`) and append the log entry. The remaining
     * call budget travels with every answer, because the model is the one that has to spend
     * it.
     * @private
     */
    _recordTool(toolLog, entry, result, callsRemaining = 0) {
        const body = (result && typeof result === 'object' && !Array.isArray(result))
            ? { ...result, callsRemaining }
            : { result, callsRemaining };
        let payload = JSON.stringify(body);
        if (payload.length > MAX_TOOL_RESULT_CHARS) {
            payload = JSON.stringify({
                truncated: true,
                limitChars: MAX_TOOL_RESULT_CHARS,
                note: 'The result is larger than one tool answer may be. Ask for less (a key, one kind, a narrower search).',
                head: payload.slice(0, MAX_TOOL_RESULT_CHARS - 200)
            });
        }
        // `result` is the exact bounded string the model was answered with - one copy,
        // both ways (the wire tool message and the operator's log). The client renders it;
        // the `SEC-2` cap already holds the size down.
        toolLog.push({ ...entry, resultChars: payload.length, result: payload });
        return { payload, ok: entry.ok, detail: entry.detail ?? '' };
    }

    /**
     * `tool_calls[].function.arguments` is a JSON string by contract; a model that sends
     * a broken one gets the parse error back as data (`T-1`), never a crash of the turn.
     * @private
     * @param {unknown} raw
     * @returns {Object}
     */
    _parseArgs(raw) {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
        if (typeof raw !== 'string' || raw.trim().length === 0) return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            return { __parseError: error?.message ?? 'arguments are not valid JSON' };
        }
    }

    /** @private */
    _toolListRegistries() {
        const registries = REGISTRY_KIND_LIST.map((kind) => ({
            kind,
            definitions: this._keysOf(kind).length,
            authorable: AUTHORABLE_KINDS.includes(kind)
        }));
        return { registries, authorableKinds: [...AUTHORABLE_KINDS], refusedKinds: [...NON_AUTHORABLE_KINDS] };
    }

    /** @private */
    _toolReadRegistry(args) {
        if (args.__parseError) throw new Error(args.__parseError);
        const kind = typeof args.kind === 'string' ? args.kind : '';
        if (!REGISTRY_KIND_LIST.includes(kind)) {
            throw new Error(`"${kind}" is not a registry kind. Call list_registries for the vocabulary.`);
        }
        const content = this._registry(kind);
        const keys = Object.keys(content);
        if (typeof args.key === 'string' && args.key.length > 0) {
            if (!Object.prototype.hasOwnProperty.call(content, args.key)) {
                throw new Error(`No "${args.key}" in registry "${kind}". Read the keys first.`);
            }
            return { kind, key: args.key, definition: content[args.key] };
        }
        const shown = keys.slice(0, MAX_KEYS_PER_READ);
        const sampleKey = keys.find((key) => Object.prototype.hasOwnProperty.call(content, key));
        return {
            kind,
            total: keys.length,
            keys: shown,
            truncated: keys.length > shown.length,
            // One real definition rides along with the key list. The live run showed why:
            // a model that sees only names spends a second call per kind to learn the shape,
            // and the call budget is the scarce thing here.
            sample: sampleKey ? { key: sampleKey, definition: content[sampleKey] } : null
        };
    }

    /** @private */
    _toolFindDefinitions(args) {
        if (args.__parseError) throw new Error(args.__parseError);
        const text = typeof args.text === 'string' ? args.text.trim().toLowerCase() : '';
        if (text.length < 2) throw new Error('"text" needs at least 2 characters.');
        const scope = typeof args.kind === 'string' && args.kind.length > 0 ? [args.kind] : REGISTRY_KIND_LIST;
        const hits = [];
        for (const kind of scope) {
            const content = this._registry(kind);
            for (const [key, value] of Object.entries(content)) {
                const hay = `${key} ${JSON.stringify(value) ?? ''}`.toLowerCase();
                if (!hay.includes(text)) continue;
                hits.push({ kind, key, name: this._labelOf(value) });
                if (hits.length >= MAX_SEARCH_HITS) {
                    return { query: text, hits, truncated: true };
                }
            }
        }
        return { query: text, hits, truncated: false };
    }

    /**
     * Validate the proposal and, if it stands, put it on the table for the operator.
     * A rejection is the rule list — the model reads it and proposes again in this turn.
     * @private
     * @param {Object} args
     * @param {Object} session
     * @returns {Object} tool result
     */
    _toolProposeMod(args, session) {
        if (args.__parseError) throw new Error(args.__parseError);
        try {
            const proposal = this.validator(
                {
                    packageId: args.packageId,
                    description: args.description,
                    rationale: args.rationale,
                    content: args.content
                },
                { registryStore: this.registryStore }
            );
            session.proposal = proposal;
            return {
                ok: true,
                proposal: {
                    packageId: proposal.packageId,
                    kinds: Object.keys(proposal.content),
                    definitions: proposal.stats.definitions,
                    added: proposal.added,
                    overrides: proposal.overrides
                },
                note: 'The proposal is on the table. Nothing is written until the operator clicks Write. Tell the operator what you proposed and what it overrides.'
            };
        } catch (error) {
            if (error instanceof ProposalValidationError) {
                return { ok: false, errors: error.errors, note: 'Fix these and call propose_mod again.' };
            }
            throw error;
        }
    }

    /** @private */
    _toolListEntities() {
        const operator = this._requireOperator();
        return { live: true, ...operator.listEntities() };
    }

    /** @private */
    _toolInspectEntity(args) {
        if (args.__parseError) throw new Error(args.__parseError);
        const entityId = typeof args.entityId === 'string' ? args.entityId.trim() : '';
        if (entityId.length === 0) throw new Error('"entityId" is required.');
        const operator = this._requireOperator();
        const entity = operator.inspectEntity(entityId);
        if (!entity) {
            throw new Error(`No entity "${entityId}". Call list_entities for the live world.`);
        }
        return { live: true, entity };
    }

    /** @private */
    _toolListRooms() {
        const operator = this._requireOperator();
        return { live: true, ...operator.listRooms() };
    }

    /**
     * Propose one live action. The model names an operation and free-form params; the
     * operator service validates them against the *live* world and, if they stand, puts
     * the action on the session's plan. Nothing is executed by the proposal — the operator
     * runs the whole plan with Execute (POST /system/execute). A rejection answers with the
     * rule list; fix it and propose again.
     * @private
     * @param {Object} args
     * @param {Object} session
     * @returns {Object} tool result
     */
    _toolProposeAction(args, session) {
        if (args.__parseError) throw new Error(args.__parseError);
        const operation = typeof args.operation === 'string' ? args.operation.trim() : '';
        const operator = this._requireOperator();
        const validation = operator.validateAction(operation, args.params ?? null);
        if (!validation.ok) {
            return {
                ok: false,
                errors: validation.errors,
                note: 'Fix these and call propose_action again.'
            };
        }
        if (session.actions.length >= MAX_ACTIONS_PER_SESSION) {
            return {
                ok: false,
                errors: [`The plan already holds ${session.actions.length} actions (cap ${MAX_ACTIONS_PER_SESSION}). Tell the operator to Execute (run) or Clear the plan before proposing more.`]
            };
        }
        const action = { id: crypto.randomUUID(), ...validation.intent };
        session.actions.push(action);
        return {
            ok: true,
            action: { operation: action.operation, summary: action.summary },
            note: 'The action is on the table. Nothing is executed yet: the operator runs the plan via Execute (POST /system/execute). Tell the operator what you added.'
        };
    }

    // ================================================================
    // Reading the live definition (through the store, never through disk)
    // ================================================================

    /** @private */
    _registry(kind) {
        if (!this.registryStore.has(kind)) return {};
        const content = this.registryStore.read(kind);
        return content && typeof content === 'object' && !Array.isArray(content) ? content : {};
    }

    /** @private */
    _keysOf(kind) {
        return Object.keys(this._registry(kind));
    }

    /**
     * The human label of a definition, when it has one — a search hit that says only the
     * key is half an answer.
     * @private
     * @param {unknown} value
     * @returns {string|null}
     */
    _labelOf(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const label = value.name ?? value.description ?? null;
        return typeof label === 'string' ? label.slice(0, 120) : null;
    }

    // ================================================================
    // The prompt (kind `system-authoring`, version PROMPT_VERSION — RP-1, RP-2)
    // ================================================================

    /**
     * System message: who is speaking, what it may author, how to work, and what it must
     * never assume. The vocabulary is NOT inlined — the tools are how it gets read (`B-6`,
     * `RP-3`), and a model that reads answers with ids that exist.
     * @private
     * @returns {string}
     */
    _buildSystemPrompt() {
        return [
            `You are the System (${PROMPT_KIND} v${PROMPT_VERSION}) of a persistent, data-driven world simulation. You have two levers: (a) author a data-only mod package (persistent definitions, applied at the next round boundary), and (b) propose a LIVE plan of actions that mutates the running world when the operator clicks Execute (POST /system/execute).`,
            'The operator tells you what they want. For each ask, decide whether it is a DEFINITION change (author a package) or a RUNTIME change (propose live actions), or both, and say in your answer which lever you used.',
            '',
            `AUTHOR definitions (persist; applied at the round boundary). Read the live definition with list_registries / read_registry / find_definitions, then propose_mod. You never write code and never edit the shipped core-* packages. Kinds refused: ${NON_AUTHORABLE_KINDS.join(', ')} — the shape the world is wrapped in, and the rules that install listeners; neither is content and both stay a hand edit. Authorable kinds: ${AUTHORABLE_KINDS.join(', ')}. This changes what the world is built from, not the running world.`,
            `AUTHOR THE MAP. "rooms" and "worldObjects" are authorable. A room is additive: applied, a room that does not exist yet joins the running map, and a room that exists is NEVER moved, renamed, resized or re-linked by an apply (its id is where the actors stand) — so author new rooms, do not rewrite existing ones; connect a new room with a connection to a room you have read, or it is unreachable. A world object is { name, blueprint, room, position {x,y} }: the blueprint must be one you read, the room is a room key of the rooms registry, and props appear when the world is created (they are population, so a running world takes them at the next world create; place one now with the live lever instead).`,
            `ACT on the running world (immediate). See the live state with list_entities / inspect_entity / list_rooms (rooms answer with BOTH the live id and the registry key, plus their door names), then propose_action to put an action on the table. The operator runs the plan with Execute; each action is re-validated and executed in order against the current world. A proposal changes nothing by itself. The live menu includes the map: create_room adds a room and opens a door to an existing one (mandatory, so nothing is stranded) — that ONE door is the whole connection, leave definition.connections empty, because a live create_room installs no door from it (a rooms package is what opens a declared door); spawn_world_object places a prop now.`,
            'EFFECTS ARE TWO STEPS, IN THAT ORDER - a TYPE, then an APPLICATION of it. An effect exists twice and both are needed.\n'
            + 'As a TYPE it is a definition in the "effects" registry: a target ("entity" or "component"), durationRounds (0 = until removed) and operations, each naming an id from the closed set (statSet, statDelta, addCondition, removeCondition, grantFlag, damageComponent, damageRandomComponents, dropMaterialChunk, moveBy, moveTo, traverseDoor, log, emitEvent) with LITERAL params. Read one with read_registry kind "effects" and copy its shape.\n'
            + 'As an APPLICATION it is a live instance of that type on one entity, with a remaining-rounds clock that reverts its own contribution when it ends.\n'
            + 'apply_effect does NOT create a type: it names one. An effectId the world does not have is refused with EFFECT_UNKNOWN, and the answer lists the ids that do exist. Never call apply_effect with a type you invented.\n'
            + 'STEP 1 - CREATE THE TYPE, IN THE WORLD. Either register_effect, which defines it in the RUNNING world (memory only: gone at a restart, and every entity carrying it stops); or propose_mod with kind "effects", which authors it durably (the operator Write click, then an apply).\n'
            + 'STEP 2 - APPLY IT TO THE ENTITY, once the type exists. apply_effect with that effectId plus the entityId (add componentId to hit one part instead of the whole body), and optional rounds to override the declared duration.\n'
            + 'THESE ARE TWO CALLS, NOT ONE PLAN. Every proposed action is checked against the definitions that exist WHEN IT IS PROPOSED, so apply_effect cannot be accepted in the same plan as the register_effect that creates its type - it would be checked against a world where that type is not there yet. The order that works: propose register_effect and have the operator Execute it; the type now exists; propose apply_effect naming it, and have the operator Execute that. Say exactly that in your answer, in that order, and name the next click.\n'
            + 'So an ask like "make entity X corrode forever" is: register_effect { effectId: "ownCorroding", definition: { target: "entity", durationRounds: 0, perRound: [ { op: "damageRandomComponents", params: { channel: "corrosion", value: 1, count: 1 } } ] } } -> Execute -> apply_effect { effectId: "ownCorroding", entityId: "ent-..." } -> Execute. Then list_effects on that entity reads back what is really running, and remove_effect takes it off.',
            '',
            'HOW YOU WORK.',
            `You have ${MAX_TOOL_ITERATIONS} provider calls this turn, and every tool answer says how many are left.`,
            'Spend them well: a couple of reads is plenty. A registry listing already carries one real definition as `sample` (for authoring); inspect_entity carries the live stats an action needs (e.g. Physical.existence).',
            '1. Read before you act. For authoring, read the definition; for an action, inspect the live entity and its components. Never cite an id or stat name you have not seen.',
            '2. Reuse what exists. Author over the existing vocabulary; for actions, target entities and components the operator actually has.',
            '3. Propose EARLY — propose_mod for definitions, propose_action for live changes. A refusal answers with its rule list; fix it and call the same tool again, still in this turn.',
            '4. Then answer in plain prose: what you did and which button the operator must click next (Write for a package, Execute for actions). The operator reads that before any click.',
            '',
            'AUTHORING DATA CONTRACT.',
            '- content is { registryKind: { key: definition } }; the key is the identifier the world reads.',
            '- Follow the shape of the definitions you read; copy it from what is already there, do not invent a schema.',
            '- Redefining a key that exists is legal (a package shadows the official one) but must be deliberate; say so.',
            '- Keep it small: the shortest content that does the job. Caps exist; a big proposal is refused.',
            '',
            'LIVE-ACTION CONTRACT.',
            '- An action is an operation (a fixed menu, see the propose_action tool) plus free-form params; the server resolves ids and checks them against the live world and live definitions. Never invent ids or stat names you have not seen via inspect_entity or read_registry.',
            '- A plan is per-session and outlives this turn. The operator runs it (Execute) or discards it (Clear). Never claim an action has run — the operator must click Execute. After Execute each action answers with a result; if one fails, report it and propose a fix.',
            '- Setting Physical.existence to 0 leaves a component gone in place (its matter vanishes, dependents cascade). remove_component also spills, cascades, cleans up and may eliminate the entity. Choose the one the operator asked for.',
            '- A machine is carried as an item. place_machine materialises it in the world (consumes the item); retrieve_machine brings a placed machine back into the holder.',
            '- Live map changes are MEMORY ONLY. create_room and spawn_world_object change the world that is running, not the files it restarts from: after a restart the map comes back from the packages. When the operator wants a room to stay, author the same room with propose_mod (kind "rooms") as well, and say which of the two you did.',
            '- A register_effect type is MEMORY ONLY for the same reason: a restart rebuilds effects from the packages, and every entity that was carrying it stops. When the operator wants the effect type to stay, author the same definition with propose_mod (kind "effects") too, and say which of the two you did.',
            '',
            'WHAT YOU DO NOT DO.',
            '- You do not apply or enable anything. A proposal becomes a package only by the operator Write click, and the world takes it at the next round boundary.',
            '- You do not run actions. A live action executes only when the operator clicks Execute; you propose, the operator runs.',
            '- Your only levers are propose_mod (definitions) and propose_action (the live plan). Nothing else changes the world.',
            '- The world rules (`worldRules`) and the shape the world is wrapped in (`world`) are not yours. Say plainly that those stay a hand edit, and say what a content-level alternative would be.',
            '- If the wish is impossible with the live tools or with data, say so. No silent approximations.',
            '',
        ].join('\n');
    }
}

export default WorldAuthoringController;

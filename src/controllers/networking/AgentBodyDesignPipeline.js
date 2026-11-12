/**
 * AgentBodyDesignPipeline — the four-stage body design behind
 * `POST /agent-body/create` (the "Create Agent Body" dev tab, Feature A).
 *
 * The design is a PIPELINE, not one prompt: each stage is one LLM call in a
 * FRESH context whose input is the previous stage's VALIDATED output.
 *
 *   1. concept  (agent-body-concept)  who the card is, distilled: rationale + focus
 *   2. anatomy  (agent-body-anatomy)  the body tree + invented part recipes
 *   3. organs   (agent-body-organs)   the NEW organs, each attached to an invented part
 *   4. outfit   (agent-body-outfit)   the garments + what the body is born wearing
 *
 * The stages exist because a single prompt asked for all of it (prompt
 * v1.6.0 carried the whole anatomy spec, the organ law, the clothing law and
 * the final checklist in one message) is where a precision model starts
 * dropping rules: each stage carries only the law of its own field, and the
 * vocabulary it needs. One failed stage costs one retry of that stage, not
 * a second shot at the whole design.
 *
 * RETRY DISCIPLINE (CODE_RULES E-6, named not ad-hoc): a stage gets
 * `maxAttempts` attempts (default 3). A VALIDATION failure is a corrective
 * retry: the violated rules ride into the next attempt's prompt (the prompt
 * changed, so no backoff). A TRANSPORT failure (the LLM seam's LLMError) is
 * retried with exponential backoff + jitter only when the error class is
 * transient (timeout, request error, parse error, HTTP 429/5xx - classified
 * on `err.code`/`err.status`, never on the message); a 4xx answer is the
 * provider refusing the request, and repeating it changes nothing.
 *
 * Each stage output is validated by the SAME shared rules the controller's
 * monolithic `_validateDesign` composes (`AgentBodyDesignRules`), so the
 * stage law and the save law cannot drift; the controller still re-runs the
 * monolithic validation on the COMPOSED body as a final safety net.
 *
 * The pipeline is a pure decision module (B-1): it never touches sockets -
 * the progress events it reports (one per attempt: started / retrying /
 * succeeded / failed) are handed to an injected `reporter`, and the server
 * wires that reporter to the `AGENT_BODY_DESIGN_STEP` socket event. The LLM
 * goes through the injected seam (B-2); the world vocabulary comes in as a
 * parameter (B-3).
 *
 * @module src/controllers/networking/AgentBodyDesignPipeline
 */

import LLMController from './LLMController.js';
import { LLM_DEFAULT_MAX_TOKENS, LLM_DEFAULT_TEMPERATURE } from '../../utils/Constants.js';
import { LLMError } from '../../utils/CustomErrors.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
    extractDesignJson,
    walkStructure,
    validateOrganDefinition,
    validateComponentRecipe,
    validateGarments,
    validateOutfit,
    normalizeDesign,
    MAX_BODY_NODES,
    MAX_IC_RECIPES,
    MAX_GARMENTS,
    MAX_OUTFIT_ENTRIES,
    MAX_IC_LABEL_CHARS,
    MAX_GARMENT_LABEL_CHARS,
    MAX_RATIONALE_CHARS,
    MAX_FOCUS_PHRASES,
    MAX_FOCUS_PHRASE_CHARS,
    GRANTABLE_STAT_KEYS,
    GRANTABLE_FLAGS
} from './AgentBodyDesignRules.js';

// ---------------------------------------------------------------------------
// Stage registry (RP-1/RP-2: each kind is a named, versioned decision).
// ---------------------------------------------------------------------------

/** The stages in order. The anatomy's parts are what the organs attach to;
 *  the body is what the outfit dresses; the concept seeds every stage. */
export const STAGE_ORDER = Object.freeze(['concept', 'anatomy', 'organs', 'outfit']);

export const STAGE_PROMPT_KIND = Object.freeze({
    concept: 'agent-body-concept',
    anatomy: 'agent-body-anatomy',
    organs: 'agent-body-organs',
    outfit: 'agent-body-outfit'
});

export const STAGE_PROMPT_VERSION = Object.freeze({
    concept: '1.0.0',
    anatomy: '1.0.0',
    organs: '1.0.0',
    outfit: '1.0.0'
});

/**
 * Per-stage token budgets, named multipliers of the global
 * LLM_DEFAULT_MAX_TOKENS (2048). The precision reasoning model counts its
 * thinking tokens against the cap; anatomy is the heavy stage (it carries
 * the full world vocabulary plus the anatomy spec, so it keeps the 10x
 * budget the single design prompt used), the rest are sized to their output.
 */
export const LLM_STAGE_MAX_TOKENS = Object.freeze({
    concept: LLM_DEFAULT_MAX_TOKENS * 2,
    anatomy: LLM_DEFAULT_MAX_TOKENS * 10,
    organs: LLM_DEFAULT_MAX_TOKENS * 4,
    outfit: LLM_DEFAULT_MAX_TOKENS * 6
});

/** Default attempts per stage (E-6: named, not ad-hoc). */
export const MAX_STAGE_ATTEMPTS = 3;
/** First backoff delay; doubles per attempt, scaled by the jitter. */
const RETRY_BASE_DELAY_MS = 1000;
/** Exponential growth factor of the backoff. */
const RETRY_BACKOFF_FACTOR = 2;

/**
 * The failure of a stage after all its attempts: the last validation errors
 * ride with it, and the controller turns it into the 422 `BODY_DESIGN_INVALID`
 * the route always returned.
 */
export class DesignStageError extends Error {
    /**
     * @param {{ step: string, kind: string, errors: string[], attempts: number, cause?: Error|null }} params
     */
    constructor({ step, kind, errors, attempts, cause = null }) {
        super('AgentBodyDesignPipeline: stage "' + step + '" (' + kind + ') failed validation on all ' + attempts + ' attempt(s): ' + errors.join('; '), { cause });
        this.name = 'DesignStageError';
        this.code = 'DESIGN_STAGE_FAILED';
        this.step = step;
        this.kind = kind;
        this.errors = [...errors];
        this.attempts = attempts;
    }
}

/**
 * Whether a transport failure is worth another attempt (E-6: classify on
 * machine-readable fields, never on message text).
 *
 * Transient (the world may have changed between two identical calls):
 * LLM_TIMEOUT, LLM_REQUEST_ERROR (network), LLM_PARSE_ERROR (a corrupt or
 * truncated provider envelope - the model's prose content is a validation
 * matter, not a parse one), and LLM_HTTP_ERROR with 429 or any 5xx.
 * Not transient: LLM_HTTP_ERROR with any other 4xx (the provider is refusing
 * this request; repeating it is the same refusal).
 *
 * @param {Error|null} err
 * @returns {boolean}
 */
export function isRetryableTransportError(err) {
    if (!(err instanceof LLMError)) {
        return false;
    }
    if (err.code === 'LLM_TIMEOUT' || err.code === 'LLM_REQUEST_ERROR' || err.code === 'LLM_PARSE_ERROR') {
        return true;
    }
    if (err.code === 'LLM_HTTP_ERROR') {
        return err.status === 429 || (typeof err.status === 'number' && err.status >= 500);
    }
    return false;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Short, human summary of one failure class (the progress events read it).
 * Validation reports the violated rules (joined by ";"); transport reports
 * the code (and the HTTP status, when the error carries one).
 * @param {'validation'|'transport'} kind
 * @param {string[]|LLMError} detail
 * @returns {string}
 */
function describeFailure(kind, detail) {
    if (kind === 'validation') {
        const rules = Array.isArray(detail) ? detail.join('; ') : String(detail);
        return 'validation: ' + rules;
    }
    const status = detail.status !== undefined ? ' (HTTP ' + detail.status + ')' : '';
    return 'transport: ' + detail.code + status;
}

class AgentBodyDesignPipeline {
    /**
     * @param {{
     *   vocabulary: { components: object, materials: object, organs: object, items: object, blueprints: object },
     *   llmController: { chatFull: (messages: object[], options?: object) => Promise<object> },
     *   reporter?: (event: object) => void,
     *   sleep?: (ms: number) => Promise<void>,
     *   rng?: () => number,
     *   maxAttempts?: number
     * }} options
     *   - vocabulary: the world's body vocabulary, loaded by the controller
     *     through the data seam (B-3); the pipeline never reads files.
     *   - llmController: the LLM seam (B-2).
     *   - reporter: progress events (see the module header); a no-op default
     *     keeps the pipeline usable without a live channel.
     *   - sleep / rng: injected so tests run the backoff deterministically
     *     (D-1); defaults to the real timer and `Math.random`.
     *   - maxAttempts: attempts per stage (E-6, named).
     */
    constructor({ vocabulary, llmController, reporter = () => {}, sleep = defaultSleep, rng = Math.random, maxAttempts = MAX_STAGE_ATTEMPTS }) {
        if (!vocabulary || !vocabulary.components || !vocabulary.materials || !vocabulary.organs || !vocabulary.items || !vocabulary.blueprints) {
            throw new TypeError('AgentBodyDesignPipeline: "vocabulary" must carry components, materials, organs, items and blueprints');
        }
        if (!llmController || typeof llmController.chatFull !== 'function') {
            throw new TypeError('AgentBodyDesignPipeline: "llmController" must expose chatFull (the LLM seam, CR B-2)');
        }
        this.vocabulary = vocabulary;
        this.llmController = llmController;
        this.reporter = reporter;
        this.sleep = sleep;
        this.rng = rng;
        this.maxAttempts = maxAttempts;
    }

    /**
     * Run the four stages for one card identity.
     *
     * @param {{cardId: string, name: string, description: string, personality: string}} identity
     * @returns {Promise<{
     *   body: object,
     *   stages: Array<{ step: string, kind: string, version: string, model: string, finishReason: string, latencyMs: number, attempts: number, promptMessages: Array }>
     * }>} the COMPOSED design (the same shape the save posts; still to be
     *   re-validated monolithically by the caller as the final safety net) and
     *   one record per stage (the final attempt's messages, for inspection).
     * @throws {DesignStageError} a stage failed validation on every attempt.
     * @throws {LLMError} a stage failed on transport after its retries
     *   (or immediately, when the error class is not transient).
     */
    async run(identity) {
        const runId = randomUUID();
        const ctx = {
            identity,
            concept: null,
            anatomy: null,
            organs: null,
            outfit: null,
            stages: []
        };
        for (let i = 0; i < STAGE_ORDER.length; i++) {
            const stage = await this._runStage(STAGE_ORDER[i], i + 1, runId, ctx);
            ctx[stage.step] = stage.output;
            ctx.stages.push({
                step: stage.step,
                kind: stage.kind,
                version: stage.version,
                model: stage.model,
                finishReason: stage.finishReason,
                latencyMs: stage.latencyMs,
                attempts: stage.attempts,
                promptMessages: stage.promptMessages
            });
        }
        return { body: this._compose(ctx), stages: ctx.stages };
    }

    // ================================================================
    // Stage execution (the retry loop)
    // ================================================================

    async _runStage(step, stepNumber, runId, ctx) {
        const { identity } = ctx;
        const kind = STAGE_PROMPT_KIND[step];
        const version = STAGE_PROMPT_VERSION[step];
        const totalSteps = STAGE_ORDER.length;
        let lastValidationErrors = null;
        let lastTransportError = null;
        // Which failure (validation or transport) the previous attempt hit;
        // the next "retrying" report names that failure, not a stale one.
        let lastFailureKind = null;

        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            // The client sees the attempt BEFORE it happens: attempt 1 is
            // "started", later ones "retrying" with what the previous attempt
            // did wrong, so the panel can show why the stage is trying again.
            this._report({
                runId,
                cardId: identity.cardId,
                step,
                stepNumber,
                totalSteps,
                attempt,
                maxAttempts: this.maxAttempts,
                status: attempt === 1 ? 'started' : 'retrying',
                ...(attempt > 1 ? {
                    error: lastFailureKind === 'validation'
                        ? describeFailure('validation', lastValidationErrors)
                        : describeFailure('transport', lastTransportError)
                } : {})
            });

            const userPrompt = this._stageUserPrompt(step, ctx, lastValidationErrors);
            const messages = [
                { role: 'system', content: this._stageSystemPrompt(step) },
                { role: 'user', content: userPrompt }
            ];

            const startedAt = performance.now();
            try {
                const full = await this.llmController.chatFull(messages, {
                    temperature: LLM_DEFAULT_TEMPERATURE,
                    max_tokens: LLM_STAGE_MAX_TOKENS[step]
                });
                const latencyMs = Math.round(performance.now() - startedAt);

                const verdict = this._validateStage(step, full, ctx);
                if (verdict.errors.length === 0) {
                    this._report({
                        runId,
                        cardId: identity.cardId,
                        step,
                        stepNumber,
                        totalSteps,
                        attempt,
                        maxAttempts: this.maxAttempts,
                        status: 'succeeded',
                        latencyMs
                    });
                    return {
                        step,
                        kind,
                        version,
                        model: full.model !== undefined ? full.model : LLMController.DEFAULT_MODEL,
                        finishReason: full.finishReason,
                        latencyMs,
                        attempts: attempt,
                        promptMessages: messages,
                        output: verdict.output
                    };
                }

                lastValidationErrors = verdict.errors;
                lastFailureKind = 'validation';
                if (attempt < this.maxAttempts) {
                    // Corrective retry: the violated rules ride into the next
                    // prompt. The prompt changed, so there is nothing to wait
                    // for (E-6's backoff is for repeating the SAME request).
                    continue;
                }
                this._report({
                    runId,
                    cardId: identity.cardId,
                    step,
                    stepNumber,
                    totalSteps,
                    attempt,
                    maxAttempts: this.maxAttempts,
                    status: 'failed',
                    error: describeFailure('validation', lastValidationErrors)
                });
                throw new DesignStageError({ step, kind, errors: lastValidationErrors, attempts: attempt });
            } catch (err) {
                if (err instanceof DesignStageError) {
                    throw err; // validation exhaustion: already reported above
                }
                if (err instanceof LLMError) {
                    lastTransportError = err;
                    lastFailureKind = 'transport';
                    if (attempt < this.maxAttempts && isRetryableTransportError(err)) {
                        // Transient transport: exponential backoff with jitter,
                        // then the SAME prompt again (nothing in it changed).
                        const delay = RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1) * (0.5 + this.rng() * 0.5);
                        await this.sleep(delay);
                        continue;
                    }
                    this._report({
                        runId,
                        cardId: identity.cardId,
                        step,
                        stepNumber,
                        totalSteps,
                        attempt,
                        maxAttempts: this.maxAttempts,
                        status: 'failed',
                        error: describeFailure('transport', err)
                    });
                    throw err; // the controller maps LLMError to the 502 contract
                }
                this._report({
                    runId,
                    cardId: identity.cardId,
                    step,
                    stepNumber,
                    totalSteps,
                    attempt,
                    maxAttempts: this.maxAttempts,
                    status: 'failed',
                    error: 'unexpected error'
                });
                throw err;
            }
        }
        // Unreachable: every path above returns or throws.
        throw new Error('AgentBodyDesignPipeline: stage loop exited without a verdict (internal)');
    }

    _report(event) {
        // The channel is the server's: the pipeline only speaks to its
        // reporter (B-1). The default reporter is a no-op.
        this.reporter(event);
    }

    // ================================================================
    // Stage prompts
    // ================================================================

    /**
     * The system prompt of one stage: only the law of that stage's field, and
     * only the vocabulary it needs (a stage that does not see the whole
     * anatomy spec cannot drop the rules it does not carry).
     * @param {string} step
     * @param {object} ctx
     * @returns {string}
     */
    _stageSystemPrompt(step) {
        switch (step) {
            case 'concept':
                return this._conceptSystemPrompt();
            case 'anatomy':
                return this._anatomySystemPrompt();
            case 'organs':
                return this._organsSystemPrompt();
            case 'outfit':
                return this._outfitSystemPrompt();
            default:
                throw new Error('AgentBodyDesignPipeline: unknown stage "' + step + '"');
        }
    }

    /**
     * The user message of one stage: the card identity, the previous stages'
     * validated output (the only input a stage gets from its predecessors),
     * and - on a corrective retry - the rules the previous attempt violated.
     * @param {string} step
     * @param {object} ctx
     * @param {string[]|null} previousErrors
     * @returns {string}
     */
    _stageUserPrompt(step, ctx, previousErrors) {
        const { identity } = ctx;
        let prompt;
        switch (step) {
            case 'concept': {
                const parts = [
                    'Design the concept for this character:',
                    'Character name: ' + identity.name
                ];
                if (identity.description) {
                    parts.push('Character description:\n' + identity.description);
                }
                if (identity.personality) {
                    parts.push('Character personality:\n' + identity.personality);
                }
                if (!identity.description && !identity.personality) {
                    parts.push('Note: this card has no description or personality; base the concept on the name alone.');
                }
                prompt = parts.join('\n\n') + '\n\nRespond with ONLY the JSON object matching the schema in the system prompt.';
                break;
            }
            case 'anatomy': {
                prompt =
                    'Character name: ' + identity.name +
                    '\n\n' + this._conceptBlock(ctx) +
                    '\n\nDesign this character\'s body: the body tree ("structure") and every NEW component recipe ("components").\n' +
                    'Respond with ONLY the JSON object matching the schema in the system prompt.';
                break;
            }
            case 'organs': {
                const parts = ctx.anatomy.components.map((recipe) => {
                    const materials = recipe.materials.map((m) => m.material + ' ' + m.fraction).join(' + ');
                    const worldOrgans = recipe.internalComponents.length
                        ? recipe.internalComponents.map((ic) => (typeof ic === 'string' ? ic : ic.type)).join(', ')
                        : 'none';
                    return '- ' + recipe.name + ' (materials: ' + materials + '; world organs it already names: ' + worldOrgans + ')';
                });
                prompt =
                    'Character name: ' + identity.name +
                    '\n\n' + this._conceptBlock(ctx) +
                    '\n\nTHE BODY DESIGNED FOR THIS CHARACTER:\n\n' +
                    'STRUCTURE:\n' + JSON.stringify(ctx.anatomy.structure, null, 2) +
                    '\n\nINVENTED PARTS - the only parts an organ may attach to:\n' +
                    (parts.length ? parts.join('\n') : '(this body invents no part; if the world organs already cover it, answer with zero organs)') +
                    '\n\nInvent and attach the new organs this body needs (or zero of them, if the world organs already cover it).\n' +
                    'Respond with ONLY the JSON object matching the schema in the system prompt.';
                break;
            }
            case 'outfit': {
                prompt =
                    'Character name: ' + identity.name +
                    '\n\n' + this._conceptBlock(ctx) +
                    '\n\nTHE BODY DESIGNED FOR THIS CHARACTER:\n\n' +
                    'STRUCTURE:\n' + JSON.stringify(ctx.anatomy.structure, null, 2) +
                    '\n\nDress this body: the garments it carries and what it is born wearing.\n' +
                    'Respond with ONLY the JSON object matching the schema in the system prompt.';
                break;
            }
            default:
                throw new Error('AgentBodyDesignPipeline: unknown stage "' + step + '"');
        }
        if (previousErrors && previousErrors.length > 0) {
            prompt +=
                '\n\nYOUR PREVIOUS ANSWER FOR THIS STAGE WAS REJECTED by the world rules:\n' +
                previousErrors.map((error) => '- ' + error).join('\n') +
                '\nFix exactly those points and answer again with ONLY the JSON object.';
        }
        return prompt;
    }

    /** The concept as the later stages read it (their only memory of stage 1). */
    _conceptBlock(ctx) {
        const { rationale, focus } = ctx.concept;
        return 'CONCEPT (from the previous stage):\nRationale: ' + rationale +
            '\nFocus: ' + (focus.length ? focus.join('; ') : 'none');
    }

    // ------------------------------------------------------------------
    // The four system prompts
    // ------------------------------------------------------------------

    _conceptSystemPrompt() {
        return (
            'You are the CHARACTER CONCEPTOR for slopSimulacrum, a persistent world simulation in which LLM-driven droids live as NPCs.\n' +
            'Your job: read one character card\'s identity (name, description, personality) and distill it into the seed the body designers work from. You design NOTHING yet - no body, no parts, no clothing, no organs. You decide who this character is and what a body for them must express.\n\n' +
            'YOUR OUTPUT\n' +
            'Respond with a single JSON object with exactly these fields:\n' +
            '- "rationale": 1-3 sentences explaining who this character is and what kind of body fits them - movement, role, temperament, signature equipment, size. Concrete and physical, not poetic filler. REQUIRED, at most ' + MAX_RATIONALE_CHARS + ' characters.\n' +
            '- "focus": 1 to ' + MAX_FOCUS_PHRASES + ' short phrases (each at most ' + MAX_FOCUS_PHRASE_CHARS + ' characters) naming the defining traits a body for this character must express. Each phrase is one physical or equipment fact: "hunched narrow frame", "rust-pitted machete on a chain", "three short arms", "a coat of woven scrap metal". The body, organ and clothing designers see ONLY your words, so name what a body can show, not what a personality feels.\n\n' +
            'If the card carries no description or personality, derive the concept from the name alone and say so in the rationale.\n\n' +
            'OUTPUT FORMAT: exactly one JSON object. No markdown, no code fences, no explanation outside the JSON.'
        );
    }

    _anatomySystemPrompt() {
        const { components, materials, organs, blueprints } = this.vocabulary;
        const componentLines = Object.values(components)
            .map((c) => this._componentLine(c))
            .join('\n');
        const materialLines = Object.values(materials)
            .map((m) => m.name + ' (density ' + (m.density === null ? '?' : m.density) + ')')
            .join(', ');
        const organLines = Object.values(organs)
            .map((o) => o.name + (o.grants ? ' - grants: ' + this._grantsString(o.grants) : ' - no stat grants'))
            .join('\n');
        const blueprintIds = Object.keys(blueprints).join(', ');
        const exampleLines = Object.entries(blueprints)
            .map(([name, tree]) => this._blueprintExampleLine(name, tree))
            .join('\n');

        return (
            'You are the BODY DESIGNER for slopSimulacrum, a persistent world simulation in which LLM-driven droids live as NPCs.\n' +
            'You must design how one character\'s BODY is constructed, from the character concept in the user message and the anatomy facts below.\n\n' +
            'ANATOMY FACTS\n' +
            '- An NPC entity is a BLUEPRINT: a tree of components (data/mods/core-blueprints/blueprints.json). Each node is a component; nodes may have children (sub-components).\n' +
            '- A COMPONENT (data/mods/core-components/components.json) is defined by its FORM (volume + position), its MATERIALS (fractions that sum to 1.0) and its INTERNAL COMPONENTS (organs). A component without organs is inert.\n' +
            '- VOLUME is a component\'s physical capacity; an ORGAN is what makes a component functional (it grants stat values).\n\n' +
            'YOUR OUTPUT\n' +
            'Respond with a single JSON object with exactly these fields:\n' +
            '- "structure": the body tree. Root: { "component": "<name>", "slot": null, "children": [ <node>... ] }.\n' +
            '  Every node: { "component": "<name>", "slot": null|"<string>", "children": [ <node>... ] or [] }.\n' +
            '  The same component may appear multiple times (four legs, two arms).\n' +
            '  slot is a short body-position token such as "frontal_left" or "top_hand" (null when absent).\n' +
            '  A node MAY also declare "hidesWithParent": true. It means: this part hangs BEHIND whatever covers the part it hangs on, so when that parent wears a garment the world does not name this part either. Author it on a part that cloth normally covers (a breast under a shirt), never on a head or a hand, and never on the root, which hangs on nothing. Omit it - never write false - when the part is simply a part.\n' +
            '  The whole tree must have at most ' + MAX_BODY_NODES + ' nodes.\n' +
            '- "components": the NEW component definitions you invent for this card. The AVAILABLE COMPONENTS below are only a generic base vocabulary - whenever the character has a feature that is distinctive to it (a signature weapon, role-specific gear, or unique anatomy such as a tail, crest, or special limb), define a NEW component for it so the body faithfully reflects THIS character and is not just a copy of the generic droid. Leave the array empty only when the available components already cover the character. Each new component:\n' +
            '  { "name": "<unique id, letters and digits only>",\n' +
            '    "form": { "volume": <positive integer 1..40>, "position": { "x": <integer>, "y": <integer> } },\n' +
            '    "materials": [ { "material": "<one of the AVAILABLE MATERIALS>", "fraction": <number> } ],\n' +
            '    "internalComponents": [ "<an EXACT name from the AVAILABLE ORGANS list - this stage may reference ONLY organs the world already has>" ] or omitted,\n' +
            '    "energyCapacity": <integer >= 0> or omitted }\n' +
            '  Material fractions within each new recipe must sum to exactly 1.0.\n\n' +
            'RULES\n' +
            '1. Every "component" in "structure" must be either an AVAILABLE COMPONENT (exactly as named below) or a NEW COMPONENT you define in "components".\n' +
            '2. A new recipe\'s "internalComponents" may use ONLY names from the AVAILABLE ORGANS list. A name not in that list rejects the design: the organs a body INVENTS are authored by a later stage, which attaches each one to your parts.\n' +
            '3. Keep the body compact: at most ' + MAX_BODY_NODES + ' component nodes in the tree.\n' +
            '4. "hidesWithParent" is a fact about THIS joint in THIS body, not about the component type: the same part may hide under the cloth of one body and not under another. Use it sparingly, and only where a garment would really be in front of the part.\n' +
            '5. Make the body recognizable as THIS card, not a generic M1 droid: invent NEW components to express the character\'s defining traits (its name, role, temperament, signature equipment, unique anatomy). Give those parts the WORLD organs that fit; the organs the world lacks arrive from the next stage.\n\n' +
            'AVAILABLE COMPONENTS (' + Object.keys(components).length + ' types):\n' +
            componentLines + '\n\n' +
            'AVAILABLE MATERIALS:\n' +
            materialLines + '\n\n' +
            'AVAILABLE ORGANS:\n' +
            organLines + '\n\n' +
            'EXISTING BLUEPRINT IDS (for reference - existing droid types in the world): ' + blueprintIds + '\n\n' +
            'EXAMPLE BLUEPRINTS (how bodies compose in this world; ["component", "slot"] is a component with a slot):\n' +
            exampleLines + '\n\n' +
            'FINAL CHECKLIST (run it after every value is written, before the JSON leaves you; one missed line is a design the server rejects as BODY_DESIGN_INVALID and this stage is retried):\n' +
            '- COMPONENT NAMES: every "component" in "structure" must match an "AVAILABLE COMPONENTS" name or a recipe name you defined in "components".\n' +
            '- ORGAN REFERENCES: every "internalComponents" entry of your "components" must match, character for character, a name in the "AVAILABLE ORGANS" list. No inventing organ names in this stage.\n' +
            '- SHAPES: every recipe has a form (integer volume 1..40, integer x/y) and materials from the closed vocabulary summing to 1.0; the tree has at most ' + MAX_BODY_NODES + ' nodes; "hidesWithParent" only as true, and only on a non-root node.\n\n' +
            'OUTPUT FORMAT: exactly one JSON object. No markdown, no code fences, no explanation outside the JSON.'
        );
    }

    _organsSystemPrompt() {
        const { organs } = this.vocabulary;
        const worldOrganLines = Object.values(organs)
            .map((o) => o.name + (o.grants ? ' - grants: ' + this._grantsString(o.grants) : ' - no stat grants'))
            .join('\n');

        return (
            'You are the ANATOMIST for slopSimulacrum, a persistent world simulation in which LLM-driven droids live as NPCs.\n' +
            'The body of one character has just been designed: its structure and its INVENTED part recipes appear in the user message. Your job: invent the NEW organs (internal components) that make this body\'s parts functional, and attach each one to exactly one of the body\'s INVENTED parts.\n\n' +
            'ORGAN FACTS\n' +
            '- An ORGAN is what makes a component functional: it grants stat values. A DESIGNER ORGAN is a STATIC claim - it grants stats and/or marks flags, and it does nothing between turns (no fuel, no repair, no item making, no per-turn effect - that half belongs to the world\'s organs and is not authorable here).\n' +
            '- An organ installs ONLY where a component names it in that component\'s own "internalComponents". A part with no organ is inert.\n' +
            '- A WORLD part (a part this body did not invent) keeps the world\'s own organs. You may attach a new organ ONLY to an INVENTED part (the list in the user message). Attaching one to a world part is rejected - a design never restates a world recipe.\n\n' +
            'WHAT A DESIGNER ORGAN MAY GRANT OR MARK (closed vocabulary)\n' +
            '- grants: ONLY ' + GRANTABLE_STAT_KEYS.join(', ') + ' (numbers >= 0)\n' +
            '- grantsFlags: ONLY ' + GRANTABLE_FLAGS.join(', ') + '\n' +
            '- at least one of grants / grantsFlags per organ (an inert organ is rejected)\n\n' +
            'YOUR OUTPUT\n' +
            'Respond with a single JSON object with exactly one field:\n' +
            '- "internalComponents": 0 to ' + MAX_IC_RECIPES + ' NEW organ definitions. ZERO is a valid answer: a body may run on world organs alone. Each:\n' +
            '  { "name": "<new id, letters and digits only, 1..31; NOT one the world already has, not one you already proposed>",\n' +
            '    "displayName": "<what the world calls it in a sentence; optional; at most ' + MAX_IC_LABEL_CHARS + ' characters>",\n' +
            '    "grants": { "<one of the four function stats>": <number >= 0> },     // optional, but required with grantsFlags\n' +
            '    "grantsFlags": ["<one of the four flags>"],                          // optional, but required with grants\n' +
            '    "volume": <positive integer 1..40 - the organ must fit inside its host part>,\n' +
            '    "component": "<the EXACT name of an INVENTED PART from the user message; the part this organ installs into. One organ names exactly one part; a part may receive several organs.>" }\n' +
            '  Decide organ by organ: read what each invented part is for (its materials, its role in the concept), and give it function only where the concept needs it. A part already carrying a world organ gets a new one only for an ADDITIONAL function the world organ does not give.\n\n' +
            'AVAILABLE (WORLD) ORGANS - what already exists, and what they grant:\n' +
            worldOrganLines + '\n\n' +
            'FINAL CHECKLIST (run it after every value is written, before the JSON leaves you; one missed line is a design the server rejects as BODY_DESIGN_INVALID and this stage is retried):\n' +
            '- NAMES: every organ name is new (never a world organ, never repeated in your answer), letters and digits only, 1..31.\n' +
            '- GRANTS: from the four function stats only; FLAGS: from the four flags only; every organ grants or marks (none inert).\n' +
            '- ATTACHMENT: every "component" is an INVENTED PART name, character for character; never a world part.\n' +
            '- BOUNDS: at most ' + MAX_IC_RECIPES + ' organs; volumes 1..40; display names at most ' + MAX_IC_LABEL_CHARS + ' characters.\n\n' +
            'OUTPUT FORMAT: exactly one JSON object. No markdown, no code fences, no explanation outside the JSON.'
        );
    }

    _outfitSystemPrompt() {
        const { materials, items } = this.vocabulary;
        const materialLines = Object.values(materials)
            .map((m) => m.name + ' (density ' + (m.density === null ? '?' : m.density) + ')')
            .join(', ');
        const wearable = Object.values(items).filter((item) => item.minVolume !== null);
        const wearableLines = wearable.length === 0
            ? '(none - this world has no wearable item; a garment must be authored in "garments")'
            : wearable
                .map((item) => '- ' + item.name + ' (' + item.displayName + ', needs ' + item.minVolume + ' free volume)')
                .join('\n');

        return (
            'You are the DRESSER for slopSimulacrum, a persistent world simulation in which LLM-driven droids live as NPCs.\n' +
            'The body of one character has just been designed (its structure appears in the user message). Your job: decide what this body is BORN WEARING.\n\n' +
            'CLOTHING FACTS\n' +
            '- A GARMENT is a wearable ITEM the character carries and wears: a cloak, a hood, a harness, a wrapped bandage, a ceremonial sash. A garment is a thing the character carries and wears, never a node of the body structure and never a component.\n' +
            '- THE OUTFIT says what is worn, and on which component of THIS body. An authored outfit is a claim even when EMPTY ([] = born wearing nothing, the world\'s default clothing stands down); omitting it says nothing, and the world\'s default clothing stays in force.\n' +
            '- Pair garments with the parts the body marked "hidesWithParent" - those parts hang behind whatever covers them, and the cloth is what hides them.\n\n' +
            'YOUR OUTPUT\n' +
            'Respond with a single JSON object with these fields (both optional - empty or absent "garments" is fine when the character is undressed and the world\'s items already cover it):\n' +
            '- "garments": 0 to ' + MAX_GARMENTS + ' NEW wearable item recipes. Each:\n' +
            '  { "name": "<unique id, letters and digits only>",\n' +
            '    "displayName": "<what the world calls it in a sentence, e.g. Rune-Stitched Cloak; optional; at most ' + MAX_GARMENT_LABEL_CHARS + ' characters>",\n' +
            '    "form": { "volume": <positive integer 1..40> },\n' +
            '    "materials": [ { "material": "<one of the AVAILABLE MATERIALS>", "fraction": <number> } ],\n' +
            '    "wear": { "minVolume": <integer 1..volume - the free volume the part it hangs on must have> },\n' +
            '    "visual": { "hue": <0-360>, "saturation": <0-100>, "lightness": <0-100>, "metalness": <0-100>, "roughness": <0-100> } or omitted }\n' +
            '  A garment asks no more of a body than it takes itself (wear.minVolume at most its own volume): the shipped t-shirt is volume 2 and needs 2. Its materials sum to 1.0. Its visual block is what the world SEES - a garment does not look like the matter it is modelled from.\n' +
            '- "outfit": what this body is BORN WEARING, as a list (0 to ' + MAX_OUTFIT_ENTRIES + ') of { "item": "<one of your garments, or one of the WEARABLE ITEMS below>", "component": "<a component name that appears in the structure above>" }.\n\n' +
            'AVAILABLE MATERIALS:\n' +
            materialLines + '\n\n' +
            'WEARABLE ITEMS already in the world ("outfit" names them by the key below; N is the free volume the part must have to accept it):\n' +
            wearableLines + '\n\n' +
            'FINAL CHECKLIST (run it after every value is written, before the JSON leaves you; one missed line is a design the server rejects as BODY_DESIGN_INVALID and this stage is retried):\n' +
            '- GARMENT NAMES: unique, letters and digits only, never an existing item or component; at most ' + MAX_GARMENTS + ' garments.\n' +
            '- MATERIALS: the closed vocabulary above, fractions summing to 1.0; wear.minVolume an integer 1..own volume.\n' +
            '- DISPLAY NAMES: at most ' + MAX_GARMENT_LABEL_CHARS + ' characters.\n' +
            '- OUTFIT: every "item" a garment you proposed or a key from "WEARABLE ITEMS"; every "component" a node of the structure above; at most ' + MAX_OUTFIT_ENTRIES + ' entries.\n' +
            '- A garment is never a body part, and a component is never in "garments".\n\n' +
            'OUTPUT FORMAT: exactly one JSON object. No markdown, no code fences, no explanation outside the JSON.'
        );
    }

    // ------------------------------------------------------------------
    // Vocabulary renderers (ported from the single design prompt)
    // ------------------------------------------------------------------

    _componentLine(component) {
        const materials = component.materials.length
            ? component.materials.map((m) => m.material + ' ' + m.fraction).join(' + ')
            : 'none';
        const organs = component.organs.length ? component.organs.join(' + ') : 'none';
        let line = '- ' + component.name + ' (vol ' + (component.volume === null ? '?' : component.volume) + ', materials: ' + materials + ', organs: ' + organs + ')';
        if (component.energyCapacity !== null) {
            line += ', energy capacity ' + component.energyCapacity;
        }
        return line;
    }

    _grantsString(grants) {
        return Object.entries(grants)
            .map(([key, value]) => key + ' ' + value)
            .join(', ');
    }

    _blueprintExampleLine(name, tree) {
        const children = tree.map((child) => {
            if (Array.isArray(child) && child.length >= 2 && typeof child[1] === 'string') {
                return child[0] + ' (' + child[1] + ')';
            }
            return String(child);
        });
        return '- ' + name + ': ' + children.join(', ');
    }

    // ================================================================
    // Stage validation (the shared rules, one law per stage)
    // ================================================================

    /**
     * Validate one stage's raw answer against that stage's law, and return
     * its narrowed output (null when validation failed).
     *
     * @param {string} step
     * @param {{content: string|null, finishReason: string}} full
     * @param {object} ctx - the stage context (the previous stages' outputs)
     * @returns {{ errors: string[], output: object|null }}
     */
    _validateStage(step, full, ctx) {
        const raw = extractDesignJson(full.content);
        if (!raw) {
            return { errors: ['the model did not answer with a JSON object'], output: null };
        }
        const errors = [];
        let output;
        switch (step) {
            case 'concept':
                output = this._validateConceptStage(raw, errors);
                break;
            case 'anatomy':
                output = this._validateAnatomyStage(raw, errors);
                break;
            case 'organs':
                output = this._validateOrgansStage(raw, errors, ctx);
                break;
            case 'outfit':
                output = this._validateOutfitStage(raw, errors, ctx);
                break;
            default:
                throw new Error('AgentBodyDesignPipeline: unknown stage "' + step + '"');
        }
        return { errors, output: errors.length === 0 ? output : null };
    }

    _validateConceptStage(raw, errors) {
        let rationale = '';
        if (typeof raw.rationale !== 'string') {
            errors.push('"rationale" must be a string');
        } else {
            rationale = raw.rationale.trim();
            if (rationale.length === 0) {
                errors.push('"rationale" must be a non-empty string');
            } else if (rationale.length > MAX_RATIONALE_CHARS) {
                errors.push('"rationale" must be at most ' + MAX_RATIONALE_CHARS + ' characters');
            }
        }
        let focus = [];
        if (raw.focus === undefined || raw.focus === null) {
            errors.push('"focus" is required (1 to ' + MAX_FOCUS_PHRASES + ' phrases; the later stages work from it)');
        } else if (!Array.isArray(raw.focus)) {
            errors.push('"focus" must be an array of short phrases');
        } else {
            if (raw.focus.length === 0) {
                errors.push('"focus" must list at least one phrase');
            } else if (raw.focus.length > MAX_FOCUS_PHRASES) {
                errors.push('"focus" has ' + raw.focus.length + ' phrases (max ' + MAX_FOCUS_PHRASES + ')');
            }
            for (const phrase of raw.focus) {
                const text = typeof phrase === 'string' ? phrase.trim() : '';
                if (text.length === 0) {
                    errors.push('"focus" phrases must be non-empty strings');
                    continue;
                }
                if (text.length > MAX_FOCUS_PHRASE_CHARS) {
                    errors.push('"focus" phrases must be at most ' + MAX_FOCUS_PHRASE_CHARS + ' characters');
                    continue;
                }
                focus.push(text);
            }
        }
        return { rationale, focus };
    }

    _validateAnatomyStage(raw, errors) {
        const { components: availableComponents, materials, organs: availableOrgans } = this.vocabulary;
        const proposedNames = new Set();
        const proposedOrganNames = new Set();

        let structure = null;
        if (!raw.structure || typeof raw.structure !== 'object' || Array.isArray(raw.structure)) {
            errors.push('"structure" must be a body-tree object');
        } else {
            structure = raw.structure;
        }

        const refs = [];
        if (structure) {
            walkStructure(structure, refs, 0, errors);
            if (refs.length > MAX_BODY_NODES) {
                errors.push('the body tree has ' + refs.length + ' nodes (max ' + MAX_BODY_NODES + ')');
            }
        }

        let components = [];
        if (raw.components === undefined || raw.components === null) {
            components = [];
        } else if (!Array.isArray(raw.components)) {
            errors.push('"components" must be an array of new component recipes');
        } else {
            components = [];
            for (const [index, recipe] of raw.components.entries()) {
                const narrowed = validateComponentRecipe(recipe, index, {
                    availableComponents,
                    availableOrgans,
                    availableMaterials: materials,
                    proposedNames,
                    proposedOrganNames,
                    allowDesignOrgans: false
                }, errors);
                if (narrowed) {
                    components.push(narrowed);
                }
            }
        }

        if (structure) {
            const known = new Set(Object.keys(availableComponents));
            for (const name of proposedNames) {
                known.add(name);
            }
            const unknownRefs = refs.filter((ref) => !known.has(ref));
            if (unknownRefs.length) {
                errors.push('unknown component(s) in the body tree: ' + [...new Set(unknownRefs)].join(', ') + ' (every node must be an available component or a recipe in "components")');
            }
        }

        return { structure, components, refs };
    }

    _validateOrgansStage(raw, errors, ctx) {
        const { organs: availableOrgans } = this.vocabulary;
        const inventedNames = new Set(ctx.anatomy.components.map((recipe) => recipe.name));
        let organs = [];
        const assignments = {};
        if (raw.internalComponents === undefined || raw.internalComponents === null) {
            organs = [];
        } else if (!Array.isArray(raw.internalComponents)) {
            errors.push('"internalComponents" must be an array of new organ recipes');
        } else {
            if (raw.internalComponents.length > MAX_IC_RECIPES) {
                errors.push('"internalComponents" has ' + raw.internalComponents.length + ' entries (max ' + MAX_IC_RECIPES + ')');
            }
            const proposedOrganNames = new Set();
            for (const [index, organ] of raw.internalComponents.entries()) {
                const at = '"internalComponents[' + index + ']"';
                const narrowed = validateOrganDefinition(organ, index, {
                    availableOrgans,
                    proposedOrganNames,
                    allowExtraKeys: ['component']
                }, errors);
                if (!narrowed) {
                    continue;
                }
                const component = (organ && typeof organ === 'object') ? organ.component : undefined;
                if (typeof component !== 'string' || component.trim().length === 0) {
                    errors.push(at + ' must attach to one of the body\'s INVENTED PARTS ("component"); an organ that attaches to nothing installs nowhere');
                    continue;
                }
                if (!inventedNames.has(component)) {
                    errors.push(at + ' is attached to "' + component + '", which is not an invented part of this body (an organ may attach only to a part this design invents' + (inventedNames.size ? ': ' + [...inventedNames].join(', ') : '') + ')');
                    continue;
                }
                assignments[narrowed.name] = component;
                organs.push(narrowed);
            }
        }
        return { organs, assignments };
    }

    _validateOutfitStage(raw, errors, ctx) {
        const { items: availableItems, components: availableComponents, materials: availableMaterials } = this.vocabulary;
        const garments = validateGarments(raw.garments, {
            availableItems,
            availableComponents,
            availableMaterials
        }, errors);
        const outfit = validateOutfit(raw.outfit, {
            structureRefs: ctx.anatomy.refs,
            garments,
            availableItems
        }, errors);
        return { garments, outfit, outfitDeclared: Array.isArray(raw.outfit) };
    }

    // ================================================================
    // Composition (the four stage outputs into one design)
    // ================================================================

    /**
     * Compose the four stage outputs into the single design the save posts.
     * The organs the anatomist invented are attached to the invented parts
     * (the part recipe's own "internalComponents" list gains the organ
     * names); the top-level "internalComponents" is the organ definitions
     * themselves. This is the only place two stage outputs meet: no other
     * cross-stage data flows, and none of the stage outputs is rewritten
     * here beyond the attachment.
     *
     * The result has exactly the shape the monolithic `_validateDesign` and
     * `_flattenTree` read; the controller re-validates it as the final
     * safety net (a pipeline success is a claim, the validator is the fact).
     *
     * @param {object} ctx
     * @returns {object} the normalized design (frozen). The organ
     *   definitions carry no "component" key - that key was the stage's
     *   attachment field and does not ride into the world file.
     */
    _compose(ctx) {
        const organsByComponent = new Map();
        for (const organ of ctx.organs.organs) {
            const component = ctx.organs.assignments[organ.name];
            const list = organsByComponent.get(component) || [];
            list.push(organ.name);
            organsByComponent.set(component, list);
        }
        const components = ctx.anatomy.components.map((recipe) => {
            const attached = organsByComponent.get(recipe.name) || [];
            return {
                ...recipe,
                internalComponents: [...recipe.internalComponents, ...attached]
            };
        });
        return normalizeDesign({
            blueprintId: ctx.identity.name,
            rationale: ctx.concept.rationale,
            structure: ctx.anatomy.structure,
            components,
            garments: ctx.outfit.garments,
            internalComponents: [...ctx.organs.organs],
            outfit: ctx.outfit.outfit,
            outfitDeclared: ctx.outfit.outfitDeclared
        });
    }
}

export default AgentBodyDesignPipeline;

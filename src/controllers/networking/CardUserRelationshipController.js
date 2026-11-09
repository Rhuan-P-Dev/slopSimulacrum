/**
 * CardUserRelationshipController — the fifth LLM prompt kind (RP-1):
 * `card-user-relationship`, versioned per RP-2 (`PROMPT_VERSION` below — a
 * prompt change is a bump here, never an edit of a shipped version).
 *
 * What it owns: the judgment of which relationship a card's character has
 * with its `{{user}}` placeholder, and the persistence of that judgment. The
 * judgment runs against the card's EFFECTIVE persona — the exact precedence
 * the spawn uses (`CardSpawnLogic.buildCardProfile`: a non-empty `personality`
 * wins, then `description`, each trimmed; a card with neither has no persona
 * to judge, not the spawn's default text, which is spawn-owned) — because that
 * is the text the NPC would actually carry into the world, and the `{{user}}`
 * token this feature is about lives in that text
 * (wiki/decisions/card-user-mapping.md). A card whose effective persona
 * carries no literal `{{user}}` token cannot be judged: this controller
 * throws `CardUserTokenAbsentError` and the route answers 422
 * `CARD_USER_TOKEN_ABSENT` (the same rule the Create-World `{{user}}`
 * binding applies, mirrored server-side per TST-9). A card file that exists
 * but carries no usable character payload throws `CardNotReadableError`
 * (route: 422 `CARD_NOT_READABLE`) — a data mistake the operator can fix.
 *
 * The judgment is persisted as a JSON sidecar NEXT TO the card's PNG
 * (`<card stem>.user-relationship.json` inside `data/cards/`, through the
 * data seam `CardRelationshipStore`): the PNG is never written (the
 * repository's language policy, AGENTS.md "Language policy (hard rule)")
 * and the world definition (`data/mods/`) is untouched (CR B-2). The sidecar
 * carries a sha-256 hash of the persona it was judged from (`personaHashFor`,
 * owned by the seam); when the card file is replaced and the hash no longer
 * matches, the judgment is invalid — it is not served, and the next judgment
 * action deletes sidecars that no card (or no matching persona) owns
 * (derived data is deleted, not kept, CHG-6; the housekeeping runs on the
 * command, not on a read, CR API-1). The seam also provides
 * `effectivePersonaFor`/`effectiveCardName` (the hash inputs) and
 * `readFreshCardUserRelationship` (the spawn's fresh-read), so the judge and
 * the spawn can never drift apart on the rule (CHG-2).
 *
 * Cost guard (SEC-9, the agent-body-design precedent): one LLM call per
 * explicit operator click, rate-limited in the route. The answer is small by
 * contract — a free-form label (at most 3 words, 48 characters) plus one
 * short sentence (at most 200 characters), owner decision,
 * wiki/decisions/card-user-relationship.md — with the word and character
 * caps enforced at the boundary (T-1, E-4), not just asked for — and `max_tokens`
 * is capped to
 * match. The provider timeout is the LLM seam's (env `LLM_TIMEOUT_MS`);
 * there is no second knob (CR A-5).
 *
 * Public API (route surface — `src/routes/agentBodyRoutes.js`):
 *   - `listCardUserRelationships()` — `{ [cardId]: { label, summary,
 *     judgedAt } }` for every card whose sidecar is fresh (a fresh sidecar is
 *     one whose persona hash still matches the card on disk). Read-only.
 *   - `judgeCardUserRelationship(cardId)` — one LLM call; validates the
 *     answer, writes the sidecar, returns the frozen judgment.
 *
 * What it does NOT do: it never writes the PNG, never creates or modifies a
 * mod package, never applies anything, never touches the world state.
 *
 * @module src/controllers/networking/CardUserRelationshipController
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Logger from '../../utils/Logger.js';
import { readCharaCard } from '../../utils/PngCharaReader.js';
import {
    SIDECAR_SUFFIX,
    SIDECAR_VERSION,
    listCardFileNames,
    listCardUserRelationshipFileNames,
    readCardUserRelationshipFile,
    writeCardUserRelationshipFile,
    deleteCardUserRelationshipFile,
    sidecarPathFor,
    personaHashFor,
    effectivePersonaFor,
    effectiveCardName
} from '../../utils/CardRelationshipStore.js';

/**
 * The `{{user}}` token: the placeholder the world replaces with the bound
 * card's display name (wiki/decisions/card-user-mapping.md). The same string
 * the client panels match against (cardHasUserPlaceholder) — a deliberate
 * mirror of a small pure constant, not an import (CHG-2).
 */
const USER_TOKEN = '{{user}}';

/**
 * Machine-readable error types for this endpoint family (CR E-7 — the
 * domain error types; the route maps each to a status + `code`).
 */
export class CardNotFoundError extends Error {
    /** @param {string} cardId */
    constructor(cardId) {
        super(`No card file matches id "${cardId}"`);
        this.name = 'CardNotFoundError';
        this.code = 'CARD_NOT_FOUND';
    }
}

export class CardUserTokenAbsentError extends Error {
    /** @param {string} cardId */
    constructor(cardId) {
        super(
            `The card "${cardId}" has no {{user}} token in the persona text the world would give this character, so there is no relationship to judge`
        );
        this.name = 'CardUserTokenAbsentError';
        this.code = 'CARD_USER_TOKEN_ABSENT';
    }
}

/**
 * A card file that exists but carries no usable character payload (a wrong
 * file type, a corrupt file, or a valid file with no character metadata):
 * the operator can fix the file, so this is a data/caller mistake (4xx), not
 * an internal one (E-1, E-7). The route maps it to 422 `CARD_NOT_READABLE`.
 */
export class CardNotReadableError extends Error {
    /**
     * @param {string} cardId
     * @param {string} [reason] - The reader's reason the file is not a card
     *   (path-safe: `readCharaCard` reports its reason, never the path).
     */
    constructor(cardId, reason = 'no usable character payload') {
        super(
            `The card file for "${cardId}" is present but not a usable character card (${reason}); there is nothing to judge`
        );
        this.name = 'CardNotReadableError';
        this.code = 'CARD_NOT_READABLE';
    }
}

export class RelationshipJudgmentError extends Error {
    /**
     * @param {string} cardId
     * @param {Array<string>} [violations] - Which validation rule(s) the model
     *   answer broke (E-4: the message names the rule, not a bare "invalid").
     */
    constructor(cardId, violations = []) {
        super(
            violations.length > 0
                ? `The judgment for card "${cardId}" failed validation: ${violations.join('; ')}`
                : `The judgment for card "${cardId}" failed validation`
        );
        this.name = 'RelationshipJudgmentError';
        this.code = 'RELATIONSHIP_JUDGMENT_INVALID';
        this.errors = violations.map(String);
    }
}

/** The prompt kind (RP-1 — a named decision, not an ad-hoc fetch). */
export const PROMPT_KIND = 'card-user-relationship';

/** The prompt version (RP-2 — bump on any prompt change). */
export const PROMPT_VERSION = '1.0.0';

/** The card-id length bound (the same 1-128 the agent-body routes enforce). */
export const MAX_CARD_ID_LENGTH = 128;

/** Label bound: a short free-form label (owner decision — no fixed vocabulary). */
export const RELATIONSHIP_LABEL_MAX_CHARS = 48;

/**
 * Label word-bound (owner decision — the same 3 words the prompt names as the
 * limit). Enforced at the boundary, not just asked for (T-1, E-4).
 */
export const RELATIONSHIP_LABEL_MAX_WORDS = 3;

/** Summary bound: ONE short sentence (owner decision). */
export const RELATIONSHIP_SUMMARY_MAX_CHARS = 200;

/**
 * Judgment answer budget (RP-3). The provider behind this endpoint is a
 * reasoning model, and the reasoning it emits (`reasoning_content`) counts
 * against this budget — the original 160 was eaten entirely by reasoning, so
 * the JSON answer came back empty with `finishReason: "length"`. 100x
 * headroom (16000) lets the reasoning run and the answer still fit; the
 * answer itself stays fenced by the label/summary validator (T-1), so a
 * rambling or truncated answer is a clean 422 the operator can retry, not a
 * silent partial write. No `temperature` is sent for this call — the seam's
 * explicit `null` opt-out leaves the sampling to the provider (see the
 * `chatFull` site below).
 */
export const LLM_CARD_USER_RELATIONSHIP_MAX_TOKENS = 16000;

/**
 * @param {Object} deps
 * @param {import('./LLMController.js')} deps.llmController - The LLM seam
 *   (CR B-4): the controller only ever calls `chatFull` on it.
 * @param {string} [deps.cardDir] - The card directory (tests inject a temp
 *   dir, TST-8); production boots with the default `data/cards`.
 */
export default class CardUserRelationshipController {
    constructor({ llmController, cardDir } = {}) {
        if (!llmController || typeof llmController.chatFull !== 'function') {
            throw new Error('CardUserRelationshipController: llmController with a chatFull method is required (CR B-4)');
        }
        this._llm = llmController;
        this._cardDir = (typeof cardDir === 'string' && cardDir.trim() !== '')
            ? path.resolve(cardDir)
            : path.resolve('data/cards');
    }

    /**
     * The judged relationships for every card on disk: `{ [cardId]:
     * { label, summary, judgedAt } }`. Only FRESH sidecars are returned — a
     * fresh one belongs to a readable card whose persona hash still matches,
     * so a replaced card never serves a stale verdict. This method reads and
     * never deletes (CR API-1 — the housekeeping runs on the judgment
     * command).
     * @returns {Object<string, {label: string, summary: string, judgedAt: string|null}>}
     */
    listCardUserRelationships() {
        const out = {};
        for (const fileName of listCardFileNames(this._cardDir)) {
            const cardId = path.basename(fileName, path.extname(fileName));
            let card;
            try {
                const payload = readCharaCard(path.join(this._cardDir, fileName));
                card = payload.success ? payload.card : null;
            } catch (err) {
                // A present-but-unreadable file is skipped, exactly the way
                // the spawn skips it (CardSpawnLogic.readCardFiles); a skipped
                // card simply has no judgment.
                Logger.warn(`CardUserRelationshipController: skipping unreadable card ${fileName}: ${err && err.message}`);
                continue;
            }
            if (card === null) {
                continue; // a file with no parseable payload: nothing to judge
            }
            const record = readCardUserRelationshipFile(sidecarPathFor(this._cardDir, fileName));
            if (record === null) {
                continue;
            }
            if (record.version !== SIDECAR_VERSION) {
                continue; // an unknown version: not served, not interpreted
            }
            const persona = effectivePersonaFor(card);
            const name = effectiveCardName(card, cardId);
            if (typeof record.personaHash !== 'string' || record.personaHash !== personaHashFor(name, persona)) {
                continue; // the card on disk is not the one that was judged
            }
            const rel = record.relationship;
            if (!rel || typeof rel.label !== 'string' || typeof rel.summary !== 'string') {
                continue; // a shape the validator never wrote: not served
            }
            out[cardId] = {
                label: rel.label.slice(0, RELATIONSHIP_LABEL_MAX_CHARS),
                summary: rel.summary.slice(0, RELATIONSHIP_SUMMARY_MAX_CHARS),
                judgedAt: typeof record.judgedAt === 'string' ? record.judgedAt : null
            };
        }
        return out;
    }

    /**
     * Judge one card's relationship with its `{{user}}`: one LLM call against
     * the card's effective persona (RP-1/RP-2 — the prompt kind and version
     * are named below and in the system prompt itself), validation of the
     * answer, and the sidecar write. Frozen result; the route shape mirrors
     * it one-to-one.
     * @param {string} cardId - The card id: the card file stem, raw, 1-128
     *   chars (no trim — a stem with surrounding whitespace is a legitimate
     *   id, the same as the image route serves it).
     * @returns {Promise<{card: {cardId: string, name: string}, relationship: {label: string, summary: string}, judgedAt: string, meta: {promptKind: string, promptVersion: string, model: string|null, finishReason: string|null, latencyMs: number}}>}
     * @throws {CardNotFoundError} no card file matches the id (route: 404)
     * @throws {CardNotReadableError} the file exists but carries no usable character payload (route: 422)
     * @throws {CardUserTokenAbsentError} the effective persona has no {{user}} (route: 422)
     * @throws {RelationshipJudgmentError} the model answer failed validation (route: 422)
     * @throws {LLMError} the seam's typed provider error (route: 502)
     */
    async judgeCardUserRelationship(cardId) {
        // Raw id, no trim: a card file whose name carries leading or trailing
        // whitespace is a legitimate card, and the gallery and the image
        // route both use the raw stem — trimming here would let a card that
        // lists and serves its image 404 on the judge.
        const id = typeof cardId === 'string' ? cardId : '';
        if (id === '' || id.length > MAX_CARD_ID_LENGTH) {
            // Backstop (the route pre-validates the same bound, CR E-1): a
            // malformed id is a caller mistake, so it maps to 4xx, not 5xx.
            throw new RelationshipJudgmentError(id, [`cardId must be a string of 1-${MAX_CARD_ID_LENGTH} characters`]);
        }

        const cardFiles = listCardFileNames(this._cardDir);
        let cardFileName = null;
        let card = null;
        let readFailure = null;
        for (const fileName of cardFiles) {
            if (path.basename(fileName, path.extname(fileName)) !== id) {
                continue;
            }
            // readCharaCard does not throw: a read failure comes back as
            // `success: false` with the reason (the CardSpawnLogic contract).
            const payload = readCharaCard(path.join(this._cardDir, fileName));
            cardFileName = fileName;
            if (!payload.success) {
                readFailure = payload.error;
                break;
            }
            card = payload.card;
            break;
        }
        if (cardFileName === null) {
            throw new CardNotFoundError(id);
        }
        if (card === null) {
            throw new CardNotReadableError(id, readFailure);
        }

        const persona = effectivePersonaFor(card);
        if (!persona.includes(USER_TOKEN)) {
            throw new CardUserTokenAbsentError(id);
        }

        const name = effectiveCardName(card, id);
        const messages = [
            { role: 'system', content: this._buildSystemPrompt() },
            { role: 'user', content: this._buildUserPrompt(name, persona) }
        ];
        const startedAt = performance.now();
        const completion = await this._llm.chatFull(messages, {
            max_tokens: LLM_CARD_USER_RELATIONSHIP_MAX_TOKENS,
            // `temperature: null` is the seam's explicit opt-out: the field
            // is not sent, so the provider's own sampling default applies.
            temperature: null
        });
        const latencyMs = Math.round(performance.now() - startedAt);

        const judgment = this._parseJudgment(completion.content, id);
        const judgedAt = new Date().toISOString(); // UTC ISO-8601 (P-6)
        const record = {
            version: SIDECAR_VERSION,
            cardId: id,
            name,
            personaHash: personaHashFor(name, persona),
            judgedAt,
            relationship: {
                label: judgment.label,
                summary: judgment.summary
            }
        };
        // A stale verdict at this path (a previous judgment of a persona that
        // no longer exists on disk) must not survive the re-write: delete it
        // first, then the atomic tmp->rename writes the fresh verdict (P-3, CHG-6
        // — derived data is deleted, not kept). The delete is a no-op when
        // nothing is there and is synchronous, so nothing can read the sidecar
        // half-replaced.
        deleteCardUserRelationshipFile(sidecarPathFor(this._cardDir, cardFileName));
        writeCardUserRelationshipFile(sidecarPathFor(this._cardDir, cardFileName), record);
        this._sweepOrphanSidecars(cardFiles);

        // OBS-3: kind, version, card, latency, lengths — never the content.
        const promptChars = messages.reduce((acc, m) => acc + String(m.content ?? '').length, 0);
        Logger.info(
            `card-user-relationship judgment: card="${id}" model="${completion.model ?? 'unknown'}" finishReason="${completion.finishReason ?? 'unknown'}" latencyMs=${latencyMs} promptChars=${promptChars} responseChars=${String(completion.content ?? '').length}`
        );

        return Object.freeze({
            card: Object.freeze({ cardId: id, name }),
            relationship: Object.freeze({
                label: judgment.label,
                summary: judgment.summary
            }),
            judgedAt,
            meta: Object.freeze({
                promptKind: PROMPT_KIND,
                promptVersion: PROMPT_VERSION,
                model: completion.model ?? null,
                finishReason: completion.finishReason ?? null,
                latencyMs
            })
        });
    }

    /**
     * The system prompt (RP-1/RP-2: the kind and version are stated in it).
     * @private
     * @returns {string}
     */
    _buildSystemPrompt() {
        return (
            `You are the relationship judge of slopSimulacrum, a persistent, data-driven world simulation. ` +
            `This is prompt kind \`${PROMPT_KIND}\` version ${PROMPT_VERSION}.\n\n` +
            `A character card describes the NPC the world would build. The persona text in the message below is ` +
            `the exact text that NPC would carry, and it may mention {{user}} - the placeholder the world replaces ` +
            `with the name of the person the character talks to.\n\n` +
            `Judge which relationship this character has with {{user}}, based only on the persona text given. ` +
            `Do not invent facts the text does not support.\n\n` +
            `Respond with a single JSON object and nothing else (no markdown, no code fence, no commentary):\n` +
            `{
  "label": a short free-form label naming the relationship, at most 3 words (for example "devoted partner", "furious rival", "distant stranger"),
  "summary": one short plain-text sentence (at most 200 characters) stating the relationship and what in the persona grounds it
}`
        );
    }

    /**
     * The user prompt: the card's name and its effective persona, in full —
     * no cap. The LLM behind this endpoint is a local reasoning model with
     * ample context, and a truncated persona degrades the judgment (the
     * operator saw exactly that on a long card); the token check and the
     * persona hash always ran on the full text, so nothing about the
     * verdict's grounding changes.
     * @private
     * @param {string} name
     * @param {string} persona
     * @returns {string}
     */
    _buildUserPrompt(name, persona) {
        return `Character name: ${name}\n\nPersona text:\n${persona}`;
    }

    /**
     * Validate the model answer (T-1 — trust the boundary): parse a single
     * JSON object (a code fence is tolerated and stripped — the model does it
     * sometimes), then enforce the contract — a non-empty trimmed label
     * within `RELATIONSHIP_LABEL_MAX_CHARS`, and a non-empty trimmed summary
     * within `RELATIONSHIP_SUMMARY_MAX_CHARS`. Every failure throws
     * `RelationshipJudgmentError` naming the violated rule (E-4).
     * @private
     * @param {string|undefined} content
     * @param {string} cardId
     * @returns {{label: string, summary: string}}
     */
    _parseJudgment(content, cardId) {
        let text = String(content ?? '').trim();
        if (text.startsWith('```')) {
            // Fence-tolerant (the agent-body-design validator does the same):
            // drop the fence lines, keep the inner JSON.
            const lines = text.split('\n');
            if (lines.length >= 3) {
                text = lines.slice(1, -1).join('\n').trim();
            }
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            throw new RelationshipJudgmentError(cardId, [
                'the answer is not a single JSON object: it did not parse'
            ]);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new RelationshipJudgmentError(cardId, [
                'the answer must be a single JSON object'
            ]);
        }

        const violations = [];
        const label = typeof parsed.label === 'string' ? parsed.label.trim() : '';
        if (label === '') {
            violations.push('"label" must be a non-empty string');
        } else {
            if (label.length > RELATIONSHIP_LABEL_MAX_CHARS) {
                violations.push(`"label" must be at most ${RELATIONSHIP_LABEL_MAX_CHARS} characters`);
            }
            if (label.split(/\s+/).filter(Boolean).length > RELATIONSHIP_LABEL_MAX_WORDS) {
                violations.push(`"label" must be at most ${RELATIONSHIP_LABEL_MAX_WORDS} words`);
            }
        }
        const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
        if (summary === '') {
            violations.push('"summary" must be a non-empty string');
        } else if (summary.length > RELATIONSHIP_SUMMARY_MAX_CHARS) {
            violations.push(`"summary" must be at most ${RELATIONSHIP_SUMMARY_MAX_CHARS} characters`);
        }
        if (violations.length > 0) {
            throw new RelationshipJudgmentError(cardId, violations);
        }
        return { label, summary };
    }

    /**
     * Housekeeping on the command path (CR API-1 — never on a read): delete
     * sidecars whose card file is gone or was renamed (orphaned derived
     * data; CHG-6 says delete, don't keep — a sidecar is not user content,
     * P-7). Sidecars of cards that still exist are left alone even when
     * stale: the next judgment for that card overwrites them.
     * @private
     * @param {Array<string>} cardFiles - The current PNG names (already listed).
     */
    _sweepOrphanSidecars(cardFiles) {
        const cardStems = new Set(
            cardFiles.map((n) => path.basename(n, path.extname(n)))
        );
        for (const sidecarName of listCardUserRelationshipFileNames(this._cardDir)) {
            const stem = sidecarName.slice(0, -SIDECAR_SUFFIX.length);
            if (cardStems.has(stem)) {
                continue;
            }
            try {
                if (deleteCardUserRelationshipFile(path.join(this._cardDir, sidecarName))) {
                    Logger.info(`card-user-relationship: deleted orphaned sidecar ${sidecarName}`);
                }
            } catch (err) {
                // A failed cleanup of derived data is not fatal: the next
                // judgment sweeps again.
                Logger.warn(`card-user-relationship: could not delete orphaned sidecar ${sidecarName}: ${err && err.message}`);
            }
        }
    }
}

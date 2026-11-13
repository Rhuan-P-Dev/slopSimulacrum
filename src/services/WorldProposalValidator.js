/**
 * WorldProposalValidator — the rules a proposal must pass before it may become a package.
 *
 * A proposal is the shape `WorldAuthoringController` receives from the model through the
 * `propose_mod` tool: a package id, a sentence for the manifest, and per-kind content.
 * This module is the single place that decides whether that object is allowed to be
 * written, and it is called twice — once when the model proposes (so the model can be
 * told what it got wrong and fix it inside the same conversation), and once when the
 * operator clicks Write (the world may have moved in between, `T-1`: nothing trusts an
 * earlier answer).
 *
 * WHAT IT CHECKS, and why each one is here and not elsewhere:
 *   - the id rules (`SEC-7`): a slug is normalised to `system-<slug>`, so every package
 *     this feature owns is recognisable in `GET /mods` next to the shipped `core-*` ones;
 *   - the kind allowlist: `rooms` and `worldObjects` ARE authored here now — a new room
 *     and a new prop are content, and an applied room becomes part of the running map
 *     additively (`wiki/decisions/world-structure-authoring.md`). `world` and
 *     `worldRules` are still refused: one is the shape the world is wrapped in and the
 *     other installs listeners, neither of which a proposal can reason about; they stay a
 *     hand decision with different rules.
 *   - the shape caps (`SEC-2`, `A-7`): kinds, definitions, depth and bytes, all named;
 *   - unsafe keys (`ModLoader` refuses them, and a proposal that would be rejected at
 *     the next rescan is rejected here instead);
 *   - the world's OWN composition rules: the proposal is merged onto a snapshot of the
 *     live definition and handed to `classifyComposition` — the same classifier `POST
 *     /mods/plan` runs. Any definition of the proposal that would be quarantined is an
 *     error here, with the owner's own reason.
 *
 * WHAT IT DOES NOT DO. It writes nothing (`ModPackageWriter` does), it does not apply
 * anything (`ModService` does, at the round boundary), and it does not re-check anything
 * downstream: after this returns, the value is narrowed and frozen and a caller never
 * re-guards it (`T-2`).
 *
 * OVERRIDES ARE REPORTED, NOT REFUSED. Shadowing an official definition is the mod
 * system's own mechanism (`wiki/decisions/mod-system.md`, decision 5), so a proposal that
 * redefines `knife` is legal — but the operator reads `overrides` before clicking Write,
 * because "the System changed the shipped knife" is not something to discover later.
 *
 * @module WorldProposalValidator
 */

import Logger from '../utils/Logger.js';
import { GameError } from '../utils/CustomErrors.js';
import classifyComposition from './CompositionClassifier.js';
import { REGISTRY_KIND_LIST, REGISTRY_KINDS, isRegistryKind } from '../../shared/RegistryKinds.js';
import { MOD_ID_PATTERN, OFFICIAL_ID_PREFIX } from './ModLoader.js';
import { DEFAULT_PACKAGE_VERSION } from './ModPackageWriter.js';

/**
 * Kinds a proposal may never author.
 *
 * `rooms` and `worldObjects` used to be in this list, and are not any more: a room and a
 * prop are definitions, and a definition that describes a place is no more dangerous than
 * one that describes a component — provided the shape rules are the same rules the world
 * enforces at boot. They are: `WorldStructureRules`, run through `classifyComposition`
 * below, so a room that would refuse to load tomorrow is refused in this conversation
 * today, with the same sentence.
 *
 * What stays refused is the two kinds a proposal cannot reason about. `world` is the shape
 * the world is wrapped in, not something inside it; `worldRules` install listeners, which
 * is behavior — and a data-only proposal that could install behavior would be a different
 * security story than the one this feature tells (`wiki/decisions/mod-system.md`,
 * decision 1). Both remain a hand edit with different rules.
 */
export const NON_AUTHORABLE_KINDS = Object.freeze([
    REGISTRY_KINDS.WORLD,
    REGISTRY_KINDS.WORLD_RULES
]);

/**
 * Everything else, in `REGISTRY_KIND_LIST` order (never in manifest order, `D-*`).
 * @type {Array<string>}
 */
export const AUTHORABLE_KINDS = Object.freeze(
    REGISTRY_KIND_LIST.filter((kind) => !NON_AUTHORABLE_KINDS.includes(kind))
);

/** Every limit a proposal is measured against. Named, not inline (`SEC-2`, `API-5`). */
export const PROPOSAL_LIMITS = Object.freeze({
    /** Kinds one proposal may touch. More than this is several wishes, not one. */
    MAX_KINDS: 6,
    /** Definitions one kind receives from one proposal. */
    MAX_DEFINITIONS_PER_KIND: 30,
    /** How deep one definition may nest before it is a dump, not a recipe. */
    MAX_DEFINITION_DEPTH: 8,
    /** Serialised size of all the content together. */
    MAX_CONTENT_BYTES: 120_000,
    /** Description (manifest prose) length. */
    MAX_DESCRIPTION_CHARS: 300,
    /** Rationale (the model's own sentence about the wish) length. */
    MAX_RATIONALE_CHARS: 800,
    /** Prefix every package of this feature carries. */
    PACKAGE_ID_PREFIX: 'system-'
});

/** Machine-readable codes. */
export const PROPOSAL_ERROR_CODES = Object.freeze({
    INVALID: 'PROPOSAL_INVALID',
    NOT_SET: 'PROPOSAL_NOT_SET'
});

/**
 * A proposal that failed the rules. `errors` is the rule list — it goes back to the
 * model as a tool result (so it can correct itself) and to the operator as the reason
 * Write would refuse (`E-1`, `E-4`).
 */
export class ProposalValidationError extends GameError {
    /**
     * @param {Array<string>} errors - every rule that failed, not only the first
     * @param {Error|null} [cause]
     */
    constructor(errors = [], cause = null) {
        super(`The proposed mod package failed validation: ${errors.join('; ')}`, PROPOSAL_ERROR_CODES.INVALID, cause);
        this.name = 'ProposalValidationError';
        /** @type {Array<string>} */
        this.errors = errors;
    }
}

/**
 * Narrow a model-chosen slug into the package id this feature uses.
 *
 * The model proposes a name; the SERVER decides the identity, exactly as
 * `AgentBodyController` takes the blueprint id from the card rather than from the
 * model (`T-1`). A slug that is not a slug at all is an error, not a sanitising
 * rewrite — silently turning `My Cool Droids!!` into something else would make the
 * id the operator reads disagree with the id the model said.
 *
 * @param {unknown} raw
 * @returns {string} e.g. `salvage-hauler` -> `system-salvage-hauler`
 * @throws {ProposalValidationError}
 */
export function normalizePackageId(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        throw new ProposalValidationError(['"packageId" is required (a short lowercase slug)']);
    }
    const slug = raw.trim().toLowerCase();
    if (!MOD_ID_PATTERN.test(slug)) {
        throw new ProposalValidationError([
            `"packageId" "${raw}" is not a slug: letters, digits, dot, dash or underscore, starting with a letter or digit, up to 64 chars`
        ]);
    }
    if (slug.startsWith(OFFICIAL_ID_PREFIX) || slug.startsWith(PROPOSAL_LIMITS.PACKAGE_ID_PREFIX)) {
        return slug;
    }
    return `${PROPOSAL_LIMITS.PACKAGE_ID_PREFIX}${slug}`;
}

/**
 * True for the plain object shape (arrays and null are values, not containers).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keys that are never data and never a definition (`ModLoader` UNSAFE_KEYS, same rule).
 * Checked at BOTH levels: a definition keyed `__proto__` is as poisoned as a definition
 * carrying one, and `JSON.parse` makes it an own key, so `Object.entries` does see it.
 */
const UNSAFE_KEY_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * The first unsafe key anywhere under `value`, with its location. `ModLoader` refuses a
 * whole package carrying one, so a proposal that would be rejected at the next rescan is
 * refused now, where the model can still be told.
 * @param {unknown} value
 * @param {string} at
 * @param {number} depth
 * @returns {{ key: string, depth: number }|null}
 */
function findDeepProblem(value, at, depth = 1) {
    if (depth > PROPOSAL_LIMITS.MAX_DEFINITION_DEPTH) {
        return { key: at, depth };
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const hit = findDeepProblem(value[i], `${at}[${i}]`, depth + 1);
            if (hit) return hit;
        }
        return null;
    }
    if (!isPlainObject(value)) return null;
    for (const [key, child] of Object.entries(value)) {
        if (UNSAFE_KEY_NAMES.includes(key)) {
            return { key: `${at}/${key}`, depth };
        }
        const hit = findDeepProblem(child, `${at}/${key}`, depth + 1);
        if (hit) return hit;
    }
    return null;
}

/**
 * A snapshot of the live definition the world runs, per kind. `RegistryStore.read`
 * answers for the kinds the store holds; the rest read as empty, which is what an
 * absent registry means to a merge anyway.
 * @param {import('./RegistryStore.js').RegistryStore} registryStore
 * @returns {Object.<string, Object>}
 */
function liveRegistries(registryStore) {
    const live = {};
    for (const kind of REGISTRY_KIND_LIST) {
        const content = registryStore && typeof registryStore.read === 'function' && registryStore.has(kind)
            ? registryStore.read(kind)
            : {};
        live[kind] = isPlainObject(content) ? content : {};
    }
    return live;
}

/**
 * Validate a proposal and return the frozen, canonical value everything downstream uses.
 *
 * @param {unknown} proposal - raw object from the model (or from a session's stored
 *   proposal at Write time — the same rules run again, nothing is trusted).
 * @param {Object} deps
 * @param {import('./RegistryStore.js').RegistryStore} deps.registryStore - the live
 *   definition, used for the override report and for the candidate check.
 * @returns {Readonly<{
 *   kind: 'mod-proposal', packageId: string, version: string, description: string,
 *   rationale: string, content: Object.<string, Object>,
 *   added: Array<{ kind: string, key: string }>,
 *   overrides: Array<{ kind: string, key: string }>,
 *   stats: { kinds: number, definitions: number }
 * }>}
 * @throws {ProposalValidationError} every failed rule, in one list
 */
export function validateProposal(proposal, { registryStore } = {}) {
    if (!isPlainObject(proposal)) {
        throw new ProposalValidationError(['the proposal must be a JSON object']);
    }
    const errors = [];
    const packageId = (() => {
        try {
            return normalizePackageId(proposal.packageId);
        } catch (error) {
            if (error instanceof ProposalValidationError) {
                errors.push(...error.errors);
                return null;
            }
            throw error;
        }
    })();

    const description = typeof proposal.description === 'string' ? proposal.description.trim() : '';
    if (description.length === 0) {
        errors.push('"description" is required — one sentence naming what this package adds');
    }
    if (description.length > PROPOSAL_LIMITS.MAX_DESCRIPTION_CHARS) {
        errors.push(`"description" is over ${PROPOSAL_LIMITS.MAX_DESCRIPTION_CHARS} chars`);
    }
    const rationale = typeof proposal.rationale === 'string' ? proposal.rationale.trim() : '';
    if (rationale.length > PROPOSAL_LIMITS.MAX_RATIONALE_CHARS) {
        errors.push(`"rationale" is over ${PROPOSAL_LIMITS.MAX_RATIONALE_CHARS} chars`);
    }

    const rawContent = proposal.content;
    if (!isPlainObject(rawContent) || Object.keys(rawContent).length === 0) {
        errors.push('"content" is required — an object of { registryKind: { key: definition } }');
    }

    const content = {};
    const added = [];
    const overrides = [];
    if (isPlainObject(rawContent) && Object.keys(rawContent).length > 0) {
        const kindKeys = Object.keys(rawContent);
        if (kindKeys.length > PROPOSAL_LIMITS.MAX_KINDS) {
            errors.push(`"content" touches ${kindKeys.length} kinds; ${PROPOSAL_LIMITS.MAX_KINDS} is the cap`);
        }
        let totalBytes = 0;
        for (const kind of kindKeys) {
            if (!isRegistryKind(kind)) {
                errors.push(`"${kind}" is not a registry kind`);
                continue;
            }
            if (NON_AUTHORABLE_KINDS.includes(kind)) {
                errors.push(`"${kind}" is world structure and is never authored here — only hand edits change the map and the world rules`);
                continue;
            }
            const definitions = rawContent[kind];
            if (!isPlainObject(definitions) || Object.keys(definitions).length === 0) {
                errors.push(`"${kind}" must hold at least one definition`);
                continue;
            }
            if (Object.keys(definitions).length > PROPOSAL_LIMITS.MAX_DEFINITIONS_PER_KIND) {
                errors.push(`"${kind}" proposes ${Object.keys(definitions).length} definitions; ${PROPOSAL_LIMITS.MAX_DEFINITIONS_PER_KIND} is the cap`);
                continue;
            }
            let kindBytes = 0;
            let rejectedHere = false;
            const kindContent = {};
            const live = liveOf(registryStore, kind);
            for (const [key, value] of Object.entries(definitions)) {
                // The definition key itself first: `__proto__` as a key is the poison, not
                // the value under it, and `findDeepProblem` walks the value.
                if (UNSAFE_KEY_NAMES.includes(key)) {
                    errors.push(`"${kind}/${key}" is not a data key`);
                    rejectedHere = true;
                    continue;
                }
                const problem = findDeepProblem(value, `${kind}/${key}`);
                if (problem) {
                    errors.push(
                        problem.depth > PROPOSAL_LIMITS.MAX_DEFINITION_DEPTH
                            ? `"${problem.key}" nests deeper than ${PROPOSAL_LIMITS.MAX_DEFINITION_DEPTH} levels`
                            : `"${problem.key}" is not a data key`
                    );
                    rejectedHere = true;
                    continue;
                }
                kindContent[key] = value;
                kindBytes += (JSON.stringify(value) ?? '').length + key.length;
                if (Object.prototype.hasOwnProperty.call(live, key)) {
                    overrides.push({ kind, key });
                } else {
                    added.push({ kind, key });
                }
            }
            totalBytes += kindBytes;
            if (rejectedHere) continue;
            if (Object.keys(kindContent).length === 0) continue;
            content[kind] = kindContent;
        }
        if (totalBytes > PROPOSAL_LIMITS.MAX_CONTENT_BYTES) {
            errors.push(`the content is ${totalBytes} bytes; ${PROPOSAL_LIMITS.MAX_CONTENT_BYTES} is the cap`);
        }
    }

    // The world's own rules, on the candidate an apply would build: live definition +
    // this proposal. A definition the classifier would quarantine is a rule violation
    // the model can fix, so it surfaces here and not three clicks later.
    if (Object.keys(content).length > 0 && errors.length === 0) {
        const candidate = structuredClone(liveRegistries(registryStore));
        for (const [kind, definitions] of Object.entries(content)) {
            candidate[kind] = { ...candidate[kind], ...structuredClone(definitions) };
        }
        const { quarantined } = classifyComposition(candidate);
        for (const entry of quarantined) {
            if (!content[entry.kind]) continue;
            const mine = entry.key === '*'
                ? Object.keys(content[entry.kind])
                : (content[entry.kind][entry.key] === undefined ? [] : [entry.key]);
            if (mine.length === 0) continue;
            errors.push(`${entry.kind} ${mine.join(', ')}: ${entry.reason}`);
        }
    }

    if (errors.length > 0) {
        throw new ProposalValidationError(errors);
    }

    const orderedContent = {};
    for (const kind of REGISTRY_KIND_LIST) {
        if (content[kind]) orderedContent[kind] = structuredClone(content[kind]);
    }
    const definitions = Object.values(orderedContent).reduce((sum, kind) => sum + Object.keys(kind).length, 0);
    Logger.info(
        `[WorldProposalValidator] proposal "${packageId}" accepted: `
        + `${Object.keys(orderedContent).length} kind(s), ${definitions} definition(s), `
        + `${added.length} new, ${overrides.length} overriding`
    );

    return Object.freeze({
        kind: 'mod-proposal',
        packageId,
        version: DEFAULT_PACKAGE_VERSION,
        description,
        rationale,
        content: Object.freeze(
            Object.fromEntries(Object.entries(orderedContent).map(([kind, defs]) => [kind, Object.freeze(structuredClone(defs))]))
        ),
        added: Object.freeze(added.map((entry) => Object.freeze({ ...entry }))),
        overrides: Object.freeze(overrides.map((entry) => Object.freeze({ ...entry }))),
        stats: Object.freeze({ kinds: Object.keys(orderedContent).length, definitions })
    });
}

/**
 * The live definitions of one kind, or an empty object.
 * @param {import('./RegistryStore.js').RegistryStore} registryStore
 * @param {string} kind
 * @returns {Object}
 */
function liveOf(registryStore, kind) {
    if (!registryStore || typeof registryStore.read !== 'function' || !registryStore.has(kind)) return {};
    const content = registryStore.read(kind);
    return isPlainObject(content) ? content : {};
}

export default validateProposal;

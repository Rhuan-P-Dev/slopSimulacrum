/**
 * AgentBodyController — body designer for the "Create Agent Body" dev tab
 * (Feature A, RP-1).
 *
 * Given a character card (PNG under data/cards/ with the identity side-channel:
 * name, description, personality) and the world's body vocabulary (components,
 * materials, organs, items, example blueprints), it:
 *   1. runs the design as a PIPELINE of four stages (AgentBodyDesignPipeline):
 *      concept -> anatomy -> organs -> outfit. Each stage is one LLM call in a
 *      FRESH context whose input is the previous stage's validated output, so
 *      no single prompt has to carry the whole anatomy spec, the organ law and
 *      the clothing law at once (the v1.6.0 monolith is where a precision model
 *      started dropping rules).
 *   2. calls the provider through the injected LLMController (the sole LLM
 *      seam, CR B-2 — this controller never fetches the provider itself).
 *   3. re-validates the COMPOSED body monolithically against the shared rules
 *      (AgentBodyDesignRules — the same law the stages used, so the stage law
 *      and the save law cannot drift), as the final safety net against a
 *      cross-stage inconsistency.
 *   4. returns a frozen design with the per-stage prompt records captured for
 *      inspection (meta.stages); the blueprint id is the card's display name
 *      (name field, stem fallback) — the model never chooses it; saveDesign
 *      persists that design as a mod package and spawnCards later match the
 *      world's droid type to the card by name.
 *
 * PROGRESS: the pipeline reports one event per stage attempt (started /
 * retrying / succeeded / failed) to its injected reporter; the server wires
 * that reporter to the AGENT_BODY_DESIGN_STEP socket event (H-6: the name
 * lives in shared/SocketProtocol.js), so the dev panel shows each stage as it
 * runs, including WHY a stage is trying again (the violated rules or the
 * transport failure that cost the attempt).
 *
 * RETRY DISCIPLINE (E-6): a validation failure is a corrective retry (the
 * violated rules ride into the next attempt's prompt); a transient transport
 * failure (timeout, network, corrupt envelope, HTTP 429/5xx) is retried with
 * exponential backoff + jitter; a 4xx answer is the provider refusing the
 * request and is not retried. Details and constants live with the pipeline.
 *
 * saveDesign (unchanged contract): persists a validated design as ONE data-only
 * mod package, `data/mods/body-<slug>/`, through `ModPackageWriter`: the body
 * tree as the `blueprints` kind (the droid-type pointer + each component's
 * sub-tree), the invented part recipes as `components`, the new organs as
 * `internalComponents`, the garments as `inventoryItems`, and what the body
 * wears as `outfits`. The official `core-*` packages are NEVER written — a
 * designed body is an overlay next to the shipped world, and disabling the
 * package is what undoes it. Every file a rewrite replaces is backed up by the
 * writer before it is touched.
 *
 * designBody itself stays display-only (it never writes); persistence is the
 * explicit saveDesign action, which re-validates and then writes through the
 * data seam (CR B-3). Writing a package and changing the world are two acts:
 * this module never enables, orders or applies anything (`ModService` owns
 * those), so a saved body reaches a running world only through
 * `POST /mods/apply`. The LLM cost-guard still applies: per-IP rate limiter in
 * src/routes/agentBodyRoutes.js (SEC-9); the per-stage token budgets live with
 * the pipeline (the anatomy stage — structure plus recipes — is the heavy
 * one). The LLM timeout is the seam's REQUEST_TIMEOUT_MS (env LLM_TIMEOUT_MS),
 * matching /llm/chat — no second timeout knob. A designed mount carries what
 * hangs behind its cloth: a node may declare `hidesWithParent`, and `saveDesign`
 * writes it as the third element of the blueprint mount
 * (`["maleBreast", "left", { "hidesWithParent": true }]`), the shape the live
 * world already reads to take a part out of the round prose when the part it
 * hangs on is covered (`PerceptionController._coveredIds`). A designed body
 * can also arrive dressed: `garments` are new wearable item recipes (the
 * package's `inventoryItems` kind) and `outfit` says what is worn, on which
 * component of THIS body (the package's `outfits` kind). SPEAKING about
 * clothing is itself the claim: an authored empty outfit means born wearing
 * nothing, while saying nothing leaves the world's default clothing in force
 * (`src/controllers/logic/OutfitLogic.js`).
 *
 * See wiki/decisions/agent-body-design.md and wiki/decisions/outfits.md.
 *
 * The cards-directory listing is read lazily and held on the instance
 * (`this._cardFiles`): the Cards screen fetches one image per card and every
 * read is matched against that listing, so opening it costs one `readdirSync`
 * no matter how many cards it holds. `listCards` refreshes the cache (the
 * listing is read-only truth when the gallery opens); the per-card reads
 * (`readCardImage`, `designBody`) reuse it, which removes the one-dir-read
 * per-card N+1 the gallery used to run.
 *
 * @module src/controllers/networking/AgentBodyController
 */

import AgentBodyDesignPipeline from './AgentBodyDesignPipeline.js';
import {
    isSlug,
    walkStructure,
    validateOrganDefinition,
    validateComponentRecipe,
    validateGarments,
    validateOutfit,
    validateDesignEffects,
    normalizeDesign,
    MAX_BODY_NODES,
    MAX_IC_RECIPES
} from './AgentBodyDesignRules.js';
import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import ModPackageWriter, { DEFAULT_PACKAGE_VERSION } from '../../services/ModPackageWriter.js';
import { readCardFiles } from '../../controllers/logic/CardSpawnLogic.js';
import { readCharaCard, readCardFileBytes } from '../../utils/PngCharaReader.js';
import path from 'node:path';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';

/**
 * The identifier `entityController.expandBlueprint` itself gives a mount that
 * authored no slot (the bare-`"type"` entry). A marked mount with no slot says
 * it explicitly, because the options object is the THIRD element of the mount
 * and there is no fourth way to reach it — the mark never invents a slot.
 */
const DEFAULT_MOUNT_SLOT = 'default';
const MAX_CARD_ID_LENGTH = 128;

/**
 * Content type for each image extension `readCardFiles` accepts (CARD_IMAGE_EXTS
 * in src/controllers/logic/CardSpawnLogic.js). Frozen read-only table (`T-8`):
 * the route reads `mimeType` from the controller answer and sends it to the
 * browser; it is a routing detail, never world state.
 */
const IMAGE_CONTENT_TYPES = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp'
});

/**
 * What a saved body is called on disk: `data/mods/body-<slug>/`. The prefix marks the
 * package as the output of THIS feature (a hand-written overlay like `custom-appearance`
 * keeps its own name), and `ModPackageWriter` refuses the reserved `core-` prefix, so a
 * designed body can never be written into the shipped world.
 */
const PACKAGE_ID_PREFIX = 'body-';
/**
 * `MOD_ID_PATTERN` caps a package id at 64 characters, so the slug gets what is left
 * after the prefix. Truncating is deliberate: a card display name is prose ("Nova,
 * seamstress of the lower ward"), and a package directory never inherits a paragraph.
 */
const PACKAGE_SLUG_MAX_CHARS = 64 - PACKAGE_ID_PREFIX.length;
/** A slug the writer will accept: one lowercase segment of letters, digits and dashes. */
const PACKAGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** The `x.y.z` the writer wrote last time, so a rewrite can advance the patch number. */
const PACKAGE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Thrown when cardId does not match any card PNG under data/cards/.
 */
class CardNotFoundError extends Error {
    /**
     * @param {string} cardId - the requested card stem that was not found.
     * @param {Error|null} [cause] - underlying error.
     */
    constructor(cardId, cause = null) {
        super('AgentBodyController: no card PNG named "' + cardId + '" in data/cards/', { cause });
        this.name = 'CardNotFoundError';
        this.code = 'CARD_NOT_FOUND';
        this.cardId = cardId;
    }
}

/**
 * Thrown when the model output of the agent body design fails validation.
 * `errors` carries one message per violated rule (a pipeline failure is
 * prefixed with the step that produced it).
 */
class DesignValidationError extends Error {
    /**
     * @param {string} cardId - the card the design was attempted for.
     * @param {string[]} errors - violated validation rules.
     * @param {Error|null} [cause] - underlying error.
     */
    constructor(cardId, errors, cause = null) {
        super('AgentBodyController: design for card "' + cardId + '" failed validation: ' + errors.join('; '), { cause });
        this.name = 'DesignValidationError';
        this.code = 'BODY_DESIGN_INVALID';
        this.cardId = cardId;
        this.errors = [...errors];
    }
}

export { CardNotFoundError, DesignValidationError, MAX_CARD_ID_LENGTH };

/**
 * Trimmed card field from the embedded identity, or '' when absent.
 * @param {Object|null} card - card object from readCharaCard (or null).
 * @param {string} field
 * @returns {string}
 */
function cardString(card, field) {
    return (card && typeof card[field] === 'string') ? card[field].trim() : '';
}

/**
 * Card display name, falling back to the card stem when the embedded name is
 * missing or blank.
 * @param {Object|null} card
 * @param {string} cardId
 * @returns {string}
 */
function cardName(card, cardId) {
    return (card && typeof card.name === 'string' && card.name.trim().length > 0) ? card.name.trim() : cardId;
}

class AgentBodyController {
    /**
     * @param {{
     *   llmController: { chatFull: (messages: object[], options?: object) => Promise<object> },
     *   packageWriter?: { writePackage: (spec: object) => object, readManifest: (id: string) => object|null, packageDir: (id: string) => string },
     *   pipeline?: { run: (identity: object) => Promise<object> },
     *   stepReporter?: (event: object) => void
     * }} options
     *   - options.llmController: the LLM seam (CR B-2). The caller's own LLMController
     *     instance is injected so provider config follows the host process; the
     *     pipeline it drives is built from it unless `pipeline` is given (tests).
     *   - options.packageWriter: `ModPackageWriter` by default. It is the module that owns
     *     putting package bytes on disk, so it is injected rather than reimplemented here;
     *     a test hands in a spy and sees exactly the package the design became.
     *   - options.stepReporter: receives the pipeline's progress events (one per
     *     stage attempt). The server wires it to the AGENT_BODY_DESIGN_STEP socket
     *     event (H-6); the default is a no-op, so the controller stays usable
     *     without a live channel.
     */
    constructor({ llmController, packageWriter = new ModPackageWriter(), pipeline = null, stepReporter = null }) {
        if (!llmController || typeof llmController.chatFull !== 'function') {
            throw new TypeError('AgentBodyController: "llmController" must expose chatFull (the LLM seam, CR B-2)');
        }
        if (!packageWriter || typeof packageWriter.writePackage !== 'function') {
            throw new TypeError('AgentBodyController: "packageWriter" must expose writePackage (the package seam, CR B-3)');
        }
        this.llmController = llmController;
        this.packageWriter = packageWriter;
        // Vocabulary is loaded once per process (B-3 data seam; data files are
        // static within a run). Frozen so the stage prompts are stable across
        // calls.
        this.components = this._loadComponents();
        this.materials = this._loadMaterials();
        this.organs = this._loadOrgans();
        this.items = this._loadItems();
        this.existingBlueprints = this._loadBlueprints();
        this.pipeline = pipeline || new AgentBodyDesignPipeline({
            vocabulary: {
                components: this.components,
                materials: this.materials,
                organs: this.organs,
                items: this.items,
                blueprints: this.existingBlueprints
            },
            llmController: this.llmController,
            reporter: (typeof stepReporter === 'function') ? stepReporter : () => {}
        });
        // The cards-directory listing, read lazily (see the module note): the
        // gallery fetches one image per card, so the per-card reads must not
        // each re-read the directory. `null` until the first read.
        this._cardFiles = null;
    }

    // ================================================================
    // Public API
    // ================================================================

    /**
     * Every PNG card in data/cards/, with its embedded identity. Card order
     * is file-system order (fine for a dev picker).
     * @returns {Array<{cardId: string, name: string, description: string, personality: string}>}
     */
    listCards() {
        // The gallery is read-only truth: opening it re-reads the directory, so a
        // card the operator just dropped is seen (and the cache the per-card
        // image reads reuse is the one that is up to date).
        this._cardFiles = null;
        const files = this._listCardFiles();
        return files.map((file) => {
            const result = readCharaCard(file.fullPath);
            const card = (result.success && result.card && typeof result.card === 'object') ? result.card : null;
            return {
                cardId: file.cardId,
                name: cardName(card, file.cardId),
                description: cardString(card, 'description'),
                personality: cardString(card, 'personality')
            };
        });
    }

    /**
     * Raw image bytes of the card matching the given stem — the art itself, not
     * the embedded identity. Reads through the data seam (CR B-3); the
     * returned `mimeType` matches the file's extension so the route sends a
     * correct `Content-Type` instead of guessing.
     *
     * The path never comes from raw request input: `cardId` is matched exactly
     * against the listing of `data/cards/`, and the bytes are read from the
     * `fullPath` that listing owns (`SEC-7` — a traversal in the request is just
     * a non-match; the file path stays inside the base dir by construction).
     *
     * @param {string} cardId - stem of a card file under data/cards/ (no extension).
     * @returns {{ bytes: Buffer, mimeType: string }} the file bytes and their
     *   content type (one of the card image types, `IMAGE_CONTENT_TYPES`, or an
     *   `application/octet-stream` fallback for an unknown extension).
     * @throws {CardNotFoundError} - when no card file matches the id.
     */
    readCardImage(cardId) {
        const file = this._listCardFiles().find((f) => f.cardId === cardId);
        if (!file) {
            throw new CardNotFoundError(cardId);
        }
        const bytes = readCardFileBytes(file.fullPath);
        const ext = path.extname(file.fullPath).toLowerCase().slice(1);
        return { bytes, mimeType: IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream' };
    }

    /**
     * Designs the body of the card whose stem is cardId: runs the four-stage
     * pipeline (concept -> anatomy -> organs -> outfit, one LLM call each,
     * each in a fresh context fed by the previous stage's validated output),
     * then re-validates the composed body monolithically as the final safety
     * net.
     *
     * @param {string} cardId - stem of a card PNG under data/cards/ (no extension).
     * @returns {Promise<{
     *   card: {cardId: string, name: string, description: string, personality: string},
     *   body: {blueprintId: string, rationale: string, structure: object, components: Array, garments: Array, internalComponents: Array, outfit?: Array},
     *   meta: {kind: string, stages: Array<{step: string, kind: string, version: string, model: string, finishReason: string, latencyMs: number, attempts: number, promptMessages: Array}>},
     *   organsByComponent: Object<string, Array<string>>
     * }>}
     * @throws {CardNotFoundError} - no card PNG matches cardId.
     * @throws {DesignValidationError} - a stage (or the monolithic revalidation)
     *   failed on every attempt (rule list in errors, prefixed with the step).
     * @throws {import('../../utils/CustomErrors.js').LLMError} - provider failure
     *   that is not worth retrying (codes: LLM_TIMEOUT, LLM_HTTP_ERROR,
     *   LLM_PARSE_ERROR, LLM_REQUEST_ERROR).
     */
    async designBody(cardId) {
        if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > MAX_CARD_ID_LENGTH) {
            throw new DesignValidationError(String(cardId == null ? 'cardId' : cardId), ['cardId must be a string of 1-128 characters']);
        }

        const file = this._listCardFiles().find((f) => f.cardId === cardId);
        if (!file) {
            throw new CardNotFoundError(cardId);
        }

        const result = readCharaCard(file.fullPath);
        const card = (result.success && result.card && typeof result.card === 'object') ? result.card : null;
        const identity = {
            cardId,
            name: cardName(card, cardId),
            description: cardString(card, 'description'),
            personality: cardString(card, 'personality')
        };

        // The pipeline drives the LLM seam itself (B-2: the injected
        // llmController is the seam; the pipeline holds no socket and no file
        // access of its own). Progress events ride the injected reporter —
        // the server wires that to the AGENT_BODY_DESIGN_STEP socket event.
        // A stage that exhausts its attempts throws DesignStageError (the
        // route maps it to the 422 BODY_DESIGN_INVALID contract); a transport
        // failure that is not worth retrying throws the LLMError as-is (502).
        const { body, stages } = await this.pipeline.run(identity);

        // Final safety net: the stages each validated their own slice; the
        // COMPOSED body is validated monolithically (the same shared rules),
        // so a cross-stage inconsistency cannot reach the panel or the save.
        // cardNameId: true — the pipeline sets blueprintId to the card's
        // display name, which is not a model-invented slug.
        const design = this._validateDesign(body, cardId, { cardNameId: true });

        Logger.info(
            '[AgentBodyController] agent-body-design pipeline for card "' + cardId + '": '
            + stages.map((s) => s.step + ' v' + s.version + ' (' + s.attempts + ' attempt(s), ' + s.latencyMs + ' ms, finish ' + (s.finishReason || 'n/a') + ')').join(', ')
            + ' -> blueprint "' + design.blueprintId + '" (' + this._countNodes(design.structure) + ' nodes, '
            + design.components.length + ' new parts, ' + design.garments.length + ' garments, '
            + design.internalComponents.length + ' organs'
            + (Array.isArray(design.outfit) ? ', ' + design.outfit.length + ' outfit entry(ies)' : ', no clothing claim') + ')'
        );

        return {
            card: identity,
            body: design,
            meta: {
                kind: 'agent-body-design-pipeline',
                stages: stages.map((s) => ({
                    step: s.step,
                    kind: s.kind,
                    version: s.version,
                    model: s.model,
                    finishReason: s.finishReason,
                    latencyMs: s.latencyMs,
                    attempts: s.attempts,
                    promptMessages: s.promptMessages
                }))
            },
            organsByComponent: this._organsByComponent(design)
        };
    }
    /**
     * One design as the panel renders it: the organs (internal components)
     * installed per component name, so the tree can show what is inside each
     * part without re-walking the flat lists. A part the design INVENTED
     * takes the organs its own recipe declares; a part the world already has
     * takes the organs the world's registry declares for it. A part with
     * none is absent from the map (the tree says nothing, not "empty").
     * @private
     * @param {{ structure?: object, components?: Array }} design - validated design.
     * @returns {Object<string, Array<string>>} component name -> organ type names (frozen).
     */
    _organsByComponent(design) {
        const recipeByComponent = new Map();
        if (Array.isArray(design.components)) {
            design.components.forEach((recipe) => {
                if (recipe && typeof recipe.name === 'string') {
                    recipeByComponent.set(recipe.name, recipe);
                }
            });
        }
        const organsByComponent = {};
        const walk = (node) => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return;
            const children = Array.isArray(node.children) ? node.children : [];
            const name = node.component;
            if (typeof name !== 'string' || Object.hasOwn(organsByComponent, name)) {
                // An already-listed part still has a subtree: walk its children
                // so a deeper part (world or new) is not missed.
                children.forEach((child) => walk(child));
                return;
            }
            let organs;
            if (recipeByComponent.has(name)) {
                const recipe = recipeByComponent.get(name);
                organs = Array.isArray(recipe.internalComponents) ? recipe.internalComponents : [];
            } else {
                organs = (this.components[name] && Array.isArray(this.components[name].organs))
                    ? this.components[name].organs
                    : [];
            }
            // A recipe's `internalComponents` may hold { type, grants } objects
            // (the model-side shape); the tree only needs the type names.
            const names = organs
                .map((ic) => (typeof ic === 'string' ? ic : (ic && typeof ic.type === 'string' ? ic.type : null)))
                .filter(Boolean);
            if (names.length > 0) organsByComponent[name] = Object.freeze(names);
            children.forEach((child) => walk(child));
        };
        if (design.structure && typeof design.structure === 'object') {
            walk(design.structure);
        }
        return Object.freeze(organsByComponent);
    }

    /**
     * Persists a validated design as ONE data-only mod package under
     * `data/mods/body-<slug>/` through `ModPackageWriter`. This is the ONLY
     * write path of the feature: designBody is display-only, and applying the
     * package to a running world is `POST /mods/apply` (`ModService`), not
     * this method.
     *
     * The package content follows the mod-system contract (one official
     * `core-*` package per kind; a designed body is an overlay next to it):
     *   - `blueprints`: the body tree — the droid-type pointer plus every component's
     *     sub-tree under its own key. Whatever the design redefines of an existing body
     *     is restated here, which is what re-designing a card means;
     *   - `components`: only the recipes the design INVENTED. A recipe the shipped
     *     registry already publishes is left out, so the package never shadows official
     *     content with a copy of it;
     *   - `inventoryItems`: only the garments the design invented (same rule);
     *   - `internalComponents`: only the organs the design INVENTED. A type the shipped
     *     registry already publishes is left out, so the package never shadows official
     *     content with a copy of it. Written in the world's IC shape — key = type id,
     *     `name` = display name, static `grants`/`grantsFlags`/`volume`, no `overTime`,
     *     no install gate; it installs on the components that name the organ, at spawn.
     *   - `outfits`: present only when the design SPOKE about clothing, keyed by the
     *     same blueprint key as the body. An authored EMPTY list means born wearing
     *     nothing; saying nothing leaves the world's default clothing in force.
     * A kind with nothing in it is omitted, because `ModPackageWriter` refuses an empty
     * one — a package says only what this design authored.
     *
     * Rewriting the same card rewrites the same package (the writer backs up every file
     * it replaces) and advances the manifest patch version, so `GET /mods` can tell a
     * first save from a redesign.
     *
     * This writes bytes; it does not change the world. Enabling, ordering and applying
     * belong to `ModService`, and a running world takes the body at
     * `POST /mods/apply` (or at the next round boundary once a change is pending).
     * Writes go through the data seam (CR B-3): this method touches no `fs` and names no
     * official data file.
     *
     * @param {Object} design - { blueprintId, rationale, structure, components,
     *   garments, internalComponents, outfit } (may be the frozen body from
     *   designBody, or raw model-shape JSON).
     * @returns {{
     *   saved: boolean,
     *   packageId: string,
     *   dir: string,
     *   version: string,
     *   description: string,
     *   created: boolean,
     *   content: string[],
     *   files: string[],
     *   overwritten: string[],
     *   backups: string[],
     *   blueprintId: string,
     *   newComponents: string[],
     *   newOrgans: string[],
     *   newItems: string[],
     *   outfitWritten: boolean,
     *   blueprintWritten: string[],
     *   overlapsOfficial: Array<{ kind: string, key: string }>
     * }}
     * @throws {DesignValidationError} the design failed validation, or its display name
     *   has no ASCII letters or digits to name a package from.
     * @throws {import('../../utils/CustomErrors.js').GameError} one of
     *   `PACKAGE_WRITE_ERROR_CODES`, when the writer refuses the package it was handed.
     */
    async saveDesign(design) {
        const designCard = (design && typeof design.blueprintId === 'string' && design.blueprintId) || 'save';

        // Re-validate. cardNameId: true — the blueprintId is the card's display
        // name (not a model-invented slug), so the slug/collision checks are
        // relaxed to "non-empty string"; overwriting the card's own
        // previously-saved body is intended. Every other rule (shape, components,
        // materials, organs, node/depth cap, distinct droid type) always applies —
        // the distinct-droid-type guard runs inside _validateDesign.
        const normalized = this._validateDesign(design, designCard, { cardNameId: true });

        // Flatten for persistence (the distinct-droid-type guard already ran in
        // _validateDesign).
        const { entries } = this._flattenTree(normalized);
        // The package id first: an inborn effect's id is namespaced by the package it ships
        // in, so the content cannot be built without it.
        const packageId = this._packageIdFor(normalized.blueprintId);
        const { content, overlapsOfficial } = this._packageContent(normalized, entries, packageId);

        const report = this.packageWriter.writePackage({
            id: packageId,
            version: this._nextPackageVersion(packageId),
            description: 'Body designed from the "' + normalized.blueprintId
                + '" character card in the "Create Agent Body" dev tab.',
            content
        });

        Logger.info(`[AgentBodyController] design "${normalized.blueprintId}" written as package ` 
            + `"${report.packageId}" (${report.content.join(', ')})${report.created ? '' : ', rewritten'}` 
            + `${overlapsOfficial.length ? `; ${overlapsOfficial.length} key(s) the official packages also define` : ''}` 
            + '; not applied');

        return Object.freeze({
            // saved, packageId, dir, version, description, content, files, created,
            // overwritten, backups — the writer's own report of the bytes it put down.
            ...report,
            blueprintId: normalized.blueprintId,
            newComponents: Object.keys(content[REGISTRY_KINDS.COMPONENTS] ?? {}),
            newOrgans: Object.keys(content[REGISTRY_KINDS.INTERNAL_COMPONENTS] ?? {}),
            newItems: Object.keys(content[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {}),
            // True when the design SPOKE about clothing (even `outfit: []` = born
            // wearing nothing). False means no claim was made and the world's default
            // clothing still applies to this body.
            outfitWritten: Array.isArray(normalized.outfit),
            // Every blueprint key this package defines: the droid-type pointer plus one
            // per component of this body that has children.
            blueprintWritten: Object.keys(entries),
            overlapsOfficial
        });
    }

    // ================================================================
    // Save helpers (used only by saveDesign)
    // ================================================================

    /**
     * Flatten the normalized nested body tree into the flat blueprint-registry
     * format used by data/mods/core-blueprints/blueprints.json:
     *   - the droid-type key holds a single [rootComponent] pointer;
     *   - every component that has children holds its direct children as
     *     [comp, slot?] items under its OWN key.
     * Two nodes of the same component name merge into one template entry — the
     * registry is keyed by component name, not by instance slot. The method
     * also collects the set of every component name used in the tree (leaf or
     * internal), which the caller uses to ensure the droid-type key is distinct
     * from all parts.
     *
     * @private
     * @param {{ blueprintId: string, structure: { component: string, children?: Array } }} design - normalized design.
     * @returns {{ entries: Object<string, Array>, componentNames: Set<string> }}
     */
    _flattenTree(design) {
        const entries = {};
        const componentNames = new Set();

        const mergeItems = (key, item) => {
            (entries[key] = entries[key] || []);
            const signature = JSON.stringify(item);
            if (!entries[key].some((existing) => JSON.stringify(existing) === signature)) {
                entries[key].push(item);
            }
        };

        const walk = (node) => {
            if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.component !== 'string') {
                return;
            }
            componentNames.add(node.component);
            const children = Array.isArray(node.children) ? node.children : [];
            if (children.length > 0) {
                children.forEach((child) => {
                    if (child && typeof child === 'object' && !Array.isArray(child) && typeof child.component === 'string') {
                        mergeItems(node.component, this._mountEntry(child));
                    }
                });
            }
            children.forEach(walk);
        };

        walk(design.structure);

        // Droid-type pointer: [rootComponent] under the blueprintId key (a
        // separate key from every body part, guaranteed by the caller's guard).
        entries[design.blueprintId] = [design.structure.component];

        return { entries, componentNames };
    }

    /**
     * The package this design becomes: one entry per kind it actually authored.
     *
     * The two recipe kinds are filtered against the OFFICIAL registry, which is the
     * rule the save always had (a design never redefines a shipped recipe —
     * `_validateDesign` rejects the name outright): restating one in the package would
     * shadow official content with a copy of it, and a copy is the one definition that
     * cannot be maintained. The blueprint and outfit kinds are written as authored,
     * because redefining an existing body IS the act of redesigning a card — those are
     * reported in `overlapsOfficial` instead of filtered away.
     *
     * @private
     * @param {Object} normalized - the narrowed design.
     * @param {Object<string, Array>} entries - the flattened blueprint entries.
     * @returns {{ content: Object.<string, Object>, overlapsOfficial: Array<{ kind: string, key: string }> }}
     */
    _packageContent(normalized, entries, packageId) {
        const officialBlueprints = DataLoader.loadRegistry(REGISTRY_KINDS.BLUEPRINTS);
        const content = { [REGISTRY_KINDS.BLUEPRINTS]: entries };
        const overlapsOfficial = Object.keys(entries)
            .filter((key) => key in officialBlueprints)
            .map((key) => ({ kind: REGISTRY_KINDS.BLUEPRINTS, key }));

        const components = this._newComponentRecipes(
            normalized.components || [],
            DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS)
        );
        if (Object.keys(components).length > 0) {
            content[REGISTRY_KINDS.COMPONENTS] = components;
        }

        const garments = this._newGarmentRecipes(
            normalized.garments || [],
            DataLoader.loadRegistry(REGISTRY_KINDS.INVENTORY_ITEMS)
        );
        if (Object.keys(garments).length > 0) {
            content[REGISTRY_KINDS.INVENTORY_ITEMS] = garments;
        }

        const organs = this._newOrganRecipes(
            normalized.internalComponents || [],
            DataLoader.loadRegistry(REGISTRY_KINDS.INTERNAL_COMPONENTS)
        );
        if (Object.keys(organs).length > 0) {
            content[REGISTRY_KINDS.INTERNAL_COMPONENTS] = organs;
        }

        // Present means the design SPOKE about clothing; absent means it said nothing
        // and the world's default clothing still applies to this body (`OutfitLogic`).
        // An authored EMPTY list is written as an empty list: born wearing nothing.
        if (Array.isArray(normalized.outfit)) {
            const outfit = { [normalized.blueprintId]: normalized.outfit.map((entry) => ({ item: entry.item, component: entry.component })) };
            content[REGISTRY_KINDS.OUTFITS] = outfit;
            if (normalized.blueprintId in DataLoader.loadRegistry(REGISTRY_KINDS.OUTFITS)) {
                overlapsOfficial.push({ kind: REGISTRY_KINDS.OUTFITS, key: normalized.blueprintId });
            }
        }

        // The body's INBORN effects: entries of this same package's `effects` kind, keyed by
        // an id namespaced with the package slug. Namespaced because the effect registry is
        // GLOBAL - two characters both authored `hotCore` would be one effect wearing two
        // bodies, and the second save would silently rewrite the first. The blueprint names
        // the ids it was born with; spawn applies them.
        if (Array.isArray(normalized.effects) && normalized.effects.length > 0) {
            const slug = String(packageId).replace(/^body-/, '');
            const effectContent = {};
            for (const entry of normalized.effects) {
                // The stamp says WHICH body this effect was designed for, and the save puts
                // it - not the model. The server knows the blueprint it is writing, and a
                // designed character should not be able to claim another one's effect.
                // `InbornEffects` applies every definition declaring this body at spawn.
                effectContent[slug + '_' + entry.id] = { ...entry.definition, appliesTo: normalized.blueprintId };
            }
            content[REGISTRY_KINDS.EFFECTS] = effectContent;
            for (const key of Object.keys(effectContent)) {
                if (key in DataLoader.loadRegistry(REGISTRY_KINDS.EFFECTS)) {
                    overlapsOfficial.push({ kind: REGISTRY_KINDS.EFFECTS, key });
                }
            }
        }

        return { content, overlapsOfficial };
    }

    /**
     * The package id for one designed body: `body-<slug>` of the card display name.
     *
     * The display name is prose and the id is a path segment (`SEC-7`), so it is
     * folded, not trusted: diacritics folded out (an accented `e` becomes a plain `e`),
     * anything that is not a letter or a digit becomes a single dash, the tail cut at the length
     * `MOD_ID_PATTERN` allows. A name with nothing ASCII in it is a refusal, not an
     * invented fallback: silently sharing a package with another card is worse than a
     * save that says what it could not name.
     *
     * Two cards whose names fold to the same slug therefore share a package — the
     * second save replaces the first's files and the writer backs them up. The card
     * display name is also how `spawnCards` matches a body to a card, so two names that
     * fold alike are already the same character to the world.
     *
     * @private
     * @param {string} blueprintId - the card's display name (the server sets it, RP-1).
     * @returns {string}
     * @throws {DesignValidationError} the folded name is not a usable id segment.
     */
    _packageIdFor(blueprintId) {
        const slug = String(blueprintId)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+/, '')
            .slice(0, PACKAGE_SLUG_MAX_CHARS)
            .replace(/-+$/, '');
        if (!PACKAGE_SLUG_PATTERN.test(slug)) {
            throw new DesignValidationError(blueprintId, [
                `"${blueprintId}" has no ASCII letters or digits to name the package from`
            ]);
        }
        return PACKAGE_ID_PREFIX + slug;
    }

    /**
     * The version this write should carry: the writer's default for a package that does
     * not exist yet, otherwise its patch number advanced. A rewrite that left the
     * version alone would be indistinguishable in the Mods panel from the save that
     * created it (`P-6`).
     * @private
     * @param {string} packageId
     * @returns {string}
     */
    _nextPackageVersion(packageId) {
        const manifest = this.packageWriter.readManifest(packageId);
        const previous = (manifest && typeof manifest.version === 'string') ? manifest.version : '';
        const parts = PACKAGE_VERSION_PATTERN.exec(previous);
        if (!parts) return DEFAULT_PACKAGE_VERSION;
        return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
    }

    /**
     * The component recipes this package carries: the design's inventions that the
     * official registry does not already publish.
     *
     * @private
     * @param {Array<{ name: string, form: object, materials: Array, internalComponents: Array, energyCapacity?: number }>} recipes - the design's invented recipes.
     * @param {Object} official - freshly loaded official components registry.
     * @returns {Object} the recipes keyed by name, ready to be `components.json`.
     */
    _newComponentRecipes(recipes, official) {
        const recipesByName = {};
        recipes.forEach((recipe) => {
            if (!recipe || typeof recipe !== 'object' || typeof recipe.name !== 'string') return;
            if (Object.hasOwn(official, recipe.name)) return; // shipped recipe: never restated by the package

            const entry = {
                name: recipe.name,
                form: recipe.form,
                materials: recipe.materials,
                internalComponents: recipe.internalComponents
            };
            if (recipe.energyCapacity !== undefined) {
                entry.energyCapacity = recipe.energyCapacity;
            }
            recipesByName[recipe.name] = entry;
        });
        return recipesByName;
    }

    /**
     * The garment recipes this package carries — the design's inventions that the
     * official item registry does not already publish (a name colliding with a shipped
     * item is rejected by `_validateGarments` before this runs). The written entry is a
     * plain item recipe: matter, volume, organs (none), and the `wear` block that makes
     * it a garment — `WearLogic` needs nothing else, and `validateOutfitRegistry` at the
     * next boot checks the claim again.
     *
     * @private
     * @param {Array<Object>} garments - narrowed garment recipes.
     * @param {Object} official - freshly loaded official inventoryItems registry.
     * @returns {Object} the recipes keyed by name, ready to be `inventoryItems.json`.
     */
    _newGarmentRecipes(garments, official) {
        const recipesByName = {};
        garments.forEach((garment) => {
            if (!garment || typeof garment.name !== 'string') return;
            if (garment.name in official) return; // shipped item: never restated by the package
            recipesByName[garment.name] = {
                name: garment.displayName || garment.name,
                description: 'A garment authored from a character card in the Create Agent Body dev tab.',
                form: { volume: garment.form.volume },
                materials: garment.materials.map((m) => ({ material: m.material, fraction: m.fraction })),
                internalComponents: [],
                wear: { minVolume: garment.wear.minVolume },
                ...(garment.visual ? { visual: garment.visual } : {})
            };
        });
        return recipesByName;
    }

    /**
     * The organ definitions this package carries - the designer's own internal
     * components, the static claims `_validateDesign` already narrowed (name, display
     * name, volume, grants over the closed stat vocabulary, optional flags). A
     * name colliding with a shipped organ is rejected by `_validateDesign` before
     * this runs, so the filter here is a belt against a hand-edited design that
     * slipped a shipped organ into the list: restating one in the package would
     * shadow official content with a copy of it.
     *
     * The written entry follows the world's IC definition shape (the `name` field is
     * the display name, the key is the type id - the same convention
     * `data/mods/core-internal-components/internalComponents.json` uses), so the IC
     * registry accepts it as-is at `POST /mods/apply`. It carries NO `overTime`, no
     * install gate and no `weight`: a designer organ installs only where a component
     * declares it, and its function is the grant it carries.
     *
     * @private
     * @param {Array<Object>} organs - narrowed organ definitions.
     * @param {Object} official - freshly loaded official internalComponents registry.
     * @returns {Object} the definitions keyed by type id, ready to be `internalComponents.json`.
     */
    _newOrganRecipes(organs, official) {
        const recipesByName = {};
        organs.forEach((organ) => {
            if (!organ || typeof organ.name !== 'string') return;
            if (organ.name in official) return; // shipped organ: never restated by the package
            recipesByName[organ.name] = {
                name: organ.displayName || organ.name,
                volume: organ.volume,
                ...((organ.grants && Object.keys(organ.grants).length > 0) ? { grants: organ.grants } : {}),
                ...((organ.grantsFlags && organ.grantsFlags.length > 0) ? { grantsFlags: organ.grantsFlags } : {})
            };
        });
        return recipesByName;
    }

    /**
     * The cards-directory listing, read once per view and cached on the
     * instance (`this._cardFiles`). The Cards screen fetches one image per
     * card, and every read is matched against this listing, so one
     * `readdirSync` per gallery open instead of one per card. `listCards`
     * clears the cache before reading (the gallery re-reads the directory on
     * open); the per-card readers (`readCardImage`, `designBody`) reuse it.
     * @private
     * @returns {Array<{fullPath: string, cardId: string}>}
     */
    _listCardFiles() {
        if (this._cardFiles === null) {
            this._cardFiles = readCardFiles();
        }
        return this._cardFiles;
    }
    // ================================================================
    // Validation (the monolithic gate)
    // ================================================================

    /**
     * Validate a raw or normalized design against the world's body vocabulary.
     *
     * This is the SHARED law in one pass: the same rule functions the pipeline
     * runs per stage (AgentBodyDesignRules) composed here over the WHOLE design,
     * so a stage that slipped a cross-stage inconsistency (and a hand-edited
     * design the panel posts to /agent-body/save) is caught by the same rules.
     * The rules live in one module; this method only composes them and supplies
     * the vocabulary, so the stage law and the save law cannot drift.
     *
     * Two option modes:
     * - cardNameId: true (designBody and saveDesign): blueprintId is the
     *   card's display name (not a model-invented slug), so the slug/collision
     *   checks are relaxed to "non-empty string"; overwriting the card's own
     *   previously-saved body is intended.
     * - otherwise: blueprintId must be a slug and must not collide with an
     *   existing blueprint (the stricter historical default).
     *
     * Every other rule always applies: rationale, structure (a valid tree, at
     * most MAX_BODY_NODES nodes), components (new recipes referencing only
     * known materials and organs — including organs the design itself
     * proposes), internalComponents (the design's own organs, a static claim),
     * garments (new wearable item recipes), outfit (wears a proposed garment
     * or a wearable item, on a component of THIS body), and the distinct
     * droid type (the blueprintId is not a component name of the tree).
     *
     * @private
     * @param {Object} raw - the design (model shape or normalized).
     * @param {string} cardId - the card the design is for (used in the error).
     * @param {{ cardNameId?: boolean }} [options]
     * @returns {Object} the normalized design (frozen; `outfit` only when the
     *   design spoke about clothing).
     * @throws {DesignValidationError} with the list of violated rules.
     */
    _validateDesign(raw, cardId, options) {
        const allowExistingBlueprint = options && options.allowExistingBlueprint === true;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new DesignValidationError(cardId, ['the design was not a JSON object']);
        }

        const errors = [];

        const existingBlueprintIds = new Set(Object.keys(this.existingBlueprints).map((k) => k.toLowerCase()));
        const blueprintId = raw.blueprintId;
        if (options && options.cardNameId === true) {
            if (typeof blueprintId !== 'string' || blueprintId.length === 0) {
                errors.push('"blueprintId" must be a non-empty string');
            }
        } else if (!isSlug(blueprintId)) {
            errors.push('"blueprintId" must be an id (letters and digits only, 1-31 chars)');
        } else if (!allowExistingBlueprint && existingBlueprintIds.has(String(blueprintId).toLowerCase())) {
            errors.push('"blueprintId" "' + blueprintId + '" collides with an existing blueprint');
        }

        const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : '';
        if (rationale.length === 0) {
            errors.push('"rationale" must be a non-empty string');
        }

        // The body tree.
        const structure = raw.structure;
        let structureOk = true;
        if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
            structureOk = false;
            errors.push('"structure" must be the body tree object');
        }
        const structureRefs = [];
        if (structureOk) {
            walkStructure(structure, structureRefs, 0, errors);
            if (structureRefs.length > MAX_BODY_NODES) {
                errors.push('the body tree has ' + structureRefs.length + ' nodes (max ' + MAX_BODY_NODES + ')');
            }
        }

        // The design's own organs (a static claim: name, display name, grants,
        // flags, volume — the same shape the pipeline's organs stage validated).
        const organs = [];
        const proposedOrganNames = new Set();
        const rawOrgans = raw.internalComponents;
        if (rawOrgans !== undefined && rawOrgans !== null) {
            if (!Array.isArray(rawOrgans)) {
                errors.push('"internalComponents" must be an array of new organ definitions');
            } else if (rawOrgans.length > MAX_IC_RECIPES) {
                errors.push('"internalComponents" has ' + rawOrgans.length + ' entries (max ' + MAX_IC_RECIPES + ')');
            } else {
                rawOrgans.forEach((organ, index) => {
                    const narrowed = validateOrganDefinition(organ, index, {
                        availableOrgans: this.organs,
                        proposedOrganNames
                    }, errors);
                    if (narrowed) {
                        organs.push(narrowed);
                    }
                });
            }
        }

        // The design's invented components (a recipe may reference an organ the
        // design itself proposes — the pipeline's organs stage attaches them).
        const components = [];
        const proposedNames = new Set();
        const rawComponents = raw.components;
        if (rawComponents !== undefined && rawComponents !== null) {
            if (!Array.isArray(rawComponents)) {
                errors.push('"components" must be an array of new component recipes');
            } else {
                for (const [index, recipe] of rawComponents.entries()) {
                    const narrowed = validateComponentRecipe(recipe, index, {
                        availableComponents: this.components,
                        availableOrgans: this.organs,
                        availableMaterials: this.materials,
                        proposedNames,
                        proposedOrganNames,
                        allowDesignOrgans: true
                    }, errors);
                    if (narrowed) {
                        components.push(narrowed);
                    }
                }
            }
        }

        const garments = validateGarments(raw.garments, {
            availableItems: this.items,
            availableComponents: this.components,
            availableMaterials: this.materials
        }, errors);
        const outfit = validateOutfit(raw.outfit, {
            structureRefs,
            garments,
            availableItems: this.items
        }, errors);

        // What the body does INBORN. The same function the effects stage ran, so the stage's
        // claim and this fact are one law (`CR T-1`); the reserved-operation gate lives in it.
        const effects = validateDesignEffects(raw.effects, errors);

        // Every tree node must be a known component or a recipe the design
        // invents (the anatomy stage's own check, run again over the whole).
        const unknownRefs = [...new Set(structureRefs)].filter((name) => !this.components[name] && !proposedNames.has(name));
        if (unknownRefs.length > 0) {
            errors.push('unknown component(s) in the body tree: ' + unknownRefs.join(', ') + ' (every node must be an available component or a recipe in "components")');
        }

        if (errors.length > 0) {
            throw new DesignValidationError(cardId, errors);
        }

        const normalized = normalizeDesign({
            blueprintId,
            rationale,
            structure,
            components,
            garments,
            internalComponents: organs,
            outfit,
            outfitDeclared: Array.isArray(raw.outfit),
            effects
        });

        // The distinct-droid-type guard: the blueprint id is the droid-type
        // key, and the registry keys a template by component name — a droid
        // type that is also the name of one of its own parts would collapse
        // into that part's entry in the flattened registry, and the spawn
        // reader would treat the body as a single component.
        const { componentNames } = this._flattenTree(normalized);
        if (componentNames.has(blueprintId)) {
            throw new DesignValidationError(cardId, [
                '"blueprintId" must not be the name of any component used in the body tree (the droid type must be a distinct key from every part it contains)'
            ]);
        }

        return normalized;
    }

    /**
     * The blueprint mount entry for one design node: `"type"`, `["type", "slot"]`,
     * or — when the mount declared it hides with its parent —
     * `["type", "slot", { "hidesWithParent": true }]`, the shape
     * `entityController.mountOptions` reads onto the instance.
     *
     * Writing that third element is the point. Before it, a design that redefined a
     * sub-tree dropped every mark the shipped data had authored on those joints —
     * the design spoke the body but not what hangs behind its cloth.
     * @private
     * @param {{ component: string, slot: string|null, hidesWithParent?: true }} node - normalized node.
     * @returns {string|Array} the mount entry as `blueprints.json` stores it
     */
    _mountEntry(node) {
        if (node.hidesWithParent !== true) {
            return node.slot != null ? [node.component, node.slot] : node.component;
        }
        // A marked mount with no slot says the identifier `expandBlueprint` itself
        // gives a slotless mount: the options object is the third element, and there
        // is no other way to reach it without inventing a body position.
        return [
            node.component,
            node.slot != null ? node.slot : DEFAULT_MOUNT_SLOT,
            { hidesWithParent: true }
        ];
    }

    /**
     * Count the nodes of a normalized body tree (for the design summary log).
     * @private
     * @param {Object} tree - normalized structure.
     * @returns {number}
     */
    _countNodes(tree) {
        if (!tree || typeof tree !== 'object') return 0;
        const children = Array.isArray(tree.children) ? tree.children : [];
        return 1 + children.reduce((sum, child) => sum + this._countNodes(child), 0);
    }

    // ================================================================
    // Vocabulary loading (data seam, B-3)
    // ================================================================

    /**
     * Components registry for the prompt: name, volume, materials, organs.
     * The vocabulary is the world's, not the design's: the LLM may reference
     * these by name, and it may propose new components that reference them.
     * @private
     * @returns {Record<string, { name: string, volume: number|null, materials: Array, organs: string[], energyCapacity: number|null }>}
     */
    _loadComponents() {
        const registry = DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS);
        const out = {};
        for (const [name, def] of Object.entries(registry)) {
            if (!def || typeof def !== 'object') continue;
            out[name] = {
                name,
                volume: def.form && typeof def.form.volume === 'number' ? def.form.volume : null,
                materials: Array.isArray(def.materials)
                    ? def.materials.filter((m) => m && typeof m.material === 'string' && typeof m.fraction === 'number')
                        .map((m) => ({ material: m.material, fraction: m.fraction }))
                    : [],
                organs: Array.isArray(def.internalComponents)
                    ? def.internalComponents.map((ic) => (typeof ic === 'string' ? ic : (ic && ic.type))).filter((t) => typeof t === 'string')
                    : [],
                energyCapacity: typeof def.energyCapacity === 'number' ? def.energyCapacity : null
            };
        }
        return out;
    }

    /**
     * Items registry, filtered to what a design may name in an outfit: items
     * that can be worn (a defined, non-null minVolume) — the same filter the
     * validator applies, so the prompt and the rule cannot disagree.
     * @private
     * @returns {Record<string, { name: string, displayName: string, minVolume: number }>}
     */
    _loadItems() {
        const registry = DataLoader.loadRegistry(REGISTRY_KINDS.INVENTORY_ITEMS);
        const out = {};
        for (const [name, def] of Object.entries(registry)) {
            if (!def || typeof def !== 'object') continue;
            if (def.wear && typeof def.wear.minVolume === 'number') {
                out[name] = {
                    name,
                    displayName: def.name || name,
                    minVolume: def.wear.minVolume
                };
            }
        }
        return out;
    }

    /**
     * Materials registry for the prompt: name and density (the density is
     * informational; a design only needs the name to reference a material).
     * @private
     * @returns {Record<string, { name: string, density: number|null }>}
     */
    _loadMaterials() {
        const registry = DataLoader.loadRegistry(REGISTRY_KINDS.MATERIALS);
        const out = {};
        for (const [name, def] of Object.entries(registry)) {
            if (!def || typeof def !== 'object') continue;
            out[name] = {
                name,
                density: typeof def.density === 'number' ? def.density : null
            };
        }
        return out;
    }

    /**
     * Organs registry for the prompt: name, display name, and the stats a
     * world organ grants (so the design can reason about what installing one
     * does). A world organ is a reference target for the design's recipes,
     * not a definition the design rewrites.
     * @private
     * @returns {Record<string, { name: string, displayName: string, grants: object, flags: string[] }>}
     */
    _loadOrgans() {
        const registry = DataLoader.loadRegistry(REGISTRY_KINDS.INTERNAL_COMPONENTS);
        const out = {};
        for (const [name, def] of Object.entries(registry)) {
            if (!def || typeof def !== 'object') continue;
            out[name] = {
                name,
                displayName: def.name || name,
                grants: (def.grants && typeof def.grants === 'object' && !Array.isArray(def.grants)) ? def.grants : {},
                flags: Array.isArray(def.grantsFlags) ? def.grantsFlags : []
            };
        }
        return out;
    }

    /**
     * The world's blueprints as compact trees for the prompt: blueprint id ->
     * a flat array of `[component, slot?]` pairs (children in order). The
     * example bodies show the LLM how a blueprint tree composes from the
     * available components — a structural sample, not a rule.
     * @private
     * @returns {Record<string, Array>}
     */
    _loadBlueprints() {
        const registry = DataLoader.loadRegistry(REGISTRY_KINDS.BLUEPRINTS);
        const out = {};
        for (const [id, def] of Object.entries(registry)) {
            if (!Array.isArray(def)) continue;
            const tree = [];
            def.forEach((entry) => {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
                if (typeof entry.component === 'string') {
                    tree.push(entry.slot === undefined ? [entry.component] : [entry.component, entry.slot]);
                }
            });
            if (tree.length > 0) out[id] = tree;
        }
        return out;
    }
}

export default AgentBodyController;

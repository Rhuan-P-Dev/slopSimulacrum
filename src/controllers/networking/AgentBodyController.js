/**
 * AgentBodyController — body designer for the "Create Agent Body" dev tab
 * (Feature A, RP-1 prompt kind `agent-body-design`, RP-2 versioned).
 *
 * Given a character card (PNG under data/cards/ with the identity side-channel:
 * name, description, personality) and the world's body vocabulary (components,
 * materials, organs, example blueprints), it:
 *   1. builds a versioned two-message prompt (system + user),
 *   2. calls the provider through the injected LLMController (the sole LLM
 *      seam, CR B-2 — this controller never fetches the provider itself),
 *   3. parses the response (tolerating a markdown code fence) and validates it
 *      against the vocabulary (body tree + new component recipes + new organs the
 *      designer invents),
 *   4. returns a frozen design with the prompt captured for inspection (meta);
 *      the blueprint id is the card's display name (name field, stem fallback) —
 *      the model does not choose it; saveDesign persists that design as a mod
 *      package and spawnCards later match the world's droid type to the card by name.
 *   5. persists a validated design (saveDesign) as ONE data-only mod package,
 *      `data/mods/body-<slug>/`, through `ModPackageWriter`: the body tree as the
 *      `blueprints` kind (the droid-type pointer + each component's sub-tree), the
 *      invented part recipes as `components`, the new organs as
 *      `internalComponents`, the garments as `inventoryItems`, and what the body
 *      wears as `outfits`. The official `core-*` packages are NEVER
 *      written — a designed body is an overlay next to the shipped world, and
 *      disabling the package is what undoes it. Every file a rewrite replaces is
 *      backed up by the writer before it is touched.
 *
 * designBody itself stays display-only (it never writes); persistence is the
 * explicit saveDesign action, which re-validates and then writes through the
 * data seam (CR B-3). Writing a package and changing the world are two acts: this
 * module never enables, orders or applies anything (`ModService` owns those), so a
 * saved body reaches a running world only through `POST /mods/apply`. The LLM
 * cost-guard still applies to designBody: per-IP
 * rate limiter in src/routes/agentBodyRoutes.js (SEC-9) and the named token
 * budget (`LLM_AGENT_BODY_MAX_TOKENS`, 10x the global `LLM_DEFAULT_MAX_TOKENS`),
 * because the precision reasoning model counts thinking tokens against that cap
 * and a small budget truncates the design. The LLM timeout is the seam's
 * REQUEST_TIMEOUT_MS (env LLM_TIMEOUT_MS), matching /llm/chat — no second
 * timeout knob. A designed mount carries what hangs behind its cloth: a node may
 * declare `hidesWithParent`, and `saveDesign` writes it as the third element of
 * the blueprint mount (`["maleBreast", "left", { "hidesWithParent": true }]`), the
 * shape the live world already reads to take a part out of the round prose when
 * the part it hangs on is covered (`PerceptionController._coveredIds`).
 * A designed body can also arrive dressed: `garments` are new wearable item recipes
 * (the package's `inventoryItems` kind) and `outfit` says what is worn, on which component
 * of THIS body (the package's `outfits` kind). SPEAKING about clothing
 * is itself the claim: an authored empty outfit means born wearing nothing, while
 * saying nothing leaves the world's default clothing in force
 * (`src/controllers/logic/OutfitLogic.js`). See wiki/decisions/agent-body-design.md
 * and wiki/decisions/outfits.md.
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

import LLMController from './LLMController.js';
import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import ModPackageWriter, { DEFAULT_PACKAGE_VERSION } from '../../services/ModPackageWriter.js';
import { LLM_DEFAULT_MAX_TOKENS, LLM_DEFAULT_TEMPERATURE } from '../../utils/Constants.js';
import { readCardFiles } from '../../controllers/logic/CardSpawnLogic.js';
import { readCharaCard, readCardFileBytes } from '../../utils/PngCharaReader.js';
import path from 'node:path';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';
import { FLAG_NAMES, STAT_NAMES, TRAIT_GROUPS, flatKey } from '../../../shared/StatVocabulary.js';
import { narrowVisualBlock } from '../../utils/materialLook.js';
import { performance } from 'node:perf_hooks';

const PROMPT_KIND = 'agent-body-design';
/**
 * v1.3.0 — a designed mount may declare `hidesWithParent`, the mark the world
 * already reads (`data/mods/core-blueprints/blueprints.json`,
 * `entityController.mountOptions`): the part hangs behind whatever covers the
 * part it hangs ON, so a garment over the parent takes this part out of the
 * round prose too (`wiki/decisions/visual-stats.md`). Before this version the
 * mark could only be hand-written in the data file, and a design that redefined
 * a sub-tree SILENTLY DELETED the marks already published there, because
 * `_flattenTree` wrote `[type, slot]` and nothing else. See the decision note.
 *
 * v1.4.0 — the design also DRESSES the body: two new output fields, `garments`
 * (new wearable ITEM recipes, written to the item registry) and `outfit` (what is
 * worn, and on which component of this body, written to the outfit registry —
 * `wiki/decisions/outfits.md`). An authored `outfit` is a claim the save honors even
 * when it is empty (`[]` = born wearing nothing, and the world's default clothing
 * stands down); omitting the field says nothing, so the default stays in force.
 * v1.5.0 — the designer also authors its own organs (internal components): a new
 * top-level field `internalComponents` carries new organ definitions — a closed,
 * static shape (name, optional displayName, grants over the four grantable function
 * stats, optional flags, volume). A component's `internalComponents` may reference
 * an organ the design proposed, not only a shipped one. The Save writes the proposed
 * organs as the package's `internalComponents` kind; they install on the components
 * that declare them, at spawn. Per-turn effects remain the world's: a designer
 * organ grants and marks, and that is all (amendment in
 * wiki/decisions/agent-body-design.md).
 *
 * v1.6.0 — the rules the validator enforces were never said to the model at the
 * decision point: one saved design came back rejected for a hallucinated organ
 * ("suppleSubjectCore" — neither shipped nor proposed) and a display name over
 * the limit. The prompt now states both laws where the model decides: the organ
 * and garment `displayName` lines carry the character limits (from the same
 * constants the validator uses), and a `FINAL CHECKLIST` between
 * `EXAMPLE BLUEPRINTS` and `OUTPUT FORMAT` restates the organ-reference law
 * (a recipe organ must match, character for character, a shipped organ or a
 * name the same design proposes) plus the other resolution rules. The 422
 * `BODY_DESIGN_INVALID` contract of `POST /agent-body/create` is unchanged.
 * (Amendment in wiki/decisions/agent-body-design.md.)
 */
const PROMPT_VERSION = '1.6.0';
const SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/**
 * The identifier `entityController.expandBlueprint` itself gives a mount that
 * authored no slot (the bare-`"type"` entry). A marked mount with no slot says
 * it explicitly, because the options object is the THIRD element of the mount
 * and there is no fourth way to reach it — the mark never invents a slot.
 */
const DEFAULT_MOUNT_SLOT = 'default';
const MAX_BODY_NODES = 16;
const MAX_TREE_DEPTH = 8;
const MAX_CARD_ID_LENGTH = 128;
const MATERIAL_FRACTION_TOLERANCE = 0.005;

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
 * Per-call token cap for the agent-body-design prompt: 10x the global
 * LLM_DEFAULT_MAX_TOKENS (2048 to 20480). The design prompt carries the full
 * world vocabulary plus a complete anatomy spec, and the precision reasoning
 * model counts its thinking tokens against this cap; a small budget truncated
 * the reasoning (finishReason "length") before the design finished. Ten times
 * the default leaves the thinking budget ample headroom. (Same precedent as
 * LLMAgentController LLM_ROUND_MAX_TOKENS, raised the same way when reasoning
 * turns were cut off.) The outer bound on the call is the seam's
 * REQUEST_TIMEOUT_MS (env LLM_TIMEOUT_MS), not this cap (no second timeout
 * knob — see the module header).
 */
const LLM_AGENT_BODY_MAX_TOKENS = LLM_DEFAULT_MAX_TOKENS * 10;

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
 * Bounds on the two arrays a design may invent (`A-7`: nothing in this feature is
 * unbounded). Eight new garments and eight wear-assignments is more than any card
 * has ever needed; past that, a design is not describing a character.
 */
const MAX_GARMENTS = 8;
const MAX_OUTFIT_ENTRIES = 8;
/**
 * How long a garment's spoken name may be. It lands in the item registry and is
 * printed in a sentence ("Adam, wearing a Rune-Stitched Cloak"), so it is prose,
 * not an identifier.
 */
const MAX_GARMENT_LABEL_CHARS = 64;
/**
 * New organs a design may propose (`A-7`: nothing in this feature is unbounded).
 * A designer organ is a registry row - one name the world does not have yet - so
 * the same "more than any card has ever needed" ceiling as garments applies; past
 * eight, the design is not describing a character.
 */
const MAX_IC_RECIPES = 8;
/**
 * The closed vocabulary a designer organ may GRANT: the four function stats the
 * world derives from organs (`StatVocabulary` "FUNCTION"), nothing else. A grant
 * outside this set would give a host a stat that matter and form do not own,
 * breaking the one-source-per-stat invariant.
 */
const GRANTABLE_STAT_KEYS = Object.freeze([
    flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH),
    flatKey(TRAIT_GROUPS.MOVEMENT, STAT_NAMES.MOVE),
    flatKey(TRAIT_GROUPS.MANIPULATION, STAT_NAMES.FINE_CONTROLS),
    flatKey(TRAIT_GROUPS.MIND, STAT_NAMES.THINK_LEVEL)
]);
/**
 * The closed vocabulary a designer organ may MARK: the world's flags
 * (`StatVocabulary.FLAG_NAMES`). Granting a flag is how the world's organs
 * `corrosiveGland` and `sensitiveNerve` mark their host; a designer organ marks
 * through the same channel.
 */
const GRANTABLE_FLAGS = Object.freeze(Object.values(FLAG_NAMES));
/**
 * A designer organ's spoken name may be at most this many chars (same bound as the
 * garments: a display string, not an identifier).
 */
const MAX_IC_LABEL_CHARS = 64;

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
 * Thrown when the model output of the agent-body-design kind fails validation.
 * `errors` carries one message per violated rule.
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

export { CardNotFoundError, DesignValidationError, PROMPT_KIND, PROMPT_VERSION, LLM_AGENT_BODY_MAX_TOKENS, MAX_CARD_ID_LENGTH };

/**
 * True for the identifier shapes used in the world (component names, blueprint
 * ids, card stems): first char a letter, letters/digits only, 1-31 chars.
 * @param {*} value
 * @returns {boolean}
 */
function isSlug(value) {
    return typeof value === 'string' && value.length > 0 && SLUG_PATTERN.test(value);
}

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
     * @param {{ llmController: { chatFull: (messages: object[], options?: object) => Promise<object> }, packageWriter?: { writePackage: (spec: object) => object, readManifest: (id: string) => object|null, packageDir: (id: string) => string } }} options
     *   - options.llmController: the LLM seam (CR B-2). The caller's own LLMController
     *     instance is injected so provider config follows the host process.
     *   - options.packageWriter: `ModPackageWriter` by default. It is the module that owns
     *     putting package bytes on disk, so it is injected rather than reimplemented here;
     *     a test hands in a spy and sees exactly the package the design became.
     */
    constructor({ llmController, packageWriter = new ModPackageWriter() }) {
        if (!llmController || typeof llmController.chatFull !== 'function') {
            throw new TypeError('AgentBodyController: "llmController" must expose chatFull (the LLM seam, CR B-2)');
        }
        if (!packageWriter || typeof packageWriter.writePackage !== 'function') {
            throw new TypeError('AgentBodyController: "packageWriter" must expose writePackage (the package seam, CR B-3)');
        }
        this.llmController = llmController;
        this.packageWriter = packageWriter;
        // Vocabulary is loaded once per process (B-3 data seam; data files are
        // static within a run). Frozen so the prompt is stable across calls.
        this.components = this._loadComponents();
        this.materials = this._loadMaterials();
        this.organs = this._loadOrgans();
        this.items = this._loadItems();
        this.existingBlueprints = this._loadBlueprints();
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
     * Designs the body of the card whose stem is cardId: builds the
     * agent-body-design prompt, calls the LLM through the seam, and validates
     * the returned JSON design.
     *
     * @param {string} cardId - stem of a card PNG under data/cards/ (no extension).
     * @returns {Promise<{
     *   card: {cardId: string, name: string, description: string, personality: string},
     *   body: {blueprintId: string, rationale: string, structure: object, components: Array, garments: Array, internalComponents: Array, outfit?: Array},
     *   meta: {promptKind: string, promptVersion: string, promptMessages: Array, model: string, finishReason: string, latencyMs: number},
     *   organsByComponent: Object<string, Array<string>>
     * }>}
     * @throws {CardNotFoundError} - no card PNG matches cardId.
     * @throws {DesignValidationError} - the model output failed validation (rule list in errors).
     * @throws {LLMError} - provider failure (codes: LLM_TIMEOUT, LLM_HTTP_ERROR, LLM_PARSE_ERROR, LLM_REQUEST_ERROR).
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

        const systemPrompt = this._buildSystemPrompt();
        const userPrompt = this._buildUserPrompt(identity);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const startedAt = performance.now();
        const full = await this.llmController.chatFull(messages, {
            temperature: LLM_DEFAULT_TEMPERATURE,
            max_tokens: LLM_AGENT_BODY_MAX_TOKENS
        });
        const latencyMs = Math.round(performance.now() - startedAt);

        // The body is named after the card (owner requirement): the model does not
        // choose the id — the server sets it to the card's display name. That is
        // the exact name the world matches a card's body by at spawn.
        const rawDesign = this._extractDesignJson(full.content);
        const design = this._validateDesign(
            rawDesign ? { ...rawDesign, blueprintId: identity.name } : rawDesign,
            cardId,
            { cardNameId: true }
        );

        Logger.info(
            '[AgentBodyController] ' + PROMPT_KIND + ' v' + PROMPT_VERSION +
            ' for card "' + cardId + '": blueprint "' + design.blueprintId +
            '" (' + this._countNodes(design.structure) + ' body nodes, ' + design.components.length + ' new recipes, ' +
            design.garments.length + ' new garments, ' + design.internalComponents.length + ' new organs, ' +
            (Array.isArray(design.outfit) ? design.outfit.length + ' outfit entry(ies)' : 'no clothing claim') + '), ' +
            systemPrompt.length + ' char system prompt, ' + userPrompt.length + ' char user prompt, ' + latencyMs + ' ms',
            { promptKind: PROMPT_KIND, promptVersion: PROMPT_VERSION }
        );

        // Read-only display context for the dev panel: the organs each body part
        // actually installs (world parts take the world recipe, new parts take
        // this design's recipe). Outside `body` on purpose - `body` is exactly
        // what Save posts, and the display map is not design data.
        const organsByComponent = this._organsByComponent(design);

        return {
            card: identity,
            body: design,
            meta: {
                promptKind: PROMPT_KIND,
                promptVersion: PROMPT_VERSION,
                promptMessages: messages,
                model: LLMController.DEFAULT_MODEL,
                finishReason: full.finishReason,
                latencyMs
            },
            organsByComponent
        };
    }

    /**
     * The organs each part of the designed body carries, keyed by component name
     * in tree order (first encounter). A part's organs come from the recipe that
     * defines it: world parts take the world's recipe (`this.components`), new
     * parts take this design's own recipe (`internalComponents`). Parts with no
     * organs are ABSENT from the map - absence IS the "no organs" claim, never
     * an empty claim. Frozen: this is read-only display context, not design data
     * (Save posts `body` alone).
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

    // ================================================================
    // Save action (the display tab's write path)
    // ================================================================

    /**
     * saveDesign — the "Save" action. Re-validates the design against the live
     * vocabulary and writes it as ONE data-only mod package, `data/mods/body-<slug>/`
     * (slug derived from the card display name — see `_packageIdFor`). The official
     * `core-*` packages are never written: a designed body is an overlay beside the
     * shipped world, and undoing it is disabling the package, not restoring a file.
     *
     * What the package carries, one kind per thing the design authored:
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
        const { content, overlapsOfficial } = this._packageContent(normalized, entries);
        const packageId = this._packageIdFor(normalized.blueprintId);

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
    _packageContent(normalized, entries) {
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

    // ================================================================
    // Prompt building (agent-body-design kind; RP-2 versioned in the prompt
    // itself — the model sees the version header)
    // ================================================================

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

    /**
     * System message: role, anatomy facts, output schema, rules, and the full
     * vocabulary (components, materials, organs) plus example blueprints.
     * @returns {string}
     */
    _buildSystemPrompt() {
        const componentLines = Object.values(this.components)
            .map((c) => this._componentLine(c))
            .join('\n');
        const materialLines = Object.values(this.materials)
            .map((m) => m.name + ' (density ' + (m.density === null ? '?' : m.density) + ')')
            .join(', ');
        const organLines = Object.values(this.organs)
            .map((o) => o.name + (o.grants ? ' — grants: ' + this._grantsString(o.grants) : ' — no stat grants'))
            .join('\n');
        const blueprintIds = Object.keys(this.existingBlueprints).join(', ');
        const exampleLines = Object.entries(this.existingBlueprints)
            .map(([name, tree]) => this._blueprintExampleLine(name, tree))
            .join('\n');

        return (
            'You are the BODY DESIGNER for slopSimulacrum, a persistent world simulation in which LLM-driven droids live as NPCs.\n' +
            'You must design how one character\'s BODY is constructed, from the character identity in the user message and the anatomy facts below.\n\n' +
            'ANATOMY FACTS\n' +
            '- An NPC entity is a BLUEPRINT: a tree of components (data/mods/core-blueprints/blueprints.json). Each node is a component; nodes may have children (sub-components).\n' +
            '- A COMPONENT (data/mods/core-components/components.json) is defined by its FORM (volume + position), its MATERIALS (fractions that sum to 1.0) and its INTERNAL COMPONENTS (organs). A component without organs is inert.\n' +
            '- VOLUME is a component\'s physical capacity; an ORGAN is what makes a component functional (it grants stat values).\n\n' +
            'YOUR OUTPUT\n' +
            'Respond with a single JSON object with exactly these fields:\n' +
            '- "rationale": 1-3 sentences explaining why this body fits the character (movement, role, weapons, temperament, size). REQUIRED.\n' +
            '- "structure": the body tree. Root: { "component": "<name>", "slot": null, "children": [ <node>... ] }.\n' +
            '  Every node: { "component": "<name>", "slot": null|"<string>", "children": [ <node>... ] or [] }.\n' +
            '  The same component may appear multiple times (four legs, two arms).\n' +
            '  slot is a short body-position token such as "frontal_left" or "top_hand" (null when absent).\n' +
            '  A node MAY also declare "hidesWithParent": true. It means: this part hangs BEHIND whatever covers the part it hangs on, so when that parent wears a garment the world does not name this part either. Author it on a part that cloth normally covers (a breast under a shirt), never on a head or a hand, and never on the root, which hangs on nothing. Omit it - never write false - when the part is simply a part.\n' +
            '  The whole tree must have at most ' + MAX_BODY_NODES + ' nodes.\n' +
            '- "components": the NEW component definitions you invent for this card. The AVAILABLE COMPONENTS below are only a generic base vocabulary — whenever the character has a feature that is distinctive to it (a signature weapon, role-specific gear, or unique anatomy such as a tail, crest, or special limb), define a NEW component for it so the body faithfully reflects THIS character and is not just a copy of the generic droid. Leave the array empty only when the available components already cover the character. Each new component:\n' +
            '  { "name": "<unique id, letters and digits only>",\n' +
            '    "form": { "volume": <positive integer 1..40>, "position": { "x": <integer>, "y": <integer> } },\n' +
            '    "materials": [ { "material": "<one of the AVAILABLE MATERIALS>", "fraction": <number> } ],\n' +
            '    "internalComponents": [ "<an EXACT name: one of the AVAILABLE ORGANS, or a NEW organ you PROPOSE in the top-level "internalComponents" array below — an undeclared or near-matching name rejects the design>" ] or omitted,\n' +
            '    "energyCapacity": <integer >= 0> or omitted }\n' +
            '  Material fractions within each new recipe must sum to exactly 1.0.\n' +
            '- "internalComponents": the NEW organs you invent for this character (the designer\'s own ICs) - a top-level array of organ definitions. An organ is what makes a component functional: a STATIC claim, not a machine. It grants stats and/or marks flags, and it does nothing between turns (no fuel, no repair, no item making, no per-turn effect - that half belongs to the world\'s organs and is not authorable here). An organ that grants no stat and marks no flag is inert, like a component without an organ, so give each one at least a grant or a flag. Each new organ:\n' +
            '  { "name": "<new id, letters and digits only, 1..31; NOT one the world already has>",\n' +
            '    "displayName": "<what the world calls it in a sentence; optional; at most ' + MAX_IC_LABEL_CHARS + ' characters">,\n' +
            '    "grants": { "<stat key>": <number> },       // from ONLY: Physical.strength, Movement.move, Manipulation.fine_controls, Mind.think_level\n' +
            '    "grantsFlags": ["<flag>"],                 // from ONLY: flammable, conductive, corrosive, sensitive\n' +
            '    "volume": <positive integer 1..40> }\n' +
            '  "grants" and "grantsFlags" are both optional, but at least one must be non-empty. At most ' + MAX_IC_RECIPES + ' new organs. A component uses a proposed organ exactly as it uses a world organ: by naming it in its own "internalComponents" - so every component that needs function names the organ that gives it.\n' +
            '- "garments": NEW wearable ITEMS you invent for this character - a cloak, a hood, a harness, a wrapped bandage, a ceremonial sash. A garment is a thing the character CARRIES and WEARS: it is never a node of "structure" and never a component. Each new garment:\n' +
            '  { "name": "<unique id, letters and digits only>",\n' +
            '    "displayName": "<what the world calls it in a sentence, e.g. Rune-Stitched Cloak; optional; at most ' + MAX_GARMENT_LABEL_CHARS + ' characters">,\n' +
            '    "form": { "volume": <positive integer 1..40> },\n' +
            '    "materials": [ { "material": "<one of the AVAILABLE MATERIALS>", "fraction": <number> } ],\n' +
            '    "wear": { "minVolume": <integer 1..volume> },\n' +
            '    "visual": { "hue": <0-360>, "saturation": <0-100>, "lightness": <0-100>, "metalness": <0-100>, "roughness": <0-100> } or omitted }\n' +
            '  A garment asks no more of a body than it takes itself (wear.minVolume at most its own volume): the shipped t-shirt is volume 2 and needs 2. Its materials sum to 1.0. Its visual block is what the world SEES - a garment does not look like the matter it is modelled from.\n' +
            '- "outfit": what this body is BORN WEARING, as a list of { "item": "<one of your garments, or one of the WEARABLE ITEMS below>", "component": "<a component name that appears in your structure>" }. Author it for a character described dressed, and pair the garment with the mounts you marked "hidesWithParent" - the cloth is what hides them. Send [] when the character wears nothing at all; leaving the field out means you said nothing about clothing, which is NOT the same claim.\n\n' +
            'RULES\n' +
            '1. Every "component" in "structure" must be either an AVAILABLE COMPONENT (exactly as named below) or a NEW COMPONENT you define in "components".\n' +
            '2. A new recipe\'s "internalComponents" may use AVAILABLE ORGANS or ORGANS you PROPOSE in the top-level "internalComponents" field - nothing else.\n' +
            '3. The body is named after the card — you do NOT choose a blueprint id. Omit "blueprintId" from your JSON; the server sets it to the card\'s display name.\n' +
            '4. Keep the body compact: at most ' + MAX_BODY_NODES + ' component nodes in the tree.\n' +
            '5. "hidesWithParent" is a fact about THIS joint in THIS body, not about the component type: the same part may hide under the cloth of one body and not under another. Use it sparingly, and only where a garment would really be in front of the part.\n' +
            '6. Make the body recognizable as THIS card, not a generic M1 droid: invent NEW components to express the character\'s defining traits (its name, role, temperament, signature equipment, unique anatomy) - and give them the NEW organs that make those parts do anything. The materials, the grantable stats and the flags stay a closed vocabulary; which organs exist is the judgment, and how organs act is the world\'s.\n' +
            '7. A garment is not a body part: never name a garment in "structure", and never name a component in "outfit".\n' +
            '8. Every "outfit" entry names a component that appears in the body tree, and a WEARABLE item - one you proposed in "garments" or one listed below.\n\n' +
            'AVAILABLE COMPONENTS (' + Object.keys(this.components).length + ' types):\n' +
            componentLines + '\n\n' +
            'AVAILABLE MATERIALS:\n' +
            materialLines + '\n\n' +
            'AVAILABLE ORGANS:\n' +
            organLines + '\n\n' +
            'WEARABLE ITEMS already in the world ("outfit" names them by the key below; N is the free volume the part must have to accept it):\n' +
            this._wearableLines() + '\n\n' +
            'EXISTING BLUEPRINT IDS (for reference — existing droid types in the world): ' + blueprintIds + '\n\n' +
            'EXAMPLE BLUEPRINTS (how bodies compose in this world; ["component", "slot"] is a component with a slot):\n' +
            exampleLines + '\n\n' +
            'FINAL CHECKLIST (run it after every value is written, before the JSON leaves you; one missed line is a design the server rejects as BODY_DESIGN_INVALID and the card must be designed again):\n' +
            '- ORGAN REFERENCES (most often violated): every string in every "internalComponents" array of your "components" must match, character for character, either a name in the "AVAILABLE ORGANS" list above or a name you define in your top-level "internalComponents". A name in NEITHER is an invented organ and rejects the design. If a recipe names an organ not in "AVAILABLE ORGANS", you MUST also define it in the top-level "internalComponents" in the SAME design — there is no third source of organ names.\n' +
            '- COMPONENT NAMES: every "component" in "structure" must match an "AVAILABLE COMPONENTS" name or a recipe name you defined in "components".\n' +
            '- DISPLAY NAMES: a new organ\'s "displayName" is at most ' + MAX_IC_LABEL_CHARS + ' characters; a garment\'s is at most ' + MAX_GARMENT_LABEL_CHARS + ' characters. If a phrase is longer, shorten it before answering.\n' +
            '- OUTFIT: every "item" is a garment you proposed in "garments" or a key from "WEARABLE ITEMS"; every "component" is a node of your "structure".\n' +
            '- BOUNDS: at most ' + MAX_BODY_NODES + ' structure nodes, at most ' + MAX_IC_RECIPES + ' new organs, at most ' + MAX_GARMENTS + ' garments and at most ' + MAX_OUTFIT_ENTRIES + ' outfit entries; material fractions sum to 1.0; organ grants from the four function stats only; organ flags from the four flags only; each new organ grants or marks.\n\n' +
            'OUTPUT FORMAT: exactly one JSON object. No markdown, no code fences, no explanation outside the JSON.'
        );
    }

    /**
     * One-line component entry for the prompt vocabulary.
     * @param {Object} component - normalized component entry.
     * @returns {string}
     */
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

    /**
     * The wearable part of the item vocabulary for the prompt: every item that
     * declares `wear.minVolume`, as `<key> (<name>, needs N free volume)`.
     * @returns {string}
     */
    _wearableLines() {
        const wearable = Object.values(this.items).filter((item) => item.minVolume !== null);
        if (wearable.length === 0) return '(none — this world has no wearable item; a garment must be authored in "garments")';
        return wearable
            .map((item) => '- ' + item.name + ' (' + item.displayName + ', needs ' + item.minVolume + ' free volume)')
            .join('\n');
    }

    /**
     * Grants object to a compact string (e.g. "Physical.strength 50, Movement.move 20").
     * @param {Object} grants
     * @returns {string}
     */
    _grantsString(grants) {
        return Object.entries(grants)
            .map(([key, value]) => key + ' ' + value)
            .join(', ');
    }

    /**
     * One-line blueprint example from the live blueprint trees. A mount that
     * authored options (`[type, slot, { … }]`) is still shown by type and slot: the
     * example teaches the shape of a body, not every option a joint declares.
     * @param {string} name
     * @param {Array} tree
     * @returns {string}
     */
    _blueprintExampleLine(name, tree) {
        const children = tree.map((child) => {
            if (Array.isArray(child) && child.length >= 2 && typeof child[1] === 'string') {
                return child[0] + ' (' + child[1] + ')';
            }
            return String(child);
        });
        return '- ' + name + ': ' + children.join(', ');
    }

    /**
     * User message: the character identity from the card + the design request.
     * @param {{cardId: string, name: string, description: string, personality: string}} identity
     * @returns {string}
     */
    _buildUserPrompt(identity) {
        const parts = [
            'Design the body of this character:',
            'Character name: ' + identity.name
        ];
        if (identity.description) {
            parts.push('Character description:\n' + identity.description);
        }
        if (identity.personality) {
            parts.push('Character personality:\n' + identity.personality);
        }
        if (!identity.description && !identity.personality) {
            parts.push('Note: this card has no description or personality; base the design on the name alone.');
        }
        parts.push('Respond with ONLY the JSON object matching the schema in the system prompt.');
        return parts.join('\n\n');
    }

    // ================================================================
    // Response parsing + validation
    // ================================================================

    /**
     * Parses a JSON object out of the model content, tolerating a markdown
     * code fence (```json ... ```) around the payload.
     * @param {string|null} content - raw model content.
     * @returns {Object|null} - the parsed object, or null when there is no
     *   parseable JSON object (the caller turns null into a validation error).
     */
    _extractDesignJson(content) {
        if (typeof content !== 'string') {
            return null;
        }
        let text = content.trim();
        if (text.startsWith('```')) {
            const fenceEnd = text.lastIndexOf('```');
            if (fenceEnd === -1) {
                return null;
            }
            text = text.slice(3, fenceEnd).trimStart();
            // Skip an optional language marker (e.g. `json`) on the first
            // line of the fence — the model often emits it before the payload.
            const firstNewline = text.indexOf('\n');
            if (firstNewline !== -1) {
                const marker = text.slice(0, firstNewline).trim();
                if (/^[a-z0-9+-]+$/i.test(marker) && marker.length <= 32) {
                    text = text.slice(firstNewline);
                }
            }
            text = text.trim();
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            return null;
        }
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    }

    /**
     * Validates the model design and normalizes it to a frozen shape. Rules
     * (the ones the prompt states):
     *   1. every body-tree component is available or proposed in "components";
     *   2. new-recipe organs are available organs or organs this design proposes;
     *   3. the blueprintId is valid for its path (a model-chosen unique slug, or
     *      a non-empty string when card-derived via { cardNameId }); a card-derived
     *      id may reuse the card's own previously-saved body;
     *   4. the tree has at most MAX_BODY_NODES nodes;
     *   5. the droid-type key is a distinct registry key from every part in the
     *      tree (the [root] pointer must not overwrite a part's sub-tree).
     * Plus shape rules: rationale required, valid recipe fields, material
     * fractions summing to 1.0.
     * @param {Object|null} raw - parsed model output (null when not valid JSON object).
     * @param {string} cardId
     * @param {{
     *   allowExistingBlueprint?: boolean,
     *   cardNameId?: boolean
     * }} [options] -
     *   - allowExistingBlueprint: when true, the model-chosen blueprintId collision
     *     check is skipped (save path: reusing an existing blueprint id is intended
     *     and overwrites it).
     *   - cardNameId: when true, the blueprintId is the card's display name (set by
     *     designBody / persisted by saveDesign, not invented by the model) and is
     *     validated as a non-empty string — no slug and no collision check — because
     *     it is deterministic per card, not a model-invented id.
     *   All other rules (structure, components, materials, organs, node/depth cap,
     *   distinct droid type) always apply, regardless of flags.
     * @returns {{blueprintId: string, rationale: string, structure: object, components: Array}}
     * @throws {DesignValidationError}
     */
    _validateDesign(raw, cardId, options) {
        const allowExistingBlueprint = (options && options.allowExistingBlueprint) === true;
        const errors = [];
        // Case-insensitive collision check: blueprint ids are slugs, but the
        // data file keys may mix case, so compare in a canonical lower form.
        const existingBlueprintIds = new Set(
            Object.keys(this.existingBlueprints).map((key) => key.toLowerCase())
        );
        const proposedNames = new Set();
        const structureRefs = [];

        // Whole-object shape.
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new DesignValidationError(cardId, ['the design was not a JSON object']);
        }

        // blueprintId. Model-chosen ids must be a unique slug; card-derived ids
        // (the card's display name, set by designBody and saveDesign) are only
        // required to be a non-empty string — they are not invented by the model
        // and may reuse the card's own previously-saved body.
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

        // rationale.
        const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : '';
        if (rationale.length === 0) {
            errors.push('"rationale" must be a non-empty string');
        }

        // structure (body tree).
        const structure = raw.structure;
        if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
            errors.push('"structure" must be the body tree object');
        } else {
            this._walkStructure(structure, structureRefs, 0, errors);
        }
        if (structureRefs.length > MAX_BODY_NODES) {
            errors.push('the body tree has ' + structureRefs.length + ' nodes (max ' + MAX_BODY_NODES + ')');
        }

        // New organs (the designer's own internal components): static claims - grants
        // over the closed stat vocabulary, optional flags, a volume. Their names are
        // proposed here, so a component's "internalComponents" may reference them
        // alongside the shipped organs.
        const rawOrgans = raw.internalComponents;
        const organs = [];
        const proposedOrganNames = new Set();
        if (rawOrgans === undefined || rawOrgans === null) {
            organs.length = 0;
        } else {
            if (!Array.isArray(rawOrgans)) {
                errors.push('"internalComponents" must be an array of new organ definitions');
            } else if (rawOrgans.length > MAX_IC_RECIPES) {
                errors.push('"internalComponents" has ' + rawOrgans.length + ' entries (max ' + MAX_IC_RECIPES + ')');
            } else {
                rawOrgans.forEach((organ, index) => {
                    const at = '"internalComponents[' + index + ']'; // leading quote only; field names go inside
                    if (!organ || typeof organ !== 'object' || Array.isArray(organ)) {
                        errors.push(at + '"] must be an organ object');
                        return;
                    }
                    const name = organ.name;
                    if (!isSlug(name)) {
                        errors.push(at + '.name" must be an id (letters and digits only, 1-31 chars)');
                        return;
                    }
                    if (this.organs[name]) {
                        errors.push(at + '.name" "' + name + '" collides with an organ the world already has');
                        return;
                    }
                    if (proposedOrganNames.has(name)) {
                        errors.push(at + '.name" "' + name + '" is already proposed by this design');
                        return;
                    }
                    let displayName = name;
                    if (organ.displayName !== undefined) {
                        if (typeof organ.displayName !== 'string') {
                            errors.push(at + '.displayName" must be a string');
                            return;
                        }
                        const label = organ.displayName.trim();
                        if (label.length === 0) {
                            errors.push(at + '.displayName" must be a non-empty string');
                            return;
                        }
                        if (label.length > MAX_IC_LABEL_CHARS) {
                            errors.push(at + '.displayName" must be at most ' + MAX_IC_LABEL_CHARS + ' characters');
                            return;
                        }
                        displayName = label;
                    }
                    // A designer organ is a STATIC definition: grants and flags only.
                    // Everything else (overTime, install gates, target types) belongs
                    // to the world; a per-turn effect carried by a design's organ
                    // would be a loop the save cannot see.
                    const foreignKey = Object.keys(organ).find((key) =>
                        !['name', 'displayName', 'grants', 'grantsFlags', 'volume'].includes(key));
                    if (foreignKey !== undefined) {
                        errors.push(at + '"] carries "' + foreignKey + '": a designer organ is static (grants and flags only)');
                        return;
                    }
                    const grants = this._validateOrganGrants(organ.grants, at, errors);
                    if (grants === null) return;
                    const flags = this._validateOrganFlags(organ.grantsFlags, at, errors);
                    if (flags === null) return;
                    if (Object.keys(grants).length === 0 && flags.length === 0) {
                        errors.push(at + '"] grants no stat and marks no flag (would be inert, like a component without an organ)');
                        return;
                    }
                    if (!Number.isInteger(organ.volume) || organ.volume < 1 || organ.volume > 40) {
                        errors.push(at + '.volume" must be an integer in 1..40');
                        return;
                    }
                    proposedOrganNames.add(name);
                    const narrowed = {
                        name: name,
                        displayName: displayName,
                        volume: organ.volume
                    };
                    if (Object.keys(grants).length > 0) narrowed.grants = grants;
                    if (flags.length > 0) narrowed.grantsFlags = flags;
                    organs.push(narrowed);
                });
            }
        }

        // new component recipes.
        const rawComponents = raw.components;
        const components = [];
        if (rawComponents === undefined || rawComponents === null) {
            components.length = 0;
        } else {
            if (!Array.isArray(rawComponents)) {
                errors.push('"components" must be an array of new component recipes');
            } else {
                rawComponents.forEach((recipe, index) => {
                    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
                        errors.push('"components[' + index + ']" must be an object');
                        return;
                    }
                    const name = recipe.name;
                    if (!isSlug(name)) {
                        errors.push('"components[' + index + '].name" must be an id (letters and digits only, 1-31 chars)');
                        return;
                    }
                    if (this.components[name] || proposedNames.has(name)) {
                        errors.push('"components[' + index + '].name" "' + name + '" collides with an existing or previously proposed component');
                        return;
                    }
                    proposedNames.add(name);

                    const form = recipe.form;
                    if (!form || typeof form !== 'object') {
                        errors.push('"components[' + index + '].form" must be an object');
                        return;
                    }
                    if (!Number.isInteger(form.volume) || form.volume < 1 || form.volume > 40) {
                        errors.push('"components[' + index + '].form.volume" must be an integer in 1..40');
                    }
                    if (!form.position || typeof form.position !== 'object' || !Number.isInteger(form.position.x) || !Number.isInteger(form.position.y)) {
                        errors.push('"components[' + index + '].form.position" must be { x: integer, y: integer }');
                    }

                    const materials = this._narrowMaterials(recipe.materials, '"components[' + index + '].materials"', errors);
                    if (materials.length === 0) return;

                    if (recipe.internalComponents !== undefined && !Array.isArray(recipe.internalComponents)) {
                        errors.push('"components[' + index + '].internalComponents" must be an array of organ ids');
                    } else if (recipe.internalComponents) {
                        recipe.internalComponents.forEach((ic, ii) => {
                            const organName = typeof ic === 'string'
                                ? ic
                                : (ic && typeof ic === 'object' && typeof ic.type === 'string' ? ic.type : null);
                            if (!organName || (!this.organs[organName] && !proposedOrganNames.has(organName))) {
                                errors.push(
                                    '"components[' + index + '].internalComponents[' + ii + ']" "' + String(organName) +
                                    '" is not an available organ and not proposed in "internalComponents"');
                            }
                        });
                    }

                    if (recipe.energyCapacity !== undefined &&
                        (!Number.isInteger(recipe.energyCapacity) || recipe.energyCapacity < 0)) {
                        errors.push('"components[' + index + '].energyCapacity" must be an integer >= 0');
                    }
                });
            }
        }

        // What the design invents to dress the body, and what it says the body wears.
        const garments = this._validateGarments(raw.garments, errors);
        const outfit = this._validateOutfit(raw.outfit, { structureRefs, garments }, errors);

        // Resolve references: every node must be available or proposed.
        const unknownRefs = [...new Set(structureRefs)]
            .filter((name) => !this.components[name] && !proposedNames.has(name));
        if (unknownRefs.length > 0) {
            errors.push('unknown component(s) in the body tree: ' + unknownRefs.join(', ') +
                ' (every node must be an available component or a recipe in "components"');
        }

        if (errors.length > 0) {
            throw new DesignValidationError(cardId, errors);
        }

        const normalizedComponents = (rawComponents ? rawComponents : [])
            .map((recipe) => ({
                name: recipe.name,
                form: {
                    volume: recipe.form.volume,
                    position: { x: recipe.form.position.x, y: recipe.form.position.y }
                },
                materials: recipe.materials.map((m) => ({
                    material: m.material,
                    fraction: m.fraction
                })),
                internalComponents: (recipe.internalComponents ? recipe.internalComponents : [])
                    .map((ic) => (typeof ic === 'string' ? ic : {
                        type: ic.type,
                        grants: ic.grants
                    })),
                energyCapacity: recipe.energyCapacity
            }));

        const normalized = this._normalizeDesign({
            blueprintId,
            rationale,
            structure,
            components: normalizedComponents,
            garments,
            internalComponents: organs,
            outfit,
            outfitDeclared: Array.isArray(raw.outfit)
        });

        // The droid-type key must be a distinct registry key from every component
        // used in the tree, otherwise the [root] pointer would overwrite (or
        // cycle through) that part's sub-tree entry. Enforced on both the design
        // and save paths.
        const { componentNames } = this._flattenTree(normalized);
        if (componentNames.has(blueprintId)) {
            throw new DesignValidationError(
                cardId,
                [
                    '"blueprintId" must not be the name of any component used in the body tree (the droid type must be a distinct key from every part it contains)'
                ]
            );
        }

        return normalized;
    }

    /**
     * Recursive structural check of the body tree: valid component id per node,
     * slot must be null or a non-empty string, children must be an array, and
     * depth is bounded (JSON cannot cycle, but depth is).
     * @private
     */
    _walkStructure(node, refs, depth, errors) {
        if (depth > MAX_TREE_DEPTH) {
            errors.push('the body tree is deeper than ' + MAX_TREE_DEPTH + ' levels');
            return;
        }
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            errors.push('a body-tree node must be an object');
            return;
        }
        const component = node.component;
        if (!isSlug(component)) {
            errors.push('a body-tree node has a bad component id: ' + JSON.stringify(node.component));
            return;
        }
        refs.push(component);
        const slot = node.slot;
        if (slot !== null && slot !== undefined) {
            if (typeof slot !== 'string' || slot.trim().length === 0) {
                errors.push('a body-tree slot must be null or a non-empty string');
            }
        }
        // What the mount declares about itself (`hidesWithParent`) is a boolean or
        // nothing. Absent is not false: the world writes the mark and never its
        // negation (`entityController.createEntityFromBlueprint`), so a written
        // `false` would be a second claim about a joint the data answers by silence.
        if (node.hidesWithParent !== undefined && typeof node.hidesWithParent !== 'boolean') {
            errors.push('a body-tree node "hidesWithParent" must be a boolean when present');
        }
        const children = node.children;
        if (children !== undefined && children !== null) {
            if (!Array.isArray(children)) {
                errors.push('"children" of a body-tree node must be an array');
            } else {
                children.forEach((child) => this._walkStructure(child, refs, depth + 1, errors));
            }
        }
    }

    /**
     * The material list a recipe authors: available materials, fractions in (0, 1],
     * summing to 1.0 within `MATERIAL_FRACTION_TOLERANCE`. One rule for the two
     * things a design can be made of, a component and a garment (`CHG-2`).
     * @param {Array} materials - the raw list.
     * @param {string} at - where it came from, for the error text (ends with `"`).
     * @param {string[]} errors - collector.
     * @returns {Array<{material: string, fraction: number}>} (used only when validation passes)
     * @private
     */
    _narrowMaterials(materials, at, errors) {
        if (!materials || !Array.isArray(materials) || materials.length === 0) {
            errors.push(at + ' must be a non-empty array');
            return [];
        }
        materials.forEach((m, mi) => {
            if (!m || typeof m !== 'object') {
                errors.push(at + '[' + mi + ']" must be an object with "material" and "fraction"');
                return;
            }
            if (!this.materials[m.material]) {
                errors.push(at + '[' + mi + '].material" "' + String(m.material) + '" is not an available material');
            }
            if (typeof m.fraction !== 'number' || !Number.isFinite(m.fraction) || m.fraction <= 0 || m.fraction > 1) {
                errors.push(at + '[' + mi + '].fraction" must be a number in (0, 1]');
            }
        });
        const fractionSum = materials.reduce((sum, m) => sum + ((m && typeof m.fraction === 'number') ? m.fraction : 0), 0);
        if (!Number.isFinite(fractionSum) || Math.abs(fractionSum - 1) > MATERIAL_FRACTION_TOLERANCE) {
            errors.push(at + ' fractions sum to ' + fractionSum + ' (must sum to 1.0)');
        }
        return materials.map((m) => ({ material: m ? m.material : undefined, fraction: m ? m.fraction : undefined }));
    }

    /**
     * The stat contributions a designer organ grants. A designer organ is a
     * FUNCTION source: it grants only the four function stats the world derives
     * from organs (the `StatVocabulary` FUNCTION set), keyed in the `Group.stat`
     * wire form. Anything else - matter stats, volume, energy, a made-up key -
     * would give a stat a second source and break one-source-per-stat derivation,
     * so it is refused here, before the definition ever reaches the IC registry.
     *
     * @param {Object|undefined} rawGrants
     * @param {string} at - where it came from, for the error text: the index-qualified identifier with its leading quote but no trailing quote, so field names are appended inside the quotes.
     * @param {string[]} errors - collector.
     * @returns {Object|null} the narrowed `{ [statKey]: number }`, or `null` when
     *   the shape is wrong (the caller stops on `null`).
     * @private
     */
    _validateOrganGrants(rawGrants, at, errors) {
        if (rawGrants === undefined || rawGrants === null) return {};
        if (typeof rawGrants !== 'object' || Array.isArray(rawGrants)) {
            errors.push(at + '.grants" must be an object of stat key to number');
            return null;
        }
        const narrowed = {};
        for (const [key, value] of Object.entries(rawGrants)) {
            if (!GRANTABLE_STAT_KEYS.includes(key)) {
                errors.push(at + '.grants" key "' + String(key) + '" is not grantable by an organ (allowed: ' + GRANTABLE_STAT_KEYS.join(', ') + ')');
                continue;
            }
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                errors.push(at + '.grants"["' + key + '"] must be a number >= 0');
                continue;
            }
            narrowed[key] = value;
        }
        return narrowed;
    }

    /**
     * The flags a designer organ marks on its host - the world's closed flag
     * vocabulary (`StatVocabulary.FLAG_NAMES`). Marking a flag is how the shipped
     * organs `corrosiveGland` and `sensitiveNerve` gate their host; a designer
     * organ marks through the same channel and no other.
     *
     * @param {Array|undefined} rawFlags
     * @param {string} at - where it came from, for the error text: the index-qualified identifier with its leading quote but no trailing quote, so field names are appended inside the quotes.
     * @param {string[]} errors - collector.
     * @returns {Array<string>|null} the narrowed flag list, or `null` on a shape error.
     * @private
     */
    _validateOrganFlags(rawFlags, at, errors) {
        if (rawFlags === undefined || rawFlags === null) return [];
        if (!Array.isArray(rawFlags)) {
            errors.push(at + '.grantsFlags" must be an array of flag names');
            return null;
        }
        const narrowed = [];
        rawFlags.forEach((flag, i) => {
            if (typeof flag !== 'string' || !GRANTABLE_FLAGS.includes(flag)) {
                errors.push(at + '.grantsFlags[' + i + ']" "' + String(flag) + '" is not a known flag (allowed: ' + GRANTABLE_FLAGS.join(', ') + ')');
                return;
            }
            if (!narrowed.includes(flag)) narrowed.push(flag);
        });
        return narrowed;
    }

    /**
     * The new WEARABLE ITEMS a design invents (`garments`). A garment is an item the
     * character carries and wears, never a node of the body tree, so its rules are
     * the item registry's: matter, volume, and a `wear.minVolume` the part it goes on
     * must have free - and it asks no more of a body than it takes itself.
     * @param {Array|undefined} rawGarments
     * @param {string[]} errors - collector.
     * @returns {Array<Object>} the narrowed recipes (used only when validation passes)
     * @private
     */
    _validateGarments(rawGarments, errors) {
        if (rawGarments === undefined || rawGarments === null) return [];
        if (!Array.isArray(rawGarments)) {
            errors.push('"garments" must be an array of new wearable item recipes');
            return [];
        }
        if (rawGarments.length > MAX_GARMENTS) {
            errors.push('"garments" has ' + rawGarments.length + ' entries (max ' + MAX_GARMENTS + ')');
        }
        const narrowed = [];
        const proposed = new Set();
        rawGarments.forEach((garment, index) => {
            const at = '"garments[' + index + ']"';
            if (!garment || typeof garment !== 'object' || Array.isArray(garment)) {
                errors.push(at + ' must be an object');
                return;
            }
            if (!isSlug(garment.name)) {
                errors.push(at + '.name" must be an id (letters and digits only, 1-31 chars)');
                return;
            }
            if (this.items[garment.name] || this.components[garment.name] || proposed.has(garment.name)) {
                errors.push(at + '.name" "' + garment.name + '" collides with an existing item, component, or previously proposed garment');
                return;
            }
            proposed.add(garment.name);

            if (!garment.form || typeof garment.form !== 'object') {
                errors.push(at + '.form" must be an object with "volume"');
                return;
            }
            const volume = garment.form.volume;
            if (!Number.isInteger(volume) || volume < 1 || volume > 40) {
                errors.push(at + '.form.volume" must be an integer in 1..40');
            }
            const minVolume = (garment.wear && typeof garment.wear === 'object') ? garment.wear.minVolume : undefined;
            if (!Number.isInteger(minVolume) || minVolume < 1 || (Number.isInteger(volume) && minVolume > volume)) {
                errors.push(at + '.wear.minVolume" must be an integer in 1..' + (Number.isInteger(volume) ? volume : 'the garment volume'));
            }

            const materials = this._narrowMaterials(garment.materials, at + '.materials', errors);

            let displayName = '';
            if (garment.displayName !== undefined) {
                const label = typeof garment.displayName === 'string' ? garment.displayName.trim() : '';
                if (!label || label.length > MAX_GARMENT_LABEL_CHARS) {
                    errors.push(at + '.displayName" must be a string of 1-' + MAX_GARMENT_LABEL_CHARS + ' characters when present');
                } else {
                    displayName = label;
                }
            }

            let visual = null;
            if (garment.visual !== undefined) {
                try {
                    visual = narrowVisualBlock(garment.visual, at);
                } catch (error) {
                    errors.push(error.message);
                }
            }

            narrowed.push({
                name: garment.name,
                displayName: displayName || String(garment.name),
                form: { volume },
                materials,
                wear: { minVolume },
                ...(visual ? { visual } : {})
            });
        });
        return narrowed;
    }

    /**
     * What the design says the body is born wearing. An authored list is a claim the
     * save honors even when it is EMPTY (born wearing nothing, and the spawn
     * loadout's default garment stands down); an absent field says nothing about
     * clothing - which is a different sentence, and `outfitDeclared` is how the two
     * stay distinguishable through a normalized design (`wiki/decisions/outfits.md`).
     * @param {Array|undefined} rawOutfit
     * @param {{ structureRefs: string[], garments: Array }} context - the body this
     *   outfit hangs on, and the garments the same design proposed.
     * @param {string[]} errors - collector.
     * @returns {Array<{ item: string, component: string }>}
     * @private
     */
    _validateOutfit(rawOutfit, { structureRefs, garments }, errors) {
        if (rawOutfit === undefined || rawOutfit === null) return [];
        if (!Array.isArray(rawOutfit)) {
            errors.push('"outfit" must be an array of { item, component }');
            return [];
        }
        if (rawOutfit.length > MAX_OUTFIT_ENTRIES) {
            errors.push('"outfit" has ' + rawOutfit.length + ' entries (max ' + MAX_OUTFIT_ENTRIES + ')');
        }
        const bodyParts = new Set(structureRefs);
        const proposedGarments = new Set(garments.map((garment) => garment.name));
        const narrowed = [];
        rawOutfit.forEach((entry, index) => {
            const at = '"outfit[' + index + ']"';
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                errors.push(at + ' must be an object with "item" and "component"');
                return;
            }
            const item = typeof entry.item === 'string' ? entry.item.trim() : '';
            const component = typeof entry.component === 'string' ? entry.component.trim() : '';
            if (!item || !component) {
                errors.push(at + ' must name both an "item" and a "component"');
                return;
            }
            const known = this.items[item];
            if (!proposedGarments.has(item) && (!known || known.minVolume === null)) {
                errors.push(at + '.item" "' + item + '" is not a wearable item - propose it in "garments" or use one of the WEARABLE ITEMS');
            }
            if (!bodyParts.has(component)) {
                errors.push(at + '.component" "' + component + '" is not a component of this body');
            }
            narrowed.push({ item, component });
        });
        return narrowed;
    }

    /**
     * Frozen, normalized design (slot defaults to null, missing children to []).
     * Takes one object because the design now carries six things (`CHG-4`).
     * @private
     */
    /**
     * The canonical frozen shape of a validated design, what `designBody` returns
     * and what `saveDesign` accepts. The organs list is always present: `[]` means
     * the design invented no organs, so downstream code can iterate it unconditionally.
     */
    _normalizeDesign({ blueprintId, rationale, structure, components, garments, internalComponents, outfit, outfitDeclared }) {
        return Object.freeze({
            blueprintId: blueprintId,
            rationale: rationale,
            structure: this._normalizeTree(structure),
            components: components,
            garments: garments,
            internalComponents: internalComponents,
            // Absent, not empty, when the design said nothing about clothing: the
            // world distinguishes "this body wears nothing" (`outfit: []`) from "this
            // body was never dressed by a design" (no key at all), and the design
            // object round-trips through Save with that distinction intact.
            ...(outfitDeclared ? { outfit: outfit } : {})
        });
    }

    _normalizeTree(node) {
        const normalized = {
            component: node.component,
            slot: (node.slot == null) ? null : node.slot,
            children: (Array.isArray(node.children))
                ? node.children.map((child) => this._normalizeTree(child))
                : []
        };
        // Absent, not false - the same rule the live instance follows.
        if (node.hidesWithParent === true) normalized.hidesWithParent = true;
        return Object.freeze(normalized);
    }

    /**
     * The blueprint mount entry for one design node: `"type"`, `["type", "slot"]`,
     * or - when the mount declared it hides with its parent -
     * `["type", "slot", { "hidesWithParent": true }]`, the shape
     * `entityController.mountOptions` reads onto the instance.
     *
     * Writing that third element is the point. Before it, a design that redefined a
     * sub-tree dropped every mark the shipped data had authored on those joints -
     * the design spoke the body but not what hangs behind its cloth.
     * @private
     * @param {{ component: string, slot: string|null, hidesWithParent?: true }} child
     * @returns {string|Array} the mount entry as `blueprints.json` stores it
     */
    _mountEntry(child) {
        if (child.hidesWithParent !== true) {
            return child.slot != null ? [child.component, child.slot] : child.component;
        }
        // A marked mount with no slot says the identifier `expandBlueprint` itself
        // gives a slotless mount: the options object is the third element, and there
        // is no other way to reach it without inventing a body position.
        return [
            child.component,
            child.slot != null ? child.slot : DEFAULT_MOUNT_SLOT,
            { hidesWithParent: true }
        ];
    }

    /**
     * Total node count of a validated body tree (used for logging + the UI).
     * @private
     */
    _countNodes(tree) {
        const children = Array.isArray(tree.children) ? tree.children : [];
        return 1 + children.reduce((sum, child) => sum + this._countNodes(child), 0);
    }

    // ================================================================
    // Vocabulary loading (B-3 data seam, once per process)
    // ================================================================

    /**
     * @returns {Object<string, {name: string, volume: number|null, materials: Array<{material: string, fraction: number}>, organs: Array<string>, energyCapacity: number|null}>}
     */
    _loadComponents() {
        const raw = DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS);
        const components = {};
        for (const [name, recipe] of Object.entries(raw)) {
            if (name.startsWith('_') || !recipe || typeof recipe !== 'object') {
                continue;
            }
            const materials = (Array.isArray(recipe.materials) ? recipe.materials : [])
                .filter((m) => m && typeof m === 'object' && typeof m.material === 'string')
                .map((m) => ({
                    material: m.material,
                    fraction: (typeof m.fraction === 'number' ? m.fraction : 0)
                }));
            const organs = (Array.isArray(recipe.internalComponents) ? recipe.internalComponents : [])
                .map((ic) => (typeof ic === 'string' ? ic : (ic && typeof ic.type === 'string' ? ic.type : null)))
                .filter((o) => o !== null);
            const volume = (recipe.form && typeof recipe.form.volume === 'number') ? recipe.form.volume : null;
            const energyCapacity = (typeof recipe.energyCapacity === 'number' && Number.isFinite(recipe.energyCapacity))
                ? recipe.energyCapacity
                : null;
            components[name] = { name, volume, materials, organs, energyCapacity };
        }
        return Object.freeze(components);
    }

    /**
     * The item registry, as the designer needs it: the key, the name the prose
     * speaks, and whether the item is wearable at all (`wear.minVolume`).
     * @returns {Object<string, {name: string, displayName: string, minVolume: number|null}>}
     */
    _loadItems() {
        const raw = DataLoader.loadRegistry(REGISTRY_KINDS.INVENTORY_ITEMS);
        const items = {};
        for (const [name, recipe] of Object.entries(raw)) {
            if (name.startsWith('_') || !recipe || typeof recipe !== 'object') {
                continue;
            }
            const minVolume = (recipe.wear && typeof recipe.wear.minVolume === 'number')
                ? recipe.wear.minVolume
                : null;
            const displayName = (typeof recipe.name === 'string' && recipe.name.trim().length > 0)
                ? recipe.name.trim()
                : name;
            items[name] = { name, displayName, minVolume };
        }
        return Object.freeze(items);
    }

    /**
     * @returns {Object<string, {name: string, density: number|null}>}
     */
    _loadMaterials() {
        const raw = DataLoader.loadRegistry(REGISTRY_KINDS.MATERIALS);
        const materials = {};
        for (const [name, recipe] of Object.entries(raw)) {
            if (name.startsWith('_') || !recipe || typeof recipe !== 'object') {
                continue;
            }
            materials[name] = {
                name,
                density: (typeof recipe.density === 'number' ? recipe.density : null)
            };
        }
        return Object.freeze(materials);
    }

    /**
     * @returns {Object<string, {name: string, grants: Object|null}>}
     */
    _loadOrgans() {
        const raw = DataLoader.loadRegistry(REGISTRY_KINDS.INTERNAL_COMPONENTS);
        const organs = {};
        for (const [name, recipe] of Object.entries(raw)) {
            if (name.startsWith('_') || !recipe || typeof recipe !== 'object') {
                continue;
            }
            organs[name] = {
                name,
                grants: (recipe.grants && typeof recipe.grants === 'object') ? recipe.grants : null
            };
        }
        return Object.freeze(organs);
    }

    /**
     * Blueprint trees present in the world (data/mods/core-blueprints/blueprints.json).
     * @returns {Object<string, Array>}
     */
    _loadBlueprints() {
        const raw = DataLoader.loadRegistry(REGISTRY_KINDS.BLUEPRINTS);
        const blueprints = {};
        for (const [name, tree] of Object.entries(raw)) {
            if (name.startsWith('_') || !Array.isArray(tree)) {
                continue;
            }
            blueprints[name] = tree;
        }
        return Object.freeze(blueprints);
    }
}

export default AgentBodyController;

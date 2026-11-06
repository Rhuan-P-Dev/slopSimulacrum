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
 *      against the vocabulary (body tree + new component recipes),
 *   4. returns a frozen design with the prompt captured for inspection (meta);
 *      the blueprint id is the card's display name (name field, stem fallback) —
 *      the model does not choose it; saveDesign persists that design into data/
 *      and spawnCards later match the world's droid type to the card by name.
 *   5. persists a validated design (saveDesign) into data/ so a generated body
 *      becomes real: new component recipes are merged into components.json and
 *      the body tree is written to blueprints.json, overwriting any blueprint
 *      entry it redefines (the droid-type pointer + each component's sub-tree).
 *      A timestamped backup of each written file is taken before the update.
 *
 * designBody itself stays display-only (it never writes); persistence is the
 * explicit saveDesign action, which re-validates and then writes through the
 * data seam (CR B-3). The LLM cost-guard still applies to designBody: per-IP
 * rate limiter in src/routes/agentBodyRoutes.js (SEC-9) and the named token
 * budget (`LLM_AGENT_BODY_MAX_TOKENS`, 10x the global `LLM_DEFAULT_MAX_TOKENS`),
 * because the precision reasoning model counts thinking tokens against that cap
 * and a small budget truncates the design. The LLM timeout is the seam's
 * REQUEST_TIMEOUT_MS (env LLM_TIMEOUT_MS), matching /llm/chat — no second
 * timeout knob. A designed mount carries what hangs behind its cloth: a node may
 * declare `hidesWithParent`, and `saveDesign` writes it as the third element of
 * the blueprint mount (`["maleBreast", "left", { "hidesWithParent": true }]`), the
 * shape the live world already reads to take a part out of the round prose when
 * the part it hangs on is covered (`PerceptionController._coveredIds`). See
 * wiki/decisions/agent-body-design.md.
 *
 * @module src/controllers/networking/AgentBodyController
 */

import LLMController from './LLMController.js';
import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import { LLM_DEFAULT_MAX_TOKENS, LLM_DEFAULT_TEMPERATURE } from '../../utils/Constants.js';
import { readCardFiles } from '../../controllers/logic/CardSpawnLogic.js';
import { readCharaCard } from '../../utils/PngCharaReader.js';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';
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
 */
const PROMPT_VERSION = '1.3.0';
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

// Files the save action (saveDesign) persists to (CR B-3: writes go only through
// this module's DataLoader seam, never raw fs). The paths come from the seam's
// kind table, so this module never names a data file itself.
const COMPONENTS_FILE = DataLoader.registrySourcePath(REGISTRY_KINDS.COMPONENTS);
const BLUEPRINTS_FILE = DataLoader.registrySourcePath(REGISTRY_KINDS.BLUEPRINTS);

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

export { CardNotFoundError, DesignValidationError, PROMPT_KIND, PROMPT_VERSION, LLM_AGENT_BODY_MAX_TOKENS };

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
     * @param {{ llmController: { chatFull: (messages: object[], options?: object) => Promise<object> } }} options
     *   - options.llmController: the LLM seam (CR B-2). The caller's own LLMController
     *     instance is injected so provider config follows the host process.
     */
    constructor({ llmController }) {
        if (!llmController || typeof llmController.chatFull !== 'function') {
            throw new TypeError('AgentBodyController: "llmController" must expose chatFull (the LLM seam, CR B-2)');
        }
        this.llmController = llmController;
        // Vocabulary is loaded once per process (B-3 data seam; data files are
        // static within a run). Frozen so the prompt is stable across calls.
        this.components = this._loadComponents();
        this.materials = this._loadMaterials();
        this.organs = this._loadOrgans();
        this.existingBlueprints = this._loadBlueprints();
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
        const files = readCardFiles();
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
     * Designs the body of the card whose stem is cardId: builds the
     * agent-body-design prompt, calls the LLM through the seam, and validates
     * the returned JSON design.
     *
     * @param {string} cardId - stem of a card PNG under data/cards/ (no extension).
     * @returns {Promise<{
     *   card: {cardId: string, name: string, description: string, personality: string},
     *   body: {blueprintId: string, rationale: string, structure: object, components: Array},
     *   meta: {promptKind: string, promptVersion: string, promptMessages: Array, model: string, finishReason: string, latencyMs: number}
     * }>}
     * @throws {CardNotFoundError} - no card PNG matches cardId.
     * @throws {DesignValidationError} - the model output failed validation (rule list in errors).
     * @throws {LLMError} - provider failure (codes: LLM_TIMEOUT, LLM_HTTP_ERROR, LLM_PARSE_ERROR, LLM_REQUEST_ERROR).
     */
    async designBody(cardId) {
        if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > MAX_CARD_ID_LENGTH) {
            throw new DesignValidationError(String(cardId == null ? 'cardId' : cardId), ['cardId must be a string of 1-128 characters']);
        }

        const file = readCardFiles().find((f) => f.cardId === cardId);
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
            '" (' + this._countNodes(design.structure) + ' body nodes, ' + design.components.length + ' new recipes), ' +
            systemPrompt.length + ' char system prompt, ' + userPrompt.length + ' char user prompt, ' + latencyMs + ' ms',
            { promptKind: PROMPT_KIND, promptVersion: PROMPT_VERSION }
        );

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
            }
        };
    }

    // ================================================================
    // Save action (the display tab's write path)
    // ================================================================

    /**
     * saveDesign — the "Save" action. Re-validates the design against the live
     * vocabulary and persists it into the world:
     *   - new component recipes are merged into data/mods/core-components/components.json
     *     (an existing recipe is never overwritten);
     *   - the body tree is written into data/mods/core-blueprints/blueprints.json as the
     *     droid-type pointer plus every component's sub-tree under its own key.
     *     Every blueprint entry the design touches is overwritten (a droid id
     *     reusing an existing one, or a part redefining its sub-tree, changes
     *     the live world) — this is the explicit, operator-confirmed side-effect.
     *     A timestamped backup of each written file is taken before the write
     *     so the change is always recoverable.
     * Writes go through the data seam (CR B-3). A reload / restart of a running
     * world is what makes the new blueprint visible; this method only writes data.
     *
     * @param {Object} design - { blueprintId, rationale, structure, components }
     *   (may be the frozen body from designBody, or raw model-shape JSON).
     * @returns {{
     *   saved: boolean,
     *   blueprintId: string,
     *   newComponents: string[],
     *   blueprintWritten: string[],
     *   blueprintOverwritten: string[],
     *   backups: { components: string, blueprints: string }
     * }}
     * @throws {DesignValidationError}
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

        // Re-read the live data files (source of truth; the in-memory vocab is
        // frozen at boot) and merge the design on top of the current content.
        const freshComponents = DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS);
        const freshBlueprints = DataLoader.loadRegistry(REGISTRY_KINDS.BLUEPRINTS);

        const nextComponents = this._mergeComponentRecipes(freshComponents, normalized.components || []);
        const blueprintWritten = Object.keys(entries);
        const blueprintOverwritten = blueprintWritten.filter((key) => key in freshBlueprints);

        // Take a pre-write backup of each file we are about to update, then write
        // (atomic per file, through the data seam).
        const backups = {
            components: DataLoader.copyFile(COMPONENTS_FILE, this._backupPath(COMPONENTS_FILE)),
            blueprints: DataLoader.copyFile(BLUEPRINTS_FILE, this._backupPath(BLUEPRINTS_FILE))
        };

        const nextBlueprints = Object.assign({}, freshBlueprints, entries);
        await DataLoader.saveJson(COMPONENTS_FILE, nextComponents);
        await DataLoader.saveJson(BLUEPRINTS_FILE, nextBlueprints);

        return Object.freeze({
            saved: true,
            blueprintId: normalized.blueprintId,
            newComponents: [...new Set((normalized.components || []).map((c) => c.name))],
            blueprintWritten,
            blueprintOverwritten,
            backups
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
     * Merge new component recipes into the registry. Never overwrites an
     * existing recipe: names colliding with built-ins are rejected by
     * _validateDesign, and a name present in the loaded file (built-in or from
     * a previous save) is preserved as-is.
     *
     * @private
     * @param {Object} current - freshly loaded components.json (may include a
     *   "_comment" key, which is preserved verbatim).
     * @param {Array<{ name: string, form: object, materials: Array, internalComponents: Array, energyCapacity?: number }>} recipes
     * @returns {Object} the merged registry.
     */
    _mergeComponentRecipes(current, recipes) {
        const next = Object.assign({}, current);
        recipes.forEach((recipe) => {
            if (!recipe || typeof recipe !== 'object' || typeof recipe.name !== 'string') return;
            if (recipe.name in next) return; // already present: keep whatever is there

            const entry = {
                name: recipe.name,
                form: recipe.form,
                materials: recipe.materials,
                internalComponents: recipe.internalComponents
            };
            if (recipe.energyCapacity !== undefined) {
                entry.energyCapacity = recipe.energyCapacity;
            }
            next[recipe.name] = entry;
        });
        return next;
    }

    /**
     * Timestamped sibling path for a pre-write backup (e.g. data/foo.json.bak-1713099876543).
     * @private
     * @param {string} relativePath
     * @returns {string}
     */
    _backupPath(relativePath) {
        return relativePath + '.bak-' + String(Date.now());
    }

    // ================================================================
    // Prompt building (agent-body-design kind; RP-2 versioned in the prompt
    // itself — the model sees the version header)
    // ================================================================

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
            '    "internalComponents": [ "<one of the AVAILABLE ORGANS>" ] or omitted,\n' +
            '    "energyCapacity": <integer >= 0> or omitted }\n' +
            '  Material fractions within each new recipe must sum to exactly 1.0.\n\n' +
            'RULES\n' +
            '1. Every "component" in "structure" must be either an AVAILABLE COMPONENT (exactly as named below) or a NEW COMPONENT you define in "components".\n' +
            '2. "internalComponents" of a new recipe may only use AVAILABLE ORGANS.\n' +
            '3. The body is named after the card — you do NOT choose a blueprint id. Omit "blueprintId" from your JSON; the server sets it to the card\'s display name.\n' +
            '4. Keep the body compact: at most ' + MAX_BODY_NODES + ' component nodes in the tree.\n' +
            '5. "hidesWithParent" is a fact about THIS joint in THIS body, not about the component type: the same part may hide under the cloth of one body and not under another. Use it sparingly, and only where a garment would really be in front of the part.\n' +
            '6. Make the body recognizable as THIS card, not a generic M1 droid: invent NEW components to express the character\'s defining traits (its name, role, temperament, signature equipment, unique anatomy). The new component recipes are the judgment — the material and organ vocabulary stays fixed so the world remains deterministic.\n\n' +
            'AVAILABLE COMPONENTS (' + Object.keys(this.components).length + ' types):\n' +
            componentLines + '\n\n' +
            'AVAILABLE MATERIALS:\n' +
            materialLines + '\n\n' +
            'AVAILABLE ORGANS:\n' +
            organLines + '\n\n' +
            'EXISTING BLUEPRINT IDS (for reference — existing droid types in the world): ' + blueprintIds + '\n\n' +
            'EXAMPLE BLUEPRINTS (how bodies compose in this world; ["component", "slot"] is a component with a slot):\n' +
            exampleLines + '\n\n' +
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
     *   2. new-recipe organs are available organs;
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

                    const materials = recipe.materials;
                    if (!materials || !Array.isArray(materials) || materials.length === 0) {
                        errors.push('"components[' + index + '].materials" must be a non-empty array');
                        return;
                    }
                    materials.forEach((m, mi) => {
                        if (!m || typeof m !== 'object') {
                            errors.push('"components[' + index + '].materials[' + mi + ']" must be an object with "material" and "fraction"');
                            return;
                        }
                        if (!this.materials[m.material]) {
                            errors.push('"components[' + index + '].materials[' + mi + '].material" "' + String(m.material) + '" is not an available material');
                        }
                        if (typeof m.fraction !== 'number' || !Number.isFinite(m.fraction) || m.fraction <= 0 || m.fraction > 1) {
                            errors.push('"components[' + index + '].materials[' + mi + '].fraction" must be a number in (0, 1]');
                        }
                    });
                    const fractionSum = materials.reduce((sum, m) => sum + (typeof m.fraction === 'number' ? m.fraction : 0), 0);
                    if (!Number.isFinite(fractionSum) || Math.abs(fractionSum - 1) > MATERIAL_FRACTION_TOLERANCE) {
                        errors.push('"components[' + index + '].materials" fractions sum to ' + fractionSum + ' (must sum to 1.0)');
                    }

                    if (recipe.internalComponents !== undefined && !Array.isArray(recipe.internalComponents)) {
                        errors.push('"components[' + index + '].internalComponents" must be an array of organ ids');
                    } else if (recipe.internalComponents) {
                        recipe.internalComponents.forEach((ic, ii) => {
                            const organName = typeof ic === 'string'
                                ? ic
                                : (ic && typeof ic === 'object' && typeof ic.type === 'string' ? ic.type : null);
                            if (!organName || !this.organs[organName]) {
                                errors.push(
                                    '"components[' + index + '].internalComponents[' + ii + ']" "' + String(organName) + '" is not an available organ');
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

        const normalized = this._normalizeDesign(blueprintId, rationale, structure, normalizedComponents);

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
     * Frozen, normalized design (slot defaults to null, missing children to []).
     * @private
     */
    _normalizeDesign(blueprintId, rationale, structure, components) {
        return Object.freeze({
            blueprintId: blueprintId,
            rationale: rationale,
            structure: this._normalizeTree(structure),
            components: components
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

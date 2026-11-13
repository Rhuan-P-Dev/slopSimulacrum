/**
 * KnowledgeController — state controller owning the read-only "Knowledge"
 * codex payload (wiki/subMDs/frontend/knowledge_viewer.md).
 *
 * Per the State Controller pattern (wiki/subMDs/controllers/controller_patterns.md §4),
 * this controller holds the raw registries and has NO cross-controller
 * dependencies: the composition root (src/composition/WorldComposition.js) loads
 * all five `data/*.json` registries via `DataLoader.loadJsonSafe` and injects the
 * ALREADY-LOADED objects here (zero new file I/O — one load, N readers). The
 * cross-layer pinned vocabulary is imported directly from the dependency-free
 * shared module `shared/StatVocabulary.js` (it is code, not a data file).
 *
 * Responsibility: assemble, ONCE at construction, the static reference codex —
 * the property→trait→stat derivation chain (global molds, mapping table,
 * per-material property values, the pinned vocabulary), every recipe with
 * display names resolved against the item registry, and every item type with
 * its full definition: the runtime-resolved volume (the `form` object's
 * `volume` first, then a legacy top-level `volume` — MaterialController._resolveVolume's rule),
 * `externalVolume`, the material composition list, `traits`, and the full raw
 * definition (deep-copied as `definition` so the viewer lists every field,
 * including fields future mods add, with no viewer change). Materials carry
 * their `visual` block (the look a renderer reads — the codex shows it, it
 * never derives from it). The result is a pure function of the data files.
 *
 * Item CAPABILITIES (`capabilities` on each item row) — DECISION, extends the
 * scope note that used to close this paragraph ("the viewer does not compute
 * derived stats"). It now computes exactly ONE derived thing, at RECIPE level:
 * the stat values the item carries before any instance exists, and the actions
 * whose stat requirements those values satisfy. WHY: the engine never links an
 * action to an item — `actions.json` gates on stats alone (`cut` is
 * `Physical.sharpness >= 20`, `shootT1` is `Physical.existence >= 0.01`), and the
 * only reason an item ever satisfies such a requirement is that equipping it
 * seeds its matter-derived stats (HoldingCostController._seedDerivedStatsOnEquip,
 * BUG-134). So "what can this item do" is answerable only by deriving those
 * stats; showing anything less would hide the one mechanism the world uses.
 * The boundary that remains: NOTHING per-instance, no wear, no live world state,
 * no entity — `MaterialController.derive` is called on the recipe (a pure,
 * boot-time function of the data files) through an injected function, not a
 * controller reference. Attribution is deliberately FAITHFUL to the requirement
 * check rather than curated: an equipable item shows every action its derived
 * stats satisfy (so the T1 also shows `cut` — equipped, it carries sharpness
 * 82.5, and the capability scan really does offer it). That coarseness is the
 * engine's, not a decoration added here (wiki/subMDs/frontend/knowledge_viewer.md).
 *
 * Deliberately has NO `getAll()`: the static codex must stay out of the
 * world-state broadcast aggregation (same exclusion rule as CraftingController
 * and RoomChatController — shipping a codex in every full-state update would
 * bloat all clients for zero benefit).
 *
 * @module KnowledgeController
 */

import Logger from '../../utils/Logger.js';
import { isChunkItemType } from '../../utils/Constants.js';
import { DEFAULT_ITEM_VOLUME } from '../../../shared/Defaults.js';
import { getDefinitionFootprint } from '../../utils/definitionVolume.js';
import { resolveRecipeBaseStats } from '../../utils/itemBaseStats.js';
import { describeAction } from './actionSemantics.js';
import {
    TRAIT_GROUPS,
    STAT_NAMES,
    EXISTENCE_GONE_AT,
    EXISTENCE_USABLE_MIN,
    TRAIT_STAT_KEY_PATTERN,
} from '../../../shared/StatVocabulary.js';

// The flat "Group.stat" mapping-key pattern is the shared constant
// TRAIT_STAT_KEY_PATTERN, imported from shared/StatVocabulary.js. MaterialController._validateMappingRegistry() imports the very same
// constant, so the two boot validators can never disagree on key form.

/**
 * The total empty-shape knowledge payload:
 * all three sections present, all arrays/objects empty, vocabulary filled
 * from the shared module. Used by WorldStateController.getKnowledge() when
 * the controller is unwired — the facade must never emit a null envelope
 * member (a null would make the client take the error state instead of
 * the per-section empty states).
 * @returns {Object} A fresh payload object (callers own it).
 */
export function emptyKnowledgePayload() {
    return {
        traitStats: {
            groups: {},
            mappings: [],
            materials: [],
            vocabulary: {
                traitGroups: Object.values(TRAIT_GROUPS),
                stats: Object.values(STAT_NAMES),
                existence: { goneAt: EXISTENCE_GONE_AT, usableMin: EXISTENCE_USABLE_MIN },
            },
        },
        recipes: [],
        items: [],
        actions: [],
    };
}

/**
 * Locale-independent, deterministic string comparator (code-unit order) so the
 * wire contract is independent of the runtime locale — sorting happens on the
 * server, not the client (wiki/subMDs/frontend/knowledge_viewer.md "Ordering").
 * @param {string} a
 * @param {string} b
 * @returns {number}
 * @private
 */
function compareStrings(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

class KnowledgeController {
    /**
     * @param {Object} deps - The ALREADY-LOADED registries (injected by the
     *   composition root; never loaded here).
     * @param {Object} deps.traits - Raw data from data/mods/core-traits/traits.json
     *   ({ group: { stat: number } } — the global trait molds).
     * @param {Object} deps.materials - Raw data from data/mods/core-materials/materials.json
     *   ({ id: { name, density, properties } }).
     * @param {Object} deps.propertyTraitMapping - Raw data from
     *   data/mods/core-property-trait-mapping/propertyTraitMapping.json (flat "Group.stat" keys; each entry has
     *   either `formula` or `sources`).
     * @param {Object} deps.recipes - Raw data from data/mods/core-crafting/crafting.json (keyed by
     *   recipe id).
     * @param {Object} deps.items - Raw data from data/mods/core-inventory-items/inventoryItems.json
     *   (keyed by item type) — also the cross-validation source for every
     *   recipe input/output type (fail-fast at boot, never mid-game).
     * @param {Object} [deps.actions] - Raw data from data/mods/core-actions/actions.json
     *   (keyed by action name): the requirement side of each item's capabilities.
     *   Optional — absent, every item reports no enabled action (a degraded codex,
     *   warned at boot, never a boot failure).
     * @param {Object} [deps.holdingCost] - Raw data from
     *   data/mods/core-holding-cost/holdingCost.json (the `massBurden` model): its
     *   `equipableItems` list is the ONLY per-item equip data the world declares.
     *   Optional — absent, nothing reports as equipable.
     * @param {Function} [deps.deriveStats] - `(itemDef) => stats`, the single
     *   matter→stats authority (`MaterialController.derive`) handed over as a
     *   function, so this controller keeps its no-controller-deps invariant.
     *   Optional — absent, no item reports derived stats or enabled actions.
     */
    constructor({ traits, materials, propertyTraitMapping, recipes, items, actions, holdingCost, deriveStats }) {
        this._traits = traits;
        this._materials = materials;
        // Keep the raw value so the plain-object validator below can reject
        // null/array (fail-fast §6); a valid object — including the {} loadJsonSafe
        // fallback and the recipe-model wrapper — passes through.
        this._propertyTraitMapping = propertyTraitMapping;
        // The mapping registry is the recipe-model wrapper { derivedStats, flagThresholds }
        // (data/mods/core-property-trait-mapping/propertyTraitMapping.json). Normalize it to the flat "Group.stat" body
        // that the validators and the mapping rows operate on; a legacy flat map
        // (no derivedStats) passes through unchanged. Null-safe so a rejected
        // (null/array) registry is validated before it can be dereferenced.
        const _rawMapping = this._propertyTraitMapping;
        this._mappingBody = (_rawMapping && _rawMapping.derivedStats && typeof _rawMapping.derivedStats === 'object' && !Array.isArray(_rawMapping.derivedStats))
            ? _rawMapping.derivedStats
            : (_rawMapping || {});
        this._recipes = recipes;
        this._items = items;
        // Capability side inputs (optional, validated when present). Kept raw so
        // the boot validator sees exactly what was injected.
        this._actions = actions;
        this._holdingCost = holdingCost;
        this._deriveStats = deriveStats;

        // Fail-fast at boot (project rule §6): validate before the payload is
        // assembled so a corrupted registry can never enter the internal state.
        this._validateKnowledgeRegistries();

        // Assemble once and cache: assembly is pure and idempotent, so the
        // getter stays O(clone) on a hot path, never O(re-assembly)
 // (wiki/subMDs/frontend/knowledge_viewer.md).
        this._assembled = this._assembleKnowledge();

        Logger.info(
            `[KnowledgeController] initialized with ${Object.keys(this._traits).length} groups, ` +
            `${Object.keys(this._propertyTraitMapping).length} mappings, ` +
            `${Object.keys(this._materials).length} materials, ` +
            `${Object.keys(this._recipes).length} recipes, ` +
            `${Object.keys(this._items).length} items, ` +
            `${Object.keys(this._actions ?? {}).length} actions`
        );
    }

    /**
 * Returns the full knowledge codex payload of wiki/subMDs/frontend/knowledge_viewer.md:
     * `{ traitStats: { groups, mappings, materials, vocabulary }, recipes, items, actions }`.
     *
     * A FRESH DEEP COPY is returned on every call (defensive-copy rule): callers
     * (the route, the client) can never mutate controller state through it.
     * The getter only clones the cached assembly — it never re-assembles.
     *
     * @returns {{
     *   traitStats: {
     *     groups: Object<string, Object<string, number>>,
     *     mappings: Array<{statKey: string, trait: string, stat: string, formula: string|null, sources: Array<{property: string, weight: number}>}>,
     *     materials: Array<{type: string, name: string, density: number, properties: Object<string, number>, visual: Object|null}>,
     *     vocabulary: {traitGroups: string[], stats: string[], existence: {goneAt: number, usableMin: number}}
     *   },
     *   recipes: Array<{id: string, name: string, description: string|null, inputs: Array<{type: string, quantity: number, name: string}>, outputs: Array<{type: string, quantity: number, name: string}>}>,
     *   items: Array<{type: string, name: string, description: string|null, volume: number, externalVolume: number|null, materials: Array<{material: string, fraction: number, role: string|null}>|null, traits: Object<string, Object<string, number>>, capabilities: {equipable: boolean, capacity: number, footprint: number, baseStats: Object<string, Object<string, number>>, actions: Array<{name: string, description: string|null}>}, definition: Object}>,
     *   actions: Array<{name: string, description: string|null, requirements: Array<{trait: string|null, stat: string|null, minValue: number|null}>, summary: {targeting: string|null, targetingDeclared: boolean, range: number|null, narration: string|null, effects: Array<{type: string, on: string|null, text: string, described: boolean}>, failureEffects: Array<Object>}, definition: Object}>
     * }}
     */
    getKnowledge() {
        return structuredClone(this._assembled);
    }

    // =========================================================================
    // VALIDATION (runs before initialization proceeds — project rule §6)
    // =========================================================================

    /**
     * Validates all five injected registries. Throws TypeError on:
     *   - a registry that is not a plain object (arrays and null rejected; the
     *     loadJsonSafe fallback `{}` is valid, so a missing file degrades to
     *     empty sections instead of a boot failure);
     *   - a mapping key that does not match the flat "Group.stat" pattern (the
     *     same pattern MaterialController's validator uses);
     *   - a mapping entry with neither a non-empty `formula` nor a non-empty
     *     `sources` object;
     *   - a material entry missing `name`/`density`/`properties` (same rules as
     *     MaterialController._validateMaterialsRegistry);
     *   - a recipe entry failing the same structural rules as
     *     CraftingController._validateRecipeDefinitions, INCLUDING the cross-check
     *     that every input/output type exists in the item registry;
     *   - an item entry with a non-numeric `volume` or a non-object `traits`.
     * @private
     */
    _validateKnowledgeRegistries() {
        this._validatePlainObjectRegistry(this._traits, 'traits');
        this._validatePlainObjectRegistry(this._materials, 'materials');
        this._validatePlainObjectRegistry(this._propertyTraitMapping, 'propertyTraitMapping');
        this._validatePlainObjectRegistry(this._recipes, 'recipes');
        this._validatePlainObjectRegistry(this._items, 'items');

        this._validateMappingEntries();
        this._validateMaterialEntries();
        this._validateRecipeEntries();
        this._validateItemEntries();
        this._validateActionEntries();
        this._validateCapabilityInputs();
    }

    /**
     * Validates the action registry entries when the registry was injected:
     * every non-metadata entry is a plain object, and a declared `requirements`
     * gate is an array or a single object — the two shapes the engine's own
     * requirement check accepts, so the codex can never boot on data the runtime
     * cannot read. A declared `minValue` must be a finite number, or absent (absent
     * = no bound, exactly how the engine reads a gate with no threshold).
     * Fail-fast, the same rule as the other registries (§6).
     * @private
     */
    _validateActionEntries() {
        if (this._actions === undefined) return;
        for (const [name, entry] of Object.entries(this._actions)) {
            if (name.startsWith('_')) continue;
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError(`[KnowledgeController] Action "${name}" must be an object.`);
            }
            const reqs = entry.requirements;
            if (reqs !== undefined && reqs !== null && typeof reqs !== 'object') {
                throw new TypeError(`[KnowledgeController] Action "${name}" requirements must be an array or an object.`);
            }
            // A `minValue` that is neither absent nor a finite number has no reading
            // the engine could give it (`value < '20'` coerces by luck, `NaN` never
            // passes), so the codex refuses the registry instead of inventing one.
            // Junk ENTRIES (null, scalars) are left to the shaper, which drops them.
            for (const req of Array.isArray(reqs) ? reqs : (reqs ? [reqs] : [])) {
                if (!req || typeof req !== 'object' || Array.isArray(req)) continue;
                const min = req.minValue;
                if (min === undefined || min === null) continue;
                if (typeof min !== 'number' || !Number.isFinite(min)) {
                    throw new TypeError(
                        `[KnowledgeController] Action "${name}" requirement minValue must be a finite number or `
                        + `absent (got ${typeof min === 'number' ? String(min) : typeof min}).`
                    );
                }
            }
        }
    }

    /**
     * Validates the OPTIONAL capability inputs. Unlike the five core registries,
     * these degrade rather than fail the boot: an absent input leaves the codex
     * without capabilities (and says so once, at boot); a PRESENT one must still
     * be a plain object (a null/array is a corrupted registry, never a "feature
     * off" signal — same rule as the material damage-type registries).
     * @private
     */
    _validateCapabilityInputs() {
        for (const [name, value] of [['actions', this._actions], ['holdingCost', this._holdingCost]]) {
            if (value === undefined) continue;
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new TypeError(`[KnowledgeController] ${name} registry must be a plain object (or absent).`);
            }
        }
        if (this._deriveStats !== undefined && typeof this._deriveStats !== 'function') {
            throw new TypeError('[KnowledgeController] deriveStats must be a function (or absent).');
        }
        if (this._actions === undefined || this._holdingCost === undefined || this._deriveStats === undefined) {
            Logger.warn(
                '[KnowledgeController] capability inputs absent (actions/holdingCost/deriveStats) — '
                + 'item rows will report no enabled actions.'
            );
        }
    }

    /**
     * Requires a plain object: arrays and null are rejected; the `{}`
     * loadJsonSafe fallback is accepted (empty registries degrade gracefully).
     * @param {*} value - The injected registry.
     * @param {string} label - A human-readable name for the error message.
     * @private
     */
    _validatePlainObjectRegistry(value, label) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new TypeError(
                `Knowledge "${label}" registry must be a plain object (arrays and null are rejected); ` +
                'the loadJsonSafe fallback {} is valid and degrades to an empty section.'
            );
        }
    }

    /**
     * Validates the property-to-trait mapping registry: each key must match the
     * flat "Group.stat" pattern; each entry must have AT LEAST ONE of a non-empty
     * `formula` string or a non-empty `sources` object. This "at least one" rule
     * is deliberately lax — identical to MaterialController._validateMappingRegistry()
     * by design (a both-filled entry is legal at boot). The wire exclusivity
     * (exactly one populated side) is enforced LATER, by _buildMappings()
     * normalization (formula wins); this validator stays unchanged.
     * @private
     */
    _validateMappingEntries() {
        for (const [key, entry] of Object.entries(this._mappingBody)) {
            if (!TRAIT_STAT_KEY_PATTERN.test(key)) {
                throw new TypeError(
                    `Mapping key "${key}" does not match the flat Group.stat pattern /^[A-Za-z]+\\.[A-Za-z_]+$/.`
                );
            }
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                throw new TypeError(`Mapping entry for "${key}" must be an object.`);
            }
            const hasFormula = typeof entry.formula === 'string' && entry.formula.length > 0;
            const hasSources = entry.sources && typeof entry.sources === 'object' && !Array.isArray(entry.sources) && Object.keys(entry.sources).length > 0;
            // The recipe→derivation model adds non-property-derived entries:
            // `existence` is a fixed 0-1 store (value) and `mass`/resistances are
            // volume/property-derived (formula). Accept a numeric `value` as a
            // third valid basis so those entries pass without a property source.
            const hasValue = entry.value !== undefined && entry.value !== null;
            if (!hasFormula && !hasSources && !hasValue) {
                throw new TypeError(
                    `Mapping entry for "${key}" must have a non-empty "formula", a non-empty "sources" object, or a numeric "value".`
                );
            }
        }
    }

    /**
     * Validates the materials registry (same rules as
     * MaterialController._validateMaterialsRegistry): every entry has a string
     * `name`, a numeric `density`, and an object `properties`.
     * @private
     */
    _validateMaterialEntries() {
        for (const [id, entry] of Object.entries(this._materials)) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                throw new TypeError(`Material "${id}" must be an object.`);
            }
            if (typeof entry.name !== 'string') {
                throw new TypeError(`Material "${id}" missing required field "name" (string).`);
            }
            if (typeof entry.density !== 'number') {
                throw new TypeError(`Material "${id}" missing required field "density" (number).`);
            }
            if (typeof entry.properties !== 'object' || entry.properties === null || Array.isArray(entry.properties)) {
                throw new TypeError(`Material "${id}" missing required field "properties" (object).`);
            }
            if (entry.visual !== undefined && (typeof entry.visual !== 'object' || entry.visual === null || Array.isArray(entry.visual))) {
                throw new TypeError(`Material "${id}" has a non-object "visual".`);
            }
        }
    }

    /**
     * Validates the recipe registry with the SAME structural rules as
     * CraftingController._validateRecipeDefinitions, including the cross-check
     * that every input/output type exists in the item registry (a broken
     * reference fails boot, never mid-game). Input entries may additionally be
     * the dynamic `chunk_<material>` types (no registry entry by design);
     * output entries must be registry items.
     * @private
     */
    _validateRecipeEntries() {
        for (const [key, recipe] of Object.entries(this._recipes)) {
            if (typeof recipe !== 'object' || recipe === null || Array.isArray(recipe)) {
                throw new TypeError(`Recipe "${key}" must be an object.`);
            }
            if (typeof recipe.id !== 'string' || recipe.id.length === 0) {
                throw new TypeError(`Recipe "${key}" has a missing or empty "id" (string).`);
            }
            if (key !== recipe.id) {
                throw new TypeError(`Recipe key "${key}" does not match its id field "${recipe.id}".`);
            }
            if (typeof recipe.name !== 'string' || recipe.name.length === 0) {
                throw new TypeError(`Recipe "${key}" has a missing or empty "name" (string).`);
            }
            if (recipe.description !== undefined && typeof recipe.description !== 'string') {
                throw new TypeError(`Recipe "${key}" has a non-string "description".`);
            }
            this._validateRecipeItemRefs(recipe, 'inputs');
            this._validateRecipeItemRefs(recipe, 'outputs');
        }
    }

    /**
     * Validates one of a recipe's item lists: must be a non-empty array whose
     * entries are `{ type: string (a known item type — or a dynamic
     * chunk_<material> type for inputs), quantity: integer ≥ 1 }`.
     * @param {Object} recipe - The recipe being validated (for error context).
     * @param {'inputs'|'outputs'} field - Which list to validate.
     * @private
     */
    _validateRecipeItemRefs(recipe, field) {
        const entries = recipe[field];
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new TypeError(`Recipe "${recipe.id}" has a missing or empty "${field}" array.`);
        }
        for (const entry of entries) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                throw new TypeError(`Recipe "${recipe.id}" has a non-object "${field}" entry.`);
            }
            if (typeof entry.type !== 'string' || entry.type.length === 0) {
                throw new TypeError(`Recipe "${recipe.id}" has a "${field}" entry with a missing or non-string "type".`);
            }
            if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
                throw new TypeError(`Recipe "${recipe.id}" has a "${field}" entry with invalid "quantity" ${entry.quantity} (must be an integer ≥ 1).`);
            }
            // Mirrors CraftingController: inputs may reference the dynamic
            // chunk_<material> item types (no registry entry by design);
            // outputs must always be registry items.
            const known = this._items[entry.type]
                || (field === 'inputs' && isChunkItemType(entry.type));
            if (!known) {
                throw new TypeError(`Recipe "${recipe.id}" references unknown item type "${entry.type}" in "${field}".`);
            }
        }
    }

    /**
     * Validates the item registry: a present `volume` must be numeric, and a
     * present `traits` must be a plain object. `description`, `volume`,
     * `externalVolume`, and `materials` are optional (they fall back at
     * assembly time). The required `name` is validated elsewhere at boot by the
     * inventory startup validation, so it is intentionally NOT re-checked here
 * (wiki/subMDs/frontend/knowledge_viewer.md).
     * @private
     */
    _validateItemEntries() {
        for (const [type, entry] of Object.entries(this._items)) {
            if (type.startsWith('_')) continue; // metadata keys (_comment) are not item types
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                throw new TypeError(`Item "${type}" must be an object.`);
            }
            if (entry.volume !== undefined && typeof entry.volume !== 'number') {
                throw new TypeError(`Item "${type}" has a non-numeric "volume".`);
            }
            // The new volume model: a `form` object carrying the volume. The
            // runtime resolves the item volume as form.volume first, then a
            // legacy top-level volume (MaterialController._resolveVolume) —
            // the codex mirrors that rule, so both shapes must be well-formed.
            if (entry.form !== undefined && (typeof entry.form !== 'object' || entry.form === null || Array.isArray(entry.form))) {
                throw new TypeError(`Item "${type}" has a non-object "form".`);
            }
            if (typeof entry.form === 'object' && entry.form !== null && !Array.isArray(entry.form)
                && entry.form.volume !== undefined && typeof entry.form.volume !== 'number') {
                throw new TypeError(`Item "${type}" has a non-numeric "form.volume".`);
            }
            if (entry.externalVolume !== undefined && typeof entry.externalVolume !== 'number') {
                throw new TypeError(`Item "${type}" has a non-numeric "externalVolume".`);
            }
            if (entry.visual !== undefined && (typeof entry.visual !== 'object' || entry.visual === null || Array.isArray(entry.visual))) {
                throw new TypeError(`Item "${type}" has a non-object "visual".`);
            }
            if (entry.wear !== undefined && (typeof entry.wear !== 'object' || entry.wear === null || Array.isArray(entry.wear))) {
                throw new TypeError(`Item "${type}" has a non-object "wear".`);
            }
            if (entry.internalComponents !== undefined) {
                if (!Array.isArray(entry.internalComponents)) {
                    throw new TypeError(`Item "${type}" has a non-array "internalComponents".`);
                }
                for (const ic of entry.internalComponents) {
                    // Either entry form (InternalComponentController): a bare
                    // type string or an object with a string "type".
                    if (typeof ic === 'string') continue;
                    if (typeof ic !== 'object' || ic === null || Array.isArray(ic) || typeof ic.type !== 'string') {
                        throw new TypeError(`Item "${type}" has an "internalComponents" entry that is neither a string nor an object with a string "type".`);
                    }
                }
            }
            if (entry.traits !== undefined && (typeof entry.traits !== 'object' || entry.traits === null || Array.isArray(entry.traits))) {
                throw new TypeError(`Item "${type}" has a non-object "traits".`);
            }
        }
    }

    // =========================================================================
    // ASSEMBLY (computed once at construction; pure function of the registries)
    // =========================================================================

    /**
     * Assembles the full codex payload from the validated registries.
     * Pure and idempotent; the result is cached by the constructor and cloned
     * by getKnowledge().
     * @returns {Object} The assembled codex payload.
     * @private
     */
    _assembleKnowledge() {
        return {
            actions: this._buildActions(),
            traitStats: {
                groups: this._buildGroups(),
                mappings: this._buildMappings(),
                materials: this._buildMaterials(),
                vocabulary: this._buildVocabulary(),
            },
            recipes: this._buildRecipes(),
            items: this._buildItems(),
        };
    }

    /**
     * The "stat" end of the derivation chain: the global trait molds from
     * data/mods/core-traits/traits.json, deep-copied verbatim and preserving the data file's
 * group order (wiki/subMDs/frontend/knowledge_viewer.md).
     * @returns {Object<string, Object<string, number>>}
     * @private
     */
    _buildGroups() {
        // data/mods/core-traits/traits.json may carry a top-level `_comment` metadata key; strip
        // underscore-prefixed keys so the codex groups are clean.
        const groups = {};
        for (const [key, value] of Object.entries(this._traits)) {
            if (key.startsWith('_')) continue;
            groups[key] = structuredClone(value);
        }
        return groups;
    }

    /**
     * The property→stat mapping table as an array of rows, sorted by `statKey`
     * for stable rendering. Each row carries the flat key split into
     * `trait`/`stat` and, per the wire contract, exactly one populated
     * side: a single-filled row passes through unchanged (a formula row has
     * `sources: []`, a source row has `formula: null`); a both-filled row is
     * NORMALIZED at assembly — the formula wins and its `sources` are dropped.
 * `sources` are expanded to a property-sorted array (wiki/subMDs/frontend/knowledge_viewer.md
     * §3.2 MappingRow).
     * @returns {Array<Object>}
     * @private
     */
    _buildMappings() {
        const rows = [];
        for (const [statKey, entry] of Object.entries(this._mappingBody)) {
            const [trait, stat] = statKey.split('.');

            // Normalization enforces the wire contract (exactly one of
            // formula/sources): the formula wins, mirroring the priority
            // MaterialController._deriveTraits() already applies to a
            // densityVolume formula (a formula row never also carries sources).
            const hasFormula = typeof entry.formula === 'string' && entry.formula.length > 0;

            rows.push({
                statKey,
                trait,
                stat,
                formula: hasFormula ? entry.formula : null,
                sources: hasFormula ? [] : this._expandSources(entry.sources),
            });
        }
        return rows.sort((a, b) => compareStrings(a.statKey, b.statKey));
    }

    /**
     * Expands a mapping entry's `sources` object to a property-sorted array of
     * `{ property, weight }`; returns [] when the entry has no valid sources
 * object (a formula-based row, or a malformed/missing one) (wiki/subMDs/frontend/knowledge_viewer.md MappingRow).
     * @param {*} sources - The entry's raw `sources` value.
     * @returns {Array<{property: string, weight: number}>}
     * @private
     */
    _expandSources(sources) {
        if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
            return [];
        }
        return Object.entries(sources)
            .map(([property, weight]) => ({ property, weight }))
            .sort((a, b) => compareStrings(a.property, b.property));
    }

    /**
     * The "material property" end of the chain: per-material property values as
     * a sorted array, so a reader can trace property value → mapping → stat.
 * `properties` is deep-copied verbatim (wiki/subMDs/frontend/knowledge_viewer.md
     * MaterialRow).
     * @returns {Array<Object>}
     * @private
     */
    _buildMaterials() {
        const rows = [];
        for (const [type, entry] of Object.entries(this._materials)) {
            rows.push({
                type,
                name: entry.name,
                density: entry.density,
                properties: structuredClone(entry.properties),
                // The renderer's look block (MaterialRow.visual): deep-copied
                // verbatim, null when the material declares none.
                visual: entry.visual !== undefined ? structuredClone(entry.visual) : null,
            });
        }
        return rows.sort((a, b) => compareStrings(a.type, b.type));
    }

    /**
     * The cross-layer pinned vocabulary, sourced from the shared module (NOT a
     * data file) — the one place both layers' names meet. The existence store is
     * a single 0–1 matter ratio: goneAt/usableMin are both 0 (there is no
     * "broken-but-usable" gap, unlike the old two-boundary existence model).
 * (wiki/subMDs/frontend/knowledge_viewer.md Vocabulary).
     * @returns {{traitGroups: string[], stats: string[], existence: {goneAt: number, usableMin: number}}}
     * @private
     */
    _buildVocabulary() {
        return {
            traitGroups: Object.values(TRAIT_GROUPS),
            stats: Object.values(STAT_NAMES),
            existence: {
                goneAt: EXISTENCE_GONE_AT,
                usableMin: EXISTENCE_USABLE_MIN,
            },
        };
    }

    /**
     * Every recipe as a row, sorted by `id`, with input/output display names
     * resolved against the item registry (the server resolves names; the client
 * never re-resolves them) (wiki/subMDs/frontend/knowledge_viewer.md).
     * @returns {Array<Object>}
     * @private
     */
    _buildRecipes() {
        const rows = [];
        for (const [_key, recipe] of Object.entries(this._recipes)) {
            rows.push({
                id: recipe.id,
                name: recipe.name,
                description: recipe.description ?? null,
                inputs: this._resolveItemRefs(recipe.inputs),
                outputs: this._resolveItemRefs(recipe.outputs),
            });
        }
        return rows.sort((a, b) => compareStrings(a.id, b.id));
    }

    /**
     * Maps a recipe's item list (order preserved as in the data file) to
     * `{ type, quantity, name }` rows, resolving each `name` against the item
     * registry. The defensive fallback for an unresolvable type is the raw
 * `type` string — never a raw ID-shaped label (wiki/subMDs/frontend/knowledge_viewer.md
     * RecipeItemRef).
     * @param {Array<Object>|undefined} entries - The recipe's input or output list.
     * @returns {Array<{type: string, quantity: number, name: string}>}
     * @private
     */
    _resolveItemRefs(entries) {
        if (!Array.isArray(entries)) {
            return [];
        }
        return entries.map((entry) => {
            const def = this._items[entry.type];
            const name = def && typeof def.name === 'string' ? def.name : entry.type;
            return {
                type: entry.type,
                quantity: entry.quantity,
                name,
            };
        });
    }

    /**
     * Every action as a row, sorted by name: its description, its requirement
     * gate (the stat checks the engine applies — the ONLY gate an action has, see
     * the module header on capabilities), a `summary` saying what the action does
     * (`describeAction`: targeting, narration, one sentence per consequence and
     * per failure consequence), and the full raw definition so the viewer still
     * lists every field — `groupPick` and anything a future mod adds included —
     * with no viewer change (same rule as the item rows).
     * @returns {Array<{name: string, description: string|null, requirements: Array<Object>, definition: Object}>}
     * @private
     */
    _buildActions() {
        const rows = [];
        for (const [name, entry] of Object.entries(this._actions ?? {})) {
            if (name.startsWith('_')) continue; // metadata keys (_comment)
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            rows.push({
                name,
                description: typeof entry.description === 'string' && entry.description.length > 0
                    ? entry.description
                    : null,
                requirements: this._buildActionRequirements(entry.requirements),
                // What the action DOES, read from its own fields by the single
                // interpreter (src/controllers/knowledge/actionSemantics.js): the
                // targeting line, the narration wording, and one sentence per
                // consequence with the party it lands on.
                summary: describeAction(entry),
                definition: structuredClone(entry),
            });
        }
        return rows.sort((a, b) => compareStrings(a.name, b.name));
    }

    /**
     * Normalizes one action's requirement gate to `{ trait, stat, minValue }`
     * rows, null per missing field (the codex's nullability convention). A lone
     * requirement object reads as a one-row list — the shape the engine's own
     * requirement check also accepts — and an absent gate yields [] (a universal
     * action, which any component that exists can perform).
     * @param {Array<Object>|Object|undefined} requirements - The action's gate.
     * @returns {Array<{trait: string|null, stat: string|null, minValue: number|null}>}
     * @private
     */
    _buildActionRequirements(requirements) {
        if (requirements === undefined || requirements === null) return [];
        const list = Array.isArray(requirements)
            ? requirements
            : (typeof requirements === 'object' ? [requirements] : []);
        const rows = [];
        for (const req of list) {
            if (!req || typeof req !== 'object' || Array.isArray(req)) continue;
            rows.push({
                trait: typeof req.trait === 'string' ? req.trait : null,
                stat: typeof req.stat === 'string' ? req.stat : null,
                minValue: typeof req.minValue === 'number' ? req.minValue : null,
            });
        }
        return rows;
    }

    /**
     * Every item type as a row, sorted by `type`, with null/fallback
 * normalization per wiki/subMDs/frontend/knowledge_viewer.md: missing `description` →
     * null, missing `volume` → DEFAULT_ITEM_VOLUME (0), missing `externalVolume`
     * → null, missing `materials` → null (with `role` → null when the entry
     * omits it), and `traits` → a deep copy ({ } when missing — the
     * declared/blueprint-override layer, not merged runtime values).
     * @returns {Array<Object>}
     * @private
     */
    _buildItems() {
        const rows = [];
        for (const [type, entry] of Object.entries(this._items)) {
            if (type.startsWith('_')) continue; // skip metadata keys (_comment)
            // The runtime's volume rule (MaterialController._resolveVolume):
            // form.volume first (new model), then a legacy top-level volume,
            // then the DEFAULT_ITEM_VOLUME fallback. The codex shows what the
            // runtime computes — and the same number is the generic container
            // capacity reported in `capabilities`.
            const volume = (typeof entry.form === 'object' && entry.form !== null && !Array.isArray(entry.form) && typeof entry.form.volume === 'number')
                ? entry.form.volume
                : (typeof entry.volume === 'number' ? entry.volume : DEFAULT_ITEM_VOLUME);
            rows.push({
                type,
                name: entry.name,
                description: entry.description ?? null,
                volume,
                externalVolume: this._declaredExternalVolume(entry),
                materials: this._buildItemMaterials(entry.materials),
                traits: structuredClone(entry.traits ?? {}),
                // What the item can do, computed from the registries (never read
                // from the item file — see the module header DECISION note).
                capabilities: this._buildItemCapabilities(type, entry, volume),
                // The full raw definition (deep copy): the viewer lists every
                // field of the item, so a field a future mod adds to the data
                // file appears without any viewer change.
                definition: structuredClone(entry),
            });
        }
        return rows.sort((a, b) => compareStrings(a.type, b.type));
    }

    /**
     * The host footprint a recipe DECLARES, or null when it declares none.
     * `form.externalVolume` first (the recipe→derivation location), then the
     * legacy top-level key — the same read order as the engine's own resolver
     * (`definitionVolume.getDefinitionFootprint`). Reading only the top-level key
     * reported `null` for the T1, whose footprint lives under `form`, while the
     * runtime computes 1.
     * @param {Object} entry - The raw item definition.
     * @returns {number|null}
     * @private
     */
    _declaredExternalVolume(entry) {
        const fromForm = (entry.form && typeof entry.form === 'object' && !Array.isArray(entry.form))
            ? entry.form.externalVolume
            : undefined;
        const declared = fromForm ?? (typeof entry.externalVolume === 'number' ? entry.externalVolume : undefined);
        return typeof declared === 'number' ? declared : null;
    }

    /**
     * One item's capabilities, derived from the registries at assembly time:
     *   - `equipable`: membership of the holdingCost model's `equipableItems`,
     *     the only per-item equip data the world declares; an item can only ever
     *     satisfy an action requirement while equipped, so a non-equipable item
     *     enables nothing;
     *   - `capacity` / `footprint`: storing is NOT a special power — any item is a
     *     valid container up to its own volume (`InventoryManager.addItemToContainer`),
     *     so capacity is the resolved volume and footprint what it occupies on its
     *     host; capacity > footprint is what makes a T1 hold 10 while taking 1;
     *   - `baseStats`: the stats the recipe carries before any instance exists
     *     (explicit traits, else matter derivation) — the same values equipping
     *     seeds (BUG-134), and the evidence for the action rows;
     *   - `actions`: every action whose stat requirements those stats satisfy.
     * @param {string} itemType - The item type key.
     * @param {Object} entry - The raw item definition.
     * @param {number} volume - The item's resolved volume (the row's `volume`).
     * @returns {{equipable: boolean, capacity: number, footprint: number,
     *   baseStats: Object, actions: Array<{name: string, description: string|null}>}}
     * @private
     */
    _buildItemCapabilities(itemType, entry, volume) {
        const equipable = Array.isArray(this._holdingCost?.equipableItems)
            && this._holdingCost.equipableItems.includes(itemType);
        const baseStats = resolveRecipeBaseStats(entry, { deriveStats: this._deriveStats });
        return {
            equipable,
            capacity: volume,
            footprint: getDefinitionFootprint(entry),
            baseStats,
            actions: equipable ? this._matchEnabledActions(baseStats) : [],
        };
    }

    /**
     * The actions whose requirements an item's base stats satisfy — the same
     * ALL-present-and-met gate the capability scan applies
     * (`_checkRequirementsForHostComponent`: a missing stat fails). An action
     * that declares no requirements is UNIVERSAL (any equipped item carries it),
     * so it matches too.
     * @param {Object} baseStats - Stats keyed by trait.
     * @returns {Array<{name: string, description: string|null}>} Sorted by name.
     * @private
     */
    _matchEnabledActions(baseStats) {
        const rows = [];
        for (const [name, def] of Object.entries(this._actions ?? {})) {
            if (name.startsWith('_')) continue; // metadata keys (_comment)
            if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
            if (!this._requirementsSatisfied(def.requirements, baseStats)) continue;
            rows.push({
                name,
                description: typeof def.description === 'string' ? def.description : null,
            });
        }
        return rows.sort((a, b) => compareStrings(a.name, b.name));
    }

    /**
     * True when `baseStats` meets every requirement of one action. A requirement
     * with no `minValue` asks only that the stat be present (no bound).
     * @param {Array<Object>|Object|undefined} requirements - The action's
     *   `requirements` (absent or empty = universal).
     * @param {Object} baseStats - Stats keyed by trait.
     * @returns {boolean}
     * @private
     */
    _requirementsSatisfied(requirements, baseStats) {
        if (requirements === undefined || requirements === null) return true;
        const list = Array.isArray(requirements)
            ? requirements
            : (typeof requirements === 'object' ? [requirements] : []);
        return list.every((req) => {
            if (!req || typeof req !== 'object' || typeof req.stat !== 'string') return false;
            const value = baseStats[req.trait]?.[req.stat];
            if (typeof value !== 'number') return false;
            // Mirrors the engine's offer gate
            // (`src/controllers/capabilities/componentCapabilityController.js`,
            // `_checkRequirementsForHostComponent`): the stat must be PRESENT, and a
            // gate with no `minValue` bounds nothing (`value < undefined` is false
            // there). Reading an absent bound as 0 would hide from the reader an
            // action the world still offers - they part company on a negative stat.
            return typeof req.minValue === 'number' ? value >= req.minValue : true;
        });
    }

    /**
     * Normalizes an item's composition list to `{ material, fraction, role }`
     * rows with `role` → null when the entry omits it; returns null when the
 * item has no composition (no derived layer) (wiki/subMDs/frontend/knowledge_viewer.md).
     * @param {Array<Object>|undefined} materials - The item's material composition.
     * @returns {Array<{material: string, fraction: number, role: string|null}>|null}
     * @private
     */
    _buildItemMaterials(materials) {
        if (!Array.isArray(materials)) {
            return null;
        }
        return materials.map((m) => ({
            material: m.material,
            fraction: m.fraction,
            role: m.role ?? null,
        }));
    }
}

export default KnowledgeController;

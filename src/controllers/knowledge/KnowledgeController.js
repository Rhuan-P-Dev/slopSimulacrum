/**
 * KnowledgeController — state controller owning the read-only "Knowledge"
 * codex payload (knowledge_viewer_spec.md §4.2).
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
 * its fields. The result is a pure function of the data files: the viewer
 * deliberately does NOT compute blended/per-instance stats (that is the
 * runtime, instance-scoped job of MaterialController.derive / the trait merge,
 * knowledge_viewer_spec.md §1 scope decision).
 *
 * Deliberately has NO `getAll()`: the static codex must stay out of the
 * world-state broadcast aggregation (same exclusion rule as CraftingController
 * and RoomChatController — shipping a codex in every full-state update would
 * bloat all clients for zero benefit).
 *
 * @module KnowledgeController
 */

import Logger from '../../utils/Logger.js';
import { DEFAULT_ITEM_VOLUME } from '../../../shared/Defaults.js';
import {
    TRAIT_GROUPS,
    STAT_NAMES,
    EXISTENCE_GONE_AT,
    EXISTENCE_USABLE_MIN,
    TRAIT_STAT_KEY_PATTERN,
} from '../../../shared/StatVocabulary.js';

// The flat "Group.stat" mapping-key pattern is the shared constant
// TRAIT_STAT_KEY_PATTERN, imported from shared/StatVocabulary.js (spec §2, risk
// R3). MaterialController._validateMappingRegistry() imports the very same
// constant, so the two boot validators can never disagree on key form.

/**
 * The total empty-shape knowledge payload (spec §3.5 invariant 1 / §4.3):
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
    };
}

/**
 * Locale-independent, deterministic string comparator (code-unit order) so the
 * wire contract is independent of the runtime locale — sorting happens on the
 * server, not the client (knowledge_viewer_spec.md §3.2 "Ordering").
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
     * @param {Object} deps.traits - Raw data from data/traits.json
     *   ({ group: { stat: number } } — the global trait molds).
     * @param {Object} deps.materials - Raw data from data/materials.json
     *   ({ id: { name, density, properties } }).
     * @param {Object} deps.propertyTraitMapping - Raw data from
     *   data/propertyTraitMapping.json (flat "Group.stat" keys; each entry has
     *   either `formula` or `sources`).
     * @param {Object} deps.recipes - Raw data from data/crafting.json (keyed by
     *   recipe id).
     * @param {Object} deps.items - Raw data from data/inventoryItems.json
     *   (keyed by item type) — also the cross-validation source for every
     *   recipe input/output type (fail-fast at boot, never mid-game).
     */
    constructor({ traits, materials, propertyTraitMapping, recipes, items }) {
        this._traits = traits;
        this._materials = materials;
        // Keep the raw value so the plain-object validator below can reject
        // null/array (fail-fast §6); a valid object — including the {} loadJsonSafe
        // fallback and the recipe-model wrapper — passes through.
        this._propertyTraitMapping = propertyTraitMapping;
        // The mapping registry is the recipe-model wrapper { derivedStats, flagThresholds }
        // (data/propertyTraitMapping.json). Normalize it to the flat "Group.stat" body
        // that the validators and the mapping rows operate on; a legacy flat map
        // (no derivedStats) passes through unchanged. Null-safe so a rejected
        // (null/array) registry is validated before it can be dereferenced.
        const _rawMapping = this._propertyTraitMapping;
        this._mappingBody = (_rawMapping && _rawMapping.derivedStats && typeof _rawMapping.derivedStats === 'object' && !Array.isArray(_rawMapping.derivedStats))
            ? _rawMapping.derivedStats
            : (_rawMapping || {});
        this._recipes = recipes;
        this._items = items;

        // Fail-fast at boot (project rule §6): validate before the payload is
        // assembled so a corrupted registry can never enter the internal state.
        this._validateKnowledgeRegistries();

        // Assemble once and cache: assembly is pure and idempotent, so the
        // getter stays O(clone) on a hot path, never O(re-assembly)
        // (knowledge_viewer_spec.md §4.2).
        this._assembled = this._assembleKnowledge();

        Logger.info(
            `[KnowledgeController] initialized with ${Object.keys(this._traits).length} groups, ` +
            `${Object.keys(this._propertyTraitMapping).length} mappings, ` +
            `${Object.keys(this._materials).length} materials, ` +
            `${Object.keys(this._recipes).length} recipes, ` +
            `${Object.keys(this._items).length} items`
        );
    }

    /**
     * Returns the full knowledge codex payload of knowledge_viewer_spec.md §3:
     * `{ traitStats: { groups, mappings, materials, vocabulary }, recipes, items }`.
     *
     * A FRESH DEEP COPY is returned on every call (defensive-copy rule): callers
     * (the route, the client) can never mutate controller state through it.
     * The getter only clones the cached assembly — it never re-assembles.
     *
     * @returns {{
     *   traitStats: {
     *     groups: Object<string, Object<string, number>>,
     *     mappings: Array<{statKey: string, trait: string, stat: string, formula: string|null, sources: Array<{property: string, weight: number}>}>,
     *     materials: Array<{type: string, name: string, density: number, properties: Object<string, number>}>,
     *     vocabulary: {traitGroups: string[], stats: string[], existence: {goneAt: number, usableMin: number}}
     *   },
     *   recipes: Array<{id: string, name: string, description: string|null, inputs: Array<{type: string, quantity: number, name: string}>, outputs: Array<{type: string, quantity: number, name: string}>}>,
     *   items: Array<{type: string, name: string, description: string|null, volume: number, externalVolume: number|null, materials: Array<{material: string, fraction: number, role: string|null}>|null, traits: Object<string, Object<string, number>>}>
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
     * by design (a both-filled entry is legal at boot). The §3.2 wire exclusivity
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
        }
    }

    /**
     * Validates the recipe registry with the SAME structural rules as
     * CraftingController._validateRecipeDefinitions, including the cross-check
     * that every input/output type exists in the item registry (a broken
     * reference fails boot, never mid-game).
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
     * entries are `{ type: string (a known item type), quantity: integer ≥ 1 }`.
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
            if (!this._items[entry.type]) {
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
     * (knowledge_viewer_spec.md §4.2 / §3.4).
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
            if (entry.traits !== undefined && (typeof entry.traits !== 'object' || entry.traits === null || Array.isArray(entry.traits))) {
                throw new TypeError(`Item "${type}" has a non-object "traits".`);
            }
        }
    }

    // =========================================================================
    // ASSEMBLY (computed once at construction; pure function of the registries)
    // =========================================================================

    /**
     * Assembles the full codex payload (§3) from the validated registries.
     * Pure and idempotent; the result is cached by the constructor and cloned
     * by getKnowledge().
     * @returns {Object} The assembled codex payload.
     * @private
     */
    _assembleKnowledge() {
        return {
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
     * data/traits.json, deep-copied verbatim and preserving the data file's
     * group order (knowledge_viewer_spec.md §3.2).
     * @returns {Object<string, Object<string, number>>}
     * @private
     */
    _buildGroups() {
        // data/traits.json may carry a top-level `_comment` metadata key; strip
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
     * `trait`/`stat` and, per the §3.2 wire contract, exactly one populated
     * side: a single-filled row passes through unchanged (a formula row has
     * `sources: []`, a source row has `formula: null`); a both-filled row is
     * NORMALIZED at assembly — the formula wins and its `sources` are dropped.
     * `sources` are expanded to a property-sorted array (knowledge_viewer_spec.md
     * §3.2 MappingRow).
     * @returns {Array<Object>}
     * @private
     */
    _buildMappings() {
        const rows = [];
        for (const [statKey, entry] of Object.entries(this._mappingBody)) {
            const [trait, stat] = statKey.split('.');

            // Normalization enforces the §3.2 wire contract (exactly one of
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
     * object (a formula-based row, or a malformed/missing one) (knowledge_viewer_spec.md §3.2 MappingRow).
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
     * `properties` is deep-copied verbatim (knowledge_viewer_spec.md §3.2
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
            });
        }
        return rows.sort((a, b) => compareStrings(a.type, b.type));
    }

    /**
     * The cross-layer pinned vocabulary, sourced from the shared module (NOT a
     * data file) — the one place both layers' names meet. The existence store is
     * a single 0–1 matter ratio: goneAt/usableMin are both 0 (there is no
     * "broken-but-usable" gap, unlike the old two-boundary existence model).
     * (knowledge_viewer_spec.md §3.2 Vocabulary).
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
     * never re-resolves them) (knowledge_viewer_spec.md §3.3).
     * @returns {Array<Object>}
     * @private
     */
    _buildRecipes() {
        const rows = [];
        for (const [key, recipe] of Object.entries(this._recipes)) {
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
     * `type` string — never a raw ID-shaped label (knowledge_viewer_spec.md §3.3
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
     * Every item type as a row, sorted by `type`, with null/fallback
     * normalization per knowledge_viewer_spec.md §3.4: missing `description` →
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
            rows.push({
                type,
                name: entry.name,
                description: entry.description ?? null,
                volume: typeof entry.volume === 'number' ? entry.volume : DEFAULT_ITEM_VOLUME,
                externalVolume: typeof entry.externalVolume === 'number' ? entry.externalVolume : null,
                materials: this._buildItemMaterials(entry.materials),
                traits: structuredClone(entry.traits ?? {}),
            });
        }
        return rows.sort((a, b) => compareStrings(a.type, b.type));
    }

    /**
     * Normalizes an item's composition list to `{ material, fraction, role }`
     * rows with `role` → null when the entry omits it; returns null when the
     * item has no composition (no derived layer) (knowledge_viewer_spec.md §3.4).
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

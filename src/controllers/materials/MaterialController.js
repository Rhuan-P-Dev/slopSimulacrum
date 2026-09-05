/**
 * MaterialController computes derived trait stats from material compositions.
 *
 * It implements a three-step pipeline:
 *   1. Validate the composition (fractions sum ≤ 1, known material IDs).
 *   2. Blend physical properties across materials by fraction.
 *   3. Derive trait stats via the property-to-trait mapping table.
 *
 * The derived stats are returned as a trait-shaped object that can be merged
 * directly into the existing merge pipeline (TraitsController.mergeTraits).
 */

import Logger from '../../utils/Logger.js';
import { TRAIT_STAT_KEY_PATTERN, DAMAGE_CHANNELS } from '../../../shared/StatVocabulary.js';

const FRACTION_SUM_TOLERANCE = 1e-9;
const STAT_PRECISION = 100;

/**
 * Tolerance when checking that a material's damage-type percentages sum to 100.
 * The distribution is a percentage (not a fraction); a designer may write values
 * that round to, but do not exactly equal, 100 (e.g. 33.3+33.3+33.4). Anything
 * within this band is treated as 100 and stored as-is; a larger deviation is a
 * TUNING DRIFT (not malformation) and is proportionally rescaled to 100 with a
 * Logger.warn (spec D9 — the file stays loadable and the feature stays on).
 * @type {number}
 */
const DAMAGE_TYPE_SUM_TOLERANCE = 0.01;

/**
 * Validates and blends material properties for a single blueprint.
 * @param {Object} materialsRegistry - Material definitions from data/materials.json.
 * @param {Object} mappingRegistry - Property-to-trait mapping from data/propertyTraitMapping.json.
 * @param {Object} [damageTypesRegistry] - Per-material damage-type distributions from
 *   data/materialDamageTypes.json (feature 1). Optional and defaulted to `{}` so that
 *   hand-built controllers (and the "feature off" case — absent/empty file) never
 *   change existing behavior; the constructor validates it and toggles the
 *   damage-type split on/off accordingly.
 */
class MaterialController {
    constructor(materialsRegistry, mappingRegistry, damageTypesRegistry = {}, dropRatesRegistry = {}) {
        this.materialsRegistry = this._validateMaterialsRegistry(materialsRegistry || {});
        // Feature 1 (per-material damage types): validate the injected registry.
        // Must run AFTER the materials registry is validated, because the validator
        // cross-checks every damage-file material key against this.materialsRegistry.
        // It returns the (possibly normalized) registry and sets _damageTypesEnabled.
        this.damageTypesRegistry = this._validateMaterialDamageTypes(damageTypesRegistry);
        // Feature 2 (material chunk drop on punch): validate the injected drop-rates
        // registry (data/materialDropRates.json). Must ALSO run after the materials
        // registry is validated, because the validator cross-checks each drop-file
        // material key against this.materialsRegistry. Returns the normalized registry
        // and sets _dropRatesEnabled (feature off → no drops, graceful degradation).
        this.dropRatesRegistry = this._validateMaterialDropRates(dropRatesRegistry);
        // The mapping registry is the recipe-model wrapper { derivedStats, flagThresholds }
        // (data/propertyTraitMapping.json). For backward compatibility a legacy flat
        // { "Trait.stat": mapping } map is also accepted (treated as the derivedStats body).
        const raw = mappingRegistry || {};
        this.flagThresholds = (raw.flagThresholds && typeof raw.flagThresholds === 'object' && !Array.isArray(raw.flagThresholds))
            ? raw.flagThresholds
            : {};
        this.mappingRegistry = (raw.derivedStats && typeof raw.derivedStats === 'object' && !Array.isArray(raw.derivedStats))
            ? raw.derivedStats
            : raw;
        this.mappingRegistry = this._validateMappingRegistry(this.mappingRegistry);
        const dropMatCount = Object.keys(this.dropRatesRegistry?.materials || {}).length;
        Logger.info(`[MaterialController] initialized with ${Object.keys(this.materialsRegistry).length} materials, ${Object.keys(this.mappingRegistry).length} mappings, ${Object.keys(this.flagThresholds).length} flag thresholds, damage-types ${this._damageTypesEnabled ? `ON (${Object.keys(this.damageTypesRegistry).length} materials)` : 'off (no split)'}, drop-rates ${this._dropRatesEnabled ? `ON (${dropMatCount} materials, minChunkVolume ${this.dropRatesRegistry?.minChunkVolume ?? 0})` : 'off (no drops)'}`);
    }

    /**
     * Validates the materials registry: must be a plain object where every entry
     * has `name` (string), `density` (number), and `properties` (object).
     * @param {Object} registry
     * @returns {Object}
     * @private
     */
    _validateMaterialsRegistry(registry) {
        if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
            throw new TypeError('Materials registry must be a plain object.');
        }
        for (const [id, entry] of Object.entries(registry)) {
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
        return registry;
    }

    /**
     * Validates the per-material damage-types registry (feature 1, spec D9).
     *
     * Three distinct outcomes, mirroring the spec's failure-mode table:
     *   - Absent / null / empty object → the feature is intentionally OFF. This is
     *     NOT an error: deleting the balance file must never crash the world. The
     *     registry is stored as {} and _damageTypesEnabled is false, so readers
     *     return "no split" and combat exactly reproduces the pre-feature
     *     single-declared-channel behavior. A single Logger.warn is emitted at boot.
     *   - Present but the wrong type (array / string / number / boolean) → a
     *     TypeError (structural malformation → boot failure).
     *   - Present and a non-empty object → validated: every material key must exist
     *     in the materials registry (cross-validation, D2), each value must be an
     *     object of channel → number, each channel must be a known DAMAGE_CHANNELS
     *     entry, and each percentage must be a finite number ≥ 0. If a material's
     *     percentages don't sum to 100 (beyond tolerance) they are proportionally
     *     rescaled to 100 with a Logger.warn (tuning drift, D9 — feature stays on).
     *
     * @param {Object|null} registry - Raw registry from data/materialDamageTypes.json.
     * @returns {Object} The normalized registry ({} when the feature is off).
     * @private
     */
    _validateMaterialDamageTypes(registry) {
        // Absent / null → feature OFF (graceful degradation, spec D9). The loader's
        // {} fallback (missing/unreadable file) and an explicitly-null file land here;
        // neither is a malformation.
        if (registry === null || registry === undefined) {
            this._damageTypesEnabled = false;
            Logger.warn('[MaterialController] materialDamageTypes registry is absent — per-material damage split disabled (declared channel keeps 100%).');
            return {};
        }
        if (typeof registry !== 'object' || Array.isArray(registry)) {
            // A present-but-wrong-type file is structurally malformed → boot failure.
            throw new TypeError('Material damage-types registry must be a plain object.');
        }
        if (Object.keys(registry).length === 0) {
            // Explicitly-empty file → feature OFF (same safe behavior as absent).
            this._damageTypesEnabled = false;
            Logger.warn('[MaterialController] materialDamageTypes registry is empty — per-material damage split disabled (declared channel keeps 100%).');
            return {};
        }

        const valid = {};
        const knownChannels = new Set(Object.values(DAMAGE_CHANNELS));
        for (const [material, channels] of Object.entries(registry)) {
            // Skip comment / metadata keys (JSON has no native comments; a "_"-prefixed
            // key is a human note, not a material — e.g. the file's _comment header).
            if (material.startsWith('_')) continue;
            // Cross-validation (D2): every damage-file material must be a known material.
            if (!this.materialsRegistry[material]) {
                throw new TypeError(`Material damage-types: unknown material "${material}" (not in data/materials.json).`);
            }
            if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
                throw new TypeError(`Material damage-types: entry for "${material}" must be an object of channel → percentage.`);
            }
            if (Object.keys(channels).length === 0) {
                throw new TypeError(`Material damage-types: entry for "${material}" must declare at least one channel.`);
            }
            const normalized = {};
            let sum = 0;
            for (const [channel, pct] of Object.entries(channels)) {
                if (!knownChannels.has(channel)) {
                    throw new TypeError(`Material damage-types: channel "${channel}" for material "${material}" is not a known damage channel (${[...knownChannels].join(', ')}).`);
                }
                if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) {
                    throw new TypeError(`Material damage-types: percentage for channel "${channel}" of material "${material}" must be a finite number ≥ 0.`);
                }
                normalized[channel] = pct;
                sum += pct;
            }
            // Normalization (tuning drift, D9): rescale to 100 only when off beyond
            // tolerance; otherwise store as-is (avoids needless float churn).
            if (Math.abs(sum - 100) > DAMAGE_TYPE_SUM_TOLERANCE) {
                Logger.warn(`[MaterialController] Material damage-types: percentages for "${material}" sum to ${Math.round(sum * STAT_PRECISION) / STAT_PRECISION}, not 100 — proportionally rescaled to 100.`);
                for (const channel of Object.keys(normalized)) {
                    normalized[channel] = normalized[channel] / sum * 100;
                }
            }
            valid[material] = normalized;
        }
        this._damageTypesEnabled = true;
        return valid;
    }

    /**
     * Whether the per-material damage-type split feature is active — i.e. the
     * data/materialDamageTypes.json registry loaded and validated to a non-empty
     * split. Mirrors the drop-rates feature flag (_dropRatesEnabled); both are set
     * during construction. Exposed as a public predicate so callers and tests can
     * query the feature state without reaching into the private flag.
     *
     * @returns {boolean} true when the split is on; false when off (feature off →
     *   the declared channel keeps 100%, exactly the pre-feature behavior).
     */
    isDamageTypesEnabled() {
        return this._damageTypesEnabled;
    }

    /**
     * Returns the damage-type distribution for a single material (feature 1).
     *
     * @param {string} materialName - A material ID (e.g. 'iron', 'wood').
     * @returns {Object<string, number>|null} A DEFENSIVE DEEP COPY of the
     *   channel → percentage map (summing to 100), or null when the damage-type
     *   split is disabled (file absent/empty) or the material has no entry.
     *   Callers treat null as "no split" → the declared channel keeps 100%.
     */
    getDamageTypeSplit(materialName) {
        if (!this._damageTypesEnabled) return null;
        const entry = this.damageTypesRegistry[materialName];
        return entry ? structuredClone(entry) : null;
    }

    /**
     * Computes the fraction-weighted damage-type distribution for a material
     * composition (feature 1). This is pure material-data math and therefore lives
     * in this controller — the damage handler keeps the damage mechanics (slice →
     * resistance → loss).
     *
     * The blend is the fraction-weighted sum of each material's split — the same
     * weighting rule `_blendProperties` uses to derive stats. Unknown materials
     * contribute 100% of the fallback channel, so a composition whose materials are
     * all absent from the damage file yields exactly the fallback (declared) channel
     * at 100% — i.e. no effective change from pre-feature behavior (spec D9).
     *
     * @param {Array<{material: string, fraction: number}>} materials - A composition
     *   (e.g. from componentController.getComponentMaterialsByType()).
     * @param {string} fallbackChannel - Channel assigned to unknown materials and to
     *   the degenerate case; usually the consequence's declared channel. Must be a
     *   known DAMAGE_CHANNELS entry.
     * @returns {Object<string, number>|null} A fresh channel → percentage map (a
     *   distribution summing to 100), or null when the split is disabled or the
     *   composition is empty. Callers treat null as "no split".
     */
    getBlendedDamageTypeSplit(materials, fallbackChannel) {
        if (!this._damageTypesEnabled) return null;
        if (!Array.isArray(materials) || materials.length === 0) return null;
        if (typeof fallbackChannel !== 'string' || !Object.values(DAMAGE_CHANNELS).includes(fallbackChannel)) {
            throw new TypeError(`getBlendedDamageTypeSplit: fallbackChannel "${fallbackChannel}" is not a known damage channel.`);
        }

        const split = {};
        let totalFraction = 0;
        for (const entry of materials) {
            if (!entry || typeof entry !== 'object') continue;
            if (typeof entry.fraction !== 'number' || entry.fraction <= 0) continue;
            // Unknown material → 100% of the fallback channel (the safe direction).
            const perMaterial = this.damageTypesRegistry[entry.material] || { [fallbackChannel]: 100 };
            for (const [channel, pct] of Object.entries(perMaterial)) {
                split[channel] = (split[channel] || 0) + entry.fraction * pct;
            }
            totalFraction += entry.fraction;
        }
        if (totalFraction === 0) return null;
        // Normalize by total weight so the result is a full distribution (sums to
        // 100). A no-op for valid compositions (fractions sum to 1); guards against
        // partially-filled compositions drifting the allocation below 100.
        for (const channel of Object.keys(split)) {
            split[channel] = split[channel] / totalFraction;
        }
        return split;
    }

    /**
     * Validates the material drop-rates registry (feature 2, spec D1/D9).
     *
     * Multi-section shape (data/materialDropRates.json, same precedent as
     * data/holdingCost.json): an optional global scalar `minChunkVolume` plus a
     * `materials` section mapping material name → { dropRate, chunkFraction }.
     *
     * Three distinct outcomes (spec D9), mirroring _validateMaterialDamageTypes:
     *   - Absent / null / empty object → feature OFF (no drops). Not an error:
     *     deleting the balance file must never crash the world. Stored as {} with
     *     _dropRatesEnabled false and a single Logger.warn at boot.
     *   - Present but the wrong container type (array / string / number / boolean)
     *     → a TypeError (structural malformation → boot failure).
     *   - Present and a non-empty object → validated: `minChunkVolume` (when present)
     *     must be a finite number > 0; the `materials` section (when present) must be a
     *     plain object whose keys are known materials (cross-validation against
     *     this.materialsRegistry) and whose entries carry dropRate and chunkFraction,
     *     each a finite number in [0, 1].
     *
     * A missing `minChunkVolume` is stored as 0 (the floor becomes a no-op); a missing
     * `materials` section yields an empty materials map (no material ever drops).
     *
     * @param {Object|null} registry - Raw registry from data/materialDropRates.json.
     * @returns {Object} { minChunkVolume: number, materials: Object<string, {dropRate:number, chunkFraction:number}> }.
     *   An empty object when the feature is off.
     * @private
     */
    _validateMaterialDropRates(registry) {
        if (registry === null || registry === undefined) {
            this._dropRatesEnabled = false;
            Logger.warn('[MaterialController] materialDropRates registry is absent — material chunk drop disabled.');
            return {};
        }
        if (typeof registry !== 'object' || Array.isArray(registry)) {
            throw new TypeError('Material drop-rates registry must be a plain object.');
        }
        if (Object.keys(registry).length === 0) {
            this._dropRatesEnabled = false;
            Logger.warn('[MaterialController] materialDropRates registry is empty — material chunk drop disabled.');
            return {};
        }

        // Global scalar floor. Optional (0 = no-op floor); when present it must be > 0.
        let minChunkVolume = 0;
        if (registry.minChunkVolume !== undefined) {
            if (typeof registry.minChunkVolume !== 'number' || !Number.isFinite(registry.minChunkVolume) || registry.minChunkVolume <= 0) {
                throw new TypeError('Material drop-rates: "minChunkVolume" must be a finite number > 0.');
            }
            minChunkVolume = registry.minChunkVolume;
        }

        const rawMaterials = registry.materials;
        const materials = {};
        if (rawMaterials !== undefined) {
            if (typeof rawMaterials !== 'object' || rawMaterials === null || Array.isArray(rawMaterials)) {
                throw new TypeError('Material drop-rates: "materials" section must be a plain object.');
            }
            for (const [material, entry] of Object.entries(rawMaterials)) {
                // Skip comment / metadata keys (a "_"-prefixed key is a human note).
                if (material.startsWith('_')) continue;
                // Cross-validation (D2/D9): every drop-file material must be a known material.
                if (!this.materialsRegistry[material]) {
                    throw new TypeError(`Material drop-rates: unknown material "${material}" (not in data/materials.json).`);
                }
                if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                    throw new TypeError(`Material drop-rates: entry for "${material}" must be an object with dropRate and chunkFraction.`);
                }
                const { dropRate, chunkFraction } = entry;
                if (typeof dropRate !== 'number' || !Number.isFinite(dropRate) || dropRate < 0 || dropRate > 1) {
                    throw new TypeError(`Material drop-rates: "dropRate" for "${material}" must be a number in [0, 1].`);
                }
                if (typeof chunkFraction !== 'number' || !Number.isFinite(chunkFraction) || chunkFraction < 0 || chunkFraction > 1) {
                    throw new TypeError(`Material drop-rates: "chunkFraction" for "${material}" must be a number in [0, 1].`);
                }
                materials[material] = { dropRate, chunkFraction };
            }
        }

        this._dropRatesEnabled = true;
        return { minChunkVolume, materials };
    }

    /**
     * Returns the per-material drop configuration for a single material (feature 2).
     *
     * @param {string} materialName - A material ID (e.g. 'iron', 'wood').
     * @returns {{ dropRate: number, chunkFraction: number }|null} A DEFENSIVE COPY of the
     *   material's { dropRate, chunkFraction }, or null when the drop feature is disabled
     *   (file absent/empty) or the material has no entry (equivalent to a 0 rate — no drop;
     *   spec D9). Callers treat null as "this material never drops".
     */
    getDropRate(materialName) {
        if (!this._dropRatesEnabled) return null;
        const entry = this.dropRatesRegistry?.materials?.[materialName];
        return entry ? { dropRate: entry.dropRate, chunkFraction: entry.chunkFraction } : null;
    }

    /**
     * Returns the global floor applied to any dropped chunk volume (feature 2, D7).
     * @returns {number} The minimum chunk volume (0 when the feature is off or no floor
     *   is declared — a 0 floor makes max(min, fraction×lost) a no-op).
     */
    getMinChunkVolume() {
        if (!this._dropRatesEnabled) return 0;
        return this.dropRatesRegistry?.minChunkVolume ?? 0;
    }

    /**
     * Resolves the "primary" material of a composition: the entry with the largest
     * numeric fraction. This is the composition-selection math that belongs to the
     * material owner (the same home as the blended damage-type split), used by the
     * onDamage `host_material` rule to decide which material a damage chip is made of.
     *
     * Tie-break: the FIRST entry in array order wins (a later equal fraction never
     * replaces an earlier best). The composition order in data/components.json is the
     * stable canonical order, so the result is deterministic.
     *
     * Returns null when the input is not a valid non-empty composition: a non-array,
     * an empty array, or any entry that is not a plain object with a non-empty string
     * `material` and a finite numeric `fraction` >= 0. Pure function of its input —
     * no I/O, no other state; returns a defensive copy of the chosen entry.
     *
     * @param {Array<{material: string, fraction: number}>} materials - The component
     *   type's composition array (the same array the chunk handler reads via
     *   getComponentMaterialsByType()).
     * @returns {{material: string, fraction: number}|null} A defensive copy of the
     *   chosen entry, or null when the input is not a valid non-empty composition.
     */
    getPrimaryMaterial(materials) {
        if (!Array.isArray(materials) || materials.length === 0) return null;
        for (const mat of materials) {
            if (!mat || typeof mat !== 'object' || Array.isArray(mat)
                || typeof mat.material !== 'string' || mat.material.length === 0
                || typeof mat.fraction !== 'number' || !Number.isFinite(mat.fraction) || mat.fraction < 0) {
                return null;
            }
        }
        let best = materials[0];
        for (let i = 1; i < materials.length; i++) {
            if (materials[i].fraction > best.fraction) best = materials[i];
        }
        return { material: best.material, fraction: best.fraction };
    }

    /**
     * Validates the mapping registry: each key must match the shared
     * TRAIT_STAT_KEY_PATTERN (shared/StatVocabulary.js — the same constant the
     * KnowledgeController validator uses, so the two cannot disagree on key
     * form; spec §2 risk R3); each entry must have either a `formula` string or
     * a non-empty `sources` object ("at least one" — deliberately lax).
     * @param {Object} registry
     * @returns {Object}
     * @private
     */
    _validateMappingRegistry(registry) {
        if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
            throw new TypeError('Mapping registry must be a plain object.');
        }
        for (const [key, entry] of Object.entries(registry)) {
            if (!TRAIT_STAT_KEY_PATTERN.test(key)) {
                throw new TypeError(`Mapping key "${key}" does not match pattern /^[A-Za-z]+\\.[A-Za-z_]+$/.`);
            }
            const hasFormula = typeof entry.formula === 'string' && entry.formula.length > 0;
            const hasSources = entry.sources && typeof entry.sources === 'object' && !Array.isArray(entry.sources) && Object.keys(entry.sources).length > 0;
            if (!hasFormula && !hasSources) {
                throw new TypeError(`Mapping entry for "${key}" must have a non-empty "formula" or a non-empty "sources" object.`);
            }
        }
        return registry;
    }

    /**
     * Derives trait stats from a blueprint's material composition.
     * Returns an empty object {} when the blueprint has no materials field.
     *
     * In the recipe→derivation model a blueprint declares no stat values: existence,
     * the six channel resistances and sharpness derive from matter (the composition);
     * mass and volume derive from matter × form. The volume is read from the recipe's
     * `form.volume` (new model) with a fallback to a legacy top-level `volume`.
     *
     * @param {Object} blueprint - A component/item blueprint (from components.json or inventoryItems.json).
     * @returns {Object} Trait-shaped derived stats, e.g. { Physical: { existence: 1, mass: 93.6, volume: 12, … } }.
     */
    derive(blueprint) {
        const materials = blueprint.materials;

        // No materials defined → no derived stats (backward-compatible passthrough)
        if (!materials || !Array.isArray(materials) || materials.length === 0) {
            return {};
        }

        // Step 1: Validate the composition
        this._validateComposition(materials);

        // Step 2: Blend properties across materials
        const blended = this._blendProperties(materials);

        // Volume comes from the recipe's form (new model), not from matter.
        let volume = 1;
        if (blueprint.form && typeof blueprint.form.volume === 'number') {
            volume = blueprint.form.volume;
        } else if (typeof blueprint.volume === 'number') {
            volume = blueprint.volume;
        }

        // Step 3: Derive trait stats from the mapping table
        return this._deriveTraits(blended, volume);
    }

    /**
     * Public validation wrapper for compositions (components and inventory items).
     * @param {string} type - The blueprint type name (for error context).
     * @param {Array<Object>} materials - Array of { material, fraction, role? }.
     */
    validateComposition(type, materials) {
        if (!Array.isArray(materials)) {
            throw new TypeError(`Composition for "${type}" must have an array "materials" field.`);
        }
        this._validateComposition(materials);
    }

    /** @returns {Object<string,Object>} deep clone of the materials registry (project rules: public getters return deep copies) */
    getMaterialsRegistry() {
        return structuredClone(this.materialsRegistry);
    }

    /**
     * Returns the derived-on-demand flag thresholds (data/propertyTraitMapping.json
     * `flagThresholds`), mapping flag name → { property, threshold }. A component is
     * flagged when its blended material property crosses the threshold (e.g. flammable).
     * @returns {Object<string, {property: string, threshold: number}>}
     */
    getFlagThresholds() {
        return structuredClone(this.flagThresholds);
    }

    /**
     * Validates that all materials exist and fractions sum to ≤ 1.
     * @param {Array<Object>} materials - Array of { material, fraction, role? }.
     * @private
     */
    _validateComposition(materials) {
        let fractionSum = 0;

        for (const entry of materials) {
            if (!this.materialsRegistry[entry.material]) {
                throw new TypeError(
                    `Unknown material "${entry.material}" in composition. ` +
                    `Available: ${Object.keys(this.materialsRegistry).join(', ')}`
                );
            }
            if (typeof entry.fraction !== 'number' || entry.fraction <= 0) {
                throw new TypeError(
                    `Material "${entry.material}" has invalid fraction ${entry.fraction}. ` +
                    'Fraction must be a positive number.'
                );
            }
            fractionSum += entry.fraction;
        }

        if (fractionSum > 1.0 + FRACTION_SUM_TOLERANCE) {
            throw new TypeError(
                `Material fractions sum to ${fractionSum.toFixed(4)}, expected ≤ 1.0. ` +
                `Current sum: ${fractionSum.toFixed(4)}`
            );
        }
    }

    /**
     * Computes the weighted blend of all physical properties across materials.
     * Each property = Σ(fraction_i × property_i).
     *
     * @param {Array<Object>} materials - Array of { material, fraction, role? }.
     * @returns {Object<string, number>} Blended property values.
     * @private
     */
    _blendProperties(materials) {
        // Collect all known property names from the shared set (properties + density)
        const allProperties = new Set(['density']);
        for (const entry of materials) {
            const mat = this.materialsRegistry[entry.material];
            if (mat && mat.properties) {
                for (const prop of Object.keys(mat.properties)) {
                    allProperties.add(prop);
                }
            }
        }

        const blended = {};
        for (const prop of allProperties) {
            let weightedSum = 0;
            for (const entry of materials) {
                const mat = this.materialsRegistry[entry.material];
                let value;
                if (prop === 'density') {
                    value = (mat && typeof mat.density === 'number') ? mat.density : 0;
                } else {
                    value = (mat && mat.properties && typeof mat.properties[prop] === 'number')
                        ? mat.properties[prop]
                        : 0; // Unknown property defaults to 0
                }
                weightedSum += entry.fraction * value;
            }
            blended[prop] = weightedSum;
        }

        return blended;
    }

    /**
     * Derives trait stats from blended properties using the mapping table.
     *
     * Supported mapping forms (data/propertyTraitMapping.json `derivedStats`):
     *  - `formula: "densityVolume"` → mass = Σ(fraction × density) × volume.
     *  - `formula: "matterRatio"` → existence (a 0–1 store). A freshly-spawned
     *    component holds 100% of its matter, so the derived value is 1.0; runtime
     *    damage later drains the instance value toward 0 (where it ceases to exist).
     *  - `sources: { property: weight, … }` → weighted blend (sharpness + the six
     *    channel resistances). An optional `inverted: true` flips the 0–100 scale
     *    (a susceptibility source like heatConduction becomes a resistance).
     *
     * The recipe's `form.volume` is carried on `Physical.volume` so every component
     * instance exposes its form volume as a stat (mass is matter × this volume).
     *
     * @param {Object<string, number>} blended - Blended property values.
     * @param {number} volume - The component's volume (from the recipe's form).
     * @returns {Object} Trait-shaped derived stats.
     * @private
     */
    _deriveTraits(blended, volume) {
        const derived = {};

        for (const [targetPath, mapping] of Object.entries(this.mappingRegistry)) {
            const [traitId, statName] = targetPath.split('.');

            if (!derived[traitId]) {
                derived[traitId] = {};
            }

            // mass = Σ(fraction × density) × volume (blended.density is already Σ(fraction × density))
            if (mapping.formula === 'densityVolume') {
                const blendedDensity = blended.density || 0;
                derived[traitId].mass = Math.round(blendedDensity * volume * STAT_PRECISION) / STAT_PRECISION;
                continue;
            }

            // existence = matter ratio (0–1). Fresh component → full matter → 1.0.
            if (mapping.formula === 'matterRatio') {
                derived[traitId].existence = 1.0;
                continue;
            }

            // Weighted source mappings (sharpness + the six channel resistances).
            if (mapping.sources && Object.keys(mapping.sources).length > 0) {
                let weightedSum = 0;
                let weightTotal = 0;

                for (const [sourceProp, weight] of Object.entries(mapping.sources)) {
                    const sourceValue = blended[sourceProp] || 0;
                    weightedSum += sourceValue * weight;
                    weightTotal += weight;
                }

                // Normalize by total weight, then optionally invert (susceptibility → resistance).
                if (weightTotal > 0) {
                    let result = Math.round((weightedSum / weightTotal) * STAT_PRECISION) / STAT_PRECISION;
                    if (mapping.inverted) {
                        result = Math.round((100 - result) * STAT_PRECISION) / STAT_PRECISION;
                    }
                    derived[traitId][statName] = result;
                }
            }
        }

        // Volume is a form attribute (not matter) but every component carries it as a stat.
        if (!derived.Physical) {
            derived.Physical = {};
        }
        derived.Physical.volume = volume;

        // Derived named-trait flags (flammable, conductive) are a pure function of
        // the blended material properties, so they never desync from the composition.
        // Computed on each derive and stored as a list on the Physical group.
        derived.Physical.derivedFlags = this._deriveFlagsFromBlended(blended);

        return derived;
    }

    /**
     * Derives the active named-trait flags (flammable, conductive) from the
     * blended material properties and the `flagThresholds` mapping table. A flag
     * is active when its referenced material property's blended value meets or
     * exceeds the declared threshold. This is a pure function of the composition,
     * so it is stable for a component's lifetime (it never desyncs).
     * @param {Object<string, number>} blended - Blended material property values.
     * @returns {string[]} Sorted list of active flag names.
     * @private
     */
    _deriveFlagsFromBlended(blended) {
        const flags = [];
        for (const [flagName, rule] of Object.entries(this.flagThresholds)) {
            if (!rule || typeof rule.property !== 'string' || typeof rule.threshold !== 'number') continue;
            const value = blended[rule.property];
            if (typeof value === 'number' && value >= rule.threshold) {
                flags.push(flagName);
            }
        }
        return flags.sort();
    }

    /**
     * Public on-read flag derivation for a material composition. Blends the
     * composition's material properties and applies the `flagThresholds` table,
     * returning the active named-trait flags. Used by the LLM context and client
     * to surface a component's flags without a full stat derive.
     * @param {Array<Object>} materials - Array of { material, fraction, role? }.
     * @returns {string[]} Sorted list of active flag names.
     */
    deriveFlags(materials) {
        if (!materials || !Array.isArray(materials) || materials.length === 0) return [];
        const blended = this._blendProperties(materials);
        return this._deriveFlagsFromBlended(blended);
    }
}

export default MaterialController;

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
import { TRAIT_STAT_KEY_PATTERN } from '../../../shared/StatVocabulary.js';

const FRACTION_SUM_TOLERANCE = 1e-9;
const STAT_PRECISION = 100;

/**
 * Validates and blends material properties for a single blueprint.
 * @param {Object} materialsRegistry - Material definitions from data/materials.json.
 * @param {Object} mappingRegistry - Property-to-trait mapping from data/propertyTraitMapping.json.
 */
class MaterialController {
    constructor(materialsRegistry, mappingRegistry) {
        this.materialsRegistry = this._validateMaterialsRegistry(materialsRegistry || {});
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
        Logger.info(`[MaterialController] initialized with ${Object.keys(this.materialsRegistry).length} materials, ${Object.keys(this.mappingRegistry).length} mappings, ${Object.keys(this.flagThresholds).length} flag thresholds`);
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

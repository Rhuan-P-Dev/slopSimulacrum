/**
 * SynergyScaling — Shared scaling functions for synergy multiplier calculations.
 *
 * Implements three scaling curves:
 * - linear: flat per-unit bonus
 * - diminishingReturns: decelerating returns (exponential decay curve)
 * - increasingReturns: accelerating returns (power curve)
 *
 * Per wiki/code_quality_and_best_practices.md §2.3: Avoid "Magic Numbers"
 * All curve parameters are defined as named constants.
 */

/**
 * Base multiplier applied regardless of unit count.
 * @type {number}
 */
const BASE_MULTIPLIER = 1.0;

/**
 * Decay rate for diminishing returns curve.
 * Higher = faster saturation.
 * @type {number}
 */
const DIMINISHING_DECAY_RATE = 2.0;

/**
 * Exponent for increasing returns curve.
 * > 1 = accelerating, < 1 = decelerating.
 * @type {number}
 */
const INCREASING_POWER_EXPONENT = 1.5;

/**
 * Minimum valid unit count to prevent negative or zero scaling.
 * @type {number}
 */
const MIN_UNIT_COUNT = 1;

/**
 * Scaling function registry.
 * @readonly
 * @enum {function}
 */
export const SCALING_CURVES = {
    /**
     * Linear scaling: each additional unit adds a flat bonus.
     * Formula: baseMultiplier + (perUnitBonus * (count - 1))
     * @param {number} count - Number of contributing units/components (>= 1)
     * @param {number} baseMultiplier - Starting multiplier (typically 1.0)
     * @param {number} perUnitBonus - Bonus added per additional unit beyond the first
     * @returns {number} Final multiplier
     */
    linear: (count, baseMultiplier, perUnitBonus) => {
        const adjustedCount = Math.max(count, MIN_UNIT_COUNT);
        return baseMultiplier + (perUnitBonus * (adjustedCount - 1));
    },

    /**
     * Diminishing returns scaling: each additional unit adds less than the previous.
     * Formula: baseMultiplier + (perUnitBonus * (1 - e^(-decayRate * (count - 1))))
     * @param {number} count - Number of contributing units/components (>= 1)
     * @param {number} baseMultiplier - Starting multiplier (typically 1.0)
     * @param {number} perUnitBonus - Maximum bonus achievable as count → ∞
     * @returns {number} Final multiplier
     */
    diminishingReturns: (count, baseMultiplier, perUnitBonus) => {
        const adjustedCount = Math.max(count, MIN_UNIT_COUNT);
        const effectiveBonus = perUnitBonus * (1 - Math.exp(-DIMINISHING_DECAY_RATE * (adjustedCount - 1)));
        return baseMultiplier + effectiveBonus;
    },

    /**
     * Increasing returns scaling: each additional unit adds more than the previous.
     * Formula: baseMultiplier + (perUnitBonus * (count - 1)^exponent)
     * @param {number} count - Number of contributing units/components (>= 1)
     * @param {number} baseMultiplier - Starting multiplier (typically 1.0)
     * @param {number} perUnitBonus - Base factor for the power curve
     * @returns {number} Final multiplier
     */
    increasingReturns: (count, baseMultiplier, perUnitBonus) => {
        const adjustedCount = Math.max(count, MIN_UNIT_COUNT);
        const effectiveBonus = perUnitBonus * Math.pow(adjustedCount - 1, INCREASING_POWER_EXPONENT);
        return baseMultiplier + effectiveBonus;
    }
};

/**
 * Retrieves a scaling function by name.
 * @param {string} curveName - Name of the scaling curve
 * @returns {function} The scaling function
 * @throws {Error} If the curve name is unknown
 */
export const getScalingCurve = (curveName) => {
    if (!(curveName in SCALING_CURVES)) {
        throw new Error(`Unknown synergy scaling curve: "${curveName}". Available: ${Object.keys(SCALING_CURVES).join(', ')}`);
    }
    return SCALING_CURVES[curveName];
};

/**
 * Calculates synergy multiplier using the specified scaling curve.
 * @param {number} count - Number of contributing units (>= 1)
 * @param {string} scalingType - Name of the scaling curve
 * @param {number} baseMultiplier - Starting multiplier
 * @param {number} perUnitBonus - Bonus per additional unit
 * @returns {number} Final multiplier
 */
export const calculateSynergyMultiplier = (count, scalingType, baseMultiplier, perUnitBonus) => {
    const curve = getScalingCurve(scalingType);
    return curve(count, baseMultiplier, perUnitBonus);
};

export default SCALING_CURVES;
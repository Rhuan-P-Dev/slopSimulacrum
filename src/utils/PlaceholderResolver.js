/**
 * Placeholder resolution utility for action consequence parameters.
 * Handles both :Trait.stat (numeric) and :variable (any type) placeholder patterns.
 *
 * Responsibility: Resolves placeholder strings to actual values from resolution context.
 * Supports embedded placeholders within template strings, and one arithmetic suffix
 * (`*N` a multiplier, `/N` a divisor) on a numeric placeholder.
 *
 * @module PlaceholderResolver
 */

import Logger from './Logger.js';
import { DEFAULT_PLACEHOLDER_MULTIPLIER } from './Constants.js';

/**
 * The arithmetic a placeholder may carry: `*N` multiplies, `/N` divides. `N` is a
 * plain decimal number — integer or fractional — optionally signed: `*:3`, `*0.5`,
 * `/2`, `/-2`. ONE grammar feeds both regexes below, so an expression means the same
 * whether it is the whole param or buried inside a log template.
 *
 * WHY A DIVISOR IS HERE. The grammar used to be `*N` with an INTEGER `N`, and an
 * expression this module does not recognise does not fail: it falls through to a
 * template substitution. `":Physical.strength/2"` therefore resolved to the STRING
 * `"50/2"`, and every consumer that did arithmetic on it got NaN. A NaN written into a
 * stat is permanent (`NaN + x` is NaN, `existence > 0` is false so the part stops
 * being a valid target, and the damage listener never fires because `NaN < 0` is
 * false), which is how one typo in one action file turned a droid's body part into a
 * `null` in the panel. Halving is a real thing world data wants to say, so it is now
 * sayable — and a suffix that is NOT a number (`/0`) resolves to nothing rather than
 * to Infinity, so no expression this module accepts can hand the world a non-finite
 * value. That is the resolver's half of the guard; the damage handler and the stat
 * write each refuse a non-finite value too, because a bad value can also arrive as an
 * UNRESOLVED placeholder (`:Physical.armor`), which is left as its own text by design.
 *
 * `PLACEHOLDER_ARITHMETIC` is one group pair: (operator, operand).
 *
 * Both fragments are EXPORTED because the law of what-counts-as-a-placeholder has exactly
 * one owner. The effect-definition guard (`EffectDefinitionRules`) has to refuse a
 * parameter that still wears this shape, and a guard built from these fragments cannot
 * disagree with what this module actually substitutes. A re-typed copy did: it kept the
 * old `*N`-only grammar after the language grew `/N` and decimals, so an unresolved
 * `:NoSuch.stat/2` walked past the guard and into an operation as a stat name.
 * @type {string}
 */
export const PLACEHOLDER_ARITHMETIC = '([*/])(-?\\d+(?:\\.\\d+)?)';

/**
 * The placeholder head: `:` then a dotted path (`:Physical.strength`, `:fuel`). Exported
 * with `PLACEHOLDER_ARITHMETIC`, for the same reason.
 * @type {string}
 */
export const PLACEHOLDER_TOKEN = ':[a-zA-Z0-9_.]+';

/**
 * Placeholder regex: matches a whole-string placeholder with an optional sign and an
 * optional arithmetic suffix. Supports both :Trait.stat and simple :variable patterns.
 * Format: `:Trait.stat` or `:variable` or `-:Trait.stat` or `*:3` or `/2` or `-:variable*0.5`
 * @type {RegExp}
 */
const EXACT_PLACEHOLDER_REGEX = new RegExp(`^(-)?(${PLACEHOLDER_TOKEN})(?:${PLACEHOLDER_ARITHMETIC})?$`);

/**
 * Embedded placeholder regex: the SAME grammar, unanchored, for placeholders inside a
 * template string. Kept derived from `PLACEHOLDER_ARITHMETIC` rather than written out
 * again so the two can never drift into two dialects.
 * @type {RegExp}
 */
const EMBEDDED_PLACEHOLDER_REGEX = new RegExp(`(-)?(${PLACEHOLDER_TOKEN})(?:${PLACEHOLDER_ARITHMETIC})?`, 'g');

/**
 * Turns the arithmetic suffix into the factor to multiply by — a divisor becomes its
 * reciprocal, so both operators end in the single operation every caller performs.
 * @param {string|undefined} operator - `*`, `/`, or undefined for no suffix
 * @param {string|undefined} operand - the matched number, as text
 * @returns {number|null} the factor, or null when the suffix is not a number usable
 *          as one (a divisor of zero), which the caller leaves unresolved
 * @private
 */
function _toFactor(operator, operand) {
    if (!operator) return DEFAULT_PLACEHOLDER_MULTIPLIER;
    const amount = Number(operand);
    if (!Number.isFinite(amount)) return null;
    if (operator === '/') return amount === 0 ? null : 1 / amount;
    return amount;
}

/**
 * Applies sign and suffix to a numeric placeholder value, or reports that the
 * expression produced nothing usable.
 * @param {string} raw - the whole matched text, returned unchanged on refusal
 * @param {string|undefined} signGroup - the leading `-`, when the expression has one
 * @param {string|undefined} operator - `*`, `/`, or undefined
 * @param {string|undefined} operand - the matched number, as text
 * @param {number} value - the resolved stat value
 * @returns {number|string} the scaled number, or `raw` when the expression is not a
 *          finite number (a division by zero, or an overflow past Infinity)
 * @private
 */
function _scale(raw, signGroup, operator, operand, value) {
    const factor = _toFactor(operator, operand);
    const scaled = factor === null ? NaN : (signGroup === '-' ? -1 : 1) * value * factor;
    if (!Number.isFinite(scaled)) {
        Logger.warn(`[PlaceholderResolver] "${raw}" does not resolve to a finite number — left unresolved.`);
        return raw;
    }
    return scaled;
}

/**
 * Resolves placeholders in params.
 * Supports :Trait.stat (numeric) and :variable (any type) patterns.
 * Embedded placeholders in template strings are replaced with their values.
 * Exact placeholders resolve to numbers when numeric, or to strings when non-numeric.
 *
 * @param {any} params - The value to resolve (string, number, array, or object).
 * @param {Object} resolutionContext - Map of placeholder names to their values.
 * @returns {any} The resolved value.
 */
export function resolvePlaceholders(params, resolutionContext) {
    if (params === null || params === undefined) return params;

    if (typeof params === 'string') {
        return _resolveStringPlaceholder(params, resolutionContext);
    }

    if (typeof params === 'number') return params;
    if (Array.isArray(params)) return params.map(p => resolvePlaceholders(p, resolutionContext));
    if (typeof params === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(params)) {
            result[key] = resolvePlaceholders(value, resolutionContext);
        }
        return result;
    }

    return params;
}

/**
 * Resolves a string placeholder value.
 * @param {string} str - The string to resolve.
 * @param {Object} resolutionContext - Map of placeholders to their values.
 * @returns {string|number} The resolved value.
 * @private
 */
function _resolveStringPlaceholder(str, resolutionContext) {
    // If the string is EXACTLY a placeholder (with optional sign/multiplier), resolve it
    const exactMatch = str.match(EXACT_PLACEHOLDER_REGEX);
    if (exactMatch) {
        return _resolveExactPlaceholder(exactMatch, resolutionContext);
    }

    // Otherwise, treat as a template string and replace all embedded placeholders.
    // Supports both :Trait.stat (numeric, with the arithmetic suffix) and :variable
    // (any type) patterns.
    return str.replace(EMBEDDED_PLACEHOLDER_REGEX, (_match, sign, placeholder, operator, operand) => {
        const pName = placeholder.substring(1);
        const val = resolutionContext[pName];
        if (val === undefined) return _match;

        if (typeof val !== 'number') {
            // Simple variable placeholder embedded in a string (e.g., "Item ':itemType' dropped")
            return String(val);
        }

        return _scale(_match, sign, operator, operand, val);
    });
}

/**
 * Resolves an exact placeholder match to a value.
 * Supports both :Trait.stat (numeric) and simple :variable (any type) patterns.
 * @param {RegExpMatchArray} match - The regex match array.
 * @param {Object} resolutionContext - Map of placeholders to their values.
 * @returns {number|string} The resolved value, or original string if unresolved.
 * @private
 */
function _resolveExactPlaceholder(match, resolutionContext) {
    const placeholder = match[2].substring(1);
    const value = resolutionContext[placeholder];

    if (value !== undefined && typeof value === 'number') {
        return _scale(match[0], match[1], match[3], match[4], value);
    }

    if (value !== undefined && typeof value !== 'number') {
        // Simple variable placeholder (e.g., :entityId, :itemId, :itemType)
        return String(value);
    }

    Logger.warn(`[PlaceholderResolver] Placeholder "${placeholder}" not found in resolution context.`);
    return match[0]; // Return original string if unresolved
}
/**
 * Placeholder resolution utility for action consequence parameters.
 * Handles both :Trait.stat (numeric) and :variable (any type) placeholder patterns.
 *
 * Responsibility: Resolves placeholder strings to actual values from resolution context.
 * Supports embedded placeholders within template strings.
 *
 * @module PlaceholderResolver
 */

import Logger from './Logger.js';
import {
    DEFAULT_PLACEHOLDER_MULTIPLIER,
    PARSING_RADIX,
} from './Constants.js';

/**
 * Placeholder regex: matches exact placeholders with optional sign and multiplier.
 * Supports both :Trait.stat and simple :variable patterns.
 * Format: `:Trait.stat` or `:variable` or `-:Trait.stat` or `*:3` or `-:variable*3`
 * @type {RegExp}
 */
const EXACT_PLACEHOLDER_REGEX = /^(-)?(:[a-zA-Z0-9_.]+)(?:\*(-?\d+))?$/;

/**
 * Embedded placeholder regex: matches placeholders within template strings.
 * Supports both :Trait.stat and :variable patterns.
 * @type {RegExp}
 */
const EMBEDDED_PLACEHOLDER_REGEX = /(-)?(:[a-zA-Z0-9_.]+)(\*(-?\d+))?/g;

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
    // Supports both :Trait.stat (numeric) and :variable (any type) patterns.
    return str.replace(EMBEDDED_PLACEHOLDER_REGEX, (_match, sign, placeholder, multiplier) => {
        const pName = placeholder.substring(1);
        const val = resolutionContext[pName];
        if (val === undefined) return _match;

        if (typeof val !== 'number') {
            // Simple variable placeholder embedded in a string (e.g., "Item ':itemType' dropped")
            return String(val);
        }

        const s = sign === '-' ? -1 : 1;
        const m = multiplier ? parseInt(multiplier.substring(1), PARSING_RADIX) : DEFAULT_PLACEHOLDER_MULTIPLIER;
        return s * val * m;
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
    const sign = match[1] === '-' ? -1 : 1;
    const placeholder = match[2].substring(1);
    const multiplier = match[3] ? parseInt(match[3], PARSING_RADIX) : DEFAULT_PLACEHOLDER_MULTIPLIER;
    const value = resolutionContext[placeholder];

    if (value !== undefined && typeof value === 'number') {
        return sign * value * multiplier;
    }

    if (value !== undefined && typeof value !== 'number') {
        // Simple variable placeholder (e.g., :entityId, :itemId, :itemType)
        return String(value);
    }

    Logger.warn(`[PlaceholderResolver] Placeholder "${placeholder}" not found in resolution context.`);
    return match[0]; // Return original string if unresolved
}
/**
 * Placeholder resolution utility for action consequence parameters.
 * Handles placeholder strings like ":Physical.strength" and embedded placeholders in template strings.
 * 
 * Responsibility: Resolves placeholder strings to actual numeric values from requirement maps.
 * This logic was extracted from ActionController to adhere to the Single Responsibility Principle (SRP).
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
 * Format: `:Trait.stat` or `-:Trait.stat` or `*:3` or `-:Trait.stat*3`
 * @type {RegExp}
 */
const EXACT_PLACEHOLDER_REGEX = /^(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\*(-?\d+))?$/;

/**
 * Embedded placeholder regex: matches placeholders within template strings.
 * @type {RegExp}
 */
const EMBEDDED_PLACEHOLDER_REGEX = /(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(\*(-?\d+))?/g;

/**
 * Resolves placeholders in params (e.g., ":Movement.move" → actual value).
 * Supports embedded placeholders within strings and numeric validation.
 *
 * @param {any} params - The value to resolve (string, number, array, or object).
 * @param {Object} requirementValues - Map of "trait.stat" → numeric value.
 * @returns {any} The resolved value (number if placeholder resolved, original otherwise).
 */
export function resolvePlaceholders(params, requirementValues) {
    if (params === null || params === undefined) return params;

    if (typeof params === 'string') {
        return _resolveStringPlaceholder(params, requirementValues);
    }

    if (typeof params === 'number') return params;
    if (Array.isArray(params)) return params.map(p => resolvePlaceholders(p, requirementValues));
    if (typeof params === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(params)) {
            result[key] = resolvePlaceholders(value, requirementValues);
        }
        return result;
    }

    return params;
}

/**
 * Resolves a string placeholder value.
 * @param {string} str - The string to resolve.
 * @param {Object} requirementValues - Map of "trait.stat" → numeric value.
 * @returns {string|number} The resolved value.
 * @private
 */
function _resolveStringPlaceholder(str, requirementValues) {
    // If the string is EXACTLY a placeholder (with optional sign/multiplier), return as number
    const exactMatch = str.match(EXACT_PLACEHOLDER_REGEX);
    if (exactMatch) {
        return _resolveExactPlaceholder(exactMatch, requirementValues);
    }

    // Otherwise, treat as a template string and replace all embedded placeholders
    return str.replace(EMBEDDED_PLACEHOLDER_REGEX, (_match, sign, placeholder, multiplier) => {
        const pName = placeholder.substring(1);
        const val = requirementValues[pName];
        if (val === undefined) return _match;

        if (typeof val !== 'number') {
            Logger.warn(`[PlaceholderResolver] Placeholder "${pName}" resolved to non-numeric value:`, val);
            return _match; // Keep original placeholder
        }

        const s = sign === '-' ? -1 : 1;
        const m = multiplier ? parseInt(multiplier.substring(1), PARSING_RADIX) : DEFAULT_PLACEHOLDER_MULTIPLIER;
        return s * val * m;
    });
}

/**
 * Resolves an exact placeholder match to a numeric value.
 * @param {RegExpMatchArray} match - The regex match array.
 * @param {Object} requirementValues - Map of "trait.stat" → numeric value.
 * @returns {number|string} The resolved numeric value, or original string if invalid.
 * @private
 */
function _resolveExactPlaceholder(match, requirementValues) {
    const sign = match[1] === '-' ? -1 : 1;
    const placeholder = match[2].substring(1);
    const multiplier = match[3] ? parseInt(match[3], PARSING_RADIX) : DEFAULT_PLACEHOLDER_MULTIPLIER;
    const value = requirementValues[placeholder];

    if (value !== undefined && typeof value === 'number') {
        return sign * value * multiplier;
    }

    Logger.warn(`[PlaceholderResolver] Placeholder "${placeholder}" resolved to non-numeric value:`, value);
    return match[0]; // Return original string if not numeric
}
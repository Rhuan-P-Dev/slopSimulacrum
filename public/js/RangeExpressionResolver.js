/**
 * RangeExpressionResolver
 * Resolves range expression strings to numeric values.
 *
 * Handles expressions like:
 *   ":Physical.strength*2+3"  →  strength * 2 + 3
 *   ":Physical.strength"       →  strength
 *   "50"                       →  50 (literal)
 *
 * This mirrors the server-side PlaceholderResolver.js logic.
 * Used by ActionExecutor and ClientApp for client-side range validation.
 *
 * @module RangeExpressionResolver
 */

/**
 * Resolves a range expression string to a numeric value.
 *
 * @param {string} expression - The range expression (e.g., ":Physical.strength*2+3")
 * @param {Object} context - Map of placeholder names to values.
 *   e.g., { "Physical.strength": 25 }
 * @param {number} fallback - Value to return if expression cannot be resolved.
 * @returns {number} The resolved numeric range.
 */
export function resolveRangeExpression(expression, context, fallback) {
    if (!expression) return fallback;

    // Match tokens: [+|-](:Placeholder[multiplier])
    const tokenRegex = /([+])|(-)?(:[a-zA-Z0-9_.]+)(?:\*(-?\d+))?/g;
    let result = 0;
    let foundPlaceholder = false;

    let match;
    while ((match = tokenRegex.exec(expression)) !== null) {
        // Skip standalone '+' signs
        if (match[1] === '+') continue;

        const sign = match[2] === '-' ? -1 : 1;
        const placeholder = match[3] ? match[3].substring(1) : null; // Remove leading ':'
        const multiplier = match[4] ? parseInt(match[4].substring(1), 10) : 1;

        if (placeholder) {
            const value = context[placeholder] !== undefined ? context[placeholder] : 0;
            result += sign * value * multiplier;
            foundPlaceholder = true;
        }
    }

    // If no placeholders found, try safe arithmetic evaluation
    if (!foundPlaceholder) {
        try {
            if (/^[\d+\-*/(). ]+$/.test(expression)) {
                return Function('"use strict"; return (' + expression + ')')();
            }
        } catch (_) {
            // Expression is invalid — fall through to return fallback
        }
        return fallback;
    }

    return result;
}

/**
 * Builds a stat value lookup function for drop range resolution.
 *
 * @param {Object} droid - The active droid entity with components array.
 * @param {Object} state - The current world state with component stats.
 * @returns {function} A function that returns the stat value for a given placeholder.
 */
export function buildStatResolver(droid, state) {
    return function getStatValue(placeholder) {
        if (!droid || !state || !droid.components) return 0;

        for (const comp of droid.components) {
            const stats = state.components?.instances?.[comp.id];
            if (stats && placeholder.includes('.')) {
                const [trait, stat] = placeholder.split('.');
                if (stats[trait] && stats[trait][stat] !== undefined) {
                    return stats[trait][stat];
                }
            }
        }

        return 0;
    };
}
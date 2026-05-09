/**
 * SynergyCalculator — Computes synergy multipliers using scaling curves.
 * Single Responsibility: Calculate multipliers, apply caps, build results.
 *
 * Extracted from SynergyController to adhere to the Single Responsibility Principle.
 *
 * @module SynergyCalculator
 */

import { calculateSynergyMultiplier } from '../../utils/SynergyScaling.js';

class SynergyCalculator {
    /**
     * Calculate synergy multiplier for a group.
     * @param {number} count - Number of members.
     * @param {string} scaling - Scaling curve name.
     * @param {number} baseMultiplier - Base multiplier.
     * @param {number} perUnitBonus - Bonus per additional member.
     * @returns {number} The computed multiplier.
     */
    computeMultiplier(count, scaling, baseMultiplier, perUnitBonus) {
        return calculateSynergyMultiplier(count, scaling, baseMultiplier, perUnitBonus);
    }

    /**
     * Apply synergy multiplier to a base value.
     * @param {number} synergyMultiplier - The synergy multiplier.
     * @param {number} baseValue - The base consequence value.
     * @returns {number} The final value.
     */
    applyToValue(synergyMultiplier, baseValue) {
        return baseValue * synergyMultiplier;
    }

    /**
     * Apply caps to a value.
     * @param {number} value - The uncapped value.
     * @param {Object} capDef - Cap definition with max property.
     * @returns {{ value: number, capped: boolean, capKey: string|null }}
     */
    applyCap(value, capDef) {
        if (!capDef || capDef.max === null || capDef.max === 'infinite') {
            return { value, capped: false, capKey: null };
        }
        return { value: Math.min(value, capDef.max), capped: true, capKey: 'cap' };
    }

    /**
     * Deduplicate contributing components by componentId.
     * @param {Array} components - Array of component entries.
     * @returns {Array} Deduplicated array.
     */
    deduplicate(components) {
        const seen = new Set();
        return components.filter(c => {
            if (seen.has(c.componentId)) return false;
            seen.add(c.componentId);
            return true;
        });
    }

    /**
     * Create a synergy result object.
     * @param {string} actionName - The action name.
     * @param {number} multiplier - The final multiplier.
     * @param {boolean} capped - Whether capped.
     * @param {string|null} capKey - Which cap was applied.
     * @param {Array} contributingComponents - Contributing components.
     * @param {string} summary - Human-readable summary.
     * @returns {Object} SynergyResult object.
     */
    createResult(actionName, multiplier, capped, capKey, contributingComponents, summary) {
        return {
            actionName,
            synergyMultiplier: multiplier,
            capped,
            capKey,
            contributingComponents,
            summary
        };
    }
}

export default SynergyCalculator;
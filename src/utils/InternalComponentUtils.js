import DataLoader from './DataLoader.js';

/**
 * Utility class for internal component operations.
 */
class InternalComponentUtils {
    /**
     * Generates a human-readable description for an internal component based on its definition.
     * @param {string} type - The internal component type.
     * @returns {string} The generated description.
     */
    static generateDescription(type) {
        const registry = DataLoader.loadJsonSafe('data/internalComponents.json', {});
        const definition = registry[type];
        if (!definition?.tickEffects?.length) return 'Passive internal component.';

        const tickInterval = definition.tickInterval || 1;
        const effectDescriptions = definition.tickEffects.map(eff => {
            const { targetTrait, targetStat, effect, amount } = eff;
            if (effect === 'add') return `adds ${amount} ${targetStat} to ${targetTrait}`;
            if (effect === 'multiply') return `multiplies ${targetStat} by ${amount} for ${targetTrait}`;
            return `${targetStat} affected for ${targetTrait}`;
        });

        return `Passively ${effectDescriptions.join(' and ')} every ${tickInterval} ticks.`;
    }
}

export default InternalComponentUtils;
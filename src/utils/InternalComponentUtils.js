/**
 * Utility class for internal component operations.
 */
class InternalComponentUtils {
    /**
     * Generates a human-readable description for an internal component
     * from its definition. The definition is passed in (rather than re-reading
     * the data file on every call) so the caller can reuse the already-loaded
     * registry — this avoids a disk read per broadcast per component.
     * @param {Object} definition - The internal component definition (the value at registry[type]).
     * @returns {string} The generated description.
     */
    static generateDescription(definition) {
        if (!definition) return 'Unknown internal component.';
        if (definition.turnDriven) {
            if (!definition.turnEffects?.length) return 'Turn-driven internal component.';
            const effectDescriptions = definition.turnEffects.map(eff => {
                const { targetTrait, targetStat, effect, amount, target } = eff;
                const who = target === 'host' ? 'host' : 'itself';
                if (effect === 'add') return `adds ${amount} ${targetStat} to ${targetTrait} of ${who}`;
                if (effect === 'multiply') return `multiplies ${targetStat} by ${amount} for ${targetTrait} of ${who}`;
                if (effect === 'set') return `sets ${targetTrait} ${targetStat} to ${amount} on ${who}`;
                return `${targetStat} affected for ${targetTrait} of ${who}`;
            });
            return `Each turn, ${effectDescriptions.join(', and ')}.`;
        }

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

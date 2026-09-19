/**
 * Utility class for internal component operations.
 */
class InternalComponentUtils {
    /**
     * Formats a flat "Group.stat" wire key into a readable label
     * ("Physical.strength" → "Physical strength").
     * @param {string} statKey - The flat key (must contain a dot).
     * @returns {string} The human-readable stat label.
     * @private
     */
    static _formatStatKey(statKey) {
        return String(statKey).replace(/\./g, ' ');
    }

    /**
     * Renders a single overTime effect definition into a clause, built only
     * from the effect's own declared fields (no hardcoded effect prose).
     * Returns null for an unrecognized effect type so callers can skip it
     * instead of rendering a generic sentence.
     * @param {Object} effect - One entry of the definition's overTime array.
     * @returns {string|null} The clause, or null.
     * @private
     */
    static _describeOverTimeEffect(effect) {
        if (!effect || typeof effect !== 'object') return null;
        const cadence = typeof effect.intervalTurns === 'number'
            ? `Every ${effect.intervalTurns} turn${effect.intervalTurns === 1 ? '' : 's'}, `
            : '';

        switch (effect.type) {
            case 'restoreExistence': {
                const gain = typeof effect.existenceGainPerInterval === 'number' ? effect.existenceGainPerInterval : 0;
                return `${cadence}restores ${gain} existence to the host`;
            }
            case 'emitChannelDamage': {
                const damage = typeof effect.damagePerInterval === 'number' ? effect.damagePerInterval : 0;
                const range = typeof effect.range === 'number' ? effect.range : 0;
                return `${cadence}emits ${damage} ${effect.channel ?? 'channel'} damage to components within ${range}`;
            }
            case 'consumeFuelGenerateStat': {
                const fuel = Number.isInteger(effect.fuelConsumedPerInterval) ? effect.fuelConsumedPerInterval : 0;
                const gain = typeof effect.energyGainPerInterval === 'number' ? effect.energyGainPerInterval : 0;
                const capacity = typeof effect.energyCapacity === 'number' ? effect.energyCapacity : 0;
                const target = typeof effect.targetStat === 'string' ? InternalComponentUtils._formatStatKey(effect.targetStat) : 'a stat';
                return `${cadence}burns ${fuel} ${effect.fuelItem ?? 'fuel'} to charge the host ${gain} ${target} (capacity ${capacity})`;
            }
            default:
                return null;
        }
    }

    /**
     * Generates a human-readable description of what an internal component
     * does, derived entirely from its definition data:
     *   - `grants`      → the function stats it maintains on the host
     *   - `grantsFlags` → the flags it marks the host with
     *   - `overTime`    → the periodic effects (per effect type, cadence and
     *                     parameters)
     * Nothing is hardcoded per type: the same renderer covers every organ,
     * so a new organ type gets a correct description just by shipping data.
     * The definition is passed in (rather than re-reading the data file on
     * every call) so the caller can reuse the already-loaded registry —
     * this avoids a disk read per broadcast per component.
     * @param {Object} definition - The internal component definition (the value at registry[type]).
     * @returns {string} The generated description.
     */
    static generateDescription(definition) {
        if (!definition || typeof definition !== 'object') return 'Unknown internal component.';

        const clauses = [];

        for (const [statKey, value] of Object.entries(definition.grants ?? {})) {
            if (typeof value !== 'number') continue;
            clauses.push(`maintains the host's ${InternalComponentUtils._formatStatKey(statKey)} at ${value}`);
        }

        if (Array.isArray(definition.grantsFlags)) {
            for (const flag of definition.grantsFlags) {
                if (typeof flag !== 'string' || flag.trim() === '') continue;
                clauses.push(`marks the host as ${flag}`);
            }
        }

        if (Array.isArray(definition.overTime)) {
            for (const effect of definition.overTime) {
                const clause = InternalComponentUtils._describeOverTimeEffect(effect);
                if (clause) clauses.push(clause);
            }
        }

        if (clauses.length === 0) return 'No measurable effects declared.';
        return clauses.map(clause => `${clause[0].toUpperCase()}${clause.slice(1)}.`).join(' ');
    }

    /**
     * Attaches a generated `description` to every internal component instance
     * of an array, resolved through the shared registry. This is the single
     * enrichment step every server surface (world-state broadcast,
     * internal-component routes) runs before an instance crosses the wire, so
     * the frontend never renders a missing or stale description.
     * Mutates and returns the same array for chaining convenience.
     * @param {Array} instances - Internal component instance array.
     * @param {Object} registry - The internal component type registry.
     * @returns {Array} The same array, enriched in place.
     */
    static enrichWithDescriptions(instances, registry) {
        if (!Array.isArray(instances)) return instances;
        for (const ic of instances) {
            if (ic && typeof ic === 'object' && ic.type) {
                ic.description = InternalComponentUtils.generateDescription(registry?.[ic.type]);
            }
        }
        return instances;
    }
}

export default InternalComponentUtils;

/**
 * Reads a definition's physical volume. Recipe→derivation model puts it under
 * `form.volume`; the legacy top-level `volume` and `traits.Physical.volume` are
 * fallbacks for unmigrated definitions. Returns 0 when no volume is declared.
 * @param {Object|undefined|null} def - An item or component definition.
 * @returns {number} The declared volume (0 when absent).
 */
export function getDefinitionVolume(def) {
    if (!def) return 0;
    if (typeof def.form?.volume === 'number') return def.form.volume;
    if (typeof def.volume === 'number') return def.volume;
    if (typeof def.traits?.Physical?.volume === 'number') return def.traits.Physical.volume;
    return 0;
}

/**
 * Reads a definition's host footprint — the volume an item occupies on its
 * host component. Recipe→derivation stores it under `form.externalVolume`;
 * the legacy top-level `externalVolume` is a fallback for unmigrated
 * definitions; when neither is declared, the full declared volume applies
 * (getDefinitionVolume).
 *
 * This is the single source of the footprint chain, shared by the capacity
 * checks that must agree with each other (initial-spawn slot gating and the
 * item-addition capacity check) so the gate and the actual add never
 * disagree.
 * @param {Object|undefined|null} def - An item or component definition.
 * @returns {number} The host footprint (external footprint, else full volume).
 */
export function getDefinitionHostFootprint(def) {
    const externalVolume = (typeof def?.form?.externalVolume === 'number')
        ? def.form.externalVolume
        : (typeof def?.externalVolume === 'number' ? def.externalVolume : undefined);
    return (typeof externalVolume === 'number') ? externalVolume : getDefinitionVolume(def);
}

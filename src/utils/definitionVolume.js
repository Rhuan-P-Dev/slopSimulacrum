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

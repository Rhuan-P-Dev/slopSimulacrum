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
 * Reads a definition's host footprint — the volume an item actually occupies on
 * its host component. A container can declare a separate external footprint under
 * `form.externalVolume` (the recipe→derivation model location); the legacy
 * top-level `externalVolume` is a fallback for unmigrated definitions; otherwise
 * the item's full volume (via getDefinitionVolume) is its footprint. This is the
 * single source of truth shared by the initial-spawn slot resolver
 * (WorldStateController._resolveInitialSpawnSlot) and InventoryManager.addItem,
 * so the footprint rule has exactly one definition.
 * @param {Object|undefined|null} def - An item or component definition.
 * @returns {number} The host footprint (falls back to the full volume).
 */
export function getDefinitionFootprint(def) {
    if (!def) return 0;
    if (typeof def.form?.externalVolume === 'number') return def.form.externalVolume;
    if (typeof def.externalVolume === 'number') return def.externalVolume;
    return getDefinitionVolume(def);
}

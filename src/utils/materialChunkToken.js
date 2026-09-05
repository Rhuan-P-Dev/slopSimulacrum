/**
 * materialChunkToken — the single source of truth for the "chunk of matter" ground
 * item mechanics shared by the legacy punch chunk stream
 * (MaterialChunkDropHandler) and the onDamage world-event rule (OnDamageDropListener).
 *
 * Extracting these two computations here keeps "the same kind of item the chunk system
 * produces" true BY CONSTRUCTION rather than by copy-paste (design §3.6): the onDamage
 * token is deliberately indistinguishable from a chunk-stream token on the ground (the
 * same chunk_<material> item identity and the same self-describing name/description
 * strings — an accepted tradeoff the torn stream already documents).
 *
 * Both functions are pure (no I/O, no shared state, no mutation of their inputs).
 *
 * @module materialChunkToken
 */

/**
 * The chunk-fraction fallback used when a material has no drop-rates entry (the
 * drop-rates file is absent or the feature is off). 1.0 means "the token represents
 * the full matter share actually lost" rather than a partial chip: the world law must
 * not depend on the presence of a balance file (design §9.4). Named to keep the
 * fallback out of the call sites as a magic number.
 * @type {number}
 */
export const FULL_MATTER_SHARE = 1.0;

/**
 * Computes the D7 chunk volume: the floor-gated matter chip of a damaged component.
 *
 * This evaluates to the EXACT float sequence the legacy chunk stream has always used,
 * so refactoring the chunk stream onto this helper is line-for-line equivalent (the
 * torn stream keeps its own distinct formula and is NOT routed through this function):
 *
 *     lost        = appliedLoss * fraction * recipeVolume   (left-to-right)
 *     chunkVolume = Math.max(minChunkVolume, chunkFraction * lost)
 *
 * `dropConfig === null` (drop-rates feature off) is handled by falling back to
 * `FULL_MATTER_SHARE` for the chunk fraction. For the existing chunk-stream call sites
 * `dropConfig` is always non-null, so the refactor there changes nothing.
 *
 * @param {Object|null} dropConfig - `{ dropRate, chunkFraction }` or null (feature off).
 * @param {number} appliedLoss - The applied damage loss (already clamped/published).
 * @param {number} fraction - The composition fraction of this material (0..1).
 * @param {number} recipeVolume - The component's total recipe volume.
 * @param {number} minChunkVolume - The global floor (0 when the feature is off).
 * @returns {number} The chunk volume, always >= minChunkVolume.
 */
export function computeChunkVolume(dropConfig, appliedLoss, fraction, recipeVolume, minChunkVolume) {
    const chunkFraction = dropConfig?.chunkFraction ?? FULL_MATTER_SHARE;
    const lost = appliedLoss * fraction * recipeVolume;
    return Math.max(minChunkVolume, chunkFraction * lost);
}

/**
 * Builds the self-describing ground item definition for a chunk of a material.
 *
 * Reproduces the exact name/description strings the chunk stream has always emitted, so
 * an onDamage token is indistinguishable from a chunk-stream token on the ground
 * (design §9.3). `volume` is passed in because the two streams use different volume
 * levers (the D7 chunk fraction vs. the torn percentage) but share one item identity.
 *
 * @param {string} materialName - The display name of the material.
 * @param {number} volume - The computed volume of this token.
 * @returns {{ name: string, description: string, volume: number }} The item definition.
 */
export function buildChunkItemDef(materialName, volume) {
    return {
        name: `${materialName} chunk`,
        description: `A chunk of ${materialName} chipped off a damaged component.`,
        volume
    };
}

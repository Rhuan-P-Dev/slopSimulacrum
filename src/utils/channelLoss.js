/** Base absorption capacity on the 0–100 resistance scale (shared by all channel-damage math). @type {number} */
export const RESISTANCE_SCALE = 100;

/**
 * Existence loss (a 0–1 fraction) from a raw damage amount and a channel resistance (0–100).
 * Higher resistance absorbs more, so the loss shrinks: resistance 0 → value/100,
 * resistance 100 → value/200. The single source of truth for the per-channel ratio
 * that both the damage-consequence handler and the internal-component controller use.
 * @param {number} value - The raw damage amount (may be negative; clamped to ≥ 0).
 * @param {number} resistance - The target's resistance to the channel (0–100; clamped to ≥ 0).
 * @returns {number} The existence loss (≥ 0).
 */
export function channelLossFromResistance(value, resistance) {
    return Math.max(0, value) / (RESISTANCE_SCALE + Math.max(0, resistance));
}

/**
 * DiskSampler — pure utility for uniform disk sampling.
 *
 * Uses uniform angle in 0..2π and radius via square root of the uniform
 * to avoid bias toward the center. Shared by the knife trigger
 * and the spill from §3.5.1.
 *
 * @module DiskSampler
 */

import Logger from '../utils/Logger.js';

/** Default radius for triggers (5 units) — exported for shared use. */
export const DEFAULT_TRIGGER_RADIUS = 5;

/**
 * Generates a uniform random point on a disk.
 * @param {number} cx - Centro X.
 * @param {number} cy - Centro Y.
 * @param {number} radius - Disk radius.
 * @param {() => number} [rand=Math.random] - Random generator function (for testing).
 * @returns {{ x: number, y: number }} Point inside the disk.
 */
function sampleDiskPoint(cx, cy, radius, rand = Math.random) {
    // Guard: non-finite or non-positive radius must not produce garbage coordinates.
    if (!Number.isFinite(radius) || radius <= 0) {
        Logger.warn(`[DiskSampler] sampleDiskPoint called with invalid radius: ${radius}; returning null.`);
        return null;
    }
    const angle = rand() * 2 * Math.PI;
    // Radius via square root of uniform for uniform distribution
    const r = radius * Math.sqrt(rand());
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    return { x, y };
}

export { sampleDiskPoint };

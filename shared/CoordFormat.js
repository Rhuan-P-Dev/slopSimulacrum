/**
 * CoordFormat — the perception coordinate display rule.
 *
 * Any coordinate shown by the perception surface is **truncated to two
 * decimal places (toward zero)** and rendered with **exactly two decimal
 * digits** ("00.00"):
 *
 *   18.81000041279735 → 18.81  → "18.81"
 *   -6.795872605527817 → -6.79 → "-6.79"
 *   300               → 300    → "300.00"
 *   0                 → 0      → "0.00"
 *
 * Truncation (not rounding): the value is cut at the second decimal, toward
 * zero. A pre-round at 8 decimals strips binary-float noise first, so a value
 * stored as 0.28999999999999998 truncates to 0.29 (never 0.28), and
 * 18.81000041279735 (noise above the cut) truncates to 18.81 (not 18.82 —
 * that would be rounding).
 *
 * This is a **display** rule, not a world rule: world state, room snapshots
 * and the diff keep full precision. The PerceptionController truncates the
 * coordinates it ships in delta entries (agent/NPC JSON view), and the
 * client's InTextPanel formats whatever it renders through formatPosition.
 * Truncation is idempotent, so applying the rule at both layers is a no-op
 * the second time around.
 *
 * Shared on purpose: importable from both `src/` (server) and `public/js/`
 * (client) — see shared/TurnPhases.js for the same pattern.
 *
 * @module CoordFormat
 */

/**
 * The display resolution of the perception surface: coordinates are shown
 * with exactly two decimal digits ("00.00"), so one display step is 0.01
 * world units. This is the observer's perceptual resolution: a change
 * smaller than this step is invisible to every reader of the perception
 * surface, so (a) the diff reports a "moved" only when the *truncated*
 * coordinates differ (DeltaDiff), and (b) the world does not even move an
 * entity toward a target closer than one step (MIN_MOVEMENT_DISTANCE).
 * @type {number}
 */
export const DISPLAY_RESOLUTION = 0.01;

/**
 * Truncates a numeric value to two decimal places (toward zero).
 * @param {*} value - The value to truncate (number or numeric string; null/
 *   undefined/NaN/objects are not finite and yield null).
 * @returns {number|null} The value with at most two decimal places (0.0 for
 *   sub-half-cent magnitudes — never -0), or null when not finite.
 */
export function truncateCoord(value) {
    const n = value == null ? Number.NaN : Number(value);
    if (!Number.isFinite(n)) return null;
    const sign = n < 0 ? -1 : 1;
    // 8-decimal round first (kills float noise), then integer truncation to
    // the hundredths — done in integer space so no second float error can
    // push the value back across a truncation boundary. (hundredths is an
    // integer count of 1/100 units → divide by 100 to return to unit value.)
    const a8 = Math.round(Math.abs(n) * 1e8);
    const hundredths = Math.trunc(a8 / 1e6);
    const v = sign * (hundredths / 100);
    return v === 0 ? 0 : v; // normalize -0 → 0 (never render "-0.00")
}

/**
 * The "00.00" form of a coordinate: truncated to two decimals, always shown
 * with exactly two decimal digits.
 * @param {*} value
 * @returns {string|null} e.g. "18.81", "-6.79", "300.00", "0.00" — null when
 *   the value is not finite.
 */
export function formatCoord(value) {
    const t = truncateCoord(value);
    return t == null ? null : t.toFixed(2);
}

/**
 * "(x, y)" — the coordinate pair every perception row uses. Non-finite axes
 * render as "?" (never "undefined"/"null").
 * @param {*} x
 * @param {*} y
 * @returns {string} e.g. "(18.81, -6.79)", "(300.00, 190.00)", "(?, 2.00)"
 */
export function formatPosition(x, y) {
    return `(${formatCoord(x) ?? '?'}, ${formatCoord(y) ?? '?'})`;
}

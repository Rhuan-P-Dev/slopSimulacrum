/**
 * Clean fixture: no rule must fire.
 *
 * Depends on nothing, exports a single pure function. Exists to prove the
 * lint-rules suite has zero false positives on well-formed code.
 *
 * @see test/lint-rules.test.js
 */
export function clamp(value, lo, hi) {
    if (value < lo) {
        return lo;
    }
    if (value > hi) {
        return hi;
    }
    return value;
}

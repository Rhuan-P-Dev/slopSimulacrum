/**
 * CoordFormat — the perception coordinate display rule ("00.00"):
 * truncate (toward zero) to two decimal places, always show two decimals.
 *
 * The rules under test (see shared/CoordFormat.js +
 * wiki/subMDs/systems/perception_system.md):
 *   • 18.81000041279735 → 18.81  (cut at the second decimal, NOT rounded up)
 *   • -6.795872605527817 → -6.79 (truncation toward zero, NOT -6.80)
 *   • 300 → 300 → "300.00" and 0 → "0.00" (always two decimal digits)
 *   • 0.29 (stored as 0.28999999999999998) → 0.29 (float noise must not
 *     push the value across the truncation boundary)
 *   • never "-0.00"; non-finite input → null (the UI renders "?")
 *   • idempotent: truncating an already-truncated value is a no-op (the
 *     server truncates the entry, the client formats again — same result)
 */
import { describe, it, expect } from 'vitest';
import { truncateCoord, formatCoord, formatPosition } from '../../shared/CoordFormat.js';

describe('truncateCoord', () => {
    it('truncates (toward zero) at the second decimal — never rounds', () => {
        expect(truncateCoord(18.81000041279735)).toBe(18.81);
        expect(truncateCoord(-6.795872605527817)).toBe(-6.79);
        expect(truncateCoord(0.999)).toBe(0.99);
        expect(truncateCoord(-0.999)).toBe(-0.99);
        expect(truncateCoord(1.9999)).toBe(1.99);
        expect(truncateCoord(2.5)).toBe(2.5); // already within 2 decimals
    });

    it('keeps values already within 2 decimals, including float-noise ones', () => {
        // 0.29 is stored as 0.28999999999999998 — naive truncation would
        // yield 0.28. The 8-decimal pre-round keeps it 0.29.
        expect(truncateCoord(0.29)).toBe(0.29);
        expect(truncateCoord(0.57)).toBe(0.57);
        expect(truncateCoord(300)).toBe(300);
        expect(truncateCoord(-300)).toBe(-300);
        expect(truncateCoord(-1.5)).toBe(-1.5);
    });

    it('normalizes -0 to 0 (the display rule forbids "-0.00")', () => {
        expect(truncateCoord(-0.001)).toBe(0);
        expect(Object.is(truncateCoord(-0.001), -0)).toBe(false);
        expect(truncateCoord(0)).toBe(0);
    });

    it('returns null for non-finite input (null, undefined, NaN, ±Inf, objects)', () => {
        expect(truncateCoord(null)).toBeNull();
        expect(truncateCoord(undefined)).toBeNull();
        expect(truncateCoord(NaN)).toBeNull();
        expect(truncateCoord(Infinity)).toBeNull();
        expect(truncateCoord(-Infinity)).toBeNull();
        expect(truncateCoord({})).toBeNull();
    });

    it('accepts numeric strings (lenient), like the world-state fields do', () => {
        expect(truncateCoord('18.81000041279735')).toBe(18.81);
    });

    it('is idempotent — re-truncating a truncated value is a no-op', () => {
        for (const v of [18.81000041279735, -6.795872605527817, 0.29, 300, -300, -0.001, 0.999]) {
            const once = truncateCoord(v);
            expect(truncateCoord(once)).toBe(once);
        }
    });
});

describe('formatCoord', () => {
    it('always shows exactly two decimal digits ("00.00")', () => {
        expect(formatCoord(0)).toBe('0.00');
        expect(formatCoord(300)).toBe('300.00');
        expect(formatCoord(0.5)).toBe('0.50');
        expect(formatCoord(18.81000041279735)).toBe('18.81');
        expect(formatCoord(-6.795872605527817)).toBe('-6.79');
    });

    it('never renders "-0.00"', () => {
        expect(formatCoord(-0.001)).toBe('0.00');
    });

    it('returns null for non-finite input (the UI renders "?")', () => {
        expect(formatCoord(null)).toBeNull();
        expect(formatCoord(undefined)).toBeNull();
        expect(formatCoord(NaN)).toBeNull();
    });
});

describe('formatPosition', () => {
    it('renders "(x, y)" with the two-decimal rule per axis', () => {
        expect(formatPosition(3, -4)).toBe('(3.00, -4.00)');
        expect(formatPosition(0, 0)).toBe('(0.00, 0.00)');
        expect(formatPosition(18.81000041279735, -6.795872605527817)).toBe('(18.81, -6.79)');
        expect(formatPosition(300, 190)).toBe('(300.00, 190.00)');
    });

    it('renders "?" for non-finite axes (never "undefined"/"null")', () => {
        expect(formatPosition(undefined, 2)).toBe('(?, 2.00)');
        expect(formatPosition(null, null)).toBe('(?, ?)');
        expect(formatPosition(NaN, 0)).toBe('(?, 0.00)');
    });
});

/**
 * RangeChecker — regression tests for checkPointRange().
 *
 * checkPointRange() is the pure utility that computes whether a target POINT
 * (coordinate) is within range of a source entity. It is the server-side distance
 * primitive used by RangeValidator.checkSpatialRange() to enforce spatial actions
 * (e.g. dropItem).
 *
 * Regression guarded: the original drop-range bug shipped a misleading failure
 * message. This pins that the point-target failure uses the POINT message
 * ("Target is too far away") and NOT the grab-target message
 * ("Item is too far away ... Move closer to grab it.").
 *
 * @module test/unit/RangeChecker.test
 */

import { describe, it, expect } from 'vitest';
import { checkPointRange, checkGrabRange } from '../../src/utils/RangeChecker.js';

// =========================================================================
// FIXTURES
// =========================================================================

/** Source entity at the origin (0,0). */
const SOURCE = { id: 'ent-src', spatial: { x: 0, y: 0 } };

// =========================================================================
// TEST 2 — checkPointRange returns correct distance and message
// =========================================================================

describe('checkPointRange — distance and point-target message', () => {
    it('returns success and correct distance when the point is inside range (distance < maxRange)', () => {
        // (30,40) → distance 50 < 100
        const result = checkPointRange(SOURCE, 30, 40, 100);
        expect(result.success).toBe(true);
        expect(result.distance).toBe(50);
        expect(result.error).toBeUndefined();
    });

    it('returns success when the point is EXACTLY at the boundary (distance === maxRange)', () => {
        // (60,80) → distance 100 === 100. The guard is `distance > maxRange`,
        // so a point exactly at the boundary is ACCEPTED.
        const result = checkPointRange(SOURCE, 60, 80, 100);
        expect(result.success).toBe(true);
        expect(result.distance).toBe(100);
    });

    it('returns success for a point at the origin (distance 0)', () => {
        const result = checkPointRange(SOURCE, 0, 0, 100);
        expect(result.success).toBe(true);
        expect(result.distance).toBe(0);
    });

    it('returns failure when the point is beyond range (distance > maxRange)', () => {
        // (200,0) → distance 200 > 100
        const result = checkPointRange(SOURCE, 200, 0, 100);
        expect(result.success).toBe(false);
        expect(result.distance).toBe(200);
        expect(result.error).toBeDefined();
    });

    it('uses the POINT-target message "Target is too far away" (NOT the grab message)', () => {
        const result = checkPointRange(SOURCE, 200, 0, 100);
        expect(result.error).toContain('Target is too far away');
        // Regression guard: the point message must NOT be the grab-target message.
        expect(result.error).not.toContain('Item is too far away');
        expect(result.error).not.toContain('Move closer to grab it');
    });
});

// =========================================================================
// SANITY — the grab-target message is intentionally DIFFERENT (documents the
// distinction this regression test protects).
// =========================================================================

describe('checkGrabRange — grab-target message (the other branch, for contrast)', () => {
    const TARGET = { id: 'ent-tgt', spatial: { x: 200, y: 0 } };

    it('uses the GRAB message "Item is too far away ... Move closer to grab it." when out of range', () => {
        const result = checkGrabRange(SOURCE, TARGET, 100);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Item is too far away');
        expect(result.error).toContain('Move closer to grab it');
        // And it must NOT be the point message.
        expect(result.error).not.toContain('Target is too far away');
    });
});

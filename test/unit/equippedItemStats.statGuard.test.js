/**
 * Unit tests for the finite-number law on the equipped-item stat store — the twin of
 * test/unit/componentController.statGuard.test.js.
 *
 * WHY. A stat is a stat whichever store holds it. Damage against a worn or held item and
 * the stat consequence both write through here, and a NaN in an item's `existence` drains
 * it out of the panel the same way it did with a body part: permanently, silently, with no
 * event firing (`NaN < 0` is false). The component store refuses; this store now refuses
 * too, so no consequence can pick the softer of the two.
 *
 * @module test/unit/equippedItemStats.statGuard
 */

import { describe, it, expect } from 'vitest';
import EquippedItemStatsController from '../../src/controllers/core/EquippedItemStatsController.js';

/** A registry stub whose one item type carries the numeric stats under test. */
function stubRegistries() {
    return {
        read: () => ({
            probeBlade: { name: 'Probe blade', form: { traits: { Physical: { sharpness: 3, existence: 1 } } } },
        }),
    };
}

/** A controller with one initialized item carrying `existence: 1`, `sharpness: 3`. */
function seeded() {
    const store = new EquippedItemStatsController(stubRegistries());
    store.initializeStats('eq-probe-1', 'item-probe-1', 'probeBlade');
    return store;
}

describe('EquippedItemStatsController refuses a value that is not a finite number', () => {
    describe('updateStatDelta', () => {
        it('refuses NaN and leaves the stored value where it was', () => {
            const store = seeded();
            expect(store.updateStatDelta('eq-probe-1', 'Physical', 'existence', NaN)).toBe(false);
            expect(store.getStats('eq-probe-1').Physical.existence).toBe(1);
        });

        it('refuses a string delta — what an unresolved placeholder hands over', () => {
            const store = seeded();
            expect(store.updateStatDelta('eq-probe-1', 'Physical', 'existence', '50/2')).toBe(false);
            expect(store.getStats('eq-probe-1').Physical.existence).toBe(1);
        });

        it('refuses Infinity and undefined', () => {
            const store = seeded();
            expect(store.updateStatDelta('eq-probe-1', 'Physical', 'existence', Infinity)).toBe(false);
            expect(store.updateStatDelta('eq-probe-1', 'Physical', 'existence', undefined)).toBe(false);
            expect(store.getStats('eq-probe-1').Physical.existence).toBe(1);
        });

        it('still applies a finite delta (the untouched path)', () => {
            const store = seeded();
            expect(store.updateStatDelta('eq-probe-1', 'Physical', 'sharpness', -0.5)).toBe(true);
            expect(store.getStats('eq-probe-1').Physical.sharpness).toBe(2.5);
        });
    });

    describe('updateStat', () => {
        it('refuses a NaN value and leaves the stored value where it was', () => {
            const store = seeded();
            expect(store.updateStat('eq-probe-1', 'Physical', 'existence', NaN)).toBe(false);
            expect(store.getStats('eq-probe-1').Physical.existence).toBe(1);
        });

        it('still sets a finite number', () => {
            const store = seeded();
            expect(store.updateStat('eq-probe-1', 'Physical', 'existence', 0.25)).toBe(true);
            expect(store.getStats('eq-probe-1').Physical.existence).toBe(0.25);
        });
    });
});

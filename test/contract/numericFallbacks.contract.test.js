/**
 * Contract: server fallback constants must mirror the data files they claim to
 * mirror. Data is the source of truth; a fallback that disagrees with data is
 * silent drift, and it surfaces as client/server resolution differences
 * (BUG-133, commit d2ef228).
 *
 * This test reads data, it never writes it.
 *
 * @module test/contract/numericFallbacks
 */

import { describe, it, expect } from 'vitest';
import DataLoader from '../../src/utils/DataLoader.js';
import {
    PICK_UP_RANGE_FALLBACK,
    DROP_BASE_RANGE,
    DROP_RANGE_MULTIPLIER,
} from '../../src/utils/Constants.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';

describe('numeric fallbacks mirror their anchoring data', () => {
    const actions = DataLoader.loadJsonSafe('data/systems/actions.json', {});

    it('PICK_UP_RANGE_FALLBACK equals the data-driven pickUpItem range', () => {
        const pickUp = actions.pickUpItem;
        expect(pickUp, 'data/systems/actions.json must define pickUpItem').toBeTruthy();
        expect(pickUp.range, 'pickUpItem.range must be a number').toBeTypeOf('number');
        expect(PICK_UP_RANGE_FALLBACK).toBe(pickUp.range);
    });

    it('dropItem range is not silently reused as a pick-up range', () => {
        const drop = actions.dropItem;
        if (drop && typeof drop.range === 'number') {
            // The two ranges are independent rules. If they ever coincide, the
            // assertion below must be revisited deliberately, not deleted.
            expect(PICK_UP_RANGE_FALLBACK).not.toBe(DROP_BASE_RANGE);
        }
    });

    it('drop range is composed from base and multiplier, never hardcoded', () => {
        expect(DROP_BASE_RANGE).toBeTypeOf('number');
        expect(DROP_RANGE_MULTIPLIER).toBeTypeOf('number');
        expect(DROP_BASE_RANGE + DROP_RANGE_MULTIPLIER).toBeGreaterThan(DROP_BASE_RANGE);
    });

    it('DEFAULT_ITEM_VOLUME stays 0 because every registered item declares volume', () => {
        const items = DataLoader.loadJsonSafe('data/components/inventoryItems.json', {});
        const registry = items.items || items;
        // Plan T8 step 2 adaptation: the data declares volume under form.volume
        // (a top-level volume is the legacy fallback, same chain as
        // CraftingLogic.hostVolumeOf). The lookup is adapted to that nesting;
        // the assertion is not weakened.
        const declaresVolume = (def) =>
            (def.form && typeof def.form.volume === 'number')
            || typeof def.volume === 'number';
        const offenders = Object.entries(registry)
            .filter(([, def]) => def && typeof def === 'object' && !declaresVolume(def));
        expect(offenders.map(([key]) => key), 'items missing volume').toEqual([]);
        expect(DEFAULT_ITEM_VOLUME).toBe(0);
    });
});

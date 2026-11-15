/**
 * Unit tests for the stat-write guard: a value that is not a finite number never enters
 * the world.
 *
 * WHY. A NaN in a component stat is permanent and silent: `NaN + x` is NaN forever, the
 * part stops satisfying `existence > 0` (so it stays a valid target yet is never
 * destroyable), and the damage listener never fires because `NaN < 0` is false. That is
 * how one unsupported damage expression in one action file left a droid's body part
 * rendering as `null` in the panel with no broken-part event anywhere. Both writes here
 * are the choke point every mover of a stat passes through (damage, stat effects and
 * their removal, organ contributions, holding cost, corrosion ticks), so they refuse.
 *
 * @module test/unit/componentController.statGuard
 */

import { describe, it, expect } from 'vitest';
import ComponentController from '../../src/controllers/core/componentController.js';

/**
 * A controller over a stub statsController that deep-merges writes into the stats object
 * the way the real one does, so a refusal can be pinned as "the stored value did not
 * move" rather than as "no call happened".
 * @param {object} stats the stats one component instance reports
 * @returns {{ cc: ComponentController, stats: object }} the controller and live stats
 */
function makeController(stats) {
    const statsController = {
        getStats: () => structuredClone(stats),
        setStats: (instanceId, patch) => {
            for (const [traitId, values] of Object.entries(patch)) {
                stats[traitId] = { ...(stats[traitId] || {}), ...values };
            }
        },
    };
    return { cc: new ComponentController(statsController, {}, {}), stats };
}

describe('ComponentController refuses a stat value that is not a finite number', () => {
    describe('updateComponentStatDelta (the choke point)', () => {
        it('refuses NaN and leaves the stored value where it was', () => {
            const { cc, stats } = makeController({ Physical: { existence: 0.666 } });
            expect(cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', NaN)).toBe(false);
            expect(stats.Physical.existence).toBe(0.666);
        });

        it('refuses a string delta — what an unresolved placeholder hands over', () => {
            const { cc, stats } = makeController({ Physical: { existence: 1 } });
            expect(cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', '50/2')).toBe(false);
            expect(stats.Physical.existence).toBe(1);
        });

        it('refuses undefined and Infinity', () => {
            const { cc, stats } = makeController({ Physical: { existence: 1 } });
            expect(cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', undefined)).toBe(false);
            expect(cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', Infinity)).toBe(false);
            expect(stats.Physical.existence).toBe(1);
        });

        it('still works after a refusal: a later finite delta lands on the original value', () => {
            const { cc, stats } = makeController({ Physical: { existence: 1 } });
            cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', NaN);
            expect(cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', -0.334)).toBe(true);
            expect(stats.Physical.existence).toBeCloseTo(0.666, 10); // not NaN
        });

        it('refuses the relative form when the factor makes a non-finite delta', () => {
            const { cc, stats } = makeController({ Physical: { existence: 1 } });
            expect(cc.updateComponentStatRelative('comp-1', 'Physical', 'existence', NaN)).toBe(false);
            expect(stats.Physical.existence).toBe(1);
        });
    });

    describe('updateComponentStat (the semantic SET)', () => {
        it('refuses a NaN value and leaves the stored value where it was', () => {
            const { cc, stats } = makeController({ Physical: { existence: 1 } });
            expect(cc.updateComponentStat('comp-1', 'Physical', 'existence', NaN)).toBe(false);
            expect(stats.Physical.existence).toBe(1);
        });

        it('still sets a finite number and a non-number value', () => {
            // A SET takes any value by contract (strings, objects); only a NON-FINITE
            // NUMBER is refused, so this guard cannot break a legitimate writer.
            const { cc, stats } = makeController({ Physical: { existence: 1 } });
            expect(cc.updateComponentStat('comp-1', 'Physical', 'existence', 0.5)).toBe(true);
            expect(cc.updateComponentStat('comp-1', 'Meta', 'mode', 'idle')).toBe(true);
            expect(stats.Physical.existence).toBe(0.5);
            expect(stats.Meta.mode).toBe('idle');
        });
    });

    describe('the damage listener', () => {
        it('does not fire on a refusal', () => {
            const { cc } = makeController({ Physical: { existence: 1 } });
            let fired = 0;
            cc.registerDamageListener(() => { fired += 1; });
            cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', NaN);
            expect(fired).toBe(0);
        });

        it('still fires on a real weakening', () => {
            const { cc } = makeController({ Physical: { existence: 1 } });
            let fired = 0;
            cc.registerDamageListener(() => { fired += 1; });
            expect(cc.updateComponentStatDelta('comp-1', 'Physical', 'existence', -0.5)).toBe(true);
            expect(fired).toBe(1);
        });
    });
});

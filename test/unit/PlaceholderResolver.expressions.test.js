/**
 * Unit tests for the arithmetic a placeholder may carry (CR DATA-6: a rule stated in
 * the data language is a rule the tests must pin).
 *
 * WHY THIS FILE EXISTS. The grammar used to be `*N` with an integer `N`, and an
 * expression the resolver did not recognise did not fail — it fell through to a
 * template substitution. `":Physical.strength/2"` therefore resolved to the STRING
 * `"50/2"`; every consumer doing arithmetic on it got NaN, and a NaN written into a
 * component stat is permanent and silent (the part stops satisfying `existence > 0`,
 * the damage listener never fires because `NaN < 0` is false). One typo in one action
 * file turned a droid's body part into a `null` in the panel.
 *
 * Two halves are pinned here: the expressions the language now accepts — including
 * the fractional ones that caused the bug — and the fact that NOTHING this module
 * returns is a non-finite number: an expression it cannot compute is left as its own
 * text, so the consumer's own guard is what refuses it.
 *
 * @module test/unit/PlaceholderResolver.expressions
 */

import { describe, it, expect } from 'vitest';
import { resolvePlaceholders } from '../../src/utils/PlaceholderResolver.js';

/** A resolution context with the shapes real consequence params use. */
function makeContext() {
    return {
        'Physical.strength': 100,
        'Physical.sharpness': 3,
        'Physical.existence': 0.666,
        'Manipulation.fine_controls': 0,
        entityId: 'droid-1',
        itemType: 'hand',
    };
}

describe('PlaceholderResolver — the arithmetic suffix', () => {
    it('resolves a bare placeholder and a leading sign (the untouched grammar)', () => {
        const ctx = makeContext();
        expect(resolvePlaceholders(':Physical.strength', ctx)).toBe(100);
        expect(resolvePlaceholders('-:Physical.strength', ctx)).toBe(-100);
    });

    it('resolves integer multipliers (the untouched grammar)', () => {
        const ctx = makeContext();
        expect(resolvePlaceholders(':Physical.strength*2', ctx)).toBe(200);
        expect(resolvePlaceholders('-:Physical.strength*3', ctx)).toBe(-300);
    });

    it('resolves a FRACTIONAL multiplier, not just an integer one', () => {
        // The old grammar read `*0.5` as `*0` plus leftovers, so the half a mod author
        // wrote was not the half the world got.
        const ctx = makeContext();
        expect(resolvePlaceholders(':Physical.strength*0.5', ctx)).toBe(50);
        expect(resolvePlaceholders(':Physical.sharpness*0.25', ctx)).toBe(0.75);
        expect(resolvePlaceholders('-:Physical.strength*0.5', ctx)).toBe(-50);
    });

    it('resolves a DIVISOR to a number (the expression that caused the reported bug)', () => {
        const ctx = makeContext();
        const halved = resolvePlaceholders(':Physical.strength/2', ctx);
        expect(halved).toBe(50);
        expect(typeof halved).toBe('number'); // the bug: the STRING "100/2"
        expect(resolvePlaceholders(':Physical.sharpness/2', ctx)).toBe(1.5);
        expect(resolvePlaceholders('-:Physical.strength/4', ctx)).toBe(-25);
        expect(resolvePlaceholders(':Physical.strength/-2', ctx)).toBe(-50);
        expect(resolvePlaceholders(':Physical.existence/0.5', ctx)).toBeCloseTo(1.332, 10);
    });

    it('refuses a divisor of zero instead of handing back Infinity', () => {
        const ctx = makeContext();
        const resolved = resolvePlaceholders(':Physical.strength/0', ctx);
        expect(resolved).toBe(':Physical.strength/0'); // left as its own text, never a value
    });

    it('leaves an unknown stat as its own text (a stat the actor does not have)', () => {
        // The other half of the reported bug: `:Physical.armor` is not a stat, so the
        // text survives and the consumer must refuse it. The resolver does not invent 0.
        expect(resolvePlaceholders(':Physical.armor', makeContext())).toBe(':Physical.armor');
        expect(resolvePlaceholders(':Physical.armor/2', makeContext())).toBe(':Physical.armor/2');
    });

    it('never returns a non-finite number for any expression over a real stat', () => {
        const ctx = makeContext();
        for (const expr of [
            ':Physical.strength', ':Physical.strength*2', ':Physical.strength*0.5',
            ':Physical.strength/2', ':Physical.strength/0', ':Physical.strength/-1',
            '-:Physical.strength/3', ':Physical.existence/0.001',
        ]) {
            const resolved = resolvePlaceholders(expr, ctx);
            if (typeof resolved === 'number') {
                expect(Number.isFinite(resolved)).toBe(true);
            } else {
                expect(resolved).toBe(expr);
            }
        }
    });

    it('carries the same grammar into a template string (one dialect, not two)', () => {
        const ctx = makeContext();
        expect(resolvePlaceholders('dealt :Physical.strength/2 damage', ctx)).toBe('dealt 50 damage');
        expect(resolvePlaceholders('x :Physical.strength*0.5 y', ctx)).toBe('x 50 y');
        expect(resolvePlaceholders("Item ':itemType' dropped", ctx)).toBe("Item 'hand' dropped");
    });

    it('leaves a template alone when the embedded placeholder is unknown', () => {
        expect(resolvePlaceholders(':entityName (:entityId)', { entityId: 'droid-1' }))
            .toBe(':entityName (droid-1)');
    });

    it('resolves a non-number placeholder to its text, with or without a suffix', () => {
        const ctx = makeContext();
        expect(resolvePlaceholders(':itemType', ctx)).toBe('hand');
        expect(resolvePlaceholders(':itemType*2', ctx)).toBe('hand');
    });

    it('resolves the suffix through nested params, as a consequence dispatches them', () => {
        const resolved = resolvePlaceholders(
            { channel: 'heat', value: ':Physical.strength/2', nested: { amount: ':Physical.sharpness*0.5' } },
            makeContext()
        );
        expect(resolved).toEqual({ channel: 'heat', value: 50, nested: { amount: 1.5 } });
    });

    it('passes a bare numeric literal through untouched (the data language is not required)', () => {
        const ctx = makeContext();
        expect(resolvePlaceholders(2, ctx)).toBe(2);
        expect(resolvePlaceholders(0.5, ctx)).toBe(0.5);
    });

    it('leaves a literal fraction-looking string as text (no placeholder, no math)', () => {
        // `"50/2"` in a data file is a string, not an expression. The damage path refuses
        // it (pinned by test/contract/damageValuePoison.contract.test.js); the resolver
        // does not silently invent a number for it.
        expect(resolvePlaceholders('50/2', makeContext())).toBe('50/2');
    });
});

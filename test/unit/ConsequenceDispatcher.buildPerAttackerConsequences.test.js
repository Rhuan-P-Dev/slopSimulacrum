/**
 * UNIT test for ConsequenceDispatcher._buildPerAttackerConsequences.
 *
 * BUG-133: the method was written for the legacy stat-delta model and silently
 * dropped the `channel` field of the modern channel-damage model. This test
 * verifies:
 *
 * 1. Channel-model actions (declaring `channel` in params) produce consequences
 *    that preserve the `channel` and carry a POSITIVE `value` (the channel-loss
 *    formula clamps negative to zero — a negative value means zero damage).
 *
 * 2. The channel-model `value` is resolved PER ATTACKER from the declared
 *    placeholder via the same PlaceholderResolver/requirementValues mechanism the
 *    single-attacker execute() path uses: a non-strength stat reference (e.g.
 *    ':Physical.sharpness') resolves to that stat's own value, NOT to strength —
 *    so a channel action is scaled by its declared stat, not unconditionally by
 *    strength. A declared value that cannot be resolved to a finite number falls
 *    back to strength (the documented limitation that keeps the model total).
 *
 * 3. Legacy stat-delta actions (declaring `trait`/`stat` in params) produce the
 *    unchanged legacy shape with a negative value (additive delta semantics).
 *
 * The method's second argument is the per-attacker flat 'Trait.stat' → number stat
 * context (see _flattenStatsToTraitStatMap) — the same shape requirementValues has
 * on the single-attacker path.
 *
 * @module test/unit/ConsequenceDispatcher.buildPerAttackerConsequences
 */

import { describe, it, expect } from 'vitest';
import ConsequenceDispatcher from '../../src/controllers/consequences/ConsequenceDispatcher.js';

/**
 * Creates a minimal ConsequenceDispatcher instance for unit testing.
 * The methods under test are pure — they read only from their arguments, not from
 * the controller's injected dependencies.
 */
function makeDispatcher() {
    // actionController and synergyController are not accessed by _buildPerAttackerConsequences
    return new ConsequenceDispatcher(
        { actionRegistry: {} }, // minimal actionController
        null                    // no synergyController needed
    );
}

/** A per-attacker stat context carrying only the strength the method needs for the punch case. */
const STRENGTH_ONLY = { 'Physical.strength': 42 };

describe('ConsequenceDispatcher._buildPerAttackerConsequences', () => {
    const dispatcher = makeDispatcher();

    describe('channel-model actions (modern DAMAGE_CHANNELS model)', () => {
        const punchAction = {
            consequences: [
                {
                    type: 'damageComponent',
                    target: 'target',
                    params: {
                        channel: 'impact',
                        value: ':Physical.strength'
                    }
                },
                {
                    type: 'dropMaterialChunk',
                    target: 'target'
                },
                {
                    type: 'log',
                    target: 'self',
                    level: 'info',
                    message: 'Droid performed a punch dealing :Physical.strength impact damage!'
                }
            ]
        };

        it('preserves the channel field in emitted damageComponent params', () => {
            const result = dispatcher._buildPerAttackerConsequences(punchAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage, 'damageComponent consequence should be present').toBeTruthy();
            expect(damage.params.channel, 'channel should be preserved').toBe('impact');
        });

        it('resolves the declared strength placeholder to a POSITIVE value (channel-loss formula requires positive input)', () => {
            const result = dispatcher._buildPerAttackerConsequences(punchAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.value, 'value should equal the attacker strength (positive)').toBe(42);
            expect(damage.params.value).toBeGreaterThan(0);
        });

        it('does NOT emit legacy trait/stat fields on channel-model consequences', () => {
            const result = dispatcher._buildPerAttackerConsequences(punchAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.trait, 'legacy trait should not be present on channel-model consequences').toBeUndefined();
            expect(damage.params.stat, 'legacy stat should not be present on channel-model consequences').toBeUndefined();
        });

        it('emits exactly the channel and value keys (no extra fields that could confuse the handler)', () => {
            const result = dispatcher._buildPerAttackerConsequences(punchAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            // Only channel and value should be in params — no trait, stat, or other legacy fields.
            const keys = Object.keys(damage.params).sort();
            expect(keys).toEqual(['channel', 'value']);
        });

        // Non-strength stat reference: the declared value placeholder must resolve to the
        // attacker's own value for THAT stat, not to strength (BUG-133 audit M2 — a
        // channel action is scaled by its declared stat, not unconditionally by strength).
        it('resolves a NON-strength placeholder (e.g. :Physical.sharpness) from the attacker stat, not strength', () => {
            const cutAction = {
                consequences: [
                    {
                        type: 'damageComponent',
                        target: 'target',
                        params: {
                            channel: 'cut',
                            value: ':Physical.sharpness'
                        }
                    }
                ]
            };
            // The attacker has sharpness 7 but strength 42 — a strength-scaled assumption
            // would (silently) yield 42; the correct per-attacker resolution yields 7.
            const context = { 'Physical.strength': 42, 'Physical.sharpness': 7 };
            const result = dispatcher._buildPerAttackerConsequences(cutAction, context);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage, 'damageComponent consequence should be present').toBeTruthy();
            expect(damage.params.channel, 'channel should be preserved from the data (not hardcoded)').toBe('cut');
            expect(damage.params.value, 'value should resolve to the attacker sharpness, not strength').toBe(7);
            expect(damage.params.value).not.toBe(42);
        });

        // Totality fallback: a declared value that does not resolve to a finite number
        // (an unknown stat / :variable) falls back to the attacker's resolved strength,
        // keeping the channel model total (documented in the method JSDoc).
        it('falls back to strength when the declared value does not resolve to a finite number', () => {
            const unknownStatAction = {
                consequences: [
                    {
                        type: 'damageComponent',
                        target: 'target',
                        params: {
                            channel: 'impact',
                            value: ':Some.unknown_stat'
                        }
                    }
                ]
            };
            const result = dispatcher._buildPerAttackerConsequences(unknownStatAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.value, 'unresolvable value falls back to the attacker strength').toBe(42);
        });
    });

    describe('legacy stat-delta actions (no channel — back-compat)', () => {
        const legacyAction = {
            consequences: [
                {
                    type: 'damageComponent',
                    target: 'target',
                    params: {
                        trait: 'Physical',
                        stat: 'existence',
                        value: ':Physical.strength'
                    }
                }
            ]
        };

        it('preserves the trait/stat fields for legacy actions', () => {
            const result = dispatcher._buildPerAttackerConsequences(legacyAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.trait).toBe('Physical');
            expect(damage.params.stat).toBe('existence');
        });

        it('emits a NEGATIVE value (additive delta semantics for legacy model)', () => {
            const result = dispatcher._buildPerAttackerConsequences(legacyAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.value, 'legacy model uses negative value').toBe(-42);
        });

        it('does NOT emit a channel field on legacy actions', () => {
            const result = dispatcher._buildPerAttackerConsequences(legacyAction, STRENGTH_ONLY);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.channel).toBeUndefined();
        });
    });

    describe('non-damageComponent consequences', () => {
        it('passes through non-damageComponent consequences unchanged', () => {
            const action = {
                consequences: [
                    { type: 'dropMaterialChunk', target: 'target' },
                    { type: 'log', target: 'self', params: { message: 'hello' }, level: 'info' }
                ]
            };

            const result = dispatcher._buildPerAttackerConsequences(action, STRENGTH_ONLY);

            // dropMaterialChunk should pass through unchanged
            expect(result[0]).toEqual({ type: 'dropMaterialChunk', target: 'target' });

            // log with params should be rebuilt with the message
            expect(result[1].type).toBe('log');
            expect(result[1].params.message).toBe('hello');
        });
    });
});

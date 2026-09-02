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
 * 2. Legacy stat-delta actions (declaring `trait`/`stat` in params) produce the
 *    unchanged legacy shape with a negative value (additive delta semantics).
 *
 * @module test/unit/ConsequenceDispatcher.buildPerAttackerConsequences
 */

import { describe, it, expect } from 'vitest';
import ConsequenceDispatcher from '../../src/controllers/consequences/ConsequenceDispatcher.js';

/**
 * Creates a minimal ConsequenceDispatcher instance for unit testing.
 * The method under test (_buildPerAttackerConsequences) is pure — it reads
 * only from its arguments, not from the controller's injected dependencies.
 */
function makeDispatcher() {
    // actionController and synergyController are not accessed by _buildPerAttackerConsequences
    return new ConsequenceDispatcher(
        { actionRegistry: {} }, // minimal actionController
        null                    // no synergyController needed
    );
}

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
            const result = dispatcher._buildPerAttackerConsequences(punchAction, 42);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage, 'damageComponent consequence should be present').toBeTruthy();
            expect(damage.params.channel, 'channel should be preserved').toBe('impact');
        });

        it('emits a POSITIVE value (the channel-loss formula requires positive input)', () => {
            const result = dispatcher._buildPerAttackerConsequences(punchAction, 42);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.value, 'value should equal the attacker strength (positive)').toBe(42);
            expect(damage.params.value).toBeGreaterThan(0);
        });

        it('does NOT emit legacy trait/stat fields on channel-model consequences', () => {
            const result = dispatcher._buildPerAttackerConsequences(punchAction, 42);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.trait, 'legacy trait should not be present on channel-model consequences').toBeUndefined();
            expect(damage.params.stat, 'legacy stat should not be present on channel-model consequences').toBeUndefined();
        });

        it('emits exactly the channel and value keys (no extra fields that could confuse the handler)', () => {
            const result = dispatcher._buildPerAttackerConsequences(punchAction, 42);
            const damage = result.find(r => r.type === 'damageComponent');

            // Only channel and value should be in params — no trait, stat, or other legacy fields.
            const keys = Object.keys(damage.params).sort();
            expect(keys).toEqual(['channel', 'value']);
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
            const result = dispatcher._buildPerAttackerConsequences(legacyAction, 42);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.trait).toBe('Physical');
            expect(damage.params.stat).toBe('existence');
        });

        it('emits a NEGATIVE value (additive delta semantics for legacy model)', () => {
            const result = dispatcher._buildPerAttackerConsequences(legacyAction, 42);
            const damage = result.find(r => r.type === 'damageComponent');

            expect(damage.params.value, 'legacy model uses negative value').toBe(-42);
        });

        it('does NOT emit a channel field on legacy actions', () => {
            const result = dispatcher._buildPerAttackerConsequences(legacyAction, 42);
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

            const result = dispatcher._buildPerAttackerConsequences(action, 42);

            // dropMaterialChunk should pass through unchanged
            expect(result[0]).toEqual({ type: 'dropMaterialChunk', target: 'target' });

            // log with params should be rebuilt with the message
            expect(result[1].type).toBe('log');
            expect(result[1].params.message).toBe('hello');
        });
    });
});

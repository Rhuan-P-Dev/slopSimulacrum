/**
 * WorldRulesController — unit test: validator matrix.
 *
 * The controller is a pure data owner: it takes a registry object (the result of
 * DataLoader.loadJsonSafe) in its constructor and validates it. Tests exercise
 * the validation semantics from spec §WR-1/WR-5 directly, without a full world.
 *
 *   - Valid rule: getRule('damageTornMaterial') returns a copy with percent/enabled
 *   - Unknown key: getRule('foo') → null, no crash
 *   - Malformed rule (percent not a number): rule disabled, others unaffected
 *   - Missing/empty/invalid file: all rules off, no throw
 *   - Percent bounds: 0 ≤ percent ≤ 100 (out-of-range → disabled)
 *
 * @module test/unit/WorldRulesController
 */

import { describe, it, expect, vi } from 'vitest';
import Logger from '../../src/utils/Logger.js';
import WorldRulesController from '../../src/controllers/worldRules/WorldRulesController.js';

describe('WorldRulesController — validator matrix', () => {
    describe('valid rule', () => {
        it('returns a copy of the rule config when valid', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 10, enabled: true }
                }
            };
            const controller = new WorldRulesController(registry);
            const rule = controller.getRule('damageTornMaterial');
            expect(rule).toEqual({ percent: 10, enabled: true });
        });

        it('returns a defensive copy (mutating the copy does not affect the registry)', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 10, enabled: true }
                }
            };
            const controller = new WorldRulesController(registry);
            const rule1 = controller.getRule('damageTornMaterial');
            rule1.percent = 999;
            const rule2 = controller.getRule('damageTornMaterial');
            expect(rule2.percent).toBe(10);
        });

        it('getDamageTornMaterialPercent() returns the active percent', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 15, enabled: true }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getDamageTornMaterialPercent()).toBe(15);
        });
    });

    describe('unknown key', () => {
        it('returns null for an unknown rule key', () => {
            const registry = { rules: { damageTornMaterial: { percent: 10 } } };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('nonexistentRule')).toBeNull();
        });

        it('unknown keys in the file are ignored (forward compatibility)', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 10 },
                    futureRule: { whatever: true }
                }
            };
            // Should not throw; the unknown rule is simply not stored or accessible.
            const controller = new WorldRulesController(registry);
            // The known rule is still active and unaffected by the unknown key.
            expect(controller.getRule('damageTornMaterial')).toEqual({ percent: 10, enabled: true });
            // The unknown rule is not accessible (returns null).
            expect(controller.getRule('futureRule')).toBeNull();
        });
    });

    describe('malformed rule', () => {
        it('percent not a number → rule disabled (getRule returns null)', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 'ten' }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
            expect(controller.getDamageTornMaterialPercent()).toBe(0);
        });

        it('percent out of range (>100) → rule disabled', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 150 }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });

        it('percent out of range (<0) → rule disabled', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: -5 }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });

        it('enabled: false → rule disabled', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 10, enabled: false }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
            expect(controller.getDamageTornMaterialPercent()).toBe(0);
        });

        it('malformed rule config does not affect the overall registry (no throw)', () => {
            // With only one known key, "other rules" means: the registry as a whole
            // still loads, other keys don't crash, and the malformed known rule is off.
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 'bad' },
                    someOtherKnownOrUnknownKey: { percent: 20 }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
            expect(controller.getDamageTornMaterialPercent()).toBe(0);
            // The registry itself is intact — other rule lookups return null gracefully.
            expect(controller.getRule('someOtherKnownOrUnknownKey')).toBeNull();
        });

        it('init summary counts only ACTIVE rules (a malformed rule does not inflate the active count)', () => {
            const infoSpy = vi.spyOn(Logger, 'info');
            try {
                new WorldRulesController({ rules: { damageTornMaterial: { percent: 'bad' } } });
                const summary = infoSpy.mock.calls
                    .map((call) => call[0])
                    .find((line) => typeof line === 'string' && line.includes('rule(s) active'));
                expect(summary, 'the init summary line should be logged at construction').toBeDefined();
                expect(summary).toMatch(/0\/1 rule\(s\) active \(none\)/);
            } finally {
                infoSpy.mockRestore();
            }
        });
    });

    describe('missing / empty / malformed file', () => {
        it('empty registry ({}) → all rules off, no throw', () => {
            const controller = new WorldRulesController({});
            expect(controller.getRule('damageTornMaterial')).toBeNull();
            expect(controller.getDamageTornMaterialPercent()).toBe(0);
        });

        it('registry without rules key → all rules off', () => {
            const controller = new WorldRulesController({ someOtherKey: true });
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });

        it('registry with rules: null → all rules off', () => {
            const controller = new WorldRulesController({ rules: null });
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });

        it('registry with rules: "string" (top-level malformed) → all rules off, no throw', () => {
            const controller = new WorldRulesController({ rules: 'not an object' });
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });

        it('registry with rules: [] → all rules off', () => {
            const controller = new WorldRulesController({ rules: [] });
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });

        it('null registry → all rules off', () => {
            const controller = new WorldRulesController(null);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });

        it('undefined registry → all rules off', () => {
            const controller = new WorldRulesController(undefined);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
        });
    });

    describe('percent bounds', () => {
        it('percent: 0 is valid (rule off by design, drops nothing)', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 0, enabled: true }
                }
            };
            const controller = new WorldRulesController(registry);
            // percent=0 is a valid value but means "rule off by design" — the
            // controller stores null for it; getDamageTornMaterialPercent returns 0.
            const rule = controller.getRule('damageTornMaterial');
            expect(rule).toBeNull();
            expect(controller.getDamageTornMaterialPercent()).toBe(0);
        });

        it('percent: 100 is valid (boundary)', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 100, enabled: true }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('damageTornMaterial')).toEqual({ percent: 100, enabled: true });
            expect(controller.getDamageTornMaterialPercent()).toBe(100);
        });

        it('missing percent (required field absent) → rule off', () => {
            // percent is a required field: if absent, the rule is disabled with a warn.
            const registry = {
                rules: {
                    damageTornMaterial: { enabled: true }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getRule('damageTornMaterial')).toBeNull();
            expect(controller.getDamageTornMaterialPercent()).toBe(0);
        });
    });
});

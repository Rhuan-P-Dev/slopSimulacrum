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
                // 2 known keys since energyFlow shipped (the count is the known-key set size).
                expect(summary).toMatch(/0\/2 rule\(s\) active \(none\)/);
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

    describe('onDamage event rule (validator matrix)', () => {
        it('valid entry: getOnDamageRules() returns a deep copy; mutating the copy does not affect the registry', () => {
            const registry = {
                rules: {
                    onDamage: [{ drop: 'host_material', percentage: 0.05 }]
                }
            };
            const controller = new WorldRulesController(registry);
            const entries = controller.getOnDamageRules();
            expect(entries).toEqual([{ drop: 'host_material', percentage: 0.05 }]);
            // Mutate the returned copy: the registry must be unaffected.
            entries[0].percentage = 0.99;
            expect(controller.getOnDamageRules()).toEqual([{ drop: 'host_material', percentage: 0.05 }]);
        });

        it('file without onDamage → [] (backward compat with pre-onDamage files)', () => {
            const registry = {
                rules: {
                    damageTornMaterial: { percent: 10, enabled: true }
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getOnDamageRules()).toEqual([]);
        });

        it('onDamage not an array (object / string / number / null) → [], no throw', () => {
            for (const bad of [{ drop: 'host_material', percentage: 0.5 }, 'oops', 42, null]) {
                const controller = new WorldRulesController({ rules: { onDamage: bad } });
                expect(controller.getOnDamageRules()).toEqual([]);
            }
        });

        it('non-object entries (string / number / null / array) are skipped, valid siblings kept (E1)', () => {
            const registry = {
                rules: {
                    onDamage: [
                        'junk',
                        7,
                        null,
                        [1, 2, 3],
                        { drop: 'host_material', percentage: 0.05 }
                    ]
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getOnDamageRules()).toEqual([{ drop: 'host_material', percentage: 0.05 }]);
        });

        it('entry drop missing / non-string / unknown token → skipped (E2), valid siblings kept', () => {
            const registry = {
                rules: {
                    onDamage: [
                        { percentage: 0.5 },
                        { drop: 42, percentage: 0.5 },
                        { drop: 'acid', percentage: 0.5 },
                        { drop: 'host_material', percentage: 0.05 }
                    ]
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getOnDamageRules()).toEqual([{ drop: 'host_material', percentage: 0.05 }]);
        });

        it('entry percentage missing / non-numeric / NaN / 1.5 / -0.1 → skipped (E3); 0 and 1 accepted (boundary)', () => {
            const registry = {
                rules: {
                    onDamage: [
                        { drop: 'host_material' },
                        { drop: 'host_material', percentage: '0.5' },
                        { drop: 'host_material', percentage: NaN },
                        { drop: 'host_material', percentage: 1.5 },
                        { drop: 'host_material', percentage: -0.1 },
                        { drop: 'host_material', percentage: 0 },
                        { drop: 'host_material', percentage: 1 }
                    ]
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getOnDamageRules()).toEqual([
                { drop: 'host_material', percentage: 0 },
                { drop: 'host_material', percentage: 1 }
            ]);
        });

        it('unknown extra field on a valid entry → ignored (stored normalized)', () => {
            const registry = {
                rules: {
                    onDamage: [{ drop: 'host_material', percentage: 0.05, futureField: true }]
                }
            };
            const controller = new WorldRulesController(registry);
            expect(controller.getOnDamageRules()).toEqual([{ drop: 'host_material', percentage: 0.05 }]);
        });

        it('malformed onDamage leaves getDamageTornMaterialPercent() intact — and vice versa (key independence)', () => {
            // Malformed onDamage must not hurt the torn rule.
            const c1 = new WorldRulesController({
                rules: {
                    damageTornMaterial: { percent: 10, enabled: true },
                    onDamage: { drop: 'host_material', percentage: 0.05 } // not an array
                }
            });
            expect(c1.getDamageTornMaterialPercent()).toBe(10);
            expect(c1.getOnDamageRules()).toEqual([]);

            // Malformed torn rule must not hurt onDamage.
            const c2 = new WorldRulesController({
                rules: {
                    damageTornMaterial: { percent: 'bad' },
                    onDamage: [{ drop: 'host_material', percentage: 0.05 }]
                }
            });
            expect(c2.getDamageTornMaterialPercent()).toBe(0);
            expect(c2.getOnDamageRules()).toEqual([{ drop: 'host_material', percentage: 0.05 }]);
        });

        it('degradation: null registry / rules missing / rules empty → onDamage [] AND torn percent 0, no throw', () => {
            const cases = [null, undefined, { someKey: true }, { rules: null }, { rules: {} }];
            for (const raw of cases) {
                const controller = new WorldRulesController(raw);
                expect(controller.getOnDamageRules()).toEqual([]);
                expect(controller.getDamageTornMaterialPercent()).toBe(0);
            }
        });

        it('summary line keeps the unanchored "X/Y rule(s) active" prefix and reports the event clause', () => {
            const infoSpy = vi.spyOn(Logger, 'info');
            try {
                new WorldRulesController({
                    rules: {
                        damageTornMaterial: { percent: 10, enabled: true },
                        onDamage: [{ drop: 'host_material', percentage: 0.05 }]
                    }
                });
                const summary = infoSpy.mock.calls
                    .map((call) => call[0])
                    .find((line) => typeof line === 'string' && line.includes('rule(s) active'));
                expect(summary, 'the init summary line should be logged at construction').toBeDefined();
                // The scalar-rule prefix must remain verbatim (existing tests depend on it).
                // 2 known keys since energyFlow shipped (the count is the known-key set size).
                expect(summary).toMatch(/1\/2 rule\(s\) active \(damageTornMaterial\)/);
                // The event clause is appended after the rule clause.
                expect(summary).toMatch(/events: onDamage 1 entr\(y\/ies\) active/);
            } finally {
                infoSpy.mockRestore();
            }
        });
    });

    // =========================================================================
    // energyFlow rule (validator matrix) — energy flow spec §4/§10.3
    // =========================================================================

    describe('energyFlow rule (validator matrix)', () => {
        /** Installs a warn spy that stays silent and returns the spy. */
        function warnSpy() {
            return vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        }

        /** The warn calls mentioning the energyFlow key (there must be at most one per rule). */
        function energyFlowWarns(spy) {
            return spy.mock.calls
                .map((call) => call[0])
                .filter((line) => typeof line === 'string' && line.includes('energyFlow'));
        }

        it('key absent (other rules only): energyFlow off, no warn, the other rules untouched', () => {
            const spy = warnSpy();
            const controller = new WorldRulesController({
                rules: { damageTornMaterial: { percent: 10, enabled: true } }
            });
            expect(controller.getRule('energyFlow')).toBeNull();
            expect(energyFlowWarns(spy)).toHaveLength(0);
            expect(controller.getDamageTornMaterialPercent()).toBe(10);
            spy.mockRestore();
        });

        it('non-object config (string / number / null / array / boolean) → off with a single warn', () => {
            for (const bad of ['flow', 42, null, [0.1, 100], true]) {
                const spy = warnSpy();
                const controller = new WorldRulesController({ rules: { energyFlow: bad } });
                expect(controller.getRule('energyFlow')).toBeNull();
                expect(energyFlowWarns(spy)).toHaveLength(1);
                spy.mockRestore();
            }
        });

        it('missing sharePerTick → off with a warn', () => {
            const spy = warnSpy();
            const controller = new WorldRulesController({
                rules: { energyFlow: { defaultEnergyCapacity: 100 } }
            });
            expect(controller.getRule('energyFlow')).toBeNull();
            expect(energyFlowWarns(spy)).toHaveLength(1);
            spy.mockRestore();
        });

        it('sharePerTick non-finite (string / NaN / Infinity) → off with a warn', () => {
            for (const bad of ['ten', NaN, Infinity]) {
                const spy = warnSpy();
                const controller = new WorldRulesController({
                    rules: { energyFlow: { sharePerTick: bad, defaultEnergyCapacity: 100 } }
                });
                expect(controller.getRule('energyFlow')).toBeNull();
                expect(energyFlowWarns(spy)).toHaveLength(1);
                spy.mockRestore();
            }
        });

        it('sharePerTick out of range (>1, <0) → off with a warn; 0 and 1 are boundaries (0 = off by design)', () => {
            for (const bad of [1.0001, -0.1]) {
                const spy = warnSpy();
                const controller = new WorldRulesController({
                    rules: { energyFlow: { sharePerTick: bad, defaultEnergyCapacity: 100 } }
                });
                expect(controller.getRule('energyFlow')).toBeNull();
                expect(energyFlowWarns(spy)).toHaveLength(1);
                spy.mockRestore();
            }
            // sharePerTick: 0 — VALID value meaning "flow off by design" (no warn).
            const spy0 = warnSpy();
            const c0 = new WorldRulesController({
                rules: { energyFlow: { sharePerTick: 0, defaultEnergyCapacity: 100 } }
            });
            expect(c0.getRule('energyFlow')).toBeNull();
            expect(energyFlowWarns(spy0)).toHaveLength(0);
            spy0.mockRestore();
            // sharePerTick: 1 — valid boundary (the whole pool circulates).
            const c1 = new WorldRulesController({
                rules: { energyFlow: { sharePerTick: 1, defaultEnergyCapacity: 100 } }
            });
            expect(c1.getRule('energyFlow')).toEqual({ sharePerTick: 1, defaultEnergyCapacity: 100, enabled: true });
        });

        it('missing / non-finite / negative defaultEnergyCapacity → off with a warn', () => {
            const cases = [
                { sharePerTick: 0.1 },
                { sharePerTick: 0.1, defaultEnergyCapacity: '100' },
                { sharePerTick: 0.1, defaultEnergyCapacity: NaN },
                { sharePerTick: 0.1, defaultEnergyCapacity: Infinity },
                { sharePerTick: 0.1, defaultEnergyCapacity: -1 }
            ];
            for (const config of cases) {
                const spy = warnSpy();
                const controller = new WorldRulesController({ rules: { energyFlow: config } });
                expect(controller.getRule('energyFlow')).toBeNull();
                expect(energyFlowWarns(spy)).toHaveLength(1);
                spy.mockRestore();
            }
        });

        it('enabled: non-boolean → off with a warn; enabled: false → off by design (no warn)', () => {
            const spyBad = warnSpy();
            const cBad = new WorldRulesController({
                rules: { energyFlow: { sharePerTick: 0.1, defaultEnergyCapacity: 100, enabled: 'yes' } }
            });
            expect(cBad.getRule('energyFlow')).toBeNull();
            expect(energyFlowWarns(spyBad)).toHaveLength(1);
            spyBad.mockRestore();

            const spyOff = warnSpy();
            const cOff = new WorldRulesController({
                rules: { energyFlow: { sharePerTick: 0.1, defaultEnergyCapacity: 100, enabled: false } }
            });
            expect(cOff.getRule('energyFlow')).toBeNull();
            expect(energyFlowWarns(spyOff)).toHaveLength(0);
            spyOff.mockRestore();
        });

        it('valid config round-trips via getRule as a defensive copy, and is counted in the boot summary', () => {
            const registry = {
                rules: { energyFlow: { sharePerTick: 0.1, defaultEnergyCapacity: 100 } }
            };
            const controller = new WorldRulesController(registry);
            const rule1 = controller.getRule('energyFlow');
            expect(rule1).toEqual({ sharePerTick: 0.1, defaultEnergyCapacity: 100, enabled: true });
            // Defensive copy: mutating the returned copy must not corrupt the registry.
            rule1.sharePerTick = 0.99;
            expect(controller.getRule('energyFlow').sharePerTick).toBe(0.1);

            // The new key is counted automatically once registered (2 known keys now).
            const infoSpy = vi.spyOn(Logger, 'info');
            try {
                new WorldRulesController(registry);
                const summary = infoSpy.mock.calls
                    .map((call) => call[0])
                    .find((line) => typeof line === 'string' && line.includes('rule(s) active'));
                expect(summary, 'the init summary line should be logged at construction').toBeDefined();
                expect(summary).toMatch(/1\/2 rule\(s\) active \(energyFlow\)/);
            } finally {
                infoSpy.mockRestore();
            }
        });

        it('key independence: a malformed energyFlow leaves the torn rule intact — and vice versa', () => {
            const spy = warnSpy();
            const c1 = new WorldRulesController({
                rules: {
                    damageTornMaterial: { percent: 10, enabled: true },
                    energyFlow: { sharePerTick: 'bad', defaultEnergyCapacity: 100 }
                }
            });
            expect(c1.getRule('energyFlow')).toBeNull();
            expect(c1.getDamageTornMaterialPercent()).toBe(10);
            spy.mockRestore();

            const c2 = new WorldRulesController({
                rules: {
                    damageTornMaterial: { percent: 'bad' },
                    energyFlow: { sharePerTick: 0.1, defaultEnergyCapacity: 100 }
                }
            });
            expect(c2.getRule('energyFlow')).toEqual({ sharePerTick: 0.1, defaultEnergyCapacity: 100, enabled: true });
            expect(c2.getDamageTornMaterialPercent()).toBe(0);
        });
    });
});

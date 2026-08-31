import { describe, it, expect, vi, afterEach } from 'vitest';
import MaterialController from '../../src/controllers/materials/MaterialController.js';
import TraitsController from '../../src/controllers/traits/TraitsController.js';
import { TRAIT_STAT_KEY_PATTERN } from '../../shared/StatVocabulary.js';

let capturedInfo = [];
vi.mock('../../src/utils/Logger.js', () => ({
    default: {
        info: (msg) => { capturedInfo.push(msg); },
        warn: (msg) => {},
        error: (msg) => {}
    }
}));

// Minimal material registry for testing
const materialsRegistry = {
    wood: {
        name: 'Wood',
        density: 0.6,
        properties: {
            flammability: 80,
            electricalConduction: 5,
            moistureRetention: 60,
            cutResistance: 20,
            impactResistance: 70,
            wearResistance: 30,
            heatConduction: 15
        }
    },
    iron: {
        name: 'Iron',
        density: 7.8,
        properties: {
            flammability: 5,
            electricalConduction: 90,
            moistureRetention: 0,
            cutResistance: 85,
            impactResistance: 45,
            wearResistance: 80,
            heatConduction: 85
        }
    }
};

// Minimal mapping registry for testing
const mappingRegistry = {
    'Physical.mass': { formula: 'densityVolume' },
    'Physical.durability': {
        sources: { wearResistance: 0.5, impactResistance: 0.3, cutResistance: 0.2 }
    },
    'Physical.flammability': { sources: { flammability: 1.0 } }
};

// Global traits for testing merge
const globalTraits = {
    Physical: {
        durability: 100,
        mass: 10,
        volume: 1,
        temperature: 20,
        strength: 10,
        sharpness: 10,
        flammability: 0
    }
};

describe('MaterialController', () => {
    describe('derive', () => {
        it('returns empty object for blueprint without materials', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({ traits: { Physical: { durability: 50 } } });
            expect(result).toEqual({});
        });

        it('returns empty object for blueprint with empty materials array', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({ materials: [], traits: {} });
            expect(result).toEqual({});
        });

        it('throws TypeError on unknown material ID', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(() => controller.derive({
                materials: [{ material: 'plastic', fraction: 1.0 }],
                traits: {}
            })).toThrow(TypeError);
        });

        it('throws TypeError on zero fraction', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(() => controller.derive({
                materials: [{ material: 'iron', fraction: 0 }],
                traits: {}
            })).toThrow(TypeError);
        });

        it('throws TypeError on negative fraction', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(() => controller.derive({
                materials: [{ material: 'iron', fraction: -0.5 }],
                traits: {}
            })).toThrow(TypeError);
        });

        it('throws TypeError when fractions sum > 1', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(() => controller.derive({
                materials: [
                    { material: 'iron', fraction: 0.6 },
                    { material: 'wood', fraction: 0.5 }
                ],
                traits: {}
            })).toThrow(TypeError);
        });

        it('validates fractions sum <= 1 (accepts exactly 1)', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'iron', fraction: 1.0 }],
                traits: {}
            });
            expect(result.Physical.mass).toBeCloseTo(7.8, 2); // density × volume(1)
        });

        it('validates fractions sum <= 1 (accepts less than 1)', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'iron', fraction: 0.5 }],
                traits: {}
            });
            expect(result.Physical.mass).toBeCloseTo(3.9, 2); // density × 0.5 × volume(1)
        });

    });
    describe('constructor validation', () => {
        it('logs info with correct counts on valid registries', () => {
            capturedInfo = [];
            new MaterialController(materialsRegistry, mappingRegistry);
            expect(capturedInfo).toHaveLength(1);
            expect(capturedInfo[0]).toContain('initialized with');
            expect(capturedInfo[0]).toContain('materials');
            expect(capturedInfo[0]).toContain('mappings');
        });

        it('throws TypeError when materials registry is not a plain object', () => {
            expect(() => new MaterialController([], mappingRegistry)).toThrow(TypeError);
        });

        it('throws TypeError when materials registry entry lacks name', () => {
            const badRegistry = {
                wood: {
                    density: 0.6,
                    properties: { flammability: 80 }
                }
            };
            expect(() => new MaterialController(badRegistry, mappingRegistry)).toThrow(TypeError);
            expect(() => new MaterialController(badRegistry, mappingRegistry)).toThrow(/"wood"/);
        });

        it('throws TypeError when materials registry entry lacks density', () => {
            const badRegistry = {
                wood: {
                    name: 'Wood',
                    properties: { flammability: 80 }
                }
            };
            expect(() => new MaterialController(badRegistry, mappingRegistry)).toThrow(TypeError);
            expect(() => new MaterialController(badRegistry, mappingRegistry)).toThrow(/"wood"/);
        });

        it('throws TypeError when materials registry entry lacks properties', () => {
            const badRegistry = {
                wood: {
                    name: 'Wood',
                    density: 0.6
                }
            };
            expect(() => new MaterialController(badRegistry, mappingRegistry)).toThrow(TypeError);
            expect(() => new MaterialController(badRegistry, mappingRegistry)).toThrow(/"wood"/);
        });

        it('throws TypeError when mapping key does not match pattern', () => {
            const badMapping = {
                'invalid-key': { formula: 'densityVolume' }
            };
            expect(() => new MaterialController(materialsRegistry, badMapping)).toThrow(TypeError);
            expect(() => new MaterialController(materialsRegistry, badMapping)).toThrow(/invalid-key/);
        });

        it('throws TypeError when mapping entry has neither formula nor sources', () => {
            const badMapping = {
                'Physical.mass': { someOtherField: 123 }
            };
            expect(() => new MaterialController(materialsRegistry, badMapping)).toThrow(TypeError);
            expect(() => new MaterialController(materialsRegistry, badMapping)).toThrow(/"Physical.mass"/);
        });

        it('constructor succeeds with valid registries and Logger.info called', () => {
            capturedInfo = [];
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(controller).toBeInstanceOf(MaterialController);
            expect(controller.materialsRegistry).toHaveProperty('wood');
            expect(controller.materialsRegistry).toHaveProperty('iron');
            expect(controller.mappingRegistry).toHaveProperty('Physical.mass');
            expect(capturedInfo).toHaveLength(1);
        });
    });

    describe('validateComposition (public)', () => {
        it('throws TypeError when materials is not an array', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(() => controller.validateComposition('test', 'not-array')).toThrow(TypeError);
        });

        it('throws TypeError for unknown material in composition', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(() => controller.validateComposition('test', [{ material: 'unknown', fraction: 1.0 }])).toThrow(TypeError);
        });

        it('does not throw for valid composition', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            expect(() => controller.validateComposition('test', [{ material: 'iron', fraction: 1.0 }])).not.toThrow();
        });
    });

    describe('blend properties and derive traits', () => {
        it('correctly blends iron-only (mass = density × volume)', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'iron', fraction: 1.0 }],
                traits: {},
                volume: 1
            });
            expect(result.Physical.mass).toBeCloseTo(7.8, 2);
        });

        it('correctly blends iron-only with custom volume', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'iron', fraction: 1.0 }],
                traits: {},
                volume: 10
            });
            expect(result.Physical.mass).toBeCloseTo(78, 2); // 7.8 × 10
        });

        it('correctly blends wood-only (mass = density × volume)', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'wood', fraction: 1.0 }],
                traits: {},
                volume: 1
            });
            expect(result.Physical.mass).toBeCloseTo(0.6, 2);
        });

        it('blends 60/40 iron/wood knife (mass)', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [
                    { material: 'iron', fraction: 0.6, role: 'blade' },
                    { material: 'wood', fraction: 0.4, role: 'handle' }
                ],
                traits: {},
                volume: 1
            });
            // mass = (0.6 × 7.8 + 0.4 × 0.6) × 1 = (4.68 + 0.24) = 4.92
            expect(result.Physical.mass).toBeCloseTo(4.92, 2);
        });

        it('blends 60/40 iron/wood knife (flammability)', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [
                    { material: 'iron', fraction: 0.6, role: 'blade' },
                    { material: 'wood', fraction: 0.4, role: 'handle' }
                ],
                traits: {},
                volume: 1
            });
            // flammability = 0.6 × 5 + 0.4 × 80 = 3 + 32 = 35
            expect(result.Physical.flammability).toBeCloseTo(35, 2);
        });

        it('blends iron-only durability (weighted sources)', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'iron', fraction: 1.0 }],
                traits: {},
                volume: 1
            });
            // durability sources: wearResistance=80 (w=0.5), impactResistance=45 (w=0.3), cutResistance=85 (w=0.2)
            // = (80×0.5 + 45×0.3 + 85×0.2) / (0.5+0.3+0.2) = (40+13.5+17)/1 = 70.5
            expect(result.Physical.durability).toBeCloseTo(70.5, 2);
        });

        it('blends wood-only durability', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'wood', fraction: 1.0 }],
                traits: {},
                volume: 1
            });
            // durability sources: wearResistance=30 (w=0.5), impactResistance=70 (w=0.3), cutResistance=20 (w=0.2)
            // = (30×0.5 + 70×0.3 + 20×0.2) / 1 = (15+21+4)/1 = 40
            expect(result.Physical.durability).toBeCloseTo(40, 2);
        });

        it('blends wood-only flammability', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'wood', fraction: 1.0 }],
                traits: {},
                volume: 1
            });
            // flammability = 80
            expect(result.Physical.flammability).toBeCloseTo(80, 2);
        });

        it('blends iron-only flammability', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [{ material: 'iron', fraction: 1.0 }],
                traits: {},
                volume: 1
            });
            // flammability = 5
            expect(result.Physical.flammability).toBeCloseTo(5, 2);
        });

        it('knife 60/40 iron/wood durability', () => {
            const controller = new MaterialController(materialsRegistry, mappingRegistry);
            const result = controller.derive({
                materials: [
                    { material: 'iron', fraction: 0.6, role: 'blade' },
                    { material: 'wood', fraction: 0.4, role: 'handle' }
                ],
                traits: {},
                volume: 1
            });
            // blended sources:
            // wearResistance = 0.6×80 + 0.4×30 = 48+12 = 60
            // impactResistance = 0.6×45 + 0.4×70 = 27+28 = 55
            // cutResistance = 0.6×85 + 0.4×20 = 51+8 = 59
            // durability = (60×0.5 + 55×0.3 + 59×0.2) / 1 = (30+16.5+11.8)/1 = 58.3
            expect(result.Physical.durability).toBeCloseTo(58.3, 2);
        });
    });

    describe('merge integration with TraitsController', () => {
        it('material-derived layer sits below blueprint overrides (blueprint wins)', () => {
            const materialController = new MaterialController(materialsRegistry, mappingRegistry);
            const traitsController = new TraitsController(globalTraits);

            // Knife blueprint: hand-sets durability=30, sharpness=50
            // Materials derive durability≈58.3 but blueprint override should win
            const blueprint = {
                materials: [
                    { material: 'iron', fraction: 0.6 },
                    { material: 'wood', fraction: 0.4 }
                ],
                traits: {
                    Physical: { durability: 30, sharpness: 50 }
                },
                volume: 1
            };

            const derived = materialController.derive(blueprint);
            const finalStats = traitsController.mergeTraits(blueprint.traits, derived);

            // Blueprint override wins for durability → should be 30, not ~58.3
            expect(finalStats.Physical.durability).toBe(30);
            // sharpness from blueprint is preserved
            expect(finalStats.Physical.sharpness).toBe(50);
            // mass and flammability come from materials (blueprint doesn't override them)
            expect(finalStats.Physical.mass).toBeCloseTo(4.92, 2);
            expect(finalStats.Physical.flammability).toBeCloseTo(35, 2);
        });

        it('material-derived layer fills gaps when blueprint does not override', () => {
            const materialController = new MaterialController(materialsRegistry, mappingRegistry);
            const traitsController = new TraitsController(globalTraits);

            // MetalBox: hand-sets mass=2, durability=100 (flammability NOT set)
            const blueprint = {
                materials: [{ material: 'iron', fraction: 1.0 }],
                traits: {
                    Physical: { mass: 2, durability: 100 }
                },
                volume: 10
            };

            const derived = materialController.derive(blueprint);
            const finalStats = traitsController.mergeTraits(blueprint.traits, derived);

            // Blueprint overrides win for mass and durability
            expect(finalStats.Physical.mass).toBe(2);
            expect(finalStats.Physical.durability).toBe(100);
            // Flammability comes from materials (iron → 5)
            expect(finalStats.Physical.flammability).toBeCloseTo(5, 2);
        });

        it('backward compat: blueprint without materials produces identical stats', () => {
            const materialController = new MaterialController(materialsRegistry, mappingRegistry);
            const traitsController = new TraitsController(globalTraits);

            // DroidArm has no materials field — should behave exactly as before
            const blueprint = {
                traits: {
                    Physical: { durability: 50, volume: 8 },
                    Spatial: { x: 20, y: 10 }
                }
            };

            const derived = materialController.derive(blueprint);
            const finalStats = traitsController.mergeTraits(blueprint.traits, derived);

            // No materials → derived is empty → merge output = globalDefaults + blueprint overrides
            expect(finalStats.Physical.durability).toBe(50);
            expect(finalStats.Physical.volume).toBe(8);
            expect(finalStats.Physical.mass).toBe(10); // from global defaults (not overridden)
            expect(finalStats.Physical.flammability).toBe(0); // from global defaults
            expect(finalStats.Spatial.x).toBe(20);
            expect(finalStats.Spatial.y).toBe(10);
        });

        it('backward compat: mergeTraits(null materialDerived) is identical to old behavior', () => {
            const traitsController = new TraitsController(globalTraits);
            const blueprintTraits = {
                Physical: { durability: 40, volume: 6 }
            };

            // Call without the second argument (default null)
            const finalStats = traitsController.mergeTraits(blueprintTraits);

            expect(finalStats.Physical.durability).toBe(40);
            expect(finalStats.Physical.volume).toBe(6);
            expect(finalStats.Physical.mass).toBe(10); // global default preserved
            expect(finalStats.Physical.flammability).toBe(0); // global default preserved
        });

        it('backward compat: blueprint declaring only one group does NOT get undeclared groups from globalTraits', () => {
            // Strengthened test: globalTraits now contains additional groups beyond Physical.
            const enrichedGlobalTraits = {
                Physical: { durability: 100, mass: 10 },
                Mind: { think_level: 50 },
                Spatial: { x: 99, y: 99 },
                Movement: {},
                Manipulation: { fine_controls: 99 }
            };

            const traitsController = new TraitsController(enrichedGlobalTraits);
            const blueprintTraits = {
                Physical: { durability: 40, volume: 6 }
                // Blueprint declares ONLY Physical — should NOT get Mind, Spatial, Movement, Manipulation
            };

            const finalStats = traitsController.mergeTraits(blueprintTraits);

            // Physical from blueprint is present with global defaults filled in
            expect(finalStats.Physical.durability).toBe(40);
            expect(finalStats.Physical.mass).toBe(10); // global default preserved
            // Blueprint did NOT declare these groups — they must NOT appear
            expect(finalStats).not.toHaveProperty('Mind');
            expect(finalStats).not.toHaveProperty('Spatial');
            expect(finalStats).not.toHaveProperty('Movement');
            expect(finalStats).not.toHaveProperty('Manipulation');
        });

        it('material-derived group not declared by blueprint IS present in merged output', () => {
            // Test the new capability: a material-derived group the blueprint does NOT declare must still appear.
            const traitsController = new TraitsController({
                Physical: { durability: 100, mass: 10 }
            });

            const blueprintTraits = {
                Physical: { durability: 50 }
                // Blueprint declares only Physical, no Movement
            };

            // Simulate material-derived output that contains a Movement group the blueprint does not declare
            const materialDerived = {
                Physical: { mass: 5 },
                Movement: { move: 25 } // Derived from some material component
            };

            const finalStats = traitsController.mergeTraits(blueprintTraits, materialDerived);

            // Blueprint's Physical is present
            expect(finalStats.Physical.durability).toBe(50);
            expect(finalStats.Physical.mass).toBe(5); // from derived (blueprint doesn't override)
            // Movement group IS present because material-derived produced it, even though blueprint didn't declare it
            expect(finalStats).toHaveProperty('Movement');
            expect(finalStats.Movement.move).toBe(25);
        });

        // Fix 3 tests: Movement default removal — no phantom move injected
        it('Fix 3: blueprint declaring only Mind → merged stats contain no Movement key', () => {
            const traitsController = new TraitsController({
                Physical: { durability: 100 },
                Mind: { think_level: 10 },
                Movement: {} // Empty in data/traits.json — no default move
            });

            const blueprintTraits = {
                Mind: { think_level: 50 }
                // Blueprint declares only Mind
            };

            const finalStats = traitsController.mergeTraits(blueprintTraits);

            // Mind present with merged value
            expect(finalStats.Mind.think_level).toBe(50);
            // Movement must NOT be present (no default move in data/traits.json, blueprint didn't declare it)
            expect(finalStats).not.toHaveProperty('Movement');
            expect(finalStats).not.toHaveProperty('move');
        });

        it('Fix 3: blueprint declaring Movement without move → group present, move undefined, no default injected', () => {
            const traitsController = new TraitsController({
                Physical: { durability: 100 },
                Movement: {} // No default move
            });

            const blueprintTraits = {
                Movement: {} // Declares the group but no move property
            };

            const finalStats = traitsController.mergeTraits(blueprintTraits);

            // Movement group is present (blueprint declared it)
            expect(finalStats).toHaveProperty('Movement');
            // move is undefined — no default injected
            expect(finalStats.Movement.move).toBeUndefined();
        });
    });
});

describe('shared mapping-key pattern (spec §2 R3)', () => {
    it('classifies trait→stat key forms (the shared constant used by both boot validators)', () => {
        expect(TRAIT_STAT_KEY_PATTERN.test('Physical.durability')).toBe(true);
        expect(TRAIT_STAT_KEY_PATTERN.test('a.b')).toBe(true); // lowercase allowed
        expect(TRAIT_STAT_KEY_PATTERN.test('A.b.c')).toBe(false); // two dots
        expect(TRAIT_STAT_KEY_PATTERN.test('A')).toBe(false);
        expect(TRAIT_STAT_KEY_PATTERN.test('A.')).toBe(false);
        expect(TRAIT_STAT_KEY_PATTERN.test('.b')).toBe(false);
        expect(TRAIT_STAT_KEY_PATTERN.test('A.B_C')).toBe(true); // underscore in stat
    });
});

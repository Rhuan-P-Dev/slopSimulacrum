import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ComponentController from '../../src/controllers/core/componentController.js';
import ComponentStatsController from '../../src/controllers/core/componentStatsController.js';
import TraitsController from '../../src/controllers/traits/TraitsController.js';

// Define mock logger state at top level (vi.mock is hoisted, needs accessible reference)
const mockLoggerState = {
    warnCalls: [],
    infoCalls: []
};

vi.mock('../../src/utils/Logger.js', () => ({
    default: {
        warn: (msg) => { mockLoggerState.warnCalls.push(msg); },
        info: (msg) => { mockLoggerState.infoCalls.push(msg); },
        error: (msg) => {}
    }
}));

// Component registry with a component that has materials
const componentRegistry = {
    simpleComponent: {
        traits: {
            Physical: { durability: 100, mass: 10 }
        }
    },
    materialComponent: {
        materials: [
            { material: 'iron', fraction: 1.0 }
        ],
        traits: {
            Physical: { durability: 50, mass: 5 }
        }
    }
};

// Materials registry
const materialsRegistry = {
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

// Mapping registry
const mappingRegistry = {
    'Physical.mass': { formula: 'densityVolume' },
    'Physical.durability': {
        sources: { wearResistance: 0.5, impactResistance: 0.3, cutResistance: 0.2 }
    }
};

describe('ComponentController material derivation fail-safe', () => {
    beforeEach(() => {
        mockLoggerState.warnCalls = [];
        mockLoggerState.infoCalls = [];
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('fail-safe on material derivation failure', () => {
        it('succeeds when materialController.derive throws, stats come from global⊕blueprint', () => {
            // Create a stubbed materialController whose derive always throws
            const stubMaterialController = {
                derive: () => {
                    throw new TypeError('Unknown material "plastic" in composition');
                }
            };

            const statsController = new ComponentStatsController();
            const traitsController = new TraitsController({
                Physical: { durability: 100, mass: 10, volume: 1, temperature: 20 }
            });

            const controller = new ComponentController(
                statsController,
                traitsController,
                componentRegistry,
                stubMaterialController
            );

            // Should NOT throw — fail-safe
            expect(() => {
                controller.initializeComponent('materialComponent', 'comp-1');
            }).not.toThrow();

            // Stats should come from blueprint (durability=50, mass=5), not derived
            const stats = controller.getComponentStats('comp-1');
            expect(stats.Physical.durability).toBe(50);
            expect(stats.Physical.mass).toBe(5);

            // Warn should have been logged
            expect(mockLoggerState.warnCalls).toHaveLength(1);
            expect(mockLoggerState.warnCalls[0]).toContain('[ComponentController] Material derivation failed');
            expect(mockLoggerState.warnCalls[0]).toContain('materialComponent');
            expect(mockLoggerState.warnCalls[0]).toContain('Unknown material "plastic"');
        });

        it('succeeds when materialController is null', () => {
            const statsController = new ComponentStatsController();
            const traitsController = new TraitsController({
                Physical: { durability: 100, mass: 10, volume: 1, temperature: 20 }
            });

            const controller = new ComponentController(
                statsController,
                traitsController,
                componentRegistry,
                null
            );

            expect(() => {
                controller.initializeComponent('materialComponent', 'comp-2');
            }).not.toThrow();

            const stats = controller.getComponentStats('comp-2');
            expect(stats.Physical.durability).toBe(50);
        });

        it('derives normally when materialController.derive succeeds', () => {
            // Create a working materialController stub
            const workingMaterialController = {
                derive: (blueprint) => {
                    return {
                        Physical: { mass: 7.8, flammability: 5 }
                    };
                }
            };

            const statsController = new ComponentStatsController();
            const traitsController = new TraitsController({
                Physical: { durability: 100, mass: 10, volume: 1, temperature: 20 }
            });

            const controller = new ComponentController(
                statsController,
                traitsController,
                componentRegistry,
                workingMaterialController
            );

            expect(() => {
                controller.initializeComponent('materialComponent', 'comp-3');
            }).not.toThrow();

            const stats = controller.getComponentStats('comp-3');
            // Blueprint override wins for mass (5 from blueprint overrides derived 7.8)
            expect(stats.Physical.mass).toBe(5);
            // flammability comes from derived (blueprint doesn't override)
            expect(stats.Physical.flammability).toBe(5);

            // No warn should have been logged
            expect(mockLoggerState.warnCalls).toHaveLength(0);
        });

        it('skips derivation when blueprint has no materials field', () => {
            const stubMaterialController = {
                derive: () => {
                    throw new TypeError('Should not be called');
                }
            };

            const statsController = new ComponentStatsController();
            const traitsController = new TraitsController({
                Physical: { durability: 100, mass: 10, volume: 1, temperature: 20 }
            });

            const controller = new ComponentController(
                statsController,
                traitsController,
                componentRegistry,
                stubMaterialController
            );

            // simpleComponent has no materials field
            expect(() => {
                controller.initializeComponent('simpleComponent', 'comp-4');
            }).not.toThrow();

            const stats = controller.getComponentStats('comp-4');
            expect(stats.Physical.durability).toBe(100);
            expect(stats.Physical.mass).toBe(10);

            // No warn should have been logged (derive not called)
            expect(mockLoggerState.warnCalls).toHaveLength(0);
        });
    });
});

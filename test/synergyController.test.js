import { describe, it, expect, vi, beforeEach } from 'vitest';
import SynergyController from '../src/controllers/synergyController.js';
import {
    calculateSynergyMultiplier,
    SCALING_CURVES,
    getScalingCurve
} from '../src/utils/SynergyScaling.js';

// ─── Mock WorldStateController ───────────────────────────────────────────────

function createMockWorldStateController() {
    const entities = new Map();

    return {
        stateEntityController: {
            getEntity: (entityId) => entities.get(entityId) || null
        },
        componentController: {
            getComponentStats: (componentId) => {
                for (const [, entity] of entities) {
                    for (const comp of entity.components) {
                        if (comp.id === componentId) {
                            return comp.stats;
                        }
                    }
                }
                return null;
            }
        },
        // Test helpers
        _addEntity: (entity) => entities.set(entity.id, entity),
        _getEntity: (entityId) => entities.get(entityId) || null
    };
}

// ─── Test Fixtures ──────────────────────────────────────────────────────────

/**
 * Action registry — no longer contains synergy definitions.
 * Synergy configs are passed separately via synergyRegistry.
 */
const mockActionRegistry = {
    'move': {
        targetingType: 'spatial',
        requirements: [{ trait: 'Movement', stat: 'move', minValue: 5 }],
        consequences: [{ type: 'deltaSpatial', params: { speed: ':Movement.move' } }]
    },
    'dash': {
        targetingType: 'spatial',
        requirements: [
            { trait: 'Movement', stat: 'move', minValue: 5 },
            { trait: 'Physical', stat: 'durability', minValue: 30 }
        ],
        consequences: [{ type: 'deltaSpatial', params: { speed: ':Movement.move*2' } }]
    },
    'punch': {
        targetingType: 'component',
        requirements: [{ trait: 'Physical', stat: 'strength', minValue: 1 }],
        consequences: [{ type: 'damageComponent', params: { trait: 'Physical', stat: 'durability', value: '-:Physical.strength' } }]
    },
    'noSynergyAction': {
        targetingType: 'spatial',
        requirements: []
    }
};

/**
 * Synergy registry — standalone synergy definitions (from data/synergy.json).
 */
const mockSynergyRegistry = {
    'move': {
        enabled: true,
        multiEntity: false,
        scaling: 'diminishingReturns',
        caps: {},
        componentGroups: [
            {
                groupType: 'movementComponents',
                minCount: 1,
                scaling: 'diminishingReturns',
                baseMultiplier: 1.0,
                perUnitBonus: 0.3
            }
        ]
    },
    'dash': {
        enabled: true,
        multiEntity: true,
        scaling: 'linear',
        caps: {},
        componentGroups: [
            {
                groupType: 'sameComponentType',
                componentType: 'droidRollingBall',
                minCount: 2,
                scaling: 'linear',
                baseMultiplier: 1.0,
                perUnitBonus: 0.5
            },
            {
                groupType: 'movementComponents',
                minCount: 1,
                scaling: 'linear',
                baseMultiplier: 1.0,
                perUnitBonus: 0.3
            }
        ]
    },
    'punch': {
        enabled: true,
        multiEntity: false,
        scaling: 'diminishingReturns',
        caps: {
            damage: { max: 1.1, req: 'Physical.stability' }
        },
        componentGroups: [
            {
                groupType: 'sameComponentType',
                minCount: 2,
                scaling: 'diminishingReturns',
                baseMultiplier: 1.0,
                perUnitBonus: 0.05
            }
        ]
    }
};

const mockEntityWithMovement = {
    id: 'entity-1',
    components: [
        {
            id: 'comp-roll-1',
            type: 'droidRollingBall',
            stats: {
                Physical: { durability: 120, mass: 20 },
                Movement: { move: 20 },
                Spatial: { x: 0, y: 0 }
            }
        },
        {
            id: 'comp-roll-2',
            type: 'droidRollingBall',
            stats: {
                Physical: { durability: 120, mass: 20 },
                Movement: { move: 20 },
                Spatial: { x: 0, y: 20 }
            }
        }
    ]
};

const mockEntityWithPhysical = {
    id: 'entity-2',
    components: [
        {
            id: 'comp-hand-1',
            type: 'droidHand',
            stats: {
                Physical: { durability: 40, strength: 25 }
            },
            Spatial: { x: 30, y: 0 }
        },
        {
            id: 'comp-arm-1',
            type: 'droidArm',
            stats: {
                Physical: { durability: 50 }
            },
            Spatial: { x: 20, y: 10 }
        }
    ]
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SynergyScaling Utilities', () => {
    describe('calculateSynergyMultiplier', () => {
        it('should return base multiplier for 1 unit with linear scaling', () => {
            const result = calculateSynergyMultiplier(1, 'linear', 1.0, 0.5);
            expect(result).toBe(1.0);
        });

        it('should apply linear scaling correctly', () => {
            const result = calculateSynergyMultiplier(3, 'linear', 1.0, 0.5);
            expect(result).toBe(2.0); // 1.0 + 0.5 * (3-1) = 2.0
        });

        it('should apply diminishing returns scaling', () => {
            const result = calculateSynergyMultiplier(2, 'diminishingReturns', 1.0, 1.0);
            // 1.0 + 1.0 * (1 - e^(-2*1)) = 1.0 + 1.0 * (1 - 0.135) ≈ 1.865
            expect(result).toBeGreaterThan(1.5);
            expect(result).toBeLessThan(2.0);
        });

        it('should apply increasing returns scaling', () => {
            const result = calculateSynergyMultiplier(3, 'increasingReturns', 1.0, 0.5);
            // 1.0 + 0.5 * (2)^1.5 = 1.0 + 0.5 * 2.828 ≈ 2.414
            expect(result).toBeGreaterThan(2.3);
            expect(result).toBeLessThan(2.5);
        });

        it('should throw error for unknown scaling curve', () => {
            expect(() => getScalingCurve('unknownCurve')).toThrow('Unknown synergy scaling curve');
        });

        it('should handle minimum unit count', () => {
            const result = calculateSynergyMultiplier(0, 'linear', 1.0, 0.5);
            expect(result).toBe(1.0); // Should clamp to 1
        });
    });

    describe('SCALING_CURVES', () => {
        it('should have all three scaling curves', () => {
            expect(SCALING_CURVES.linear).toBeDefined();
            expect(SCALING_CURVES.diminishingReturns).toBeDefined();
            expect(SCALING_CURVES.increasingReturns).toBeDefined();
        });

        it('should have linear curve as a function', () => {
            expect(typeof SCALING_CURVES.linear).toBe('function');
        });
    });
});

describe('SynergyController', () => {
    let mockWSC;
    let controller;

    beforeEach(() => {
        mockWSC = createMockWorldStateController();
        // Pass actionRegistry (2nd) and synergyRegistry (3rd) separately
        controller = new SynergyController(mockWSC, mockActionRegistry, mockSynergyRegistry);
    });

    describe('computeSynergy', () => {
        it('should return no synergy for action without synergy config', () => {
            const result = controller.computeSynergy('noSynergyAction', 'entity-1');
            expect(result.synergyMultiplier).toBe(1.0);
            expect(result.capped).toBe(false);
            expect(result.contributingComponents).toEqual([]);
        });

        it('should return no synergy for unknown action', () => {
            const result = controller.computeSynergy('unknownAction', 'entity-1');
            expect(result.synergyMultiplier).toBe(1.0);
        });

        it('should compute synergy for move action with movement components', () => {
            mockWSC._addEntity(mockEntityWithMovement);
            const result = controller.computeSynergy('move', 'entity-1');

            expect(result.synergyMultiplier).toBeGreaterThan(1.0);
            expect(result.contributingComponents.length).toBeGreaterThan(0);
            expect(result.capped).toBe(false);
        });

        it('should compute synergy with multi-entity groups', () => {
            mockWSC._addEntity(mockEntityWithMovement);

            const result = controller.computeSynergy('dash', 'entity-1', {
                synergyGroups: [
                    {
                        primaryEntityId: 'entity-1',
                        primaryComponentId: 'comp-roll-1',
                        supportingEntityIds: ['entity-2'],
                        supportingComponentIds: ['comp-roll-2'],
                        perUnitBonus: 0.5
                    }
                ]
            });

            expect(result.synergyMultiplier).toBeGreaterThan(1.0);
            expect(result.contributingComponents.length).toBeGreaterThan(0);
        });

        it('should return result with summary string', () => {
            mockWSC._addEntity(mockEntityWithMovement);
            const result = controller.computeSynergy('move', 'entity-1');

            expect(result.summary).toBeDefined();
            expect(typeof result.summary).toBe('string');
            expect(result.summary).toContain('Synergy:');
        });
    });

    describe('applySynergyToResult', () => {
        it('should apply multiplier to base value', () => {
            const mockResult = {
                actionName: 'move',
                synergyMultiplier: 1.5,
                capped: false,
                capKey: null,
                contributingComponents: []
            };

            const finalValue = controller.applySynergyToResult(mockResult, 10);
            expect(finalValue).toBe(15);
        });

        it('should cap value when capped is true', () => {
            const mockResult = {
                actionName: 'punch',
                synergyMultiplier: 2.0,
                capped: true,
                capKey: 'damage',
                contributingComponents: []
            };

            const finalValue = controller.applySynergyToResult(mockResult, 100);
            expect(finalValue).toBeLessThanOrEqual(1.1); // Cap is 1.1
        });
    });

    describe('getSynergyConfig', () => {
        it('should return synergy config for action with synergy', () => {
            const config = controller.getSynergyConfig('move');
            expect(config.enabled).toBe(true);
            expect(config.scaling).toBe('diminishingReturns');
        });

        it('should return default config for action without synergy', () => {
            const config = controller.getSynergyConfig('noSynergyAction');
            expect(config.enabled).toBe(false);
        });

        it('should return default config for unknown action', () => {
            const config = controller.getSynergyConfig('unknown');
            expect(config.enabled).toBe(false);
        });
    });

    describe('getActionsWithSynergy', () => {
        it('should return all actions with synergy enabled', () => {
            const actions = controller.getActionsWithSynergy();
            expect(actions).toContain('move');
            expect(actions).toContain('dash');
            expect(actions).toContain('punch');
            expect(actions).not.toContain('noSynergyAction');
        });
    });

    describe('clearCache', () => {
        it('should clear the synergy cache', () => {
            mockWSC._addEntity(mockEntityWithMovement);
            controller.computeSynergy('move', 'entity-1');
            controller.clearCache();
            // Cache should be empty after clearing
            expect(controller._synergyCache.size).toBe(0);
        });
    });

    describe('getSynergySummary', () => {
        it('should return a human-readable summary', () => {
            mockWSC._addEntity(mockEntityWithMovement);
            const result = controller.computeSynergy('move', 'entity-1');
            const summary = controller.getSynergySummary(result);
            expect(summary).toBeDefined();
            expect(typeof summary).toBe('string');
        });
    });
});

describe('Synergy Integration Scenarios', () => {
    let mockWSC;
    let controller;

    beforeEach(() => {
        mockWSC = createMockWorldStateController();
        controller = new SynergyController(mockWSC, mockActionRegistry, mockSynergyRegistry);
    });

    it('should handle multi-entity dash with 2 droids', () => {
        // Entity 1: First droid with rolling ball
        const entity1 = {
            id: 'droid-1',
            components: [
                {
                    id: 'roll-1',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 20 }
                    }
                }
            ]
        };

        // Entity 2: Second droid with rolling ball
        const entity2 = {
            id: 'droid-2',
            components: [
                {
                    id: 'roll-2',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 20 }
                    }
                }
            ]
        };

        mockWSC._addEntity(entity1);
        mockWSC._addEntity(entity2);

        const result = controller.computeSynergy('dash', 'droid-1', {
            synergyGroups: [
                {
                    primaryEntityId: 'droid-1',
                    primaryComponentId: 'roll-1',
                    supportingEntityIds: ['droid-2'],
                    supportingComponentIds: ['roll-2'],
                    perUnitBonus: 0.5
                }
            ]
        });

        // Single-entity group: 1 movement component → 1.0x
        // Multi-entity group: 2 entities → 1.5x
        // Total: 1.0 * 1.5 = 1.5
        // Components: 1 (single) + 2 (multi) = 3
        expect(result.synergyMultiplier).toBe(1.5);
        expect(result.contributingComponents.length).toBe(3);
    });

    it('should handle single entity with multiple movement components', () => {
        const entity = {
            id: 'multi-mover',
            components: [
                {
                    id: 'roll-1',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 20 }
                    }
                },
                {
                    id: 'roll-2',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 15 }
                    }
                },
                {
                    id: 'roll-3',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 10 }
                    }
                }
            ]
        };

        mockWSC._addEntity(entity);

        const result = controller.computeSynergy('move', 'multi-mover');

        // 3 movement components, diminishing returns
        // 1.0 + 0.3 * (1 - e^(-2*2)) = 1.0 + 0.3 * (1 - 0.018) ≈ 1.295
        expect(result.synergyMultiplier).toBeGreaterThan(1.2);
        expect(result.synergyMultiplier).toBeLessThan(1.4);
        expect(result.contributingComponents.length).toBe(3);
    });

    it('should skip synergy when minCount not met', () => {
        const entity = {
            id: 'single-comp',
            components: [
                {
                    id: 'hand-1',
                    type: 'droidHand',
                    stats: {
                        Physical: { durability: 40, strength: 25 }
                    }
                }
            ]
        };

        mockWSC._addEntity(entity);

        // Punch requires minCount: 2 of sameComponentType
        const result = controller.computeSynergy('punch', 'single-comp');

        // Only 1 droidHand, minCount is 2, so no synergy from that group
        expect(result.synergyMultiplier).toBe(1.0);
    });

    it('should apply synergy when dash has 2 droidRollingBall on same entity', () => {
        // Entity with 2 droidRollingBall components
        const entity = {
            id: 'dual-roll-droid',
            components: [
                {
                    id: 'roll-left',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 20 }
                    }
                },
                {
                    id: 'roll-right',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 20 }
                    }
                }
            ]
        };

        mockWSC._addEntity(entity);

        const result = controller.computeSynergy('dash', 'dual-roll-droid');

        // Group 1 (sameComponentType droidRollingBall, minCount=2, linear, base=1.0, bonus=0.5):
        //   2 components → 1.0 + 0.5 * (2-1) = 1.5x
        // Group 2 (movementComponents, minCount=1, linear, base=1.0, bonus=0.3):
        //   2 movement components → 1.0 + 0.3 * (2-1) = 1.3x
        // Total: 1.5 * 1.3 = 1.95x
        expect(result.synergyMultiplier).toBeCloseTo(1.95, 1);
        expect(result.contributingComponents.length).toBe(4); // 2 from each group
    });

    it('should not apply sameComponentType synergy when only 1 droidRollingBall present', () => {
        // Entity with only 1 droidRollingBall
        const entity = {
            id: 'single-roll-droid',
            components: [
                {
                    id: 'roll-1',
                    type: 'droidRollingBall',
                    stats: {
                        Physical: { durability: 120 },
                        Movement: { move: 20 }
                    }
                }
            ]
        };

        mockWSC._addEntity(entity);

        const result = controller.computeSynergy('dash', 'single-roll-droid');

        // Group 1 (sameComponentType droidRollingBall, minCount=2): SKIPPED (only 1 component)
        // Group 2 (movementComponents, minCount=1, linear, base=1.0, bonus=0.3):
        //   1 movement component → 1.0x
        // Total: 1.0 * 1.0 = 1.0x
        expect(result.synergyMultiplier).toBe(1.0);
    });
});

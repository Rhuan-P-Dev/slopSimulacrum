/**
 * RangeValidator unit tests
 * Tests range expression resolution using PlaceholderResolver.
 * 
 * @module test/unit/RangeValidator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import RangeValidator from '../../src/controllers/actions/RangeValidator.js';

// =========================================================================
// Mock WorldStateController
// =========================================================================

function createMockWorldStateController(entities = {}, componentStats = {}) {
    return {
        getEntity(id) {
            return entities[id] || null;
        },
        getComponentStats(compId) {
            return componentStats[compId] || null;
        }
    };
}

// =========================================================================
// Mock ActionController (minimal, only needed for executeRangeFailureConsequences)
// =========================================================================

function createMockActionController() {
    return {
        actionRegistry: {},
        consequenceHandlers: {
            handle() {
                return { success: true };
            }
        }
    };
}

// =========================================================================
// Tests
// =========================================================================

describe('RangeValidator - Range Expression Resolution', () => {
    let validator;
    let mockWSC;
    let mockAC;

    const mockEntities = {
        'droid-1': {
            id: 'droid-1',
            components: [
                { id: 'comp-1' },
                { id: 'comp-2' }
            ],
            spatial: { x: 0, y: 0 }
        },
        'droid-2': {
            id: 'droid-2',
            components: [
                { id: 'comp-3' }
            ],
            spatial: { x: 10, y: 10 }
        }
    };

    const mockComponentStats = {
        'comp-1': {
            Physical: { strength: 25, mass: 20, durability: 100 },
            Spatial: { x: 0, y: 0 }
        },
        'comp-2': {
            Mind: { think_level: 5 },
            Movement: { move: 20 }
        },
        'comp-3': {
            Physical: { strength: 15, mass: 10 },
            Spatial: { x: 10, y: 10 }
        }
    };

    beforeEach(() => {
        mockWSC = createMockWorldStateController(mockEntities, mockComponentStats);
        mockAC = createMockActionController();
        validator = new RangeValidator(mockWSC, mockAC);
    });

    describe('_resolveRequirementValues', () => {
        it('should build a flat stat map from all entity components', () => {
            const result = validator._resolveRequirementValues('droid-1');

            expect(result).toHaveProperty('Physical.strength', 25);
            expect(result).toHaveProperty('Physical.mass', 20);
            expect(result).toHaveProperty('Physical.durability', 100);
            expect(result).toHaveProperty('Mind.think_level', 5);
            expect(result).toHaveProperty('Movement.move', 20);
        });

        it('should return empty object for unknown entity', () => {
            const result = validator._resolveRequirementValues('unknown-entity');
            expect(result).toEqual({});
        });

        it('should return empty object for entity without components', () => {
            const result = validator._resolveRequirementValues('');
            expect(result).toEqual({});
        });
    });

    describe('checkGrabRange - literal numbers', () => {
        it('should accept a plain number range', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', 20);
            expect(result.success).toBe(true);
            expect(result.distance).toBeGreaterThan(0);
        });

        it('should fail when distance exceeds range', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', 5);
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });
    });

    describe('checkGrabRange - expression strings', () => {
        it('should resolve ":Physical.strength*2" → 50 (25*2)', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', ':Physical.strength*2');
            expect(result.success).toBe(true);
        });

        it('should resolve ":Physical.strength" → 25', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', ':Physical.strength');
            expect(result.success).toBe(true);
        });

        it('should resolve ":Physical.strength*3' + '> 14 (25*3=75 > distance~14)', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', ':Physical.strength*3');
            expect(result.success).toBe(true);
        });

        it('should resolve "-:Physical.mass" → -20, return validation error (negative range)', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', '-:Physical.mass');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid range value');
        });

        it('should resolve multi-component stat lookup (Mind.think_level=5)', () => {
            // think_level=5, distance~14 → fails
            const result = validator.checkGrabRange('droid-1', 'droid-2', ':Mind.think_level');
            expect(result.success).toBe(false);
        });

        it('should resolve Movement.move*5 → 100 (20*5)', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', ':Movement.move*5');
            expect(result.success).toBe(true);
        });

        it('should handle unknown placeholder gracefully (returns original string, fails validation)', () => {
            const result = validator.checkGrabRange('droid-1', 'droid-2', ':Unknown.stat');
            // Unknown placeholder resolves to original string, Number() → NaN, should fail
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid range value');
        });
    });

    describe('checkGrabRange - edge cases', () => {
        it('should fail for unknown source entity', () => {
            const result = validator.checkGrabRange('unknown-source', 'droid-2', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should fail for unknown target entity', () => {
            const result = validator.checkGrabRange('droid-1', 'unknown-target', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should handle numeric string (e.g., "10") as number', () => {
            // "10" is not a :T stat expression, PlaceholderResolver returns the original string
            // The Number() conversion then produces 10, but distance is 14.1, so it should fail
            const result = validator.checkGrabRange('droid-1', 'droid-2', '10');
            expect(result.success).toBe(false);
        });

        it('should handle numeric string (e.g., "20") as number (passes distance check)', () => {
            // "20" resolves to Number 20, distance is 14.1, so it should pass
            const result = validator.checkGrabRange('droid-1', 'droid-2', '20');
            expect(result.success).toBe(true);
        });
    });
});
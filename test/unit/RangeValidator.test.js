/**
 * RangeValidator unit tests
 * Tests range expression resolution using the shared RangeResolver.
 * 
 * @module test/unit/RangeValidator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import RangeValidator from '../../src/controllers/actions/RangeValidator.js';
import { resolveRange } from '../../shared/RangeResolver.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
// Mock RequirementResolver
//
// RangeValidator delegates entity-level stat-map resolution to RequirementResolver
// (Single Source of Truth, per wiki). This mock mirrors the real
// resolveEntityRequirementValues() contract: it scans the entity's components and
// flattens their trait.stat values into a "trait.stat" → number map.
// =========================================================================

function createMockRequirementResolver(worldStateController) {
    return {
        resolveEntityRequirementValues(entityId) {
            const entity = worldStateController.getEntity(entityId);
            if (!entity || !entity.components) return {};
            const values = {};
            for (const comp of entity.components) {
                const stats = worldStateController.getComponentStats(comp.id);
                if (!stats) continue;
                for (const [traitId, traitData] of Object.entries(stats)) {
                    for (const [statName, statValue] of Object.entries(traitData)) {
                        if (typeof statValue === 'number') {
                            values[`${traitId}.${statName}`] = statValue;
                        }
                    }
                }
            }
            return values;
        }
    };
}

// =========================================================================
// Mock ActionController
//
// The `consequenceHandlers` field mirrors the REAL ConsequenceHandlers contract
// (src/controllers/consequences/consequenceHandlers.js):
//   - a `handlers` GETTER that returns a map of handler functions,
//   - each handler uses the normalized signature (targetId, params, context),
//   - and there is NO `handle()` method (the previous mock invented one, which
//     does not exist on the real class and desynchronized the mock from reality).
// =========================================================================

function createMockActionController() {
    // Normalized handler signature, matching the real handlers map.
    const noopHandler = (targetId, params, context) => ({ success: true });

    const consequenceHandlers = {
        get handlers() {
            return {
                updateSpatial: noopHandler,
                deltaSpatial: noopHandler,
                log: noopHandler,
                updateStat: noopHandler,
                updateComponentStatDelta: noopHandler,
                triggerEvent: noopHandler,
                damageComponent: noopHandler,
                dropItem: noopHandler,
                pickUpItem: noopHandler,
                consumeItemAndDamage: noopHandler,
            };
        }
    };

    return {
        actionRegistry: {},
        consequenceHandlers
    };
}

// =========================================================================
// Tests
// =========================================================================

describe('RangeValidator - Range Expression Resolution', () => {
    let validator;
    let mockWSC;
    let mockAC;

    // NOTE: Entity IDs use the typed "ent-<uuid>" format — RangeValidator rejects
    // any source/target ID that is neither a typed ent-... ID nor a legacy UUID.
    const mockEntities = {
        'ent-droid-1': {
            id: 'ent-droid-1',
            components: [
                { id: 'comp-1' },
                { id: 'comp-2' }
            ],
            spatial: { x: 0, y: 0 }
        },
        'ent-droid-2': {
            id: 'ent-droid-2',
            components: [
                { id: 'comp-3' }
            ],
            spatial: { x: 10, y: 10 }
        }
    };

    const mockComponentStats = {
        'comp-1': {
            Physical: { strength: 25, mass: 20, existence: 100 },
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
        // RangeValidator delegates entity-level stat-map resolution to
        // RequirementResolver (Single Source of Truth). Inject a mock that mirrors
        // the real resolveEntityRequirementValues() contract.
        const mockRequirementResolver = createMockRequirementResolver(mockWSC);
        // FASE 5: the facade is no longer a constructor argument — it is injected
        // post-construction via setWorldStateController() (same as in production,
        // where WorldComposition calls it after the facade is fully built).
        validator = new RangeValidator(mockAC, mockRequirementResolver);
        validator.setWorldStateController(mockWSC);
    });

    describe('_resolveRequirementValues', () => {
        it('should build a flat stat map from all entity components', () => {
            const result = validator._resolveRequirementValues('ent-droid-1');

            expect(result).toHaveProperty('Physical.strength', 25);
            expect(result).toHaveProperty('Physical.mass', 20);
            expect(result).toHaveProperty('Physical.existence', 100);
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
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', 20);
            expect(result.success).toBe(true);
            expect(result.distance).toBeGreaterThan(0);
        });

        it('should fail when distance exceeds range', () => {
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', 5);
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });
    });

    describe('checkGrabRange - expression strings', () => {
        it('should resolve ":Physical.strength*2" → 50 (25*2)', () => {
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', ':Physical.strength*2');
            expect(result.success).toBe(true);
        });

        it('should resolve ":Physical.strength" → 25', () => {
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', ':Physical.strength');
            expect(result.success).toBe(true);
        });

        it('should resolve ":Physical.strength*3' + '> 14 (25*3=75 > distance~14)', () => {
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', ':Physical.strength*3');
            expect(result.success).toBe(true);
        });

        it('should resolve "-:Physical.mass" → -20, return validation error (negative range)', () => {
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', '-:Physical.mass');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid range value');
        });

        it('should resolve multi-component stat lookup (Mind.think_level=5)', () => {
            // think_level=5, distance~14 → fails
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', ':Mind.think_level');
            expect(result.success).toBe(false);
        });

        it('should resolve Movement.move*5 → 100 (20*5)', () => {
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', ':Movement.move*5');
            expect(result.success).toBe(true);
        });

        it('should handle unknown placeholder gracefully (resolves to NaN, fails validation)', () => {
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', ':Unknown.stat');
            // Unknown placeholder is unresolvable → the shared RangeResolver returns
            // checkGrabRange's fallback (NaN) → rejected as an invalid range value.
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid range value');
        });
    });

    describe('checkGrabRange - edge cases', () => {
        it('should fail for unknown source entity', () => {
            // Valid typed-ID format but not present in the world → "not found"
            const result = validator.checkGrabRange('ent-unknown-source', 'ent-droid-2', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should fail for unknown target entity', () => {
            // Valid typed-ID format but not present in the world → "not found"
            const result = validator.checkGrabRange('ent-droid-1', 'ent-unknown-target', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should handle numeric string (e.g., "10") as number', () => {
            // "10" is a plain numeric literal — the shared RangeResolver parses it to 10,
            // but distance is ~14.1, so it should fail
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', '10');
            expect(result.success).toBe(false);
        });

        it('should handle numeric string (e.g., "20") as number (passes distance check)', () => {
            // "20" resolves to Number 20, distance is 14.1, so it should pass
            const result = validator.checkGrabRange('ent-droid-1', 'ent-droid-2', '20');
            expect(result.success).toBe(true);
        });
    });
});

// =========================================================================
// checkSpatialRange — server-side spatial (coordinate) range enforcement
//
// This is the SERVER-SIDE counterpart to the client's range display for
// spatial actions like dropItem (which send targetX/targetY, not a target
// entity). It must enforce the SAME range the client renders (single source
// of truth: data/actions.json range, resolved via the shared RangeResolver).
// =========================================================================

describe('RangeValidator - checkSpatialRange (spatial drop enforcement)', () => {
    let validator;
    let mockWSC;
    let mockAC;

    // ent-droid-1 is at the origin (0,0); component comp-1 has Physical.strength 25.
    const mockEntities = {
        'ent-droid-1': {
            id: 'ent-droid-1',
            components: [{ id: 'comp-1' }],
            spatial: { x: 0, y: 0 }
        }
    };

    const mockComponentStats = {
        'comp-1': {
            Physical: { strength: 25, mass: 20, existence: 100 }
        }
    };

    beforeEach(() => {
        mockWSC = createMockWorldStateController(mockEntities, mockComponentStats);
        mockAC = createMockActionController();
        // RangeValidator delegates entity-level stat-map resolution to
        // RequirementResolver (Single Source of Truth).
        const mockRequirementResolver = createMockRequirementResolver(mockWSC);
        validator = new RangeValidator(mockAC, mockRequirementResolver);
        validator.setWorldStateController(mockWSC);
    });

    describe('plain number range', () => {
        it('should pass when the target point is at the range boundary (range 100)', () => {
            // distance from (0,0) to (60, 80) = 100 → exactly at range boundary → pass
            const result = validator.checkSpatialRange('ent-droid-1', 60, 80, 100);
            expect(result.success).toBe(true);
            expect(result.distance).toBe(100);
        });

        it('should fail when the target point is beyond range', () => {
            // distance from (0,0) to (200, 0) = 200 > 100 → out of range
            const result = validator.checkSpatialRange('ent-droid-1', 200, 0, 100);
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('should pass for a point clearly inside range', () => {
            // distance from (0,0) to (30, 40) = 50 < 100
            const result = validator.checkSpatialRange('ent-droid-1', 30, 40, 100);
            expect(result.success).toBe(true);
        });
    });

    describe('expression string range (single source of truth with client)', () => {
        it('should resolve ":Physical.strength*4" → 100 and pass at distance 100', () => {
            // strength 25 * 4 = 100; distance to (100, 0) = 100 → pass
            const result = validator.checkSpatialRange('ent-droid-1', 100, 0, ':Physical.strength*4');
            expect(result.success).toBe(true);
        });

        it('should resolve ":Physical.strength*2" → 50 and fail at distance 100', () => {
            // strength 25 * 2 = 50; distance to (100, 0) = 100 > 50 → fail
            const result = validator.checkSpatialRange('ent-droid-1', 100, 0, ':Physical.strength*2');
            expect(result.success).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('should fail for an unknown source entity', () => {
            const result = validator.checkSpatialRange('ent-unknown', 10, 10, 100);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should fail when the source entity lacks spatial data', () => {
            // ent-no-spatial is a valid typed-ID format but has no spatial data,
            // so the "lacks spatial data" guard fires before any range math.
            const noSpatialWSC = createMockWorldStateController(
                { 'ent-no-spatial': { id: 'ent-no-spatial', components: [] } },
                {}
            );
            const noSpatialValidator = new RangeValidator(
                createMockActionController(),
                createMockRequirementResolver(noSpatialWSC)
            );
            noSpatialValidator.setWorldStateController(noSpatialWSC);

            const result = noSpatialValidator.checkSpatialRange('ent-no-spatial', 10, 10, 100);
            expect(result.success).toBe(false);
            expect(result.error).toContain('lacks spatial data');
        });

        it('should fail for invalid spatial coordinates', () => {
            const result = validator.checkSpatialRange('ent-droid-1', 'x', 10, 100);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid spatial target coordinates');
        });

        it('should reject a negative resolved range (":Physical.mass" is positive, so use -mass)', () => {
            const result = validator.checkSpatialRange('ent-droid-1', 10, 10, '-:Physical.mass');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid range value');
        });

        it('should handle an unknown placeholder gracefully (NaN → invalid range)', () => {
            const result = validator.checkSpatialRange('ent-droid-1', 10, 10, ':Unknown.stat');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid range value');
        });
    });
    
    // =========================================================================
    // TEST 3 — RangeValidator.checkSpatialRange uses the SAME range as
    // data/actions.json (single source of truth).
    //
    // Regression guarded: the drop-range bug diverged the server-enforced range from
    // the client-displayed range. This test feeds the ACTUAL dropItem.range from
    // data/actions.json into the real RangeValidator and verifies the enforcement
    // boundary matches that value exactly (and that the failure message is the
    // point-target message, not the grab message).
    // =========================================================================
    
    function readDropItemRange() {
        const dataPath = new URL('../../data/actions.json', import.meta.url);
        const raw = readFileSync(fileURLToPath(dataPath), 'utf8');
        return JSON.parse(raw).dropItem.range;
    }
    
    describe('RangeValidator - checkSpatialRange uses the same range as data/actions.json', () => {
        let validator;
        let mockWSC;
        let mockAC;
        let dropRange;
    
        // ent-droid-1 is at the origin (0,0); comp-1 carries Physical.strength 25.
        const mockEntities = {
            'ent-droid-1': {
                id: 'ent-droid-1',
                components: [{ id: 'comp-1' }],
                spatial: { x: 0, y: 0 }
            }
        };
    
        const mockComponentStats = {
            'comp-1': {
                Physical: { strength: 25, mass: 20, existence: 100 }
            }
        };
    
        beforeEach(() => {
            dropRange = readDropItemRange();
            mockWSC = createMockWorldStateController(mockEntities, mockComponentStats);
            mockAC = createMockActionController();
            const mockRequirementResolver = createMockRequirementResolver(mockWSC);
            validator = new RangeValidator(mockAC, mockRequirementResolver);
            validator.setWorldStateController(mockWSC);
        });
    
        it('accepts a target point exactly at the boundary (distance === dropItem.range)', () => {
            // (dropRange, 0) → distance === dropRange. The guard is `distance > maxRange`,
            // so the boundary point is ACCEPTED — proving the enforced range is exactly
            // dropItem.range, not a smaller (diverged) value.
            const result = validator.checkSpatialRange('ent-droid-1', dropRange, 0, dropRange);
            expect(result.success).toBe(true);
            expect(result.distance).toBe(dropRange);
        });
    
        it('rejects a target point just outside the boundary (distance === dropItem.range + 1)', () => {
            const result = validator.checkSpatialRange('ent-droid-1', dropRange + 1, 0, dropRange);
            expect(result.success).toBe(false);
            expect(result.distance).toBe(dropRange + 1);
        });
    
        it('uses the point-target message "Target is too far away" (NOT the grab message)', () => {
            const result = validator.checkSpatialRange('ent-droid-1', dropRange + 1, 0, dropRange);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Target is too far away');
            // Regression guard: the spatial failure must not use the grab-target wording.
            expect(result.error).not.toContain('Item is too far away');
            expect(result.error).not.toContain('Move closer to grab it');
        });
    
        it('resolves an expression range to the same value the shared resolver produces', () => {
            // For expression ranges, the enforced boundary must equal the shared
            // resolver's value. strength 25 * 4 = 100 → a point at distance 100 passes,
            // distance 101 fails.
            const sharedResolved = resolveRange(':Physical.strength*4', { 'Physical.strength': 25 }, NaN);
            expect(sharedResolved).toBe(100);
    
            const atBoundary = validator.checkSpatialRange('ent-droid-1', sharedResolved, 0, ':Physical.strength*4');
            const outside = validator.checkSpatialRange('ent-droid-1', sharedResolved + 1, 0, ':Physical.strength*4');
            expect(atBoundary.success).toBe(true);
            expect(outside.success).toBe(false);
        });
    });
});
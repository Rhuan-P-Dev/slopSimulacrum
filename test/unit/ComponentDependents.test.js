/**
 * ComponentDependents — unit tests for `buildReverseIndex` type guard (B1-M4).
 *
 * Tests the new input guard: invalid (non-array) input yields an empty Map,
 * never a throw.  Also verifies the happy-path reverse-index construction
 * using the real component shape consumed by WorldStateController._cascadeDependents.
 *
 * Component shape (from entity.components[], see data/components.json +
 * stateEntityController spawn logic):
 *   {
 *     id: string,            // unique instance uid, e.g. 'comp-centralBall-001'
 *     type: string,          // blueprint key, e.g. 'centralBall'
 *     dependsOn: string[],   // array of parent component instance ids
 *     [traitId: string]: { ...traits }  // Physical, Spatial, etc.
 *   }
 *
 * @module test/unit/ComponentDependents
 */

import { describe, it, expect } from 'vitest';
import { buildReverseIndex } from '../../src/utils/ComponentDependents.js';

// =========================================================================
// Helpers — real component shape (mimics entity.components built by spawn)
// =========================================================================

/**
 * Build a minimal realistic components array:
 *   centralBall (id: "cb-1") ← no dependencies
 *   droidArm    (id: "arm-1") ← dependsOn: ["cb-1"]
 *   droidHand   (id: "hand-1")← dependsOn: ["arm-1"]
 *
 * Reverse index expected:
 *   "cb-1"  → ["arm-1"]
 *   "arm-1" → ["hand-1"]
 *   "hand-1"→ []  (leaf, no dependents)
 *   "other-parent" → []  (orphan edge — exists as dependsOn target but not a component id itself)
 */
function buildRealComponents() {
    return [
        {
            id: 'cb-1',
            type: 'centralBall',
            dependsOn: []
        },
        {
            id: 'arm-1',
            type: 'droidArm',
            dependsOn: ['cb-1']
        },
        {
            id: 'hand-1',
            type: 'droidHand',
            dependsOn: ['arm-1']
        }
    ];
}

// =========================================================================
// Test A — happy-path: valid components array → correct reverse index
// =========================================================================

describe('buildReverseIndex — happy path (valid array)', () => {
    it('returns a Map with correct reverse-index entries for a realistic component chain', () => {
        const components = buildRealComponents();
        const result = buildReverseIndex(components);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBeGreaterThan(0);

        // cb-1 should have arm-1 as dependent
        expect(result.get('cb-1')).toEqual(['arm-1']);

        // arm-1 should have hand-1 as dependent
        expect(result.get('arm-1')).toEqual(['hand-1']);

        // hand-1 is a leaf — no dependents (empty array)
        expect(result.get('hand-1')).toEqual([]);
    });

    it('includes orphan parent ids in the map (dependsOn target that is not a component id)', () => {
        const components = [
            {
                id: 'child-1',
                type: 'droidHand',
                dependsOn: ['orphan-parent-1'] // orphan-parent-1 does NOT exist as a component id
            }
        ];

        const result = buildReverseIndex(components);

        expect(result).toBeInstanceOf(Map);
        // The function creates an entry for the orphan parent (line 36-38 in ComponentDependents.js)
        expect(result.has('orphan-parent-1')).toBe(true);
        expect(result.get('orphan-parent-1')).toEqual(['child-1']);
    });

    it('handles an empty components array', () => {
        const result = buildReverseIndex([]);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });

    it('handles self-dependency (A.dependsOn contains A.id)', () => {
        const components = [
            {
                id: 'self-1',
                type: 'centralBall',
                dependsOn: ['self-1']
            }
        ];

        const result = buildReverseIndex(components);

        expect(result).toBeInstanceOf(Map);
        // self-1 should appear as a dependent of itself
        expect(result.get('self-1')).toEqual(['self-1']);
    });
});

// =========================================================================
// Test B — null input → empty Map, no throw
// =========================================================================

describe('buildReverseIndex — null input guard (B1-M4)', () => {
    it('returns an empty Map when input is null', () => {
        expect(() => buildReverseIndex(null)).not.toThrow();
        const result = buildReverseIndex(null);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });
});

// =========================================================================
// Test C — undefined input → empty Map, no throw
// =========================================================================

describe('buildReverseIndex — undefined input guard (B1-M4)', () => {
    it('returns an empty Map when input is undefined', () => {
        expect(() => buildReverseIndex(undefined)).not.toThrow();
        const result = buildReverseIndex(undefined);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });
});

// =========================================================================
// Test D — non-array object → empty Map, no throw
// =========================================================================

describe('buildReverseIndex — non-array object guard (B1-M4)', () => {
    it('returns an empty Map when input is a plain object', () => {
        expect(() => buildReverseIndex({ foo: 1 })).not.toThrow();
        const result = buildReverseIndex({ foo: 1 });

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });

    it('returns an empty Map when input is a string', () => {
        expect(() => buildReverseIndex('not-an-array')).not.toThrow();
        const result = buildReverseIndex('not-an-array');

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });

    it('returns an empty Map when input is a number', () => {
        expect(() => buildReverseIndex(42)).not.toThrow();
        const result = buildReverseIndex(42);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });

    it('returns an empty Map when input is a boolean', () => {
        expect(() => buildReverseIndex(true)).not.toThrow();
        const result = buildReverseIndex(true);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });
});

/**
 * Unit tests for ComponentController.getComponentDefinition() (L2).
 *
 * A state controller must return defensive deep copies from public getters so a
 * caller can never mutate the internal registry through the reference. This pins
 * that getComponentDefinition() hands out a fresh deep copy (not a live reference)
 * and still returns null for unknown types.
 *
 * @module test/unit/componentController
 */

import { describe, it, expect } from 'vitest';
import ComponentController from '../../src/controllers/core/componentController.js';

/** Build a ComponentController with stub sub-controllers and a real registry. */
function makeController(registry) {
    return new ComponentController(
        {},
        {},
        registry
    );
}

describe('ComponentController.getComponentDefinition()', () => {
    const registry = {
        droidHand: {
            name: 'Droid Hand',
            form: { volume: 4 },
            traits: { Physical: { volume: 4 } },
            materials: [{ material: 'iron', fraction: 0.7 }, { material: 'wood', fraction: 0.3 }]
        }
    };

    it('returns null for an unknown type', () => {
        expect(makeController(registry).getComponentDefinition('nonexistent')).toBeNull();
    });

    it('returns a deep copy (mutating the result never touches the registry)', () => {
        const cc = makeController(registry);
        const first = cc.getComponentDefinition('droidHand');
        expect(first).not.toBeNull();

        // Mutate the returned object deeply: top-level, nested object, nested array item.
        first.name = 'MUTATED';
        first.form.volume = 999;
        first.traits.Physical.volume = 888;
        first.materials[0].material = 'MUTATED';
        first.materials[0].fraction = -1;

        // A second call must return pristine values.
        const second = cc.getComponentDefinition('droidHand');
        expect(second.name).toBe('Droid Hand');
        expect(second.form.volume).toBe(4);
        expect(second.traits.Physical.volume).toBe(4);
        expect(second.materials[0].material).toBe('iron');
        expect(second.materials[0].fraction).toBe(0.7);

        // The two results must not share references (a deep copy, not a shallow one).
        expect(second).not.toBe(first);
        expect(second.materials).not.toBe(first.materials);
        expect(second.materials[0]).not.toBe(first.materials[0]);
        expect(second.form).not.toBe(first.form);
    });
});

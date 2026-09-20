/**
 * EntityAttributeBars (CLIENT) tests.
 *
 * The whole-entity attribute bars (e.g. the M1 droid's `Physical.energy`)
 * render from the entity's `attributes` (live) + `attributesConfig`
 * (declaration) that ride on the entity in the broadcast world state. They are
 * distinct from the per-component stat bars in StatBarsManager.
 *
 * Smoke-tested with a minimal DOM stub (the house pattern for client
 * controllers — no jsdom): enough element shape for the bars to bind a
 * container and rewrite its innerHTML. Pins:
 *   - init binds the #entity-attributes-container element;
 *   - updateAll renders a bar per DECLARED attribute that has a display entry
 *     (currently only Physical.energy), with the correct value / max / fill;
 *   - an attribute without a display entry is NOT rendered (data-driven gate);
 *   - the low-energy class is applied at <= 20% fill;
 *   - no droid / no declarations -> the empty placeholder.
 *
 * @module test/unit/EntityAttributeBars.client
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EntityAttributeBars } from '../../public/js/EntityAttributeBars.js';
import {
    getEntityAttribute,
    getEntityAttributeConfig,
    ATTRIBUTE_DISPLAY,
} from '../../public/js/EntityAttributeData.js';

// =========================================================================
// Minimal DOM stub (house pattern for client controllers — no jsdom)
// =========================================================================

function makeElement(id = '') {
    return {
        id,
        innerHTML: '',
        textContent: '',
        value: '',
        style: {},
        children: [],
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); },
        },
        addEventListener() {},
        removeEventListener() {},
        appendChild(child) { this.children.push(child); return child; },
    };
}

let container;

function makeDom() {
    container = makeElement('entity-attributes-container');
    globalThis.document = {
        getElementById: (id) => (id === 'entity-attributes-container' ? container : null),
        createElement: (tag) => makeElement(tag),
    };
    return container;
}

/** A WorldStateManager stub returning a fixed active droid. */
function makeWorldStateManager(droid) {
    return {
        getActiveDroid: () => droid || null,
        getMyEntityId: () => (droid ? droid.id : null),
        getState: () => ({ entities: droid ? { [droid.id]: droid } : {} }),
    };
}

/** The M1 droid shape: an energy attribute + its declaration. */
function makeDroid(energy = 100) {
    return {
        id: 'ent-1',
        blueprint: 'm1Droid',
        attributes: { Physical: { energy } },
        attributesConfig: { Physical: { energy: { value: 100, max: 100, drainPerTurn: 1 } } },
    };
}

beforeEach(() => {
    makeDom();
});

afterEach(() => {
    delete globalThis.document;
    container = null;
});

// =========================================================================
// EntityAttributeData helpers
// =========================================================================

describe('EntityAttributeData', () => {
    it('ATTRIBUTE_DISPLAY declares the energy attribute (label/color/icon)', () => {
        expect(ATTRIBUTE_DISPLAY['Physical.energy']).toBeDefined();
        expect(ATTRIBUTE_DISPLAY['Physical.energy'].label).toBe('Energy');
        expect(ATTRIBUTE_DISPLAY['Physical.energy'].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it('getEntityAttribute reads the live value (null-safe)', () => {
        const droid = makeDroid(42);
        expect(getEntityAttribute(droid, 'Physical', 'energy')).toBe(42);
        expect(getEntityAttribute(null, 'Physical', 'energy')).toBeNull();
        expect(getEntityAttribute({ attributes: {} }, 'Physical', 'energy')).toBeNull();
        expect(getEntityAttribute({ attributes: {} }, 'Mind', 'energy')).toBeNull();
    });

    it('getEntityAttributeConfig reads the declaration (null-safe)', () => {
        const droid = makeDroid();
        expect(getEntityAttributeConfig(droid, 'Physical', 'energy')).toEqual({
            value: 100, max: 100, drainPerTurn: 1,
        });
        expect(getEntityAttributeConfig(null, 'Physical', 'energy')).toBeNull();
        expect(getEntityAttributeConfig({ attributesConfig: {} }, 'Physical', 'energy')).toBeNull();
    });
});

// =========================================================================
// EntityAttributeBars rendering
// =========================================================================

describe('EntityAttributeBars', () => {
    it('init binds the container element', () => {
        const bars = new EntityAttributeBars(makeWorldStateManager(makeDroid()));
        bars.init();
        expect(container.innerHTML, 'container is bound and starts empty').toBe('');
    });

    it('renders the energy bar with value / max / 100% fill at full capacity', () => {
        const bars = new EntityAttributeBars(makeWorldStateManager(makeDroid(100)));
        bars.init();
        bars.updateAll({ entities: { 'ent-1': makeDroid(100) } });

        expect(container.innerHTML).toContain('entity-attribute-bar');
        expect(container.innerHTML).toContain('Energy');
        expect(container.innerHTML).toContain('100 / 100');
        expect(container.innerHTML).toContain('width: 100%');
        expect(container.innerHTML).not.toContain('entity-attribute-bar--low');
    });

    it('reflects a lowered energy value with the matching fill percentage', () => {
        const droid = makeDroid(100);
        const bars = new EntityAttributeBars(makeWorldStateManager(droid));
        bars.init();
        droid.attributes.Physical.energy = 50;
        bars.updateAll({ entities: { 'ent-1': droid } });

        expect(container.innerHTML).toContain('50 / 100');
        expect(container.innerHTML).toContain('width: 50%');
        expect(container.innerHTML).not.toContain('entity-attribute-bar--low');
    });

    it('applies the low-energy class at <= 20% fill', () => {
        const droid = makeDroid(100);
        const bars = new EntityAttributeBars(makeWorldStateManager(droid));
        bars.init();
        droid.attributes.Physical.energy = 10; // 10% -> low
        bars.updateAll({ entities: { 'ent-1': droid } });

        expect(container.innerHTML).toContain('entity-attribute-bar--low');
        expect(container.innerHTML).toContain('width: 10%');
    });

    it('clamps the fill to 100% when the value exceeds the declared max', () => {
        const droid = makeDroid(100);
        droid.attributes.Physical.energy = 150; // over-max (defensive)
        const bars = new EntityAttributeBars(makeWorldStateManager(droid));
        bars.init();
        bars.updateAll({ entities: { 'ent-1': droid } });

        expect(container.innerHTML).toContain('width: 100%');
    });

    it('only renders attributes that have a display entry (data-driven gate)', () => {
        const droid = makeDroid(100);
        // An extra attribute with NO display entry must not be rendered.
        droid.attributes.Physical.thrust = 50;
        droid.attributesConfig.Physical.thrust = { value: 50, max: 50, drainPerTurn: 2 };
        const bars = new EntityAttributeBars(makeWorldStateManager(droid));
        bars.init();
        bars.updateAll({ entities: { 'ent-1': droid } });

        expect(container.innerHTML).toContain('Energy');
        expect(container.innerHTML).not.toContain('thrust');
    });

    it('renders the empty placeholder when the droid declares no attributes', () => {
        const droid = { id: 'ent-1', blueprint: 'm1Droid' };
        const bars = new EntityAttributeBars(makeWorldStateManager(droid));
        bars.init();
        bars.updateAll({ entities: { 'ent-1': droid } });

        expect(container.innerHTML).toContain('No entity attributes declared');
    });

    it('renders the empty placeholder when there is no active droid', () => {
        const bars = new EntityAttributeBars(makeWorldStateManager(null));
        bars.init();
        bars.updateAll({ entities: {} });

        expect(container.innerHTML).toContain('No entity attributes declared');
    });

    it('re-renders on every update (value transitions are reflected)', () => {
        const droid = makeDroid(100);
        const bars = new EntityAttributeBars(makeWorldStateManager(droid));
        bars.init();
        bars.updateAll({ entities: { 'ent-1': droid } });
        expect(container.innerHTML).toContain('100 / 100');

        droid.attributes.Physical.energy = 33;
        bars.updateAll({ entities: { 'ent-1': droid } });
        expect(container.innerHTML).toContain('33 / 100');
        expect(container.innerHTML).toContain('width: 33%');
    });
});

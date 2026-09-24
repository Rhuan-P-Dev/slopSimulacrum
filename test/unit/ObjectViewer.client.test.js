/**
 * ObjectViewer client shaper tests (wiki/subMDs/frontend/object_viewer.md).
 *
 * The panel's rendering logic is a set of pure functions of the payload
 * (normalizeObjectPayload / inventoryLine / productionLine / existenceLabel
 * / componentUsedVolume / buildMoveOptions / renderMovePickerHTML).
 * These tests pin:
 *   - normalization is defensive: null/garbage input degrades to the
 *     fetch-failure state (null), partial input degrades field-by-field to
 *     empty defaults — never an exception;
 *   - the production sentence: the active case (rate + storage + overflow
     note) and the two halted cases (organ broken / host broken);
 *   - the inventory line and existence label formatting;
 *   - the move-picker shapers: per-component used-volume sums, the option
 *     states (current host disabled, no-free-volume disabled as advisory
 *     preview, unbounded components always accept, exact-fit boundary),
 *     and the picker HTML (state classes, result line, escapeHtml on every
 *     interpolated value).
 *
 * @module test/unit/ObjectViewer.client
 */

import { describe, it, expect } from 'vitest';
import ObjectViewer, { normalizeObjectPayload, inventoryLine, productionLine, existenceLabel, componentUsedVolume, buildMoveOptions, renderMovePickerHTML, buildTakeOptions, renderTakePickerHTML } from '../../public/js/ObjectViewer.js';

/** A representative full payload (the knife generator at r3). */
const PAYLOAD = {
    entity: { id: 'gen-1', name: 'Knife Generator', isStatic: true, spatial: { x: -80, y: 0 }, roomName: 'Entrance Hall' },
    components: [
        {
            id: 'comp-1', type: 'generatorCore', existence: 1, broken: false, volume: 10,
            stats: { Physical: { existence: 1, volume: 10, sharpness: 5 } },
            internalComponents: [
                { id: 'ic-1', type: 'knifeGeneratorIC', broken: false, description: 'Every 1 turn, produces 1 knife.' }
            ]
        }
    ],
    items: [
        { id: 'i-1', type: 'knife', name: 'Knife', description: 'A sharp blade.', volume: 1, hostComponentId: 'comp-1' },
        { id: 'i-2', type: 'knife', name: 'Knife', description: 'A sharp blade.', volume: 1, hostComponentId: 'comp-1' },
        { id: 'i-3', type: 'knife', name: 'Knife', description: 'A sharp blade.', volume: 1, hostComponentId: 'comp-1' }
    ],
    inventory: { used: 3, capacity: 10, percent: 30 },
    production: [
        {
            organType: 'knifeGeneratorIC', itemKey: 'knife', itemName: 'Knife',
            countPerTurn: 1, intervalTurns: 1, active: true,
            organBroken: false, hostBroken: false, stored: 3, capacity: 10
        }
    ]
};

describe('normalizeObjectPayload', () => {
    it('returns null for null / undefined / non-object input (the fetch-failure state)', () => {
        expect(normalizeObjectPayload(null)).toBeNull();
        expect(normalizeObjectPayload(undefined)).toBeNull();
        expect(normalizeObjectPayload('garbage')).toBeNull();
        expect(normalizeObjectPayload(42)).toBeNull();
        expect(normalizeObjectPayload([])).toBeNull();
    });

    it('normalizes a well-formed payload into the render shape', () => {
        const p = normalizeObjectPayload(PAYLOAD);
        expect(p.entity.name).toBe('Knife Generator');
        expect(p.entity.isStatic).toBe(true);
        expect(p.components[0].type).toBe('generatorCore');
        expect(p.components[0].stats.Physical.sharpness).toBe(5);
        expect(p.components[0].internalComponents[0].description).toBe('Every 1 turn, produces 1 knife.');
        expect(p.items).toHaveLength(3);
        expect(p.items[0].name).toBe('Knife');
        expect(p.items[0].hostComponentId).toBe('comp-1');
        expect(p.inventory).toEqual({ used: 3, capacity: 10, percent: 30 });
        expect(p.production[0]).toMatchObject({ itemName: 'Knife', countPerTurn: 1, intervalTurns: 1, active: true, stored: 3 });
    });

    it('degrades missing sections to empty structures instead of throwing', () => {
        const p = normalizeObjectPayload({});
        expect(p).not.toBeNull();
        expect(p.entity.name).toBe('Unknown object');
        expect(p.components).toEqual([]);
        expect(p.items).toEqual([]);
        expect(p.inventory).toEqual({ used: 0, capacity: 0, percent: 0 });
        expect(p.production).toEqual([]);
    });

    it('filters malformed rows out of the arrays (defensive, per row)', () => {
        const p = normalizeObjectPayload({
            components: [{ type: 'x' }, null, 'junk'],
            items: [{ type: 'knife' }, 7],
            production: [{ organType: 'knifeGeneratorIC' }, null]
        });
        expect(p.components).toHaveLength(1);
        expect(p.items).toHaveLength(1);
        expect(p.items[0].name, 'falls back to the type when name is absent').toBe('knife');
        expect(p.items[0].hostComponentId, 'absent host degrades to null').toBeNull();
        expect(p.production).toHaveLength(1);
        expect(p.production[0].active, 'defaults to active when the flag is absent').toBe(true);
    });
});

describe('inventoryLine', () => {
    it('formats used/capacity + percent', () => {
        expect(inventoryLine({ used: 3, capacity: 10, percent: 30 })).toBe('3/10 volume (30%)');
        expect(inventoryLine({ used: 10, capacity: 10, percent: 100 })).toBe('10/10 volume (100%)');
    });

    it('degrades on a missing input', () => {
        expect(inventoryLine(null)).toBe('No capacity');
    });
});

describe('productionLine', () => {
    it('active, singular: rate + storage + overflow note', () => {
        const line = productionLine(PAYLOAD.production[0]);
        expect(line).toBe('Produces 1 Knife every 1 turn — 3/10 stored; when full, extras drop on the floor.');
    });

    it('active, plural interval: "every 3 turns"', () => {
        const line = productionLine({
            ...PAYLOAD.production[0], countPerTurn: 2, intervalTurns: 3, itemName: 'Coal', stored: 5, capacity: 0
        });
        expect(line).toBe('Produces 2 Coal every 3 turns — stored.');
    });

    it('halted: organ broken names the organ', () => {
        const line = productionLine({ ...PAYLOAD.production[0], active: false, organBroken: true, organType: 'knifeGeneratorIC' });
        expect(line).toBe('Production halted — the knifeGeneratorIC organ is broken.');
    });

    it('halted: host broken (organ fine)', () => {
        const line = productionLine({ ...PAYLOAD.production[0], active: false, organBroken: false, hostBroken: true });
        expect(line).toBe('Production halted — the host component is destroyed.');
    });

    it('degrades on null input', () => {
        expect(productionLine(null)).toBe('Production halted.');
    });
});

describe('existenceLabel', () => {
    it('formats a 0–1 ratio as a percentage', () => {
        expect(existenceLabel(1)).toBe('100%');
        expect(existenceLabel(0.923)).toBe('92%');
        expect(existenceLabel(0)).toBe('0%');
    });

    it('returns a dash for an absent value', () => {
        expect(existenceLabel(null)).toBe('—');
        expect(existenceLabel(undefined)).toBe('—');
    });
});

describe('componentUsedVolume', () => {
    it('sums the volumes of items hosted on one component', () => {
        const items = [
            { id: 'i-1', volume: 2, hostComponentId: 'a' },
            { id: 'i-2', volume: 3, hostComponentId: 'b' },
            { id: 'i-3', volume: 1, hostComponentId: 'a' }
        ];
        expect(componentUsedVolume(items, 'a')).toBe(3);
        expect(componentUsedVolume(items, 'b')).toBe(3);
        expect(componentUsedVolume(items, 'c')).toBe(0);
    });

    it('treats missing volumes and bad input as zero (defensive)', () => {
        expect(componentUsedVolume([{ id: 'x', volume: null, hostComponentId: 'a' }], 'a')).toBe(0);
        expect(componentUsedVolume(null, 'a')).toBe(0);
        expect(componentUsedVolume('junk', 'a')).toBe(0);
    });
});

describe('buildMoveOptions', () => {
    const components = [
        { id: 'c1', type: 'core', volume: 10 },
        { id: 'c2', type: 'shell', volume: 4 },
        { id: 'c3', type: 'satchel', volume: null }
    ];
    const items = [
        { id: 'i-1', name: 'Knife', volume: 3, hostComponentId: 'c1', description: null },
        { id: 'i-2', name: 'Crate', volume: 4, hostComponentId: 'c2', description: null }
    ];

    it('lists one option per component, marking the current host disabled', () => {
        const opts = buildMoveOptions(items[0], items, components);
        expect(opts).toHaveLength(3);
        const current = opts.find((o) => o.id === 'c1');
        expect(current.current).toBe(true);
        expect(current.disabled).toBe(true);
    });

    it('disables a full component (no free volume) and labels capacities', () => {
        const opts = buildMoveOptions(items[0], items, components);
        // c2 holds 4 of 4 vol — the knife (3 vol) does not fit.
        const full = opts.find((o) => o.id === 'c2');
        expect(full.disabled).toBe(true);
        expect(full.capacityLabel).toBe('4/4 vol');
        // c1 holds the knife itself (3 of 10).
        expect(opts.find((o) => o.id === 'c1').capacityLabel).toBe('3/10 vol');
    });

    it('enables an exact-fit move (used + volume === capacity)', () => {
        const item = { id: 'i-9', name: 'Slat', volume: 7, hostComponentId: 'c-elsewhere', description: null };
        const opts = buildMoveOptions(item, items, [components[0]]);
        expect(opts[0].disabled).toBe(false);
    });

    it('treats null/zero capacity as unbounded (always accepts)', () => {
        const opts = buildMoveOptions(items[0], items, components);
        const unbounded = opts.find((o) => o.id === 'c3');
        expect(unbounded.disabled).toBe(false);
        expect(unbounded.capacityLabel).toBe('unbounded');
        const zero = buildMoveOptions(items[0], items, [{ id: 'c4', type: 'frame', volume: 0 }]);
        expect(zero[0].disabled).toBe(false);
        expect(zero[0].capacityLabel).toBe('unbounded');
    });

    it('degrades on bad input (never throws)', () => {
        expect(buildMoveOptions(null, null, null)).toEqual([]);
        expect(buildMoveOptions(items[0], 'junk', 'not-an-array')).toEqual([]);
    });
});

describe('renderMovePickerHTML', () => {
    const item = { id: 'i-1', name: 'Knife' };
    const options = [
        { id: 'c1', type: 'core', current: true, disabled: true, capacityLabel: '3/10 vol' },
        { id: 'c2', type: 'shell', current: false, disabled: true, capacityLabel: '4/4 vol' },
        { id: 'c3', type: 'satchel', current: false, disabled: false, capacityLabel: 'unbounded' }
    ];

    it('renders one option per component with its data-comp-id and state class', () => {
        const html = renderMovePickerHTML(item, options, null);
        expect(html).toContain('data-item-id="i-1"');
        expect(html).toContain('data-comp-id="c1"');
        expect(html).toContain('data-comp-id="c3"');
        expect(html).toContain('ov-move-option is-current');
        expect(html).toContain('ov-move-option is-full');
        expect(html).toContain('ov-move-close');
        expect(html).toContain('(current)');
        expect(html).toContain('not enough volume');
        expect(html).not.toContain('ov-move-error');
    });

    it('renders the result line with its outcome class', () => {
        const ok = renderMovePickerHTML(item, options, { ok: true, text: 'Moved.' });
        expect(ok).toContain('ov-move-ok');
        expect(ok).toContain('Moved.');
        const err = renderMovePickerHTML(item, options, { ok: false, text: 'Target component c2 does not have enough volume.' });
        expect(err).toContain('ov-move-error');
        expect(err).toContain('does not have enough volume');
    });

    it('escapes every interpolated value (XSS guard)', () => {
        const hostile = renderMovePickerHTML(
            { id: 'i-1', name: '<img src=x onerror=alert(1)>' },
            [{ id: 'c-x', type: '<script>', current: false, disabled: false, capacityLabel: 'a"b' }],
            null
        );
        expect(hostile).not.toContain('<img src=x');
        expect(hostile).not.toContain('<script>');
    });
});

describe('ObjectViewer._renderInventory — item row interactivity', () => {
    function renderInventory(inventory, items, components, moveTarget = null, moveMessage = null) {
        const stub = { _moveTarget: moveTarget, _moveMessage: moveMessage, _renderComponentCard: () => '' };
        return ObjectViewer.prototype._renderInventory.call(stub, inventory, items, components);
    }

    const INV = { used: 10, capacity: 10, percent: 100 };
    const ITEMS = [
        { id: 'i-1', name: 'Knife', volume: 1, description: null, hostComponentId: 'c1' },
        { id: 'i-2', name: 'Knife', volume: 1, description: null, hostComponentId: 'c1' }
    ];

    it('makes every item row movable on a single-component object (the knife generator case)', () => {
        const html = renderInventory(INV, ITEMS, [{ id: 'c1', type: 'core', volume: 10 }]);
        const rows = html.match(/<div class="[^"]*ov-item-row[^"]*"[^>]*>/g) || [];
        expect(rows).toHaveLength(2);
        for (const r of rows) {
            expect(r).toContain('ov-item-movable');
            expect(r).toContain('data-item-id=');
        }
    });

    it('keeps rows non-interactive only when the object has no components at all', () => {
        const html = renderInventory(INV, ITEMS, []);
        const rows = html.match(/<div class="[^"]*ov-item-row[^"]*"[^>]*>/g) || [];
        expect(rows).toHaveLength(2);
        expect(rows.join(' ')).not.toContain('ov-item-movable');
    });

    it('opens a one-option picker (the current host, inert) for a single-component object', () => {
        const html = renderInventory(INV, ITEMS, [{ id: 'c1', type: 'core', volume: 10 }], 'i-1');
        expect(html).toContain('ov-move-picker');
        expect(html).toContain('data-item-id="i-1"');
        const options = html.match(/data-comp-id=/g) || [];
        expect(options).toHaveLength(1);
        expect(html).toContain('ov-move-option is-current');
        expect(html).toContain('(current)');
    });
});

// =========================================================================
// buildTakeOptions / renderTakePickerHTML (the cross-entity take picker)
// =========================================================================

describe('buildTakeOptions — take picker option matrix', () => {
    const droid = { id: 'droid-1', name: 'Small Ball Droid', components: [
        { id: 'cb-1', type: 'centralBall', used: 0, capacity: 10 },
        { id: 'limb-1', type: 'limb', used: 8, capacity: 8 }
    ] };
    const other = { id: 'drone-1', name: 'Crafter Drone', components: [
        { id: 'core-1', type: 'droneCore', used: 9, capacity: null }
    ] };

    it('builds one option per component of every offered entity', () => {
        const out = buildTakeOptions([droid, other], 1);
        expect(out).toHaveLength(3);
        expect(out[0]).toEqual({
            entityId: 'droid-1', entityName: 'Small Ball Droid',
            id: 'cb-1', type: 'centralBall', disabled: false, capacityLabel: '0/10 vol'
        });
        expect(out[1].disabled).toBe(true); // limb is full (8/8)
        expect(out[2]).toEqual({
            entityId: 'drone-1', entityName: 'Crafter Drone',
            id: 'core-1', type: 'droneCore', disabled: false, capacityLabel: 'unbounded'
        });
    });

    it('treats null capacity as unbounded (always fits) and exact-fit as valid', () => {
        const unbounded = { id: 'd1', name: 'D', components: [{ id: 'c1', type: 't', used: 99, capacity: null }] };
        expect(buildTakeOptions([unbounded], 50)[0].disabled).toBe(false);

        const exact = { id: 'd2', name: 'D', components: [{ id: 'c2', type: 't', used: 9, capacity: 10 }] };
        expect(buildTakeOptions([exact], 1)[0].disabled, 'used + vol == capacity fits').toBe(false);
        expect(buildTakeOptions([exact], 2)[0].disabled, 'used + vol > capacity does not').toBe(true);
    });

    it('degrades garbage input to an empty option list (never throws)', () => {
        expect(buildTakeOptions(null, 1)).toEqual([]);
        expect(buildTakeOptions(undefined, 1)).toEqual([]);
        expect(buildTakeOptions([{ id: '', components: [{ id: 'c', type: 't' }] }, null, 5], 1)).toEqual([]);
        expect(buildTakeOptions([{ id: 'd', name: null, components: [{ id: null }] }], null)).toEqual([]);
    });
});

describe('renderTakePickerHTML — the take picker sub-panel', () => {
    it('renders one option row per destination with entity/component ids and a capacity label', () => {
        const html = renderTakePickerHTML(
            { id: 'knife-1', name: 'Knife' },
            buildTakeOptions([{ id: 'droid-1', name: 'Small Ball Droid', components: [
                { id: 'cb-1', type: 'centralBall', used: 0, capacity: 10 }]}], 1),
            null
        );
        expect(html).toContain('ov-take-picker');
        expect(html).toContain('data-item-id="knife-1"');
        expect(html).toContain('Take Knife — choose where it goes');
        expect(html).toContain('data-entity-id="droid-1"');
        expect(html).toContain('data-comp-id="cb-1"');
        expect(html).toContain('Small Ball Droid → centralBall');
        expect(html).toContain('0/10 vol');
        expect(html).toContain('ov-move-close');
    });

    it('marks a full destination disabled and renders the explanatory empty state', () => {
        const full = renderTakePickerHTML(
            { id: 'knife-1', name: 'Knife' },
            [{ entityId: 'droid-1', entityName: 'D', id: 'cb-1', type: 'centralBall', disabled: true, capacityLabel: '10/10 vol' }],
            null
        );
        expect(full).toContain('ov-move-option is-full ov-take-option');
        expect(full).toContain('not enough volume');

        const empty = renderTakePickerHTML({ id: 'k', name: 'K' }, [], null);
        expect(empty).toContain('No entities in this world can receive items');
    });

    it('renders the result line (ok and error) and escapes interpolated values', () => {
        const ok = renderTakePickerHTML({ id: 'k', name: 'K' }, [], { ok: true, text: 'Taken' });
        expect(ok).toContain('ov-move-ok');
        expect(ok).toContain('Taken');

        const err = renderTakePickerHTML({ id: 'k', name: 'K' }, [], { ok: false, text: 'Server says no' });
        expect(err).toContain('ov-move-error');

        const xss = renderTakePickerHTML(
            { id: 'k', name: '<img src=x onerror=alert(1)>' },
            [{ entityId: 'd', entityName: 'D<script>', id: 'c', type: 't', disabled: false, capacityLabel: '0/1' }],
            null
        );
        expect(xss).not.toContain('<script>');
        expect(xss).not.toContain('<img');
        expect(xss).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
});

describe('normalizeObjectPayload — takeOptions normalization', () => {
    it('passes through well-formed take options and degrades garbage per field', () => {
        const norm = normalizeObjectPayload({
            takeOptions: [
                { id: 'd1', name: 'Droid', components: [{ id: 'c1', type: 'centralBall', used: 2, capacity: 10 }] },
                { id: '', name: 'no id', components: [] },
                null,
                { components: [{ id: 'c2' }] }
            ]
        });
        // The null, the empty-id and the missing-id entries are all dropped;
        // only the well-formed droid survives.
        expect(norm.takeOptions).toHaveLength(1);
        expect(norm.takeOptions[0]).toEqual({
            id: 'd1', name: 'Droid',
            components: [{ id: 'c1', type: 'centralBall', used: 2, capacity: 10 }]
        });
        expect(norm.takeOptions.every(t => t.id)).toBe(true);
    });

    it('defaults to an empty list when the field is absent', () => {
        expect(normalizeObjectPayload({}).takeOptions).toEqual([]);
    });
});

// =========================================================================
// Range gate (wiki/subMDs/frontend/object_viewer.md §7–8) — the actor
// behind the panel's mutations. Pure surface only: the normalizer's
// spatial pass-through and the class-level distance helper
// (_distanceToActor is a function of the registered actor and the
// normalized payload — no DOM needed).
// =========================================================================

describe('range gate — actor registration and distance', () => {
    const payload = normalizeObjectPayload(PAYLOAD); // the generator at (-80, 0)

    it('the normalizer preserves a spatial point and drops garbage', () => {
        expect(payload.entity.spatial).toEqual({ x: -80, y: 0 });
        expect(normalizeObjectPayload({ entity: { id: 'e1', name: 'X', spatial: 'not-a-point' } }).entity.spatial).toBeNull();
        expect(normalizeObjectPayload({ entity: { id: 'e1', name: 'X' } }).entity.spatial).toBeNull();
    });

    it('setActor registers and clears; _distanceToActor measures actor→object', () => {
        const viewer = new ObjectViewer();
        // No actor registered → distance unknown (null).
        expect(viewer._distanceToActor(payload)).toBeNull();

        // A droid at the origin is 80 units from the generator at (-80, 0).
        viewer.setActor({ id: 'ent-1', spatial: { x: 0, y: 0 } });
        expect(viewer._distanceToActor(payload)).toBe(80);

        // On top of the object → 0.
        viewer.setActor({ id: 'ent-1', spatial: { x: -80, y: 0 } });
        expect(viewer._distanceToActor(payload)).toBe(0);

        // Garbage actor shapes are dropped (the panel degrades to ungated).
        viewer.setActor({ id: 'ent-1' });
        expect(viewer._distanceToActor(payload)).toBeNull();
        viewer.setActor({ id: 'ent-1', spatial: { x: 0 } });
        expect(viewer._distanceToActor(payload)).toBeNull();
        viewer.setActor(null);
        expect(viewer._distanceToActor(payload)).toBeNull();
    });

    it('_renderInventory: out of range renders the banner with inert rows', () => {
        const viewer = new ObjectViewer();
        const outHtml = viewer._renderInventory(payload.inventory, payload.items, payload.components, [], true);
        expect(outHtml).toContain('ov-range-note');
        expect(outHtml).not.toContain('ov-item-movable');

        const inHtml = viewer._renderInventory(payload.inventory, payload.items, payload.components, [], false);
        expect(inHtml).not.toContain('ov-range-note');
        expect(inHtml).toContain('ov-item-movable');
    });
});

/**
 * ViewController unit tests (the generic GET /view/:id reader).
 *
 * Covers, with a hand-built facade (no live world):
 *   - the entity node (entity record + per-component nodes + inventory totals);
 *   - the clothing rule: a component wearing a t-shirt is replaced by a
 *     clothing node (component data hidden); non-worn equipped items (a
 *     knife) leave the component node intact;
 *   - the component view (comp- prefix): component node, clothing node as
 *     root, unknown id → null;
 *   - the item views (item- and eq-): registry data + live instance data
 *     (owner, host, worn flag, container contents), eq id preserved;
 *   - null-tolerance: missing sub-controllers degrade, never throw.
 *
 * The fake facade exercises the REAL clothes-system helper (getWornItems —
 * from src/controllers/logic/WearLogic.js), so the "wear.minVolume → worn
 * clothing" filter is tested, not mocked away.
 *
 * @module test/unit/ViewController
 */
import { describe, it, expect, vi } from 'vitest';
import ViewController from '../../src/controllers/core/ViewController.js';

const ITEM_REGISTRY = {
    tshirt: { id: 'tshirt', type: 'tshirt', name: 'T-Shirt', description: 'Worn cloth.', wear: { minVolume: 2 }, materials: [{ material: 'wood', fraction: 1 }], form: { volume: 2 } },
    knife: { id: 'knife', type: 'knife', name: 'Knife', description: 'A blade.', equip: true, form: { volume: 1 } },
    box: { id: 'box', type: 'box', name: 'Box', description: 'A container.', form: { volume: 3 }, externalVolume: true },
    chip: { id: 'chip', type: 'chip', name: 'Chip', description: 'A chip.' },
};

const COMPONENT_REGISTRY = {
    iron: { id: 'iron', type: 'iron', name: 'Iron', materials: [{ material: 'iron', fraction: 1 }], form: { volume: 4 } },
    cloth: { id: 'cloth', type: 'cloth', name: 'Cloth', materials: [{ material: 'cloth', fraction: 1 }], form: { volume: 2 } },
};

const ORGAN_REGISTRY = {
    // Realistic organ definition: the enrichment (enrichWithDescriptions) derives
    // the description from the definition's grants / grantsFlags / overTime.
    blade: {
        id: 'blade',
        type: 'blade',
        grantsFlags: ['armored'],
    },
};

const ENTITIES = {
    'ent-A': {
        id: 'ent-A',
        name: 'Generator',
        blueprint: 'gen',
        isStatic: true,
        isMachine: false,
        location: 'room-1',
        spatial: { x: 0, y: 0 },
        components: [
            { id: 'comp-A1', type: 'cloth', exists: true },
            { id: 'comp-A2', type: 'iron', exists: true },
        ],
        items: [
            { id: 'tshirt-1', type: 'tshirt', name: 'T-Shirt', volume: 2, hostComponentId: 'comp-A1' },
            { id: 'knife-1', type: 'knife', name: 'Knife', volume: 1, hostComponentId: 'comp-A2' },
            { id: 'box-1', type: 'box', name: 'Box', volume: 3, hostComponentId: 'comp-A2', traits: { Physical: { energy: 50 } } },
        ],
    },
    'ent-B': {
        id: 'ent-B',
        name: 'Other',
        blueprint: 'other',
        isStatic: false,
        location: 'room-2',
        components: [],
        items: [{ id: 'chip-1', type: 'chip', name: 'Chip', volume: 1 }],
    },
};

function cloneEntities() {
    return structuredClone(ENTITIES);
}

/**
 * Builds the hand-built test facade.
 * @param {object} [overrides] - Per-fixture overrides (e.g. drop a sub-controller
 *   to test null-tolerance, or replace getItemRegistry).
 * @returns {object} The facade.
 */
function buildFacade(overrides = {}) {
    const world = cloneEntities();
    const componentStats = {
        'comp-A1': { Physical: { existence: 1, volume: 2 } },
        'comp-A2': { Physical: { existence: 1, volume: 4 } },
    };
    const internalComponents = { 'ent-A': { 'comp-A2': [{ id: 'ic-1', type: 'blade', exists: true, broken: false }] } };

    const facade = {
        // Root public readers (the ones the viewer uses).
        getEntity: (entityId) => (world[entityId] || null),
        getItem: vi.fn((entityId, itemId) => world[entityId]?.items?.find((it) => it?.id === itemId) || null),
        getEquippedItems: vi.fn((entityId) => {
            if (!world[entityId]) {
                return [];
            }
            return [
                { itemId: 'tshirt-1', itemType: 'tshirt', componentId: 'comp-A1' },
                { itemId: 'knife-1', itemType: 'knife', componentId: 'comp-A2' },
            ];
        }),
        getItemRegistry: vi.fn(() => ITEM_REGISTRY),
        getComponent: vi.fn((id) => id),
        // The state seam the viewer scans (no facade-level getEntity fallback needed).
        stateEntityController: {
            getEntity: vi.fn((entityId) => (world[entityId] || null)),
            getAll: vi.fn(() => world),
            findEntityByComponent: vi.fn((compId) => {
                for (const entity of Object.values(world)) {
                    const comp = (Array.isArray(entity.components) ? entity.components : []).find((c) => c?.id === compId);
                    if (comp) {
                        return entity;
                    }
                }
                return null;
            }),
        },
        componentController: {
            getComponentDefinition: vi.fn((type) => (COMPONENT_REGISTRY[type] || {})),
            getAll: vi.fn(() => ({ instances: componentStats })),
        },
        internalComponentController: {
            registry: ORGAN_REGISTRY,
            getAll: vi.fn(() => internalComponents),
        },
        inventoryManager: {
            getItemDefinition: vi.fn((type) => (ITEM_REGISTRY[type] || {})),
            getContainerItems: vi.fn((entity, containerItemId) => (containerItemId === 'box-1' ? [
                { id: 'knife-2', type: 'knife', name: 'Knife', volume: 1 },
            ] : [])),
        },
        roomsController: {
            getRoom: vi.fn((location) => ({ id: location, name: 'Main Room' })),
        },
        holdingCostController: {
            getEquippedItemsByEntity: vi.fn(() => ({
                'ent-A': { 'eq-1': { itemId: 'tshirt-1', itemType: 'tshirt', componentId: 'comp-A1' } },
                'ent-B': {},
            })),
        },
    };

    return Object.assign(facade, overrides);
}

function makeController(facade) {
    const controller = new ViewController();
    controller.setWorldStateController(facade);
    return controller;
}

describe('ViewController.view()', () => {
    it('returns null when the facade is unset (null-tolerant)', () => {
        const controller = new ViewController();
        expect(controller.view('ent-A', 'ENTITY')).toBeNull();
    });

    describe('ENTITY kind', () => {
        it('unknown entity id → null', () => {
            const controller = makeController(buildFacade());
            expect(controller.view('ent-nope', 'ENTITY')).toBeNull();
        });

        it('returns the entity node: record + component nodes + inventory totals', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('ent-A', 'ENTITY');

            expect(node.kind).toBe('entity');
            expect(node.entity).toEqual({
                id: 'ent-A',
                name: 'Generator',
                blueprint: 'gen',
                isStatic: true,
                isMachine: false,
                machineType: null,
                spatial: { x: 0, y: 0 },
                roomId: 'room-1',
                roomName: 'Main Room',
            });
            expect(node.inventory).toEqual({ used: 6, capacity: 6, percent: 100 });
        });

        it('the clothing rule: a component wearing a t-shirt becomes a clothing node (component data hidden)', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('ent-A', 'ENTITY');
            const compA1 = node.components[0]; // cloth comp, wearing the t-shirt

            expect(compA1.kind).toBe('clothing');
            expect(compA1.componentId).toBe('comp-A1');
            expect(compA1.worn).toEqual([
                {
                    itemId: 'tshirt-1',
                    itemType: 'tshirt',
                    name: 'T-Shirt',
                    description: 'Worn cloth.',
                    materials: [{ material: 'wood', fraction: 1 }],
                    form: { volume: 2 },
                    wear: { minVolume: 2 },
                },
            ]);
            // No component-specific data on the node:
            expect(compA1).not.toHaveProperty('materials');
            expect(compA1).not.toHaveProperty('stats');
            expect(compA1).not.toHaveProperty('internalComponents');
            expect(compA1).not.toHaveProperty('existence');
        });

        it('a component with only non-worn equipment (a knife) keeps its component node: materials, organs, stats, items, worn flags', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('ent-A', 'ENTITY');
            const compA2 = node.components[1]; // iron comp: holds knife + box (not worn)

            expect(compA2.kind).toBe('component');
            expect(compA2.id).toBe('comp-A2');
            expect(compA2.type).toBe('iron');
            expect(compA2.name).toBe('Iron');
            expect(compA2.exists).toBe(true);
            expect(compA2.existence).toBe(1);
            expect(compA2.broken).toBe(false);
            expect(compA2.volume).toBe(4);
            expect(compA2.materials).toEqual([{ material: 'iron', fraction: 1 }]);
            expect(compA2.form).toEqual({ volume: 4 });
            expect(compA2.stats.Physical).toEqual({ existence: 1, volume: 4 });
            expect(compA2.internalComponents).toEqual([
                { id: 'ic-1', type: 'blade', exists: true, broken: false, description: 'Marks the host as armored.' },
            ]);
            expect(compA2.items).toEqual([
                { id: 'knife-1', type: 'knife', name: 'Knife', volume: 1, hostComponentId: 'comp-A2', worn: false },
                { id: 'box-1', type: 'box', name: 'Box', volume: 3, hostComponentId: 'comp-A2', worn: false },
            ]);
        });

        it('the flat entity items list is the full inventory with worn flags (t-shirt worn, rest not)', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('ent-A', 'ENTITY');
            expect(node.items).toEqual([
                { id: 'tshirt-1', type: 'tshirt', name: 'T-Shirt', volume: 2, hostComponentId: 'comp-A1', worn: true },
                { id: 'knife-1', type: 'knife', name: 'Knife', volume: 1, hostComponentId: 'comp-A2', worn: false },
                { id: 'box-1', type: 'box', name: 'Box', volume: 3, hostComponentId: 'comp-A2', worn: false },
            ]);
        });
    });

    describe('COMPONENT kind', () => {
        it('resolves the component by componentId and returns its component node (non-clothing case)', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('comp-A2', 'COMPONENT');
            expect(node.kind).toBe('component');
            expect(node.id).toBe('comp-A2');
            expect(node.type).toBe('iron');
            expect(node.materials).toEqual([{ material: 'iron', fraction: 1 }]);
        });

        it('returns the clothing node when the component wears a t-shirt (full replacement — no component data at root)', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('comp-A1', 'COMPONENT');
            expect(node.kind).toBe('clothing');
            expect(node.componentId).toBe('comp-A1');
            expect(node.worn[0].itemId).toBe('tshirt-1');
            expect(node.worn[0].materials).toEqual([{ material: 'wood', fraction: 1 }]);
            expect(node.worn[0].wear.minVolume).toBe(2);
            expect(node).not.toHaveProperty('stats');
            expect(node).not.toHaveProperty('internalComponents');
        });

        it('unknown component id → null', () => {
            const controller = makeController(buildFacade());
            expect(controller.view('comp-nope', 'COMPONENT')).toBeNull();
        });

        it('component owned by a nonexistent entity (findEntityByComponent → null) → null', () => {
            const controller = makeController(buildFacade({
                stateEntityController: { ...buildFacade().stateEntityController, findEntityByComponent: () => null },
            }));
            expect(controller.view('comp-A2', 'COMPONENT')).toBeNull();
        });
    });

    describe('ITEM kind (item- prefix)', () => {
        it('returns the item node with registry data + live instance data', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('tshirt-1', 'ITEM');
            expect(node).toEqual({
                kind: 'item',
                id: 'tshirt-1',
                itemId: 'tshirt-1',
                entityType: 'ent-A',
                itemType: 'tshirt',
                name: 'T-Shirt',
                description: 'Worn cloth.',
                materials: [{ material: 'wood', fraction: 1 }],
                form: { volume: 2 },
                wear: { minVolume: 2 },
                volume: 2,
                traits: null,
                hostComponentId: 'comp-A1',
                worn: true,
                contents: null,
            });
        });

        it("a container's node exposes its stored contents and instance traits; non-containers have null contents", () => {
            const controller = makeController(buildFacade());
            const box = controller.view('box-1', 'ITEM');
            expect(box.itemId).toBe('box-1');
            expect(box.worn).toBe(false);
            expect(box.traits).toEqual({ Physical: { energy: 50 } });
            expect(box.contents).toEqual([
                { id: 'knife-2', type: 'knife', name: 'Knife', volume: 1 },
            ]);

            const knife = controller.view('knife-1', 'ITEM');
            expect(knife.contents).toBeNull();
            expect(knife.traits).toBeNull();
        });

        it('unknown item id → null', () => {
            const controller = makeController(buildFacade());
            expect(controller.view('item-nope', 'ITEM')).toBeNull();
        });

        it('an item in a different entity resolves to that entity', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('chip-1', 'ITEM');
            expect(node.kind).toBe('item');
            expect(node.itemId).toBe('chip-1');
            expect(node.entityType).toBe('ent-B');
            expect(node.name).toBe('Chip');
        });
    });

    describe('EQUIPPED kind (eq- prefix)', () => {
        it('resolves the eq entry to its item node, preserving the eq id and the real item id', () => {
            const controller = makeController(buildFacade());
            const node = controller.view('eq-1', 'EQUIPPED');
            expect(node.kind).toBe('item');
            expect(node.id).toBe('eq-1');
            expect(node.itemId).toBe('tshirt-1');
            expect(node.entityType).toBe('ent-A');
            expect(node.itemType).toBe('tshirt');
            expect(node.worn).toBe(true);
        });

        it('unknown eq id → null', () => {
            const controller = makeController(buildFacade());
            expect(controller.view('eq-nope', 'EQUIPPED')).toBeNull();
        });
    });

    describe('null-tolerance (missing sub-controllers)', () => {
        it('missing roomsController / internalComponentController degrade the entity node, never throw', () => {
            const controller = makeController(buildFacade({
                roomsController: undefined,
                internalComponentController: undefined,
            }));
            const node = controller.view('ent-A', 'ENTITY');
            expect(node.kind).toBe('entity');
            expect(node.entity.roomName).toBeNull();
            const compA2 = node.components.find((c) => c.kind === 'component');
            expect(compA2.internalComponents).toEqual([]);
            expect(compA2.materials).toEqual([{ material: 'iron', fraction: 1 }]);
        });

        it('missing holdingCostController → equipped view null; missing getContainerItems → null contents, never a throw', () => {
            const controller = makeController(buildFacade({ holdingCostController: undefined }));
            expect(controller.view('eq-1', 'EQUIPPED')).toBeNull();

            const controller2 = makeController(buildFacade({
                inventoryManager: { getItemDefinition: vi.fn((type) => (ITEM_REGISTRY[type] || {})), getContainerItems: undefined },
            }));
            const node = controller2.view('box-1', 'ITEM');
            expect(node.kind).toBe('item');
            expect(node.name).toBe('Box');
            expect(node.contents).toBeNull();
        });
    });

    describe('contract', () => {
        it('viewing never mutates the fixture world (fresh copies out — the node is a new object)', () => {
            const facade = buildFacade();
            const controller = makeController(facade);
            const before = JSON.stringify(facade.stateEntityController.getAll());

            controller.view('ent-A', 'ENTITY');
            controller.view('comp-A2', 'COMPONENT');
            controller.view('tshirt-1', 'ITEM');
            controller.view('eq-1', 'EQUIPPED');

            const after = JSON.stringify(facade.stateEntityController.getAll());
            expect(after).toBe(before);

            const node = controller.view('ent-A', 'ENTITY');
            // The returned node is a fresh copy: mutating it cannot mutate the
            // world (the reader contract, DOC-2 / T-12 lineage).
            node.entity.name = 'MUTATED';
            expect(facade.getEntity('ent-A').name).toBe('Generator');
        });
        it('an unknown kind is never passed (default branch is a contract guard) → null', () => {
            const controller = makeController(buildFacade());
            expect(controller.view('ent-A', 'BOGUS')).toBeNull();
        });
    });
});

/**
 * Unit tests — WearLogic (clothes feature, simplified: pure volume fit).
 *
 * The fit rule: the target component (chosen by the caller, like /equip)
 * must have at least the item's `wear.minVolume` (item registry) of free
 * volume; if it does, the item fits. These tests run the module against a
 * mock facade (no world boot); boot-level behavior is pinned by
 * test/contract/wear.contract.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wearItem, getWornItems, getWearMinVolume } from '../../src/controllers/logic/WearLogic.js';

const TSHIRT = 'itm_t0';
const KNIFE = 'itm_kn0';

function makeEntity(components) {
    return {
        id: 'ent_player1',
        components: components.map((t, i) => ({ id: `comp_${i}`, type: t })),
        items: []
    };
}

function makeFacade({ entity, items, equipped, available, itemRegistry, equipResult }) {
    return {
        getEntity: () => entity || null,
        getItem: (_entityId, itemId) => (items || []).find((i) => i.id === itemId) || null,
        getItemRegistry: () => itemRegistry || {},
        getEquippedItems: () => equipped || [],
        getComponent: (componentId) => {
            const comp = (entity?.components || []).find((c) => c.id === componentId);
            return comp ? { id: comp.id, type: comp.type } : null;
        },
        inventoryManager: {
            getAvailableVolume: () => available ?? 10
        },
        holdingCostController: {
            equipItem: vi.fn(() => equipResult || { success: true })
        },
        _broadcastService: {
            broadcast: vi.fn()
        }
    };
}

const registry = {
    tshirt: {
        name: 'T-Shirt',
        form: { volume: 2 },
        wear: { minVolume: 2 }
    },
    knife: { name: 'Knife', form: { volume: 1 } }
};

describe('WearLogic (pure volume fit)', () => {
    let facade;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('wearItem', () => {
        it('wears on a component that has at least minVolume of free volume (it fits)', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [{ id: TSHIRT, type: 'tshirt', name: 'T-Shirt' }],
                itemRegistry: registry,
                available: 8
            });

            const result = wearItem(facade, entity.id, TSHIRT, 'comp_0');

            expect(result.success).toBe(true);
            expect(facade.holdingCostController.equipItem).toHaveBeenCalledWith(entity.id, TSHIRT, 'tshirt', 'comp_0');
            expect(facade._broadcastService.broadcast).toHaveBeenCalledTimes(1);
            expect(result.componentId).toBe('comp_0');
        });

        it('rejects when the component has less than minVolume of free volume (it does not fit)', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [{ id: TSHIRT, type: 'tshirt', name: 'T-Shirt' }],
                itemRegistry: registry,
                available: 1
            });

            const result = wearItem(facade, entity.id, TSHIRT, 'comp_0');

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/has 1 free volume; "tshirt" needs 2 to fit/);
            expect(facade.holdingCostController.equipItem).not.toHaveBeenCalled();
            expect(facade._broadcastService.broadcast).not.toHaveBeenCalled();
        });

        it('accepts the exact boundary (available == minVolume fits)', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [{ id: TSHIRT, type: 'tshirt', name: 'T-Shirt' }],
                itemRegistry: registry,
                available: 2
            });

            expect(wearItem(facade, entity.id, TSHIRT, 'comp_0').success).toBe(true);
        });

        it('rejects items whose type declares no wear.minVolume (not wearable)', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [{ id: KNIFE, type: 'knife', name: 'Knife' }],
                itemRegistry: registry,
                available: 10
            });

            const result = wearItem(facade, entity.id, KNIFE, 'comp_0');

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/cannot be worn/);
            expect(facade.holdingCostController.equipItem).not.toHaveBeenCalled();
        });

        it('rejects non-positive or invalid minVolume values (not a fit rule)', () => {
            const entity = makeEntity(['centralBall']);
            for (const bad of [{}, { minVolume: 0 }, { minVolume: -3 }, { minVolume: Number.NaN }]) {
                facade = makeFacade({
                    entity,
                    items: [{ id: 'itm_w0', type: 'weird', name: 'Weird' }],
                    itemRegistry: { ...registry, weird: { name: 'Weird', form: { volume: 1 }, wear: bad } },
                    available: 10
                });

                expect(wearItem(facade, entity.id, 'itm_w0', 'comp_0').success).toBe(false);
                expect(facade.holdingCostController.equipItem).not.toHaveBeenCalled();
            }
        });

        it('rejects a component that does not belong to the entity', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [{ id: TSHIRT, type: 'tshirt', name: 'T-Shirt' }],
                itemRegistry: registry,
                available: 10
            });

            const result = wearItem(facade, entity.id, TSHIRT, 'comp_other');

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/does not belong to entity/);
            expect(facade.holdingCostController.equipItem).not.toHaveBeenCalled();
        });

        it('rejects re-wearing an item that is already equipped (idempotent)', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [{ id: TSHIRT, type: 'tshirt', name: 'T-Shirt' }],
                equipped: [{ itemId: TSHIRT, itemType: 'tshirt', componentId: 'comp_0' }],
                itemRegistry: registry,
                available: 10
            });

            const result = wearItem(facade, entity.id, TSHIRT, 'comp_0');

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/already worn/);
            expect(facade.holdingCostController.equipItem).not.toHaveBeenCalled();
        });

        it('rejects an unknown entity or an unknown item', () => {
            facade = makeFacade({});
            expect(wearItem(facade, 'ent_x', TSHIRT, 'comp_0').success).toBe(false);

            const entity = makeEntity(['centralBall']);
            facade = makeFacade({ entity, items: [], itemRegistry: registry });
            expect(wearItem(facade, entity.id, 'itm_nope', 'comp_0').success).toBe(false);
        });

        it('propagates a holding-cost failure (no state change, no broadcast)', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [{ id: TSHIRT, type: 'tshirt', name: 'T-Shirt' }],
                itemRegistry: registry,
                available: 10,
                equipResult: { success: false, message: 'cannot hold' }
            });

            const result = wearItem(facade, entity.id, TSHIRT, 'comp_0');

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/cannot hold/);
            expect(facade._broadcastService.broadcast).not.toHaveBeenCalled();
        });
    });

    describe('getWornItems', () => {
        it('returns only the equipped items whose type declares wear.minVolume', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({
                entity,
                items: [
                    { id: TSHIRT, type: 'tshirt', name: 'T-Shirt' },
                    { id: KNIFE, type: 'knife', name: 'Knife' }
                ],
                equipped: [
                    { itemId: TSHIRT, itemType: 'tshirt', componentId: 'comp_0' },
                    { itemId: KNIFE, itemType: 'knife', componentId: 'comp_0' }
                ],
                itemRegistry: registry
            });

            const worn = getWornItems(facade, entity.id);

            expect(worn).toHaveLength(1);
            expect(worn[0].itemId).toBe(TSHIRT);
            expect(worn[0].itemType).toBe('tshirt');
            expect(worn[0].name).toBe('T-Shirt');
            expect(worn[0].componentId).toBe('comp_0');
            expect(worn[0].componentType).toBe('centralBall');
        });

        it('returns [] for an unknown entity or one wearing nothing', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({ entity, items: [], itemRegistry: registry });

            expect(getWornItems(facade, 'ent_missing')).toEqual([]);
            expect(getWornItems(facade, entity.id)).toEqual([]);
        });
    });

    describe('getWearMinVolume', () => {
        it('reads the fit rule from the item registry', () => {
            const entity = makeEntity(['centralBall']);
            facade = makeFacade({ entity, itemRegistry: registry });

            expect(getWearMinVolume(facade, 'tshirt')).toBe(2);
            expect(getWearMinVolume(facade, 'knife')).toBeNull();
            expect(getWearMinVolume(facade, 'unknown_type')).toBeNull();
        });
    });
});

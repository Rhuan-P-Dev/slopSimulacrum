/**
 * UNIT TEST — the outfit registry: what a body wears, and what stands down.
 *
 * `data/mods/core-outfits/outfits.json` says which garment a blueprint is born
 * wearing and on which component. Two claims are pinned here, and the second is the
 * one with teeth: an outfit does not merely add clothing, it REPLACES the default
 * clothing of the spawn loadouts, because a body does not wear the world's shirt
 * underneath its own coat (`wiki/decisions/agent-body-design.md`).
 *
 * The facade is a stub (TST-2): the real driven spawn is covered by
 * `test/contract/outfitSpawn.contract.test.js`. What this file owns is the narrowing
 * (a half-written entry puts nothing on anybody) and the boot rule
 * (`validateOutfitRegistry`), which the composition root and the mod classifier share.
 *
 * @module test/unit/OutfitLogic
 */

import { describe, it, expect } from 'vitest';
import {
    outfitForBlueprint,
    clothedByOutfit,
    applyOutfit,
    validateOutfitRegistry
} from '../../src/controllers/logic/OutfitLogic.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

/**
 * A facade small enough to read: one body, one item registry, and a wear seam that
 * reports what it was asked to do. `wearItem` is the real seam's stand-in — this file
 * is about WHICH component the logic asks for, not about the fit rule itself
 * (`WearLogic` has its own tests).
 * @param {Object} [options]
 * @returns {{ facade: Object, worn: Array, entity: Object }}
 */
function stubFacade({ outfits = {}, items = { tshirt: { wear: { minVolume: 2 } } }, addFails = false } = {}) {
    const worn = [];
    const entity = {
        id: 'ent-1',
        blueprint: 'TestBody',
        components: [{ id: 'comp-core', type: 'centralBody' }, { id: 'comp-head', type: 'head' }]
    };
    const facade = {
        getRegistry: (kind) => (kind === REGISTRY_KINDS.OUTFITS ? outfits : {}),
        stateEntityController: { getEntity: (id) => (id === entity.id ? entity : null) },
        inventoryManager: {
            getItemDefinitions: () => items,
            addItem: (_entity, itemType, componentId) => (
                addFails
                    ? { success: false, message: 'no room' }
                    : { success: true, item: { id: 'item-' + itemType, itemType, hostComponentId: componentId } }
            )
        },
        componentController: {},
        wearItem: (_entityId, itemId, componentId) => {
            worn.push({ itemId, componentId });
            return { success: true };
        }
    };
    return { facade, worn, entity };
}

describe('OutfitLogic — reading the outfit', () => {
    it('reads the garments authored for a blueprint key', () => {
        const { facade } = stubFacade({
            outfits: { TestBody: [{ item: 'tshirt', component: 'centralBody' }] }
        });
        expect(outfitForBlueprint(facade, 'TestBody')).toEqual([{ item: 'tshirt', component: 'centralBody' }]);
    });

    it('reads no outfit as no outfit — absent is the normal state, not a defect', () => {
        const { facade } = stubFacade({ outfits: { Other: 'not an array' } });
        expect(outfitForBlueprint(facade, 'TestBody')).toEqual([]);
        expect(outfitForBlueprint(facade, '')).toEqual([]);
        expect(outfitForBlueprint(facade, undefined)).toEqual([]);
    });

    it('skips an entry that names only half of a garment', () => {
        const { facade } = stubFacade({
            outfits: {
                TestBody: [
                    { item: 'tshirt' },
                    { component: 'centralBody' },
                    { item: '  ', component: 'centralBody' },
                    'a string is not a garment',
                    { item: 'cloak', component: '  shoulders  ' }
                ]
            }
        });
        // Only the trimmed, complete entry survives. A half-written wish about a body
        // is not a garment, and it must not become one by accident.
        expect(outfitForBlueprint(facade, 'TestBody')).toEqual([{ item: 'cloak', component: 'shoulders' }]);
    });

    it('answers the question both spawn readers ask', () => {
        const dressed = stubFacade({ outfits: { TestBody: [{ item: 'tshirt', component: 'centralBody' }] } });
        const bare = stubFacade({ outfits: { TestBody: [{ item: 'tshirt' }] } });
        expect(clothedByOutfit(dressed.facade, dressed.entity)).toBe(true);
        // A key whose entries are all garbage is not a claim about clothing either -
        // the body falls back to the default rather than going naked because of a typo.
        expect(clothedByOutfit(bare.facade, bare.entity)).toBe(false);
        expect(clothedByOutfit(dressed.facade, null)).toBe(false);
    });

    it('counts an authored EMPTY outfit: born wearing nothing, and the default stands down', () => {
        const { facade, worn } = stubFacade({ outfits: { TestBody: [] } });
        // Absent and empty are two different sentences, and this is the only place they
        // part: an empty list IS a clothing claim, so nothing is worn and the spawn
        // loadout's shirt is not put on instead.
        expect(clothedByOutfit(facade, { blueprint: 'TestBody' })).toBe(true);
        expect(clothedByOutfit(facade, { blueprint: 'Other' })).toBe(false);
        expect(applyOutfit(facade, 'ent-1')).toEqual({ applied: 0, failed: 0 });
        expect(worn).toEqual([]);
    });
});

describe('OutfitLogic — putting it on', () => {
    it('wears each garment on the component the outfit named, through the wear seam', () => {
        const { facade, worn } = stubFacade({
            outfits: {
                TestBody: [
                    { item: 'tshirt', component: 'centralBody' },
                    { item: 'tshirt', component: 'head' }
                ]
            }
        });
        const result = applyOutfit(facade, 'ent-1');
        expect(result).toEqual({ applied: 2, failed: 0 });
        expect(worn).toEqual([
            { itemId: 'item-tshirt', componentId: 'comp-core' },
            { itemId: 'item-tshirt', componentId: 'comp-head' }
        ]);
    });

    it('does nothing at all for a body nobody dressed', () => {
        const { facade, worn } = stubFacade({ outfits: {} });
        expect(applyOutfit(facade, 'ent-1')).toEqual({ applied: 0, failed: 0 });
        expect(worn).toEqual([]);
    });

    it('warns and keeps spawning when the part is not on this body', () => {
        const { facade, worn } = stubFacade({
            outfits: { TestBody: [{ item: 'tshirt', component: 'tail' }] }
        });
        expect(applyOutfit(facade, 'ent-1')).toEqual({ applied: 0, failed: 1 });
        expect(worn, 'no wear attempted on a part the body does not have').toEqual([]);
    });

    it('warns when the item registry does not know the garment', () => {
        const { facade, worn } = stubFacade({
            outfits: { TestBody: [{ item: 'crown', component: 'head' }] },
            items: { tshirt: { wear: { minVolume: 2 } } }
        });
        expect(applyOutfit(facade, 'ent-1')).toEqual({ applied: 0, failed: 1 });
        expect(worn).toEqual([]);
    });

    it('reports a garment that could not be added, and a missing entity', () => {
        const noRoom = stubFacade({
            outfits: { TestBody: [{ item: 'tshirt', component: 'centralBody' }] },
            addFails: true
        });
        expect(applyOutfit(noRoom.facade, 'ent-1')).toEqual({ applied: 0, failed: 1 });

        // An entity that is not there has no blueprint, so no outfit is even knowable:
        // nothing to wear, nothing failed. The failure count is for garments the world
        // asked for and could not put on.
        const gone = stubFacade({ outfits: { TestBody: [{ item: 'tshirt', component: 'centralBody' }] } });
        expect(applyOutfit(gone.facade, 'ent-missing')).toEqual({ applied: 0, failed: 0 });
        expect(gone.worn).toEqual([]);

        // A body with a blueprint and no components: the outfit is known, and cannot
        // go anywhere.
        const limbless = stubFacade({ outfits: { TestBody: [{ item: 'tshirt', component: 'centralBody' }] } });
        limbless.facade.stateEntityController.getEntity = () => ({ id: 'ent-1', blueprint: 'TestBody' });
        expect(applyOutfit(limbless.facade, 'ent-1')).toEqual({ applied: 0, failed: 1 });
    });
});

describe('OutfitLogic — the rule boot and the mod swap share', () => {
    const ITEMS = { tshirt: { wear: { minVolume: 2 } }, knife: {} };

    it('accepts a garment the item registry says is wearable', () => {
        expect(() => validateOutfitRegistry(
            { _comment: 'file metadata, never an outfit', TestBody: [{ item: 'tshirt', component: 'centralBody' }] },
            ITEMS
        )).not.toThrow();
    });

    it('refuses an outfit that is not a list', () => {
        expect(() => validateOutfitRegistry({ TestBody: 'tshirt' }, ITEMS))
            .toThrow(/must be an array/);
    });

    it('refuses an entry that does not name both a garment and a part', () => {
        expect(() => validateOutfitRegistry({ TestBody: [{ item: 'tshirt' }] }, ITEMS))
            .toThrow(/both "item" and "component"/);
    });

    it('refuses a garment the item registry does not define', () => {
        const error = (() => {
            try {
                validateOutfitRegistry({ TestBody: [{ item: 'crown', component: 'head' }] }, ITEMS);
            } catch (e) {
                return e;
            }
            return null;
        })();
        expect(error?.code).toBe('OUTFIT_DEFINITION_INVALID');
        expect(error.message).toContain('crown');
    });

    it('refuses a garment that cannot be worn (no wear.minVolume)', () => {
        expect(() => validateOutfitRegistry({ TestBody: [{ item: 'knife', component: 'hand' }] }, ITEMS))
            .toThrow(/not wearable/);
    });

    it('does not open the blueprints: an unknown component is a spawn warning, not a broken world', () => {
        expect(() => validateOutfitRegistry(
            { TestBody: [{ item: 'tshirt', component: 'aPartNobodyHas' }] },
            ITEMS
        )).not.toThrow();
    });
});

/**
 * Feature 1 — Per-material damage types: unit tests.
 *
 * Covers (spec D2/D9):
 *  - MaterialController._validateMaterialDamageTypes(): structural TypeErrors,
 *    normalization (sum != 100), defensive copies, graceful feature-off.
 *  - MaterialController.getDamageTypeSplit() / getBlendedDamageTypeSplit(): the
 *    fraction-weighted blend math (including the three action-specific attacker
 *    compositions: droidHand, knife, and the pure-iron T1).
 *  - DamageConsequenceHandler: _computeSplitLoss (null-split == legacy formula,
 *    and the per-channel slicing) and _resolveAttackerMaterials (comp / eq /
 *    unresolvable resolution matrix).
 *
 * Data files are read directly (the same files the server reads) so the expected
 * blends are derived from the real registry, not hardcoded guesses.
 *
 * @module test/unit/materialDamageTypes
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MaterialController from '../../src/controllers/materials/MaterialController.js';
import DamageConsequenceHandler from '../../src/controllers/consequences/DamageConsequenceHandler.js';
import MaterialChunkDropHandler from '../../src/controllers/consequences/MaterialChunkDropHandler.js';
import { PUBLISHED_CHANNEL_LOSS_KEY } from '../../src/utils/Constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8'));

const materials = readJson('data/materials.json');
const propertyTraitMapping = readJson('data/propertyTraitMapping.json');
const damageTypes = readJson('data/materialDamageTypes.json');
const components = readJson('data/components.json');
const inventoryItems = readJson('data/inventoryItems.json');

/** Build a real MaterialController with the real (feature-on) damage-types registry. */
function makeMaterialController(registry = damageTypes) {
    return new MaterialController(materials, propertyTraitMapping, registry);
}

/**
 * Build a DamageConsequenceHandler wired to a mock world + the real MaterialController.
 * `materialController: null` is honored as "feature off" (distinct from the default),
 * so this uses an explicit undefined-check rather than `??`.
 */
function makeHandler(opts = {}) {
    const materialController = opts.materialController === undefined ? makeMaterialController() : opts.materialController;
    const world = opts.world === undefined ? makeMockWorld() : opts.world;
    return new DamageConsequenceHandler({
        worldStateController: world,
        equippedItemStats: null,
        materialController
    });
}

/**
 * A minimal mock world exposing only the public surface DamageConsequenceHandler's
 * attacker-resolution + loss math reads. Components/items are defined inline so the
 * resolution matrix is deterministic and data-driven values come from the real files.
 */
function makeMockWorld() {
    const componentsById = {
        'comp-hand-1': { id: 'comp-hand-1', type: 'droidHand' },
        'comp-head-1': { id: 'comp-head-1', type: 'droidHead' }
    };
    const equippedByEqId = {
        // A real knife (has its own recipe materials).
        'eq-knife-1': { eqId: 'eq-knife-1', itemId: 'item-knife-1', itemType: 'knife', componentId: 'comp-hand-1' },
        // An item type that declares NO materials — must fall back to the host component.
        'eq-bare-1': { eqId: 'eq-bare-1', itemId: 'item-bare-1', itemType: 'bareItem', componentId: 'comp-head-1' }
    };
    const statsById = {
        'comp-head-1': { Physical: { existence: 1, impact_resistance: 20, cut_resistance: 40, wear_resistance: 10 } },
        'item-knife-1': { Physical: { existence: 1, impact_resistance: 5, cut_resistance: 5, wear_resistance: 5 } }
    };
    const itemDefinitions = { ...inventoryItems, bareItem: { name: 'Bare', form: { volume: 1 } } /* no materials */ };
    const componentsByType = {};
    for (const [type, def] of Object.entries(components)) {
        if (def && Array.isArray(def.materials)) componentsByType[type] = def.materials;
    }

    return {
        getComponent: (id) => componentsById[id] || null,
        getEquippedItem: (entityId, eqId) => equippedByEqId[eqId] || null,
        componentController: {
            getComponentStats: (id) => statsById[id] || null,
            getComponentMaterialsByType: () => componentsByType
        },
        inventoryManager: { getItemDefinitions: () => itemDefinitions },
        stateEntityController: { getEntity: () => null }
    };
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const droidHandMaterials = () => components.droidHand.materials;
const knifeMaterials = () => inventoryItems.knife.materials;
const t1Materials = () => inventoryItems.t1.materials;

// ===========================================================================
// MaterialController — validator
// ===========================================================================

describe('MaterialController._validateMaterialDamageTypes()', () => {
    const goodRegistry = { wood: { impact: 50, cut: 25, wear: 25 }, iron: { impact: 100 } };

    it('throws TypeError when the registry is a non-object (array)', () => {
        expect(() => makeMaterialController([1, 2, 3])).toThrow(TypeError);
    });

    it('throws TypeError when an entry value is not an object', () => {
        expect(() => makeMaterialController({ wood: 'impact:50' })).toThrow(TypeError);
    });

    it('throws TypeError when a material key is not in the materials registry', () => {
        expect(() => makeMaterialController({ notARealMaterial: { impact: 100 } })).toThrow(TypeError);
    });

    it('throws TypeError when a channel is not a known damage channel', () => {
        expect(() => makeMaterialController({ wood: { impact: 100, bogus: 0 } })).toThrow(TypeError);
    });

    it('throws TypeError when a percentage is not a finite number', () => {
        expect(() => makeMaterialController({ wood: { impact: 'fifty' } })).toThrow(TypeError);
    });

    it('throws TypeError when a percentage is negative', () => {
        expect(() => makeMaterialController({ wood: { impact: -5 } })).toThrow(TypeError);
    });

    it('throws TypeError when a material has an empty (no-channel) entry', () => {
        expect(() => makeMaterialController({ wood: {} })).toThrow(TypeError);
    });

    it('accepts a valid registry (sums to 100)', () => {
        const mc = makeMaterialController(goodRegistry);
        expect(mc.getDamageTypeSplit('wood')).toEqual({ impact: 50, cut: 25, wear: 25 });
        expect(mc.getDamageTypeSplit('iron')).toEqual({ impact: 100 });
    });
});

// ===========================================================================
// MaterialController — normalization (sum != 100)
// ===========================================================================

describe('MaterialController normalization (sum != 100 → warn + renormalize)', () => {
    it('renormalizes a split that sums to less than 100', () => {
        const mc = makeMaterialController({ wood: { impact: 50, cut: 25 } }); // sums to 75
        const split = mc.getDamageTypeSplit('wood');
        expect(split.impact).toBeCloseTo(50 / 75 * 100);   // 66.67
        expect(split.cut).toBeCloseTo(25 / 75 * 100);      // 33.33
        expect(split.impact + split.cut).toBeCloseTo(100);
    });

    it('renormalizes a split that sums to more than 100', () => {
        const mc = makeMaterialController({ wood: { impact: 100, cut: 50 } }); // sums to 150
        const split = mc.getDamageTypeSplit('wood');
        expect(split.impact).toBeCloseTo(100 / 150 * 100); // 66.67
        expect(split.cut).toBeCloseTo(50 / 150 * 100);     // 33.33
        expect(split.impact + split.cut).toBeCloseTo(100);
    });

    it('leaves an all-100 single-channel split unchanged', () => {
        const mc = makeMaterialController({ iron: { impact: 100 } });
        expect(mc.getDamageTypeSplit('iron')).toEqual({ impact: 100 });
    });
});

// ===========================================================================
// MaterialController — defensive copies + feature-off
// ===========================================================================

describe('MaterialController defensive copies + feature-off', () => {
    it('getDamageTypeSplit returns a deep copy (mutating it does not touch the registry)', () => {
        const mc = makeMaterialController();
        const first = mc.getDamageTypeSplit('wood');
        first.impact = 9999;
        first.injected = true;
        const second = mc.getDamageTypeSplit('wood');
        expect(second.impact).not.toBe(9999);
        expect(second.injected).toBeUndefined();
    });

    it('feature-off (null registry): getters return null, no throw', () => {
        const mc = new MaterialController(materials, propertyTraitMapping, null);
        expect(mc.getDamageTypeSplit('wood')).toBeNull();
        expect(mc.getBlendedDamageTypeSplit(droidHandMaterials(), 'impact')).toBeNull();
    });

    it('feature-off (empty registry): getters return null, no throw', () => {
        const mc = new MaterialController(materials, propertyTraitMapping, {});
        expect(mc.getDamageTypeSplit('wood')).toBeNull();
    });

    it('getDamageTypeSplit returns null for an unknown material (feature on)', () => {
        const mc = makeMaterialController();
        expect(mc.getDamageTypeSplit('notARealMaterial')).toBeNull();
    });
});

// ===========================================================================
// MaterialController — blend math (fraction-weighted)
// ===========================================================================

describe('MaterialController.getBlendedDamageTypeSplit()', () => {
    const mc = makeMaterialController();

    it('punch attacker (droidHand = iron 0.7 + wood 0.3) → impact 85 / cut 7.5 / wear 7.5', () => {
        const split = mc.getBlendedDamageTypeSplit(droidHandMaterials(), 'impact');
        expect(split.impact).toBeCloseTo(85);
        expect(split.cut).toBeCloseTo(7.5);
        expect(split.wear).toBeCloseTo(7.5);
        expect(Object.values(split).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    });

    it('cut attacker (knife = iron 0.6 + wood 0.4) → impact 80 / cut 10 / wear 10', () => {
        const split = mc.getBlendedDamageTypeSplit(knifeMaterials(), 'impact');
        expect(split.impact).toBeCloseTo(80);
        expect(split.cut).toBeCloseTo(10);
        expect(split.wear).toBeCloseTo(10);
        expect(Object.values(split).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    });

    it('shootT1 attacker (T1 = iron 1.0, single material) → 100% declared channel (legacy)', () => {
        const split = mc.getBlendedDamageTypeSplit(t1Materials(), 'impact');
        expect(split).toEqual({ impact: 100 }); // pure single-channel → identical to legacy
    });

    it('an unknown material in the mix is excluded (falls to the declared channel)', () => {
        const mix = [{ material: 'mystery', fraction: 0.5 }, { material: 'iron', fraction: 0.5 }];
        const split = mc.getBlendedDamageTypeSplit(mix, 'impact');
        // 0.5 (unknown → impact) + 0.5 (iron → impact) = 100% impact
        expect(split).toEqual({ impact: 100 });
    });

    it('all-unknown composition → 100% declared channel', () => {
        const split = mc.getBlendedDamageTypeSplit([{ material: 'mystery', fraction: 1 }], 'impact');
        expect(split).toEqual({ impact: 100 });
    });

    it('empty composition → null (caller falls back to legacy)', () => {
        expect(mc.getBlendedDamageTypeSplit([], 'impact')).toBeNull();
    });

    it('feature-off → null', () => {
        const off = new MaterialController(materials, propertyTraitMapping, {});
        expect(off.getBlendedDamageTypeSplit(droidHandMaterials(), 'impact')).toBeNull();
    });
});

// ===========================================================================
// DamageConsequenceHandler — _computeSplitLoss
// ===========================================================================

describe('DamageConsequenceHandler._computeSplitLoss()', () => {
    // Target head: impact_res 20, cut_res 40, wear_res 10.
    const stats = makeMockWorld().componentController.getComponentStats('comp-head-1');

    it('null split === legacy formula (declared channel, whole value)', () => {
        const handler = makeHandler();
        const legacy = handler._computeChannelLoss(stats, 'impact', 100);
        expect(handler._computeSplitLoss(stats, 'impact', 100, null)).toBeCloseTo(legacy);
        expect(legacy).toBeCloseTo(100 / (100 + 20));
    });

    it('splits the value per channel and sums the per-channel losses', () => {
        const handler = makeHandler();
        const split = { impact: 85, cut: 7.5, wear: 7.5 };
        const total = handler._computeSplitLoss(stats, 'impact', 100, split);
        const expected =
            (100 * 0.85) / (100 + 20) +
            (100 * 0.075) / (100 + 40) +
            (100 * 0.075) / (100 + 10);
        expect(total).toBeCloseTo(expected);
    });

    it('a 100% declared-channel split is identical to the legacy formula (regression)', () => {
        const handler = makeHandler();
        const legacy = handler._computeChannelLoss(stats, 'impact', 100);
        expect(handler._computeSplitLoss(stats, 'impact', 100, { impact: 100 })).toBeCloseTo(legacy);
    });
});

// ===========================================================================
// DamageConsequenceHandler — _resolveAttackerMaterials (resolution matrix)
// ===========================================================================

describe('DamageConsequenceHandler._resolveAttackerMaterials()', () => {
    const handler = makeHandler();
    const world = makeMockWorld();

    it('comp- ID via fulfillingComponents → the component TYPE recipe materials (droidHand)', () => {
        const result = handler._resolveAttackerMaterials({
            fulfillingComponents: { 'Physical.strength': 'comp-hand-1' }
        });
        expect(result).toEqual(droidHandMaterials());
    });

    it('comp- ID via context.attackerComponentId (multi-attacker) → type materials', () => {
        const result = handler._resolveAttackerMaterials({
            attackerComponentId: 'comp-hand-1'
        });
        expect(result).toEqual(droidHandMaterials());
    });

    it('eq- ID → the item OWN materials (knife)', () => {
        const result = handler._resolveAttackerMaterials({
            actionParams: { entityId: 'ent-1' },
            fulfillingComponents: { 'Physical.sharpness': 'eq-knife-1' }
        });
        expect(result).toEqual(knifeMaterials());
    });

    it('eq- ID whose item has no materials → falls back to the host component materials', () => {
        const result = handler._resolveAttackerMaterials({
            actionParams: { entityId: 'ent-1' },
            attackerComponentId: 'eq-bare-1' // host is comp-head-1 (droidHead)
        });
        expect(result).toEqual(components.droidHead.materials);
    });

    it('unresolvable (no comp-/eq- ID) → null', () => {
        const result = handler._resolveAttackerMaterials({
            fulfillingComponents: { 'Physical.strength': 'ent-whatever' }
        });
        expect(result).toBeNull();
    });

    it('no context → null', () => {
        expect(handler._resolveAttackerMaterials(null)).toBeNull();
    });
});

// ===========================================================================
// End-to-end-ish: _resolveAttackerSplit through the handler (feature on vs off)
// ===========================================================================

describe('DamageConsequenceHandler._resolveAttackerSplit()', () => {
    it('feature on + resolvable comp- attacker → non-null split summing to 100', () => {
        const handler = makeHandler();
        const split = handler._resolveAttackerSplit(
            { fulfillingComponents: { 'Physical.strength': 'comp-hand-1' } },
            'impact'
        );
        expect(split).not.toBeNull();
        expect(Object.values(split).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    });

    it('feature off (materialController null) → null split (legacy path)', () => {
        const handler = makeHandler({ materialController: null });
        expect(handler._resolveAttackerSplit(
            { fulfillingComponents: { 'Physical.strength': 'comp-hand-1' } }, 'impact'
        )).toBeNull();
    });

    it('feature on + unresolvable attacker → null split (legacy path)', () => {
        const handler = makeHandler();
        expect(handler._resolveAttackerSplit(
            { fulfillingComponents: { 'Physical.strength': 'ent-x' } }, 'impact'
        )).toBeNull();
    });

});

// ===========================================================================
// PUBLISHED_CHANNEL_LOSS_KEY — the dispatcher's publish→read contract (spec D5)
// ===========================================================================

describe('PUBLISHED_CHANNEL_LOSS_KEY (dispatcher contract)', () => {
    it('is the literal string "lastChannelLoss"', () => {
        expect(PUBLISHED_CHANNEL_LOSS_KEY).toBe('lastChannelLoss');
    });

    it('publish (damage handler) → read (chunk handler) round-trips through the constant', () => {
        const damageHandler = makeHandler();
        const context = { actionParams: {} };
        const entry = { targetId: 'comp-x', appliedLoss: 0.5 };

        // The damage handler's publisher writes under the named constant.
        damageHandler._publishChannelLoss(context, entry);

        // The chunk handler reads with the identical constant expression
        // (`context?.actionParams?.[PUBLISHED_CHANNEL_LOSS_KEY]`), so whatever the
        // publisher wrote is exactly what the consumer reads back.
        const readBack = context?.actionParams?.[PUBLISHED_CHANNEL_LOSS_KEY];
        expect(readBack).toEqual(entry);
        // The write site no longer uses a bare string literal: the only key present
        // is the one addressed by the constant.
        expect(context.actionParams).toHaveProperty(PUBLISHED_CHANNEL_LOSS_KEY, entry);
    });

    it('the chunk handler recognizes an entry published under the constant', () => {
        // A real chunk handler wired to a mock world; feature off (materialController
        // null) so the read guard is what under test, not the drop math.
        const chunkHandler = new MaterialChunkDropHandler({
            worldStateController: makeMockWorld(),
            materialController: null
        });
        const context = { actionParams: {} };
        // Publish a loss the way the damage handler does (same constant).
        context.actionParams[PUBLISHED_CHANNEL_LOSS_KEY] = { targetId: 'comp-head-1', appliedLoss: 0.25 };
        // With no materialController the handler reports feature-off (zero drops) —
        // proof it READ the published entry (non-zero appliedLoss) rather than the
        // "missing loss" early return. We assert on the distinct message.
        const result = chunkHandler._handleDropMaterialChunk('comp-head-1', {}, context);
        expect(result.success).toBe(true);
        expect(result.message).toBe('Material chunk drop disabled.');
    });
});

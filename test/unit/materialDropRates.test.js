/**
 * Feature 2 — Material chunk drop: UNIT tests.
 *
 * Covers (spec D1/D7/D9/D10/D11/D12):
 *  - MaterialController._validateMaterialDropRates(): every TypeError case, the three
 *    feature-off outcomes (absent / null / empty), normalization (missing minChunkVolume →
 *    0, missing materials → empty), the _-prefixed-key skip, and the public getters
 *    getDropRate / getMinChunkVolume — including defensive-copy isolation.
 *  - MaterialChunkDropHandler._handleDropMaterialChunk(): the per-material roll
 *    boundaries with a stubbed Math.random (0 / 0.5 / 1), the floor formula
 *    max(min, chunkFraction × lost) with a stubbed applied loss, the target-mismatch
 *    guard (multi-attacker path, D11), and the no-published-loss no-op.
 *  - Constants: isChunkItemType / recoverChunkMaterial (prefix match, material recovery,
 *    non-matches).
 *
 * Data files are read directly (the same files the server reads) where a real materials
 * registry is needed; the drop-rates registries under test are inline fixtures.
 *
 * @module test/unit/materialDropRates
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MaterialController from '../../src/controllers/materials/MaterialController.js';
import MaterialChunkDropHandler from '../../src/controllers/consequences/MaterialChunkDropHandler.js';
import { CHUNK_ITEM_TYPE_PREFIX, isChunkItemType, recoverChunkMaterial } from '../../src/utils/Constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8'));

const materials = readJson('data/materials.json');
const propertyTraitMapping = readJson('data/propertyTraitMapping.json');

/** Build a MaterialController with the given (inline) drop-rates registry. */
function mc(dropRatesRegistry) {
    return new MaterialController(materials, propertyTraitMapping, {}, dropRatesRegistry);
}

const VALID = { minChunkVolume: 0.05, materials: { iron: { dropRate: 1.0, chunkFraction: 0.3 }, wood: { dropRate: 0.25, chunkFraction: 0.5 } } };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('MaterialController — drop-rates registry validation (D1/D9)', () => {
    it('absent / null / empty registry → feature off (getDropRate null, minChunkVolume 0, no throw)', () => {
        for (const reg of [undefined, null, {}]) {
            const c = mc(reg);
            expect(c._dropRatesEnabled, `registry ${JSON.stringify(reg)}`).toBe(false);
            expect(c.getDropRate('iron')).toBeNull();
            expect(c.getMinChunkVolume()).toBe(0);
        }
    });

    it('a valid registry is stored: getDropRate returns the per-material config and getMinChunkVolume the floor', () => {
        const c = mc(VALID);
        expect(c._dropRatesEnabled).toBe(true);
        expect(c.getDropRate('iron')).toEqual({ dropRate: 1.0, chunkFraction: 0.3 });
        expect(c.getDropRate('wood')).toEqual({ dropRate: 0.25, chunkFraction: 0.5 });
        expect(c.getMinChunkVolume()).toBe(0.05);
        // A material with no entry → null (equivalent to rate 0; D9).
        expect(c.getDropRate('unknownMaterial')).toBeNull();
    });

    it('getDropRate returns a DEFENSIVE COPY (mutating it never touches the registry)', () => {
        const c = mc(VALID);
        const a = c.getDropRate('iron');
        const b = c.getDropRate('iron');
        expect(a).not.toBe(b, 'each call returns a fresh object');
        a.dropRate = 0.99;
        a.chunkFraction = 0.99;
        expect(c.getDropRate('iron')).toEqual({ dropRate: 1.0, chunkFraction: 0.3 }, 'the registry is unaffected');
    });

    it('missing minChunkVolume normalizes to 0 (a no-op floor); missing materials yields no drops', () => {
        const c = mc({ materials: { iron: { dropRate: 1.0, chunkFraction: 0.3 } } });
        expect(c._dropRatesEnabled).toBe(true);
        expect(c.getMinChunkVolume()).toBe(0);
        expect(c.getDropRate('iron')).toEqual({ dropRate: 1.0, chunkFraction: 0.3 });

        const d = mc({ minChunkVolume: 0.5 });
        expect(d._dropRatesEnabled).toBe(true);
        expect(d.getMinChunkVolume()).toBe(0.5);
        expect(d.getDropRate('iron')).toBeNull();
    });

    it('skips _-prefixed (comment) keys in the materials section', () => {
        const c = mc({ minChunkVolume: 0.1, materials: { _comment: 'note', iron: { dropRate: 0.5, chunkFraction: 0.5 } } });
        expect(c.getDropRate('iron')).toEqual({ dropRate: 0.5, chunkFraction: 0.5 });
        expect(c.getDropRate('_comment')).toBeNull();
    });

    it('a wrong container type (array / string / number / boolean) throws a TypeError', () => {
        for (const bad of [[{ iron: {} }], 'nope', 42, true]) {
            expect(() => mc(bad)).toThrow(TypeError);
        }
    });

    it('an invalid minChunkVolume (0 / negative / non-finite / non-number) throws a TypeError', () => {
        for (const bad of [0, -1, NaN, Infinity, 'x', null]) {
            expect(() => mc({ minChunkVolume: bad, materials: { iron: { dropRate: 0.5, chunkFraction: 0.5 } } })).toThrow(TypeError);
        }
    });

    it('a wrong-typed materials section (array / string / null) throws a TypeError', () => {
        for (const bad of [[{ dropRate: 0.5, chunkFraction: 0.5 }], 'nope', null]) {
            expect(() => mc({ materials: bad })).toThrow(TypeError);
        }
    });

    it('an unknown material key throws a TypeError (cross-validation against the materials registry)', () => {
        expect(() => mc({ materials: { ghost: { dropRate: 0.5, chunkFraction: 0.5 } } })).toThrow(/unknown material/);
    });

    it('a non-object per-material entry throws a TypeError', () => {
        expect(() => mc({ materials: { iron: 'nope' } })).toThrow(TypeError);
        expect(() => mc({ materials: { iron: { dropRate: 0.5 } } })).toThrow(/chunkFraction/);
    });

    it('dropRate / chunkFraction outside [0, 1] throw a TypeError', () => {
        expect(() => mc({ materials: { iron: { dropRate: 1.5, chunkFraction: 0.5 } } })).toThrow(/dropRate/);
        expect(() => mc({ materials: { iron: { dropRate: -0.1, chunkFraction: 0.5 } } })).toThrow(/dropRate/);
        expect(() => mc({ materials: { iron: { dropRate: 0.5, chunkFraction: 1.5 } } })).toThrow(/chunkFraction/);
        expect(() => mc({ materials: { iron: { dropRate: 0.5, chunkFraction: NaN } } })).toThrow(/chunkFraction/);
    });
});

// =========================================================================
// MaterialChunkDropHandler — roll boundaries, floor, and guards (D7/D10/D11/D12)
// =========================================================================

/**
 * A mock world for the chunk handler. One target component (`comp-1`) of type
 * `testComp` owned by `ent-1`, with a configurable composition, recipe volume, and a
 * mutable dropped-items map the handler's batched write lands in.
 */
function makeChunkWorld({ materials: compMaterials, volume, droppedItems }) {
    return {
        getComponent: (id) => (id === 'comp-1' ? { id: 'comp-1', type: 'testComp', entityId: 'ent-1' } : null),
        getEntity: (id) => (id === 'ent-1' ? { id: 'ent-1', location: 'room-1', spatial: { x: 0, y: 0 } } : null),
        componentController: {
            getComponentMaterialsByType: () => ({ testComp: compMaterials }),
            getComponentDefinition: (type) => (type === 'testComp' ? { volume } : null)
        },
        getMaterialRegistry: () => ({ materials: { iron: { name: 'Iron' }, wood: { name: 'Wood' } } }),
        getDroppedItems: () => droppedItems,
        setDroppedItems: (items) => Object.assign(droppedItems, items)
    };
}

function makeChunkHandler(world, dropRatesRegistry) {
    return new MaterialChunkDropHandler({
        worldStateController: world,
        materialController: new MaterialController(materials, propertyTraitMapping, {}, dropRatesRegistry)
    });
}

/** Invoke the handler with a published loss of `appliedLoss` on target `comp-1`. */
function punch(handler, appliedLoss, targetId = 'comp-1') {
    return handler._handleDropMaterialChunk(targetId, {}, {
        actionParams: { lastChannelLoss: { targetId, appliedLoss } }
    });
}

describe('MaterialChunkDropHandler — roll boundaries (D12, stubbed Math.random)', () => {
    const reg = { minChunkVolume: 0.05, materials: { iron: { dropRate: 1.0, chunkFraction: 0.3 }, wood: { dropRate: 0.25, chunkFraction: 0.5 } } };
    // Single-material target so the roll is isolated: 100% iron, recipe volume 1.
    const world = () => makeChunkWorld({ materials: [{ material: 'iron', fraction: 1.0 }], volume: 1, droppedItems: {} });

    it('roll 0.0 (the low boundary) → drops for any positive rate', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const h = makeChunkHandler(world(), reg);
        expect(punch(h, 1).data.droppedChunks).toBe(1);
    });

    it('roll 0.5 → drops for iron (rate 1.0) but not wood (rate 0.25)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const dropped = {};
        const h = makeChunkHandler(makeChunkWorld({ materials: [{ material: 'iron', fraction: 0.5 }, { material: 'wood', fraction: 0.5 }], volume: 1, droppedItems: dropped }), reg);
        const res = punch(h, 1);
        expect(res.data.droppedChunks).toBe(1);
        expect(res.data.chunkVolumes['chunk_iron']).toBeDefined();
        expect(res.data.chunkVolumes['chunk_wood']).toBeUndefined();
    });

    it('roll 1.0 (the upper boundary, just at max rate) → never drops', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const h = makeChunkHandler(world(), reg);
        expect(punch(h, 1).data.droppedChunks).toBe(0);
    });
});

describe('MaterialChunkDropHandler — floor formula max(min, chunkFraction × lost) (D7)', () => {
    const reg = { minChunkVolume: 1, materials: { iron: { dropRate: 1.0, chunkFraction: 0.5 } } };

    it('applied loss large enough that chunkFraction × lost > min → the computed value wins', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const h = makeChunkHandler(makeChunkWorld({ materials: [{ material: 'iron', fraction: 1.0 }], volume: 10, droppedItems: {} }), reg);
        // lost = 2 × 1.0 × 10 = 20; 0.5 × 20 = 10 > min(1) → chunkVolume 10.
        expect(punch(h, 2).data.chunkVolumes['chunk_iron']).toBeCloseTo(10, 6);
    });

    it('applied loss small enough that chunkFraction × lost < min → the floor wins', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const h = makeChunkHandler(makeChunkWorld({ materials: [{ material: 'iron', fraction: 1.0 }], volume: 1, droppedItems: {} }), reg);
        // lost = 1 × 1.0 × 1 = 1; 0.5 × 1 = 0.5 < min(1) → chunkVolume floored to 1.
        expect(punch(h, 1).data.chunkVolumes['chunk_iron']).toBeCloseTo(1, 6);
    });
});

describe('MaterialChunkDropHandler — guards (D10/D11)', () => {
    const reg = { minChunkVolume: 0.05, materials: { iron: { dropRate: 1.0, chunkFraction: 0.3 } } };
    const world = () => makeChunkWorld({ materials: [{ material: 'iron', fraction: 1.0 }], volume: 1, droppedItems: {} });

    it('no published loss → success with zero drops (multi-attacker path never propagates; D11)', () => {
        const h = makeChunkHandler(world(), reg);
        const res = h._handleDropMaterialChunk('comp-1', {}, { actionParams: {} });
        expect(res.success).toBe(true);
        expect(res.data.droppedChunks).toBe(0);
    });

    it('non-positive published loss → zero drops', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const h = makeChunkHandler(world(), reg);
        expect(punch(h, 0).data.droppedChunks).toBe(0);
        expect(punch(h, -1).data.droppedChunks).toBe(0);
    });

    it('target-mismatch (published loss for a different target) → zero drops (D11)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const h = makeChunkHandler(world(), reg);
        // Loss published for comp-2, but the handler is invoked for comp-1.
        const res = h._handleDropMaterialChunk('comp-1', {}, { actionParams: { lastChannelLoss: { targetId: 'comp-2', appliedLoss: 5 } } });
        expect(res.success).toBe(true);
        expect(res.data.droppedChunks).toBe(0);
    });

    it('vanished target (component removed after a lethal punch) → success with zero drops (D10)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        // getComponent returns null for comp-1 (it was removed by the break cascade).
        const goneWorld = { ...world(), getComponent: () => null };
        const h = makeChunkHandler(goneWorld, reg);
        const res = punch(h, 5);
        expect(res.success).toBe(true);
        expect(res.data.droppedChunks).toBe(0);
    });

    it('feature off (no materialController / disabled drop-rates) → zero drops, no throw', () => {
        const noController = new MaterialChunkDropHandler({ worldStateController: world(), materialController: null });
        expect(punch(noController, 5).data.droppedChunks).toBe(0);
        const disabled = new MaterialChunkDropHandler({
            worldStateController: world(),
            materialController: new MaterialController(materials, propertyTraitMapping, {}, {})
        });
        expect(punch(disabled, 5).data.droppedChunks).toBe(0);
    });
});

// =========================================================================
// MaterialChunkDropHandler — torn-material step (WR-2): gate, null-tolerance, batched
// =========================================================================

function makeTornWorld({ materials: compMaterials, volume, droppedItems }) {
    return {
        getComponent: (id) => (id === 'comp-1' ? { id: 'comp-1', type: 'testComp', entityId: 'ent-1' } : null),
        getEntity: (id) => (id === 'ent-1' ? { id: 'ent-1', location: 'room-1', spatial: { x: 0, y: 0 } } : null),
        componentController: {
            getComponentMaterialsByType: () => ({ testComp: compMaterials }),
            getComponentDefinition: (type) => (type === 'testComp' ? { volume } : null)
        },
        getMaterialRegistry: () => ({ materials: { iron: { name: 'Iron' }, wood: { name: 'Wood' } } }),
        getDroppedItems: () => droppedItems,
        setDroppedItems: (items) => Object.assign(droppedItems, items)
    };
}

/** Build a mock WorldRulesController stub that returns a fixed torn percent. */
function makeMockWorldRules(percent) {
    return {
        getDamageTornMaterialPercent: () => percent
    };
}

describe('MaterialChunkDropHandler — torn-material step (WR-2)', () => {
    const reg = { minChunkVolume: 0.05, materials: { iron: { dropRate: 1.0, chunkFraction: 0.3 } } };
    const compMats = [{ material: 'iron', fraction: 1.0 }];

    it('torn volume >= minChunkVolume → torn token appears alongside chunk', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0); // chunk always drops
        const dropped = {};
        const world = makeTornWorld({ materials: compMats, volume: 10, droppedItems: dropped });
        const h = new MaterialChunkDropHandler({
            worldStateController: world,
            materialController: new MaterialController(materials, propertyTraitMapping, {}, reg),
            worldRulesController: makeMockWorldRules(10)
        });
        // appliedLoss=1, fraction=1.0, volume=10 → tornVolume = 0.10 × 1 × 1.0 × 10 = 1.0 >= 0.05
        const res = h._handleDropMaterialChunk('comp-1', {}, {
            actionParams: { lastChannelLoss: { targetId: 'comp-1', appliedLoss: 1 } }
        });
        expect(res.data.droppedChunks).toBe(1); // chunk
        expect(res.data.tornDropped).toBe(1); // torn
        expect(res.data.tornVolumes['chunk_iron']).toBeCloseTo(1.0, 6);
    });

    it('torn volume < minChunkVolume → no torn token (gate); chunk still appears', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const dropped = {};
        // Small applied loss: tornVolume = 0.10 × 0.1 × 1.0 × 1 = 0.01 < 0.05 → gated out
        const world = makeTornWorld({ materials: compMats, volume: 1, droppedItems: dropped });
        const h = new MaterialChunkDropHandler({
            worldStateController: world,
            materialController: new MaterialController(materials, propertyTraitMapping, {}, reg),
            worldRulesController: makeMockWorldRules(10)
        });
        const res = h._handleDropMaterialChunk('comp-1', {}, {
            actionParams: { lastChannelLoss: { targetId: 'comp-1', appliedLoss: 0.1 } }
        });
        // The chunk volume is floored: max(0.05, 0.3 × 0.1 × 1.0 × 1) = max(0.05, 0.03) = 0.05
        expect(res.data.droppedChunks).toBe(1);
        expect(res.data.tornDropped).toBe(0, 'torn below minChunkVolume → gated out');
    });

    it('worldRulesController is null → no torn tokens, no throw (null-tolerance)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const dropped = {};
        const world = makeTornWorld({ materials: compMats, volume: 10, droppedItems: dropped });
        const h = new MaterialChunkDropHandler({
            worldStateController: world,
            materialController: new MaterialController(materials, propertyTraitMapping, {}, reg)
            // No worldRulesController — simulates a test that hand-builds the handler
        });
        const res = h._handleDropMaterialChunk('comp-1', {}, {
            actionParams: { lastChannelLoss: { targetId: 'comp-1', appliedLoss: 1 } }
        });
        expect(res.data.droppedChunks).toBe(1);
        expect(res.data.tornDropped).toBe(0);
    });

    it('torn percent = 0 (rule active but disabled) → no torn tokens', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const dropped = {};
        const world = makeTornWorld({ materials: compMats, volume: 10, droppedItems: dropped });
        const h = new MaterialChunkDropHandler({
            worldStateController: world,
            materialController: new MaterialController(materials, propertyTraitMapping, {}, reg),
            worldRulesController: makeMockWorldRules(0)
        });
        const res = h._handleDropMaterialChunk('comp-1', {}, {
            actionParams: { lastChannelLoss: { targetId: 'comp-1', appliedLoss: 1 } }
        });
        expect(res.data.droppedChunks).toBe(1);
        expect(res.data.tornDropped).toBe(0);
    });

    it('batched write: chunk and torn land in the same setDroppedItems call', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const writeCalls = [];
        const dropped = {};
        const world = {
            getComponent: (id) => (id === 'comp-1' ? { id: 'comp-1', type: 'testComp', entityId: 'ent-1' } : null),
            getEntity: (id) => (id === 'ent-1' ? { id: 'ent-1', location: 'room-1', spatial: { x: 0, y: 0 } } : null),
            componentController: {
                getComponentMaterialsByType: () => ({ testComp: compMats }),
                getComponentDefinition: (type) => (type === 'testComp' ? { volume: 10 } : null)
            },
            getMaterialRegistry: () => ({ materials: { iron: { name: 'Iron' } } }),
            getDroppedItems: () => dropped,
            setDroppedItems: (items) => { writeCalls.push(items); Object.assign(dropped, items); }
        };
        const h = new MaterialChunkDropHandler({
            worldStateController: world,
            materialController: new MaterialController(materials, propertyTraitMapping, {}, reg),
            worldRulesController: makeMockWorldRules(10)
        });
        h._handleDropMaterialChunk('comp-1', {}, {
            actionParams: { lastChannelLoss: { targetId: 'comp-1', appliedLoss: 1 } }
        });
        // Exactly one setDroppedItems call — both chunk and torn are in the same batch.
        expect(writeCalls.length).toBe(1);
        // The batch contains both the chunk and the torn (2 items with chunk_iron type).
        const batchIds = Object.keys(writeCalls[0]);
        expect(batchIds.length).toBe(2, 'both chunk and torn should be in the same batched write');
    });
});

describe('Constants — chunk-type helper (D8)', () => {
    it('CHUNK_ITEM_TYPE_PREFIX is "chunk_"', () => {
        expect(CHUNK_ITEM_TYPE_PREFIX).toBe('chunk_');
    });

    it('isChunkItemType matches the prefix and a non-empty material', () => {
        expect(isChunkItemType('chunk_iron')).toBe(true);
        expect(isChunkItemType('chunk_wood')).toBe(true);
        expect(isChunkItemType('chunk_iron_chunk')).toBe(true);
        expect(isChunkItemType('chunk_')).toBe(false, 'the bare prefix is not a chunk type');
        expect(isChunkItemType('chunk')).toBe(false);
        expect(isChunkItemType('iron')).toBe(false);
        expect(isChunkItemType('knife')).toBe(false);
        expect(isChunkItemType(undefined)).toBe(false);
        expect(isChunkItemType(42)).toBe(false);
    });

    it('recoverChunkMaterial returns the material for a chunk type and null otherwise', () => {
        expect(recoverChunkMaterial('chunk_iron')).toBe('iron');
        expect(recoverChunkMaterial('chunk_wood')).toBe('wood');
        expect(recoverChunkMaterial('chunk_iron_chunk')).toBe('iron_chunk');
        expect(recoverChunkMaterial('chunk_')).toBeNull();
        expect(recoverChunkMaterial('iron')).toBeNull();
        expect(recoverChunkMaterial(undefined)).toBeNull();
    });
});

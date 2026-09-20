/**
 * OnDamageDropListener — unit tests (stub-deps pattern).
 *
 * The listener is exercised against a stub facade (getComponent/getEntity/
 * getDroppedItems/setDroppedItems/getMaterialRegistry + a stub
 * componentController) and stub material/world-rules controllers. The Bernoulli
 * draw source is the documented seam `listener._randomFn` (deterministic
 * success / failure / sequences). No world, no file I/O, no timers.
 *
 * Covers the §7.3 behavior table: fast path (no entries), roll failure, roll
 * success with the D7 volume formula + spatial bounds + batched write,
 * largest-fraction selection, non-existence floor tokens, the total-loss skip,
 * null tolerance (vanished component / entity), within-event independence, and
 * unwired-dependency silent returns.
 *
 * @module test/unit/OnDamageDropListener
 */

import { describe, it, expect } from 'vitest';
import OnDamageDropListener from '../../src/controllers/worldRules/OnDamageDropListener.js';
import { DEFAULT_TRIGGER_RADIUS } from '../../src/utils/DiskSampler.js';
import { CHUNK_ITEM_TYPE_PREFIX } from '../../src/utils/Constants.js';
import { TRAIT_GROUPS, STAT_NAMES } from '../../shared/StatVocabulary.js';

const COMP_ID = 'comp-1';
const ENT_ID = 'ent-1';
const COMP_TYPE = 'testComp';
const ROOM = 'room-1';

/**
 * Consumes the given values in order, clamping to the last value once exhausted.
 * Lets a test script a sequence of Bernoulli draws for multiple entries.
 */
function seqRandomFn(values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

/**
 * Builds a listener + stub facade with knobs for every resolution step.
 * Defaults produce a fully wired, resolvable world (a 10-volume single-material
 * iron component of an entity at the origin of room-1).
 */
function makeListener({
    entries = [],
    materials = [{ material: 'iron', fraction: 1.0 }],
    primaryMaterial = { material: 'iron', fraction: 1.0 },
    dropRate = { dropRate: 1.0, chunkFraction: 0.3 },
    minChunkVolume = 0.05,
    volume = 10,
    component = undefined,   // undefined → resolvable stub component; null → vanished
    entity = undefined,      // undefined → resolvable stub entity; null → vanished
    facade = undefined,      // undefined → stub facade; null → unwired facade
    rulesController = undefined,  // undefined → stub with `entries`; null → unwired
    materialController = undefined // undefined → stub; null → unwired
}) {
    const dropped = {};
    const facadeCalls = { setDroppedItems: 0 };
    const stubFacade = {
        getComponent: (id) => (component !== undefined
            ? component
            : (id === COMP_ID ? { id, type: COMP_TYPE, entityId: ENT_ID } : null)),
        getEntity: (id) => (entity !== undefined
            ? entity
            : (id === ENT_ID ? { id, location: ROOM, spatial: { x: 0, y: 0 } } : null)),
        componentController: {
            getComponentMaterialsByType: () => ({ [COMP_TYPE]: materials }),
            getComponentDefinition: (type) => (type === COMP_TYPE ? { volume } : null)
        },
        getMaterialRegistry: () => ({ materials: { iron: { name: 'Iron' }, wood: { name: 'Wood' } } }),
        getDroppedItems: () => dropped,
        setDroppedItems: (items) => { facadeCalls.setDroppedItems++; Object.assign(dropped, items); }
    };
    const stubRules = { getOnDamageRules: () => entries.map((e) => ({ ...e })) };
    const stubMat = {
        getMinChunkVolume: () => minChunkVolume,
        getDropRate: (m) => (m === 'iron' || m === 'wood' ? { ...dropRate } : null),
        getPrimaryMaterial: () => (primaryMaterial ? { ...primaryMaterial } : null)
    };
    const listener = new OnDamageDropListener({
        materialController: materialController === undefined ? stubMat : materialController,
        worldRulesController: rulesController === undefined ? stubRules : rulesController
    });
    if (facade !== null) {
        listener.setWorldStateController(facade === undefined ? stubFacade : facade);
    }
    return { listener, dropped, facadeCalls };
}

describe('OnDamageDropListener — stub-deps unit tests (§7.3)', () => {
    it('no entries (getOnDamageRules() → []) → zero facade drop-writes (fast path)', () => {
        const { listener, dropped, facadeCalls } = makeListener({ entries: [] });
        listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(facadeCalls.setDroppedItems).toBe(0);
        expect(Object.keys(dropped)).toHaveLength(0);
    });

    it('roll failure (seam () => 1) → no drop, no facade write', () => {
        const { listener, dropped, facadeCalls } = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }]
        });
        listener._randomFn = () => 1;
        listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(facadeCalls.setDroppedItems).toBe(0);
        expect(Object.keys(dropped)).toHaveLength(0);
    });

    it('roll success + existence damage → exactly one chunk_<primary> at the D7 volume, in-room, within radius, one batched write', () => {
        const { listener, dropped, facadeCalls } = makeListener({
            entries: [{ drop: 'host_material', percentage: 0.05 }]
        });
        listener._randomFn = () => 0.01; // 0.01 < 0.05 → success
        listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);

        const records = Object.values(dropped);
        expect(records).toHaveLength(1);
        const rec = records[0];
        expect(rec.itemType).toBe(CHUNK_ITEM_TYPE_PREFIX + 'iron');
        // D7: lost = 2 * 1.0 * 10 = 20; volume = max(0.05, 0.3 * 20) = 6.
        expect(rec.volume).toBeCloseTo(6, 12);
        expect(rec.roomId).toBe(ROOM);
        expect(rec.ownerId).toBe(ENT_ID);
        // Self-describing chunk identity (shared materialChunkToken strings).
        expect(rec.name).toBe('Iron chunk');
        expect(rec.description).toBe('A chunk of Iron chipped off a damaged component.');
        // Sampled within the trigger disk of the entity position.
        expect(Math.hypot(rec.x - 0, rec.y - 0)).toBeLessThanOrEqual(DEFAULT_TRIGGER_RADIUS);
        // Batched: exactly one setDroppedItems call on the facade.
        expect(facadeCalls.setDroppedItems).toBe(1);
    });

    it('multi-material (iron 0.7 / wood 0.3) → token is chunk_iron at the 0.7-fraction volume', () => {
        const { listener, dropped } = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }],
            materials: [
                { material: 'iron', fraction: 0.7 },
                { material: 'wood', fraction: 0.3 }
            ],
            primaryMaterial: { material: 'iron', fraction: 0.7 }
        });
        listener._randomFn = () => 0.01;
        listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 6);

        const records = Object.values(dropped);
        expect(records).toHaveLength(1);
        expect(records[0].itemType).toBe(CHUNK_ITEM_TYPE_PREFIX + 'iron');
        // lost = 4 * 0.7 * 10 = 28; volume = max(0.05, 0.3 * 28) = 8.4 — never wood.
        expect(records[0].volume).toBeCloseTo(8.4, 12);
    });

    it('non-existence stat damage → floor-volume token (skipped when minChunkVolume is 0)', () => {
        // Floor token present:
        let ctx = makeListener({ entries: [{ drop: 'host_material', percentage: 1.0 }] });
        ctx.listener._randomFn = () => 0.01;
        ctx.listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH, 100, 95);
        let records = Object.values(ctx.dropped);
        expect(records).toHaveLength(1);
        expect(records[0].itemType).toBe(CHUNK_ITEM_TYPE_PREFIX + 'iron');
        expect(records[0].volume).toBeCloseTo(0.05, 12);

        // Feature off (floor 0) → a 0-volume token is meaningless → skipped:
        ctx = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }],
            minChunkVolume: 0
        });
        ctx.listener._randomFn = () => 0.01;
        ctx.listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH, 100, 95);
        expect(Object.keys(ctx.dropped)).toHaveLength(0);
        expect(ctx.facadeCalls.setDroppedItems).toBe(0);
    });

    it('existence crossing to <= 0 → no token (D10 mirror: the break cascade owns total loss)', () => {
        for (const [oldV, newV] of [[2, 0], [1, -1], [5, 0]]) {
            const { listener, dropped, facadeCalls } = makeListener({
                entries: [{ drop: 'host_material', percentage: 1.0 }]
            });
            listener._randomFn = () => 0.01;
            listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, oldV, newV);
            expect(Object.keys(dropped), `existence ${oldV} → ${newV} must drop nothing`).toHaveLength(0);
            expect(facadeCalls.setDroppedItems).toBe(0);
        }
        // A non-lethal existence hit on the same component still drops:
        const { listener: l2, dropped: d2 } = makeListener({ entries: [{ drop: 'host_material', percentage: 1.0 }] });
        l2._randomFn = () => 0.01;
        l2.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 5);
        expect(Object.keys(d2)).toHaveLength(1);
    });

    it('getComponent → null (vanished) or entity → null → no drop, no write, no throw', () => {
        const vanishedComp = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }],
            component: null
        });
        vanishedComp.listener._randomFn = () => 0.01;
        vanishedComp.listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(Object.keys(vanishedComp.dropped)).toHaveLength(0);
        expect(vanishedComp.facadeCalls.setDroppedItems).toBe(0);

        const vanishedEnt = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }],
            entity: null
        });
        vanishedEnt.listener._randomFn = () => 0.01;
        vanishedEnt.listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(Object.keys(vanishedEnt.dropped)).toHaveLength(0);
        expect(vanishedEnt.facadeCalls.setDroppedItems).toBe(0);
    });

    it('two entries, seam [0.99, 0.01] → first fails (0.99 < 0.5 = no), second succeeds (0.01 < 1.0 = yes) → exactly one drop (independence within one event)', () => {
        const { listener, dropped, facadeCalls } = makeListener({
            entries: [
                { drop: 'host_material', percentage: 0.5 },
                { drop: 'host_material', percentage: 1.0 }
            ]
        });
        listener._randomFn = seqRandomFn([0.99, 0.01]);
        listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(Object.keys(dropped)).toHaveLength(1);
        // Still a single batched write for the whole event.
        expect(facadeCalls.setDroppedItems).toBe(1);
    });

    /**
     * Builds a facade that mirrors the REAL WorldStateController drop-map semantics:
     * getDroppedItems() returns a defensive clone; setDroppedItems() REPLACES the
     * whole map (this._droppedItems = items) — it does NOT merge. This is the shape
     * under which the bug (a near-empty `batch` replacing the floor) was observable:
     * the existing unit stubs merge, so they masked the wipe. `dropRef.current` is
     * a mutable reference so the test can assert the floor after each write.
     */
    function makeReplaceFacade(dropRef) {
        return {
            getComponent: (id) => (id === COMP_ID ? { id, type: COMP_TYPE, entityId: ENT_ID } : null),
            getEntity: (id) => (id === ENT_ID ? { id, location: ROOM, spatial: { x: 0, y: 0 } } : null),
            componentController: {
                getComponentMaterialsByType: () => ({ [COMP_TYPE]: [{ material: 'iron', fraction: 1.0 }] }),
                getComponentDefinition: (type) => (type === COMP_TYPE ? { volume: 10 } : null)
            },
            getMaterialRegistry: () => ({ materials: { iron: { name: 'Iron' }, wood: { name: 'Wood' } } }),
            getDroppedItems: () => structuredClone(dropRef.current),
            setDroppedItems: (items) => { dropRef.writes++; dropRef.current = items; }
        };
    }

    it('pre-existing floor items survive a drop on a later damage event (replace-semantics facade) — no silent wipe', () => {
        const dropRef = {
            writes: 0,
            current: {
                'pre-existing-1': {
                    id: 'pre-existing-1',
                    roomId: ROOM,
                    x: 12.5,
                    y: 4.25,
                    itemType: 'chunk_iron',
                    ownerId: 'ent-9'
                }
            }
        };

        const { listener } = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }],
            facade: makeReplaceFacade(dropRef)
        });

        // 0.01 < 1.0 → a guaranteed drop on this damage event.
        listener._randomFn = () => 0.01;
        listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);

        // The pre-existing floor item must STILL be on the ground (not wiped).
        expect(dropRef.current['pre-existing-1'], 'pre-existing drop must survive the damage drop').toBeDefined();
        expect(dropRef.current['pre-existing-1'].roomId).toBe(ROOM);
        expect(dropRef.current['pre-existing-1'].x).toBeCloseTo(12.5, 6);
        expect(dropRef.current['pre-existing-1'].y).toBeCloseTo(4.25, 6);
        // The new token landed ALONGSIDE it (add, not replace).
        expect(Object.keys(dropRef.current)).toHaveLength(2);
        // One batched write.
        expect(dropRef.writes).toBe(1);
    });

    it('rogue killing-blow: pre-existing items survive across multiple hits where one roll a drop (chance)', () => {
        const dropRef = {
            writes: 0,
            current: {
                'survivor-1': {
                    id: 'survivor-1',
                    roomId: ROOM,
                    x: 7.0,
                    y: 3.0,
                    itemType: 'chunk_wood',
                    ownerId: 'ent-7'
                }
            }
        };

        const { listener } = makeListener({
            // the shipped world-rule (data/world_rules.json: percentage 0.05)
            entries: [{ drop: 'host_material', percentage: 0.05 }],
            facade: makeReplaceFacade(dropRef)
        });

        // Scripted Bernoulli draws across the rogue's successive hits — this is the
        // "chance" in the report: without a successful roll the floor is untouched;
        // with one, the pre-existing drop used to be clobbered.
        //   hit 1: 0.90 → no drop
        //   hit 2: 0.90 → no drop
        //   hit 3: 0.01 → DROP  (the hit that would clobber in the buggy code)
        //   hit 4: 0.90 → no drop
        let roll = 0;
        listener._randomFn = () => ([0.90, 0.90, 0.01, 0.90][roll++] ?? 0.90);

        for (let i = 0; i < 4; i += 1) {
            const oldV = 15 - i;
            listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, oldV, oldV - 1);
        }

        // The survivor must still be on the ground after the rogue's killing blow.
        expect(dropRef.current['survivor-1'], 'floor item must survive the rogue kill').toBeDefined();
        expect(dropRef.current['survivor-1'].roomId).toBe(ROOM);
        expect(dropRef.current['survivor-1'].x).toBeCloseTo(7.0, 6);
        expect(dropRef.current['survivor-1'].y).toBeCloseTo(3.0, 6);
        // The 5% roll on hit 3 added a token, so the floor now holds 2 entries.
        expect(Object.keys(dropRef.current)).toHaveLength(2);
    });

    it('unwired facade / unwired controllers → silent return (no throw, no write)', () => {
        // Unwired facade (never setWorldStateController):
        const noFacade = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }],
            facade: null
        });
        noFacade.listener._randomFn = () => 0.01;
        noFacade.listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(Object.keys(noFacade.dropped)).toHaveLength(0);

        // Unwired world-rules controller:
        const noRules = makeListener({ entries: [], rulesController: null });
        noRules.listener._randomFn = () => 0.01;
        noRules.listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(Object.keys(noRules.dropped)).toHaveLength(0);

        // Unwired material controller (primary resolution impossible):
        const noMat = makeListener({
            entries: [{ drop: 'host_material', percentage: 1.0 }],
            materialController: null
        });
        noMat.listener._randomFn = () => 0.01;
        noMat.listener.handleDamage(COMP_ID, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, 10, 8);
        expect(Object.keys(noMat.dropped)).toHaveLength(0);
        expect(noMat.facadeCalls.setDroppedItems).toBe(0);
    });
});

/**
 * Equipped knife capability & requirement-resolution contract test.
 *
 * Covers the server-side half of the "knife cannot be equipped" fix (the
 * recipe→derivation contract drift that left several consumers gating on the
 * removed top-level `itemDef.traits`):
 *
 *   1. The capability scan surfaces `cut` for an equipped knife. The knife
 *      recipe (`data/inventoryItems.json`) declares NO top-level `traits` — its
 *      stats derive from matter — so the old `if (!itemDef?.traits) continue;`
 *      gate skipped the equipped knife entirely. The relaxation reads the
 *      knife's live per-instance stats (from EquippedItemStatsController) or
 *      its derived base traits.
 *
 *   2. RequirementResolver resolves the equipped item without `itemDef.traits`,
 *      via both the equipped-id path (`_findEquippedItemByEqId`) and the
 *      host-component path (`_resolveEquippedItemForHostComponent`).
 *
 * The test drives the real world facade (equipped items, per-instance stats,
 * the capability cache). Two documented test-only seams (withKnifeFormTraits /
 * withBareKnife) intentionally mutate the private field
 * world.inventoryManager._itemDefinitions and guarantee restoration in a
 * finally (precedent: test/unit/InventoryManager.materialTraits.test.js) — the
 * only sanctioned internal-state touch, used solely to exercise fallback
 * branches no shipped data can reach.
 *
 * @module test/contract/equippedKnifeCapability
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { isCompId } from '../../src/utils/IdResolver.js';
import Logger from '../../src/utils/Logger.js';

let world;

beforeAll(() => {
    const { worldStateController } = buildWorldState(null);
    world = worldStateController;
});

afterAll(() => {
    try {
        world.dispose?.();
    } catch (_) { /* best-effort teardown */ }
});

/**
 * Spawns a fresh droid, adds a knife to a droidHand, equips it, and returns the
 * relevant typed IDs. The knife's live per-instance stats are NOT set here —
 * callers set them (from the material derivation) to model a fully-derived item.
 *
 * @returns {{ entityId: string, handId: string, knifeId: string, eqId: string }}
 */
function equipKnifeOnFreshDroid() {
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    const entity = world.getEntity(entityId);
    const hand = entity.components.find((c) => c.type === 'droidHand');
    expect(hand, 'expected a droidHand component on the droid').toBeTruthy();

    world.addItemToEntity(entityId, 'knife', hand.id);
    const items = world.getEntityItems(entityId);
    const knife = (items[hand.id] || []).find((i) => i.type === 'knife');
    expect(knife, 'expected a knife item on the droidHand').toBeTruthy();

    const equipResult = world.equipItem(entityId, knife.id, 'knife', hand.id);
    expect(equipResult.success, `equipping the knife should succeed: ${JSON.stringify(equipResult)}`).toBe(true);

    const eq = world.getEquippedItems(entityId).find((e) => e.itemId === knife.id);
    expect(eq, 'equipped knife should be listed for the entity').toBeTruthy();

    return { entityId, handId: hand.id, knifeId: knife.id, eqId: eq.eqId };
}

/** Derives the knife's real stat set from its matter (the post-migration source of truth). */
function deriveKnifeStats() {
    const knifeDef = world.getItemRegistry().knife;
    const derived = world.materialController.derive(knifeDef);
    expect(derived?.Physical?.sharpness, 'derived knife sharpness should be present').toBeGreaterThan(0);
    return derived;
}

/** Seeds the knife's live per-instance stats from the material derivation. */
function seedKnifeStats(eqId) {
    world.equippedItemStats.setStats(eqId, deriveKnifeStats());
}

/**
 * Test-only seam: temporarily swaps the knife's base `form.traits` on the
 * inventoryManager's item definitions, then restores the original in a `finally`.
 *
 * The `form.traits` fallback in the capability scan and the requirement resolver is
 * defensive against legacy/fixture definitions — current production data ships no
 * item `traits` (data/inventoryItems.json carries only `form`/`materials`), and
 * `initializeStats` always seeds `Physical.existence`, so the only public path to
 * "no live stats" is `removeStats(eqId)`. This is therefore the only way to exercise
 * the "no live stats → base traits" branch without editing data files. Precedent for
 * mutating `_itemDefinitions` directly with fixtures:
 * test/unit/InventoryManager.materialTraits.test.js.
 *
 * NOTE: every registry read (getItemRegistry / getItemDefinitions) deep-clones the
 * current `_itemDefinitions`, so the call under test MUST run while this seam is
 * active — do not perform the capability/requirement read after the seam has restored.
 *
 * @param {Object} traits - The form.traits fixture to install.
 * @param {Function} fn - Runs while the fixture is installed; its return is the return.
 * @returns {*} Whatever fn() returns.
 */
function withKnifeFormTraits(traits, fn) {
    const original = world.inventoryManager._itemDefinitions.knife;
    const next = structuredClone(original);
    next.form = { ...(next.form || {}), traits };
    world.inventoryManager._itemDefinitions.knife = next;
    try {
        return fn();
    } finally {
        world.inventoryManager._itemDefinitions.knife = original;
    }
}

/**
 * Test-only seam (mirrors withKnifeFormTraits): swap the knife definition for a
 * genuinely trait- AND material-free shape (no `form.traits`, no top-level
 * `traits`, no `materials`) and run fn.
 *
 * Pins the writer-side graceful degradation introduced by BUG-134: a post-
 * migration knife now legitimately gains its matter-derived sharpness at equip,
 * so the real knife can no longer pin "never invents a capability". With NEITHER
 * an explicit-traits source NOR a matter source, the item must stay at the
 * existence-only baseline and never surface `cut`. Restores the original
 * definition in `finally`.
 *
 * Like withKnifeFormTraits, the call under test MUST run while this seam is
 * active (the capability scan re-reads the item definition on every rescan).
 *
 * @param {Function} fn - Runs while the fixture is installed; its return is the return.
 * @returns {*} Whatever fn() returns.
 */
function withBareKnife(fn) {
    const original = world.inventoryManager._itemDefinitions.knife;
    world.inventoryManager._itemDefinitions.knife = {
        name: 'Bare Knife',
        description: 'A knife with no traits and no matter.',
        form: { volume: 1 }
        // intentionally: no `materials`, no `traits`, no `form.traits`
    };
    try {
        return fn();
    } finally {
        world.inventoryManager._itemDefinitions.knife = original;
    }
}

describe('Equipped knife — capability scan (recipe→derivation gate relaxation)', () => {
    it('surfaces the `cut` capability for an equipped knife with derived sharpness', () => {
        const { entityId, eqId } = equipKnifeOnFreshDroid();
        seedKnifeStats(eqId);

        world.actionController.reEvaluateEntityCapabilities(world.getAll(), entityId);

        const cache = world.componentCapabilityController.getCachedCapabilities();
        const cutEntries = cache.cut || [];
        const knifeCut = cutEntries.find(
            (e) => e._isEquippedItem && e._eqId === eqId && e.componentType === 'knife'
        );
        expect(knifeCut, 'the equipped knife should surface the cut capability').toBeTruthy();
        // Read the threshold from the action registry (single source of truth)
        // rather than duplicating the hardcoded minValue (L1).
        const minSharpness = world.componentCapabilityController.getActionRegistry()
            .cut.requirements.find((r) => `${r.trait}.${r.stat}` === 'Physical.sharpness').minValue;
        expect(knifeCut.requirementValues['Physical.sharpness']).toBeGreaterThanOrEqual(minSharpness);
    });

    it('pins the production flow: equipping a knife (no manual seeding) surfaces `cut` via matter-derived stats (BUG-134)', () => {
        // The real writer-side flow, exactly as the server runs it (mirrors
        // equipKnifeOnFreshDroid): spawn a fresh droid, hand it a knife, equip it.
        // No test-side stat seeding — the per-instance store must be seeded from
        // matter at equip time, and BOTH the capability cache and the endpoint-
        // shaped view must surface `cut`.
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        const entity = world.getEntity(entityId);
        const hand = entity.components.find((c) => c.type === 'droidHand');
        expect(hand, 'expected a droidHand component on the droid').toBeTruthy();

        world.addItemToEntity(entityId, 'knife', hand.id);
        const items = world.getEntityItems(entityId);
        const knife = (items[hand.id] || []).find((i) => i.type === 'knife');
        expect(knife, 'expected a knife item on the droidHand').toBeTruthy();

        const equipResult = world.equipItem(entityId, knife.id, 'knife', hand.id);
        expect(equipResult.success, `equipping the knife should succeed: ${JSON.stringify(equipResult)}`).toBe(true);
        const eq = world.getEquippedItems(entityId).find((e) => e.itemId === knife.id);
        expect(eq, 'equipped knife should be listed for the entity').toBeTruthy();
        const eqId = eq.eqId;

        // equipItem already re-evaluates the entity internally (after the
        // writer-side seeding), so the cache reflects the post-equip state — read
        // it directly, with no test-side re-seeding.
        const cache = world.componentCapabilityController.getCachedCapabilities();
        const cutEntries = cache.cut || [];
        const knifeCut = cutEntries.find(
            (e) => e._isEquippedItem && e._eqId === eqId && e.componentType === 'knife'
        );
        expect(knifeCut, 'the production equip flow must surface a knife eq entry for cut').toBeTruthy();
        // Read the threshold from the action registry (single source of truth)
        // rather than duplicating the hardcoded minValue (L1).
        const minSharpness = world.componentCapabilityController.getActionRegistry()
            .cut.requirements.find((r) => `${r.trait}.${r.stat}` === 'Physical.sharpness').minValue;
        expect(knifeCut.requirementValues['Physical.sharpness']).toBeGreaterThanOrEqual(minSharpness);

        // The endpoint-shaped view (what the client ⚔️ panel renders) must report
        // `cut` as executable for this entity, with the knife as an equipped entry.
        const actions = world.getActionsForEntity(entityId);
        const cutView = actions.cut;
        expect(cutView, 'cut must be present in the endpoint-shaped view').toBeTruthy();
        const equippedCut = (cutView.canExecute || []).find(
            (e) => e._isEquippedItem && e._eqId === eqId
        );
        expect(equippedCut, 'the endpoint view must report the knife as a capable, equipped entry for cut').toBeTruthy();
        expect(equippedCut._isEquippedItem).toBe(true);
    });

    it('never invents a capability for an equipped item with no explicit traits AND no matter (graceful degradation)', () => {
        // BUG-134 re-scope: a post-migration knife now legitimately gains its
        // matter-derived sharpness at equip, so the real knife can no longer pin
        // "never invents". Use a genuinely trait- AND material-free item instead:
        // with neither an explicit-traits source nor a matter source, it must stay
        // at the existence-only baseline and never surface `cut`.
        let eqId;
        withBareKnife(() => {
            const ids = equipKnifeOnFreshDroid();
            eqId = ids.eqId;
            world.actionController.reEvaluateEntityCapabilities(world.getAll(), ids.entityId);
        });

        const cache = world.componentCapabilityController.getCachedCapabilities();
        const cutEntries = cache.cut || [];
        expect(
            cutEntries.some((e) => e._eqId === eqId),
            'a bare (no-trait, no-matter) equipped item must not surface cut'
        ).toBe(false);
    });
});

describe('Equipped knife — RequirementResolver (no itemDef.traits required)', () => {
    it('resolves the equipped item via the equipped-id path and attributes sharpness to it', () => {
        const { entityId, eqId } = equipKnifeOnFreshDroid();
        seedKnifeStats(eqId);

        const resolver = world.actionController.requirementResolver;
        const cutReq = world.componentCapabilityController.getActionRegistry().cut.requirements;

        const byEq = resolver.checkComponentRequirements(cutReq, entityId, eqId);
        expect(byEq.passed, `eq-path should pass: ${JSON.stringify(byEq.error || {})}`).toBe(true);
        expect(byEq.fulfillingComponents['Physical.sharpness']).toBe(eqId);
    });

    it('resolves via the host component when the knife is equipped on it', () => {
        const { entityId, handId, eqId } = equipKnifeOnFreshDroid();
        expect(isCompId(handId), 'host droidHand should be a typed comp-... ID').toBe(true);
        seedKnifeStats(eqId);

        const resolver = world.actionController.requirementResolver;
        const cutReq = world.componentCapabilityController.getActionRegistry().cut.requirements;

        const byComp = resolver.checkComponentRequirements(cutReq, entityId, handId);
        expect(byComp.passed, `comp-path should pass: ${JSON.stringify(byComp.error || {})}`).toBe(true);
        expect(byComp.fulfillingComponents['Physical.sharpness']).toBe(eqId);
    });
});

describe('graceful-degradation fallback branches (live stats removed)', () => {
    // The only public path to "no live stats" is removeStats(eqId) (initializeStats
    // always seeds existence, and shipped items carry no traits). A 37 sharpness
    // fixture is deliberately distinct from any material-derived value, so exact
    // equality proves the form.traits fallback (via _convertTraitsToStats) was used,
    // not matter derivation.

    it('capability scan falls back to form.traits when live stats are absent', () => {
        let eqId;
        withKnifeFormTraits({ Physical: { sharpness: 37 } }, () => {
            const ids = equipKnifeOnFreshDroid();
            world.equippedItemStats.removeStats(ids.eqId);
            world.actionController.reEvaluateEntityCapabilities(world.getAll(), ids.entityId);
            eqId = ids.eqId;
        });

        const cache = world.componentCapabilityController.getCachedCapabilities();
        const cutEntries = cache.cut || [];
        const knifeCut = cutEntries.find((e) => e._isEquippedItem && e._eqId === eqId);
        expect(knifeCut, 'the equipped knife should surface cut via the form.traits fallback').toBeTruthy();
        // Exact equality (37) proves the base-traits fallback, not matter derivation.
        expect(knifeCut.requirementValues['Physical.sharpness']).toBe(37);
    });

    it('resolver equipped-id path falls back to form.traits when live stats are absent', () => {
        let result;
        let ids;
        withKnifeFormTraits({ Physical: { sharpness: 37 } }, () => {
            ids = equipKnifeOnFreshDroid();
            world.equippedItemStats.removeStats(ids.eqId);
            const cutReq = world.componentCapabilityController.getActionRegistry().cut.requirements;
            result = world.actionController.requirementResolver.checkComponentRequirements(cutReq, ids.entityId, ids.eqId);
        });

        expect(result.passed, `eq-path fallback should pass: ${JSON.stringify(result.error || {})}`).toBe(true);
        expect(result.fulfillingComponents['Physical.sharpness']).toBe(ids.eqId);
    });

    it('resolver host-component path falls back to form.traits when live stats are absent', () => {
        let result;
        let ids;
        withKnifeFormTraits({ Physical: { sharpness: 37 } }, () => {
            ids = equipKnifeOnFreshDroid();
            expect(isCompId(ids.handId), 'host droidHand should be a typed comp-... ID').toBe(true);
            world.equippedItemStats.removeStats(ids.eqId);
            const cutReq = world.componentCapabilityController.getActionRegistry().cut.requirements;
            result = world.actionController.requirementResolver.checkComponentRequirements(cutReq, ids.entityId, ids.handId);
        });

        expect(result.passed, `comp-path fallback should pass: ${JSON.stringify(result.error || {})}`).toBe(true);
        expect(result.fulfillingComponents['Physical.sharpness']).toBe(ids.eqId);
    });

    it('never invents a capability or a resolution when there are no live stats and no traits anywhere', () => {
        // Real knife (no form.traits, no itemDef.traits), no stat seeding, live stats
        // removed: the relaxation must skip cleanly (never invent a capability) and the
        // resolver must fail gracefully with a warning.
        const { entityId, handId, eqId } = equipKnifeOnFreshDroid();
        world.equippedItemStats.removeStats(eqId);
        world.actionController.reEvaluateEntityCapabilities(world.getAll(), entityId);

        // Capability side: no equipped-item entry for this eqId across the whole action set.
        const cache = world.componentCapabilityController.getCachedCapabilities();
        for (const [actionName, entries] of Object.entries(cache)) {
            expect(
                (entries || []).some((e) => e._isEquippedItem && e._eqId === eqId),
                `action "${actionName}" must not surface the trait-less equipped knife`
            ).toBe(false);
        }

        // Resolver side: the trait-less knife must be safely skipped (warn "no traits"),
        // never used to fabricate a capability. The equipped-id path resolves ONLY the
        // knife's stats, so it must fail cleanly. The host-component path may still pass
        // `cut` — but only via the hand's OWN matter-derived sharpness (iron/wood have
        // high wear/cut resistance, so the hand genuinely cuts), in which case the
        // knife's eqId must NOT be the fulfilling component.
        const warnSpy = vi.spyOn(Logger, 'warn');
        try {
            const cutReq = world.componentCapabilityController.getActionRegistry().cut.requirements;
            const byEq = world.actionController.requirementResolver.checkComponentRequirements(cutReq, entityId, eqId);
            const byComp = world.actionController.requirementResolver.checkComponentRequirements(cutReq, entityId, handId);
            expect(byEq.passed, `eq-path should fail cleanly: ${JSON.stringify(byEq.error || {})}`).toBe(false);
            if (byComp.passed) {
                expect(
                    byComp.fulfillingComponents['Physical.sharpness'],
                    'cut must be attributed to the hand, not the trait-less knife'
                ).not.toBe(eqId);
            }
            const warned = warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('no traits'));
            expect(warned, 'expected a "no traits" warning from the resolver').toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

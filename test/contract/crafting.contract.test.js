/**
 * Crafting system — end-to-end contract tests.
 *
 * Uses the real buildWorldState() composition (no mocks of world internals —
 * the broadcast service is the only stub) and drives the PUBLIC facade API
 * (wsc.craftItems / wsc.getCraftingRecipes), mirroring what the HTTP layer
 * (POST /crafting/:entityId/craft, GET /crafting/recipes) calls.
 *
 * Entity notes (data-driven world): a spawned smallBallDroid arrives with
 * starter items; its centralBall is already full (10/10) while droidHead
 * (8) and the right droidArm (8) start empty — those are the test surfaces.
 *
 * Covers the spec §8 test plan:
 *   1. craft 2 knives → 1 t1 on the same component; hostComponentId preserved;
 *      inputs gone, output present; exactly one broadcast on success.
 *   2. insufficient inputs (1 knife) → INPUTS_MISMATCH; inputs intact; 0 broadcasts.
 *   3. item hosted on a different component → INVALID_ITEM; inputs intact; 0 broadcasts.
 *   4. insufficient volume (heavy output) → INSUFFICIENT_VOLUME before any
 *      consumption (NO item loss); 0 broadcasts.
 *   5. unknown recipe / unknown entity / component not on entity → codes.
 *   6. getCraftingRecipes() is data-driven (returns the data/crafting.json entries).
 *   7. queueAction('knife_to_t1') → ACTION_NOT_FOUND (documents the no-turn decision).
 *
 * @module test/contract/crafting.contract
 */

import { describe, it, expect, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import CraftingController from '../../src/controllers/crafting/CraftingController.js';
import Logger from '../../src/utils/Logger.js';

/**
 * Builds a fresh world (tick system NOT started) with a spied broadcast
 * service installed AFTER world init, so only post-setup operations
 * (item adds done in the test, crafting) can trigger broadcasts.
 * @returns {{ worldStateController: import('../../src/controllers/WorldStateController.js'), subControllers: Object, broadcast: import('vitest').Mock, tickSystem: Object }}
 */
function buildWorld() {
    const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController, subControllers } = buildWorldState(tickSystem);

    const broadcast = vi.fn();
    worldStateController.setBroadcastService({ broadcast });

    return { worldStateController, subControllers, broadcast, tickSystem };
}

/**
 * Spawns a smallBallDroid in start_room and returns the world plus its test
 * components: droidHead (volume 8, starts empty) and the right droidArm
 * (volume 8, starts empty).
 */
function spawnDroid(world) {
    const { worldStateController: wsc } = world;
    const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
    const entityId = wsc.spawnEntity('smallBallDroid', startRoomId);
    const entity = wsc.getEntity(entityId);
    const droidHead = entity.components.find((c) => c.type === 'droidHead');
    const droidArmRight = entity.components.find((c) => c.type === 'droidArm' && c.identifier === 'right');
    if (!droidHead || !droidArmRight) {
        throw new Error(`Test setup error: smallBallDroid must have droidHead and a right droidArm, got: ${entity.components.map((c) => `${c.type}/${c.identifier}`).join(', ')}`);
    }
    return { entityId, droidHead, droidArmRight };
}

/**
 * Adds items via the public facade and collects the created item IDs.
 * @param {import('../../src/controllers/WorldStateController.js')} wsc
 * @param {string} entityId
 * @param {string} componentId
 * @param {string[]} types
 * @returns {string[]} The new item IDs, in order.
 */
function addItems(wsc, entityId, componentId, types) {
    return types.map((type) => {
        const result = wsc.addItemToEntity(entityId, type, componentId);
        if (!result.success) {
            throw new Error(`Test setup error: addItemToEntity(${type} → ${componentId}) failed: ${result.message}`);
        }
        return result.item.id;
    });
}

/**
 * Returns the item instances hosted on one component (array form).
 * @param {import('../../src/controllers/WorldStateController.js')} wsc
 * @param {string} entityId
 * @param {string} componentId
 * @returns {Array<Object>}
 */
function componentItems(wsc, entityId, componentId) {
    const map = wsc.getEntityItems(entityId);
    return map[componentId] ?? [];
}

function itemsOfType(items, type) {
    return items.filter((item) => item.type === type);
}

describe('crafting contract — success path', () => {
    it('crafts 2 knives into 1 t1 on the same component; exactly one broadcast; no item loss', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidHead } = spawnDroid(world);

        const [knifeA, knifeB] = addItems(wsc, entityId, droidHead.id, ['knife', 'knife']);
        const broadcastCallsBefore = broadcast.mock.calls.length;

        const result = wsc.craftItems(entityId, 'knife_to_t1', droidHead.id, [knifeA, knifeB]);

        // Shape: mirrors the HTTP 200 body.
        expect(result.success).toBe(true);
        expect(result.recipeId).toBe('knife_to_t1');
        expect(result.consumed).toEqual([knifeA, knifeB]);
        expect(result.produced).toHaveLength(1);

        // The output landed on the SAME component (hostComponentId preserved).
        const t1 = result.produced[0];
        expect(t1.type).toBe('t1');
        expect(t1.hostComponentId).toBe(droidHead.id);

        // Inputs are gone from the component; exactly one t1 now sits there.
        const headItems = componentItems(wsc, entityId, droidHead.id);
        expect(itemsOfType(headItems, 'knife')).toHaveLength(0);
        expect(itemsOfType(headItems, 't1')).toHaveLength(1);
        expect(headItems[0].id).toBe(t1.id);
        expect(wsc.getItem(entityId, knifeA)).toBeNull();
        expect(wsc.getItem(entityId, knifeB)).toBeNull();

        // Exactly one broadcast on success (the two setup addItems happened
        // before this snapshot, so the delta must be exactly 1).
        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore + 1);
        expect(broadcast.mock.calls.at(-1)).toEqual([]);
    });
});

describe('crafting contract — failure paths (no mutation, no broadcast)', () => {
    it('1 knife for a 2-knife recipe → INPUTS_MISMATCH; knife intact; 0 broadcasts', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidHead } = spawnDroid(world);

        const [knifeA] = addItems(wsc, entityId, droidHead.id, ['knife']);
        const broadcastCallsBefore = broadcast.mock.calls.length;

        const result = wsc.craftItems(entityId, 'knife_to_t1', droidHead.id, [knifeA]);

        expect(result.success).toBe(false);
        expect(result.code).toBe('INPUTS_MISMATCH');
        expect(result.message).toContain('knife: have 1, need 2');

        // No mutation: the knife is exactly where it was.
        const headItems = componentItems(wsc, entityId, droidHead.id);
        expect(itemsOfType(headItems, 'knife').map((i) => i.id)).toEqual([knifeA]);
        expect(itemsOfType(headItems, 't1')).toHaveLength(0);

        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore);
    });

    it('item hosted on a different component → INVALID_ITEM; both knives intact; 0 broadcasts', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidHead, droidArmRight } = spawnDroid(world);

        const [knifeOnHead] = addItems(wsc, entityId, droidHead.id, ['knife']);
        const [knifeOnArm] = addItems(wsc, entityId, droidArmRight.id, ['knife']);
        const broadcastCallsBefore = broadcast.mock.calls.length;

        // The recipe inputs match by type (2 knives), but knifeOnArm is
        // hosted on the right droidArm, not on droidHead → rejected per item.
        const result = wsc.craftItems(entityId, 'knife_to_t1', droidHead.id, [knifeOnHead, knifeOnArm]);

        expect(result.success).toBe(false);
        expect(result.code).toBe('INVALID_ITEM');
        expect(result.message).toContain(knifeOnArm);
        expect(result.message).toContain(droidArmRight.id);

        // Both knives still on their original components.
        expect(wsc.getItem(entityId, knifeOnHead)?.hostComponentId).toBe(droidHead.id);
        expect(wsc.getItem(entityId, knifeOnArm)?.hostComponentId).toBe(droidArmRight.id);
        expect(itemsOfType(componentItems(wsc, entityId, droidHead.id), 't1')).toHaveLength(0);

        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore);
    });

    it('duplicated itemIds → INVALID_ITEM; zero mutation; zero broadcasts', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidHead } = spawnDroid(world);

        const [knifeA, knifeB] = addItems(wsc, entityId, droidHead.id, ['knife', 'knife']);
        const broadcastCallsBefore = broadcast.mock.calls.length;

        // The same instance listed twice: one instance can only be consumed
        // once, so the request must be rejected before any per-item work.
        const result = wsc.craftItems(entityId, 'knife_to_t1', droidHead.id, [knifeA, knifeA]);

        expect(result.success).toBe(false);
        expect(result.code).toBe('INVALID_ITEM');
        expect(result.message).toContain(knifeA);

        // Zero mutation: both knives still on droidHead, unchanged IDs.
        const headItems = componentItems(wsc, entityId, droidHead.id);
        expect(itemsOfType(headItems, 'knife').map((i) => i.id).sort()).toEqual([knifeA, knifeB].sort());
        expect(itemsOfType(headItems, 't1')).toHaveLength(0);

        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore);
    });

    it('unknown recipe → RECIPE_NOT_FOUND; unknown entity → ENTITY_NOT_FOUND; component not on entity → COMPONENT_NOT_FOUND; 0 broadcasts', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidHead, droidArmRight } = spawnDroid(world);
        const [knifeA, knifeB] = addItems(wsc, entityId, droidHead.id, ['knife', 'knife']);
        const broadcastCallsBefore = broadcast.mock.calls.length;

        const unknownRecipe = wsc.craftItems(entityId, 'nope_recipe', droidHead.id, [knifeA, knifeB]);
        expect(unknownRecipe.success).toBe(false);
        expect(unknownRecipe.code).toBe('RECIPE_NOT_FOUND');

        const unknownEntity = wsc.craftItems('ent-00000000-0000-0000-0000-000000000000', 'knife_to_t1', droidHead.id, [knifeA, knifeB]);
        expect(unknownEntity.success).toBe(false);
        expect(unknownEntity.code).toBe('ENTITY_NOT_FOUND');

        const foreignComponent = wsc.craftItems(entityId, 'knife_to_t1', 'comp-00000000-0000-0000-0000-000000000000', [knifeA, knifeB]);
        expect(foreignComponent.success).toBe(false);
        expect(foreignComponent.code).toBe('COMPONENT_NOT_FOUND');

        // None of the failures mutated anything or broadcast.
        const headItems = componentItems(wsc, entityId, droidHead.id);
        expect(itemsOfType(headItems, 'knife').map((i) => i.id).sort()).toEqual([knifeA, knifeB].sort());
        expect(itemsOfType(headItems, 't1')).toHaveLength(0);
        expect(itemsOfType(componentItems(wsc, entityId, droidArmRight.id), 't1')).toHaveLength(0);
        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore);
    });

    it('heavy output on a nearly-full component → INSUFFICIENT_VOLUME before consumption (no item loss)', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidArmRight } = spawnDroid(world);

        // Right droidArm has volume 8 and starts empty. Fill to 5/8 with
        // testItem2 (4) plus the knife (1) we will try to consume: free = 3.
        const [, knifeA] = addItems(wsc, entityId, droidArmRight.id, ['testItem2', 'knife']);

        // Test seam (intentional): the facade declares craftingController as a
        // null-tolerant injected dependency (src/controllers/WorldStateController.js:106)
        // and the composition root wires the identical dependency
        // (src/composition/WorldComposition.js:158). Reassigning the field here uses
        // that same seam. No setter is added to the public surface — it is pinned
        // by test/contract/worldStateController.contract.test.js:139.
        // The data-file recipe (knife_to_t1) always frees ≥ what it needs, so
        // it can never demonstrate the volume guard. Inject an alternate
        // CraftingController (the same dependency the composition root wires)
        // with a recipe whose output footprint (toolCrate, 30) far exceeds the
        // freed footprint (knife, 1) + free (3).
        const itemRegistry = DataLoader.loadJsonSafe('data/inventoryItems.json', {});
        wsc.craftingController = new CraftingController(
            {
                heavy_swap: {
                    id: 'heavy_swap',
                    name: 'Heavy Swap',
                    inputs: [{ type: 'knife', quantity: 1 }],
                    outputs: [{ type: 'toolCrate', quantity: 1 }],
                },
            },
            itemRegistry
        );

        const broadcastCallsBefore = broadcast.mock.calls.length;
        const result = wsc.craftItems(entityId, 'heavy_swap', droidArmRight.id, [knifeA]);

        expect(result.success).toBe(false);
        expect(result.code).toBe('INSUFFICIENT_VOLUME');
        expect(result.message).toContain(droidArmRight.id);
        expect(result.message).toContain('has 3 free, gains 1, needs 30');

        // NO item loss: every input item is still on the component, unchanged.
        const armItems = componentItems(wsc, entityId, droidArmRight.id);
        expect(itemsOfType(armItems, 'knife').map((i) => i.id)).toEqual([knifeA]);
        expect(itemsOfType(armItems, 'testItem2')).toHaveLength(1);
        expect(itemsOfType(armItems, 'toolCrate')).toHaveLength(0);

        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore);
    });

    it('volume drift (re-tuned definition) → INSUFFICIENT_VOLUME before consumption (no item loss)', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidHead } = spawnDroid(world);

        // droidHead (volume 8) filled to 1 free: testItem2 (4) + 3 knives (1 each).
        const [t2, kA, kB, kC] = addItems(wsc, entityId, droidHead.id, ['testItem2', 'knife', 'knife', 'knife']);

        // Model a re-tuned knife definition (volume 1 → 2) AFTER the knives
        // were created. getItemDefinitions is read only by the craft
        // pre-check, so the spy models definition drift precisely; the
        // persisted knife instances keep their original footprint of 1.
        const realRegistry = DataLoader.loadJsonSafe('data/inventoryItems.json', {});
        const driftSpy = vi.spyOn(wsc.inventoryManager, 'getItemDefinitions')
            .mockReturnValue(structuredClone({ ...realRegistry, knife: { ...realRegistry.knife, volume: 2 } }));

        // Alternate recipe: 2 knives → 1 testItem2 (output footprint 4).
        wsc.craftingController = new CraftingController(
            {
                knife_to_box: {
                    id: 'knife_to_box',
                    name: 'K2B',
                    inputs: [{ type: 'knife', quantity: 2 }],
                    outputs: [{ type: 'testItem2', quantity: 1 }],
                },
            },
            realRegistry
        );

        const broadcastCallsBefore = broadcast.mock.calls.length;
        const result = wsc.craftItems(entityId, 'knife_to_box', droidHead.id, [kA, kB]);
        driftSpy.mockRestore();

        // Instance-based freed: 2 × 1 = 2 ("gains 2"). The definition-based
        // old code would compute 2 × 2 = 4, pass the pre-check, consume both
        // knives, and then fail to fit the 4-volume output — destroying the
        // inputs (item loss).
        expect(result.success).toBe(false);
        expect(result.code).toBe('INSUFFICIENT_VOLUME');
        expect(result.message).toContain('has 1 free, gains 2, needs 4');

        // NO item loss: all three knives and the original testItem2 intact.
        const headItems = componentItems(wsc, entityId, droidHead.id);
        expect(itemsOfType(headItems, 'knife').map((i) => i.id).sort()).toEqual([kA, kB, kC].sort());
        expect(itemsOfType(headItems, 'testItem2').map((i) => i.id)).toEqual([t2]);
        expect(itemsOfType(headItems, 'toolCrate')).toHaveLength(0);

        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore);
    });

    it('input containing nested items → INVALID_ITEM; children intact; zero broadcasts', () => {
        const world = buildWorld();
        const { worldStateController: wsc, broadcast } = world;
        const { entityId, droidHead } = spawnDroid(world);

        // `outer` is a knife that HOLDS a knife; `inner2` is a plain knife.
        // (knife volume 1 = capacity 1, so one knife child fits.)
        const [outer] = addItems(wsc, entityId, droidHead.id, ['knife']);
        const nestedResult = wsc.addItemToContainer(entityId, outer, 'knife');
        expect(nestedResult.success).toBe(true);
        const childId = nestedResult.item.id;
        const [inner2] = addItems(wsc, entityId, droidHead.id, ['knife']);
        const broadcastCallsBefore = broadcast.mock.calls.length;

        const result = wsc.craftItems(entityId, 'knife_to_t1', droidHead.id, [outer, inner2]);

        expect(result.success).toBe(false);
        expect(result.code).toBe('INVALID_ITEM');
        expect(result.message).toContain('nested');

        // The container, its child, and the second knife are all intact.
        expect(wsc.getItem(entityId, outer)).not.toBeNull();
        const containerItems = wsc.getContainerItems(entityId, outer);
        expect(containerItems).toHaveLength(1);
        expect(containerItems[0].id).toBe(childId);
        expect(wsc.getItem(entityId, inner2)?.hostComponentId).toBe(droidHead.id);
        expect(itemsOfType(componentItems(wsc, entityId, droidHead.id), 't1')).toHaveLength(0);

        expect(broadcast.mock.calls.length).toBe(broadcastCallsBefore);
    });

    it('unwired craftingController degrades with a warning (not a silent empty registry)', () => {
        const world = buildWorld();
        const { worldStateController: wsc } = world;
        const { entityId, droidHead } = spawnDroid(world);

        // Same seam as the recipe-swap tests above: craftingController is an
        // injected dependency; null models the unwired composition state.
        const warnSpy = vi.spyOn(Logger, 'warn');
        wsc.craftingController = null;

        // The recipe listing degrades to an empty registry WITH a warning.
        expect(wsc.getCraftingRecipes()).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockClear();

        const [knifeA, knifeB] = addItems(wsc, entityId, droidHead.id, ['knife', 'knife']);
        warnSpy.mockClear();

        // And every craft fails RECIPE_NOT_FOUND (warned, once) — never a
        // silent success or a silent no-op.
        const result = wsc.craftItems(entityId, 'knife_to_t1', droidHead.id, [knifeA, knifeB]);
        expect(result.code).toBe('RECIPE_NOT_FOUND');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
    });
});

describe('crafting contract — data-driven registry & no-turn decision', () => {
    it('getCraftingRecipes() returns the data/crafting.json entries (deep copies)', () => {
        const world = buildWorld();
        const { worldStateController: wsc } = world;

        const recipes = wsc.getCraftingRecipes();
        expect(Array.isArray(recipes)).toBe(true);
        expect(recipes).toHaveLength(1);
        expect(recipes[0].id).toBe('knife_to_t1');
        expect(recipes[0].name).toBe('T1 Assembly');
        expect(recipes[0].inputs).toEqual([{ type: 'knife', quantity: 2 }]);
        expect(recipes[0].outputs).toEqual([{ type: 't1', quantity: 1 }]);

        // Defensive copy: mutating the result must not affect the controller.
        recipes[0].name = 'TAMPERED';
        expect(wsc.getCraftingRecipes()[0].name).toBe('T1 Assembly');
    });

    it("queueAction('knife_to_t1') → ACTION_NOT_FOUND (crafting does not consume a turn)", () => {
        const world = buildWorld();
        const { worldStateController: wsc, subControllers, tickSystem } = world;
        const { entityId } = spawnDroid(world);
        const turns = subControllers.turnSystemController;

        // Enter an open planning window (tick 10 → local 0 of round 1).
        tickSystem.currentTick = 10;
        turns.onTick();

        const result = turns.queueAction(entityId, 'knife_to_t1');
        expect(result.success).toBe(false);
        expect(result.code).toBe('ACTION_NOT_FOUND');
        expect(result.error).toContain('knife_to_t1');
    });
});

/**
 * Machine lifecycle — integration test.
 *
 * Verifies the full "craft -> place -> forge -> retrieve" flow in-process
 * (no HTTP/socket):
 *   1. a droid crafts a knife generator (1 coal + 1 knife);
 *   2. it places the machine into the world (POST /place-machine semantics);
 *   3. the machine's generator organ forges knives into its belly over turns;
 *   4. it retrieves the machine (POST /retrieve-machine semantics) — the item
 *      returns to inventory and the stored knives spill to the floor.
 *
 * Plus a guard: placing a non-machine item is rejected.
 *
 * @module test/unit/MachineLifecycle.test
 */
import { describe, it, expect, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { handlePlaceMachine } from '../../src/controllers/core/PlaceMachineHandler.js';
import { handleRetrieveMachine } from '../../src/controllers/core/RetrieveMachineHandler.js';
import Logger from '../../src/utils/Logger.js';

vi.spyOn(Logger, 'info').mockImplementation(() => {});
vi.spyOn(Logger, 'warn').mockImplementation(() => {});
vi.spyOn(Logger, 'error').mockImplementation(() => {});

function buildWorld() {
    const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController, subControllers } = buildWorldState(tickSystem);
    worldStateController.setBroadcastService({ broadcast: vi.fn() });
    return { worldStateController, subControllers, tickSystem };
}

/** Spawns a smallBallDroid and returns the entity + a storage component (droidHead). */
function spawnDroid(world) {
    const { worldStateController: wsc } = world;
    const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
    const entityId = wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    const entity = wsc.getEntity(entityId);
    const droidHead = entity.components.find((c) => c.type === 'droidHead');
    if (!droidHead) throw new Error('smallBallDroid must have a droidHead component');
    return { entityId, droidHead };
}

/** Adds items to a specific component via the public facade; returns the new item IDs. */
function addItems(wsc, entityId, componentId, types) {
    return types.map((type) => {
        const result = wsc.addItemToEntity(entityId, type, componentId);
        if (!result.success) throw new Error(`addItemToEntity(${type}) failed: ${result.message}`);
        return result.item.id;
    });
}

function flatItems(world, entityId) {
    return Object.values(world.getEntityItems(entityId) || {}).flat();
}

describe('Machine lifecycle (craft -> place -> forge -> retrieve)', () => {
    it('crafts a knife generator, places it, forges knives, retrieves it', () => {
        const { worldStateController: wsc, subControllers } = buildWorld();
        const { entityId, droidHead } = spawnDroid({ worldStateController: wsc });
        const deps = { worldStateController: wsc, machineRegistry: wsc.machineRegistry };

        // 1. Add 1 coal + 1 knife to the same component, then craft the generator.
        const [coalId, knifeId] = addItems(wsc, entityId, droidHead.id, ['coal', 'knife']);
        const craft = wsc.craftItems(entityId, 'craft_knife_generator', droidHead.id, [coalId, knifeId]);
        expect(craft.success, 'craft should succeed: ' + JSON.stringify(craft)).toBe(true);

        // 2. The knifeGenerator item is now in the droid's inventory.
        const machineItem = flatItems(wsc, entityId).find((i) => i.type === 'knifeGenerator');
        expect(machineItem, 'knifeGenerator item should exist after craft').toBeTruthy();

        // 3. Place the machine into the world.
        const place = handlePlaceMachine(deps, {
            entityId, itemId: machineItem.id, itemType: 'knifeGenerator', targetX: 30, targetY: 30
        });
        expect(place.success, 'place should succeed: ' + JSON.stringify(place)).toBe(true);
        const machineEntityId = place.machineEntityId;

        // 4. The machine is a static knifeGenerator at the chosen position.
        const machine = wsc.stateEntityController.getEntity(machineEntityId);
        expect(machine, 'machine entity should exist after place').toBeTruthy();
        expect(machine.blueprint).toBe('knifeGenerator');
        expect(machine.isStatic).toBe(true);
        expect(machine.machineType).toBe('knifeGenerator');
        expect(machine.spatial.x).toBe(place.position.x);
        expect(machine.spatial.y).toBe(place.position.y);
        // 5. The carried item was consumed on place.
        expect(flatItems(wsc, entityId).find((i) => i.type === 'knifeGenerator'), 'item should be consumed on place').toBeUndefined();

        // 5b. The placement is PERCEIVED on the room's first observation: the
        // baseline reports the machine with WHO placed it (the droid) and
        // WHERE (the chosen floor position) — derived from the machine tag on
        // the entity itself, so no side state is involved.
        const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
        const firstEntries = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 5 });
        const firstEntry = firstEntries?.[firstEntries.length - 1] ?? null;
        expect(firstEntry?.kind, 'first observation is a baseline').toBe('baseline');
        expect(firstEntry?.machines?.placed?.length, 'the baseline reports the placed machine').toBe(1);
        expect(firstEntry.machines.placed[0].name).toBe('Knife Generator');
        expect(firstEntry.machines.placed[0].type).toBe('knifeGenerator');
        expect(firstEntry.machines.placed[0].placedBy?.id, 'the placer is credited (who)').toBe(entityId);
        expect(firstEntry.machines.placed[0].x, 'the floor position is reported (where)').toBe(place.position.x);
        expect(firstEntry.machines.placed[0].y).toBe(place.position.y);
        // counts.machines mirrors the row (deliberately NOT part of total,
        // which already counts the machine's entity row).
        expect(firstEntry.counts.machines).toBe(1);

        // 6. The generator organ forges knives into the machine's belly over turns.
        const icc = subControllers.internalComponentController;
        icc.processTurnEffects(1);
        icc.processTurnEffects(2);
        const knivesInBelly = flatItems(wsc, machineEntityId).filter((i) => i.type === 'knife').length;
        expect(knivesInBelly, 'machine should have forged >=2 knives').toBeGreaterThanOrEqual(2);

        // 7. Retrieve the machine.
        const ret = handleRetrieveMachine(deps, { entityId, targetEntityId: machineEntityId });
        expect(ret.success, 'retrieve should succeed: ' + JSON.stringify(ret)).toBe(true);
        expect(ret.retrieved.itemType).toBe('knifeGenerator');
        expect(ret.spilled).toBe(knivesInBelly);

        // 8. The item returns to inventory, the machine despawns, knives spill to the floor.
        expect(flatItems(wsc, entityId).find((i) => i.type === 'knifeGenerator'), 'item should return on retrieve').toBeTruthy();
        expect(wsc.stateEntityController.getEntity(machineEntityId), 'machine should be despawned').toBeNull();
        const spilledKnives = Object.values(wsc.getDroppedItems() || {}).filter((d) => d.itemType === 'knife');
        expect(spilledKnives.length, 'spilled knives should be on the floor').toBeGreaterThanOrEqual(knivesInBelly);

        // 9. The retrieval is PERCEIVED too: the diff against the baseline
        // reports the machine's disappearance with its last-seen position and
        // the placer (the tag rode on the despawned entity's snapshot).
        const retEntries = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 5 });
        const retEntry = retEntries?.[retEntries.length - 1] ?? null;
        expect(retEntry?.kind, 'second observation is a delta').toBe('delta');
        expect(retEntry?.machines?.retrieved?.length, 'the delta reports the retrieved machine').toBe(1);
        expect(retEntry.machines.retrieved[0].name).toBe('Knife Generator');
        expect(retEntry.machines.retrieved[0].placedBy?.id, 'the retrieval row still credits the placer (who)').toBe(entityId);
        expect(retEntry.machines.retrieved[0].x, 'the last-seen position is reported (where)').toBe(place.position.x);
        expect(retEntry.machines.retrieved[0].y).toBe(place.position.y);
        expect(retEntry?.machines?.placed?.length, 'a retrieval flush has no placement rows').toBe(0);
    });

    it('rejects placing an item that is not a machine', () => {
        const { worldStateController: wsc } = buildWorld();
        const { entityId, droidHead } = spawnDroid({ worldStateController: wsc });
        const deps = { worldStateController: wsc, machineRegistry: wsc.machineRegistry };
        const [knifeId] = addItems(wsc, entityId, droidHead.id, ['knife']);
        const place = handlePlaceMachine(deps, { entityId, itemId: knifeId, itemType: 'knife' });
        expect(place.success).toBe(false);
        expect(place.message).toMatch(/not a placeable machine/);
        // No machine entity should have been created.
        expect(Object.values(wsc.stateEntityController.getAll()).some((e) => e.machineType === 'knifeGenerator')).toBe(false);
    });
});

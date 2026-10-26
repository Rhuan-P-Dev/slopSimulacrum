/**
 * Contract tests — WearLogic (clothes feature, simplified: pure volume
 * fit).
 *
 * Boots the real world (buildWorldState) and pins the boot-level behavior
 * of the fit rule: the item is worn on the component the caller picked,
 * and only when that component has at least the item's `wear.minVolume`
 * of free volume. Unit-level behavior (validation, idempotency, broadcast
 * discipline) lives in test/unit/WearLogic.test.js.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

// The drone in data/entities/npcs.json is gated by KILLER_LLM_DRONE_ENABLED;
// its initialItems include a worn t-shirt (the clothes feature) plus
// equipped tools.
const DRONE_NAME = 'Killer LLM Drone';

/**
 * Boots the real world exactly like src/server.js does (composition root).
 * The player is NOT an NPC: it incarnates on the socket-connect path, which
 * we replicate with spawnEntity (see playerInitialSpawns.contract.test.js).
 */
function buildWorld() {
    process.env.KILLER_LLM_DRONE_ENABLED = 'true';
    const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController } = buildWorldState(tickSystem);
    return worldStateController;
}


/** Looks up an entity id by its displayName via the public facade. */
function entityIdByName(facade, name) {
    const store = facade.getEntities();
    const list = store instanceof Map ? Array.from(store.values())
        : (Array.isArray(store) ? store : Object.values(store));
    const hit = list.find((e) => e && (e.name === name || e.displayName === name));
    return hit ? hit.id : null;
}

describe('WearLogic contract (pure volume fit, real world boot)', () => {
    let wsc;
    let playerEntityId;

    beforeAll(() => {
        wsc = buildWorld();
        const startRoomId = wsc.getRoomUidByLogicalId('start_room');
        playerEntityId = wsc.spawnEntity('smallBallDroid', startRoomId);
        expect(playerEntityId).toBeTruthy();
    });

    it('the player spawns WEARING the t-shirt on the slot-resolved component (world.json)', () => {
        const entityId = playerEntityId;
        const entity = wsc.getEntity(entityId);
        const worn = wsc.getWornItems(entityId);

        expect(worn).toHaveLength(1);
        expect(worn[0].itemType).toBe('tshirt');
        expect(worn[0].name).toBe('T-Shirt');

        // The fit is pure volume (wear.minVolume in the item registry):
        // the item is worn on the component the slot expression resolved
        // to — the same component that received the item's inventory slot.
        const tshirt = (entity.items || []).find((i) => i.type === 'tshirt');
        expect(tshirt).toBeTruthy();
        expect(worn[0].componentId).toBe(tshirt.hostComponentId);

        // Worn = equipped on that component (the equipped machinery
        // underneath the feature).
        const equipped = wsc.getEquippedItems(entityId);
        expect(equipped.some((eq) => eq.itemId === worn[0].itemId && eq.componentId === worn[0].componentId)).toBe(true);
    });

    it('an NPC t-shirt is worn on the first component with enough free volume (npcs.json)', () => {
        const entityId = entityIdByName(wsc, DRONE_NAME);
        expect(entityId).toBeTruthy();

        const entity = wsc.getEntity(entityId);
        const worn = wsc.getWornItems(entityId);

        expect(worn).toHaveLength(1);
        expect(worn[0].itemType).toBe('tshirt');

        // First component (in order) with at least wear.minVolume free
        // volume: the m1 body core (m1CentralBody), where the item's
        // inventory slot lands as well.
        expect(worn[0].componentId).toBe(entity.components[0].id);
    });

    it('a card droid spawns wearing the t-shirt (default card profile)', () => {
        const entityId = wsc._spawnSingleCard?.(300, 300, 'ClothesCard', null);
        expect(entityId).toBeTruthy();

        const worn = wsc.getWornItems(entityId);
        expect(worn).toHaveLength(1);
        expect(worn[0].itemType).toBe('tshirt');
    });

    it('the caller can choose the wear target (like /equip)', () => {
        const entityId = entityIdByName(wsc, DRONE_NAME);
        const entity = wsc.getEntity(entityId);

        const worn = wsc.getWornItems(entityId);
        const tshirtId = worn[0].itemId;

        // Unequip, then re-wear on a DIFFERENT component — any of the
        // entity's components with enough free volume is a valid target.
        expect(wsc.unequipItem(entityId, tshirtId, 'tshirt', worn[0].componentId).success).toBe(true);

        const candidates = entity.components
            .map((c) => ({ comp: c, free: wsc.inventoryManager.getAvailableVolume(entity, c.id) }))
            .filter((x) => x.comp.id !== worn[0].componentId && x.free >= 2)
            .sort((a, b) => b.free - a.free);
        expect(candidates.length).toBeGreaterThan(0);
        const target = candidates[0].comp;

        const result = wsc.wearItem(entityId, tshirtId, target.id);
        expect(result.success).toBe(true);
        expect(result.componentId).toBe(target.id);

        expect(wsc.getWornItems(entityId).map((w) => w.componentId)).toEqual([target.id]);
    });

    it('a component with less than minVolume of free volume does not fit', () => {
        const entityId = entityIdByName(wsc, DRONE_NAME);
        const entity = wsc.getEntity(entityId);

        const worn = wsc.getWornItems(entityId);
        const tshirtId = worn[0].itemId;
        expect(wsc.unequipItem(entityId, tshirtId, 'tshirt', worn[0].componentId).success).toBe(true);

        // Pick the component with the LEAST free volume; if it falls below
        // the t-shirt's minVolume the fit rule must reject it.
        const byFree = entity.components
            .map((c) => ({ comp: c, free: wsc.inventoryManager.getAvailableVolume(entity, c.id) }))
            .sort((a, b) => a.free - b.free);
        const tightest = byFree[0];

        const result = wsc.wearItem(entityId, tshirtId, tightest.comp.id);
        if (tightest.free < 2) {
            expect(result.success).toBe(false);
            expect(result.message).toMatch(/needs 2 to fit/);
        } else {
            // Every component of this blueprint is roomy enough: the
            // volume-rejection path is pinned by the unit tests. Restore
            // the state this probe just changed.
            expect(result.success).toBe(true);
            expect(wsc.unequipItem(entityId, tshirtId, 'tshirt', tightest.comp.id).success).toBe(true);
        }
    });

    it('a non-wearable item is rejected; re-wearing is idempotent; unequip empties worn', () => {
        const entityId = playerEntityId;
        const entity = wsc.getEntity(entityId);

        // The player carries a knife (world.json equip: true) — not
        // wearable (the recipe declares no wear.minVolume).
        const knife = (entity.items || []).find((i) => i.type === 'knife');
        expect(knife).toBeTruthy();
        const knifeResult = wsc.wearItem(entityId, knife.id, entity.components[0].id);
        expect(knifeResult.success).toBe(false);
        expect(knifeResult.message).toMatch(/cannot be worn/);

        // Re-wearing the t-shirt that is already worn fails idempotently.
        const worn = wsc.getWornItems(entityId);
        expect(worn).toHaveLength(1);
        const rewear = wsc.wearItem(entityId, worn[0].itemId, entity.components[0].id);
        expect(rewear.success).toBe(false);
        expect(rewear.message).toMatch(/already worn/);

        // Taking the t-shirt off empties the worn list...
        expect(wsc.unequipItem(entityId, worn[0].itemId, 'tshirt', worn[0].componentId).success).toBe(true);
        expect(wsc.getWornItems(entityId)).toHaveLength(0);

        // ...and the t-shirt can be worn again on its fit component
        // (the component the slot expression resolved to at spawn).
        expect(wsc.wearItem(entityId, worn[0].itemId, worn[0].componentId).success).toBe(true);
        expect(wsc.getWornItems(entityId)).toHaveLength(1);
    });

    it('wearing on a component of another entity is rejected', () => {
        const entityId = playerEntityId;
        const other = entityIdByName(wsc, DRONE_NAME);
        const otherEntity = wsc.getEntity(other);
        expect(otherEntity).toBeTruthy();

        const worn = wsc.getWornItems(entityId);
        const tshirtId = worn[0].itemId;
        expect(wsc.unequipItem(entityId, tshirtId, 'tshirt', worn[0].componentId).success).toBe(true);

        const foreignComp = otherEntity.components[0].id;
        const result = wsc.wearItem(entityId, tshirtId, foreignComp);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/does not belong to entity/);

        // The t-shirt is still carried; put it back where it started.
        expect(wsc.wearItem(entityId, tshirtId, worn[0].componentId).success).toBe(true);
    });
});

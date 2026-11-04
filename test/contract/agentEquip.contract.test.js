/**
 * Contract tests — the agent's equip_item / unequip_item tools against the
 * REAL world.
 *
 * The unit tests (test/unit/LLMAgentController.test.js) pin which door the
 * controller knocks on; this file pins that the door opens: a round driven by
 * a scripted model call actually moves world state through the real facade —
 * the clothing fit rule (WearLogic) included, because a wearable type is
 * dispatched through `wearItem` and not around it.
 *
 * One pair of tools for both jobs is the contract under test: the same
 * `equip_item` that puts a knife on also puts a shirt on (through the fit
 * rule), and the same `unequip_item` that takes a knife off also takes the
 * worn shirt off (a worn item IS an equipped entry).
 *
 * Boots the world exactly like src/server.js (composition root) and drives
 * the LLM agent with a scripted chatFull — no provider, no network (TST-3).
 * Each case normalizes the body through the facade before it acts, so no case
 * depends on the one that ran before it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';

// The drone in data/mods/core-npcs/npcs.json is gated by KILLER_LLM_DRONE_ENABLED
// and is LLM-routed (no deterministic brain), which is what runRound requires.
const DRONE_NAME = 'Killer LLM Drone';
/** The only wearable in the shipped item registry (wear.minVolume 2). */
const SHIRT = 'tshirt';

/** Boots the real world exactly like src/server.js does (composition root). */
function buildWorld() {
    process.env.KILLER_LLM_DRONE_ENABLED = 'true';
    const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController } = buildWorldState(tickSystem);
    return worldStateController;
}

function entityIdByName(facade, name) {
    const store = facade.getEntities();
    const list = store instanceof Map ? Array.from(store.values())
        : (Array.isArray(store) ? store : Object.values(store));
    const hit = list.find((e) => e && (e.name === name || e.displayName === name));
    return hit ? hit.id : null;
}

/**
 * The first carried item of `type` and the entity component that hosts it —
 * the same pair the agent reads from its Inventory line, and the only pair its
 * equip_item accepts: the host must be one of the entity's OWN components.
 * Items nested inside a container item (the t1 holds ten knives) are not
 * equippable, so they are skipped here exactly as the tool skips them.
 * Deterministic: the host map is walked in insertion order.
 */
function carriedOfType(facade, entityId, type) {
    const entity = facade.getEntity(entityId);
    const compIds = new Set((entity?.components || []).map((c) => c && c.id));
    const itemsByHost = facade.getEntityItems(entityId) || {};
    for (const [hostComponentId, items] of Object.entries(itemsByHost)) {
        if (!compIds.has(hostComponentId)) continue;
        const item = (items || []).find((i) => i && i.type === type);
        if (item) return { item, hostComponentId };
    }
    return null;
}

/**
 * The agent for one scripted round: only the LLM is faked. The world facade is
 * real, and no turn system is wired, so the self transaction runs on the
 * immediate path (the same one the HTTP routes use).
 */
function buildAgent(wsc, toolName, args) {
    const call = {
        role: 'assistant',
        content: null,
        tool_calls: [
            { id: 'call_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } },
            { id: 'call_2', type: 'function', function: { name: 'done', arguments: '{}' } }
        ]
    };
    const silent = { role: 'assistant', content: null, tool_calls: [] };
    let answered = false;
    return new LLMAgentController({
        llmController: {
            chatFull: async () => {
                const first = !answered;
                answered = true;
                return { content: null, toolCalls: [], finishReason: 'tool_calls', message: first ? call : silent };
            }
        },
        worldStateController: wsc,
        llmContextController: { buildContext: () => ({ text: '=== YOUR STATE === (contract fixture)' }) },
        roomChatController: { sendMessage: () => ({ success: true, message: { id: 'chat-1' } }) },
        turnSystemController: null
    });
}

describe('agent equip_item / unequip_item (real world, clothing included)', () => {
    let wsc;
    let droneId;

    /** Wears the carried shirt on its current host, so a case starts worn. */
    function wearShirt() {
        const worn = wsc.getWornItems(droneId);
        if (worn.length > 0) return worn[0];
        const carried = carriedOfType(wsc, droneId, SHIRT);
        expect(carried).toBeTruthy();
        expect(wsc.wearItem(droneId, carried.item.id, carried.hostComponentId).success).toBe(true);
        return wsc.getWornItems(droneId)[0];
    }

    /** Takes the worn shirt off again, so a case starts not-wearing it. */
    function removeShirt() {
        for (const worn of wsc.getWornItems(droneId)) {
            expect(wsc.unequipItem(droneId, worn.itemId).success).toBe(true);
        }
        expect(wsc.getWornItems(droneId)).toHaveLength(0);
        return carriedOfType(wsc, droneId, SHIRT);
    }

    beforeAll(() => {
        wsc = buildWorld();
        droneId = entityIdByName(wsc, DRONE_NAME);
        expect(droneId).toBeTruthy();
        // The spawn profile wears the t-shirt and equips the knife + t1
        // (data/mods/core-npcs/npcs.json) — the starting point of the body.
        expect(wsc.getWornItems(droneId).map((w) => w.itemType)).toEqual([SHIRT]);
        expect(wsc.getEquippedItems(droneId).some((eq) => eq.itemType === 'knife')).toBe(true);
    });

    it('unequip_item takes the WORN t-shirt off the real body', async () => {
        const worn = wearShirt();

        const result = await buildAgent(wsc, 'unequip_item', { itemType: SHIRT }).runRound(droneId, 1);

        expect(result.unequips).toHaveLength(1);
        expect(result.unequips[0]).toMatchObject({
            itemType: SHIRT,
            itemId: worn.itemId,
            componentId: worn.componentId,
            wearable: true,
            success: true
        });
        // The world, not just the tool result: nothing is worn any more, and
        // the shirt is still carried where it was worn.
        expect(wsc.getWornItems(droneId)).toHaveLength(0);
        expect(carriedOfType(wsc, droneId, SHIRT)?.item.id).toBe(worn.itemId);
    });

    it('equip_item puts that same shirt back on, and the world accepted the fit', async () => {
        const carried = removeShirt();

        const result = await buildAgent(wsc, 'equip_item', {
            itemType: SHIRT,
            componentId: carried.hostComponentId
        }).runRound(droneId, 2);

        expect(result.equips).toHaveLength(1);
        expect(result.equips[0]).toMatchObject({
            itemType: SHIRT,
            itemId: carried.item.id,
            componentId: carried.hostComponentId,
            wearable: true,
            success: true
        });
        // Worn again — on the component the world accepted, which is the fit
        // rule answering rather than being skipped.
        const worn = wsc.getWornItems(droneId);
        expect(worn).toHaveLength(1);
        expect(worn[0].itemId).toBe(carried.item.id);
        expect(worn[0].componentId).toBe(carried.hostComponentId);
    });

    it('the same pair still unequips and equips ordinary gear (the knife)', async () => {
        const off = await buildAgent(wsc, 'unequip_item', { itemType: 'knife' }).runRound(droneId, 3);
        expect(off.unequips[0]).toMatchObject({ itemType: 'knife', wearable: false, success: true });
        expect(wsc.getEquippedItems(droneId).some((eq) => eq.itemType === 'knife')).toBe(false);

        const carried = carriedOfType(wsc, droneId, 'knife');
        const on = await buildAgent(wsc, 'equip_item', {
            itemType: 'knife',
            componentId: carried.hostComponentId
        }).runRound(droneId, 4);

        expect(on.equips[0]).toMatchObject({
            itemType: 'knife',
            itemId: carried.item.id,
            componentId: carried.hostComponentId,
            wearable: false,
            success: true
        });
        expect(on.equips[0].detail).toBe(`equipped "knife" on ${carried.hostComponentId}`);
        expect(wsc.getEquippedItems(droneId).some((eq) => eq.itemType === 'knife')).toBe(true);
    });

    it('dresses only with what a component actually carries — aiming elsewhere is refused', async () => {
        wearShirt();
        const carried = removeShirt();
        const entity = wsc.getEntity(droneId);

        // The tool names the component that CARRIES the item, so a model cannot
        // dress out of a component that holds nothing of that type (and cannot
        // move an item between its own parts by guessing). The world is not
        // touched: the shirt stays where it was taken off.
        const occupied = new Set(Object.entries(wsc.getEntityItems(droneId) || {})
            .filter(([, items]) => (items || []).length > 0)
            .map(([hostId]) => hostId));
        const elsewhere = entity.components
            .filter((c) => c && !occupied.has(c.id))
            .sort((a, b) => a.id.localeCompare(b.id))[0];
        expect(elsewhere).toBeTruthy();

        const result = await buildAgent(wsc, 'equip_item', { itemType: SHIRT, componentId: elsewhere.id })
            .runRound(droneId, 5);

        expect(result.equips[0]).toMatchObject({ itemType: SHIRT, success: false });
        expect(result.equips[0].detail).toBe(
            `no "${SHIRT}" carried on ${elsewhere.id} (that component carries nothing)`
        );
        expect(wsc.getWornItems(droneId)).toHaveLength(0);
        expect(carriedOfType(wsc, droneId, SHIRT)?.item.id).toBe(carried.item.id);

        // Leave the body as the spawn profile dressed it.
        wearShirt();
        expect(wsc.getWornItems(droneId)).toHaveLength(1);
    });
});

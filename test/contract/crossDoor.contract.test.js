/**
 * CONTRACT TEST — crossing a door with the `crossDoor` action, against the real
 * world (data files + composition root, no network, no mocks).
 *
 * What this pins, and why nothing else does:
 *   - the ACTION EXISTS IN DATA (data/mods/core-actions/actions.json) and its
 *     `traverseDoor` consequence has a registered handler — an unregistered
 *     consequence type fails at dispatch with 'no-handler', which no unit test
 *     of the handler can see;
 *   - the CAPABILITY engine reports crossDoor executable for a spawned droid
 *     (the action declares Movement.move >= 5, so an agent's use_door tool fires
 *     against exactly the gate a queued action uses);
 *   - the CROSSING IS A REAL ROOM CHANGE: the entity's `location` moves to the
 *     room the door's connection names in data/mods/core-rooms/rooms.json, at the
 *     door-to-door spawn position (`getSpawnPositionForDoorTraversal`) rather
 *     than the room centre — which is what makes a droid walk out of one door and
 *     appear at the door on the far side;
 *   - the shipped map is BIDIRECTIONAL (right_door out, left_door back);
 *   - a door the room does not have is refused by the consequence and leaves the
 *     entity exactly where it was — the model never picks a destination, so an
 *     invented door cannot move anybody anywhere.
 *
 * The LLM tool that dispatches this action (`use_door`: its door allowlist, its
 * capability gate and its per-round budget) is pinned by
 * test/unit/LLMAgentController.test.js; the handler's own guards by
 * test/unit/DoorTraversalHandler.test.js.
 *
 * Every test spawns its OWN droid, so no test depends on the order of another
 * and none of them touch the card NPCs the world also spawns.
 *
 * @module test/contract/crossDoor.contract
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { DEFAULT_PLAYER_BLUEPRINT } from '../../shared/Defaults.js';

describe('crossDoor — walking through a door (real world, data-driven)', () => {
    let wsc;
    let startRoomId;
    let rightRoomId;
    let doorSpawn;

    beforeAll(() => {
        const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        ({ worldStateController: wsc } = buildWorldState(tickSystem));

        startRoomId = wsc.getRoomUidByLogicalId('start_room');
        rightRoomId = wsc.getRoomUidByLogicalId('right_room');
        // Where the world says a droid appears when it comes OUT of start_room's
        // right_door — the crossing must land here, not somewhere else.
        doorSpawn = wsc.roomsController.getSpawnPositionForDoorTraversal(startRoomId, 'right_door', rightRoomId);
    });

    /** A droid of its own, standing in The Entrance Hall. */
    function spawnInEntranceHall() {
        return wsc.spawnEntity(DEFAULT_PLAYER_BLUEPRINT, startRoomId);
    }

    /** Executes crossDoor the way the LLM agent does, through the action pipeline. */
    function cross(entityId, params) {
        return wsc.actionController.executeAction('crossDoor', entityId, params);
    }

    function firstConsequence(result) {
        return (result.results || [])[0] || {};
    }

    /**
     * Places a droid AT a door (test-side placement — the rule under test is the
     * crossing, not the walk). Returns the door position the world resolved, so a
     * test can also assert the geometry the Exits line prints.
     */
    function standAtDoor(entityId, roomId, door) {
        const pos = wsc.getDoorPosition(roomId, door);
        wsc.stateEntityController.updateEntitySpatial(entityId, pos);
        return pos;
    }

    it('declares crossDoor in data with the traverseDoor consequence, executable for a droid with legs', () => {
        const action = wsc.actionController.getRegistry().crossDoor;
        expect(action, 'crossDoor must be data, not code').toBeTruthy();
        expect(action.consequences[0].type).toBe('traverseDoor');

        const droidId = spawnInEntranceHall();
        const capable = wsc.getActionsForEntity(droidId).crossDoor?.canExecute || [];
        expect(capable.length).toBeGreaterThan(0);

        // The reach rule reads this number (how close a droid must stand to the
        // door); it is data, and the door geometry has to resolve for it to work.
        expect(typeof action.range).toBe('number');
        const doorPos = wsc.getDoorPosition(startRoomId, 'right_door');
        expect(Number.isFinite(doorPos?.x)).toBe(true);
        expect(Number.isFinite(doorPos?.y)).toBe(true);
    });

    it('moves a droid standing at the door into the room beyond, at the far-side door', () => {
        const droidId = spawnInEntranceHall();
        const doorPos = standAtDoor(droidId, startRoomId, 'right_door');

        const result = cross(droidId, { door: 'right_door' });

        expect(doorPos).toBeTruthy();

        expect(firstConsequence(result).success).toBe(true);
        expect(firstConsequence(result).error).not.toBe('no-handler');
        expect(wsc.getEntity(droidId).location).toBe(rightRoomId);
        expect(wsc.getEntity(droidId).spatial).toEqual(doorSpawn);
    });

    it('refuses to cross from the middle of the room — a door is a place, not a spell', () => {
        const droidId = spawnInEntranceHall();
        const centre = { ...wsc.getEntity(droidId).spatial };

        const result = cross(droidId, { door: 'right_door' });

        // Spawned at the room centre, the door is far outside the declared reach.
        expect(firstConsequence(result).success).toBe(false);
        expect(firstConsequence(result).message).toMatch(/units away — stand at it first/);
        expect(wsc.getEntity(droidId).location).toBe(startRoomId);
        expect(wsc.getEntity(droidId).spatial).toEqual(centre);
    });

    it('walks back through the opposite door into the room it came from', () => {
        const droidId = spawnInEntranceHall();
        standAtDoor(droidId, startRoomId, 'right_door');
        // Crossing lands the droid AT the door on the far side, so the return
        // crossing is in reach without walking anywhere.
        cross(droidId, { door: 'right_door' });

        const back = cross(droidId, { door: 'left_door' });

        expect(firstConsequence(back).success).toBe(true);
        expect(wsc.getEntity(droidId).location).toBe(startRoomId);
    });

    it('refuses a door the room does not have and leaves the droid where it stands', () => {
        const droidId = spawnInEntranceHall();
        standAtDoor(droidId, startRoomId, 'right_door');
        const positionBefore = { ...wsc.getEntity(droidId).spatial };

        const result = cross(droidId, { door: 'trap_door' });

        expect(firstConsequence(result).success).toBe(false);
        expect(firstConsequence(result).message).toContain('No door "trap_door"');
        expect(wsc.getEntity(droidId).location).toBe(startRoomId);
        expect(wsc.getEntity(droidId).spatial).toEqual(positionBefore);
    });

    it('refuses a crossing with no door named', () => {
        const droidId = spawnInEntranceHall();

        const result = cross(droidId, {});

        expect(firstConsequence(result).success).toBe(false);
        expect(firstConsequence(result).message).toBe('Missing door name.');
        expect(wsc.getEntity(droidId).location).toBe(startRoomId);
    });
});

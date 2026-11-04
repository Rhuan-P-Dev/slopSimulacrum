/**
 * DoorTraversalHandler — unit tests for the `traverseDoor` consequence
 * (the `crossDoor` action: a door of the actor's current room, the room beyond).
 *
 * The facade is a hand-built stub exposing only what the handler reads
 * (`getEntity`, `roomsController.getConnectionTarget`, `moveEntity`), so the
 * contract the handler keeps with the world is the thing under test: it asks for
 * the door's target through RoomsController, hands the door name to
 * `moveEntity` as `sourceDoor` (that is what makes the spawn land at the door on
 * the far side), and never reports a crossing the world refused. The real rooms
 * and the real consequence wiring are covered by
 * test/contract/crossDoor.contract.test.js.
 *
 * @module test/unit/DoorTraversalHandler
 */

import { describe, it, expect } from 'vitest';
import { handleDoorTraversal } from '../../src/controllers/consequences/DoorTraversalHandler.js';

const ENTITY_ID = 'ent-droid-0001';
const ROOM_A = 'room-a-uid';
const ROOM_B = 'room-b-uid';

/**
 * Builds a facade stub. `connections` is ROOM_A's door map (what
 * RoomsController.getConnectionTarget answers); `moveResult` flips the
 * moveEntity answer. The entity record is mutated by a successful move, the way
 * the real state controller does.
 */
function makeDeps({ entity = { id: ENTITY_ID, location: ROOM_A, spatial: { x: 5, y: 5 } }, connections = { right_door: ROOM_B }, moveResult = true } = {}) {
    const moves = [];
    const worldStateController = {
        getEntity: (id) => (id === entity.id ? entity : null),
        roomsController: {
            // The facade's designated door accessor: null for a door the room does
            // not have AND for a connection that resolves to no room.
            getConnectionTarget: (roomId, door) => (roomId === ROOM_A ? (connections[door] ?? null) : null)
        },
        moveEntity: (entityId, toRoomId, options) => {
            moves.push({ entityId, toRoomId, options });
            if (!moveResult) return false;
            entity.location = toRoomId;
            entity.spatial = { x: -125, y: -75 };
            return true;
        }
    };
    return { deps: { worldStateController }, moves, entity };
}

describe('handleDoorTraversal — the crossDoor consequence', () => {
    it('moves the entity through the door of its own room and reports both rooms', () => {
        const { deps, moves, entity } = makeDeps();

        const result = handleDoorTraversal(deps, { entityId: ENTITY_ID, door: 'right_door' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
            door: 'right_door',
            fromRoomId: ROOM_A,
            toRoomId: ROOM_B,
            spatial: { x: -125, y: -75 }
        });
        expect(entity.location).toBe(ROOM_B);
        // ONE move, and the door name travels as sourceDoor — that is what places
        // the entity at the door on the far side instead of the room centre.
        expect(moves).toEqual([{ entityId: ENTITY_ID, toRoomId: ROOM_B, options: { sourceDoor: 'right_door' } }]);
    });

    it('refuses a door the current room does not have, and moves nothing', () => {
        const { deps, moves, entity } = makeDeps();

        const result = handleDoorTraversal(deps, { entityId: ENTITY_ID, door: 'trap_door' });

        expect(result.success).toBe(false);
        expect(result.message).toContain('No door "trap_door"');
        expect(result.data).toBeNull();
        expect(entity.location).toBe(ROOM_A);
        expect(moves).toHaveLength(0);
    });

    it.each([
        ['no door at all', {}],
        ['an empty door name', { door: '' }],
        ['a non-string door name', { door: 42 }],
        ['the unresolved template token ":door"', { door: ':door' }]
    ])('refuses %s with "Missing door name." and moves nothing', (_label, params) => {
        const { deps, moves } = makeDeps();

        const result = handleDoorTraversal(deps, { entityId: ENTITY_ID, ...params });

        expect(result.success).toBe(false);
        expect(result.message).toBe('Missing door name.');
        expect(moves).toHaveLength(0);
    });

    it('refuses an actor it cannot resolve', () => {
        const { deps, moves } = makeDeps();

        const result = handleDoorTraversal(deps, { entityId: 'ent-gone-0001', door: 'right_door' });

        expect(result.success).toBe(false);
        expect(result.message).toContain('ent-gone-0001');
        expect(moves).toHaveLength(0);
    });

    it('refuses a dangling connection — a door that resolves to no room', () => {
        // The room declares a door whose target uid is missing from the map.
        // A null destination is never a room to walk into.
        const { deps, moves } = makeDeps({ connections: { right_door: null } });

        const result = handleDoorTraversal(deps, { entityId: ENTITY_ID, door: 'right_door' });

        expect(result.success).toBe(false);
        expect(result.message).toContain('No door "right_door"');
        expect(moves).toHaveLength(0);
    });

    it('reports failure when the world refuses the move', () => {
        const { deps, entity } = makeDeps({ moveResult: false });

        const result = handleDoorTraversal(deps, { entityId: ENTITY_ID, door: 'right_door' });

        expect(result.success).toBe(false);
        expect(result.message).toContain('Could not move');
        expect(result.data).toBeNull();
        expect(entity.location).toBe(ROOM_A);
    });

    it('refuses without a facade (a handler never throws on its own)', () => {
        const result = handleDoorTraversal({ worldStateController: null }, { entityId: ENTITY_ID, door: 'right_door' });

        expect(result.success).toBe(false);
        expect(result.message).toBe('WorldStateController not available.');
    });
});

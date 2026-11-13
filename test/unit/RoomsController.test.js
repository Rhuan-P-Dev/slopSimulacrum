/**
 * RoomsController - room-definition validation, and a map that grows at runtime.
 *
 * Pins the new static room-environment enums from the "Add air, ceiling,
 * condition and power" change (commit 05dea00): out-of-vocab ceiling/condition/power
 * and airQuality/fog are refused with a *named* TypeError naming the field and the
 * allowed values. The rules themselves now live in `WorldStructureRules` (the same text
 * the plan/apply classifier and the System's proposal answer with); this file still pins
 * the byte-exact message, because boot's wording is a contract.
 *
 * Construction/mock seam (mirrors test/unit/WorldStateController.npcValidation.test.js):
 *   - A single top-level `vi.mock` of '../../src/utils/DataLoader.js' serves a
 *     mutable `fixtureRooms` for 'data/mods/core-rooms/rooms.json' (the only path
 *     RoomsController loads) and delegates every other path to the real
 *     DataLoader.
 *   - The real controller is built via `new RoomsController()` (the public
 *     constructor), which runs the production validation. These tests therefore
 *     pin behavior *through the public entry point* (TST-1), never a private validator.
 *
 * @module test/unit/RoomsController
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import RoomsController from '../../src/controllers/core/RoomsController.js';

// ---------------------------------------------------------------------------
// Fixture state (shared across all tests via the hoisted top-level vi.mock)
// ---------------------------------------------------------------------------

/** @type {Object|null} - room definitions served for data/mods/core-rooms/rooms.json. */
let fixtureRooms = null;

function setRooms(rooms) {
    fixtureRooms = rooms;
}

function resetRooms() {
    fixtureRooms = null;
}

/**
 * A minimal room definition that passes every validation branch except the one
 * the test overrides - the common base for the throw matrix.
 * @param {Object} [overrides] Extra/overriding fields for `start_room`.
 * @returns {Object} A single-room definition map.
 */
function baseRoom(overrides = {}) {
    return {
        start_room: {
            name: 'Start Room',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            connections: {},
            ...overrides
        }
    };
}

// ---------------------------------------------------------------------------
// Top-level DataLoader mock (hoisted by vitest)
// ---------------------------------------------------------------------------

/**
 * The fixture content served for one data path, or `undefined` to fall through to
 * the real seam.
 * @param {string} relativePath
 * @returns {Object|undefined}
 */
function fixtureFor(relativePath) {
    if (relativePath === 'data/mods/core-rooms/rooms.json') return fixtureRooms ?? {};
    return undefined;
}

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');

    // SUBCLASS, never enumerate. Static methods are non-enumerable, so spreading the
    // real seam copies nothing, and a method this mock forgot is not an error - it is
    // a world silently built from nothing. Inheriting keeps every seam method working
    // including ones added later, and the real loadRegistry already routes through the
    // overridden loadJsonSafe below.
    return {
        ...actual,
        default: class FixtureDataLoader extends actual.default {
            static loadJson(relativePath) {
                const fixture = fixtureFor(relativePath);
                return fixture !== undefined ? fixture : super.loadJson(relativePath);
            }

            static loadJsonSafe(relativePath, defaultValue) {
                const fixture = fixtureFor(relativePath);
                return fixture !== undefined ? fixture : super.loadJsonSafe(relativePath, defaultValue);
            }
        }
    };
});

beforeEach(() => {
    resetRooms();
});

/**
 * Builds a real `RoomsController` (running the public validation), asserts the
 * constructor threw a `TypeError`, and returns the thrown error so the message
 * (field name + allowed values) can be byte-pinned.
 * @param {Function} fn
 * @returns {TypeError} The thrown error.
 */
function thrownTypeError(fn) {
    let caught = null;
    try {
        fn();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    return caught;
}

describe('RoomsController - room-level constrained enums (ceiling/condition/power)', () => {
    it('rejects ceiling outside VALID_CEILING with a named TypeError', () => {
        setRooms(baseRoom({ ceiling: 'tall' }));
        const err = thrownTypeError(() => new RoomsController());
        expect(err.message).toBe(
            "Room 'start_room' ceiling must be one of low, high, vaulted, open"
        );
    });

    it('rejects a non-string ceiling with a named TypeError', () => {
        setRooms(baseRoom({ ceiling: 123 }));
        const err = thrownTypeError(() => new RoomsController());
        expect(err.message).toBe(
            "Room 'start_room' ceiling must be one of low, high, vaulted, open"
        );
    });

    it('rejects condition outside VALID_CONDITION with a named TypeError', () => {
        setRooms(baseRoom({ condition: 'burnt' }));
        const err = thrownTypeError(() => new RoomsController());
        expect(err.message).toBe(
            "Room 'start_room' condition must be one of pristine, worn, decaying, derelict"
        );
    });

    it('rejects power outside VALID_POWER with a named TypeError', () => {
        setRooms(baseRoom({ power: 'out' }));
        const err = thrownTypeError(() => new RoomsController());
        expect(err.message).toBe(
            "Room 'start_room' power must be one of live, flickering, dead"
        );
    });
});

describe('RoomsController - atmosphere constrained enums (airQuality/fog)', () => {
    it('rejects airQuality outside VALID_AIR_QUALITY with a named TypeError', () => {
        setRooms(baseRoom({ atmosphere: { airQuality: 'muddy' } }));
        const err = thrownTypeError(() => new RoomsController());
        expect(err.message).toBe(
            'Room \'start_room\' atmosphere.airQuality must be one of clean, stale, smoky, toxic'
        );
    });

    it('rejects fog outside VALID_FOG with a named TypeError', () => {
        setRooms(baseRoom({ atmosphere: { fog: 'dense' } }));
        const err = thrownTypeError(() => new RoomsController());
        expect(err.message).toBe(
            "Room 'start_room' atmosphere.fog must be one of none, hazy, thick"
        );
    });

    it('rejects a non-string atmosphere.fog with a named TypeError', () => {
        setRooms(baseRoom({ atmosphere: { fog: 5 } }));
        const err = thrownTypeError(() => new RoomsController());
        expect(err.message).toBe(
            "Room 'start_room' atmosphere.fog must be one of none, hazy, thick"
        );
    });
});

describe('RoomsController - normalization (happy path)', () => {
    it('accepts all new fields with in-enum values and normalizes them (no throw)', () => {
        setRooms(baseRoom({
            ceiling: 'vaulted',
            condition: 'derelict',
            power: 'dead',
            atmosphere: { airQuality: 'toxic', fog: 'thick' }
        }));
        const rc = new RoomsController();
        const rooms = rc.getAll();
        expect(Object.keys(rooms).length).toBe(1);
        const [room] = Object.values(rooms);
        expect(room.ceiling).toBe('vaulted');
        expect(room.condition).toBe('derelict');
        expect(room.power).toBe('dead');
        expect(room.atmosphere.airQuality).toBe('toxic');
        expect(room.atmosphere.fog).toBe('thick');
    });
});

// ---------------------------------------------------------------------------
// The map grows: a room can join a RUNNING world (wiki/decisions/world-structure-authoring.md)
// ---------------------------------------------------------------------------

describe('RoomsController - the map grows (addRoom / connectRooms / reconcile)', () => {
    /** A room the map can build, distinct from `baseRoom`'s `start_room`. */
    const annex = (overrides = {}) => ({
        name: 'Annex',
        connections: {},
        x: 400,
        y: 0,
        width: 200,
        height: 200,
        ...overrides
    });

    /** A controller over one installed `start_room`. */
    function worldWithStartRoom() {
        setRooms(baseRoom());
        return new RoomsController();
    }

    it('addRoom installs a new room under a fresh uid, with the record shape every consumer reads', () => {
        const rc = worldWithStartRoom();
        const before = rc.getAll();

        const { roomId } = rc.addRoom('annex', annex({ atmosphere: { fog: 'hazy' } }));

        const rooms = rc.getAll();
        expect(Object.keys(rooms)).toHaveLength(2);
        expect(Object.keys(before)).toHaveLength(1);
        expect(rooms[roomId]).toMatchObject({ id: roomId, name: 'Annex', x: 400, width: 200, connections: {}, objects: [], entities: [] });
        expect(rooms[roomId].atmosphere.fog).toBe('hazy');
        expect(rc.getUidByLogicalId('annex')).toBe(roomId);
        expect(rc.getLogicalId(roomId)).toBe('annex');
    });

    it('addRoom refuses a key the map already has and a definition boot would refuse', () => {
        const rc = worldWithStartRoom();
        expect(() => rc.addRoom('start_room', annex())).toThrow(/already exists/);
        expect(() => rc.addRoom('annex', { name: 'Annex' })).toThrow("Room 'annex' must have a connections object");
        expect(rc.logicalIds()).toEqual(['start_room']);
    });

    it('connectRooms opens the door both ways, and the geometry finds it', () => {
        const rc = worldWithStartRoom();
        // Centres aligned (start_room is 100x100 at the origin), so the exit lands exactly
        // on the source room's east edge.
        const { roomId: annexUid } = rc.addRoom('annex', annex({ y: -50 }));

        const opened = rc.connectRooms('start_room', 'east_door', 'annex');

        const rooms = rc.getAll();
        expect(opened).toMatchObject({ door: 'east_door', toRoomId: annexUid, targetDoor: 'back_to_east_door' });
        expect(rooms[opened.fromRoomId].connections.east_door.target).toBe(annexUid);
        expect(rooms[annexUid].connections.back_to_east_door.target).toBe(opened.fromRoomId);
        // The two-tier door geometry works on a runtime door exactly as on an authored one:
        // a room to the east puts the exit on the source room's east edge.
        expect(rc.getDoorPosition(opened.fromRoomId, 'east_door')).toEqual({ x: 50, y: 0 });
    });

    it('connectRooms never re-points a door that exists, and refuses a room joined to itself', () => {
        const rc = worldWithStartRoom();
        rc.addRoom('annex', annex());
        rc.connectRooms('start_room', 'east_door', 'annex');

        expect(() => rc.connectRooms('start_room', 'east_door', 'annex')).toThrow(/already has a door 'east_door'/);
        expect(() => rc.connectRooms('start_room', 'loop', 'start_room')).toThrow(/cannot connect to itself/);
        expect(() => rc.connectRooms('nowhere', 'east_door', 'annex')).toThrow("No room 'nowhere'");
    });

    it('reconcile adds what the definition grew by, and never moves, renames or re-points what the actors already know', () => {
        const rc = worldWithStartRoom();
        const startUid = rc.getUidByLogicalId('start_room');

        const report = rc.reconcile({
            // An existing room "changed": renamed, resized, moved, and given a new door.
            start_room: { name: 'Renamed', connections: { east_door: { target: 'annex' } }, x: 999, y: 999, width: 1, height: 1 },
            annex: { name: 'Annex', connections: { back: { target: 'start_room' } }, x: 400, y: 0, width: 200, height: 200 }
        });

        expect(report.added.map((entry) => entry.logicalId)).toEqual(['annex']);
        const start = rc.getRoom(startUid);
        expect(start.name).toBe('Start Room');   // never renamed
        expect(start.x).toBe(0);                 // never moved
        expect(start.width).toBe(100);           // never resized
        // A door the definition adds to an installed room is additive, and it resolves.
        expect(start.connections.east_door.target).toBe(rc.getUidByLogicalId('annex'));
        expect(rc.getRoom(rc.getUidByLogicalId('annex')).connections.back.target).toBe(startUid);
        expect(report.doorsAdded).toHaveLength(2);
    });

    it('reconcile skips the room it cannot build — with the rule text — and the rest lands', () => {
        const rc = worldWithStartRoom();

        const report = rc.reconcile({
            broken: { name: 'Broken' },
            // A door leading to a room the definition does not hold is the room's own
            // defect: the same candidate rule `CompositionClassifier` applies, so reconcile
            // refuses it rather than install a room with a hole in it.
            annex: { name: 'Annex', connections: { door_to_ghost: { target: 'ghost' } }, x: 0, y: 300, width: 50, height: 50 },
            // A room declared after the one that points at it is still known: the door
            // resolution is a second pass, exactly as the constructor's is.
            east: { name: 'East', connections: {}, x: 400, y: 0, width: 50, height: 50 },
            hub: { name: 'Hub', connections: { east_door: { target: 'east' } }, x: 200, y: 0, width: 50, height: 50 }
        });

        expect(report.added.map((entry) => entry.logicalId)).toEqual(['east', 'hub']);
        expect(report.skipped.map((entry) => entry.logicalId)).toEqual(['broken', 'annex']);
        expect(report.skipped[0].reason).toContain("Room 'broken' must have a connections object");
        expect(report.skipped[1].reason).toContain("targets unknown room 'ghost'");
        expect(rc.getRoom(rc.getUidByLogicalId('hub')).connections.east_door.target)
            .toBe(rc.getUidByLogicalId('east'));
    });

    it('reconcile with nothing new changes nothing', () => {
        const rc = worldWithStartRoom();
        const before = rc.getAll();
        expect(rc.reconcile({ start_room: { ...baseRoom().start_room, name: 'Same' } })).toMatchObject({ added: [], doorsAdded: [], skipped: [] });
        expect(rc.getAll()).toEqual(before);
        expect(rc.reconcile(null)).toMatchObject({ added: [], doorsAdded: [], skipped: [] });
    });
});

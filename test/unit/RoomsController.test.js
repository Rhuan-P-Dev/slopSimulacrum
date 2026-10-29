/**
 * RoomsController - room-definition validation unit tests.
 *
 * Pins the new static room-environment enums from the "Add air, ceiling,
 * condition and power" change (commit 05dea00). `_validateRoomDefinitions`
 * rejects out-of-vocab ceiling/condition/power and `_validateAtmosphere`
 * rejects out-of-vocab airQuality/fog with a *named* TypeError that names the
 * field and the allowed values.
 *
 * Construction/mock seam (mirrors test/unit/WorldStateController.npcValidation.test.js):
 *   - A single top-level `vi.mock` of '../../src/utils/DataLoader.js' serves a
 *     mutable `fixtureRooms` for 'data/world/rooms.json' (the only path
 *     RoomsController loads) and delegates every other path to the real
 *     DataLoader.
 *   - The real controller is built via `new RoomsController()` (the public
 *     constructor), which runs the production validation. These tests therefore
 *     pin behavior *through the public entry point* (TST-1), never the private
 *     `_validateRoomDefinitions`/`_validateAtmosphere`.
 *
 * @module test/unit/RoomsController
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import RoomsController from '../../src/controllers/core/RoomsController.js';

// ---------------------------------------------------------------------------
// Fixture state (shared across all tests via the hoisted top-level vi.mock)
// ---------------------------------------------------------------------------

/** @type {Object|null} - room definitions served for data/world/rooms.json. */
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

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');
    const realDefault = actual.default || {};
    return {
        default: {
            loadJsonSafe(path, defaultValue) {
                if (path === 'data/world/rooms.json') {
                    return fixtureRooms !== null ? fixtureRooms : defaultValue;
                }
                // Delegate every other path to the real DataLoader.
                if (realDefault.loadJsonSafe) {
                    return realDefault.loadJsonSafe(path, defaultValue);
                }
                return defaultValue;
            },
            loadJson: realDefault.loadJson
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

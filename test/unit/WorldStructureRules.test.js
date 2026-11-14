/**
 * UNIT TEST — WorldStructureRules: one shape for a room and a prop, three callers.
 *
 * The rules are checked at boot (`RoomsController`), at plan/apply
 * (`CompositionClassifier`) and at proposal (`WorldProposalValidator` through that
 * classifier). Pinned here so the wording the boot path has always said stays the wording
 * the other two say, and so a rule added for one caller cannot silently exist for one
 * caller only (`CR T-2`).
 *
 * Behaviour through the public functions, never through a private helper (`TST-1`).
 *
 * @module test/unit/WorldStructureRules
 */

import { describe, it, expect } from 'vitest';
import {
    ROOM_FIELD_ENUMS,
    ATMOSPHERE_ENUMS,
    assertRoomDefinitions,
    doorPositionErrors,
    roomDefinitionErrors,
    roomDefinitionsErrors,
    worldObjectDefinitionErrors
} from '../../src/services/WorldStructureRules.js';

/** A room every rule accepts (its own doors point at nothing — see the target test). */
const room = (over = {}) => ({
    name: 'Annex',
    connections: {},
    x: 400,
    y: 0,
    width: 200,
    height: 200,
    ...over
});

describe('roomDefinitionErrors', () => {
    it('accepts a room the map could be built from', () => {
        expect(roomDefinitionErrors('annex', room(), { knownLogicalIds: ['start_room', 'annex'] })).toEqual([]);
    });

    it('says the sentence boot says, byte for byte, on a constrained enum', () => {
        expect(roomDefinitionErrors('annex', room({ ceiling: 'tall' }))[0])
            .toBe("Room 'annex' ceiling must be one of " + ROOM_FIELD_ENUMS.ceiling.join(', '));
        expect(roomDefinitionErrors('annex', room({ atmosphere: { fog: 'soup' } }))
            .join(' ')).toContain(`atmosphere.fog must be one of ${ATMOSPHERE_ENUMS.fog.join(', ')}`);
    });

    it('names every violation of one room, not only the first', () => {
        const errors = roomDefinitionErrors('annex', { connections: {}, x: 'here', width: null });
        expect(errors).toContain("Room 'annex' must have a non-empty name");
        expect(errors).toContain("Room 'annex' must have numeric x, y coordinates");
        expect(errors).toContain("Room 'annex' must have numeric width, height");
    });

    it('refuses a connection to a room the candidate does not hold — only when it has a candidate to check against', () => {
        const linking = room({ connections: { west_door: { target: 'start_room' } } });
        expect(roomDefinitionErrors('annex', linking, { knownLogicalIds: ['start_room', 'annex'] })).toEqual([]);
        const withContext = roomDefinitionErrors('annex', linking, { knownLogicalIds: ['annex'] });
        expect(withContext.join(' ')).toContain("targets unknown room 'start_room'");
        // Boot reads the definition, not a candidate of one, and has never rejected a
        // dangling target. The absence of the context is the difference, not the rule.
        expect(roomDefinitionErrors('annex', room()).join(' ')).not.toContain('unknown room');
    });

    it('checks a door position in either format and refuses a half of neither', () => {
        expect(doorPositionErrors({ x: 1, y: 2 }, 'annex', 'door')).toEqual([]);
        expect(doorPositionErrors({ edge: 'top', offset: 0.5 }, 'annex', 'door')).toEqual([]);
        expect(doorPositionErrors({ edge: 'middle', offset: 2 }, 'annex', 'door').length).toBe(2);
        expect(doorPositionErrors({}, 'annex', 'door').join(' '))
            .toContain('position must have either { x, y } or { edge, offset }');
    });
});

describe('assertRoomDefinitions', () => {
    it('throws the first violation as a TypeError, the way boot always has', () => {
        expect(() => assertRoomDefinitions({ annex: room({ name: '   ' }) })).toThrow(TypeError);
        expect(() => assertRoomDefinitions(null)).toThrow('Room definitions must be an object');
        expect(() => assertRoomDefinitions({ annex: room(), other: room({ name: 'Other' }) })).not.toThrow();
    });

    it('collects every room violation when asked for the list', () => {
        const errors = roomDefinitionsErrors({ a: { name: 'A' }, b: { name: 'B' } });
        expect(errors.length).toBeGreaterThan(4);
        expect(errors.join(' ')).toContain("Room 'a'");
        expect(errors.join(' ')).toContain("Room 'b'");
    });
});

describe('worldObjectDefinitionErrors', () => {
    const blueprints = { tree: { name: 'Tree' } };
    const rooms = { start_room: room() };

    it('accepts a prop whose blueprint and room both resolve', () => {
        expect(worldObjectDefinitionErrors('bench', { blueprint: 'tree', room: 'start_room', position: { x: 0, y: -80 } }, { blueprints, rooms }))
            .toEqual([]);
    });

    it('accepts a prop that names no room — the shape boot reads as "the start room"', () => {
        // `room` is OPTIONAL, and absent is not a violation: `_spawnStaticProps` reads a missing
        // room as `start_room` (the shipped prop file relies on it). Pinned here so the default
        // is a rule, not an accident; the behavior half is pinned end-to-end in
        // test/integration/modApplyAtRoundBoundary.test.js.
        expect(worldObjectDefinitionErrors('bench', { blueprint: 'tree' }, { blueprints, rooms }))
            .toEqual([]);
        // Present-but-empty is a different thing from absent, and is refused.
        expect(worldObjectDefinitionErrors('bench', { blueprint: 'tree', room: '  ' }, { blueprints, rooms })
            .join(' ')).toContain('room must be a non-empty string');
    });

    it('refuses a prop pointing at a blueprint or a room that is not there', () => {
        const errors = worldObjectDefinitionErrors('bench', { blueprint: 'unobtainium', room: 'nowhere' }, { blueprints, rooms });
        expect(errors.join(' ')).toContain("targets unknown blueprint 'unobtainium'");
        expect(errors.join(' ')).toContain("targets unknown room 'nowhere'");
    });

    it('refuses a position that is not a point', () => {
        expect(worldObjectDefinitionErrors('bench', { blueprint: 'tree', position: { x: 'left' } }, {}).join(' '))
            .toContain('position.x must be a finite number');
    });

    it('does not invent a reference rule it has no context for', () => {
        // No blueprints passed means "cannot cross-check", not "there are none" — the same
        // reading the room rules take, so one caller cannot be stricter than another by
        // accident.
        expect(worldObjectDefinitionErrors('bench', { blueprint: 'tree', room: 'start_room' }, {})).toEqual([]);
    });
});

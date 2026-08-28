/**
 * ContextResolution unit tests (spec "better text & vision" — M2).
 *
 * Covers the shared, stateless exit-resolution helpers used by BOTH the LLM
 * text layer (LlmContextController) and the frontend event-panel route
 * (worldEventRoutes):
 *   (a) object-form connection ({ target: <uid> }) resolves to the room name,
 *   (b) string-form connection (<uid>) resolves to the room name,
 *   (c) a dangling target UID (not in the rooms map) → 'unknown',
 *   (d) resolveRoomExits slices to the maxExits cap.
 *
 * @module test/unit/ContextResolution
 */

import { describe, it, expect } from 'vitest';
import {
    UNRESOLVED_ROOM_NAME,
    resolveExitTargetRoomName,
    resolveRoomExits
} from '../../src/utils/ContextResolution.js';

const ROOMS = {
    'room-1': { id: 'room-1', name: 'The Entrance Hall' },
    'room-2': { id: 'room-2', name: 'The Deep Vault' }
};

describe('ContextResolution', () => {
    describe('resolveExitTargetRoomName', () => {
        it('(a) resolves an object-form connection { target } to the target room name', () => {
            expect(resolveExitTargetRoomName(ROOMS, { target: 'room-2' })).toBe('The Deep Vault');
        });

        it('(b) resolves a string-form connection (bare target UID) to the target room name', () => {
            expect(resolveExitTargetRoomName(ROOMS, 'room-2')).toBe('The Deep Vault');
        });

        it('(c) returns the unresolved token for a dangling target UID not in the rooms map', () => {
            expect(resolveExitTargetRoomName(ROOMS, { target: 'room-missing' })).toBe(UNRESOLVED_ROOM_NAME);
            expect(UNRESOLVED_ROOM_NAME).toBe('unknown');
            expect(resolveExitTargetRoomName(ROOMS, 'room-missing')).toBe('unknown');
        });

        it('(c) returns the unresolved token for a null/empty connection value', () => {
            expect(resolveExitTargetRoomName(ROOMS, null)).toBe('unknown');
            expect(resolveExitTargetRoomName(ROOMS, undefined)).toBe('unknown');
            expect(resolveExitTargetRoomName(ROOMS, { target: null })).toBe('unknown');
        });
    });

    describe('resolveRoomExits', () => {
        it('pairs each door with its resolved target room name', () => {
            const room = {
                id: 'room-1',
                connections: {
                    right_door: { target: 'room-2' },
                    back_door: 'room-2'
                }
            };
            expect(resolveRoomExits(ROOMS, room, 6)).toEqual([
                { door: 'right_door', targetRoomName: 'The Deep Vault' },
                { door: 'back_door', targetRoomName: 'The Deep Vault' }
            ]);
        });

        it('(d) slices the exits list to the maxExits cap', () => {
            const room = {
                id: 'room-1',
                connections: {
                    door_a: { target: 'room-2' },
                    door_b: { target: 'room-2' },
                    door_c: { target: 'room-2' },
                    door_d: { target: 'room-2' }
                }
            };
            const exits = resolveRoomExits(ROOMS, room, 2);
            expect(exits).toHaveLength(2);
            expect(exits.map(e => e.door)).toEqual(['door_a', 'door_b']);
        });

        it('resolves a dangling target to the unresolved token within the exits list', () => {
            const room = { id: 'room-1', connections: { ghost_door: { target: 'room-missing' } } };
            expect(resolveRoomExits(ROOMS, room, 6)).toEqual([
                { door: 'ghost_door', targetRoomName: 'unknown' }
            ]);
        });

        it('returns an empty array for a room with no connections (or none defined)', () => {
            expect(resolveRoomExits(ROOMS, { id: 'room-1', connections: {} }, 6)).toEqual([]);
            expect(resolveRoomExits(ROOMS, { id: 'room-1' }, 6)).toEqual([]);
        });
    });
});

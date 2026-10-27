/**
 * RoundProseBuilder unit tests — prose assembly is pure (no world, no tick,
 * no I/O). These pin the prose contract byte for byte.
 *
 * `buildRoomProse` now produces *narrative* prose from the delta entry's
 * structured fields (the dev-tab text), independently of the compact
 * `summary` string the LLM reads via `buildDeltaSummary`. `buildRoundProse`
 * (the one-line round summary) keeps its stable counting contract, so those
 * tests are unchanged.
 *
 * @module test/unit/RoundProseBuilder
 */

import { describe, it, expect } from 'vitest';
import { buildRoomProse, buildRoundProse } from '../../src/utils/RoundProseBuilder.js';

// A raw entity id that the prose layer must never echo verbatim into sentences.
const RAW_ENT_ID = 'ent-3382b7f0-03e8-41cf-a3a0-d7f1cb471771';

describe('buildRoomProse (narrative prose)', () => {
    it('returns an empty string when there are no entries', () => {
        expect(buildRoomProse({ entries: [], roomName: 'start room' })).toBe('');
        expect(buildRoomProse({ entries: null, roomName: 'start room' })).toBe('');
        expect(buildRoomProse({ roomName: 'start room' })).toBe('');
    });

    it('names the room once, at the front, and renders a single action', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                { actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] } },
            ],
        });
        expect(text).toBe('In start room, Test Droid threw a punch.');
        expect(text.endsWith('.')).toBe(true);
        // The room name appears exactly once.
        expect(text.toLowerCase().split('start room').length - 1).toBe(1);
    });

    it('derives a chunk display name from the type key and a generic actor when the owner is a raw id', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            entries: [
                {
                    dropped: {
                        added: [
                            {
                                itemId: 'i1',
                                type: 'chunk_wood',
                                ownerId: RAW_ENT_ID,
                                actor: { id: RAW_ENT_ID, name: RAW_ENT_ID, x: null, y: null },
                            },
                        ],
                    },
                },
            ],
        });
        expect(text).toBe('In The Entrance Hall, someone dropped a Wood chunk.');
        expect(text.toLowerCase().includes('chunk_wood')).toBe(false);
        expect(text.toLowerCase().includes(RAW_ENT_ID)).toBe(false);
    });

    it('weaves the whole entry into a flowing paragraph, room named once', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                {
                    actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] },
                    dropped: {
                        added: [ { itemId: 'i1', type: 'chunk_wood', actor: { name: 'Test Droid' } } ],
                    },
                    items: { added: [ { itemId: 'i2', type: 'knife', name: 'Knife' } ] },
                    entities: {
                        statChanges: [
                            { id: 'e1', name: 'Test Droid', traitId: 'Physical', statName: 'strength', from: 15, to: 13 },
                        ],
                    },
                    components: { changed: [ { componentId: 'c1', type: 'blade', entity: 'e1' } ] },
                },
            ],
        });
        expect(text).toBe(
            'In start room, Test Droid threw a punch, Test Droid dropped a Wood chunk, and a Knife appeared. ' +
                'Test Droid had a stat change in strength and a Blade had a stat change.'
        );
        expect(text.toLowerCase().includes('stat change')).toBe(true);
        expect(text.toLowerCase().split('start room').length - 1).toBe(1);
    });

    it('falls back to a generic noun for raw-id entities rather than echoing the id', () => {
        const text = buildRoomProse({
            roomName: 'x',
            entries: [
                { actions: { performed: [ { action: 'droid punch', name: RAW_ENT_ID } ] } },
            ],
        });
        expect(text).toBe('In x, an entity threw a punch.');
        expect(text).not.toContain(RAW_ENT_ID);
    });

    it('renders a baseline round as an "Initial observation of" paragraph', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                {
                    kind: 'baseline',
                    entities: { appeared: [ { id: 'e1', name: 'Test Droid' } ] },
                    dropped: { added: [] },
                    items: { added: [] },
                },
            ],
        });
        expect(text.toLowerCase().includes('initial observation')).toBe(true);
        expect(text).toBe('Initial observation of start room: Test Droid is in the room.');
        expect(text.endsWith('.')).toBe(true);
    });

    it('renders a multi-entity baseline with a plural verb', () => {
        const text = buildRoomProse({
            roomName: 'workshop',
            entries: [
                {
                    kind: 'baseline',
                    entities: {
                        appeared: [ { id: 'e1', name: 'Test Droid' }, { id: 'e2', name: 'Crafter Drone' } ],
                    },
                    dropped: { added: [] },
                },
            ],
        });
        expect(text).toBe('Initial observation of workshop: Test Droid and Crafter Drone are in the room.');
    });

    it('chains a baseline sentence then subsequent delta sentences without repeating the room', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                { kind: 'baseline', entities: { appeared: [ { id: 'e1', name: 'Test Droid' } ] }, dropped: { added: [] } },
                { actions: { performed: [ { action: 'selfHeal', name: 'Test Droid' } ] } },
            ],
        });
        expect(text).toBe(
            'Initial observation of start room: Test Droid is in the room. Test Droid healed itself.'
        );
    });

    it('builds the prose from the structured delta fields, ignoring any pre-set summary (LLM independence)', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                {
                    // A compact LLM summary that must NOT leak into the prose.
                    summary: '1 action performed (droid punch by ent-3382b7f0) in start room',
                    actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] },
                },
            ],
        });
        expect(text).toBe('In start room, Test Droid threw a punch.');
        expect(text.toLowerCase().includes('action performed')).toBe(false);
    });

    it('ends with a single terminal period and never double-periods', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                { actions: { performed: [ { action: 'dash', name: 'Test Droid' } ] } },
                { items: { added: [ { itemId: 'i', type: 'knife', name: 'Knife' } ] } },
            ],
        });
        expect(text.endsWith('.')).toBe(true);
        expect(text.includes('..')).toBe(false);
    });
});

describe('buildRoundProse (stable round summary, unchanged)', () => {
    const oneRoom = {
        rooms: { r1: { name: 'start room', text: 'M1 Droid moved in start room.', entryCount: 1 } },
    };
    const twoRooms = {
        rooms: {
            r1: { name: 'start room', text: 'A.', entryCount: 2 },
            r2: { name: 'workshop', text: 'B.', entryCount: 1 },
        },
    };

    it('closed round with changes: "Round N (ticks a to b) recorded X across Y room(s)."', () => {
        const result = buildRoundProse({ round: 0, live: false, startTick: 0, endTick: 3, ...oneRoom });
        expect(result.summary).toBe('Round 0 (ticks 0 to 3) recorded 1 observable change across 1 room.');
        expect(result.entryCount).toBe(1);
        expect(result.rooms).toEqual(oneRoom.rooms);
    });

    it('closed round uses plural counting', () => {
        const result = buildRoundProse({ round: 2, live: false, startTick: 6, endTick: 7, ...twoRooms });
        expect(result.summary).toBe('Round 2 (ticks 6 to 7) recorded 3 observable changes across 2 rooms.');
    });

    it('closed round with no entries', () => {
        const result = buildRoundProse({ round: 4, live: false, startTick: 8, endTick: 9, rooms: {} });
        expect(result.summary).toBe('Round 4 (ticks 8 to 9) passed with no observable changes.');
        expect(result.entryCount).toBe(0);
    });

    it('live round with entries: "still planning; ... so far."', () => {
        const result = buildRoundProse({ round: 5, live: true, startTick: 10, endTick: 12, ...oneRoom });
        expect(result.summary).toBe('Round 5 (ticks 10 to 12) is still planning; 1 observable change across 1 room so far.');
    });

    it('live round with no entries: "still planning (no change yet)."', () => {
        const result = buildRoundProse({ round: 5, live: true, startTick: 10, endTick: 10, rooms: null });
        expect(result.summary).toBe('Round 5 (ticks 10 to 10) is still planning (no change yet).');
        expect(result.entryCount).toBe(0);
        expect(result.rooms).toEqual({});
    });
});

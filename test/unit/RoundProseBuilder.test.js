/**
 * RoundProseBuilder unit tests — prose assembly is pure (no world, no tick,
 * no I/O). These pin the prose contract byte for byte.
 *
 * `buildRoomProse` produces *narrative* prose from the delta entry's
 * structured fields (the dev-tab text), independently of the compact
 * `summary` string the LLM reads via the delta summary layer. It renders
 * every useful field the entries carry: the room itself (name, size, map
 * position, description), action targets and powered-by components, floor
 * objects at display coordinates, entity move (from/to room, from/to position,
 * locomotion parts), stat values (from/to), component/equipped/internal
 * parts, machines (placed/retrieved), and room chat (verbatim). All output
 * is deterministic (no timestamps, no raw ids) so identically driven worlds
 * produce byte-identical prose. `buildRoundProse` (the one-line round summary)
 * keeps its stable counting contract, so those tests are unchanged.
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
        expect(text).toBe('In The Entrance Hall, someone dropped a Wood chunk on the floor.');
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
            'In start room, Test Droid threw a punch, Test Droid dropped a Wood chunk on the floor, and a Knife appeared. ' +
                'Test Droid had a stat change in strength (from 15 to 13) and a Blade had a stat change.'
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

    it('names the room with its full context (name, size, map position, description)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
                description: 'a stone hall with a north door',
                width: 20,
                height: 12,
                x: 4,
                y: 7,
            },
            entries: [
                { actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] } },
            ],
        });
        expect(text).toBe(
            'In The Entrance Hall (20 x 12, map position (4.00, 7.00), and a stone hall with a north door), ' +
                'Test Droid threw a punch.'
        );
        expect(text.toLowerCase().split('the entrance hall').length - 1).toBe(1);
    });

    // Atmosphere (optional static room block, validated in RoomsController).
    // Each present field becomes one lower-case clause after the description;
    // absent fields (and a missing block) are simply dropped.
    it('names the room with atmosphere when supplied (delta path)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
                description: 'a stone hall with a north door',
                width: 20,
                height: 12,
                x: 4,
                y: 7,
                atmosphere: {
                    temperature: 18.5,
                    lightLevel: 'dim',
                    smell: 'dust and old oil',
                    ambientSound: 'distant dripping water',
                },
            },
            entries: [
                { actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] } },
            ],
        });
        expect(text).toBe(
            'In The Entrance Hall (20 x 12, map position (4.00, 7.00), a stone hall with a north door, ' +
                'a temperature of 18.5, dim light, the smell of dust and old oil, and the sound of distant dripping water), ' +
                'Test Droid threw a punch.'
        );
        expect(text.toLowerCase().split('the entrance hall').length - 1).toBe(1);
    });

    it('baseline renders atmosphere (Initial observation of)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
                description: 'a stone hall with a north door',
                width: 20,
                height: 12,
                x: 4,
                y: 7,
                atmosphere: {
                    temperature: 18.5,
                    lightLevel: 'dim',
                    smell: 'dust and old oil',
                    ambientSound: 'distant dripping water',
                },
            },
            entries: [
                {
                    kind: 'baseline',
                    entities: { appeared: [ { id: 'e1', name: 'Test Droid' } ] },
                    dropped: { added: [] },
                },
            ],
        });
        expect(text).toBe(
            'Initial observation of The Entrance Hall (20 x 12, map position (4.00, 7.00), ' +
                'a stone hall with a north door, a temperature of 18.5, dim light, the smell of dust and old oil, ' +
                'and the sound of distant dripping water): Test Droid is in the room.'
        );
    });

    it('drops missing atmosphere fields (partial block)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
                description: 'a stone hall with a north door',
                width: 20,
                height: 12,
                x: 4,
                y: 7,
                atmosphere: { lightLevel: 'dark' },
            },
            entries: [
                { actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] } },
            ],
        });
        expect(text).toBe(
            'In The Entrance Hall (20 x 12, map position (4.00, 7.00), a stone hall with a north door, and darkness), ' +
                'Test Droid threw a punch.'
        );
        expect(text).not.toContain('temperature of');
    });

    it('narrates a targeted action (against whom, powered by which components)', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                {
                    actions: {
                        performed: [
                            {
                                name: 'Test Droid',
                                action: 'droid punch',
                                target: { id: 't1', name: 'Knife', componentId: null, componentName: null },
                                used: [ { type: 'blade' }, { type: 'core' } ],
                            },
                        ],
                    },
                },
            ],
        });
        expect(text).toBe(
            'In start room, Test Droid threw a punch against Knife, powered by Blade and Core.'
        );
    });

    it('places floor objects at their display coordinates (2 decimals, perception rule)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            entries: [
                {
                    dropped: {
                        added: [ { itemId: 'i1', type: 'chunk_wood', ownerId: RAW_ENT_ID, x: 3.25, y: 7.5 } ],
                    },
                },
            ],
        });
        expect(text).toBe('In The Entrance Hall, someone dropped a Wood chunk on the floor at (3.25, 7.50).');
    });

    it('narrates entity movement with from/to rooms, from/to coordinates, and locomotion parts', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            entries: [
                {
                    entities: {
                        moved: [
                            {
                                id: 'e1',
                                name: 'Test Droid',
                                fromRoom: 'start room',
                                toRoom: 'workshop',
                                fromXY: { x: 1, y: 2 },
                                toXY: { x: 9, y: 2 },
                                action: 'dash',
                                locomotion: [ { type: 'legs', id: 'c1' } ],
                            },
                        ],
                    },
                },
            ],
        });
        expect(text).toBe(
            'In The Entrance Hall, Test Droid dashed from start room to workshop (from (1.00, 2.00) to (9.00, 2.00)), ' +
                'powered by Legs.'
        );
    });

    it('renders stat values with their precision (no float noise, no double period)', () => {
        const text = buildRoomProse({
            roomName: 'start room',
            entries: [
                {
                    entities: {
                        statChanges: [
                            { id: 'e1', name: 'Test Droid', statName: 'energy', from: 100, to: 80.003 },
                            { id: 'e2', name: 'Crafter Drone', statName: 'heat', from: 0.125, to: 0 },
                        ],
                    },
                },
            ],
        });
        expect(text).toBe(
            'In start room, Test Droid had a stat change in energy (from 100 to 80.003) and ' +
                'Crafter Drone had a stat change in heat (from 0.125 to 0).'
        );
        expect(text.includes('..')).toBe(false);
    });

    it('narrates machine placement and retrieval (who, what, where) without double-telling the entity appear', () => {
        const text = buildRoomProse({
            roomName: 'The Workshop',
            entries: [
                {
                    entities: {
                        appeared: [ { id: 'm1', name: 'Furnace 1', machine: {}, x: 10, y: 5 } ],
                    },
                    machines: {
                        placed: [ { id: 'm1', name: 'Furnace 1', type: 'furnace', x: 10, y: 5, placedBy: 'Maria' } ],
                        retrieved: [ { id: 'm2', type: 'furnace', x: 3, y: 3 } ],
                    },
                },
            ],
        });
        expect(text).toBe(
            'In The Workshop, Maria placed Furnace 1 at (10.00, 5.00) and a Furnace was retrieved at (3.00, 3.00).'
        );
    });

    it('places entities at their coordinates and notes where they left', () => {
        const text = buildRoomProse({
            roomName: 'The Lounge',
            entries: [
                {
                    entities: {
                        appeared: [ { id: 'e1', name: 'Test Droid', x: 3, y: 2 } ],
                        despawned: [ { id: 'e2', name: 'Crafter Drone', x: 1, y: 1 } ],
                    },
                },
            ],
        });
        expect(text).toBe(
            'In The Lounge, Test Droid appeared in the room at (3.00, 2.00) and Crafter Drone left the room from (1.00, 1.00).'
        );
    });

    it('narrates equipped/gained components, component stat values, and internal parts', () => {
        const text = buildRoomProse({
            roomName: 'The Workshop',
            entries: [
                {
                    equipped: {
                        added: [ { id: 'e1', itemType: 'knife', entity: RAW_ENT_ID } ],
                    },
                    components: {
                        added: [ { componentId: 'c1', type: 'blade', entity: RAW_ENT_ID } ],
                        changed: [
                            { componentId: 'c2', type: 'blade', entity: RAW_ENT_ID, statName: 'energy', from: 3, to: 2 },
                        ],
                    },
                    internal: { added: [ { id: 'c3', type: 'power', entity: RAW_ENT_ID } ] },
                },
            ],
        });
        expect(text).toBe(
            'In The Workshop, someone equipped a Knife, an entity gained a Blade, and a Blade had a stat change in energy ' +
                '(from 3 to 2). Someone gained an internal part (type Power).'
        );
    });

    it('renders room chat verbatim (speaker + text, trailing punctuation not doubled)', () => {
        const text = buildRoomProse({
            roomName: 'The Lounge',
            entries: [
                {
                    chat: {
                        added: [
                            { speakerName: 'Test Droid', text: 'The hall is wide.' },
                            { speakerName: RAW_ENT_ID, text: 'quiet' },
                        ],
                    },
                },
            ],
        });
        expect(text).toBe(
            'In The Lounge, Test Droid said, "The hall is wide" and someone said, "quiet".'
        );
        expect(text).not.toContain('.."');
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

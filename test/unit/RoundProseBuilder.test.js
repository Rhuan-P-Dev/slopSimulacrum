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
import { buildRoomProse, buildRoundProse, buildEntityProse, selectEntityRows } from '../../src/utils/RoundProseBuilder.js';

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

    it('names the room with its size and map position (no description, no atmosphere)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
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
            'In The Entrance Hall (20 x 12 and map position (4.00, 7.00)), ' +
                'Test Droid threw a punch.'
        );
        expect(text.toLowerCase().split('the entrance hall').length - 1).toBe(1);
    });

    // Atmosphere (optional static room block, validated in RoomsController).
    // Each present field becomes one lower-case clause; absent fields (and a
    // missing block) are simply dropped.
    it('names the room with atmosphere when supplied (delta path)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
                width: 20,
                height: 12,
                x: 4,
                y: 7,
                atmosphere: {
                    temperature: 18.5,
                    lightLevel: 'dim',
                    lightColor: 'warm',
                    smell: 'dust and old oil',
                    ambientSound: 'distant dripping water',
                    humidity: 60,
                    airQuality: 'stale',
                    fog: 'hazy',
                },
            },
            entries: [
                { actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] } },
            ],
        });
        expect(text).toBe(
            'In The Entrance Hall (20 x 12, map position (4.00, 7.00), ' +
                'a temperature of 18.5, 60% humidity, stale air, dim warm light, a haze, ' +
                'the smell of dust and old oil, and the sound of distant dripping water), ' +
                'Test Droid threw a punch.'
        );
        expect(text.toLowerCase().split('the entrance hall').length - 1).toBe(1);
    });

    it('renders thick fog when fog is thick (Deep Vault case)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
                width: 20,
                height: 12,
                x: 4,
                y: 7,
                atmosphere: {
                    temperature: 18.5,
                    lightLevel: 'dim',
                    lightColor: 'warm',
                    smell: 'dust and old oil',
                    ambientSound: 'distant dripping water',
                    humidity: 60,
                    airQuality: 'stale',
                    fog: 'thick',
                },
            },
            entries: [
                { actions: { performed: [ { action: 'droid punch', name: 'Test Droid' } ] } },
            ],
        });
        expect(text).toBe(
            'In The Entrance Hall (20 x 12, map position (4.00, 7.00), ' +
                'a temperature of 18.5, 60% humidity, stale air, dim warm light, thick fog, ' +
                'the smell of dust and old oil, and the sound of distant dripping water), ' +
                'Test Droid threw a punch.'
        );
        expect(text).toContain('thick fog');
        expect(text).not.toContain('a haze');
        expect(text.toLowerCase().split('the entrance hall').length - 1).toBe(1);
    });

    it('baseline renders atmosphere (Initial observation of)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
                width: 20,
                height: 12,
                x: 4,
                y: 7,
                atmosphere: {
                    temperature: 18.5,
                    lightLevel: 'dim',
                    lightColor: 'warm',
                    smell: 'dust and old oil',
                    ambientSound: 'distant dripping water',
                    humidity: 60,
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
                'a temperature of 18.5, 60% humidity, dim warm light, the smell of dust and old oil, ' +
                'and the sound of distant dripping water): Test Droid is in the room.'
        );
    });

    it('drops missing atmosphere fields (partial block)', () => {
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            room: {
                name: 'The Entrance Hall',
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
            'In The Entrance Hall (20 x 12, map position (4.00, 7.00), and darkness), ' +
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

    it('never echoes a room uid: a move row referencing rooms by uuid keeps the coordinates, not the id', () => {
        // Room rows reference rooms by uid, and room uids are generated per world
        // build — echoing one would both leak a raw id and make the same event
        // read differently on every boot. The coordinates carry the movement.
        const uidA = '56ebc147-f267-4a5b-9eda-7aad0c6eea68';
        const uidB = '9f1e2d3c-4b5a-4978-8a7b-1234567890ab';
        const text = buildRoomProse({
            roomName: 'The Entrance Hall',
            entries: [
                {
                    entities: {
                        moved: [{ id: 'e1', name: 'Test Droid', fromRoom: uidA, toRoom: uidB, fromXY: { x: 0, y: 0 }, toXY: { x: 12, y: 9 } }]
                    }
                }
            ]
        });

        expect(text).toBe('In The Entrance Hall, Test Droid moved from (0.00, 0.00) to (12.00, 9.00).');
        expect(text).not.toContain(uidA);
        expect(text).not.toContain(uidB);
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

// =========================================================================
// ONE ENTITY'S ROUND (buildEntityProse / selectEntityRows) — the entity
// counterpart of the room paragraph: only the rows that NAME it. The phrasing
// is reused from the room narrative, so these tests pin the SELECTION and the
// labelling, not new wording.
// =========================================================================

const RAW_OTHER_ID = 'ent-9999b7f0-03e8-41cf-a3a0-d7f1cb471771';

/**
 * One round's worth of rows for two actors: an action each (one aimed at the
 * other), floor objects owned by each, a chat line each, a machine placed by
 * the test droid, its stat / component / item / equipped rows — and a baseline,
 * which belongs to the room and never to one entity.
 */
function twoActorEntries() {
    return [
        {
            kind: 'delta',
            actions: {
                performed: [
                    { entity: RAW_ENT_ID, name: 'Test Droid', action: 'droid punch', target: { id: RAW_OTHER_ID, name: 'Rival' }, used: [{ type: 'hand' }] },
                    { entity: RAW_OTHER_ID, name: 'Rival', action: 'cut' }
                ]
            },
            entities: {
                statChanges: [{ id: RAW_ENT_ID, name: 'Test Droid', traitId: 'Physical', statName: 'existence', from: 10, to: 7 }]
            },
            components: {
                added: [{ componentId: 'comp-1', type: 'hand', entity: RAW_ENT_ID }],
                changed: [{ componentId: 'comp-1', type: 'hand', entity: RAW_ENT_ID, statName: 'strength', from: 5, to: 3 }]
            },
            items: { added: [{ itemId: 'item-1', type: 'knife', entity: RAW_ENT_ID, hostComponent: 'comp-1' }] },
            equipped: { added: [{ id: 'eq-1', itemType: 'tshirt', entity: RAW_ENT_ID }] },
            dropped: {
                added: [{ itemId: 'item-2', type: 'chunk_wood', x: 4, y: 6, ownerId: RAW_ENT_ID }],
                removed: [{ itemId: 'item-3', type: 'coal', ownerId: RAW_OTHER_ID }]
            },
            chat: {
                added: [
                    { id: 'c1', speakerEntityId: RAW_ENT_ID, speakerName: 'Test Droid', text: 'I am fine.' },
                    { id: 'c2', speakerEntityId: RAW_OTHER_ID, speakerName: 'Rival', text: 'Noise.' }
                ]
            },
            machines: { placed: [{ id: 'ent-machine-1', name: 'Pump', type: 'knifeGenerator', x: 1, y: 2, placedBy: RAW_ENT_ID }] }
        },
        { kind: 'baseline', entities: { appeared: [{ id: RAW_ENT_ID, name: 'Test Droid' }] } },
        {
            kind: 'delta',
            entities: { moved: [{ id: RAW_ENT_ID, name: 'Test Droid', action: 'walk', fromXY: { x: 1, y: 1 }, toXY: { x: 4, y: 2 } }] }
        }
    ];
}

describe('buildEntityProse (one entity, one round)', () => {
    it('says nothing when there is nothing to say (no entries, no entity id)', () => {
        expect(buildEntityProse({ entries: [], entityId: RAW_ENT_ID })).toEqual({ text: '', entryCount: 0 });
        expect(buildEntityProse({ entries: null, entityId: RAW_ENT_ID })).toEqual({ text: '', entryCount: 0 });
        // No entity named means no prose, even with a full entry stream.
        expect(buildEntityProse({ entries: twoActorEntries(), entityId: '' })).toEqual({ text: '', entryCount: 0 });
        expect(buildEntityProse({ entries: twoActorEntries(), entityId: null })).toEqual({ text: '', entryCount: 0 });
    });

    it('keeps only the rows that name it — the other actor\'s line never appears', () => {
        const { text, entryCount } = buildEntityProse({
            entries: twoActorEntries(),
            entityId: RAW_ENT_ID,
            entityName: 'Test Droid'
        });

        expect(entryCount).toBe(2);
        expect(text).toBe(
            'Test Droid threw a punch against Rival, powered by Hand, Test Droid dropped a Wood chunk '
            + 'on the floor at (4.00, 6.00), and a Knife appeared in Test Droid\'s hand. Test Droid '
            + 'equipped a Tshirt, a Knife Generator was placed in the room at (1.00, 2.00), and Test '
            + 'Droid had a stat change in existence (from 10 to 7). Test Droid gained a Hand, a Hand '
            + 'had a stat change in strength (from 5 to 3), and Test Droid said, "I am fine". Test '
            + 'Droid walked from (1.00, 1.00) to (4.00, 2.00).'
        );
        // The rival's own rows (its cut, the coal it picked up, its line) are absent.
        expect(text).not.toContain('cut');
        expect(text).not.toContain('Coal');
        expect(text).not.toContain('Noise');
        // Deterministic like the rest of the module: no raw ids in the text.
        expect(text).not.toContain(RAW_ENT_ID);
        expect(text).not.toContain('ent-');
        expect(text).not.toContain('item-1');
    });

    it('a row where the entity is the VICTIM is its prose too', () => {
        const { text } = buildEntityProse({
            entries: twoActorEntries(),
            entityId: RAW_OTHER_ID,
            entityName: 'Rival'
        });

        expect(text).toContain('Test Droid threw a punch against Rival');
        expect(text).toContain('Rival cut something');
        expect(text).toContain('Rival picked up a Coal');
        expect(text).toContain('Rival said, "Noise"');
        // The punch still names its own actor — the victim view does not steal
        // the agency.
        expect(text).not.toContain('Rival threw a punch');
    });

    it('a known display name replaces the generic fallback; without it no id leaks', () => {
        const labeled = buildEntityProse({ entries: twoActorEntries(), entityId: RAW_ENT_ID, entityName: 'Test Droid' }).text;
        const unlabeled = buildEntityProse({ entries: twoActorEntries(), entityId: RAW_ENT_ID }).text;

        expect(labeled).toContain('Test Droid gained a Hand');
        expect(labeled).toContain('Test Droid dropped a Wood chunk');
        // Without a name the reused clause builders keep their generic wording…
        expect(unlabeled).toContain('An entity gained a Hand');
        expect(unlabeled).toContain('someone dropped a Wood chunk');
        // …and never echo the raw id (the same guard the room prose has).
        expect(unlabeled).not.toContain(RAW_ENT_ID);
    });

    it('a baseline is the room\'s state description, never one entity\'s prose', () => {
        const { text, entryCount } = buildEntityProse({
            entries: [{ kind: 'baseline', entities: { appeared: [{ id: RAW_ENT_ID, name: 'Test Droid' }] } }],
            entityId: RAW_ENT_ID,
            entityName: 'Test Droid'
        });

        expect(entryCount).toBe(0);
        expect(text).toBe('');
    });

    it('entryCount counts the entries that said something about it', () => {
        const entries = [
            { kind: 'delta', entities: { moved: [{ id: RAW_ENT_ID, name: 'Test Droid', action: 'walk' }] } },
            { kind: 'delta', entities: { moved: [{ id: RAW_OTHER_ID, name: 'Rival', action: 'walk' }] } },
            { kind: 'delta', chat: { added: [{ id: 'c1', speakerEntityId: RAW_ENT_ID, speakerName: 'Test Droid', text: 'Again.' }] } },
            // A row is present but nothing is sayable in it (blank chat) — not counted.
            { kind: 'delta', chat: { added: [{ id: 'c2', speakerEntityId: RAW_ENT_ID, speakerName: 'Test Droid', text: '   ' }] } }
        ];

        const { text, entryCount } = buildEntityProse({ entries, entityId: RAW_ENT_ID, entityName: 'Test Droid' });
        expect(entryCount).toBe(2);
        expect(text).toBe('Test Droid walked. Test Droid said, "Again".');
    });

    it('selectEntityRows reports the rows it kept and the display name they carry', () => {
        const first = twoActorEntries()[0];

        const kept = selectEntityRows(first, RAW_ENT_ID);
        expect(kept.rowCount).toBeGreaterThan(0);
        expect(kept.name).toBe('Test Droid');
        // Only the entity's own rows survive, bucket by bucket.
        expect(kept.entry.actions.performed).toHaveLength(1);
        expect(kept.entry.dropped.removed).toBeUndefined();
        expect(kept.entry.chat.added).toHaveLength(1);
        // The caller's entry keeps every row — the selection is a copy.
        expect(first.actions.performed).toHaveLength(2);

        // A machine row is matched through who PLACED it, and the name found
        // there is the machine's own (the row names the machine entity).
        const machine = selectEntityRows(first, 'ent-machine-1');
        expect(machine.rowCount).toBe(1);
        expect(machine.name).toBe('Pump');

        expect(selectEntityRows(first, 'ent-00000000-0000-0000-0000-000000000000').rowCount).toBe(0);
        expect(selectEntityRows(null, RAW_ENT_ID).rowCount).toBe(0);
    });
});

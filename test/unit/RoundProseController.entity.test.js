/**
 * RoundProseController.getEntityProse — the entity counterpart of the room
 * prose, tested with a STUB facade (no world build, no tick system).
 *
 * What only this level can pin: the reader walks EVERY room's ring (an entity
 * that crossed a door mid-round has its past in two rooms' rings), it drops the
 * entries outside the round window, and it keeps only the rows that name the
 * entity it was asked about. The cross-room case is the reason this read is not
 * `getRoomProse` with a filter.
 *
 * The round window itself comes from `TurnSystemController.getRoundWindow` — the
 * turn system's own contract, not this reader's — so it is a stub reporting one
 * fixed window here: what is under test is which rows the prose is built from.
 *
 * @module test/unit/RoundProseController.entity
 */

import { describe, it, expect } from 'vitest';
import RoundProseControllerBase from '../../src/controllers/core/RoundProseController.js';

/**
 * The real controller takes its facade post-construction (`setWorldStateController`,
 * the PerceptionController convention); this only folds the two calls the tests
 * would otherwise repeat. No behavior is added or overridden.
 */
class RoundProseController extends RoundProseControllerBase {
    constructor(facade) {
        super();
        this.setWorldStateController(facade);
    }
}

const ENT = 'ent-11111111-1111-4111-8111-111111111111';
const OTHER = 'ent-22222222-2222-4222-8222-222222222222';
const HALL = 'room-hall';
const CORRIDOR = 'room-corridor';

/**
 * A facade-shaped stub: three rooms (two with rings), the entities the world
 * still holds, and one turn system that reports one round window
 * (startTick..endTick, closed unless `live`). `rings[roomId]` is oldest first,
 * the way a perception ring reads.
 */
function stubWorld({ rings = {}, entities = {}, window = { round: 4, startTick: 10, endTick: 12, live: false } } = {}) {
    const has = Object.prototype.hasOwnProperty.bind(rings);
    return {
        turnSystemController: window === null ? null : { getRoundWindow: () => window },
        getRooms: () => ({ [HALL]: { name: 'The Entrance Hall' }, [CORRIDOR]: { name: 'The Eastern Corridor' }, 'room-vault': { name: 'The Deep Vault' } }),
        getPerceptionDeltasForRoom: (roomId) => (has(roomId) ? rings[roomId] : []),
        getEntity: (id) => entities[id] ?? null
    };
}

/**
 * The rows of one round, told in two rooms: the droid leaves the hall and
 * appears in the corridor (a cross-room move shows up as a departure in one
 * ring and an arrival in the other), while a rival in the hall says a line the
 * entity read must never pick up.
 */
function twoRoomRings() {
    return {
        [HALL]: [
            { tick: 9, kind: 'baseline', entities: { appeared: [{ id: ENT, name: 'Test Droid' }] } },
            {
                tick: 10,
                kind: 'delta',
                entities: { despawned: [{ id: ENT, name: 'Test Droid', action: 'leave', x: 1, y: 2 }] },
                chat: { added: [{ id: 'c1', speakerEntityId: OTHER, speakerName: 'Rival', text: 'Not my round.' }] }
            },
            { tick: 13, kind: 'delta', entities: { statChanges: [{ id: ENT, name: 'Test Droid', traitId: 'Physical', statName: 'existence', from: 4, to: 9 }] } }
        ],
        [CORRIDOR]: [
            // Two rows in the same tick, one naming the entity and one not: the
            // window filter must not smuggle the rival's line in.
            {
                tick: 12,
                kind: 'delta',
                entities: { appeared: [{ id: ENT, name: 'Test Droid', action: 'arrive', x: 3, y: 4 }] },
                actions: { performed: [{ entity: OTHER, name: 'Rival', action: 'craft' }] }
            }
        ]
    };
}

describe('RoundProseController.getEntityProse (stubbed facade)', () => {
    it('reads one round across every room ring, in tick order', () => {
        const reader = new RoundProseController(stubWorld({ rings: twoRoomRings(), entities: { [ENT]: { name: 'Test Droid', location: CORRIDOR } } }));

        const prose = reader.getEntityProse(ENT, 4);

        expect(prose).toMatchObject({
            round: 4,
            live: false,
            startTick: 10,
            endTick: 12,
            entityId: ENT,
            entity: 'Test Droid',
            room: 'The Eastern Corridor'
        });
        // Two rooms' rows, ordered by tick: the hall's departure (10) first,
        // then the corridor's arrival (12). The round window is the same one the
        // round / room prose uses.
        expect(prose.entryCount).toBe(2);
        expect(prose.text).toBe(
            'Test Droid left the room from (1.00, 2.00). Test Droid appeared in the room at (3.00, 4.00).'
        );
    });

    it('keeps only rows that name the entity — never another entity\'s, never a baseline', () => {
        const reader = new RoundProseController(stubWorld({ rings: twoRoomRings(), entities: { [ENT]: { name: 'Test Droid', location: CORRIDOR } } }));

        const text = reader.getEntityProse(ENT, 4).text;

        // The rival's chat line and the rival's own action are absent.
        expect(text).not.toContain('Not my round');
        expect(text).not.toContain('Rival');
        // The baseline (tick 9, before the window) and the round-2 entry (tick
        // 13, after it) are absent: the window is inclusive at both ends.
        expect(text).not.toContain('initial observation');
        expect(text).not.toContain('stat change');
    });

    it('an entity that is gone still has a past: the name comes from its rows', () => {
        const reader = new RoundProseController(stubWorld({ rings: twoRoomRings(), entities: {} }));

        const prose = reader.getEntityProse(ENT, 4);

        expect(prose.entity).toBe('Test Droid');
        // No current room to report, but the prose is still the round's.
        expect(prose.room).toBeNull();
        expect(prose.entryCount).toBe(2);
        expect(prose.text).toContain('Test Droid left the room');
    });

    it('an entity nothing named is a real answer, not a failure', () => {
        const reader = new RoundProseController(stubWorld({ rings: twoRoomRings(), entities: { [OTHER]: { name: 'Rival', location: HALL } } }));

        const prose = reader.getEntityProse(OTHER, 4);

        // The rival IS in the rows (its chat line, its action) — so it is named,
        // and its own paragraph is what comes back.
        expect(prose.entryCount).toBe(2);
        expect(prose.text).toContain('Rival said, "Not my round"');
        expect(prose.text).toContain('Rival did craft');
        expect(prose.text).not.toContain('Test Droid');

        // A valid id with no row anywhere: empty prose, zero rows, no error.
        const nobody = reader.getEntityProse('ent-00000000-0000-0000-0000-000000000000', 4);
        expect(nobody.entryCount).toBe(0);
        expect(nobody.text).toBe('');
        expect(nobody.entity).toBe('ent-00000000-0000-0000-0000-000000000000');
    });

    it('a live round is reported as live, with the window open at the current tick', () => {
        const rings = { [HALL]: [{ tick: 11, kind: 'delta', entities: { statChanges: [{ id: ENT, name: 'Test Droid', traitId: 'Physical', statName: 'existence', from: 4, to: 3 }] } }] };
        const reader = new RoundProseController(stubWorld({
            rings,
            entities: { [ENT]: { name: 'Test Droid', location: HALL } },
            window: { round: 4, startTick: 10, endTick: 11, live: true }
        }));

        const prose = reader.getEntityProse(ENT, 4);

        expect(prose.live).toBe(true);
        expect(prose.startTick).toBe(10);
        expect(prose.endTick).toBe(11);
        expect(prose.text).toBe('Test Droid had a stat change in existence (from 4 to 3).');
    });

    it('null when the round is not in recent history (no window) — never an empty object', () => {
        const withWindow = new RoundProseController(stubWorld({ rings: twoRoomRings(), entities: {} }));
        const noWindow = new RoundProseController(stubWorld({ rings: twoRoomRings(), entities: {}, window: null }));
        const unwired = new RoundProseController(null);

        expect(withWindow.getEntityProse(ENT, 4)).not.toBeNull();
        expect(noWindow.getEntityProse(ENT, 4)).toBeNull();
        expect(unwired.getEntityProse(ENT, 4)).toBeNull();
    });

    it('is deterministic across builds: two rooms\' rows for one tick order by the world\'s room order, not by room id', () => {
        // Room ids are generated per world build, so they cannot order ties.
        // The two rings below hold one entry each at the SAME tick, with the
        // rooms' map order reversed between the two reads: the prose keeps the
        // room order, so the sentences stay in the world's order both times.
        const rows = (word) => ({
            entities: { appeared: [{ id: ENT, name: 'Test Droid', action: 'arrive', x: 1, y: 1 }] },
            chat: { added: [{ id: `c-${word}`, speakerEntityId: ENT, speakerName: 'Test Droid', text: word }] }
        });
        const first = new RoundProseController(stubWorld({
            rings: { [HALL]: [{ tick: 11, kind: 'delta', ...rows('first') }], [CORRIDOR]: [{ tick: 11, kind: 'delta', ...rows('second') }] },
            entities: { [ENT]: { name: 'Test Droid', location: HALL } }
        }));
        const second = new RoundProseController(stubWorld({
            rings: { [CORRIDOR]: [{ tick: 11, kind: 'delta', ...rows('second') }], [HALL]: [{ tick: 11, kind: 'delta', ...rows('first') }] },
            entities: { [ENT]: { name: 'Test Droid', location: HALL } }
        }));

        expect(first.getEntityProse(ENT, 4).text).toBe(second.getEntityProse(ENT, 4).text);
        expect(first.getEntityProse(ENT, 4).text).toContain('said, "first"');
    });

    it('a room with no ring at all (or no rooms) yields empty prose, not an error', () => {
        const empty = new RoundProseController(stubWorld({ entities: { [ENT]: { name: 'Test Droid', location: HALL } } }));

        const prose = empty.getEntityProse(ENT, 4);

        expect(prose.entryCount).toBe(0);
        expect(prose.text).toBe('');
        expect(prose.room).toBe('The Entrance Hall');
    });
});

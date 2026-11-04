/**
 * RoomChatController unit tests (Feature D backend, spec §7.3 — pulled
 * forward to Feature C because the speak_in_room tool needs a real target).
 *
 * Pure store tests (no composition root, no data files): the controller is a
 * per-room ring buffer with validation + a broadcast side effect. Covers:
 *   - happy path: message shape (id chat-<uuid>, roomId, speaker fields,
 *     tick, ts) + the global broadcast side effect;
 *   - validation: EMPTY_MESSAGE, MESSAGE_TOO_LONG (201 chars rejected, 200
 *     accepted), ROOM_NOT_FOUND (unknown room);
 *   - ring semantics: 50-message capacity per room, eviction of the oldest;
 *   - getMessages: oldest → newest, defensive copies (mutation of a returned
 *     entry does not corrupt the store), limit;
 *   - serialize/restore round-trip.
 *
 * @module test/unit/RoomChatController
 */

import { describe, it, expect } from 'vitest';
import RoomChatController from '../../src/controllers/core/RoomChatController.js';

function makeController() {
    const emitted = [];
    const facade = {
        getRooms: () => ({ 'room-main': { name: 'Main Room' } }),
        tickSystem: { currentTick: 123 }
    };
    const broadcaster = { broadcastRoomChatMessage: (msg) => emitted.push(msg) };
    const roomChat = new RoomChatController(50, 200);
    roomChat.setWorldStateController(facade);
    roomChat.setBroadcaster(broadcaster);
    return { roomChat, emitted };
}

describe('RoomChatController (Feature D backend, spec §7.3)', () => {
    it('sends a message: correct shape + global broadcast side effect', () => {
        const { roomChat, emitted } = makeController();

        const result = roomChat.sendMessage({
            roomId: 'room-main',
            speakerName: 'Player',
            speakerEntityId: null,
            text: '  hello room  '
        });

        expect(result.success).toBe(true);
        const m = result.message;
        expect(m.id).toMatch(/^chat-/);
        expect(m.roomId).toBe('room-main');
        expect(m.speakerName).toBe('Player');
        expect(m.speakerEntityId).toBeNull();
        expect(m.text).toBe('hello room'); // trimmed
        expect(m.tick).toBe(123);
        expect(typeof m.ts).toBe('number');

        // The global emit carries the FULL message (roomId in the payload).
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toBe(m);
    });

    it('rejects an unknown room with ROOM_NOT_FOUND', () => {
        const { roomChat, emitted } = makeController();
        const result = roomChat.sendMessage({ roomId: 'room-nowhere', text: 'hi' });
        expect(result).toMatchObject({ success: false, code: 'ROOM_NOT_FOUND' });
        expect(emitted).toHaveLength(0);
    });

    it('rejects empty/whitespace-only messages with EMPTY_MESSAGE', () => {
        const { roomChat } = makeController();
        expect(roomChat.sendMessage({ roomId: 'room-main', text: '   ' })).toMatchObject({
            success: false, code: 'EMPTY_MESSAGE'
        });
        expect(roomChat.sendMessage({ roomId: 'room-main' })).toMatchObject({
            success: false, code: 'EMPTY_MESSAGE'
        });
    });

    it('rejects messages over 200 chars, accepts exactly 200', () => {
        const { roomChat } = makeController();
        expect(roomChat.sendMessage({ roomId: 'room-main', text: 'x'.repeat(201) })).toMatchObject({
            success: false, code: 'MESSAGE_TOO_LONG'
        });
        const ok = roomChat.sendMessage({ roomId: 'room-main', text: 'x'.repeat(200) });
        expect(ok.success).toBe(true);
        expect(ok.message.text).toHaveLength(200);
    });

    it('evicts the oldest message per room at capacity 50 (ring semantics)', () => {
        const { roomChat } = makeController();
        for (let i = 1; i <= 55; i++) {
            roomChat.sendMessage({ roomId: 'room-main', text: `msg ${i}` });
        }
        const messages = roomChat.getMessages('room-main');
        expect(messages).toHaveLength(50);
        expect(messages[0].text).toBe('msg 6'); // 5 oldest evicted
        expect(messages[49].text).toBe('msg 55');
    });

    it('getMessages returns oldest → newest defensive copies', () => {
        const { roomChat } = makeController();
        roomChat.sendMessage({ roomId: 'room-main', text: 'first' });
        roomChat.sendMessage({ roomId: 'room-main', text: 'second' });

        const messages = roomChat.getMessages('room-main');
        expect(messages.map(m => m.text)).toEqual(['first', 'second']);

        // Mutating a returned copy must not corrupt the store.
        messages[0].text = 'CORRUPTED';
        expect(roomChat.getMessages('room-main')[0].text).toBe('first');
    });

    it('getMessages honours the limit (last N, still oldest → newest)', () => {
        const { roomChat } = makeController();
        for (let i = 1; i <= 5; i++) {
            roomChat.sendMessage({ roomId: 'room-main', text: `m${i}` });
        }
        expect(roomChat.getMessages('room-main', 2).map(m => m.text)).toEqual(['m4', 'm5']);
        expect(roomChat.getMessages('room-nothing')).toEqual([]);
    });

    it('serialize/restore round-trips the store', () => {
        const { roomChat } = makeController();
        roomChat.sendMessage({ roomId: 'room-main', text: 'a', speakerName: 'Player' });
        roomChat.sendMessage({ roomId: 'room-main', text: 'b', speakerName: 'Bolt' });

        const fresh = new RoomChatController(50, 200);
        fresh.restore(roomChat.serialize());

        expect(fresh.getMessages('room-main').map(m => m.text)).toEqual(['a', 'b']);
        // Restore is defensive: mutating the original store after restore is safe.
        expect(fresh.getMessages('room-main')[0].speakerName).toBe('Player');
    });

    it('restore tolerates malformed input (resets to empty, never throws)', () => {
        const roomChat = new RoomChatController(50, 200);
        expect(() => roomChat.restore(null)).not.toThrow();
        expect(() => roomChat.restore([1, 2, 3])).not.toThrow();
        expect(() => roomChat.restore('nope')).not.toThrow();
        expect(roomChat.getMessages('room-main')).toEqual([]);
    });
});

// The round is the delivery window (wiki/decisions/round-scoped-context.md).
// The per-agent cursor this store used to carry delivered exactly the backlog
// the owner rejected: an agent that missed two rounds got two rounds of speech
// in one turn. Delivery is now a question about the world -- which round was
// this line said in -- stamped at send time and never guessed.
describe('RoomChatController — the round is the delivery window', () => {
    const texts = (list) => list.map((m) => m.text);

    /** A controller whose turn system reports `roundNumber` as the open round. */
    function makeRoundController(round) {
        const roomChat = new RoomChatController(50, 200);
        roomChat.setWorldStateController({
            getRooms: () => ({ 'room-main': { name: 'Main Room' }, 'room-east': { name: 'East' } }),
            tickSystem: { currentTick: 123 },
            subControllers: { turns: { getRoundState: () => ({ roundNumber: round.live }) } }
        });
        roomChat.setBroadcaster({ broadcastRoomChatMessage: () => {} });
        return roomChat;
    }

    it('stamps each line with the open round at send time', () => {
        const round = { live: 4 };
        const roomChat = makeRoundController(round);
        roomChat.sendMessage({ roomId: 'room-main', text: 'said in four' });
        round.live = 5;
        roomChat.sendMessage({ roomId: 'room-main', text: 'said in five' });

        expect(roomChat.getMessages('room-main').map((m) => m.round)).toEqual([4, 5]);
    });

    it('delivers one round alone, and reading it twice changes nothing', () => {
        const round = { live: 4 };
        const roomChat = makeRoundController(round);
        roomChat.sendMessage({ roomId: 'room-main', text: 'four' });
        round.live = 5;
        roomChat.sendMessage({ roomId: 'room-main', text: 'five-a' });
        roomChat.sendMessage({ roomId: 'room-main', text: 'five-b' });

        expect(texts(roomChat.getMessagesForRound('room-main', { round: 5 }))).toEqual(['five-a', 'five-b']);
        expect(texts(roomChat.getMessagesForRound('room-main', { round: 4 }))).toEqual(['four']);
        expect(texts(roomChat.getMessagesForRound('room-main', { round: 5 })),
            'stateless: nothing was consumed by the first ask')
            .toEqual(['five-a', 'five-b']);
    });

    it('never delivers a line whose round is unknown, and still shows it to people', () => {
        const { roomChat } = makeController(); // this stub wires no turn system
        roomChat.sendMessage({ roomId: 'room-main', text: 'before any round existed' });

        expect(roomChat.getMessages('room-main')[0].round).toBeNull();
        for (const round of [0, 1, 7]) {
            expect(roomChat.getMessagesForRound('room-main', { round }), 'unknown is never guessed')
                .toEqual([]);
        }
        expect(texts(roomChat.getMessages('room-main'))).toEqual(['before any round existed']);
    });

    it('answers no lines for a round that is not a round (-1, null, fractional)', () => {
        const roomChat = makeRoundController({ live: 3 });
        roomChat.sendMessage({ roomId: 'room-main', text: 'three' });
        for (const round of [-1, null, undefined, 3.5, '3']) {
            expect(roomChat.getMessagesForRound('room-main', { round })).toEqual([]);
        }
        // Nothing resolved yet is no round of speech, not round 0's speech.
        expect(roomChat.getMessagesForRound('room-main', {})).toEqual([]);
    });

    it('scopes per room: another room\'s lines of the same round stay there', () => {
        const roomChat = makeRoundController({ live: 6 });
        roomChat.sendMessage({ roomId: 'room-main', text: 'here' });
        roomChat.sendMessage({ roomId: 'room-east', text: 'there' });

        expect(texts(roomChat.getMessagesForRound('room-main', { round: 6 }))).toEqual(['here']);
        expect(texts(roomChat.getMessagesForRound('room-east', { round: 6 }))).toEqual(['there']);
        expect(roomChat.getMessagesForRound('room-nowhere', { round: 6 })).toEqual([]);
    });

    it('caps a round at the tail `limit`, keeping the newest lines of that round', () => {
        const roomChat = makeRoundController({ live: 2 });
        for (let i = 1; i <= 5; i += 1) roomChat.sendMessage({ roomId: 'room-main', text: `m${i}` });

        expect(texts(roomChat.getMessagesForRound('room-main', { round: 2, limit: 2 }))).toEqual(['m4', 'm5']);
        expect(texts(roomChat.getMessagesForRound('room-main', { round: 2, limit: 0 })))
            .toEqual(['m1', 'm2', 'm3', 'm4', 'm5'], 'a non-positive limit falls back to the room cap');
    });

    it('keeps the sequence monotonic across restore, and never backfills the round', () => {
        const roomChat = makeRoundController({ live: 9 });
        roomChat.sendMessage({ roomId: 'room-main', text: 'one' });
        roomChat.sendMessage({ roomId: 'room-main', text: 'two' });
        const [first, second] = roomChat.getMessages('room-main');
        expect(second.sequence).toBeGreaterThan(first.sequence);

        const carried = makeRoundController({ live: 9 });
        carried.restore(roomChat.serialize());
        expect(carried.getMessages('room-main').map((m) => m.round)).toEqual([9, 9],
            'a round stamp a snapshot carries survives the load');

        // A transcript saved before the round stamp existed: sequence backfilled,
        // round left unknown -- guessing would put old speech inside a live round.
        const legacy = makeRoundController({ live: 4 });
        legacy.restore({
            'room-main': [{ id: 'chat-1', roomId: 'room-main', speakerName: 'Old', text: 'pre-stamp' }]
        });
        const rows = legacy.getMessages('room-main');
        expect(rows[0].sequence).toBe(1);
        expect(rows[0].round).toBeNull();
        expect(legacy.getMessagesForRound('room-main', { round: 4 })).toEqual([]);

        // A line sent after the load is filed in the live round, above the
        // restored sequence high-water mark.
        legacy.sendMessage({ roomId: 'room-main', text: 'sent after the load' });
        const [live] = legacy.getMessagesForRound('room-main', { round: 4 });
        expect(live.text).toBe('sent after the load');
        expect(live.sequence).toBeGreaterThan(rows[0].sequence);
    });

    it('clear() empties the transcript: no round answers afterwards', () => {
        const roomChat = makeRoundController({ live: 1 });
        roomChat.sendMessage({ roomId: 'room-main', text: 'old world' });
        expect(roomChat.getMessagesForRound('room-main', { round: 1 })).toHaveLength(1);

        roomChat.clear();
        expect(roomChat.getMessagesForRound('room-main', { round: 1 })).toEqual([]);
        expect(roomChat.getMessages('room-main')).toEqual([]);
    });
});

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

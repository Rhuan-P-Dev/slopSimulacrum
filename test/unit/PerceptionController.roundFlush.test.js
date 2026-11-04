/**
 * PerceptionController — the round-boundary flush
 * (wiki/decisions/round-scoped-context.md).
 *
 * A delta entry aggregates "the room changed since its last flush", and an
 * agent's turn is scoped to one round. Those two only agree if the flush happens
 * AT the round boundary and the entry is stamped with the round that closed.
 * `flushDirtyForRound(round)` is the seam the turn system calls (via a hook, so
 * the turn system never imports perception).
 *
 * The trap this file exists to keep pinned: `_flushRoom` does not store. It
 * diffs and RETURNS the entry, and every reader pushes it into the room's ring
 * itself. A round-boundary flush has no reader, so it must push — otherwise it
 * consumes the dirty mark and throws the round's changes away, and the round the
 * agent is finally shown is empty.
 *
 * @module test/unit/PerceptionController.roundFlush
 */

import { describe, it, expect } from 'vitest';
import PerceptionController from '../../src/controllers/core/PerceptionController.js';

/**
 * The smallest world the perception controller can diff: one entity in one room,
 * plus the turn system it stamps its round from (`subControllers.turns`).
 */
function makeWorld({ round = 0 } = {}) {
    const state = {
        live: round,
        entities: {
            'ent-1': {
                id: 'ent-1', name: 'Rover', isNPC: true, location: 'room-1',
                spatial: { x: 0, y: 0 }, components: []
            }
        },
        dropped: {}
    };
    const facade = {
        getEntities: () => ({ ...state.entities }),
        getDroppedItems: () => ({ ...state.dropped }),
        getRoomChatMessages: () => [],
        getRooms: () => ({ 'room-1': { id: 'room-1', name: 'The Hall' } }),
        subControllers: { turns: { getRoundState: () => ({ roundNumber: state.live }) } }
    };
    const perception = new PerceptionController();
    perception.setWorldStateController(facade);
    /** Move the entity so the next diff has something to report. */
    const move = (x) => {
        state.entities['ent-1'].spatial = { x, y: 0 };
        perception.markDirty('room-1', 7);
    };
    return { perception, state, move };
}

/** The entries resident in a room's ring (no flush, no reader cursor moved). */
function ring(perception, roomId = 'room-1') {
    return perception.getBuffers().get(roomId)?.getAll?.() ?? [];
}

describe('PerceptionController — the round-boundary flush', () => {
    it('stores what it flushed: an entry lands in the ring, stamped with the round that closed', () => {
        const { perception, move } = makeWorld({ round: 3 });
        perception.getRoomDeltas('room-1', { limit: 10 }); // first observation → baseline

        move(5);
        expect(perception.flushDirtyForRound(4)).toBe(1);

        const entries = ring(perception);
        expect(entries).toHaveLength(2);
        const flushed = entries.at(-1);
        expect(flushed.roundNumber, 'the round that resolved owns the change')
            .toBe(4);
        expect(flushed.roundNumber, 'not the round open at flush time')
            .not.toBe(3);
    });

    it('leaves nothing pending: the same change is not reported twice', () => {
        const { perception, move } = makeWorld();
        perception.getRoomDeltas('room-1', { limit: 10 });

        move(9);
        expect(perception.flushDirtyForRound(1)).toBe(1);
        expect(perception.flushDirtyForRound(2), 'the room is no longer dirty').toBe(0);
        expect(ring(perception)).toHaveLength(2);
    });

    it('answers 0 without a round to stamp, and leaves the room dirty for the next reader', () => {
        const { perception, move } = makeWorld();
        perception.getRoomDeltas('room-1', { limit: 10 });
        move(4);

        for (const round of [undefined, null, -1, 2.5, '3']) {
            expect(perception.flushDirtyForRound(round)).toBe(0);
        }
        // Not flushed, so the change is still owed — a reader gets it.
        expect(perception.getRoomDeltas('room-1', { limit: 10 }).length).toBeGreaterThan(1);
    });

    it('a quiet room is not an entry: nothing dirty, nothing pushed', () => {
        const { perception } = makeWorld();
        perception.getRoomDeltas('room-1', { limit: 10 });
        expect(perception.flushDirtyForRound(5)).toBe(0);
        expect(ring(perception)).toHaveLength(1, 'only the baseline');
    });

    it('the stamp at flush time is the open round when nobody names one', () => {
        // A reader-driven flush (the lazy path) has no closing round to name, so
        // it stamps the round in force. That is what keeps a UI read honest
        // outside the round loop, and what the boundary flush exists to replace.
        const { perception, state, move } = makeWorld({ round: 6 });
        perception.getRoomDeltas('room-1', { limit: 10 });
        move(3);
        perception.getRoomDeltas('room-1', { limit: 10 });
        expect(ring(perception).at(-1).roundNumber).toBe(6);
        state.live = 7;
        move(6);
        perception.getRoomDeltas('room-1', { limit: 10 });
        expect(ring(perception).at(-1).roundNumber).toBe(7);
    });
});

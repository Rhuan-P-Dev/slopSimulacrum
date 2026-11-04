/**
 * WorldEventLogController unit tests — the round is the delivery window
 * (wiki/decisions/round-scoped-context.md).
 *
 * The store used to hand each agent a reader-relative cursor window ("what is
 * new to me since my last look"). That produced exactly the backlog the owner
 * rejected: an agent that misses two rounds gets two rounds of events in one
 * turn, under a header naming one. Delivery is now a question about the world,
 * not about the reader — `getEventsForRound({ round, limit })` — and the
 * ordering key (`sequence`) stayed while the reader state (per-agent cursors)
 * is gone.
 *
 * Covers:
 *   - a round read carries that round's events alone, oldest → newest;
 *   - the round stamped at write is the OPEN round of the turn system (both
 *     facade paths that publish it), and null when nothing answers;
 *   - a row with no round is never delivered to a round, and is never guessed;
 *   - restore: `sequence` backfilled and monotonic, `round` NOT backfilled;
 *   - `getRecent()` stays the stateless tail for `GET /world-events`.
 *
 * @module test/unit/WorldEventLogController
 */

import { describe, it, expect } from 'vitest';
import WorldEventLogController from '../../src/controllers/core/WorldEventLogController.js';

/**
 * A facade stub publishing the turn system the way the composition root does
 * (`subControllers.turns`), with `getRoundState().roundNumber` as the open
 * round. Pass null to model a world with no turn system wired.
 */
function facadeOpenRound(round) {
    return {
        subControllers: {
            turns: { getRoundState: () => ({ roundNumber: round }) }
        }
    };
}

/** A log wired to a turn system whose open round the test controls. */
function makeLog({ capacity = 50, round = 0 } = {}) {
    const log = new WorldEventLogController(capacity);
    log.setWorldStateController(facadeOpenRound(round));
    return log;
}

/** Record one event (warn is the level the LLM context renders). */
function write(log, message, over = {}) {
    log.record({ tick: 10, action: 'droid punch', message, level: 'warn', ...over });
}

describe('WorldEventLogController — the round is the delivery window', () => {
    it('delivers one round alone, oldest → newest, and nothing of its neighbours', () => {
        const turns = { open: 4 };
        const log = new WorldEventLogController(50);
        log.setWorldStateController({
            turnSystemController: { getRoundState: () => ({ roundNumber: turns.open }) }
        });
        write(log, 'round four blow');
        turns.open = 5;
        write(log, 'round five blow');
        turns.open = 6;
        write(log, 'round six blow');

        expect(log.getEventsForRound({ round: 5 }).map((e) => e.message)).toEqual(['round five blow']);
        expect(log.getEventsForRound({ round: 4 }).map((e) => e.message)).toEqual(['round four blow']);
        // Reading a round changes nothing: two asks, same answer.
        expect(log.getEventsForRound({ round: 6 }).map((e) => e.message))
            .toEqual(log.getEventsForRound({ round: 6 }).map((e) => e.message));
    });

    it('stamps the OPEN round at write time, not the resolved one', () => {
        // Resolution runs while its own round is still the open one, so the open
        // round IS the round that produced the event. The event log never asks
        // which round resolved.
        const log = makeLog({ round: 7 });
        write(log, 'resolved in seven');
        expect(log.getRecent(10)[0].round).toBe(7);
    });

    it('stamps null when no turn system answers, and never delivers a null row to a round', () => {
        const log = new WorldEventLogController(50); // no facade wired
        write(log, 'before any round existed');

        expect(log.getRecent(10)[0].round).toBeNull();
        for (const round of [0, 1, 7]) {
            expect(log.getEventsForRound({ round }), 'unknown is never guessed').toEqual([]);
        }
        // Human readers still see it.
        expect(log.getRecent(10).map((e) => e.message)).toEqual(['before any round existed']);
    });

    it('treats a throwing or partial turn system as no round, never as round 0', () => {
        const throwing = new WorldEventLogController(50);
        throwing.setWorldStateController({
            subControllers: { turns: { getRoundState: () => { throw new Error('seam down'); } } }
        });
        write(throwing, 'written despite a broken seam');
        expect(throwing.getRecent(10)[0].round).toBeNull();

        const partial = new WorldEventLogController(50);
        partial.setWorldStateController({ subControllers: {} });
        write(partial, 'no turns at all');
        expect(partial.getRecent(10)[0].round).toBeNull();
    });

    it('answers no rows for a round that is not a round (-1, null, fractional, absent)', () => {
        const log = makeLog({ round: 3 });
        write(log, 'three');
        for (const round of [-1, null, undefined, 3.5, '3']) {
            expect(log.getEventsForRound({ round })).toEqual([]);
        }
        expect(log.getEventsForRound()).toEqual([]);
    });

    it('caps a round at the tail `limit`, keeping the newest rows of that round', () => {
        const log = makeLog({ round: 2 });
        for (const name of ['a', 'b', 'c', 'd']) write(log, name);
        expect(log.getEventsForRound({ round: 2, limit: 2 }).map((e) => e.message)).toEqual(['c', 'd']);
        expect(log.getEventsForRound({ round: 2, limit: 0 }).map((e) => e.message)).toEqual(['a', 'b', 'c', 'd'],
            'a non-positive limit falls back to the recent cap, it does not empty the round');
    });

    it('keeps rows of other rounds out even when the round is the whole ring', () => {
        const turns = { open: 0 };
        const log = new WorldEventLogController(50);
        log.setWorldStateController({ subControllers: { turns: { getRoundState: () => ({ roundNumber: turns.open }) } } });
        for (const name of ['r0-a', 'r0-b']) write(log, name);
        turns.open = 1;
        for (const name of ['r1-a', 'r1-b', 'r1-c']) write(log, name);

        expect(log.getEventsForRound({ round: 0 }).map((e) => e.message)).toEqual(['r0-a', 'r0-b']);
        expect(log.getEventsForRound({ round: 1 }).map((e) => e.message)).toEqual(['r1-a', 'r1-b', 'r1-c']);
    });

    it('stamps a monotonic sequence on write, and restore keeps it monotonic', () => {
        const log = makeLog({ round: 9 });
        write(log, 'one');
        write(log, 'two');
        const [first, second] = log.getRecent(10);
        expect(second.sequence).toBeGreaterThan(first.sequence);

        const loaded = new WorldEventLogController(50);
        loaded.setWorldStateController(facadeOpenRound(9));
        loaded.restore(log.serialize());
        write(loaded, 'three after the load');
        const rows = loaded.getRecent(10);
        expect(rows.at(-1).sequence).toBeGreaterThan(rows.at(-2).sequence);
    });

    it('backfills the sequence for a ring saved before it existed — and never backfills the round', () => {
        const loaded = new WorldEventLogController(50);
        loaded.setWorldStateController(facadeOpenRound(4));
        // A snapshot written before either stamp existed.
        loaded.restore([
            { tick: 1, action: 'punch', message: 'old one', level: 'warn', ts: 1 },
            { tick: 2, action: 'punch', message: 'old two', level: 'warn', ts: 2 }
        ]);

        const rows = loaded.getRecent(10);
        expect(rows.map((e) => e.sequence)).toEqual([1, 2]);
        // The snapshot has no record of which round said what. Guessing would
        // put old history inside a live round, so unknown stays unknown.
        expect(rows.every((e) => e.round === null)).toBe(true);
        expect(loaded.getEventsForRound({ round: 4 })).toEqual([]);

        // A write after the load carries the live round, above the restored high
        // water mark in sequence order too.
        write(loaded, 'fresh in four');
        const [fresh] = loaded.getEventsForRound({ round: 4 });
        expect(fresh.message).toBe('fresh in four');
        expect(fresh.sequence).toBeGreaterThan(2);
    });

    it('preserves a round that a snapshot already carries', () => {
        const loaded = new WorldEventLogController(50);
        loaded.setWorldStateController(facadeOpenRound(4));
        loaded.restore([
            { message: 'said in two', level: 'warn', round: 2 },
            { message: 'said in three', level: 'warn', round: 3 }
        ]);
        expect(loaded.getEventsForRound({ round: 2 }).map((e) => e.message)).toEqual(['said in two']);
        expect(loaded.getEventsForRound({ round: 3 }).map((e) => e.message)).toEqual(['said in three']);
    });

    it('clear() empties the store: no round answers afterwards', () => {
        const log = makeLog({ round: 1 });
        write(log, 'before the recreate');
        expect(log.getEventsForRound({ round: 1 })).toHaveLength(1);
        log.clear();
        expect(log.getEventsForRound({ round: 1 })).toEqual([]);
        expect(log.getRecent(10)).toEqual([]);
    });
});

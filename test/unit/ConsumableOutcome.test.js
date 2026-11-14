/**
 * ConsumableOutcome — unit tests for reading a bite out of an action result.
 *
 * The whole reason this module exists is a shape trap: `executeAction` answers
 * `success: true` for an action that was ALLOWED, while what the world did with it
 * rides in `results`. A refused meal is therefore a top-level success with a failed
 * `eatItem` entry — and a client reading the top flag toasts "you ate" over an item
 * that was never spent. These tests pin the reading against hand-written responses of
 * exactly that shape (the real one is pinned in
 * test/contract/consumables.contract.test.js, which runs the same reader over a real
 * action result).
 *
 * The third shape is the round queue: in Turn mode the request is ENQUEUED, so the
 * answer is an ack (`{ success: true, queued: true }`) with no consequences in it at
 * all — neither a meal nor a refusal. Getting that wrong is what made a healthy click
 * read as a broken world (see the describe block at the end).
 *
 * @module test/unit/ConsumableOutcome
 */

import { describe, it, expect } from 'vitest';
import { readEatOutcome, EAT_CONSEQUENCE_TYPE } from '../../shared/ConsumableOutcome.js';

/** An action result as the server sends it: validation verdict on top, consequences inside. */
const response = (biteResult, top = { success: true }) => ({
    ...top,
    action: 'eat',
    entityId: 'ent-1',
    executedConsequences: 2,
    results: [
        biteResult,
        { success: true, type: 'log', message: 'Logged: Ate one carried item.' }
    ]
});

describe('the consequence name', () => {
    it('is the name the data files write', () => {
        // actions.json `eat.consequences[0].type` and the key in
        // consequenceHandlers.js. Rename it there and this has to change in the same
        // commit — the contract test is what notices a drift at runtime.
        expect(EAT_CONSEQUENCE_TYPE).toBe('eatItem');
    });
});

describe('a meal that happened', () => {
    it('reads as a success with the world\'s own words', () => {
        const outcome = readEatOutcome(response({
            success: true,
            type: 'eatItem',
            message: 'Ate Apple (+15 Physical.energy).'
        }));
        expect(outcome).toEqual({
            success: true,
            queued: false,
            message: 'Ate Apple (+15 Physical.energy).',
            refused: false
        });
    });
});

describe('a meal the world refused', () => {
    it('is NOT the top-level success', () => {
        // The trap, stated plainly: top says the action was allowed, the bite says no.
        const raw = response({ success: false, type: 'eatItem', message: 'Already at full Physical.energy (100/100).' });
        expect(raw.success).toBe(true);
        expect(readEatOutcome(raw)).toEqual({
            success: false,
            queued: false,
            message: 'Already at full Physical.energy (100/100).',
            refused: true
        });
    });

    it('keeps the reason even when the bite sends none', () => {
        const outcome = readEatOutcome(response({ success: false, type: 'eatItem' }));
        expect(outcome.success).toBe(false);
        expect(outcome.refused).toBe(true);
        expect(outcome.message).toBeNull();
    });
});

describe('a request that never became an action', () => {
    it('reads a validation refusal from the top of the result', () => {
        const outcome = readEatOutcome(response(
            { success: false, type: 'eatItem', message: 'ignored' },
            { success: false, error: 'Requirement failed: must be alive.' }
        ));
        expect(outcome).toEqual({
            success: false,
            queued: false,
            message: 'Requirement failed: must be alive.',
            refused: true
        });
    });

    it('speaks for itself when validation failed without a reason', () => {
        expect(readEatOutcome({ success: false, results: [] }).message).toBe('You could not eat that.');
    });

    it('does not claim a meal when no consequence ran', () => {
        // `success: true` and no `eatItem` entry: a mod replaced the action's
        // consequences, or a different action answered. "You ate" would be a lie.
        const outcome = readEatOutcome({ success: true, results: [{ success: true, type: 'log' }] });
        expect(outcome.success).toBe(false);
        expect(outcome.refused).toBe(false);
        expect(outcome.message).toMatch(/without eating anything/);
    });

    it('survives a missing or malformed response', () => {
        for (const value of [null, undefined, 'ok', 0, { results: null }, { results: 'nope' }]) {
            const outcome = readEatOutcome(value);
            expect(outcome.success, JSON.stringify(value)).toBe(false);
            expect(outcome.refused, JSON.stringify(value)).toBe(false);
            expect(outcome.queued, JSON.stringify(value)).toBe(false);
        }
    });
});

describe('an eat the round has scheduled (the Turn-mode answer)', () => {
    // The path a player is on by default: ActionManager adds `queueForRound: true` in
    // Turn mode, and the route's queue gate answers
    // `{ success: true, queued: true, queueId, queue }` (src/routes/actionRoutes.js) —
    // an ACK, with no `results` because no consequence has run yet. The bite happens when
    // the round resolves. Read as an outcome, this fell into the "no consequence ran"
    // branch and toasted "The world ran the eat action without eating anything" over a
    // request the world had just accepted: a message that looks like a bug and is not.
    const ack = {
        success: true,
        queued: true,
        queueId: 'q-1',
        queue: [{ queueId: 'q-1', actionName: 'eat', entityId: 'ent-1' }]
    };

    it('is neither a meal nor a refusal', () => {
        expect(readEatOutcome(ack)).toEqual({ success: false, queued: true, message: null, refused: false });
    });

    it('carries no words of its own — the ack says nothing about a meal', () => {
        // null, not the failure text: the schedule line is composed by the caller, which
        // is where the item's display name lives.
        expect(readEatOutcome(ack).message).toBeNull();
    });

    it('a queue that refused the ENQUEUE is a refusal, not a schedule', () => {
        // TURNS_DISABLED / PLANNING_CLOSED answer `{ success: false, code, error }`. The
        // reason is `error`, at the top, and there is no bite to read.
        const outcome = readEatOutcome({
            success: false,
            queued: true,
            code: 'PLANNING_CLOSED',
            error: 'Planning window is closed; the round has entered resolution.'
        });
        expect(outcome).toEqual({
            success: false,
            queued: false,
            message: 'Planning window is closed; the round has entered resolution.',
            refused: true
        });
    });

    it('reads a settled meal as a meal — only the ack means scheduled', () => {
        // `queued` is the ack's flag, not a general "there is a queue somewhere" hint:
        // a real result with consequences in it is read as the bite, never as a plan.
        const outcome = readEatOutcome(response({ success: true, type: 'eatItem', message: 'Ate Apple (+15 Physical.energy).' }));
        expect(outcome.success).toBe(true);
        expect(outcome.queued).toBe(false);
    });
});

/**
 * ConsumableOutcome — the pure reading of what an `eat` action did to the world.
 *
 * WHY THIS EXISTS. The top of an action result answers a DIFFERENT question from the
 * one a diner asks. `actionController.executeAction` returns `success: true` once the
 * action was VALID — target type, requirements, cooldown, bindings — and every
 * consequence's own outcome rides along in `results`, one entry per consequence. That
 * is the right shape for a world where an action can do five things and three of them
 * fail; it is the wrong shape for a meal, because "Already at full Physical.energy
 * (100/100)" is a 200 answer with `success: true` at the top and a FAILED `eatItem`
 * entry underneath. A client that read only the top-level flag would toast "you ate"
 * over an item that was never spent — the loudest kind of lie this feature could ship
 * with, and invisible to the gate unless the reading is written down somewhere testable.
 *
 * So the reading lives here, as a pure function over the wire shape: no DOM, no Node,
 * one rule, tested in test/unit/ConsumableOutcome.test.js, and pinned against a REAL
 * action response in test/contract/consumables.contract.test.js (the contract half:
 * the shape this reads is the shape the server actually sends).
 *
 * `EAT_CONSEQUENCE_TYPE` names the consequence entry, exactly as it is written in
 * `data/mods/core-actions/actions.json` (`eat.consequences[0].type`) and registered in
 * `src/controllers/consequences/consequenceHandlers.js`. Rename it there and this must
 * be renamed in the same commit — the contract test is what notices.
 *
 * @module ConsumableOutcome
 */

/** The consequence entry the bite writes (see header for where that name lives). */
export const EAT_CONSEQUENCE_TYPE = 'eatItem';

/**
 * THE THIRD ANSWER — the round queue. In Turn mode (the client's default) an action
 * request is ENQUEUED, not executed: `POST /execute-action` with `queueForRound: true`
 * answers `{ success: true, queued: true, queueId, queue }` (`src/routes/actionRoutes.js`,
 * the `queueForRound === true` branch) and NO consequence has run — the bite happens at
 * the round's resolution, when `TurnSystemController` replays the entry through the same
 * pipeline. That ack carries no `results` at all, so a reader that only knows "ate" and
 * "did not eat" reads it as the failure branch and toasts a broken-world message over a
 * request the world ACCEPTED. Both readings are wrong: nothing was spent yet, and
 * nothing went wrong. Hence `queued` — a third state, neither meal nor refusal.
 *
 * @returns {{ success: boolean, queued: boolean, message: string|null, refused: boolean }}
 *   `success` — the item WAS eaten (spent and charged); `queued` — the round accepted
 *   the plan and has not eaten yet; `message` — what the world said, in the actor's own
 *   words (the handler writes both the meal and the refusal; a queued ack says nothing,
 *   so it is `null` and the caller words the schedule line, which is where the item's
 *   display name lives); `refused` — the world answered and said no (as opposed to the
 *   request never reaching it, which is `refused: false, success: false`).
 */
export function readEatOutcome(actionResult) {
    if (!actionResult || typeof actionResult !== 'object') {
        return { success: false, queued: false, message: 'Eating did not happen.', refused: false };
    }

    // Read the queue ack BEFORE anything else: it is the one answer that carries no
    // consequences by design, not because a mod rewired the action.
    if (actionResult.queued === true && actionResult.success === true) {
        return { success: false, queued: true, message: null, refused: false };
    }

    const bite = (Array.isArray(actionResult.results) ? actionResult.results : [])
        .find((entry) => entry?.type === EAT_CONSEQUENCE_TYPE);

    // Validation refused the action (unknown action, failed requirement, cooldown),
    // or the queue refused the ENQUEUE (TURNS_DISABLED, PLANNING_CLOSED) — whose reason
    // is `error` at the top of the result. Both are the world answering "no".
    if (actionResult.success === false) {
        return {
            success: false,
            queued: false,
            message: actionResult.error ?? bite?.message ?? 'You could not eat that.',
            refused: true
        };
    }

    // The action was allowed but produced no bite: a mod replaced the action's
    // consequences, or the request never carried the item. Saying "you ate" here would
    // be a lie of the loudest kind, so it is a failure with no refusal claimed.
    if (!bite) {
        return {
            success: false,
            queued: false,
            message: 'The world ran the eat action without eating anything.',
            refused: false
        };
    }

    return {
        success: bite.success === true,
        queued: false,
        message: bite.message ?? null,
        refused: bite.success !== true
    };
}

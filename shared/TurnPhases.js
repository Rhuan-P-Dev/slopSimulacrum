/**
 * TurnPhases — Shared, environment-agnostic turn-phase vocabulary.
 *
 * SINGLE SOURCE OF TRUTH for the phase strings stored in
 * `state.turns.phase`: each world turn is either in the PLANNING window
 * (entities may enqueue actions) or the RESOLUTION window (the queued
 * actions replay through the action pipeline). The strings are part of the
 * persisted world-state schema, so code must never re-type them by hand —
 * a hand-typed spelling that drifts breaks turn-system consumers silently.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same
 * ES module can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * @module TurnPhases
 */

/**
 * The two phase values of a world turn, as stored in `state.turns.phase`.
 * @type {Object.<string, string>}
 */
export const TURN_PHASES = {
    PLANNING: 'planning',
    RESOLUTION: 'resolution',
};

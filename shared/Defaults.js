/**
 * Defaults — Shared, environment-agnostic fallback defaults for world data.
 *
 * Every value here is a SAFETY FALLBACK, not a tuning knob: each exists so
 * that code degrades gracefully when a data file is missing or an entry is
 * malformed, instead of silently inventing behavior. They must stay in
 * sync with the values the data files define today (see each entry's note
 * for which file anchors it).
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same
 * ES module can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * @module Defaults
 */

/**
 * Blueprint name used to spawn the player droid when a client connects.
 * Anchored in `data/blueprints.json` (and mirrored by the NPCs in
 * `data/npcs.json`).
 * @type {string}
 */
export const DEFAULT_PLAYER_BLUEPRINT = 'smallBallDroid';

/**
 * Fallback volume for an item whose `volume` field is missing or undefined.
 * 0 was chosen deliberately:
 *   - every entry in `data/inventoryItems.json` defines a volume, so this
 *     fallback only ever fires on malformed/missing data;
 *   - 0 is the safe direction: it can never falsely block an inventory
 *     from accepting an item (capacity) or inflate holding cost, whereas
 *     any positive guess could;
 *   - the most conservative existing fallback site already used 0.
 * @type {number}
 */
export const DEFAULT_ITEM_VOLUME = 0;

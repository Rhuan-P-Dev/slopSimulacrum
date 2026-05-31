/**
 * Constants for the game application.
 * All constants use UPPER_SNAKE_CASE naming convention.
 */

/**
 * Minimum movement distance required to trigger movement calculation.
 * When distance is 0 or less, no movement is needed.
 * @type {number}
 */
export const MIN_MOVEMENT_DISTANCE = 0;

/**
 * Default base multiplier for synergy calculations when not specified.
 * Represents 100% base value (1.0x multiplier).
 * @type {number}
 */
export const DEFAULT_SYNERGY_BASE_MULTIPLIER = 1.0;

/**
 * Default placeholder multiplier when no multiplier is specified in placeholder strings.
 * Represents 1x multiplier (use the value as-is).
 * @type {number}
 */
export const DEFAULT_PLACEHOLDER_MULTIPLIER = 1;

/**
 * Base-10 radix used for parsing integer values in placeholder strings.
 * @type {number}
 */
export const PARSING_RADIX = 10;

/**
 * Synergy multiplier threshold below which no synergy bonus is applied.
 * Values greater than 1.0 indicate a bonus; 1.0 is the baseline (no bonus).
 * @type {number}
 */
export const SYNERGY_BONUS_THRESHOLD = 1.0;

/**
 * Score for the "release" action capability entry (lowest priority).
 * @type {number}
 */
export const RELEASE_ACTION_SCORE = 10;

/**
 * Invalid score threshold: scores at or below this value are considered invalid.
 * @type {number}
 */
export const INVALID_SCORE_THRESHOLD = 0;

/**
 * TTL for synergy computation cache in milliseconds (5 seconds).
 * Used by SynergyController to expire stale synergy results.
 * @type {number}
 */
export const SYNERGY_CACHE_TTL_MS = 5000;

/**
 * Maximum number of entries in the synergy cache.
 * Prevents unbounded memory growth.
 * @type {number}
 */
export const SYNERGY_CACHE_MAX_SIZE = 100;

// =========================================================================
// ITEM DROP / PICK-UP CONSTANTS
// =========================================================================

/**
 * Base range for dropping items (minimum distance).
 * Total drop range = DROP_BASE_RANGE + (Physical.strength × DROP_RANGE_MULTIPLIER).
 * @type {number}
 */
export const DROP_BASE_RANGE = 3;

/**
 * Multiplier applied to Physical.strength for calculating drop range.
 * Total drop range = DROP_BASE_RANGE + (Physical.strength × DROP_RANGE_MULTIPLIER).
 * @type {number}
 */
export const DROP_RANGE_MULTIPLIER = 2;